import * as THREE from 'three';
import { TRACKED_HAND_JOINT_NAMES, type HandPoseSource, type MockVrPoseInput, type TrackedHandJointName, type VrHandSide } from '../types/contracts';
import { isFiniteQuaternionLike, isFiniteVector3Like } from '../shared/math';

interface VrHandTrackingState {
  poseValid: boolean;
  hasLastValidPose: boolean;
  targetPosition: THREE.Vector3;
  targetQuaternion: THREE.Quaternion;
  lastValidPosition: THREE.Vector3;
  lastValidQuaternion: THREE.Quaternion;
  lastValidOffsetFromEye: THREE.Vector3;
}

interface XrInputSourceLike {
  handedness: string;
  gripSpace?: unknown;
  hand?: unknown;
  targetRaySpace?: unknown;
}

interface XrGripState {
  index: number;
  grip: THREE.Group;
  inputSource: XrInputSourceLike | undefined;
  handednessHint: VrHandSide | undefined;
}

interface XrHandSourceState {
  index: number;
  hand: THREE.Group;
  inputSource: XrInputSourceLike | undefined;
  handednessHint: VrHandSide | undefined;
}

interface XrControllerState {
  index: number;
  controller: THREE.Group;
  inputSource: XrInputSourceLike | undefined;
  handednessHint: VrHandSide | undefined;
}

interface MockVrJointState {
  tracked: boolean;
  hasPosition: boolean;
  hasQuaternion: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface MockVrHandState {
  tracked: boolean;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  joints: Record<TrackedHandJointName, MockVrJointState>;
}

interface MockVrState {
  enabled: boolean;
  headPosition: THREE.Vector3;
  headQuaternion: THREE.Quaternion;
  hands: Record<VrHandSide, MockVrHandState>;
}

interface TrackingRotationOptions {
  handPitchDeg?: number;
  handYawDeg?: number;
  handRollDeg?: number;
  handInwardYawDeg?: number;
  controllerPitchDeg?: number;
  controllerYawDeg?: number;
  controllerRollDeg?: number;
}

interface TrackedHandJointState {
  positionTracked: boolean;
  quaternionTracked: boolean;
  positionWorld: THREE.Vector3;
  quaternionWorld: THREE.Quaternion;
}

const FINGER_TRACKED_JOINT_NAMES = TRACKED_HAND_JOINT_NAMES.filter((jointName) => jointName !== 'wrist');
const LOW_FINGER_JOINT_TRACKED_COUNT = 6;
const LOW_FINGER_JOINT_WARN_FRAMES = 45;

export interface XrTransition {
  entered: boolean;
  exited: boolean;
}

export class XrSessionService {
  private readonly xrGripStates: XrGripState[];
  private readonly xrHandSources: XrHandSourceState[];
  private readonly xrControllers: XrControllerState[];
  private readonly xrHandState: Record<VrHandSide, VrHandTrackingState>;
  private readonly xrHandJointState: Record<VrHandSide, Record<TrackedHandJointName, TrackedHandJointState>>;
  private readonly mockVrState: MockVrState;
  private readonly lowFingerJointTrackedFrames: Record<VrHandSide, number> = { left: 0, right: 0 };
  private readonly lowFingerJointWarned: Record<VrHandSide, boolean> = { left: false, right: false };

  private wasXrPresenting = false;

