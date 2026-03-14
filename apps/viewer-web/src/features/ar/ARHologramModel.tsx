import { useAnimations, useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Box3, LoopRepeat, MathUtils, Quaternion, Vector3 } from "three";
import type { AnimationAction, Group, Object3D } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { prepareAnimatedScene } from "../hologram/object3dUtils";
import { useSphereClipping } from "../hologram/useSphereClipping";
import type { SphereClipStatus } from "../hologram/useSphereClipping";
import { freezeBubbleWrapperMotion } from "./arAnimation";
import { ARBubbleAura } from "./ARBubbleAura";
import {
  computeFloorPlacement,
  computeVisibilityFallbackPlacement,
  evaluatePlacementVisibility
} from "./arPlacement";

const HOLOGRAM_ANIMATION_SPEED = 1;
const AR_MODEL_TARGET_HEIGHT_METERS = 1.85;
const AR_MODEL_MIN_SCALE = 0.12;
const AR_MODEL_MAX_SCALE = 2.5;
const AR_INITIAL_POSITION = new Vector3(0, 0.05, -2);
const AR_LOCAL_REFERENCE_SPACE_MAX_Y_METERS = 0.45;
const AR_INITIAL_FORWARD_DISTANCE_MIN_METERS = 1.8;
const AR_INITIAL_FORWARD_DISTANCE_MAX_METERS = 8;
const AR_INITIAL_FORWARD_DISTANCE_HEIGHT_MULTIPLIER = 0.9;
const AR_INITIAL_FORWARD_DISTANCE_BUBBLE_MARGIN_METERS = 1.1;
const AR_FLOOR_PLACEMENT_VIEW_LIFT_METERS = 0.08;
const AR_FALLBACK_PLACEMENT_VERTICAL_OFFSET_METERS = -0.22;
const AR_VISIBILITY_PROBE_HEIGHT_RATIO = 0.55;
const AR_STABLE_POSE_FRAMES_REQUIRED = 2;
const AR_VISIBILITY_MONITOR_FRAMES = 45;
const AR_FALLBACK_TRIGGER_FAILURE_FRAMES = 12;

type PlacementStage = "unplaced" | "floor-placed" | "fallback-placed" | "locked";

type PlacementRuntimeState = {
  stage: PlacementStage;
  stablePoseFrames: number;
  monitorFrames: number;
  continuousVisibilityFailures: number;
};

type ARHologramModelProps = {
  url: string;
  placementVersion: number;
  onBubbleStatusChange: (status: SphereClipStatus) => void;
};

function createPlacementRuntimeState(): PlacementRuntimeState {
  return {
    stage: "unplaced",
    stablePoseFrames: 0,
    monitorFrames: 0,
    continuousVisibilityFailures: 0
  };
}

function isFiniteCameraPose(position: Vector3, quaternion: Quaternion): boolean {
  return Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(position.z)
    && Number.isFinite(quaternion.x)
    && Number.isFinite(quaternion.y)
    && Number.isFinite(quaternion.z)
    && Number.isFinite(quaternion.w);
}

