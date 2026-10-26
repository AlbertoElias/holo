import * as THREE from 'three';
import { isFiniteQuaternionLike, isFiniteVector3Like } from '../shared/math';
import { TRACKED_HAND_JOINT_NAMES, type HandPoseSource, type TrackedHandJointName, type VrHandSide } from '../types/contracts';
import { type MockHand, MockVrPose } from './MockVrPose';

const SIDES = ['left', 'right'] as const;

interface HandTarget {
  poseValid: boolean;
  hasLastValidPose: boolean;
  targetPosition: THREE.Vector3;
  targetQuaternion: THREE.Quaternion;
  lastValidPosition: THREE.Vector3;
  lastValidQuaternion: THREE.Quaternion;
  lastValidOffsetFromEye: THREE.Vector3;
}

interface TrackedJoint {
  positionTracked: boolean;
  quaternionTracked: boolean;
  positionWorld: THREE.Vector3;
  quaternionWorld: THREE.Quaternion;
}

interface XrInputSourceLike {
  handedness: string;
  gripSpace?: unknown;
  hand?: unknown;
  targetRaySpace?: unknown;
  gamepad?: { axes?: readonly number[]; buttons?: readonly unknown[] };
}

// One of three's per-index XR input objects (grip, hand or target ray) and
// the input source it currently follows.
interface InputSlot {
  object: THREE.Group;
  inputSource: XrInputSourceLike | undefined;
  handednessHint: VrHandSide | undefined;
}

type SlotKind = 'grip' | 'hand' | 'controller';
const SLOT_KINDS: readonly SlotKind[] = ['grip', 'hand', 'controller'];
const SLOT_SPACE: Record<SlotKind, 'gripSpace' | 'hand' | 'targetRaySpace'> = { grip: 'gripSpace', hand: 'hand', controller: 'targetRaySpace' };

export interface TrackingRotationOptions {
  handPitchDeg: number;
  handYawDeg: number;
  handRollDeg: number;
  handInwardYawDeg: number;
  controllerPitchDeg: number;
  controllerYawDeg: number;
  controllerRollDeg: number;
}

const FINGER_TRACKED_JOINT_NAMES = TRACKED_HAND_JOINT_NAMES.filter((jointName) => jointName !== 'wrist');
const LOW_FINGER_JOINT_TRACKED_COUNT = 6;
const LOW_FINGER_JOINT_WARN_FRAMES = 45;
const PREFERRED_HAND_POSE_JOINTS: readonly TrackedHandJointName[] = [
  'wrist',
  'middle-finger-metacarpal',
  'index-finger-metacarpal',
  'thumb-metacarpal',
  'index-finger-phalanx-proximal',
  'middle-finger-phalanx-proximal'
];

// Tracked eye midpoint and orientation for the current XR frame. `local` is
// tracking space (the camera rig's local space); `world` applies the rig.
export interface XrHeadPose {
  valid: boolean;
  localPosition: THREE.Vector3;
  localQuaternion: THREE.Quaternion;
  worldPosition: THREE.Vector3;
  worldQuaternion: THREE.Quaternion;
}

/**
 * The input + tracking adapter: per-frame head, hand and controller poses
 * with their source, in explicit tracking (rig-local) and world spaces. Real
 * XR input comes from three's grips, hands and controllers; the mock pose
 * hook substitutes deterministic hands. Never scales anything.
 */
export class XrTracking {
  readonly mock: MockVrPose;
  private readonly slots: Record<SlotKind, InputSlot[]>;
  private readonly handTargets: Record<VrHandSide, HandTarget> = { left: createHandTarget(), right: createHandTarget() };
  private readonly joints: Record<VrHandSide, Record<TrackedHandJointName, TrackedJoint>> = { left: createJointMap(), right: createJointMap() };
  private readonly lowFingerJointFrames: Record<VrHandSide, number> = { left: 0, right: 0 };
  private readonly lowFingerJointWarned: Record<VrHandSide, boolean> = { left: false, right: false };
  // Which input produced each hand's pose this frame.
  private readonly handPoseSource: Record<VrHandSide, HandPoseSource> = { left: 'none', right: 'none' };
  private cameraRig: THREE.Group | null = null;

  private wasXrPresenting = false;
  private session: XRSession | null = null;
  private heightReferenceSpace: XRReferenceSpace | null = null;
  // Bumped whenever tracking space may have moved (new reference space, a
  // reset, a visibility change): a height fit belongs to one revision.
  private heightReferenceRevision = 0;
  private floorHeadPosition: DOMPointReadOnly | undefined;
  // Whether the latest XR frame had a viewer pose. three keeps its last
  // camera matrices when tracking is lost, so they alone cannot tell.
  private viewerTracked = true;
  private readonly onTrackingSpaceChange = (): void => {
    this.floorHeadPosition = undefined;
    this.heightReferenceRevision += 1;
  };

