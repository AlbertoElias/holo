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
import type { AnimationAction, Mesh, Object3D } from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { useSphereClipping } from "../hologram/useSphereClipping";
import type { SphereClipResult } from "../hologram/useSphereClipping";
import { useGltfAudio } from "../hologram/useGltfAudio";
import { PointingHighlights } from "../meaning/PointingHighlights";
import type { PointingProbe } from "../meaning/PointingHighlights";
import { readMeaningLinks } from "../meaning/meaningLinks";
import type { MeaningGltf } from "../meaning/meaningLinks";
import { readRecordedObjects } from "../objects/recordedObjects";
import { getTopLevelAncestor, isFiniteVector3, prepareAnimatedScene } from "../hologram/object3dUtils";
import { INSIDE_DISTANCE, anglesFromPose, freeCameraPose } from "../portal/portalStore";
import type { PortalStore } from "../portal/portalStore";
import { usePortalValue } from "../portal/usePortalValue";
import { DEFAULT_CAMERA_FRAMING_CONFIG, computeDesiredFraming } from "./cameraFraming";
import { HologramLighting } from "./HologramLighting";

export type HologramRenderInfo = {
  animationCount: number;
  bubbleActive: boolean;
};

type HologramCardCanvasProps = {
  modelUrl: string;
  active: boolean;
  muted: boolean;
  onHasAudio: (hasAudio: boolean) => void;
  onRendered?: ((info: HologramRenderInfo) => void) | undefined;
  colorAccurateMode: boolean;
  portal: PortalStore;
};

const HOLOGRAM_ANIMATION_SPEED = 1;
const SPHERE_CLIP_FALLOFF = 1.8;
const CARD_CAMERA_DISTANCE_SCALE = 1.36;
const CARD_CAMERA_POSITION_OFFSET = new Vector3(0.62, 0.36, 0.18);
const CARD_CAMERA_LOOK_AT_OFFSET = new Vector3(0, -0.14, 0);
const BUBBLE_CAMERA_POSITION_OFFSET = new Vector3(0, 0, 0);
const BUBBLE_CAMERA_LOOK_AT_OFFSET = new Vector3(0, 0, 0);
/** Seconds Return takes to glide from the Free view back to Follow. */
const RETURN_SECONDS = 0.45;
/** Inside end never comes closer than this share of the Follow distance. */
const MAX_INSIDE_SHARE = 0.6;

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