function toArray(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

function toQuaternionArray(quaternion: Quaternion): [number, number, number, number] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function normalizeSceneAtOrigin(root: Object3D): void {
  const anchor = root.getObjectByName("RecordedAvatar")
    ?? root.getObjectByName("Hips")
    ?? root.getObjectByName("mixamorigHips")
    ?? root;

  const anchorPos = anchor.getWorldPosition(new Vector3());
  if (!Number.isFinite(anchorPos.x) || !Number.isFinite(anchorPos.y) || !Number.isFinite(anchorPos.z)) return;

  root.position.sub(anchorPos);

  const bounds = new Box3().setFromObject(root);
  if (!bounds.isEmpty() && Number.isFinite(bounds.min.y)) {
    root.position.y -= bounds.min.y;
  }
}

export function ARHologramModel({
  url,
  placementVersion,
  onBubbleStatusChange
}: ARHologramModelProps) {
  const { scene, animations } = useGLTF(url);
  const clonedScene = useMemo(() => {
    const cloned = cloneSkeleton(scene);
    prepareAnimatedScene(cloned);
    normalizeSceneAtOrigin(cloned);
    return cloned;
  }, [scene]);
  const modelScale = useMemo(() => {
    const bounds = new Box3().setFromObject(clonedScene);
    const size = bounds.getSize(new Vector3());
    if (!Number.isFinite(size.y) || size.y <= 1e-4) return 0.4;
    return Math.min(AR_MODEL_MAX_SCALE, Math.max(AR_MODEL_MIN_SCALE, AR_MODEL_TARGET_HEIGHT_METERS / size.y));
  }, [clonedScene]);
  const modelHeightMeters = useMemo(() => {
    const bounds = new Box3().setFromObject(clonedScene);
    const size = bounds.getSize(new Vector3());
    if (!Number.isFinite(size.y) || size.y <= 1e-4) {
      return AR_MODEL_TARGET_HEIGHT_METERS;
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
  const arAnimations = useMemo(() => freezeBubbleWrapperMotion(animations), [animations]);
  const { actions } = useAnimations(arAnimations, clonedScene);
  const groupRef = useRef<Group>(null);
  const placementStateRef = useRef<PlacementRuntimeState>(createPlacementRuntimeState());
  const cameraPositionRef = useRef(new Vector3());
  const cameraQuaternionRef = useRef(new Quaternion());
  const cameraForwardRef = useRef(new Vector3());
  const visibilityProbePositionRef = useRef(new Vector3());

  const resolveForwardDistance = (): number => {
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
  };

  const logPlacement = (message: string, details: Record<string, unknown>): void => {
    if (!import.meta.env.DEV) {
      return;
    }

    console.info("[AR placement]", message, details);
  };

  useEffect(() => {
    placementStateRef.current = createPlacementRuntimeState();
    if (groupRef.current) {
      groupRef.current.position.copy(AR_INITIAL_POSITION);
    }
  }, [placementVersion, url]);

  // Place hologram with a small runtime state machine:
  // unplaced -> floor-placed -> fallback-placed -> locked.
  useFrame(({ camera }) => {
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

    if (state.stage === "unplaced") {
      state.stablePoseFrames += 1;
      if (state.stablePoseFrames < AR_STABLE_POSE_FRAMES_REQUIRED) {
        return;
      }

      const distanceMeters = resolveForwardDistance();
      const shouldUseCameraRelativePlacement = camPos.y <= AR_LOCAL_REFERENCE_SPACE_MAX_Y_METERS;
      const initialPlacement = shouldUseCameraRelativePlacement
        ? computeVisibilityFallbackPlacement(camPos, camQuat, {
          distanceMeters,
          verticalOffsetMeters: AR_FALLBACK_PLACEMENT_VERTICAL_OFFSET_METERS
        })
        : computeFloorPlacement(camPos, camQuat, {
          distanceMeters,
          verticalOffsetMeters: AR_FLOOR_PLACEMENT_VIEW_LIFT_METERS
        });
      groupRef.current.position.copy(initialPlacement.position);
      state.stage = "floor-placed";
      state.monitorFrames = 0;
      state.continuousVisibilityFailures = 0;

      logPlacement("applied placement", {
        mode: initialPlacement.mode,
        reason: initialPlacement.reason,
        cameraRelative: shouldUseCameraRelativePlacement,
        cameraPosition: toArray(camPos),
        cameraQuaternion: toQuaternionArray(camQuat),
        targetPosition: toArray(initialPlacement.position)
      });
      return;
    }

    if (state.stage === "floor-placed") {
      state.monitorFrames += 1;
      const visibilityProbeTarget = visibilityProbePositionRef.current.copy(groupRef.current.position);
      visibilityProbeTarget.y += visibilityProbeHeightMeters;
      const visibility = evaluatePlacementVisibility(camPos, camForward, visibilityProbeTarget);
      if (visibility.visible) {
        state.continuousVisibilityFailures = 0;
        if (state.monitorFrames >= AR_VISIBILITY_MONITOR_FRAMES) {
          state.stage = "locked";
        }
        return;
      }

      state.continuousVisibilityFailures += 1;
      const shouldFallback = state.monitorFrames <= AR_VISIBILITY_MONITOR_FRAMES
        && state.continuousVisibilityFailures >= AR_FALLBACK_TRIGGER_FAILURE_FRAMES;

      if (shouldFallback) {
        const distanceMeters = Math.max(0.95, resolveForwardDistance() * 0.85);
        const fallbackPlacement = computeVisibilityFallbackPlacement(camPos, camQuat, {
          distanceMeters,
          verticalOffsetMeters: AR_FALLBACK_PLACEMENT_VERTICAL_OFFSET_METERS
        });
        groupRef.current.position.copy(fallbackPlacement.position);
        state.stage = "fallback-placed";
        state.monitorFrames = 0;
        state.continuousVisibilityFailures = 0;

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
      }
      return;
    }

    if (state.stage === "fallback-placed") {
      state.monitorFrames += 1;
      if (state.monitorFrames >= AR_VISIBILITY_MONITOR_FRAMES) {
        state.stage = "locked";
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

    primaryAction.reset();
    primaryAction.enabled = true;
    primaryAction.setLoop(LoopRepeat, Infinity);
    primaryAction.clampWhenFinished = false;
    primaryAction.setEffectiveWeight(1);
    primaryAction.setEffectiveTimeScale(HOLOGRAM_ANIMATION_SPEED);
    primaryAction.play();

    // Keep extra clips running with lower weight.
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
      rankedActions.forEach((action) => action.stop());
    };
  }, [actions]);

  return (
    <group ref={groupRef} scale={[modelScale, modelScale, modelScale]}>
      <primitive object={clonedScene} />
      <ARBubbleAura bubble={sphereClip} />
    </group>
  );
}
