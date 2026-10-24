import { useAnimations, useGLTF } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import { useXR } from "@react-three/xr";
import { Box3, LoopRepeat, MathUtils, Quaternion, Vector3 } from "three";
import type { AnimationAction, Group, Object3D } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { TRUE_SCALE } from "@holoim/xr-ui-core";


import { prepareAnimatedScene } from "../hologram/object3dUtils";
import { isInsideRecordedObject } from "../objects/recordedObjects";
import { useSphereClipping } from "../hologram/useSphereClipping";
import type { SphereClipResult, SphereClipStatus } from "../hologram/useSphereClipping";
import { ARDepthOcclusion } from "./ARDepthOcclusion";
import { freezeBubbleWrapperMotion } from "./arAnimation";
import { ARBubbleAura } from "./ARBubbleAura";
import {
  computeFloorPlacement,
  computeVisibilityFallbackPlacement,
  evaluatePlacementVisibility,
  type ArPlacementMode
} from "./arPlacement";

const HOLOGRAM_ANIMATION_SPEED = 1;
// Only for the first viewing distance when a recording has no measurable height.
const AR_UNKNOWN_HEIGHT_METERS = 1.7;
const AR_FOOT_MIN_FRONT_METERS = 0.3;
const AR_FOOT_FRONT_HEIGHT_RATIO = 0.2;
const AR_INITIAL_POSITION = new Vector3(0, 0.05, -2);
const AR_LOCAL_REFERENCE_SPACE_MAX_Y_METERS = 0.45;
const AR_INITIAL_FORWARD_DISTANCE_MIN_METERS = 1.8;
const AR_INITIAL_FORWARD_DISTANCE_MAX_METERS = 8;
const AR_INITIAL_FORWARD_DISTANCE_HEIGHT_MULTIPLIER = 0.9;
const AR_INITIAL_FORWARD_DISTANCE_BUBBLE_MARGIN_METERS = 1.1;
const AR_FLOOR_PLACEMENT_VIEW_LIFT_METERS = 0.08;
const AR_FALLBACK_PLACEMENT_VERTICAL_OFFSET_METERS = -0.22;
const AR_VISIBILITY_PROBE_HEIGHT_RATIO = 0.55;
const AR_VISIBILITY_MONITOR_FRAMES = 45;
const AR_FALLBACK_TRIGGER_FAILURE_FRAMES = 12;
const AR_HIT_TEST_TIMEOUT_MS = 3500;
const AR_TARGET_WORLD_QUATERNION = new Quaternion();
const AR_HIT_TEST_RAY_DIRECTION = Object.freeze({ x: 0, y: -0.35, z: -1, w: 0 });
// A hit pose's Y axis is the surface normal; only near-horizontal, upward
// surfaces (floors, tables) can hold a standing hologram, never walls.
const AR_MIN_SURFACE_UP_DOT = 0.8;

function isUpwardSurface({ x, z }: DOMPointReadOnly): boolean {
  // World Y component of the pose's +Y axis, which is the surface normal.
  return 1 - 2 * (x * x + z * z) >= AR_MIN_SURFACE_UP_DOT;
}

type PlacementStage = "unplaced" | "searching" | "placed" | "anchored" | "locked";
type PlaneLike = {
  orientation?: string;
  planeSpace?: XRSpace;
};

type PlacementRuntimeState = {
  stage: PlacementStage;
  stablePoseFrames: number;
  monitorFrames: number;
  continuousVisibilityFailures: number;
};

export type ArPlacementStatus = {
  stage: PlacementStage;
  mode: ArPlacementMode | null;
  reason: string;
  anchored: boolean;
  sequence: number;
  // Where the model sits in the session's reference space after this update.
  position?: [number, number, number];
};

type ARHologramModelProps = {
  enableDepthOcclusion: boolean;
  url: string;
  placementVersion: number;
  onBubbleStatusChange: (status: SphereClipStatus) => void;
  onPlacementStatusChange?: (status: ArPlacementStatus) => void;
  /** The viewer's rescale; true scale (Q13) unless they pinch, and then labelled at the foot. */
  scaleFactor?: number;
  paused?: boolean;
  /** Written every frame with the playing take's time, in seconds, for the timecode. */
  playbackSecondsRef?: MutableRefObject<number>;
  /** The controls at the hologram's foot: in its placement, never in its scale. */
  children?: (foot: { frontMeters: number }) => ReactNode;
  /** World-space chrome that follows the bubble, read every frame (the edge's ring). */
  bubbleChrome?: (bubble: SphereClipResult) => ReactNode;
};

