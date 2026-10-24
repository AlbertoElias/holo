import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Face behaviour the shipped avatar cannot reach through the XR face check,
// one test per failure an independent verifier reproduced:
// 1. Eye bones and eyeLook morphs both carry the gaze (the eye turns twice).
// 2. A combined blink target beside per-eye targets double-closes the lids.
// 3. A rig with eyeLook morphs and no eye bones never moves its eyes, and
//    WebXR eye gaze cannot aim it.
// 4. The binding report omits channels the avatar can neither show nor route.
// 5. Turning the camera off while permission is pending switches it back on
//    and keeps the stream.
// 6. Entering VR leaves the camera running.
vi.mock('@mediapipe/tasks-vision', () => ({
  FaceLandmarker: { createFromOptions: vi.fn(async () => ({ close: vi.fn(), detectForVideo: vi.fn() })) }
}));

const { FaceRig } = await import('./FaceRig');
const { FaceDriver } = await import('./FaceDriver');
const { WebcamFace } = await import('./WebcamFace');

const DEG = Math.PI / 180;
const level = { yaw: 0, pitch: 0 };

function morphMesh(name: string, targets: string[]): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry());
  mesh.name = name;
  mesh.morphTargetDictionary = Object.fromEntries(targets.map((target, index) => [target, index]));
  mesh.morphTargetInfluences = targets.map(() => 0);
  return mesh;
}

function influence(mesh: THREE.Mesh, target: string): number {
  return mesh.morphTargetInfluences![mesh.morphTargetDictionary![target]!]!;
}

/** An avatar facing +Z (its own left is +X) with a head, and eye bones if asked. */
function avatar(mesh: THREE.Mesh, { eyes }: { eyes: boolean }): { root: THREE.Group; leftEye: THREE.Bone | null } {
  const root = new THREE.Group();
  const head = new THREE.Bone();
  head.name = 'Head';
  head.position.set(0, 1.6, 0);
  root.add(head, mesh);
  let leftEye: THREE.Bone | null = null;
  if (eyes) {
    for (const [name, x] of [['LeftEye', 0.03], ['RightEye', -0.03]] as const) {
      const eye = new THREE.Bone();
      eye.name = name;
      eye.position.set(x, 0.05, 0.08);
      head.add(eye);
      if (name === 'LeftEye') leftEye = eye;
    }
  }
  root.updateMatrixWorld(true);
  return { root, leftEye };
}

describe('FaceRig', () => {
  it('turns the eyes with bones only when the rig also has eyeLook morphs', () => {
    const mesh = morphMesh('Head', ['eyeLookOutLeft', 'eyeLookInRight', 'jawOpen']);
    const { root, leftEye } = avatar(mesh, { eyes: true });
    const rig = new FaceRig(root);
    rig.apply({ eyeLookOutLeft: 1, eyeLookInRight: 1, jawOpen: 0.5 }, { left: { yaw: 20 * DEG, pitch: 0 }, right: { yaw: 20 * DEG, pitch: 0 } });
    expect(rig.report().gazeBy).toBe('bones');
    expect(influence(mesh, 'eyeLookOutLeft')).toBe(0);
    expect(influence(mesh, 'eyeLookInRight')).toBe(0);
    expect(influence(mesh, 'jawOpen')).toBeCloseTo(0.5);
    // Yaw toward the avatar's own left turns the eye's forward (+Z) toward +X.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(leftEye!.quaternion);
    expect(Math.atan2(forward.x, forward.z)).toBeCloseTo(20 * DEG);
  });

  it('leaves a combined blink at 0 beside per-eye blinks on the same mesh', () => {
    const mesh = morphMesh('Face', ['blink', 'blinkLeft', 'blinkRight']);
    const rig = new FaceRig(avatar(mesh, { eyes: false }).root);
    rig.apply({ eyeBlinkLeft: 1, eyeBlinkRight: 1 }, { left: level, right: level });
    expect(influence(mesh, 'blink')).toBe(0);
    expect(influence(mesh, 'blinkLeft')).toBe(1);
    expect(influence(mesh, 'blinkRight')).toBe(1);
    expect(rig.report().suppressedTargets).toEqual(['Face:blink']);
  });

  it('keeps a combined blink when it is the only one', () => {
    const mesh = morphMesh('Face', ['blink']);
    const rig = new FaceRig(avatar(mesh, { eyes: false }).root);
    rig.apply({ eyeBlinkLeft: 1, eyeBlinkRight: 1 }, { left: level, right: level });
    expect(influence(mesh, 'blink')).toBe(1);
  });

  it('turns eyeLook morphs on a rig without eye bones, and aims them at a point', () => {
    const mesh = morphMesh('Face', ['lookLeft', 'lookRight', 'lookUp', 'lookDown']);
    const { root } = avatar(mesh, { eyes: false });
    const rig = new FaceRig(root);
    expect(rig.report().gazeBy).toBe('morphs');
    rig.apply({}, { left: { yaw: 15 * DEG, pitch: 0 }, right: { yaw: 15 * DEG, pitch: 0 } });
    expect(influence(mesh, 'lookLeft')).toBeGreaterThan(0.3);
    expect(influence(mesh, 'lookRight')).toBe(0);
    // A point ahead and to the avatar's own left (+X), level with the head.
    const gaze = rig.gazeTowardPoint(new THREE.Vector3(1, 1.6, 2));
    expect(gaze?.left.yaw).toBeGreaterThan(0);
    expect(Math.abs(gaze!.left.pitch)).toBeLessThan(1e-6);
  });

  it('reports the channels a legacy rig can neither show nor route', () => {
    const rig = new FaceRig(avatar(morphMesh('Head', ['mouthOpen', 'mouthSmile']), { eyes: false }).root);
    const { unroutableChannels, gazeBy } = rig.report();
    expect(gazeBy).toBe('none');
    expect(unroutableChannels).toContain('browInnerUp');
    expect(unroutableChannels).toContain('eyeBlinkLeft');
    expect(unroutableChannels).not.toContain('jawOpen');
    expect(unroutableChannels).not.toContain('viseme_aa');
  });
});

describe('WebcamFace', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('releases a stream that arrives after the camera was turned off', async () => {
    const stopTrack = vi.fn();
    let grant: (stream: MediaStream) => void = () => undefined;
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)) }
    });
    const states: string[] = [];
    const webcam = new WebcamFace((state) => states.push(state));
    const started = webcam.start();
    webcam.stop();
    grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await started;
    expect(states).toEqual(['starting', 'off']);
    expect(webcam.state).toBe('off');
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});

describe('FaceDriver', () => {
  it('stops the camera on entering VR', () => {
    const driver = new FaceDriver(new THREE.Group(), () => undefined);
    driver.webcam.state = 'tracking';
    const stop = vi.spyOn(driver.webcam, 'stop');
    driver.update({ timeSec: 0, deltaSec: 1 / 30, vrActive: true, micGranted: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(driver.webcam.state).toBe('off');
  });
});
