import { useAnimations, useGLTF } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  ACESFilmicToneMapping,
  Box3,
  LoopRepeat,
  MathUtils,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3
} from "three";
import type { AnimationAction, Material, Mesh, Object3D } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { useSphereClipping } from "../hologram/useSphereClipping";
import type { SphereClipResult } from "../hologram/useSphereClipping";
import { useGltfAudio } from "../hologram/useGltfAudio";
import { getTopLevelAncestor, isFiniteVector3, prepareAnimatedScene } from "../hologram/object3dUtils";
import { DEFAULT_CAMERA_FRAMING_CONFIG, computeDesiredFraming } from "./cameraFraming";
import { HologramLighting } from "./HologramLighting";

type HologramCardCanvasProps = {
  modelUrl: string;
  active: boolean;
  muted: boolean;
  onHasAudio: (hasAudio: boolean) => void;
  colorAccurateMode: boolean;
};

const HOLOGRAM_ANIMATION_SPEED = 1;
const CARD_CAMERA_DISTANCE_SCALE = 1.36;
const CARD_CAMERA_POSITION_OFFSET = new Vector3(0.62, 0.36, 0.18);
const CARD_CAMERA_LOOK_AT_OFFSET = new Vector3(0, -0.14, 0);
const BUBBLE_CAMERA_POSITION_OFFSET = new Vector3(0, 0, 0);
const BUBBLE_CAMERA_LOOK_AT_OFFSET = new Vector3(0, 0, 0);

function disposeScene(root: Object3D): void {
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }

    const material = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

function getFramingTargets(root: Object3D): Object3D[] {
  const targets = new Set<Object3D>();

  root.traverse((child) => {
    const candidate = child as Mesh & { isSkinnedMesh?: boolean };
    if (candidate.isSkinnedMesh && candidate.geometry) {
      targets.add(getTopLevelAncestor(child, root));
    }
  });

  return targets.size > 0 ? [...targets] : [root];
}

function setBoundsFromTargets(bounds: Box3, targets: Object3D[], scratch: Box3): Box3 {
  bounds.makeEmpty();
  targets.forEach((target) => {
    scratch.setFromObject(target);
    if (!scratch.isEmpty()) {
      bounds.union(scratch);
    }
  });

  return bounds;
}

