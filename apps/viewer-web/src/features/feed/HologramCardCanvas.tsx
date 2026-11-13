import { useGLTF } from "@react-three/drei";
import { withKtx2 } from "../hologram/ktx2";
import { useTextureDetail } from "../hologram/textureDetail";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ACESFilmicToneMapping,
  Box3,
  LoopRepeat,
  MathUtils,
  PerspectiveCamera,
  Raycaster,
  SRGBColorSpace,
  Vector2,
  Vector3
} from "three";
import type { AnimationAction, Group, Mesh, Object3D, PointLight, SkinnedMesh } from "three";
import { tokens } from "@holoim/design-tokens";
import type { ObjectCredit } from "@holoim/objects";
import { clocheFollowDirection, clocheFraming, clocheInside, fitCloche, stageLight, type ClocheFraming, type ClocheShape, type SootInput, type ViewTarget } from "@holoim/xr-ui-core";
import { Cloche } from "@holoim/xr-ui-r3f";
import { ClocheRimTexture } from "@holoim/xr-ui-three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { useSphereClipping } from "../hologram/useSphereClipping";
import type { DomeClip, SphereClipResult } from "../hologram/useSphereClipping";
import { useTakeAnimations } from "../hologram/useTakeAnimations";
import { buildGroundField, cachedGroundField, groundFieldBudget, readRimTake, RimMotion, takeSamples, type RimTake } from "../hologram/groundField";
import { useGltfAudio } from "../hologram/useGltfAudio";
import { createEarPose, earFromObject, type ScheduledGltfAudio, type SoundLayers } from "../hologram/gltfAudio";
import { portalEar } from "../hologram/portalEar";
import { drawnBounds, drawnPoints, motionPoints } from "../hologram/drawnPoints";
import { isCameraTake } from "../hologram/hologramScene";
import { type HumanoidGltf, resolveHumanoidAnchors } from "../hologram/humanoidAnchors";
import { compareTakeClips, TAKE_CLIP_WEIGHT } from "../hologram/takePlayback";
import { createHandTracesProbe, HandTraces, useHandTraceSource } from "../meaning/HandTraces";
import { PointingHighlights } from "../meaning/PointingHighlights";
import type { PointingProbe } from "../meaning/PointingHighlights";
import { readMeaningLinks } from "../meaning/meaningLinks";
import type { MeaningGltf } from "../meaning/meaningLinks";
import { AuthorCameraMark, createPresenceProbe } from "../presence/AuthorCameraMark";
import { identityOf } from "../presence/identityHue";
import { isInsideRecordedObject, readObjectCredits, readRecordedObjects } from "../objects/recordedObjects";
import { getTopLevelAncestor, isFiniteVector3, prepareAnimatedScene } from "../hologram/object3dUtils";
import { INSIDE_DISTANCE, RETURN_SECONDS_PER_NEPER, anglesFromPose, freeCameraPose, returnPose } from "../portal/portalStore";
import { layerIndexOf, outermostDrawn, readDeepZoom, soundLayers as layeredSound } from "../portal/deepZoom";
import type { PortalStore } from "../portal/portalStore";
import { usePortalValue } from "../portal/usePortalValue";
import { DEFAULT_CAMERA_FRAMING_CONFIG, computeDesiredFraming } from "./cameraFraming";
import { HologramLighting } from "./HologramLighting";
import { createPlaceGate, PLACE_FIT_WAIT_MS, warnPlaceOnce } from "../place/placeGate";
import type { PlaceRequest } from "../place/placeRequest";
import { findStoredPlace } from "../place/storedPlace";
import { testHooks } from "../../testHooks";

// A scanned place around the take (docs/features/archive/splat-place.md): Spark and
// everything that touches it load by this one dynamic import, which only the
// dev and e2e builds keep.
const PlaceMount = testHooks ? lazy(() => import("../place/PlaceMount")) : null;
// A take's own stored place (docs/features/splat-capture.md) ships in production, in a chunk loaded only for a take that has one.
const StoredPlaceMount = lazy(() => import("../place/StoredPlaceMount"));

export type HologramRenderInfo = {
  animationCount: number;
  bubbleActive: boolean;
};

type HologramCardCanvasProps = {
  modelUrl: string;
  /** The place's detail SPZ and the full-size textures (hologram-budgets), for the focused card. */
  placeDetailUrl?: string | null;
  textureDetailUrl?: string | null;
  active: boolean;
  muted: boolean;
  onHasAudio: (hasAudio: boolean) => void;
  onCredits: (credits: ObjectCredit[]) => void;
  onRendered?: ((info: HologramRenderInfo) => void) | undefined;
  colorAccurateMode: boolean;
  portal: PortalStore;
  /** The screen the card is on: sets the stage light's flicker (8.1). */
  target: ViewTarget;
  reducedMotion: boolean;
  /** The hologram's id (Q10): its cloche's burns. */
  seed: string;
  /**
   * The card's viewing box inside the canvas, in CSS px. The canvas covers the
   * whole card, so nothing is ever cut square; Follow frames the cloche in
   * this box.
   */
  frameRect?: FrameRect | null | undefined;
  /** What the cloche's char reads (3.2, 3.4): the ground behind its foot. */
  soot: SootInput;
  /** Who made the take: a camera take's mark is in their identity hue, with their initial (2.4). */
  author: string;
  /** A scanned place to show around the take (dev and e2e builds only; see `?place=`). */
  placeRequest?: PlaceRequest | null | undefined;
};

export type FrameRect = { left: number; top: number; width: number; height: number };