function followPose(
  preferred: { focus: Vector3; distance: number },
  positionOffset: Vector3,
  lookAtOffset: Vector3,
  outPosition: Vector3,
  outTarget: Vector3
): void {
  outPosition.copy(preferred.focus).add(positionOffset);
  outPosition.z += preferred.distance;
  outTarget.copy(preferred.focus).add(lookAtOffset);
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function HologramModel({ url, active, muted, onHasAudio, onRendered, portal }: {
  url: string;
  active: boolean;
  muted: boolean;
  onHasAudio: (hasAudio: boolean) => void;
  onRendered?: ((info: HologramRenderInfo) => void) | undefined;
  portal: PortalStore;
}) {
  const gltf = useGLTF(url);
  const { scene, animations } = gltf;
  const paused = usePortalValue(portal, (state) => state.paused);
  const primaryActionRef = useRef<AnimationAction | null>(null);
  const getPlaybackTime = useCallback(() => primaryActionRef.current?.time ?? 0, []);
  const audioState = useGltfAudio(gltf, active && !paused, muted, getPlaybackTime);
  const poseRef = useRef({
    followPosition: new Vector3(),
    followTarget: new Vector3(),
    headTarget: new Vector3(),
    position: new Vector3(),
    target: new Vector3(),
    lastPosition: new Vector3(),
    lastTarget: new Vector3(),
    hasLast: false
  });
  // Field of view and canvas height while the bubble is closed. Opening the
  // bubble widens the canvas; the view widens with it instead of magnifying.
  const baseFovRef = useRef<number | null>(null);
  const baseHeightRef = useRef(0);

  useEffect(() => {
    onHasAudio(audioState.hasAudio);
  }, [audioState.hasAudio, onHasAudio]);
  const { camera, invalidate, gl: renderer, scene: renderScene } = useThree();
  const clonedScene = useMemo(() => cloneSkeleton(scene), [scene]);
  const sphereClip = useSphereClipping(clonedScene, { falloffWidth: SPHERE_CLIP_FALLOFF });
  const meaningLinks = useMemo(() => readMeaningLinks(gltf as unknown as MeaningGltf, clonedScene), [gltf, clonedScene]);
  const recordedObjects = useMemo(() => readRecordedObjects(gltf as unknown as MeaningGltf, clonedScene), [gltf, clonedScene]);
  const pointingProbe = useRef<PointingProbe>({ links: [] }).current;
  useEffect(() => {
    portal.setHasHighlights(meaningLinks.length > 0);
    return () => portal.setHasHighlights(false);
  }, [meaningLinks, portal]);
  const animatedBoundsRef = useRef(new Box3());
  const fullSceneBoundsRef = useRef(new Box3());
  const scratchBoundsRef = useRef(new Box3());
  const framingTargetsRef = useRef<Object3D[]>([]);
  const avatarRootRef = useRef<Object3D | null>(null);
  const avatarAnchorRef = useRef<{ hips: Object3D; head: Object3D | null } | null>(null);
  const { actions, mixer } = useAnimations(animations, clonedScene);

  useEffect(() => {
    if (import.meta.env.DEV) {
      const observer = (window as Window & { __HOLOIM_FEED_TEST_OBSERVER__?: (value: unknown) => void }).__HOLOIM_FEED_TEST_OBSERVER__;
      observer?.({ url, renderer, scene: renderScene, model: clonedScene, camera, bubble: sphereClip, actions, mixer, portal, pointing: pointingProbe, objects: recordedObjects });
    }
  }, [actions, camera, clonedScene, mixer, pointingProbe, portal, recordedObjects, renderScene, renderer, sphereClip, url]);

  // Mounting means the GLTF resolved and its scene is in the canvas.
  useEffect(() => {
    onRendered?.({ animationCount: animations.length, bubbleActive: sphereClip.active });
  }, [animations.length, onRendered, sphereClip.active]);

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
    const avatarRootByName = findObjectByName(clonedScene, ["RecordedAvatar"]);
    // Within the avatar when the export names it, so a recorded object's own
    // bone names (a prop with a "Head") never take over the framing.
    const avatarScope = avatarRootByName ?? clonedScene;
    const hips = findObjectByName(avatarScope, ["Hips", "mixamorigHips"]);
    const head = findObjectByName(avatarScope, ["Head", "mixamorigHead"]);

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
    primaryActionRef.current = primaryAction;

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
      primaryActionRef.current = null;
    };
  }, [actions, active, audioState.hasAudio, camera, computePreferredFraming, invalidate, sphereClip]);

  // Pausing freezes the actions where they are; the setup above resets them
  // only when the card itself becomes active.
  useEffect(() => {
    Object.values(actions).forEach((action) => {
      if (action) action.paused = !active || paused;
    });
  }, [actions, active, paused]);

  useFrame((frameState, delta) => {
    if (!(camera instanceof PerspectiveCamera)) {
      return;
    }

    baseFovRef.current ??= camera.fov;
    const baseFov = baseFovRef.current;
    // Framing is computed for the closed bubble's field of view.
    camera.fov = baseFov;
    const preferred = computePreferredFraming(camera, sphereClip);
    if (!preferred) {
      return;
    }

    if (!isFiniteVector3(preferred.focus) || !isFinitePositive(preferred.distance)) {
      return;
    }

    // Follow is today's automatic framing; Free orbits the same focus.
    const pose = poseRef.current;
    followPose(
      preferred,
      sphereClip.active ? BUBBLE_CAMERA_POSITION_OFFSET : CARD_CAMERA_POSITION_OFFSET,
      sphereClip.active ? BUBBLE_CAMERA_LOOK_AT_OFFSET : CARD_CAMERA_LOOK_AT_OFFSET,
      pose.followPosition,
      pose.followTarget
    );
    const follow = anglesFromPose(pose.followPosition, pose.followTarget);
    const outsideDistance = follow.distance;
    const insideDistance = Math.min(INSIDE_DISTANCE, outsideDistance * MAX_INSIDE_SHARE);
    const runtime = portal.runtime;
    runtime.followYaw = follow.yaw;
    runtime.followPitch = follow.pitch;
    runtime.zoomSpan = Math.log(outsideDistance / insideDistance);

    const state = portal.getState();
    const canvasHeight = frameState.size.height;
    if (state.mode === "follow" && runtime.returnBlend === 0) {
      baseHeightRef.current = canvasHeight;
    }
    const openRatio = baseHeightRef.current > 0 ? Math.max(canvasHeight / baseHeightRef.current, 1) : 1;
    camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(baseFov) / 2) * openRatio));
    if (state.mode === "free") {
      const head = avatarAnchorRef.current?.head;
      if (head) {
        head.getWorldPosition(pose.headTarget);
      } else {
        pose.headTarget.copy(pose.followTarget);
      }
      freeCameraPose(state, pose.followTarget, pose.headTarget, insideDistance, outsideDistance, pose.position, pose.target);
    } else if (runtime.returnBlend > 0 && pose.hasLast) {
      runtime.returnBlend = Math.max(runtime.returnBlend - delta / RETURN_SECONDS, 0);
      const t = easeInOut(1 - runtime.returnBlend);
      pose.position.lerpVectors(pose.lastPosition, pose.followPosition, t);
      pose.target.lerpVectors(pose.lastTarget, pose.followTarget, t);
    } else {
      runtime.returnBlend = 0;
      pose.position.copy(pose.followPosition);
      pose.target.copy(pose.followTarget);
    }
    pose.lastPosition.copy(pose.position);
    pose.lastTarget.copy(pose.target);
    pose.hasLast = true;

    camera.position.copy(pose.position);
    camera.lookAt(pose.target);
    runtime.measured.cameraDistance = pose.position.distanceTo(pose.target);
    runtime.measured.insideDistance = insideDistance;
    runtime.measured.outsideDistance = outsideDistance;
    runtime.measured.target = [pose.target.x, pose.target.y, pose.target.z];
    if (state.mode === "free" || runtime.returnBlend > 0) {
      // Inside the bubble the Follow clip planes would cut the scene away.
      const distance = pose.position.distanceTo(pose.target);
      camera.near = Math.max(distance / 200, DEFAULT_CAMERA_FRAMING_CONFIG.minNear);
      camera.far = Math.max(preferred.far, distance + sphereClip.radius * 2 + 10);
    } else {
      camera.near = preferred.near;
      camera.far = preferred.far;
    }
    camera.updateProjectionMatrix();
  });

  // SkeletonUtils clones share the loader cache's geometry and source materials.
  // useSphereClipping owns/disposes its material clones; leave cached assets alive.

  return (
    <>
      <primitive object={clonedScene} />
      {meaningLinks.length > 0 && (
        <PointingHighlights
          links={meaningLinks}
          portal={portal}
          bubble={sphereClip}
          falloffWidth={SPHERE_CLIP_FALLOFF}
          getPlaybackTime={getPlaybackTime}
          probe={pointingProbe}
        />
      )}
    </>
  );
}

export function HologramCardCanvas({
  modelUrl,
  active,
  muted,
  onHasAudio,
  onRendered,
  colorAccurateMode,
  portal
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
      <HologramModel url={modelUrl} active={active} muted={muted} onHasAudio={onHasAudio} onRendered={onRendered} portal={portal} />
    </Canvas>
  );
}