  private readonly headPose: XrHeadPose = {
    valid: false,
    localPosition: new THREE.Vector3(),
    localQuaternion: new THREE.Quaternion(),
    worldPosition: new THREE.Vector3(),
    worldQuaternion: new THREE.Quaternion()
  };
  private readonly trackedHandRotationOffset = new THREE.Quaternion();
  private readonly trackedHandInwardYawOffsets: Record<VrHandSide, THREE.Quaternion> = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
  private readonly trackedControllerRotationOffset = new THREE.Quaternion();

  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpEyeAnchor = new THREE.Vector3();
  private readonly tmpXrHeadWorld = new THREE.Vector3();
  // Own scratch for per-joint capture: callers hold the hand pose in tmpVecA
  // across captureTrackedHandJoints, which once made the wrist target the
  // last captured joint (the pinky tip).
  private readonly tmpJointWorld = new THREE.Vector3();
  private readonly tmpEyeLocal = new THREE.Vector3();
  private readonly tmpRigQuat = new THREE.Quaternion();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuatB = new THREE.Quaternion();

  constructor(private readonly renderer: THREE.WebGLRenderer, mockVrEnabled: boolean, rotation: TrackingRotationOptions) {
    this.mock = new MockVrPose(mockVrEnabled);
    const xr = renderer.xr;
    const objectFor: Record<SlotKind, (index: number) => THREE.Group> = {
      grip: (index) => xr.getControllerGrip(index),
      hand: (index) => xr.getHand(index),
      controller: (index) => xr.getController(index)
    };
    this.slots = { grip: [], hand: [], controller: [] };
    for (const kind of SLOT_KINDS) {
      this.slots[kind] = [0, 1].map((index) => ({ object: objectFor[kind](index), inputSource: undefined, handednessHint: undefined }));
    }

    const deg = THREE.MathUtils.degToRad;
    this.trackedHandRotationOffset.setFromEuler(new THREE.Euler(deg(rotation.handPitchDeg), deg(rotation.handYawDeg), deg(rotation.handRollDeg), 'XYZ'));
    this.trackedHandInwardYawOffsets.left.setFromEuler(new THREE.Euler(0, deg(rotation.handInwardYawDeg), 0, 'XYZ'));
    this.trackedHandInwardYawOffsets.right.setFromEuler(new THREE.Euler(0, -deg(rotation.handInwardYawDeg), 0, 'XYZ'));
    this.trackedControllerRotationOffset.setFromEuler(new THREE.Euler(deg(rotation.controllerPitchDeg), deg(rotation.controllerYawDeg), deg(rotation.controllerRollDeg), 'XYZ'));

    for (const kind of SLOT_KINDS) {
      for (const slot of this.slots[kind]) {
        const events = slot.object as THREE.Object3D & { addEventListener(type: string, listener: (event: unknown) => void): void };
        events.addEventListener('connected', (event) => {
          const data = (event as { data?: XrInputSourceLike }).data;
          slot.inputSource = data;
          const side = toSide(data?.handedness);
          if (side) slot.handednessHint = side;
        });
        events.addEventListener('disconnected', () => {
          slot.inputSource = undefined;
          slot.handednessHint = undefined;
        });
      }
    }
  }

  /**
   * Controllers, grips and hands MUST be children of the camera rig, so their
   * world positions include the same dolly as the XR camera; otherwise hand
   * targets land near the room origin instead of near the avatar.
   */
  mountToRig(cameraRig: THREE.Group): void {
    this.cameraRig = cameraRig;
    for (const kind of ['controller', 'grip', 'hand'] as const) {
      for (const slot of this.slots[kind]) cameraRig.add(slot.object);
    }
  }

  updateTransition(): { entered: boolean; exited: boolean } {
    const isXrPresenting = this.renderer.xr.isPresenting;
    const entered = !this.wasXrPresenting && isXrPresenting;
    const exited = this.wasXrPresenting && !isXrPresenting;
    this.wasXrPresenting = isXrPresenting;
    if (entered) {
      this.session = this.renderer.xr.getSession();
      this.session?.addEventListener('visibilitychange', this.onTrackingSpaceChange);
      this.resetTrackingState();
    }
    if (exited) {
      this.session?.removeEventListener('visibilitychange', this.onTrackingSpaceChange);
      this.session = null;
      this.heightReferenceSpace?.removeEventListener('reset', this.onTrackingSpaceChange);
      this.heightReferenceSpace = null;
      this.floorHeadPosition = undefined;
      this.clearInputSources();
    }
    return { entered, exited };
  }

  isXrPresenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  isVrEmbodimentActive(): boolean {
    return this.renderer.xr.isPresenting || this.mock.enabled;
  }

  isMockVrOnly(): boolean {
    return this.mock.enabled && !this.renderer.xr.isPresenting;
  }

  getHeightReferenceRevision(): number {
    return this.heightReferenceRevision;
  }

  // ── Device frame acquisition (inside the XR frame callback) ──────────

  /** Raw floor-space head position; XRFrame poses are only readable inside its callback, so keep a value, never the frame. */
  captureFloorHeadPose(frame: XRFrame | undefined): void {
    this.floorHeadPosition = frame ? this.readFloorHeadPosition(frame) : undefined;
  }

  noteXrFrame(frame: XRFrame): void {
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    if (!referenceSpace) return;
    try {
      this.viewerTracked = frame.getViewerPose(referenceSpace) !== null;
    } catch {
      // A frame outside its callback; keep the last known state.
    }
  }

  getFloorHeadPosition(): DOMPointReadOnly | undefined {
    return this.renderer.xr.getSession()?.visibilityState === 'visible' ? this.floorHeadPosition : undefined;
  }

  private readFloorHeadPosition(frame: XRFrame): DOMPointReadOnly | undefined {
    const reference = this.renderer.xr.getReferenceSpace();
    if (reference !== this.heightReferenceSpace) {
      this.heightReferenceSpace?.removeEventListener('reset', this.onTrackingSpaceChange);
      this.heightReferenceSpace = reference;
      reference?.addEventListener('reset', this.onTrackingSpaceChange);
      this.heightReferenceRevision += 1;
    }
    const session = this.renderer.xr.getSession();
    if (!session || session.visibilityState !== 'visible' || !reference || this.mock.enabled) return undefined;
    // Entry requires local-floor; unsupported floor spaces fail session entry
    // rather than interpreting viewer-relative Y as stature.
    const pose = frame.getViewerPose(reference);
    const position = pose?.transform.position;
    if (!pose || pose.emulatedPosition || !position || !isFiniteVector3Like(position)) return undefined;
    return position;
  }

  // ── Head ──────────────────────────────────────────────────────────────

  getHeadWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.floorHeadPosition) {
      out.set(this.floorHeadPosition.x, this.floorHeadPosition.y, this.floorHeadPosition.z);
      return this.cameraRig ? this.cameraRig.localToWorld(out) : out;
    }
    // Do not call getWorldPosition on three's internal XR camera: it stores
    // world coordinates, and updating its matrix can feed that dolly back in.
    return out.copy(this.tmpXrHeadWorld);
  }

  // Reads the head from the XR views. three copies each view.transform into
  // getCamera().cameras[i].matrix (tracking space) at the start of every XR
  // frame, before the app runs. The ArrayCamera's own position is not usable
  // here: it is tracking space until render() calls updateCamera and world
  // space afterwards, so its meaning depends on frame order (B-009). Call once
  // per frame, and again via refreshHeadWorldPose() after moving the rig.
  updateHeadPose(): XrHeadPose {
    const pose = this.headPose;
    pose.valid = false;
    if (!this.renderer.xr.isPresenting || !this.viewerTracked) return pose;
    // AR sessions may expose a single view; the type assumes two.
    const cameras: readonly THREE.Camera[] = this.renderer.xr.getCamera().cameras;
    if (cameras.length === 0) return pose;
    pose.localPosition.set(0, 0, 0);
    for (const eye of cameras) pose.localPosition.add(this.tmpEyeLocal.setFromMatrixPosition(eye.matrix));
    pose.localPosition.multiplyScalar(1 / cameras.length);
    pose.localQuaternion.setFromRotationMatrix(cameras[0]!.matrix).normalize();
    if (!isFiniteVector3Like(pose.localPosition) || !isFiniteQuaternionLike(pose.localQuaternion)) return pose;
    pose.valid = true;
    this.refreshHeadWorldPose();
    return pose;
  }

  refreshHeadWorldPose(): XrHeadPose {
    const pose = this.headPose;
    pose.worldPosition.copy(pose.localPosition);
    pose.worldQuaternion.copy(pose.localQuaternion);
    const rig = this.cameraRig;
    if (rig) {
      rig.updateWorldMatrix(true, false);
      pose.worldPosition.applyMatrix4(rig.matrixWorld);
      pose.worldQuaternion.premultiply(rig.getWorldQuaternion(this.tmpRigQuat)).normalize();
    }
    return pose;
  }

  getHeadPose(): XrHeadPose {
    return this.headPose;
  }

  /** The heading the avatar faces: the mock head's, the tracked head's, or the current one. */
  syncYaw(lookYaw: number): number {
    if (this.mock.enabled) {
      const yaw = this.mock.yaw();
      if (yaw !== undefined) return yaw;
    }
    if (this.renderer.xr.isPresenting && this.headPose.valid) return headYawFromQuaternion(this.headPose.worldQuaternion, lookYaw);
    return lookYaw;
  }

  getCurrentHeadLocalY(): number | undefined {
    if (this.mock.enabled) return Number.isFinite(this.mock.headPosition.y) ? this.mock.headPosition.y : undefined;
    if (this.renderer.xr.isPresenting && this.headPose.valid) return this.headPose.localPosition.y;
    if (this.renderer.xr.isPresenting) return this.getFloorHeadPosition()?.y;
    return undefined;
  }

  // ── Hands ─────────────────────────────────────────────────────────────

  /**
   * Hand targets for this frame, relative to `getEyeAnchorWorld`: tracked
   * hand joints first, then grip, then target ray, then the last valid pose,
   * then a neutral pose in front of the eyes.
   */
  updateHandTrackingTargets(getEyeAnchorWorld: (out: THREE.Vector3) => THREE.Vector3): void {
    if (this.mock.enabled) {
      // The deterministic hook keeps its synthetic hands even while an IWER
      // XR session provides camera/session emulation.
      for (const side of SIDES) {
        const target = this.handTargets[side];
        const mockHand = this.mock.hands[side];
        this.clearTrackedHandJoints(side);
        target.poseValid = false;
        this.handPoseSource[side] = 'none';
        if (mockHand.tracked) {
          getEyeAnchorWorld(this.tmpEyeAnchor);
          this.tmpVecB.copy(mockHand.position).applyQuaternion(this.mock.headQuaternion);
          this.tmpVecA.copy(this.tmpEyeAnchor).add(this.tmpVecB);
          this.tmpQuat.copy(this.mock.headQuaternion).multiply(mockHand.quaternion).multiply(this.trackedHandInwardYawOffsets[side]).normalize();
          setTrackedPose(target, this.tmpVecA, this.tmpQuat, this.tmpEyeAnchor);
          this.captureMockHandJoints(side, mockHand, this.tmpEyeAnchor);
          this.handPoseSource[side] = 'mock';
          this.updateLowFingerJointWarning(side, true);
          continue;
        }
        this.updateLowFingerJointWarning(side, false);
        if (target.hasLastValidPose) {
          getEyeAnchorWorld(this.tmpEyeAnchor);
          this.holdLastValidPose(side, this.tmpEyeAnchor);
        }
      }
      return;
    }

    if (!this.renderer.xr.isPresenting) {
      getEyeAnchorWorld(this.tmpEyeAnchor);
      for (const side of SIDES) {
        const target = this.handTargets[side];
        this.clearTrackedHandJoints(side);
        target.poseValid = false;
        this.handPoseSource[side] = 'none';
        this.updateLowFingerJointWarning(side, false);
        if (target.hasLastValidPose) this.holdLastValidPose(side, this.tmpEyeAnchor);
      }
      return;
    }

    this.refreshInputSourcesFromSession();
    getEyeAnchorWorld(this.tmpEyeAnchor);
    if (!this.headPose.valid) this.updateHeadPose();
    this.tmpXrHeadWorld.copy(this.refreshHeadWorldPose().worldPosition);

    for (const side of SIDES) {
      const target = this.handTargets[side];
      this.clearTrackedHandJoints(side);
      target.poseValid = false;
      this.handPoseSource[side] = 'none';

      const hand = this.resolveSlot('hand', side);
      const grip = this.resolveSlot('grip', side);

      if (hand && this.readHandPose(hand.object, this.tmpVecA, this.tmpQuat)) {
        this.tmpQuat.multiply(this.trackedHandRotationOffset).multiply(this.trackedHandInwardYawOffsets[side]).normalize();
        this.captureHandJoints(side, hand.object, this.tmpXrHeadWorld, this.tmpEyeAnchor);
        this.handPoseSource[side] = 'xr-hand';
        this.setPoseFromHead(target, this.tmpVecA, this.tmpQuat);
        this.updateLowFingerJointWarning(side, true);
        continue;
      }

      if (grip) {
        grip.object.getWorldPosition(this.tmpVecA);
        grip.object.getWorldQuaternion(this.tmpQuat);
        if (isFiniteVector3Like(this.tmpVecA) && isFiniteQuaternionLike(this.tmpQuat)) {
          this.tmpQuat.multiply(this.trackedControllerRotationOffset).normalize();
          this.handPoseSource[side] = 'controller';
          this.setPoseFromHead(target, this.tmpVecA, this.tmpQuat);
          this.updateLowFingerJointWarning(side, false);
          continue;
        }
      }

      const controller = this.resolveSlot('controller', side);
      if (controller && this.readControllerPose(controller.object, this.tmpVecA, this.tmpQuat)) {
        this.tmpQuat.multiply(this.trackedControllerRotationOffset).normalize();
        this.handPoseSource[side] = 'controller';
        this.setPoseFromHead(target, this.tmpVecA, this.tmpQuat);
        this.updateLowFingerJointWarning(side, false);
        continue;
      }

      if (target.hasLastValidPose) {
        this.holdLastValidPose(side, this.tmpEyeAnchor);
        this.updateLowFingerJointWarning(side, false);
        continue;
      }

      // Final fallback: a visible neutral hand in front of the eyes while waiting for real tracking.
      this.tmpQuatB.copy(this.headPose.worldQuaternion);
      this.tmpVecA.set(side === 'left' ? -0.24 : 0.24, -0.18, -0.36).applyQuaternion(this.tmpQuatB).add(this.tmpEyeAnchor);
      this.tmpQuat.copy(this.tmpQuatB);
      setTrackedPose(target, this.tmpVecA, this.tmpQuat, this.tmpEyeAnchor);
      this.handPoseSource[side] = 'fallback';
      this.updateLowFingerJointWarning(side, false);
    }
  }

  /**
   * Thumbstick axes for a controller side, y forward-positive. Standard
   * mapping puts the stick at axes[2,3]; two-axis (touchpad) devices fall
   * back to axes[0,1]. Undefined when no gamepad reports for the side.
   */
  getThumbstickAxes(side: VrHandSide): { x: number; y: number } | undefined {
    if (!this.renderer.xr.isPresenting) return undefined;
    this.refreshInputSourcesFromSession();
    const session = this.renderer.xr.getSession();
    if (!session) return undefined;
    for (const source of session.inputSources) {
      if (source.handedness !== side) continue;
      const axes = (source as XrInputSourceLike).gamepad?.axes;
      if (!axes || axes.length < 2) continue;
      const base = axes.length >= 4 ? 2 : 0;
      const x = axes[base] ?? 0;
      const y = axes[base + 1] ?? 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      return { x, y: -y };
    }
    return undefined;
  }

  getHandTrackingState(side: VrHandSide): Readonly<HandTarget> {
    return this.handTargets[side];
  }

  getTrackedHandJointQuaternion(side: VrHandSide, jointName: TrackedHandJointName, out: THREE.Quaternion): boolean {
    const joint = this.joints[side][jointName];
    if (!joint.quaternionTracked) return false;
    out.copy(joint.quaternionWorld);
    return true;
  }

  getTrackedHandJointPosition(side: VrHandSide, jointName: TrackedHandJointName, out: THREE.Vector3): boolean {
    const joint = this.joints[side][jointName];
    if (!joint.positionTracked) return false;
    out.copy(joint.positionWorld);
    return true;
  }

  /**
   * What drives `side` now, for chrome that follows a hand: its target-ray
   * object (rays, selects) and grip object (a controller's wrist), and the
   * input source behind them (for haptics). Undefined parts are untracked.
   */
  getChromeInput(side: VrHandSide): { hand: boolean; targetRay: THREE.Group | undefined; grip: THREE.Group | undefined; inputSource: XRInputSource | undefined } {
    // Chrome takes only this side's own input, never the nearest tracked slot:
    // with one controller on, both sides would otherwise share it, and one
    // select would commit twice and the wrist would ride the pointing hand.
    const own = { ownSideOnly: true };
    const hand = this.resolveSlot('hand', side, own);
    const targetRay = this.resolveSlot('controller', side, own);
    const grip = this.resolveSlot('grip', side, own);
    const inputSource = (targetRay?.inputSource ?? hand?.inputSource) as XRInputSource | undefined;
    return { hand: Boolean(hand?.inputSource?.hand), targetRay: targetRay?.object, grip: grip?.object, inputSource };
  }

  getHandPoseSource(side: VrHandSide): HandPoseSource {
    return this.handPoseSource[side];
  }

  getTrackedFingerJointCount(side: VrHandSide): number {
    const joints = this.joints[side];
    let count = 0;
    for (const jointName of FINGER_TRACKED_JOINT_NAMES) {
      if (joints[jointName].positionTracked || joints[jointName].quaternionTracked) count += 1;
    }
    return count;
  }

  // A tracked pose relative to the tracked head, placed at the eye anchor.
  private setPoseFromHead(target: HandTarget, worldPosition: THREE.Vector3, worldQuaternion: THREE.Quaternion): void {
    this.tmpVecB.copy(worldPosition).sub(this.tmpXrHeadWorld).add(this.tmpEyeAnchor);
    setTrackedPose(target, this.tmpVecB, worldQuaternion, this.tmpEyeAnchor);
  }

  private holdLastValidPose(side: VrHandSide, eyeAnchor: THREE.Vector3): void {
    const target = this.handTargets[side];
    target.targetPosition.copy(eyeAnchor).add(target.lastValidOffsetFromEye);
    target.targetQuaternion.copy(target.lastValidQuaternion);
    target.poseValid = true;
    this.handPoseSource[side] = 'held';
  }

  private resetTrackingState(): void {
    for (const side of SIDES) {
      const target = this.handTargets[side];
      target.poseValid = false;
      target.hasLastValidPose = false;
      target.targetPosition.set(0, 0, 0);
      target.targetQuaternion.identity();
      target.lastValidPosition.set(0, 0, 0);
      target.lastValidQuaternion.identity();
      target.lastValidOffsetFromEye.set(0, 0, 0);
      this.clearTrackedHandJoints(side);
      this.lowFingerJointFrames[side] = 0;
      this.lowFingerJointWarned[side] = false;
    }
    // Input sources stay: their 'connected' events, which carry handedness,
    // fire before entry and do not fire again for the session.
  }

  private clearInputSources(): void {
    for (const kind of SLOT_KINDS) {
      for (const slot of this.slots[kind]) {
        slot.inputSource = undefined;
        slot.handednessHint = undefined;
      }
    }
    for (const side of SIDES) {
      this.lowFingerJointFrames[side] = 0;
      this.lowFingerJointWarned[side] = false;
    }
  }

  // Follows the session's current input sources: slots keep their side, and
  // a side whose slot was lost takes an unassigned slot.
  private refreshInputSourcesFromSession(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;
    const bySide: Record<SlotKind, Partial<Record<VrHandSide, XrInputSourceLike>>> = { grip: {}, hand: {}, controller: {} };
    for (const source of session.inputSources) {
      const side = toSide(source.handedness);
      if (!side) continue;
      for (const kind of SLOT_KINDS) {
        if (source[SLOT_SPACE[kind]]) bySide[kind][side] = source as XrInputSourceLike;
      }
    }
    for (const kind of SLOT_KINDS) {
      const slots = this.slots[kind];
      const space = SLOT_SPACE[kind];
      for (const slot of slots) {
        const side = slot.handednessHint ?? toSide(slot.inputSource?.handedness);
        const next = side ? bySide[kind][side] : undefined;
        if (side && next?.[space]) {
          slot.inputSource = next;
          slot.handednessHint = side;
        }
      }
      for (const side of SIDES) {
        if (!bySide[kind][side] || slots.some((slot) => slot.handednessHint === side)) continue;
        const unassigned = slots.find((slot) => !slot.handednessHint);
        if (unassigned) {
          unassigned.inputSource = bySide[kind][side];
          unassigned.handednessHint = side;
        }
      }
    }
  }

  // The slot tracking `side`: its declared handedness, then its remembered
  // side, then whichever tracked slot lies furthest to that side of the head.
  private resolveSlot(kind: SlotKind, side: VrHandSide, { ownSideOnly = false }: { ownSideOnly?: boolean } = {}): InputSlot | undefined {
    const slots = this.slots[kind];
    const space = SLOT_SPACE[kind];
    const read = (slot: InputSlot): boolean => this.readSlotPosition(kind, slot.object);

    const explicit = slots.find((slot) => slot.inputSource?.handedness === side && slot.inputSource[space]);
    if (explicit && read(explicit)) return explicit;
    const hinted = slots.find((slot) => slot.handednessHint === side && slot.inputSource?.[space]);
    if (hinted && read(hinted)) return hinted;
    if (ownSideOnly) return undefined;

    let fallback: InputSlot | undefined;
    let fallbackScore = -Infinity;
    for (const slot of slots) {
      if (!slot.inputSource?.[space] || !read(slot)) continue;
      const score = this.scorePoseForSide(this.tmpVecA, side);
      if (score > fallbackScore) {
        fallback = slot;
        fallbackScore = score;
      }
    }
    return fallback;
  }

  // Writes the slot's world position to tmpVecA; true when it is tracked.
  private readSlotPosition(kind: SlotKind, object: THREE.Group): boolean {
    if (kind === 'hand') return this.readHandPose(object, this.tmpVecA, this.tmpQuat);
    if (kind === 'controller') return this.readControllerPose(object, this.tmpVecA, this.tmpQuat);
    object.getWorldPosition(this.tmpVecA);
    return isFiniteVector3Like(this.tmpVecA);
  }

  private clearTrackedHandJoints(side: VrHandSide): void {
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      const joint = this.joints[side][jointName];
      joint.positionTracked = false;
      joint.quaternionTracked = false;
    }
  }

  private captureHandJoints(side: VrHandSide, hand: THREE.Group, xrHeadWorld: THREE.Vector3, eyeAnchorWorld: THREE.Vector3): void {
    const lookup = (hand as THREE.Group & { joints?: Record<string, THREE.Object3D | undefined> }).joints;
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      const object = lookup?.[jointName] ?? hand.getObjectByName(jointName);
      if (!object || !object.visible) continue;
      const joint = this.joints[side][jointName];
      object.getWorldPosition(this.tmpJointWorld);
      if (isFiniteVector3Like(this.tmpJointWorld)) {
        joint.positionWorld.copy(this.tmpJointWorld).sub(xrHeadWorld).add(eyeAnchorWorld);
        joint.positionTracked = isFiniteVector3Like(joint.positionWorld);
      }
      object.getWorldQuaternion(this.tmpQuatB);
      if (isFiniteQuaternionLike(this.tmpQuatB)) {
        joint.quaternionWorld.copy(this.tmpQuatB).normalize();
        joint.quaternionTracked = true;
      }
    }
  }

  private captureMockHandJoints(side: VrHandSide, mockHand: MockHand, eyeAnchorWorld: THREE.Vector3): void {
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      const mockJoint = mockHand.joints[jointName];
      if (!mockJoint.tracked) continue;
      const joint = this.joints[side][jointName];
      if (mockJoint.hasPosition && isFiniteVector3Like(mockJoint.position)) {
        joint.positionWorld.copy(mockJoint.position).applyQuaternion(this.mock.headQuaternion).add(eyeAnchorWorld);
        joint.positionTracked = isFiniteVector3Like(joint.positionWorld);
      }
      if (mockJoint.hasQuaternion && isFiniteQuaternionLike(mockJoint.quaternion)) {
        joint.quaternionWorld.copy(this.mock.headQuaternion).multiply(mockJoint.quaternion).normalize();
        joint.quaternionTracked = true;
      }
    }
  }

  // A hand's pose from its wrist (or the first tracked preferred joint, or any
  // joint-like child, wrist first).
  private readHandPose(hand: THREE.Group, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean {
    if (!hand.visible) return false;
    const lookup = (hand as THREE.Group & { joints?: Record<string, THREE.Object3D | undefined> }).joints;
    for (const jointName of PREFERRED_HAND_POSE_JOINTS) {
      const joint = lookup?.[jointName] ?? hand.getObjectByName(jointName);
      if (!joint || !joint.visible) continue;
      joint.getWorldPosition(outPosition);
      joint.getWorldQuaternion(outQuaternion);
      if (isFiniteVector3Like(outPosition) && isFiniteQuaternionLike(outQuaternion)) {
        outQuaternion.normalize();
        return true;
      }
    }

    let wristLike: THREE.Object3D | undefined;
    let jointLike: THREE.Object3D | undefined;
    hand.traverse((child) => {
      if (child === hand) return;
      const declared = (child as THREE.Object3D & { jointName?: unknown }).jointName;
      const jointName = typeof declared === 'string' ? declared : child.name;
      if (!jointName) return;
      const lower = jointName.toLowerCase();
      const isJointLike = typeof declared === 'string' || /(wrist|finger|thumb|metacarpal|phalanx)/.test(lower);
      if (!isJointLike || !child.visible) return;
      if (!jointLike) jointLike = child;
      if (!wristLike && lower.includes('wrist')) wristLike = child;
    });
    const joint = wristLike ?? jointLike;
    if (!joint) return false;
    joint.getWorldPosition(outPosition);
    joint.getWorldQuaternion(outQuaternion);
    if (!isFiniteVector3Like(outPosition) || !isFiniteQuaternionLike(outQuaternion)) return false;
    outQuaternion.normalize();
    return true;
  }

  private readControllerPose(controller: THREE.Group, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean {
    controller.getWorldPosition(outPosition);
    controller.getWorldQuaternion(outQuaternion);
    return isFiniteVector3Like(outPosition) && isFiniteQuaternionLike(outQuaternion);
  }

  // How far a point lies to `side` of the head, along the head's flat right.
  private scorePoseForSide(worldPosition: THREE.Vector3, side: VrHandSide): number {
    this.tmpVecB.copy(this.headPose.worldPosition);
    this.tmpQuat.copy(this.headPose.worldQuaternion);
    this.tmpVecC.set(1, 0, 0).applyQuaternion(this.tmpQuat).setY(0);
    if (this.tmpVecC.lengthSq() < 1e-8) this.tmpVecC.set(1, 0, 0);
    else this.tmpVecC.normalize();
    const sideOffset = this.tmpVecA.copy(worldPosition).sub(this.tmpVecB).dot(this.tmpVecC);
    return side === 'left' ? -sideOffset : sideOffset;
  }

  private updateLowFingerJointWarning(side: VrHandSide, trackedHandPoseUsed: boolean): void {
    if (!trackedHandPoseUsed) {
      this.lowFingerJointFrames[side] = 0;
      return;
    }
    const trackedCount = this.getTrackedFingerJointCount(side);
    if (trackedCount >= LOW_FINGER_JOINT_TRACKED_COUNT) {
      this.lowFingerJointFrames[side] = 0;
      return;
    }
    this.lowFingerJointFrames[side] += 1;
    if (this.lowFingerJointWarned[side] || this.lowFingerJointFrames[side] < LOW_FINGER_JOINT_WARN_FRAMES) return;
    this.lowFingerJointWarned[side] = true;
    console.warn(
      `[XR] ${side} hand pose is valid but finger joint tracking is low (${trackedCount}/${FINGER_TRACKED_JOINT_NAMES.length}) for ${LOW_FINGER_JOINT_WARN_FRAMES} frames.`
    );
  }
}

function toSide(value: string | undefined): VrHandSide | undefined {
  return value === 'left' || value === 'right' ? value : undefined;
}

function createHandTarget(): HandTarget {
  return {
    poseValid: false,
    hasLastValidPose: false,
    targetPosition: new THREE.Vector3(),
    targetQuaternion: new THREE.Quaternion(),
    lastValidPosition: new THREE.Vector3(),
    lastValidQuaternion: new THREE.Quaternion(),
    lastValidOffsetFromEye: new THREE.Vector3()
  };
}

function createJointMap(): Record<TrackedHandJointName, TrackedJoint> {
  const joints = {} as Record<TrackedHandJointName, TrackedJoint>;
  for (const jointName of TRACKED_HAND_JOINT_NAMES) {
    joints[jointName] = { positionTracked: false, quaternionTracked: false, positionWorld: new THREE.Vector3(), quaternionWorld: new THREE.Quaternion() };
  }
  return joints;
}

function setTrackedPose(target: HandTarget, positionWorld: THREE.Vector3, quaternionWorld: THREE.Quaternion, eyeAnchorWorld: THREE.Vector3): void {
  target.targetPosition.copy(positionWorld);
  target.targetQuaternion.copy(quaternionWorld);
  target.lastValidPosition.copy(positionWorld);
  target.lastValidQuaternion.copy(quaternionWorld);
  target.lastValidOffsetFromEye.copy(positionWorld).sub(eyeAnchorWorld);
  target.hasLastValidPose = true;
  target.poseValid = true;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const tmpHeadForward = new THREE.Vector3();
const tmpHeadUp = new THREE.Vector3();

// Heading of a head pose on the floor plane (0 = facing -Z, positive = turned
// left): the projected forward, blending near vertical (looking straight up
// or down) into the projected up vector, which then tilts along the heading.
export function headYawFromQuaternion(quaternion: THREE.Quaternion, fallbackYaw: number): number {
  tmpHeadForward.set(0, 0, -1).applyQuaternion(quaternion);
  tmpHeadUp.set(0, 1, 0).applyQuaternion(quaternion);
  const tilt = tmpHeadForward.y;
  tmpHeadForward.projectOnPlane(WORLD_UP);
  tmpHeadUp.projectOnPlane(WORLD_UP).multiplyScalar(-Math.sign(tilt));
  const flat = tmpHeadForward.length();
  const weight = THREE.MathUtils.smoothstep(flat, 0.15, 0.35);
  if (flat > 1e-6) tmpHeadForward.multiplyScalar(weight / flat);
  const upLength = tmpHeadUp.length();
  if (upLength > 1e-6) tmpHeadForward.addScaledVector(tmpHeadUp, (1 - weight) / upLength);
  if (tmpHeadForward.lengthSq() < 1e-8) return fallbackYaw;
  return Math.atan2(-tmpHeadForward.x, -tmpHeadForward.z);
}