const HOLOGRAM_ANIMATION_SPEED = 1;
const SPHERE_CLIP_FALLOFF = 1.8;
/** Points sampled along a touch ray across the cloche, enough to find a dome a few hundredths of its size thick. */
const GLASS_RAY_SAMPLES = 48;
const CARD_CAMERA_DISTANCE_SCALE = 1.36;
const CARD_CAMERA_POSITION_OFFSET = new Vector3(0.62, 0.36, 0.18);
const CARD_CAMERA_LOOK_AT_OFFSET = new Vector3(0, -0.14, 0);
const BUBBLE_CAMERA_POSITION_OFFSET = new Vector3(0, 0, 0);
const BUBBLE_CAMERA_LOOK_AT_OFFSET = new Vector3(0, 0, 0);
/** Inside the layers the near plane is the camera's distance over this, and the far plane its distance times the next. */
const DEEP_NEAR_SHARE = 100;
const DEEP_FAR_REACH = 400;
/** Seconds Return takes to glide from the Free view back to Follow. */
const RETURN_SECONDS = 0.45;
/** The stage light sits this share of the way from the author toward the Follow camera, */
const STAGE_LIGHT_TOWARD_VIEWER = 0.35;
/** and this far below the Follow target, near the floor at the author's feet. */
const STAGE_LIGHT_DROP_METERS = 0.7;
/** Follow looks at the cloche from a little right of front and above (3.4). */
const FOLLOW_DIRECTION = new Vector3().copy(clocheFollowDirection());
/** Inside end never comes closer than this share of the Follow distance. */
const MAX_INSIDE_SHARE = 0.6;
const RIM = tokens.edge.cloche.rim;
/** The node a hologram that zooms into itself names its zoom by (see the agent-authored holograms concept page). */
const HOLOGRAM_ZOOM_NODE = "HologramZoom";

/** What the feed's rim (3.4) did, for the e2e checks: ready once its ground field is read. */
export type RimProbe = {
  /** The rim may run: the sphere clip is active, a performer (not a camera) recorded it, with a recorded scene. */
  gated: boolean;
  rimReady: boolean;
  /** The take's rim lifts somewhere on its path: no shade, and the bent dome clips the scene. */
  lifts: boolean;
  maxLift: number;
  buildMs: number | null;
  candidates: number;
  /** The heights the cloche and the clip read this frame, and the target they ease toward. */
  heights: Float32Array | null;
  target: Float32Array | null;
  /** The ground's lift per bin before smoothing. */
  raw: Float32Array | null;
  framing: Float32Array | null;
  timing: { lastMs: number; meanMs: number; maxMs: number; frames: number; recent: Float32Array } | null;
  /** The ground's height at a world point, NaN where there is none (the field, for diagnostics only). */
  groundAt: ((x: number, z: number) => number) | null;
  /** Whether a world point is under the bent glass this frame, null while the sphere clips (the clip's CPU twin, for diagnostics only). */
  insideDome: ((point: Vector3) => boolean | null) | null;
};

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

/**
 * Runs `run` every frame ahead of the siblings mounted after it: R3F calls
 * frame callbacks in subscription order, and children subscribe before
 * their parent.
 */
function FrameFirst({ run }: { run: (delta: number) => void }) {
  useFrame((_, delta) => run(delta));
  return null;
}