function findObjectByName(root: Object3D, candidates: string[]): Object3D | null {
  const wanted = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  let match: Object3D | null = null;

  root.traverse((child) => {
    if (match || !child.name) {
      return;
    }

    if (wanted.has(child.name.toLowerCase())) {
      match = child;
    }
  });

  return match;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function applyCameraFraming(
  camera: PerspectiveCamera,
  focus: Vector3,
  distance: number,
  positionOffset = new Vector3(),
  lookAtOffset = new Vector3()
): void {
  camera.position.set(focus.x + positionOffset.x, focus.y + positionOffset.y, focus.z + distance + positionOffset.z);
  camera.lookAt(focus.x + lookAtOffset.x, focus.y + lookAtOffset.y, focus.z + lookAtOffset.z);
  camera.near = Math.max(distance / 500, DEFAULT_CAMERA_FRAMING_CONFIG.minNear);
  camera.far = Math.max(distance * 20, 100);
  camera.updateProjectionMatrix();
}

function HologramModel({ url, active, muted, onHasAudio }: { url: string; active: boolean; muted: boolean; onHasAudio: (hasAudio: boolean) => void }) {
  const gltf = useGLTF(url);
  const { scene, animations } = gltf;
  const audioState = useGltfAudio(gltf, active, muted);

  useEffect(() => {
    onHasAudio(audioState.hasAudio);
  }, [audioState.hasAudio, onHasAudio]);
  const { camera, invalidate } = useThree();
  const clonedScene = useMemo(() => cloneSkeleton(scene), [scene]);
  const sphereClip = useSphereClipping(clonedScene, { falloffWidth: 1.8 });
  const animatedBoundsRef = useRef(new Box3());
  const fullSceneBoundsRef = useRef(new Box3());
  const scratchBoundsRef = useRef(new Box3());
  const framingTargetsRef = useRef<Object3D[]>([]);
  const avatarRootRef = useRef<Object3D | null>(null);
  const avatarAnchorRef = useRef<{ hips: Object3D; head: Object3D | null } | null>(null);
  const { actions } = useAnimations(animations, clonedScene);

  const computePreferredFraming = useCallback((perspectiveCamera: PerspectiveCamera, bubble: SphereClipResult): {
    focus: Vector3;
    distance: number;
    near: number;
    far: number;
    positionOffset?: Vector3;
    lookAtOffset?: Vector3;
  } | null => {
    clonedScene.updateWorldMatrix(true, true);

    const avatarAnchors = avatarAnchorRef.current;
    if (avatarAnchors?.hips) {
      const hipsWorld = avatarAnchors.hips.getWorldPosition(new Vector3());
      const headWorld = avatarAnchors.head
        ? avatarAnchors.head.getWorldPosition(new Vector3())
        : hipsWorld.clone().add(new Vector3(0, 1.55, 0));

      if (isFiniteVector3(hipsWorld) && isFiniteVector3(headWorld)) {
        const focus = hipsWorld.clone().lerp(headWorld, 0.5);
        const avatarHeight = Math.max(headWorld.distanceTo(hipsWorld) * 2.2, 1.45);
        const verticalFovRadians = MathUtils.degToRad(Math.max(perspectiveCamera.fov, 1));
        const distanceForHeight = (avatarHeight * 0.62) / Math.tan(verticalFovRadians / 2);
        const distance = MathUtils.clamp(distanceForHeight * CARD_CAMERA_DISTANCE_SCALE, 2.8, 12);

        if (bubble.active && bubble.radius > 0) {
          const bubbleDistance = distance * 1.8;
          return {
            focus,
            distance: bubbleDistance,
            near: Math.max(bubbleDistance - bubble.radius - 1, DEFAULT_CAMERA_FRAMING_CONFIG.minNear),
            far: bubbleDistance + bubble.radius + 10,
            positionOffset: new Vector3(0, avatarHeight * 2.0, 0),
            lookAtOffset: new Vector3(0, -avatarHeight * 0.3, 0)
          };
        }

        return {
          focus,
          distance,
          near: Math.max(distance / 500, DEFAULT_CAMERA_FRAMING_CONFIG.minNear),
          far: Math.max(distance * 20, 100)
        };
      }
    }

    const avatarRoot = avatarRootRef.current;
    if (avatarRoot) {
      const avatarRootWorld = avatarRoot.getWorldPosition(new Vector3());
      if (isFiniteVector3(avatarRootWorld)) {
        const focus = avatarRootWorld.clone().add(new Vector3(0, 0.95, 0));
        const distance = 4.8;
        return {
          focus,
          distance,
          near: Math.max(distance / 500, DEFAULT_CAMERA_FRAMING_CONFIG.minNear),
          far: Math.max(distance * 20, 100)
        };
      }
    }

    const targetBounds = setBoundsFromTargets(animatedBoundsRef.current, framingTargetsRef.current, scratchBoundsRef.current);
    if (!targetBounds.isEmpty()) {
      const target = computeDesiredFraming(targetBounds, perspectiveCamera, DEFAULT_CAMERA_FRAMING_CONFIG);
      const distance = MathUtils.clamp(target.distance * CARD_CAMERA_DISTANCE_SCALE, 1.4, 14);
      return {
        focus: target.focus,
        distance,
        near: Math.max(distance / 500, DEFAULT_CAMERA_FRAMING_CONFIG.minNear),
        far: Math.max(distance * 20, 100)
      };
    }

    const fullBounds = fullSceneBoundsRef.current.setFromObject(clonedScene);
    if (!fullBounds.isEmpty()) {
      const full = computeDesiredFraming(fullBounds, perspectiveCamera, DEFAULT_CAMERA_FRAMING_CONFIG);
      const distance = MathUtils.clamp(full.distance * CARD_CAMERA_DISTANCE_SCALE, 1.4, 16);
      return {
        focus: full.focus,
        distance,
        near: Math.max(distance / 500, DEFAULT_CAMERA_FRAMING_CONFIG.minNear),
        far: Math.max(distance * 20, 100)
      };
    }

    return null;
  }, [clonedScene]);

  useLayoutEffect(() => {
    prepareAnimatedScene(clonedScene);
    framingTargetsRef.current = getFramingTargets(clonedScene);
    const hips = findObjectByName(clonedScene, ["Hips", "mixamorigHips"]);
    const head = findObjectByName(clonedScene, ["Head", "mixamorigHead"]);
    const avatarRootByName = findObjectByName(clonedScene, ["RecordedAvatar"]);

    avatarRootRef.current = avatarRootByName ?? (hips ? getTopLevelAncestor(hips, clonedScene) : null);
    if (!avatarRootRef.current && framingTargetsRef.current.length > 0) {
      avatarRootRef.current = framingTargetsRef.current[0] ?? null;
    }

    avatarAnchorRef.current = hips
      ? { hips, head }
      : null;

    if (camera instanceof PerspectiveCamera) {
      const preferred = computePreferredFraming(camera, sphereClip);
      if (!preferred) {
        return;
      }

      camera.near = preferred.near;
      camera.far = preferred.far;
      applyCameraFraming(
        camera,
        preferred.focus,
        preferred.distance,
        sphereClip.active ? BUBBLE_CAMERA_POSITION_OFFSET : CARD_CAMERA_POSITION_OFFSET,
        sphereClip.active ? BUBBLE_CAMERA_LOOK_AT_OFFSET : CARD_CAMERA_LOOK_AT_OFFSET
      );
      invalidate();
    }
  }, [camera, clonedScene, computePreferredFraming, invalidate, sphereClip]);

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
    const animSpeed = HOLOGRAM_ANIMATION_SPEED;
    primaryAction.setEffectiveWeight(1);
    primaryAction.setEffectiveTimeScale(animSpeed);
    primaryAction.play();
    primaryAction.paused = !active;

    rankedActions.slice(1).forEach((action) => {
      action.reset();
      action.enabled = true;
      action.setLoop(LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.setEffectiveWeight(0.35);
      action.setEffectiveTimeScale(animSpeed);
      action.play();
      action.paused = !active;
    });

    if (camera instanceof PerspectiveCamera) {
      const preferred = computePreferredFraming(camera, sphereClip);
      if (preferred && isFiniteVector3(preferred.focus) && isFinitePositive(preferred.distance)) {
        camera.near = preferred.near;
        camera.far = preferred.far;
        applyCameraFraming(
          camera,
          preferred.focus,
          preferred.distance,
          CARD_CAMERA_POSITION_OFFSET,
          CARD_CAMERA_LOOK_AT_OFFSET
        );
        invalidate();
      }
    }

    return () => {
      rankedActions.forEach((action) => action.stop());
    };
  }, [actions, active, audioState.hasAudio, camera, computePreferredFraming, invalidate, sphereClip]);

  useFrame(() => {
    if (!(camera instanceof PerspectiveCamera)) {
      return;
    }

    const preferred = computePreferredFraming(camera, sphereClip);
    if (!preferred) {
      return;
    }

    if (!isFiniteVector3(preferred.focus) || !isFinitePositive(preferred.distance)) {
      return;
    }
    camera.near = preferred.near;
    camera.far = preferred.far;
    applyCameraFraming(
      camera,
      preferred.focus,
      preferred.distance,
      sphereClip.active ? BUBBLE_CAMERA_POSITION_OFFSET : CARD_CAMERA_POSITION_OFFSET,
      sphereClip.active ? BUBBLE_CAMERA_LOOK_AT_OFFSET : CARD_CAMERA_LOOK_AT_OFFSET
    );
  });

  useEffect(() => {
    return () => {
      disposeScene(clonedScene);
    };
  }, [clonedScene]);

  return <primitive object={clonedScene} />;
}

export function HologramCardCanvas({
  modelUrl,
  active,
  muted,
  onHasAudio,
  colorAccurateMode
}: HologramCardCanvasProps) {
  return (
    <Canvas
      camera={{ position: [0, 1.2, 2.8], fov: 38 }}
      dpr={[1, 1.5]}
      frameloop={active ? "always" : "demand"}
      gl={{
        alpha: true,
        outputColorSpace: SRGBColorSpace,
        toneMapping: ACESFilmicToneMapping,
        toneMappingExposure: colorAccurateMode ? 0.82 : 1.1
      }}
    >
      <HologramLighting colorAccurate={colorAccurateMode} />
      <HologramModel url={modelUrl} active={active} muted={muted} onHasAudio={onHasAudio} />
    </Canvas>
  );
}
