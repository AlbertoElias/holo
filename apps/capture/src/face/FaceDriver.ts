import * as THREE from 'three';
import { FACE_CHANNELS, MAX_PITCH, type FaceChannel } from '@holoim/avatar-face';
import { type FaceRigBones, FaceRig, type FaceBindingReport } from './FaceRig';
import type { FaceCameraState, FaceExpressionSource, FaceGaze, FaceGazeSource, FaceSample, FaceWeights } from './faceTypes';
import { LivenessFace } from './LivenessFace';
import { VoiceLevel } from './VoiceLevel';
import { WebcamFace } from './WebcamFace';
import { XrGaze } from './XrGaze';

// A change of source (a face entering or leaving the camera, automation
// starting) crossfades instead of popping.
const CROSSFADE_SEC = 0.25;
// Looking down drops the upper lids a little, as real lids follow the eyes.
const LID_FOLLOW = 0.3;

export interface FaceSnapshot {
  binding: FaceBindingReport | null;
  expressionSource: FaceExpressionSource;
  gazeSource: FaceGazeSource;
  camera: FaceCameraState;
  cameraDelegate: 'GPU' | 'CPU' | null;
  weights: FaceWeights;
  influences: Record<string, number>;
  gaze: { left: { yaw: number; pitch: number } | null; right: { yaw: number; pitch: number } | null };
}

export interface FaceStepInput {
  timeSec: number;
  deltaSec: number;
  vrActive: boolean;
  micGranted: boolean;
}

/**
 * Chooses the face each step, by priority per part: automation (replayed
 * fixtures), then the webcam, then liveness for the expression; automation,
 * webcam, WebXR eye gaze, then liveness for the gaze. Writes the avatar's
 * morph weights and eye bones, after the body pose and before the recorder.
 */
export class FaceDriver {
  readonly webcam: WebcamFace;
  readonly xrGaze: XrGaze;
  private rig: FaceRig | null = null;
  private readonly liveness = new LivenessFace();
  private readonly voice = new VoiceLevel();
  private automation: FaceSample | null = null;
  private expressionSource: FaceExpressionSource = 'liveness';
  private gazeSource: FaceGazeSource = 'liveness';
  private output: FaceWeights = {};
  private outputGaze: FaceGaze = { left: { yaw: 0, pitch: 0 }, right: { yaw: 0, pitch: 0 } };
  private expressionFade = { from: {} as FaceWeights, startedAt: -Infinity };
  private gazeFade = { from: this.outputGaze, startedAt: -Infinity };
  private readonly lookPoint = new THREE.Vector3();

  constructor(rig: THREE.Object3D, onCameraState: (state: FaceCameraState) => void) {
    this.webcam = new WebcamFace(onCameraState);
    this.xrGaze = new XrGaze(rig);
  }

  attach(avatar: THREE.Object3D, bones?: FaceRigBones): void {
    this.rig = new FaceRig(avatar, bones);
  }

  /** Automation: a full face (channels it omits are 0), or null to release. */
  setAutomationInput(sample: FaceSample | null): void {
    this.automation = sample;
  }

  toggleCamera(): void {
    if (this.webcam.active) this.webcam.stop();
    else void this.webcam.start();
  }

  update(input: FaceStepInput): void {
    // The camera cannot see a face under a headset: release it on entering VR.
    if (input.vrActive && this.webcam.active) this.webcam.stop();
    const rig = this.rig;
    if (!rig?.hasFace) return;
    if (input.micGranted) void this.voice.start();

    const camera = input.vrActive ? null : this.webcam.sample(performance.now());
    const live = this.liveness.sample(input.timeSec, input.deltaSec, this.automation || camera ? 0 : this.voice.read());

    const expression: [FaceExpressionSource, FaceWeights] = this.automation
      ? ['automation', this.automation.weights]
      : camera
        ? ['webcam', camera.weights]
        : ['liveness', live.weights];
    let gaze: [FaceGazeSource, FaceGaze];
    if (this.automation?.gaze) gaze = ['automation', this.automation.gaze];
    else if (camera?.gaze) gaze = ['webcam', camera.gaze];
    else {
      const point = input.vrActive ? this.xrGaze.lookPoint(this.lookPoint) : null;
      const xr = point ? rig.gazeTowardPoint(point) : null;
      gaze = xr ? ['xr-gaze', xr] : ['liveness', live.gaze];
    }

    if (expression[0] !== this.expressionSource) {
      this.expressionFade = { from: { ...this.output }, startedAt: input.timeSec };
      this.expressionSource = expression[0];
    }
    if (gaze[0] !== this.gazeSource) {
      this.gazeFade = { from: cloneGaze(this.outputGaze), startedAt: input.timeSec };
      this.gazeSource = gaze[0];
    }
    const expressionT = fade(input.timeSec - this.expressionFade.startedAt);
    const gazeT = fade(input.timeSec - this.gazeFade.startedAt);

    const weights: FaceWeights = {};
    for (const channel of FACE_CHANNELS) {
      const value = lerp(this.expressionFade.from[channel] ?? 0, expression[1][channel] ?? 0, expressionT);
      if (value > 1e-4) weights[channel] = value;
    }
    const nextGaze: FaceGaze = {
      left: lerpGaze(this.gazeFade.from.left, gaze[1].left, gazeT),
      right: lerpGaze(this.gazeFade.from.right, gaze[1].right, gazeT)
    };
    this.output = weights;
    this.outputGaze = nextGaze;

    rig.apply(withLidFollow(weights, nextGaze), nextGaze);
  }

  snapshot(): FaceSnapshot {
    return {
      binding: this.rig?.report() ?? null,
      expressionSource: this.expressionSource,
      gazeSource: this.gazeSource,
      camera: this.webcam.state,
      cameraDelegate: this.webcam.delegate,
      weights: { ...this.output },
      influences: this.rig?.sampleInfluences() ?? {},
      gaze: this.rig?.sampleGaze() ?? { left: null, right: null }
    };
  }
}

function fade(elapsed: number): number {
  const t = Math.min(1, Math.max(0, elapsed / CROSSFADE_SEC));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpGaze(a: { yaw: number; pitch: number }, b: { yaw: number; pitch: number }, t: number): { yaw: number; pitch: number } {
  return { yaw: lerp(a.yaw, b.yaw, t), pitch: lerp(a.pitch, b.pitch, t) };
}

function cloneGaze(gaze: FaceGaze): FaceGaze {
  return { left: { ...gaze.left }, right: { ...gaze.right } };
}

function withLidFollow(weights: FaceWeights, gaze: FaceGaze): FaceWeights {
  const out = { ...weights };
  for (const [side, channel] of [['left', 'eyeBlinkLeft'], ['right', 'eyeBlinkRight']] as const) {
    const down = Math.max(0, -gaze[side].pitch / MAX_PITCH);
    if (down > 0) out[channel as FaceChannel] = Math.min(1, (out[channel] ?? 0) + down * LID_FOLLOW);
  }
  return out;
}