function HologramModel({ url, placeDetailUrl, textureDetailUrl, active, muted, onHasAudio, onCredits, onRendered, portal, target, reducedMotion, seed, frameRect, soot, author, placeRequest }: {
  url: string;
  placeDetailUrl: string | null;
  textureDetailUrl: string | null;
  placeRequest: PlaceRequest | null;
  author: string;
  seed: string;
  frameRect?: FrameRect | null | undefined;
  soot: SootInput;
  target: ViewTarget;
  reducedMotion: boolean;
  active: boolean;
  muted: boolean;
  onHasAudio: (hasAudio: boolean) => void;
  onCredits: (credits: ObjectCredit[]) => void;
  onRendered?: ((info: HologramRenderInfo) => void) | undefined;
  portal: PortalStore;
}) {
  const gltf = useGLTF(url, true, true, withKtx2);
  const { scene, animations } = gltf;
  // The take's own place, read from the GLB's JSON (Spark-free); a malformed one leaves the take on its floor disc.
  const storedPlace = useMemo(() => {
    const found = findStoredPlace(gltf.parser.json);
    if (found.error) console.warn(`The hologram's stored place is malformed; it plays on its floor: ${found.error}`);
    return found.place;
  }, [gltf]);
  const storedPlaceShows = useRef(false);
  const paused = usePortalValue(portal, (state) => state.paused);
  const primaryActionRef = useRef<AnimationAction | null>(null);
  const getPlaybackTime = useCallback(() => primaryActionRef.current?.time ?? 0, []);
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
  // The portal's own stage light (8.1): warm light from the hologram's foot.
  const stageLightRef = useRef<PointLight>(null);
  const clocheGroupRef = useRef<Group>(null);

  const { camera, invalidate, gl: renderer, scene: renderScene } = useThree();
  const clonedScene = useMemo(() => cloneSkeleton(scene), [scene]);
  // Deep zoom (docs/features/deep-zoom.md): the layers the hologram declares
  // nested inside it, read once; null for one that declares none, which then
  // zooms exactly as before.
  const deep = useMemo(() => readDeepZoom(clonedScene, gltf.animations), [clonedScene, gltf.animations]);
  // How deep the camera is this frame (0 outside the layers), for the sound and the hit test.
  const depthNow = useRef(0);
  const soundLayers = useMemo<SoundLayers | null>(() => (deep ? layeredSound(deep, () => depthNow.current) : null), [deep]);
  // Each layer's own meshes, so the outer ones can be left undrawn deep in;
  // and the outermost layer drawn last frame (0 = all).
  const layerMeshes = useMemo(() => {
    if (!deep) return null;
    const meshes: Object3D[][] = deep.layers.map(() => []);
    meshes.push([]);
    clonedScene.traverse((object) => {
      if ((object as { isMesh?: boolean }).isMesh) meshes[layerIndexOf(deep, object)]!.push(object);
    });
    return meshes;
  }, [clonedScene, deep]);
  const drawnFrom = useRef(0);
  // The meshes deep zoom hid itself: only those come back on the way out, so one hidden for another reason (the recorded bubble's old glass) stays hidden.
  const deepHidden = useRef(new Set<Object3D>()).current;
  const audioState = useGltfAudio(gltf, clonedScene, active && !paused, muted, getPlaybackTime);
  // The card's sound for the probe: decoded after mount, so read through a ref.
  const soundRef = useRef<ScheduledGltfAudio | null>(null);
  soundRef.current = audioState.audio;
  const earRef = useRef({ camera: createEarPose(), ear: createEarPose() });
  useEffect(() => {
    onHasAudio(audioState.hasAudio);
  }, [audioState.hasAudio, onHasAudio]);
  // The feed clips a take whose rim lifts by the bent dome (3.4); its uniforms are set once the cloche is fitted.
  const domeRim = useMemo(() => new ClocheRimTexture(), []);
  useEffect(() => () => domeRim.dispose(), [domeRim]);
  const domeClip = useMemo<DomeClip>(() => ({
    u_domeOn: { value: 0 },
    u_domeBase: { value: new Vector3() },
    u_domeRadii: { value: new Vector3(1, 1, 1) },
    u_domeExponent: { value: 2 },
    u_domeRim: { value: domeRim.texture }
  }), [domeRim]);
  const sphereClip = useSphereClipping(clonedScene, { falloffWidth: SPHERE_CLIP_FALLOFF, dome: domeClip });
  const meaningLinks = useMemo(() => readMeaningLinks(gltf as unknown as MeaningGltf, clonedScene), [gltf, clonedScene]);
  const recordedObjects = useMemo(() => readRecordedObjects(gltf as unknown as MeaningGltf, clonedScene), [gltf, clonedScene]);
  const credits = useMemo(() => readObjectCredits(recordedObjects), [recordedObjects]);
  useEffect(() => {
    onCredits(credits);
  }, [credits, onCredits]);
  const pointingProbe = useRef<PointingProbe>({ links: [] }).current;
  const tracesProbe = useRef(createHandTracesProbe()).current;
  // Hand traces read the recorded author's fingertips and hips (PRD-023); a camera take has no author's body.
  const traceAnchors = useMemo(() => (isCameraTake(clonedScene) ? null : resolveHumanoidAnchors(clonedScene, gltf as unknown as HumanoidGltf)), [clonedScene, gltf]);
  const traceSource = useHandTraceSource(gltf, clonedScene, traceAnchors);
  const presenceProbe = useRef(createPresenceProbe()).current;
  const authorHex = useMemo(() => identityOf(author).hex, [author]);
  useEffect(() => {
    portal.setHasHighlights(meaningLinks.length > 0);
    return () => portal.setHasHighlights(false);
  }, [meaningLinks, portal]);
  const animatedBoundsRef = useRef(new Box3());
  const fullSceneBoundsRef = useRef(new Box3());
  const scratchBoundsRef = useRef(new Box3());
  const framingTargetsRef = useRef<Object3D[]>([]);
  const avatarRootRef = useRef<Object3D | null>(null);
  // A camera take has no avatar: the set is what is framed, and no node named Hips or Head is the author.
  const cameraTakeRef = useRef(false);
  const setBoundsRef = useRef<Box3 | null>(null);
  const avatarAnchorRef = useRef<{ hips: Object3D; head: Object3D | null } | null>(null);
  const { actions, mixer } = useTakeAnimations(animations, clonedScene);
  // The cloche (3.4), fitted once on the first drawn frame, when the bubble's
  // live centre and the actions are known. A bubble moves with its author, so
  // the dome follows it by the centre's shift since the fit.
  const [cloche, setCloche] = useState<ClocheShape | null>(null);
  const clocheRef = useRef<ClocheShape | null>(null);
  const clocheShift = useRef(new Vector3()).current;
  const fittedCentre = useRef<Vector3 | null>(null);
  const frameRectRef = useRef(frameRect);
  frameRectRef.current = frameRect;
  const framingRef = useRef<{ key: string; framing: ClocheFraming } | null>(null);
  // The rim follows the ground (3.4): read at the fit, or a frame later when another card is reading its own.
  const rimRef = useRef<{ take: RimTake; motion: RimMotion } | null>(null);
  const rimPending = useRef(false);
  const rimProp = useRef<{ heights: Float32Array | null; shade: boolean }>({ heights: null, shade: true }).current;
  const rimProbe = useRef<RimProbe>({ gated: false, rimReady: false, lifts: false, maxLift: 0, buildMs: null, candidates: 0, heights: null, target: null, raw: null, framing: null, timing: null, groundAt: null, insideDome: null }).current;
  // A scanned place (testHooks only): the fit waits for it, with a timeout, then hides the recorded set.
  const placeGate = useMemo(() => createPlaceGate(testHooks && placeRequest !== null), [placeRequest]);
  // The dome has been fitted once, or tried and found nothing to wrap (a take with no drawn points plays unwrapped).
  const fitTried = useRef(false);
  useEffect(() => {
    if (placeGate.status !== "loading") return undefined;
    const timer = window.setTimeout(() => {
      if (placeGate.status !== "loading") return;
      placeGate.status = "timeout";
      warnPlaceOnce(placeGate, `Place ${placeRequest?.url ?? ""} did not load in time; the card shows its recorded set.`);
      invalidate();
    }, placeRequest?.waitMs ?? PLACE_FIT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [invalidate, placeGate, placeRequest]);
  const buildRimNow = useCallback((shape: ClocheShape) => {
    rimPending.current = false;
    const sceneBubble = clonedScene.getObjectByName("RecordedSceneBubble");
    const fitted = fittedCentre.current;
    if (!sceneBubble || !fitted) return;
    const samples = takeSamples(clonedScene, animations, RIM.framingSamples);
    if (samples.length === 0) return;
    // The grid covers where the foot goes, and the dome's reach around it.
    const reach = Math.max(shape.radii.x, shape.radii.z);
    const margin = reach + RIM.gridMargin;
    const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const sample of samples) {
      const x = shape.base.x + sample.bubble.x - fitted.x;
      const z = shape.base.z + sample.bubble.z - fitted.z;
      box.minX = Math.min(box.minX, x - margin);
      box.maxX = Math.max(box.maxX, x + margin);
      box.minZ = Math.min(box.minZ, z - margin);
      box.maxZ = Math.max(box.maxZ, z + margin);
    }
    clonedScene.updateWorldMatrix(true, false);
    const key = `${clonedScene.matrixWorld.elements.map((value) => value.toFixed(4)).join(",")}|${[box.minX, box.maxX, box.minZ, box.maxZ].map((value) => value.toFixed(2)).join(",")}`;
    const field = cachedGroundField(scene, key, () => buildGroundField(sceneBubble, { box, seeds: samples.map((sample) => sample.feet) }));
    if (!field) return;
    const take = readRimTake(shape, field, samples, fitted);
    rimRef.current = { take, motion: new RimMotion(shape, field) };
    Object.assign(rimProbe, { rimReady: true, lifts: take.lifts, maxLift: take.maxLift, buildMs: field.buildMs, candidates: field.candidates, framing: take.framing, groundAt: field.heightAt });
    // Decided once, so nothing pops in playback: a take whose rim lifts stands on its ground, with no shade (5.1).
    rimProp.shade = !take.lifts;
    framingRef.current = null;
  }, [animations, clonedScene, rimProbe, rimProp, scene]);
  const fitClocheNow = useCallback(() => {
    const bubble = sphereClip.active && sphereClip.radius > 0 ? { center: sphereClip.center.clone(), radius: sphereClip.radius } : null;
    // A bubble follows its author, so the walk is read relative to it: the author's full reach, not their path.
    const anchor = bubble ? clonedScene.getObjectByName("RecordedBubbleSphere") ?? undefined : undefined;
    const points = [...drawnPoints(clonedScene, bubble), ...motionPoints(clonedScene, animations, { anchor, bubble })];
    // The dome wraps everything the bubble draws, ground falling away from the author included (B-033).
    // A camera take's set stands on its origin, the recorded floor; what lies below only widens the foot.
    const shape = fitCloche(points, { floorY: isCameraTake(clonedScene) ? clonedScene.getWorldPosition(new Vector3()).y : undefined });
    if (!shape) return;
    fittedCentre.current = bubble ? bubble.center : null;
    clocheRef.current = shape;
    setCloche(shape);
    // A scanned place replaces the recorded set: the dome was fitted with the set in, so it is the same dome, and the set is hidden after.
    const showsPlace = placeGate.status === "ready";
    // A performer's take with its recorded scene; a camera take and an old export keep today's dome. A place has no ground to lift to.
    rimProbe.gated = !showsPlace && Boolean(bubble) && !isCameraTake(clonedScene) && Boolean(clonedScene.getObjectByName("RecordedAvatar")) && Boolean(clonedScene.getObjectByName("RecordedSceneBubble"));
    if (showsPlace) {
      const recordedSet = clonedScene.getObjectByName("RecordedSceneBubble");
      if (recordedSet) recordedSet.visible = false;
      placeGate.shows = true;
    }
    if (rimProbe.gated) {
      if (groundFieldBudget()) buildRimNow(shape);
      else rimPending.current = true;
    }
    // The cloche is the bubble's look now; the recorded sphere's old glass is not drawn.
    clonedScene.traverse((child) => {
      if (child.name === "RecordedBubbleSphere") child.visible = false;
    });
  }, [animations, buildRimNow, clonedScene, placeGate, rimProbe, sphereClip]);

  // The dome's shift and rim for this frame, set before the cloche paints
  // (FrameFirst), so the shell and the scene's clip always agree.
  const bubbleNode = useMemo(() => clonedScene.getObjectByName("RecordedBubbleSphere") ?? null, [clonedScene]);
  const bubbleNow = useRef(new Vector3()).current;
  // A hologram that zooms into itself names its zoom: the node sits at the
  // zoom's centre and its scale is how far the outermost layer has grown. The
  // dome wraps that layer, so it grows with it and leaves the view going in.
  const zoomNode = useMemo(() => clonedScene.getObjectByName(HOLOGRAM_ZOOM_NODE) ?? null, [clonedScene]);
  const clocheZoom = useRef<{ scale: number; centre: Vector3 } | undefined>(undefined);
  if (zoomNode && !clocheZoom.current) clocheZoom.current = { scale: 1, centre: new Vector3() };
  const zoomScale = useRef(new Vector3()).current;
  const driveCloche = useCallback((delta: number) => {
    // The take advances first: everything after reads this frame's pose. Until the dome is fitted the take holds at its
    // first pose, so the dome is the same however long the first frame was (a loaded machine's can be a large part of a
    // second, and the bubble walks over uneven ground), and the dome fitted after a scan's wait is the one fitted without.
    mixer.update(clocheRef.current || (fitTried.current && placeGate.status === "off") ? delta : 0);
    // The bubble where it is now (a seek between frames included), not where the last draw synced it.
    if (fittedCentre.current && sphereClip.active && bubbleNode) clocheShift.copy(bubbleNode.getWorldPosition(bubbleNow)).sub(fittedCentre.current);
    const zoom = clocheZoom.current;
    if (zoomNode && zoom) {
      zoomNode.updateWorldMatrix(true, false);
      zoomNode.getWorldPosition(zoom.centre);
      zoom.scale = zoomNode.getWorldScale(zoomScale).x;
    }
    const rim = rimRef.current;
    const fittedShape = clocheRef.current;
    if (rim?.take.lifts && fittedShape) {
      const action = primaryActionRef.current;
      const advanceS = action && action.enabled && !action.paused ? delta * action.getEffectiveTimeScale() : 0;
      const heights = rim.motion.update(clocheShift, { dtS: delta, playbackS: action?.time ?? 0, advanceS, reducedMotion });
      rimProp.heights = heights;
      domeRim.set(heights);
      domeClip.u_domeBase.value.set(fittedShape.base.x, fittedShape.base.y, fittedShape.base.z).add(clocheShift);
      domeClip.u_domeRadii.value.set(fittedShape.radii.x, fittedShape.radii.y, fittedShape.radii.z);
      domeClip.u_domeExponent.value = fittedShape.exponent;
      domeClip.u_domeOn.value = 1;
      rimProbe.heights = heights;
      rimProbe.target = rim.motion.target;
      rimProbe.raw = rim.motion.raw;
      rimProbe.timing = rim.motion.timing;
    }
  }, [bubbleNode, bubbleNow, clocheShift, domeClip, domeRim, mixer, placeGate, reducedMotion, rimProbe, rimProp, sphereClip, zoomNode, zoomScale]);

  /** Whether a world point is under the glass where the dome is now, bent onto the rim of a take that lifts. */
  const insideDome = useCallback((point: Vector3): boolean | null => {
    const shape = clocheRef.current;
    if (!shape || !rimRef.current?.take.lifts) return null;
    return clocheInside(shape, rimProp.heights, { x: point.x - clocheShift.x, y: point.y - clocheShift.y, z: point.z - clocheShift.z });
  }, [clocheShift, rimProp]);
  rimProbe.insideDome = insideDome;
  const domeEdge = useMemo(() => ({ inside: insideDome }), [insideDome]);

  useEffect(() => {
    if (testHooks) {
      const observer = (window as Window & { __HOLOIM_FEED_TEST_OBSERVER__?: (value: unknown) => void }).__HOLOIM_FEED_TEST_OBSERVER__;
      const probe = { url, renderer, scene: renderScene, model: clonedScene, camera, bubble: sphereClip, actions, mixer, portal, deep, depthNow, pointing: pointingProbe, traces: tracesProbe, presence: presenceProbe, objects: recordedObjects, credits, cloche: { shape: clocheRef, fitted: fittedCentre, group: clocheGroupRef }, rim: rimProbe, dome: domeClip, sound: soundRef };
      observer?.(probe);
      // Once processed, the API serves `<id>-light.glb` (hologram-budgets) in
      // place of the `<id>.glb` the upload answered with; tests find a card by
      // the upload's URL, whichever of the two the feed fetched first.
      if (/-light\.glb$/.test(url)) observer?.({ ...probe, url: url.replace(/-light\.glb$/, ".glb") });
    }
  }, [actions, camera, clonedScene, credits, deep, mixer, pointingProbe, portal, presenceProbe, recordedObjects, renderScene, renderer, rimProbe, domeClip, sphereClip, tracesProbe, url]);

  useEffect(() => {
    portal.runtime.maxDepth = deep?.maxDepth ?? 0;
    return () => {
      portal.runtime.maxDepth = 0;
    };
  }, [deep, portal]);

  // The wheel zooms only over the hologram itself (usePortalTriggers): a
  // visible mesh of the recording, not chrome, not clipped away by its
  // bubble (recorded objects are never clipped). From inside the bubble
  // everything in view is the hologram. A finger is broader than a cursor, so
  // a touch counts anywhere inside the cloche's glass as well.
  useEffect(() => {
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const centre = new Vector3();
    const sample = new Vector3();
    const throughGlass = () => {
      const shape = clocheRef.current;
      if (!shape) return false;
      const reach = Math.max(shape.radii.x, shape.radii.y, shape.radii.z);
      const zoom = clocheZoom.current;
      const grow = zoom && zoom.scale > 0 ? zoom.scale : 1;
      centre.set(shape.base.x, shape.base.y + shape.radii.y / 2, shape.base.z).add(clocheShift);
      if (zoom && grow !== 1) centre.sub(zoom.centre).multiplyScalar(grow).add(zoom.centre);
      const nearest = raycaster.ray.direction.dot(sample.copy(centre).sub(raycaster.ray.origin));
      for (let step = 0; step <= GLASS_RAY_SAMPLES; step += 1) {
        raycaster.ray.at(nearest - reach * grow + (2 * reach * grow * step) / GLASS_RAY_SAMPLES, sample);
        // Back into the space the dome was fitted in.
        if (zoom && grow !== 1) sample.sub(zoom.centre).divideScalar(grow).add(zoom.centre);
        sample.sub(clocheShift);
        if (clocheInside(shape, rimProp.heights, sample)) return true;
      }
      return false;
    };
    const drawn = (object: Object3D | null): boolean => {
      for (let node = object; node; node = node.parent) {
        if (!node.visible || node.userData.holoimChrome === true) return false;
      }
      return true;
    };
    const hitTest = (clientX: number, clientY: number, options?: { glass?: boolean }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return false;
      // Inside the layers everything in view is the hologram.
      if (depthNow.current > 0) return true;
      const bubble = sphereClip.active && sphereClip.radius > 0 ? sphereClip : null;
      if (bubble && camera.position.distanceTo(bubble.center) < bubble.radius) return true;
      // A skinned mesh caches its bounds on its first raycast; a body that
      // has since walked out of them would be missed, so pose them now.
      clonedScene.traverse((node) => {
        const skinned = node as SkinnedMesh;
        if (!skinned.isSkinnedMesh) return;
        skinned.computeBoundingSphere();
        if (skinned.boundingBox) skinned.computeBoundingBox();
      });
      raycaster.setFromCamera(ndc, camera);
      // With a place the recorded set is hidden, so the glass over the scan counts as the hologram.
      if ((options?.glass || placeGate.shows || storedPlaceShows.current) && throughGlass()) return true;
      return raycaster.intersectObject(clonedScene, true).some((hit) => (
        (hit.object as Mesh).isMesh === true
        && drawn(hit.object)
        && (!bubble || isInsideRecordedObject(hit.object) || drawnAt(hit.object, hit.point, bubble))
      ));
    };
    // What the clip leaves: the bent dome's inside for a take whose rim lifts (the avatar never cut), else the sphere.
    const drawnAt = (object: Object3D, point: Vector3, bubble: SphereClipResult) => {
      const dome = insideDome(point);
      if (dome === null) return point.distanceTo(bubble.center) <= bubble.radius;
      for (let node: Object3D | null = object; node; node = node.parent) if (node.name === "RecordedAvatar") return true;
      return dome;
    };
    portal.runtime.hitTest = hitTest;
    return () => {
      if (portal.runtime.hitTest === hitTest) portal.runtime.hitTest = null;
    };
  }, [camera, clocheShift, clonedScene, insideDome, placeGate, portal, renderer, rimProp, sphereClip]);

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

    if (cameraTakeRef.current) {
      // The set and its objects as drawn: not the author's camera, the bubble's sphere or chrome.
      // Read once, as it first stands: the set is still and every frame asks.
      const setBounds = setBoundsRef.current ??= drawnBounds(clonedScene);
      if (setBounds.isEmpty()) return null;
      const target = computeDesiredFraming(setBounds, perspectiveCamera, DEFAULT_CAMERA_FRAMING_CONFIG);
      const distance = MathUtils.clamp(target.distance * CARD_CAMERA_DISTANCE_SCALE, 1.4, 14);
      return {
        focus: target.focus,
        distance,
        near: Math.max(distance / 500, DEFAULT_CAMERA_FRAMING_CONFIG.minNear),
        far: Math.max(distance * 20, 100)
      };
    }

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
    const cameraTake = isCameraTake(clonedScene);
    cameraTakeRef.current = cameraTake;
    setBoundsRef.current = null;
    // Any avatar format, within the avatar when the export names it, so a
    // recorded object's own bone names (a prop with a "Head") never take over
    // the framing. A camera take has no avatar, so no bone is the author.
    const { hips, head } = cameraTake ? { hips: null, head: null } : resolveHumanoidAnchors(clonedScene, gltf as unknown as HumanoidGltf);

    avatarRootRef.current = avatarRootByName ?? (hips ? getTopLevelAncestor(hips, clonedScene) : null);
    if (!cameraTake && !avatarRootRef.current && framingTargetsRef.current.length > 0) {
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
  }, [camera, clonedScene, computePreferredFraming, gltf, invalidate, sphereClip]);

  useEffect(() => {
    const allActions = Object.values(actions).filter(Boolean) as AnimationAction[];
    if (allActions.length === 0) {
      return;
    }

    const rankedActions = allActions
      .slice()
      .sort((a, b) => compareTakeClips(a.getClip(), b.getClip()));

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
    primaryAction.setEffectiveWeight(TAKE_CLIP_WEIGHT.primary);
    primaryAction.setEffectiveTimeScale(animSpeed);
    primaryAction.play();
    primaryAction.paused = !active;

    rankedActions.slice(1).forEach((action) => {
      action.reset();
      action.enabled = true;
      action.setLoop(LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.setEffectiveWeight(TAKE_CLIP_WEIGHT.secondary);
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
    portal.runtime.playbackSeconds = primaryActionRef.current?.time ?? 0;
    if (!clocheRef.current) {
      // The scan is read before the dome is fitted, so the set it replaces is still in the fit.
      if (placeGate.status !== "loading") {
        fitClocheNow();
        fitTried.current = true;
      }
    }
    else if (rimPending.current && groundFieldBudget()) buildRimNow(clocheRef.current);
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
    // Follow frames the whole cloche in the card's viewing box (3.4).
    const shape = clocheRef.current;
    const rect = frameRectRef.current;
    const framed = Boolean(shape && rect && rect.width > 0 && rect.height > 0);
    if (shape && rect && framed) {
      const key = `${rect.width}x${rect.height}:${baseFov}`;
      if (framingRef.current?.key !== key) {
        // A take whose rim lifts is framed bent by its lowest rim over the path, fixed for the take.
        const rimFraming = rimRef.current?.take.lifts ? rimRef.current.take.framing : null;
        framingRef.current = { key, framing: clocheFraming(shape, { fovY: MathUtils.degToRad(baseFov), aspect: rect.width / rect.height, rim: rimFraming }) };
      }
      const { target: middle, distance } = framingRef.current.framing;
      pose.followTarget.set(middle.x, middle.y, middle.z).add(clocheShift);
      pose.followPosition.copy(pose.followTarget).addScaledVector(FOLLOW_DIRECTION, distance);
      const reach = Math.max(shape.radii.x, shape.radii.y, shape.radii.z);
      preferred.near = Math.max(DEFAULT_CAMERA_FRAMING_CONFIG.minNear, (distance - reach * 1.5) / 40);
      preferred.far = distance + reach * 4;
    }
    const state = portal.getState();
    const runtime = portal.runtime;
    const light = stageLightRef.current;
    if (light) {
      light.position.lerpVectors(pose.followTarget, pose.followPosition, STAGE_LIGHT_TOWARD_VIEWER);
      light.position.y = pose.followTarget.y - STAGE_LIGHT_DROP_METERS;
      light.intensity = stageLight(target, frameState.clock.elapsedTime * 1000, { reducedMotion }) ?? 0;
    }
    const follow = anglesFromPose(pose.followPosition, pose.followTarget);
    const outsideDistance = follow.distance;
    const insideDistance = Math.min(INSIDE_DISTANCE, outsideDistance * MAX_INSIDE_SHARE);
    runtime.followYaw = follow.yaw;
    runtime.followPitch = follow.pitch;
    runtime.zoomSpan = Math.log(outsideDistance / insideDistance);

    const canvasHeight = frameState.size.height;
    if (state.mode === "follow" && runtime.returnBlend === 0) {
      baseHeightRef.current = canvasHeight;
    }
    if (rect && framed) {
      // The main view is the viewing box; the canvas around it shows more of the same view.
      camera.fov = baseFov;
      camera.aspect = rect.width / rect.height;
      camera.setViewOffset(rect.width, rect.height, -rect.left, -rect.top, frameState.size.width, frameState.size.height);
    } else {
      const openRatio = baseHeightRef.current > 0 ? Math.max(canvasHeight / baseHeightRef.current, 1) : 1;
      camera.fov = MathUtils.radToDeg(2 * Math.atan(Math.tan(MathUtils.degToRad(baseFov) / 2) * openRatio));
    }
    const head = avatarAnchorRef.current?.head;
    if (head) {
      head.getWorldPosition(pose.headTarget);
    } else {
      pose.headTarget.copy(pose.followTarget);
    }
    let depth = 0;
    if (state.mode === "free") {
      depth = deep ? state.depth : 0;
      freeCameraPose(state, pose.followTarget, pose.headTarget, insideDistance, outsideDistance, pose.position, pose.target, deep);
    } else if (runtime.returnBlend > 0 && runtime.returnFrom && deep) {
      // Back out of the layers the way in, in log distance, so each passes by instead of a leap to Follow.
      const from = runtime.returnFrom;
      runtime.returnBlend = Math.max(runtime.returnBlend - delta / (RETURN_SECONDS + RETURN_SECONDS_PER_NEPER * from.depth), 0);
      const way = returnPose(from, easeInOut(1 - runtime.returnBlend), follow, runtime.zoomSpan);
      depth = way.depth;
      freeCameraPose(way, pose.followTarget, pose.headTarget, insideDistance, outsideDistance, pose.position, pose.target, deep);
      if (runtime.returnBlend === 0) runtime.returnFrom = null;
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
    depthNow.current = depth;
    if (deep && layerMeshes) {
      // Going in, the cloche is not drawn once the camera is inside its glass
      // (seen from within, it would be a sliver), and a layer's own meshes
      // not once the camera is two homes deeper; they come back on the way
      // out, in the frame the camera crosses back.
      const clocheGroup = clocheGroupRef.current;
      if (clocheGroup) {
        const shape = clocheRef.current;
        const at = pose.position;
        clocheGroup.visible = !(depth > 0 && shape
          && clocheInside(shape, rimProp.heights, { x: at.x - clocheShift.x, y: at.y - clocheShift.y, z: at.z - clocheShift.z }));
      }
      const from = outermostDrawn(deep, depth);
      if (from !== drawnFrom.current) {
        layerMeshes.forEach((meshes, layer) => {
          const was = layer >= drawnFrom.current;
          const now = layer >= from;
          if (was === now) return;
          for (const mesh of meshes) {
            if (!now && mesh.visible) {
              mesh.visible = false;
              deepHidden.add(mesh);
            } else if (now && deepHidden.delete(mesh)) {
              mesh.visible = true;
            }
          }
        });
        drawnFrom.current = from;
      }
    }
    if (depth > 0) {
      // Inside the layers the planes follow the camera down: no floor, or a layer a millimetre across would be cut away.
      const distance = pose.position.distanceTo(pose.target);
      camera.near = distance / DEEP_NEAR_SHARE;
      camera.far = distance * DEEP_FAR_REACH;
    } else if (state.mode === "free" || runtime.returnBlend > 0) {
      // Inside the bubble the Follow clip planes would cut the scene away.
      const distance = pose.position.distanceTo(pose.target);
      camera.near = Math.max(distance / 200, DEFAULT_CAMERA_FRAMING_CONFIG.minNear);
      camera.far = Math.max(preferred.far, distance + sphereClip.radius * 2 + 10);
    } else {
      camera.near = preferred.near;
      camera.far = preferred.far;
    }
    camera.updateProjectionMatrix();

    // The playing card's sounds sit where their objects are, heard from the portal's ear.
    const sound = audioState.audio;
    if (sound?.playing && sound.spatial) {
      camera.updateMatrixWorld();
      const { camera: cameraEar, ear } = earRef.current;
      portalEar(earFromObject(camera, cameraEar), pose.target, insideDistance, outsideDistance, ear);
      sound.place(ear, delta, soundLayers);
    }
  });

  // Where the bubble's centre goes over the take, relative to the fit: the box the place's coarse crop keeps.
  const placeSweep = useMemo(() => {
    const sweep = { min: new Vector3(), max: new Vector3() };
    const fitted = fittedCentre.current;
    if (!cloche || !placeRequest || !fitted) return sweep;
    for (const sample of takeSamples(clonedScene, animations, RIM.framingSamples)) {
      sweep.min.min(sample.bubble.clone().sub(fitted));
      sweep.max.max(sample.bubble.clone().sub(fitted));
    }
    return sweep;
  }, [animations, cloche, clonedScene, placeRequest]);
  // Full-size textures for the focused card (hologram-budgets, Q4 A).
  useTextureDetail({
    url: textureDetailUrl,
    wanted: active,
    scene: clonedScene,
    associations: (gltf.parser as unknown as { associations: Map<object, { textures?: number } | undefined> }).associations
  });
  // The lowest foot bone of the author now, for the place report.
  const readFeetY = useCallback(() => {
    const avatar = clonedScene.getObjectByName("RecordedAvatar");
    let lowest = Number.NaN;
    const at = new Vector3();
    avatar?.traverse((node) => {
      if ((node as Mesh & { isBone?: boolean }).isBone && /(Left|Right)(Foot|ToeBase)$/.test(node.name)) lowest = Math.min(Number.isNaN(lowest) ? Infinity : lowest, node.getWorldPosition(at).y);
    });
    return lowest;
  }, [clonedScene]);

  // The stored place's bytes, from the loader's own parse; the disc it replaces hides once its splats draw.
  const readStoredPlaceBytes = useCallback(
    () => gltf.parser.getDependency("bufferView", storedPlace?.extension.bufferView ?? -1) as Promise<ArrayBuffer>,
    [gltf, storedPlace]
  );
  const onStoredPlaceShown = useCallback(() => {
    const disc = clonedScene.getObjectByName("RecordedSceneBubble");
    if (disc) disc.visible = false;
    storedPlaceShows.current = true;
    invalidate();
  }, [clonedScene, invalidate]);
  const onStoredPlaceFailed = useCallback((error: unknown) => {
    console.warn("The hologram's stored place did not load; it plays on its floor.", error);
  }, []);

  // SkeletonUtils clones share the loader cache's geometry and source materials.
  // useSphereClipping owns/disposes its material clones; leave cached assets alive.

  return (
    <>
      <FrameFirst run={driveCloche} />
      <primitive object={clonedScene} />
      <pointLight ref={stageLightRef} color={tokens.color.glow} decay={2} />
      {cloche && (
        <group ref={clocheGroupRef}>
          <Cloche seed={seed} shape={cloche} shift={clocheShift} zoom={clocheZoom.current} target={target} recording={false} inFocus={active} reducedMotion={reducedMotion} soot={soot} rim={rimProp} />
        </group>
      )}
      {meaningLinks.length > 0 && (
        <PointingHighlights
          links={meaningLinks}
          portal={portal}
          bubble={sphereClip}
          falloffWidth={SPHERE_CLIP_FALLOFF}
          domeEdge={domeEdge}
          getPlaybackTime={getPlaybackTime}
          probe={pointingProbe}
          authorHex={authorHex}
        />
      )}
      {traceSource && (
        <HandTraces source={traceSource} portal={portal} active={active} getPlaybackTime={getPlaybackTime} probe={tracesProbe} />
      )}
      <AuthorCameraMark scene={clonedScene} author={author} probe={presenceProbe} />
      {storedPlace && !placeRequest && (
        <Suspense fallback={null}>
          <StoredPlaceMount
            place={storedPlace}
            readBytes={readStoredPlaceBytes}
            detailUrl={placeDetailUrl}
            detailWanted={active}
            scene={clonedScene}
            shape={cloche}
            shift={clocheShift}
            readFeetY={readFeetY}
            onShown={onStoredPlaceShown}
            onFailed={onStoredPlaceFailed}
          />
        </Suspense>
      )}
      {PlaceMount && placeRequest && (
        <Suspense fallback={null}>
          <PlaceMount request={placeRequest} gate={placeGate} shape={cloche} shift={clocheShift} scene={clonedScene} clips={animations} sweep={placeSweep} readFeetY={readFeetY} />
        </Suspense>
      )}
    </>
  );
}

export function HologramCardCanvas({
  modelUrl,
  placeDetailUrl = null,
  textureDetailUrl = null,
  active,
  muted,
  onHasAudio,
  onCredits,
  onRendered,
  colorAccurateMode,
  portal,
  target,
  reducedMotion,
  seed,
  frameRect,
  soot,
  author,
  placeRequest
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
      <HologramModel url={modelUrl} placeDetailUrl={placeDetailUrl} textureDetailUrl={textureDetailUrl} active={active} muted={muted} onHasAudio={onHasAudio} onCredits={onCredits} onRendered={onRendered} portal={portal} target={target} reducedMotion={reducedMotion} seed={seed} frameRect={frameRect} soot={soot} author={author} placeRequest={placeRequest ?? null} />
    </Canvas>
  );
}