  private readonly tmpVecA = new THREE.Vector3();
  private readonly tmpVecB = new THREE.Vector3();
  private readonly tmpVecC = new THREE.Vector3();
  private readonly tmpEyeAnchor = new THREE.Vector3();
  private readonly tmpXrHeadWorld = new THREE.Vector3();
  private readonly tmpHeadLocal = new THREE.Vector3();
  // Which input produced each hand's pose this frame (see HandPoseSource).
  private readonly handPoseSource: Record<VrHandSide, HandPoseSource> = { left: 'none', right: 'none' };
  private cameraRig: THREE.Group | null = null;
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpQuatB = new THREE.Quaternion();
  private readonly trackedHandRotationOffset = new THREE.Quaternion();
  private readonly trackedHandInwardYawOffsets: Record<VrHandSide, THREE.Quaternion> = {
    left: new THREE.Quaternion(),
    right: new THREE.Quaternion()
  };
  private readonly trackedControllerRotationOffset = new THREE.Quaternion();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    mockVrEnabledFromQuery: boolean,
    _avatarHeight: () => number,
    trackingRotationOptions?: TrackingRotationOptions
  ) {
    this.xrGripStates = [0, 1].map((index) => {
      const grip = renderer.xr.getControllerGrip(index);
      return { index, grip, inputSource: undefined, handednessHint: undefined };
    });

    this.xrHandSources = [0, 1].map((index) => {
      const hand = renderer.xr.getHand(index);
      return { index, hand, inputSource: undefined, handednessHint: undefined };
    });

    this.xrControllers = [0, 1].map((index) => {
      const controller = renderer.xr.getController(index);
      return { index, controller, inputSource: undefined, handednessHint: undefined };
    });

    this.xrHandState = {
      left: {
        poseValid: false,
        hasLastValidPose: false,
        targetPosition: new THREE.Vector3(),
        targetQuaternion: new THREE.Quaternion(),
        lastValidPosition: new THREE.Vector3(),
        lastValidQuaternion: new THREE.Quaternion(),
        lastValidOffsetFromEye: new THREE.Vector3()
      },
      right: {
        poseValid: false,
        hasLastValidPose: false,
        targetPosition: new THREE.Vector3(),
        targetQuaternion: new THREE.Quaternion(),
        lastValidPosition: new THREE.Vector3(),
        lastValidQuaternion: new THREE.Quaternion(),
        lastValidOffsetFromEye: new THREE.Vector3()
      }
    };
    this.xrHandJointState = {
      left: this.createTrackedHandJointStateMap(),
      right: this.createTrackedHandJointStateMap()
    };

    this.mockVrState = {
      enabled: mockVrEnabledFromQuery,
      headPosition: new THREE.Vector3(0, 0, 0),
      headQuaternion: new THREE.Quaternion(),
      hands: {
        left: {
          tracked: false,
          position: new THREE.Vector3(-0.2, -0.2, -0.35),
          quaternion: new THREE.Quaternion(),
          joints: this.createMockVrJointStateMap()
        },
        right: {
          tracked: false,
          position: new THREE.Vector3(0.2, -0.2, -0.35),
          quaternion: new THREE.Quaternion(),
          joints: this.createMockVrJointStateMap()
        }
      }
    };

    const handPitchRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.handPitchDeg ?? 0));
    const handYawRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.handYawDeg ?? 0));
    const handRollRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.handRollDeg ?? 0));
    this.trackedHandRotationOffset.setFromEuler(new THREE.Euler(handPitchRad, handYawRad, handRollRad, 'XYZ'));
    const handInwardYawRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.handInwardYawDeg ?? 0));
    this.trackedHandInwardYawOffsets.left.setFromEuler(new THREE.Euler(0, handInwardYawRad, 0, 'XYZ'));
    this.trackedHandInwardYawOffsets.right.setFromEuler(new THREE.Euler(0, -handInwardYawRad, 0, 'XYZ'));

    const controllerPitchRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.controllerPitchDeg ?? 0));
    const controllerYawRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.controllerYawDeg ?? 180));
    const controllerRollRad = THREE.MathUtils.degToRad(Number(trackingRotationOptions?.controllerRollDeg ?? 0));
    this.trackedControllerRotationOffset.setFromEuler(new THREE.Euler(controllerPitchRad, controllerYawRad, controllerRollRad, 'XYZ'));

    for (const gripState of this.xrGripStates) {
      const gripEvents = this.renderer.xr.getControllerGrip(gripState.index) as THREE.Object3D & {
        addEventListener(type: string, listener: (event: unknown) => void): void;
      };

      gripEvents.addEventListener('connected', (event) => {
        const xrEvent = event as Event & { data?: XrInputSourceLike };
        gripState.inputSource = xrEvent.data;
        if (xrEvent.data?.handedness === 'left' || xrEvent.data?.handedness === 'right') {
          gripState.handednessHint = xrEvent.data.handedness;
        }
      });
      gripEvents.addEventListener('disconnected', () => {
        gripState.inputSource = undefined;
        gripState.handednessHint = undefined;
      });
    }

    for (const handState of this.xrHandSources) {
      const handEvents = this.renderer.xr.getHand(handState.index) as THREE.Object3D & {
        addEventListener(type: string, listener: (event: unknown) => void): void;
      };

      handEvents.addEventListener('connected', (event) => {
        const xrEvent = event as Event & { data?: XrInputSourceLike };
        handState.inputSource = xrEvent.data;
        if (xrEvent.data?.handedness === 'left' || xrEvent.data?.handedness === 'right') {
          handState.handednessHint = xrEvent.data.handedness;
        }
      });
      handEvents.addEventListener('disconnected', () => {
        handState.inputSource = undefined;
        handState.handednessHint = undefined;
      });
    }

    for (const controllerState of this.xrControllers) {
      const controllerEvents = this.renderer.xr.getController(controllerState.index) as THREE.Object3D & {
        addEventListener(type: string, listener: (event: unknown) => void): void;
      };

      controllerEvents.addEventListener('connected', (event) => {
        const xrEvent = event as Event & { data?: XrInputSourceLike };
        controllerState.inputSource = xrEvent.data;
        if (xrEvent.data?.handedness === 'left' || xrEvent.data?.handedness === 'right') {
          controllerState.handednessHint = xrEvent.data.handedness;
        }
      });
      controllerEvents.addEventListener('disconnected', () => {
        controllerState.inputSource = undefined;
        controllerState.handednessHint = undefined;
      });
    }
  }

  mountToScene(_scene: THREE.Scene, cameraRig: THREE.Group): void {
    this.cameraRig = cameraRig;
    // Controllers, grips, and hands MUST be children of the cameraRig (the
    // VR dolly group) so their world positions include the same transform as
    // the XR camera.  Without this, getWorldPosition() returns raw XR
    // reference-space coordinates while the XR camera's getWorldPosition()
    // includes the dolly offset — making the subtraction in
    // updateHandTrackingTargets produce targets near the room origin instead
    // of near the avatar.
    for (const state of this.xrControllers) cameraRig.add(state.controller);
    for (const state of this.xrGripStates) cameraRig.add(state.grip);
    for (const state of this.xrHandSources) cameraRig.add(state.hand);
  }

  updateTransition(): XrTransition {
    const isXrPresenting = this.renderer.xr.isPresenting;
    const entered = !this.wasXrPresenting && isXrPresenting;
    const exited = this.wasXrPresenting && !isXrPresenting;
    this.wasXrPresenting = isXrPresenting;
    if (entered) {
      this.resetTrackingState();
    }
    if (exited) {
      this.clearRuntimeInputSources();
    }
    return { entered, exited };
  }

  isXrPresenting(): boolean {
    return this.renderer.xr.isPresenting;
  }

  isVrEmbodimentActive(): boolean {
    return this.renderer.xr.isPresenting || this.mockVrState.enabled;
  }

  isMockVrOnly(): boolean {
    return this.mockVrState.enabled && !this.renderer.xr.isPresenting;
  }

  applyMockVrPoseInput(payload: MockVrPoseInput): void {
    if (typeof payload.enabled === 'boolean') {
      this.mockVrState.enabled = payload.enabled;
    }

    const head = payload.head;
    if (head?.position) {
      this.mockVrState.headPosition.set(head.position.x, head.position.y, head.position.z);
    }
    if (head?.quaternion) {
      this.mockVrState.headQuaternion.set(head.quaternion.x, head.quaternion.y, head.quaternion.z, head.quaternion.w).normalize();
    }

    if (payload.hands) {
      for (const side of ['left', 'right'] as const) {
        const next = payload.hands[side];
        if (!next) continue;
        const mockHand = this.mockVrState.hands[side]!;
        if (typeof next.tracked === 'boolean') {
          mockHand.tracked = next.tracked;
        }
        if (next.position) {
          mockHand.position.set(next.position.x, next.position.y, next.position.z);
        }
        if (next.quaternion) {
          mockHand.quaternion.set(next.quaternion.x, next.quaternion.y, next.quaternion.z, next.quaternion.w).normalize();
        }
        if (next.joints) {
          for (const jointName of TRACKED_HAND_JOINT_NAMES) {
            const nextJoint = next.joints[jointName];
            if (!nextJoint) continue;
            const mockJoint = mockHand.joints[jointName]!;
            if (typeof nextJoint.tracked === 'boolean') {
              mockJoint.tracked = nextJoint.tracked;
            }
            if (nextJoint.position) {
              mockJoint.position.set(nextJoint.position.x, nextJoint.position.y, nextJoint.position.z);
              mockJoint.hasPosition = true;
            }
            if (nextJoint.quaternion) {
              mockJoint.quaternion.set(nextJoint.quaternion.x, nextJoint.quaternion.y, nextJoint.quaternion.z, nextJoint.quaternion.w).normalize();
              mockJoint.hasQuaternion = true;
            }
          }
        }
      }
    }
  }

  syncYaw(lookYaw: number): number {
    if (this.mockVrState.enabled) {
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.mockVrState.headQuaternion).projectOnPlane(new THREE.Vector3(0, 1, 0));
      if (forward.lengthSq() > 1e-8) {
        forward.normalize();
        return Math.atan2(-forward.x, -forward.z);
      }
    }

    if (this.renderer.xr.isPresenting) {
      const xrCamQuat = new THREE.Quaternion();
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.renderer.xr.getCamera().getWorldQuaternion(xrCamQuat)).projectOnPlane(new THREE.Vector3(0, 1, 0));
      if (forward.lengthSq() > 1e-8) {
        forward.normalize();
        return Math.atan2(-forward.x, -forward.z);
      }
      return lookYaw;
    }

    return lookYaw;
  }

  getMockHeadPose(): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    return { position: this.mockVrState.headPosition, quaternion: this.mockVrState.headQuaternion };
  }

  getCurrentHeadLocalY(): number | undefined {
    if (this.mockVrState.enabled) {
      return Number.isFinite(this.mockVrState.headPosition.y) ? this.mockVrState.headPosition.y : undefined;
    }

    if (this.renderer.xr.isPresenting) {
      // Tracking-space height: the XR camera's world position relative to the
      // rig the app dollies to the avatar's eye.
      this.renderer.xr.getCamera().getWorldPosition(this.tmpHeadLocal);
      this.cameraRig?.worldToLocal(this.tmpHeadLocal);
      return Number.isFinite(this.tmpHeadLocal.y) ? this.tmpHeadLocal.y : undefined;
    }
    return undefined;
  }

  updateHandTrackingTargets(getEyeAnchorWorld: (out: THREE.Vector3) => THREE.Vector3): void {
    if (this.mockVrState.enabled) {
      // The deterministic test hook keeps using synthetic hand/joint payloads,
      // even when an IWER XR session is active for camera/session emulation.
      for (const side of ['left', 'right'] as const) {
        const state = this.xrHandState[side]!;
        const mockHand = this.mockVrState.hands[side]!;
        this.clearTrackedHandJoints(side);
        state.poseValid = false;
        this.handPoseSource[side] = 'none';
        if (mockHand.tracked) {
          getEyeAnchorWorld(this.tmpEyeAnchor);
          this.tmpVecB.copy(mockHand.position).applyQuaternion(this.mockVrState.headQuaternion);
          this.tmpVecA.copy(this.tmpEyeAnchor).add(this.tmpVecB);
          this.tmpQuat
            .copy(this.mockVrState.headQuaternion)
            .multiply(mockHand.quaternion)
            .multiply(this.trackedHandInwardYawOffsets[side]!)
            .normalize();
          this.setTrackedPose(state, this.tmpVecA, this.tmpQuat, this.tmpEyeAnchor);
          this.captureMockTrackedHandJoints(side, mockHand, this.tmpEyeAnchor);
          this.handPoseSource[side] = 'mock';
          this.updateLowFingerJointWarningState(side, true);
          continue;
        }
        this.updateLowFingerJointWarningState(side, false);
        if (state.hasLastValidPose) {
          getEyeAnchorWorld(this.tmpEyeAnchor);
          state.targetPosition.copy(this.tmpEyeAnchor).add(state.lastValidOffsetFromEye);
          state.targetQuaternion.copy(state.lastValidQuaternion);
          state.poseValid = true;
          this.handPoseSource[side] = 'held';
        }
      }
      return;
    }

    if (!this.renderer.xr.isPresenting) {
      getEyeAnchorWorld(this.tmpEyeAnchor);
      for (const side of ['left', 'right'] as const) {
        const state = this.xrHandState[side]!;
        this.clearTrackedHandJoints(side);
        state.poseValid = false;
        this.handPoseSource[side] = 'none';
        this.updateLowFingerJointWarningState(side, false);
        if (!state.hasLastValidPose) continue;
        state.targetPosition.copy(this.tmpEyeAnchor).add(state.lastValidOffsetFromEye);
        state.targetQuaternion.copy(state.lastValidQuaternion);
        state.poseValid = true;
        this.handPoseSource[side] = 'held';
      }
      return;
    }

    this.refreshInputSourcesFromRuntime();
    getEyeAnchorWorld(this.tmpEyeAnchor);
    this.renderer.xr.getCamera().getWorldPosition(this.tmpXrHeadWorld);

    for (const side of ['left', 'right'] as const) {
      const state = this.xrHandState[side]!;
      this.clearTrackedHandJoints(side);
      state.poseValid = false;
      this.handPoseSource[side] = 'none';

      const handSource = this.resolveHandSourceForSide(side);
      const gripState = this.resolveGripForSide(side);

      if (handSource && this.getTrackedHandPose(handSource.hand, this.tmpVecA, this.tmpQuat)) {
        this.tmpQuat
          .multiply(this.trackedHandRotationOffset)
          .multiply(this.trackedHandInwardYawOffsets[side]!)
          .normalize();
        this.captureTrackedHandJoints(side, handSource.hand, this.tmpXrHeadWorld, this.tmpEyeAnchor);
        this.handPoseSource[side] = 'xr-hand';
        this.tmpVecB.copy(this.tmpVecA).sub(this.tmpXrHeadWorld).add(this.tmpEyeAnchor);
        this.setTrackedPose(state, this.tmpVecB, this.tmpQuat, this.tmpEyeAnchor);
        this.updateLowFingerJointWarningState(side, true);
        continue;
      }

      if (gripState) {
        gripState.grip.getWorldPosition(this.tmpVecA);
        gripState.grip.getWorldQuaternion(this.tmpQuat);
        const tracked = isFiniteVector3Like(this.tmpVecA) && isFiniteQuaternionLike(this.tmpQuat);

        if (tracked) {
          this.tmpQuat.multiply(this.trackedControllerRotationOffset).normalize();
          this.handPoseSource[side] = 'controller';
          this.tmpVecB.copy(this.tmpVecA).sub(this.tmpXrHeadWorld).add(this.tmpEyeAnchor);
          this.setTrackedPose(state, this.tmpVecB, this.tmpQuat, this.tmpEyeAnchor);
          this.updateLowFingerJointWarningState(side, false);
          continue;
        }
      }

      const controllerState = this.resolveControllerForSide(side);
      if (controllerState && this.getTrackedControllerPose(controllerState.controller, this.tmpVecA, this.tmpQuat)) {
        this.tmpQuat.multiply(this.trackedControllerRotationOffset).normalize();
        this.handPoseSource[side] = 'controller';
        this.tmpVecB.copy(this.tmpVecA).sub(this.tmpXrHeadWorld).add(this.tmpEyeAnchor);
        this.setTrackedPose(state, this.tmpVecB, this.tmpQuat, this.tmpEyeAnchor);
        this.updateLowFingerJointWarningState(side, false);
        continue;
      }

      if (state.hasLastValidPose) {
        state.targetPosition.copy(this.tmpEyeAnchor).add(state.lastValidOffsetFromEye);
        state.targetQuaternion.copy(state.lastValidQuaternion);
        state.poseValid = true;
        this.handPoseSource[side] = 'held';
        this.updateLowFingerJointWarningState(side, false);
        continue;
      }

      // Final fallback: keep a visible neutral hand pose in front of the eyes while waiting for real tracking.
      this.tmpQuatB.copy(this.renderer.xr.getCamera().getWorldQuaternion(this.tmpQuatB));
      this.tmpVecA.set(side === 'left' ? -0.24 : 0.24, -0.18, -0.36).applyQuaternion(this.tmpQuatB).add(this.tmpEyeAnchor);
      this.tmpQuat.copy(this.tmpQuatB);
      this.setTrackedPose(state, this.tmpVecA, this.tmpQuat, this.tmpEyeAnchor);
      this.handPoseSource[side] = 'fallback';
      this.updateLowFingerJointWarningState(side, false);
    }
  }

  getHandTrackingState(side: VrHandSide): VrHandTrackingState {
    return this.xrHandState[side]!;
  }

  getTrackedHandJointQuaternion(side: VrHandSide, jointName: TrackedHandJointName, outQuaternion: THREE.Quaternion): boolean {
    const jointState = this.xrHandJointState[side]![jointName];
    if (!jointState.quaternionTracked) return false;
    outQuaternion.copy(jointState.quaternionWorld);
    return true;
  }

  getTrackedHandJointPosition(side: VrHandSide, jointName: TrackedHandJointName, outPosition: THREE.Vector3): boolean {
    const jointState = this.xrHandJointState[side]![jointName];
    if (!jointState.positionTracked) return false;
    outPosition.copy(jointState.positionWorld);
    return true;
  }

  getHandPoseSource(side: VrHandSide): HandPoseSource {
    return this.handPoseSource[side];
  }

  getTrackedFingerJointCount(side: VrHandSide): number {
    return this.countTrackedFingerJoints(side);
  }

  getMockSnapshot(): { enabled: boolean; head: { x: number; y: number; z: number }; leftTracked: boolean; rightTracked: boolean } {
    return {
      enabled: this.mockVrState.enabled,
      head: {
        x: this.mockVrState.headPosition.x,
        y: this.mockVrState.headPosition.y,
        z: this.mockVrState.headPosition.z
      },
      leftTracked: this.mockVrState.hands.left.tracked,
      rightTracked: this.mockVrState.hands.right.tracked
    };
  }

  private resetTrackingState(): void {
    for (const side of ['left', 'right'] as const) {
      this.xrHandState[side]!.poseValid = false;
      this.xrHandState[side]!.hasLastValidPose = false;
      this.xrHandState[side]!.targetPosition.set(0, 0, 0);
      this.xrHandState[side]!.targetQuaternion.identity();
      this.xrHandState[side]!.lastValidPosition.set(0, 0, 0);
      this.xrHandState[side]!.lastValidQuaternion.identity();
      this.xrHandState[side]!.lastValidOffsetFromEye.set(0, 0, 0);
      this.clearTrackedHandJoints(side);
      this.lowFingerJointTrackedFrames[side] = 0;
      this.lowFingerJointWarned[side] = false;
    }
    // NOTE: Do NOT call clearRuntimeInputSources() here.
    // The 'connected' events that establish handedness hints fire BEFORE this
    // method runs on XR entry. Clearing them here would permanently lose the
    // controller-to-side mapping for the entire session, because 'connected'
    // events do not re-fire. The exited path and 'disconnected' handlers
    // already handle cleanup when leaving VR.
  }

  private clearRuntimeInputSources(): void {
    for (const gripState of this.xrGripStates) {
      gripState.inputSource = undefined;
      gripState.handednessHint = undefined;
    }
    for (const handState of this.xrHandSources) {
      handState.inputSource = undefined;
      handState.handednessHint = undefined;
    }
    for (const controllerState of this.xrControllers) {
      controllerState.inputSource = undefined;
      controllerState.handednessHint = undefined;
    }
    for (const side of ['left', 'right'] as const) {
      this.lowFingerJointTrackedFrames[side] = 0;
      this.lowFingerJointWarned[side] = false;
    }
  }

  private refreshInputSourcesFromRuntime(): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    const sideGripSources: Partial<Record<VrHandSide, XrInputSourceLike>> = {};
    const sideHandSources: Partial<Record<VrHandSide, XrInputSourceLike>> = {};
    const sideControllerSources: Partial<Record<VrHandSide, XrInputSourceLike>> = {};
    for (const source of session.inputSources) {
      const side = this.toVrHandSide(source.handedness);
      if (!side) continue;
      if (source.gripSpace) sideGripSources[side] = source as XrInputSourceLike;
      if (source.hand) sideHandSources[side] = source as XrInputSourceLike;
      if (source.targetRaySpace) sideControllerSources[side] = source as XrInputSourceLike;
    }

    // Update states that already have a known side assignment.
    for (const state of this.xrGripStates) {
      const stateSide = state.handednessHint ?? this.toVrHandSide(state.inputSource?.handedness);
      if (stateSide) {
        const next = sideGripSources[stateSide];
        if (next?.gripSpace) {
          state.inputSource = next;
          state.handednessHint = stateSide;
        }
      }
    }
    // Recover: assign any unmatched side sources to states that lack a hint.
    for (const side of ['left', 'right'] as const) {
      if (!sideGripSources[side]) continue;
      if (this.xrGripStates.some((s) => s.handednessHint === side)) continue;
      const unassigned = this.xrGripStates.find((s) => !s.handednessHint);
      if (unassigned) {
        unassigned.inputSource = sideGripSources[side];
        unassigned.handednessHint = side;
      }
    }

    for (const state of this.xrHandSources) {
      const stateSide = state.handednessHint ?? this.toVrHandSide(state.inputSource?.handedness);
      if (stateSide) {
        const next = sideHandSources[stateSide];
        if (next?.hand) {
          state.inputSource = next;
          state.handednessHint = stateSide;
        }
      }
    }
    for (const side of ['left', 'right'] as const) {
      if (!sideHandSources[side]) continue;
      if (this.xrHandSources.some((s) => s.handednessHint === side)) continue;
      const unassigned = this.xrHandSources.find((s) => !s.handednessHint);
      if (unassigned) {
        unassigned.inputSource = sideHandSources[side];
        unassigned.handednessHint = side;
      }
    }

    for (const state of this.xrControllers) {
      const stateSide = state.handednessHint ?? this.toVrHandSide(state.inputSource?.handedness);
      if (stateSide) {
        const next = sideControllerSources[stateSide];
        if (next?.targetRaySpace) {
          state.inputSource = next;
          state.handednessHint = stateSide;
        }
      }
    }
    for (const side of ['left', 'right'] as const) {
      if (!sideControllerSources[side]) continue;
      if (this.xrControllers.some((s) => s.handednessHint === side)) continue;
      const unassigned = this.xrControllers.find((s) => !s.handednessHint);
      if (unassigned) {
        unassigned.inputSource = sideControllerSources[side];
        unassigned.handednessHint = side;
      }
    }
  }

  private resolveHandSourceForSide(side: VrHandSide): XrHandSourceState | undefined {
    const explicit = this.xrHandSources.find((state) => state.inputSource?.handedness === side && state.inputSource.hand);
    if (explicit && this.getTrackedHandPose(explicit.hand, this.tmpVecA, this.tmpQuat)) return explicit;

    const hinted = this.xrHandSources.find((state) => state.handednessHint === side && state.inputSource?.hand);
    if (hinted && this.getTrackedHandPose(hinted.hand, this.tmpVecA, this.tmpQuat)) return hinted;

    let fallback: XrHandSourceState | undefined;
    let fallbackScore = -Infinity;

    for (const handState of this.xrHandSources) {
      if (!handState.inputSource?.hand) continue;
      if (!this.getTrackedHandPose(handState.hand, this.tmpVecA, this.tmpQuat)) continue;
      const score = this.scorePoseForSide(this.tmpVecA, side);
      if (score > fallbackScore) {
        fallback = handState;
        fallbackScore = score;
      }
    }

    return fallback;
  }

  private resolveGripForSide(side: VrHandSide): XrGripState | undefined {
    const explicit = this.xrGripStates.find((state) => state.inputSource?.handedness === side && state.inputSource.gripSpace);
    if (explicit) {
      explicit.grip.getWorldPosition(this.tmpVecA);
      if (isFiniteVector3Like(this.tmpVecA)) return explicit;
    }

    const hinted = this.xrGripStates.find((state) => state.handednessHint === side && state.inputSource?.gripSpace);
    if (hinted) {
      hinted.grip.getWorldPosition(this.tmpVecA);
      if (isFiniteVector3Like(this.tmpVecA)) return hinted;
    }

    let fallback: XrGripState | undefined;
    let fallbackScore = -Infinity;

    for (const gripState of this.xrGripStates) {
      if (!gripState.inputSource?.gripSpace) continue;
      gripState.grip.getWorldPosition(this.tmpVecA);
      if (!isFiniteVector3Like(this.tmpVecA)) continue;
      const score = this.scorePoseForSide(this.tmpVecA, side);
      if (score > fallbackScore) {
        fallback = gripState;
        fallbackScore = score;
      }
    }

    return fallback;
  }

  private resolveControllerForSide(side: VrHandSide): XrControllerState | undefined {
    const explicit = this.xrControllers.find((state) => state.inputSource?.handedness === side && state.inputSource.targetRaySpace);
    if (explicit && this.getTrackedControllerPose(explicit.controller, this.tmpVecA, this.tmpQuat)) return explicit;

    const hinted = this.xrControllers.find((state) => state.handednessHint === side && state.inputSource?.targetRaySpace);
    if (hinted && this.getTrackedControllerPose(hinted.controller, this.tmpVecA, this.tmpQuat)) return hinted;

    let fallback: XrControllerState | undefined;
    let fallbackScore = -Infinity;
    for (const controllerState of this.xrControllers) {
      if (!controllerState.inputSource?.targetRaySpace) continue;
      if (!this.getTrackedControllerPose(controllerState.controller, this.tmpVecA, this.tmpQuat)) continue;
      const score = this.scorePoseForSide(this.tmpVecA, side);
      if (score > fallbackScore) {
        fallback = controllerState;
        fallbackScore = score;
      }
    }
    return fallback;
  }

  private clearTrackedHandJoints(side: VrHandSide): void {
    const sideState = this.xrHandJointState[side]!;
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      sideState[jointName]!.positionTracked = false;
      sideState[jointName]!.quaternionTracked = false;
    }
  }

  private captureTrackedHandJoints(side: VrHandSide, hand: THREE.Group, xrHeadWorld: THREE.Vector3, eyeAnchorWorld: THREE.Vector3): void {
    const sideState = this.xrHandJointState[side]!;
    const handWithJoints = hand as THREE.Group & { joints?: Record<string, THREE.Object3D | undefined> };
    const jointLookup = handWithJoints.joints;

    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      const joint = jointLookup?.[jointName] ?? hand.getObjectByName(jointName);
      if (!joint || !joint.visible) continue;

      joint.getWorldPosition(this.tmpVecA);
      if (isFiniteVector3Like(this.tmpVecA)) {
        sideState[jointName]!.positionWorld.copy(this.tmpVecA).sub(xrHeadWorld).add(eyeAnchorWorld);
        sideState[jointName]!.positionTracked = isFiniteVector3Like(sideState[jointName]!.positionWorld);
      }

      joint.getWorldQuaternion(this.tmpQuatB);
      if (isFiniteQuaternionLike(this.tmpQuatB)) {
        sideState[jointName]!.quaternionWorld.copy(this.tmpQuatB).normalize();
        sideState[jointName]!.quaternionTracked = true;
      }
    }
  }

  private captureMockTrackedHandJoints(side: VrHandSide, mockHand: MockVrHandState, eyeAnchorWorld: THREE.Vector3): void {
    const sideState = this.xrHandJointState[side]!;
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      const mockJoint = mockHand.joints[jointName]!;
      if (!mockJoint.tracked) continue;

      if (mockJoint.hasPosition && isFiniteVector3Like(mockJoint.position)) {
        sideState[jointName]!.positionWorld.copy(mockJoint.position).applyQuaternion(this.mockVrState.headQuaternion).add(eyeAnchorWorld);
        sideState[jointName]!.positionTracked = isFiniteVector3Like(sideState[jointName]!.positionWorld);
      }

      if (mockJoint.hasQuaternion && isFiniteQuaternionLike(mockJoint.quaternion)) {
        sideState[jointName]!.quaternionWorld
          .copy(this.mockVrState.headQuaternion)
          .multiply(mockJoint.quaternion)
          .normalize();
        sideState[jointName]!.quaternionTracked = true;
      }
    }
  }

  private getTrackedHandPose(hand: THREE.Group, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean {
    if (!hand.visible) return false;

    const handWithJoints = hand as THREE.Group & { joints?: Record<string, THREE.Object3D | undefined> };
    const jointLookup = handWithJoints.joints;
    const preferredJointNames: TrackedHandJointName[] = [
      'wrist',
      'middle-finger-metacarpal',
      'index-finger-metacarpal',
      'thumb-metacarpal',
      'index-finger-phalanx-proximal',
      'middle-finger-phalanx-proximal'
    ];

    for (const jointName of preferredJointNames) {
      const joint = jointLookup?.[jointName] ?? hand.getObjectByName(jointName);
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
      const childAny = child as THREE.Object3D & { jointName?: unknown };
      const jointName = typeof childAny.jointName === 'string' ? childAny.jointName : child.name;
      if (!jointName) return;
      const lower = jointName.toLowerCase();
      const isJointLike = typeof childAny.jointName === 'string' || /(wrist|finger|thumb|metacarpal|phalanx)/.test(lower);
      if (!isJointLike) return;
      if (!child.visible) return;
      if (!jointLike) jointLike = child;
      if (!wristLike && lower.includes('wrist')) wristLike = child;
    });
    jointLike = wristLike ?? jointLike;
    if (jointLike) {
      jointLike.getWorldPosition(outPosition);
      jointLike.getWorldQuaternion(outQuaternion);
      if (isFiniteVector3Like(outPosition) && isFiniteQuaternionLike(outQuaternion)) {
        outQuaternion.normalize();
        return true;
      }
    }
    return false;
  }

  private getTrackedControllerPose(controller: THREE.Group, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean {
    controller.getWorldPosition(outPosition);
    controller.getWorldQuaternion(outQuaternion);
    return isFiniteVector3Like(outPosition) && isFiniteQuaternionLike(outQuaternion);
  }

  private scorePoseForSide(worldPosition: THREE.Vector3, side: VrHandSide): number {
    const xrCamera = this.renderer.xr.getCamera();
    xrCamera.getWorldPosition(this.tmpVecB);
    xrCamera.getWorldQuaternion(this.tmpQuat);
    this.tmpVecC.set(1, 0, 0).applyQuaternion(this.tmpQuat).setY(0);
    if (this.tmpVecC.lengthSq() < 1e-8) {
      this.tmpVecC.set(1, 0, 0);
    } else {
      this.tmpVecC.normalize();
    }
    const sideOffset = this.tmpVecA.copy(worldPosition).sub(this.tmpVecB).dot(this.tmpVecC);
    return side === 'left' ? -sideOffset : sideOffset;
  }

  private countTrackedFingerJoints(side: VrHandSide): number {
    const sideState = this.xrHandJointState[side]!;
    let trackedCount = 0;
    for (const jointName of FINGER_TRACKED_JOINT_NAMES) {
      const joint = sideState[jointName]!;
      if (joint.positionTracked || joint.quaternionTracked) {
        trackedCount += 1;
      }
    }
    return trackedCount;
  }

  private updateLowFingerJointWarningState(side: VrHandSide, trackedHandPoseUsed: boolean): void {
    if (!trackedHandPoseUsed) {
      this.lowFingerJointTrackedFrames[side] = 0;
      return;
    }

    const trackedCount = this.countTrackedFingerJoints(side);
    if (trackedCount >= LOW_FINGER_JOINT_TRACKED_COUNT) {
      this.lowFingerJointTrackedFrames[side] = 0;
      return;
    }

    this.lowFingerJointTrackedFrames[side] = this.lowFingerJointTrackedFrames[side]! + 1;
    if (this.lowFingerJointWarned[side] || this.lowFingerJointTrackedFrames[side]! < LOW_FINGER_JOINT_WARN_FRAMES) return;

    this.lowFingerJointWarned[side] = true;
    console.warn(
      `[XR] ${side} hand pose is valid but finger joint tracking is low (${trackedCount}/${FINGER_TRACKED_JOINT_NAMES.length}) for ${LOW_FINGER_JOINT_WARN_FRAMES} frames.`
    );
  }

  private isLikelySidePosition(worldPosition: THREE.Vector3, side: VrHandSide): boolean {
    return this.scorePoseForSide(worldPosition, side) >= -0.03;
  }

  private toVrHandSide(value: string | undefined): VrHandSide | undefined {
    if (value === 'left' || value === 'right') return value;
    return undefined;
  }

  private createMockVrJointStateMap(): Record<TrackedHandJointName, MockVrJointState> {
    const out = {} as Record<TrackedHandJointName, MockVrJointState>;
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      out[jointName] = {
        tracked: false,
        hasPosition: false,
        hasQuaternion: false,
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion()
      };
    }
    return out;
  }

  private createTrackedHandJointStateMap(): Record<TrackedHandJointName, TrackedHandJointState> {
    const out = {} as Record<TrackedHandJointName, TrackedHandJointState>;
    for (const jointName of TRACKED_HAND_JOINT_NAMES) {
      out[jointName] = {
        positionTracked: false,
        quaternionTracked: false,
        positionWorld: new THREE.Vector3(),
        quaternionWorld: new THREE.Quaternion()
      };
    }
    return out;
  }

  private setTrackedPose(
    state: VrHandTrackingState,
    positionWorld: THREE.Vector3,
    quaternionWorld: THREE.Quaternion,
    eyeAnchorWorld: THREE.Vector3
  ): void {
    state.targetPosition.copy(positionWorld);
    state.targetQuaternion.copy(quaternionWorld);
    state.lastValidPosition.copy(positionWorld);
    state.lastValidQuaternion.copy(quaternionWorld);
    state.lastValidOffsetFromEye.copy(positionWorld).sub(eyeAnchorWorld);
    state.hasLastValidPose = true;
    state.poseValid = true;
  }
}