function createPlacementRuntimeState(): PlacementRuntimeState {
  return {
    stage: "unplaced",
    stablePoseFrames: 0,
    monitorFrames: 0,
    continuousVisibilityFailures: 0
  };
}

function createPlacementStatus(): ArPlacementStatus {
  return {
    stage: "unplaced",
    mode: null,
    reason: "unplaced",
    anchored: false,
    sequence: 0
  };
}

function isFiniteVector(vector: Vector3): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteQuaternion(quaternion: Quaternion): boolean {
  return Number.isFinite(quaternion.x)
    && Number.isFinite(quaternion.y)
    && Number.isFinite(quaternion.z)
    && Number.isFinite(quaternion.w);
}

function isFiniteCameraPose(position: Vector3, quaternion: Quaternion): boolean {
  return isFiniteVector(position) && isFiniteQuaternion(quaternion);
}

function toArray(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function toQuaternionArray(quaternion: Quaternion): [number, number, number, number] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

/**
 * Bounds of the recording without the objects the author handled: a prop
 * held below the feet or at arm's length must not lift or shrink the avatar.
 */
function boundsWithoutObjects(root: Object3D): Box3 {
  const bounds = new Box3();
  const scratch = new Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((child) => {
    const mesh = child as Object3D & { isMesh?: boolean };
    if (!mesh.isMesh || isInsideRecordedObject(child)) return;
    scratch.setFromObject(child);
    if (!scratch.isEmpty()) bounds.union(scratch);
  });
  return bounds;
}

function normalizeSceneAtOrigin(root: Object3D): void {
  const anchor = root.getObjectByName("RecordedAvatar")
    ?? root.getObjectByName("Hips")
    ?? root.getObjectByName("mixamorigHips")
    ?? root;

  const anchorPos = anchor.getWorldPosition(new Vector3());
  if (!Number.isFinite(anchorPos.x) || !Number.isFinite(anchorPos.y) || !Number.isFinite(anchorPos.z)) return;

  root.position.sub(anchorPos);

  const bounds = boundsWithoutObjects(root);
  if (!bounds.isEmpty() && Number.isFinite(bounds.min.y)) {
    root.position.y -= bounds.min.y;
  }
}

export function ARHologramModel({
  enableDepthOcclusion,
  url,
  placementVersion,
  onBubbleStatusChange,
  onPlacementStatusChange,
  scaleFactor = TRUE_SCALE,
  paused = false,
  playbackSecondsRef,
  children,
  bubbleChrome
}: ARHologramModelProps) {
  const { scene, animations } = useGLTF(url);
  const renderer = useThree((state) => state.gl);
  const renderScene = useThree((state) => state.scene);
  const clonedScene = useMemo(() => {
    const cloned = cloneSkeleton(scene);
    prepareAnimatedScene(cloned);
    normalizeSceneAtOrigin(cloned);
    return cloned;
  }, [scene]);
  // True scale is a fact (principle 6): the recording opens at its own size,
  // and only the viewer's own, labelled rescale changes it.
  const modelScale = scaleFactor;
  const modelHeightMeters = useMemo(() => {
    const bounds = boundsWithoutObjects(clonedScene);
    const size = bounds.getSize(new Vector3());
    if (!Number.isFinite(size.y) || size.y <= 1e-4) {
      return AR_UNKNOWN_HEIGHT_METERS;
    }
    return size.y * modelScale;
  }, [clonedScene, modelScale]);
  const visibilityProbeHeightMeters = useMemo(
    () => Math.max(0.2, modelHeightMeters * AR_VISIBILITY_PROBE_HEIGHT_RATIO),
    [modelHeightMeters]
  );
  const sphereClip = useSphereClipping(clonedScene, {
    falloffWidth: 0.2,
    safeMode: true,
    onStatus: onBubbleStatusChange,
    onError: (error) => {
      if (import.meta.env.DEV) {
        console.warn("[AR] Bubble clipping fallback triggered.", error);
      }
    }
  });
  // The foot row stands at the front of the bubble, or a short step ahead of a recording without one.
  const footFrontMeters = sphereClip.active && Number.isFinite(sphereClip.radius) && sphereClip.radius > 0
    ? sphereClip.radius
    : Math.max(AR_FOOT_MIN_FRONT_METERS, modelHeightMeters * AR_FOOT_FRONT_HEIGHT_RATIO);
  const arAnimations = useMemo(() => freezeBubbleWrapperMotion(animations), [animations]);
  const { actions, mixer } = useAnimations(arAnimations, clonedScene);
  const xrSession = useXR((state) => state.session);
  const xrSessionRef = useRef<XRSession | null>(null);
  const originReferenceSpace = useXR((state) => state.originReferenceSpace);
  const groupRef = useRef<Group>(null);
  const footRef = useRef<Group>(null);
  const primaryActionRef = useRef<AnimationAction | null>(null);
  const placementStateRef = useRef<PlacementRuntimeState>(createPlacementRuntimeState());
  const placementStatusRef = useRef<ArPlacementStatus>(createPlacementStatus());
  const anchorReportedRef = useRef(new Vector3());
  const anchorRef = useRef<XRAnchor | null>(null);
  const anchorRequestPendingRef = useRef(false);
  const hitTestSourceRef = useRef<XRHitTestSource | null>(null);
  const cameraPositionRef = useRef(new Vector3());
  const cameraQuaternionRef = useRef(new Quaternion());
  const cameraForwardRef = useRef(new Vector3());
  const visibilityProbePositionRef = useRef(new Vector3());
  const hitTestPositionRef = useRef(new Vector3());

  useEffect(() => {
    // Opt-in local E2E observer: tests inspect real XR cameras and pixels.
    // This branch is removed from production builds.
    if (import.meta.env.DEV) {
      const observer = (window as Window & {
        __HOLOIM_AR_TEST_OBSERVER__?: (value: unknown) => void;
      }).__HOLOIM_AR_TEST_OBSERVER__;
      observer?.({ renderer, scene: renderScene, model: clonedScene, bubble: sphereClip, actions, mixer });
    }
  }, [actions, clonedScene, mixer, renderScene, renderer, sphereClip]);

  useEffect(() => {
    xrSessionRef.current = xrSession ?? null;
  }, [xrSession]);

  const resolveForwardDistance = useCallback((): number => {
    const bubbleRadiusMeters = sphereClip.active && Number.isFinite(sphereClip.radius) && sphereClip.radius > 0
      ? sphereClip.radius
      : 0;
    const byHeight = modelHeightMeters * AR_INITIAL_FORWARD_DISTANCE_HEIGHT_MULTIPLIER;
    const byBubble = bubbleRadiusMeters > 0
      ? bubbleRadiusMeters + AR_INITIAL_FORWARD_DISTANCE_BUBBLE_MARGIN_METERS
      : 0;
    return MathUtils.clamp(
      Math.max(byHeight, byBubble),
      AR_INITIAL_FORWARD_DISTANCE_MIN_METERS,
      AR_INITIAL_FORWARD_DISTANCE_MAX_METERS
    );
  }, [modelHeightMeters, sphereClip.active, sphereClip.radius]);

  const logPlacement = useCallback((message: string, details: Record<string, unknown>): void => {
    if (!import.meta.env.DEV) {
      return;
    }

    console.info("[AR placement]", message, details);
  }, []);

  const clearActiveAnchor = useCallback((deleteAnchor: boolean): void => {
    anchorRequestPendingRef.current = false;
    const activeAnchor = anchorRef.current;
    anchorRef.current = null;
    if (!activeAnchor || !deleteAnchor) {
      return;
    }

    try {
      activeAnchor.delete();
    } catch {
      // Best effort cleanup only.
    }
  }, []);

  const clearActiveHitTestSource = useCallback((): void => {
    const activeHitTestSource = hitTestSourceRef.current;
    hitTestSourceRef.current = null;
    if (!activeHitTestSource) {
      return;
    }

    try {
      activeHitTestSource.cancel();
    } catch {
      // Best effort cleanup only.
    }
  }, []);

  const emitPlacementStatus = useCallback((
    next: Partial<ArPlacementStatus>,
    { incrementSequence = false }: { incrementSequence?: boolean } = {}
  ): void => {
    const current = placementStatusRef.current;
    const group = groupRef.current;
    const updated: ArPlacementStatus = {
      ...current,
      ...next,
      sequence: incrementSequence ? current.sequence + 1 : current.sequence,
      ...(group ? { position: [group.position.x, group.position.y, group.position.z] as [number, number, number] } : {})
    };
    placementStatusRef.current = updated;
    onPlacementStatusChange?.(updated);
  }, [onPlacementStatusChange]);

  const applyPlacementTransform = useCallback((position: Vector3, quaternion = AR_TARGET_WORLD_QUATERNION): void => {
    if (!groupRef.current) {
      return;
    }
    groupRef.current.position.copy(position);
    groupRef.current.quaternion.copy(quaternion);
  }, []);

  const requestWorldAnchor = useCallback((
    frame: XRFrame,
    position: Vector3,
    reason: string
  ): void => {
    if (anchorRef.current || anchorRequestPendingRef.current || !originReferenceSpace) {
      return;
    }

    const createAnchor = frame.createAnchor?.bind(frame);
    if (!createAnchor) {
      return;
    }

    anchorRequestPendingRef.current = true;
    const transform = new XRRigidTransform(
      { x: position.x, y: position.y, z: position.z, w: 1 },
      { x: 0, y: 0, z: 0, w: 1 }
    );

    void createAnchor(transform, originReferenceSpace)
      .then((anchor: XRAnchor | undefined) => {
        anchorRequestPendingRef.current = false;
        if (!anchor || placementStatusRef.current.mode == null) {
          return;
        }

        anchorRef.current = anchor;
        placementStateRef.current.stage = "anchored";
        emitPlacementStatus({
          stage: "anchored",
          reason,
          anchored: true
        });
      })
      .catch((error: unknown) => {
        anchorRequestPendingRef.current = false;
        if (import.meta.env.DEV) {
          console.warn("[AR] Anchor placement unavailable; continuing without anchor.", error);
        }
      });
  }, [emitPlacementStatus, originReferenceSpace]);

  const applyFallbackPlacement = useCallback((reason: string): void => {
    const state = placementStateRef.current;
    const camPos = cameraPositionRef.current;
    const camQuat = cameraQuaternionRef.current;
    const distanceMeters = resolveForwardDistance();
    const shouldUseCameraRelativePlacement = camPos.y <= AR_LOCAL_REFERENCE_SPACE_MAX_Y_METERS;
    const placement = shouldUseCameraRelativePlacement
      ? computeVisibilityFallbackPlacement(camPos, camQuat, {
        distanceMeters,
        verticalOffsetMeters: AR_FALLBACK_PLACEMENT_VERTICAL_OFFSET_METERS
      })
      : computeFloorPlacement(camPos, camQuat, {
        distanceMeters,
        verticalOffsetMeters: AR_FLOOR_PLACEMENT_VIEW_LIFT_METERS
      });

    clearActiveAnchor(true);
    applyPlacementTransform(placement.position);
    state.stage = "placed";
    state.monitorFrames = 0;
    state.continuousVisibilityFailures = 0;
    emitPlacementStatus(
      {
        stage: "placed",
        mode: placement.mode,
        reason,
        anchored: false
      },
      { incrementSequence: true }
    );

    logPlacement("applied fallback placement", {
      mode: placement.mode,
      reason,
      cameraRelative: shouldUseCameraRelativePlacement,
      cameraPosition: toArray(camPos),
      cameraQuaternion: toQuaternionArray(camQuat),
      targetPosition: toArray(placement.position)
    });
  }, [applyPlacementTransform, clearActiveAnchor, emitPlacementStatus, logPlacement, resolveForwardDistance]);

  useEffect(() => {
    placementStateRef.current = createPlacementRuntimeState();
    clearActiveHitTestSource();
    clearActiveAnchor(true);
    emitPlacementStatus({
      stage: "unplaced",
      mode: null,
      reason: "unplaced",
      anchored: false
    });
    if (groupRef.current) {
      groupRef.current.position.copy(AR_INITIAL_POSITION);
      groupRef.current.quaternion.copy(AR_TARGET_WORLD_QUATERNION);
    }
  }, [applyPlacementTransform, clearActiveAnchor, clearActiveHitTestSource, emitPlacementStatus, placementVersion, url]);

  useEffect(() => {
    const activeSession = xrSessionRef.current;
    if (!activeSession || !groupRef.current) {
      clearActiveHitTestSource();
      clearActiveAnchor(false);
      return;
    }

    let cancelled = false;

    // The frame loop, the timeout fallback, and the IWER assist all act only
    // while the runtime state is searching; reporting it is not enough.
    placementStateRef.current.stage = "searching";
    placementStateRef.current.stablePoseFrames = 0;
    emitPlacementStatus({
      stage: "searching",
      mode: null,
      reason: "hit-test-search",
      anchored: false
    });

    void (async () => {
      try {
        const requestHitTestSource = activeSession.requestHitTestSource?.bind(activeSession);
        if (!requestHitTestSource) {
          throw new Error("XRSession.requestHitTestSource is unavailable.");
        }

        const viewerReferenceSpace = await activeSession.requestReferenceSpace("viewer");
        if (cancelled) {
          return;
        }

        const offsetRay = typeof XRRay === "function"
          ? new XRRay(
            { x: 0, y: 0, z: 0, w: 1 },
            AR_HIT_TEST_RAY_DIRECTION
          )
          : undefined;
        const hitTestSource = await requestHitTestSource({
          space: viewerReferenceSpace,
          entityTypes: ["plane", "mesh"],
          ...(offsetRay ? { offsetRay } : {})
        });
        if (!hitTestSource) {
          throw new Error("XRSession.requestHitTestSource returned no hit-test source.");
        }
        if (cancelled) {
          hitTestSource.cancel();
          return;
        }

        hitTestSourceRef.current = hitTestSource;
      } catch (error) {
        if (!cancelled) {
          applyFallbackPlacement("hit-test-unavailable");
        }
        if (import.meta.env.DEV) {
          console.warn("[AR] Hit-test placement unavailable; using fallback.", error);
        }
        return;
      }
    })();

    const timeoutId = window.setTimeout(() => {
      if (cancelled || placementStateRef.current.stage !== "searching") {
        return;
      }

      if (!hitTestSourceRef.current) {
        applyFallbackPlacement("hit-test-unavailable");
        return;
      }

      clearActiveHitTestSource();
      if (placementStateRef.current.stage === "searching") {
        applyFallbackPlacement("hit-test-timeout");
      }
    }, AR_HIT_TEST_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      clearActiveHitTestSource();
    };
    // This effect owns the session-scoped hit-test lifecycle and must only restart when the
    // XR session or explicit placement reset changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placementVersion, Boolean(xrSession)]);

  useEffect(() => {
    mixer.timeScale = paused ? 0 : 1;
  }, [mixer, paused]);

  // The foot row follows the hologram's placement, not its scale.
  useFrame(() => {
    const group = groupRef.current;
    const foot = footRef.current;
    if (playbackSecondsRef) playbackSecondsRef.current = primaryActionRef.current?.time ?? 0;
    if (!group || !foot) return;
    foot.position.copy(group.position);
    foot.quaternion.copy(group.quaternion);
  });

  useFrame(({ camera }, _delta, frame) => {
    if (!groupRef.current) {
      return;
    }

    const camPos = camera.getWorldPosition(cameraPositionRef.current);
    const camQuat = camera.getWorldQuaternion(cameraQuaternionRef.current);
    const camForward = cameraForwardRef.current.set(0, 0, -1).applyQuaternion(camQuat);
    const state = placementStateRef.current;

    if (!isFiniteCameraPose(camPos, camQuat)) {
      state.stablePoseFrames = 0;
      return;
    }

    if (anchorRef.current && frame && originReferenceSpace) {
      try {
        const anchorPose = frame.getPose(anchorRef.current.anchorSpace, originReferenceSpace);
        if (anchorPose) {
          groupRef.current.position.set(
            anchorPose.transform.position.x,
            anchorPose.transform.position.y,
            anchorPose.transform.position.z
          );
          groupRef.current.quaternion.copy(AR_TARGET_WORLD_QUATERNION);
          // Keep the reported position current when the anchor relocalizes.
          const reported = placementStatusRef.current.position;
          if (!reported || groupRef.current.position.distanceTo(anchorReportedRef.current.set(...reported)) > 0.01) {
            emitPlacementStatus({});
          }
        }
      } catch {
        clearActiveAnchor(false);
        emitPlacementStatus({ anchored: false, stage: "placed", reason: "anchor-lost" });
      }
      return;
    }

    if (state.stage === "searching" && frame) {
      if (originReferenceSpace) {
        const hitTestResults = hitTestSourceRef.current ? frame.getHitTestResults(hitTestSourceRef.current) : [];
        let hitTestPose: XRPose | undefined;
        for (const result of hitTestResults) {
          const pose = result.getPose(originReferenceSpace);
          if (pose && isUpwardSurface(pose.transform.orientation)) {
            hitTestPose = pose;
            break;
          }
        }
        if (hitTestPose) {
          const hitTestPosition = hitTestPositionRef.current.set(
            hitTestPose.transform.position.x,
            hitTestPose.transform.position.y,
            hitTestPose.transform.position.z
          );

          clearActiveAnchor(true);
          clearActiveHitTestSource();
          applyPlacementTransform(hitTestPosition);

          state.stage = "placed";
          state.monitorFrames = 0;
          state.continuousVisibilityFailures = 0;
          emitPlacementStatus(
            {
              stage: "placed",
              mode: "hit-test",
              reason: "hit-test-stable",
              anchored: false
            },
            { incrementSequence: true }
          );

          logPlacement("applied hit-test placement", {
            anchored: false,
            cameraPosition: toArray(camPos),
            cameraQuaternion: toQuaternionArray(camQuat),
            targetPosition: toArray(hitTestPosition)
          });

          requestWorldAnchor(frame, hitTestPosition, "hit-test-anchor");

          return;
        }
      }

      let floorY: number | null = null;
      if (originReferenceSpace) {
        const detectedPlanes: ReadonlySet<PlaneLike> | undefined = frame.detectedPlanes && frame.detectedPlanes.size > 0
          ? frame.detectedPlanes
          : undefined;
        if (detectedPlanes && detectedPlanes.size > 0) {
          for (const plane of detectedPlanes) {
            if (plane.orientation !== "horizontal") {
              continue;
            }

            if (!plane.planeSpace) {
              continue;
            }

            const planePose = frame.getPose(plane.planeSpace, originReferenceSpace);
            if (!planePose) {
              continue;
            }

            floorY = floorY === null
              ? planePose.transform.position.y
              : Math.min(floorY, planePose.transform.position.y);
          }
        }
      }


      if (floorY !== null) {
        const planePlacement = computeFloorPlacement(camPos, camQuat, {
          distanceMeters: resolveForwardDistance(),
          minFloorY: floorY,
          eyeToFloorMeters: Math.max(0.1, camPos.y - floorY),
          verticalOffsetMeters: AR_FLOOR_PLACEMENT_VIEW_LIFT_METERS
        });

        clearActiveAnchor(true);
        clearActiveHitTestSource();
        applyPlacementTransform(planePlacement.position);

        state.stage = "placed";
        state.monitorFrames = 0;
        state.continuousVisibilityFailures = 0;
        emitPlacementStatus(
          {
            stage: "placed",
            mode: planePlacement.mode,
            reason: "plane-detected",
            anchored: false
          },
          { incrementSequence: true }
        );

        logPlacement("applied plane-detected placement", {
          cameraPosition: toArray(camPos),
          cameraQuaternion: toQuaternionArray(camQuat),
          targetPosition: toArray(planePlacement.position),
          floorY
        });

        requestWorldAnchor(frame, planePlacement.position, "plane-detected-anchor");

        return;
      }
    }

    if (state.stage === "unplaced" || state.stage === "searching") {
      state.stablePoseFrames += 1;
      return;
    }

    if (state.stage === "placed") {
      state.monitorFrames += 1;
      const visibilityProbeTarget = visibilityProbePositionRef.current.copy(groupRef.current.position);
      visibilityProbeTarget.y += visibilityProbeHeightMeters;
      const visibility = evaluatePlacementVisibility(camPos, camForward, visibilityProbeTarget);
      if (visibility.visible) {
        state.continuousVisibilityFailures = 0;
        if (state.monitorFrames >= AR_VISIBILITY_MONITOR_FRAMES) {
          state.stage = "locked";
          emitPlacementStatus({ stage: "locked" });
        }
        return;
      }

      state.continuousVisibilityFailures += 1;
      const shouldFallback = placementStatusRef.current.mode !== "visibility-fallback"
        && state.monitorFrames <= AR_VISIBILITY_MONITOR_FRAMES
        && state.continuousVisibilityFailures >= AR_FALLBACK_TRIGGER_FAILURE_FRAMES;

      if (shouldFallback) {
        const distanceMeters = Math.max(0.95, resolveForwardDistance() * 0.85);
        const fallbackPlacement = computeVisibilityFallbackPlacement(camPos, camQuat, {
          distanceMeters,
          verticalOffsetMeters: AR_FALLBACK_PLACEMENT_VERTICAL_OFFSET_METERS
        });
        applyPlacementTransform(fallbackPlacement.position);
        state.monitorFrames = 0;
        state.continuousVisibilityFailures = 0;
        emitPlacementStatus(
          {
            stage: "placed",
            mode: fallbackPlacement.mode,
            reason: visibility.reason,
            anchored: false
          },
          { incrementSequence: true }
        );

        logPlacement("switched to visibility fallback", {
          mode: fallbackPlacement.mode,
          reason: visibility.reason,
          cameraPosition: toArray(camPos),
          cameraQuaternion: toQuaternionArray(camQuat),
          targetPosition: toArray(fallbackPlacement.position)
        });
        return;
      }

      if (state.monitorFrames >= AR_VISIBILITY_MONITOR_FRAMES) {
        state.stage = "locked";
        emitPlacementStatus({ stage: "locked" });
      }
    }
  });

  useEffect(() => {
    const allActions = Object.values(actions).filter(Boolean) as AnimationAction[];
    if (allActions.length === 0) {
      return;
    }

    const rankedActions = allActions
      .slice()
      .sort((a, b) => {
        const aName = a.getClip().name.toLowerCase();
        const bName = b.getClip().name.toLowerCase();
        const motionTerms = ["body", "move", "walk", "run", "idle", "anim", "record"];
        const aHasMotionName = motionTerms.some((term) => aName.includes(term)) ? 1 : 0;
        const bHasMotionName = motionTerms.some((term) => bName.includes(term)) ? 1 : 0;
        if (bHasMotionName !== aHasMotionName) {
          return bHasMotionName - aHasMotionName;
        }

        const aTracks = a.getClip().tracks.length;
        const bTracks = b.getClip().tracks.length;
        if (bTracks !== aTracks) {
          return bTracks - aTracks;
        }

        return b.getClip().duration - a.getClip().duration;
      });

    const primaryAction = rankedActions[0];
    if (!primaryAction) {
      return;
    }

    primaryActionRef.current = primaryAction;
    primaryAction.reset();
    primaryAction.enabled = true;
    primaryAction.setLoop(LoopRepeat, Infinity);
    primaryAction.clampWhenFinished = false;
    primaryAction.setEffectiveWeight(1);
    primaryAction.setEffectiveTimeScale(HOLOGRAM_ANIMATION_SPEED);
    primaryAction.play();

    rankedActions.slice(1).forEach((action) => {
      action.reset();
      action.enabled = true;
      action.setLoop(LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.setEffectiveWeight(0.35);
      action.setEffectiveTimeScale(HOLOGRAM_ANIMATION_SPEED);
      action.play();
    });

    return () => {
      primaryActionRef.current = null;
      rankedActions.forEach((action) => action.stop());
    };
  }, [actions]);

  useEffect(() => {
    return () => {
      clearActiveAnchor(true);
    };
  }, [clearActiveAnchor]);

  return (
    <>
      <ARDepthOcclusion enabled={enableDepthOcclusion} />
      <group ref={groupRef} scale={[modelScale, modelScale, modelScale]}>
        <primitive object={clonedScene} />
        <ARBubbleAura bubble={sphereClip} />
      </group>
      <group ref={footRef} name="ar-hologram-foot">
        {children?.({ frontMeters: footFrontMeters })}
      </group>
      {bubbleChrome?.(sphereClip)}
    </>
  );
}
