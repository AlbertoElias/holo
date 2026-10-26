import { tokens } from "@holoim/design-tokens";
import { readIwerRuntime } from "@holoim/xr-runtime";
import {
  AudioSystem,
  DomeGradient,
  Grabbed,
  IBLGradient,
  LocomotionEnvironment,
  LocomotionSystem,
  ReferenceSpaceType,
  DepthSensingSystem,
  SessionMode,
  SlideSystem,
  TurningMethod,
  World,
  type Entity
} from "@iwsdk/core";
import { Box3, CircleGeometry, Color, Euler, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import type { Object3D } from "three";

import { resumeAudioContext } from "../hologram/gltfAudio";
import { HologramBubbleSystem } from "./bubbleSystem";
import { HologramAssetCache } from "./hologramAssets";
import { HologramPlayback, HologramPlaybackSystem, seekHologram, setHologramPlaying, type HologramRuntime } from "./hologramPlayback";
import { HologramControlsSystem } from "./hologramControls";
import { HologramSpace } from "./hologramSpace";
import { GallerySystem, type GalleryFeed } from "./gallerySystem";
import { ArPlacementSystem, VrPlacementSystem } from "./placementSystems";
import { ScreenInputSystem } from "./screenInputBridge";
import { GRAB_SCALE_MAX, GRAB_SCALE_MIN } from "./twoHandGrab";
import { createViewerContext, focusedRecord, viewerContext, type PlacedHologram, type XrViewMode } from "./viewerContext";

// Design tokens (docs/product/design/tokens.json): the VR room is the
// blue-hour gradient, and the hologram is lit warm by its own stage light.
const BLUE_HOUR_SKY: [number, number, number, number] = [0.0471, 0.1333, 0.1569, 1]; // ground.top
const BLUE_HOUR_EQUATOR: [number, number, number, number] = [0.3412, 0.3725, 0.3529, 1]; // ground.grey
const BLUE_HOUR_GROUND: [number, number, number, number] = [0.7216, 0.5137, 0.3686, 1]; // ground.horizon
const DEEP_SEA = tokens.color.deepSea;
const VR_FLOOR_RADIUS_M = 12;
// VR locomotion as capture moves (archived vr-thumbstick-locomotion.md):
// 30° snap turns and a walking pace for a 1.75 m person (1.8 × height / s).
const VR_SNAP_TURN_DEG = 30;
const VR_SLIDE_SPEED_MPS = 3.2;
// IWSDK's locomotor integrates gravity over the whole frame delta: one long
// frame (a model loading, the session starting) drops the rig through the
// floor before its ground ray can catch it, and the slide's comfort vignette
// eases by 10 × delta, which overshoots past 0.1 s and turns it solid black.
// Steps are clamped to this.
const VR_LOCOMOTION_MAX_STEP_S = 1 / 20;
/** Within this of the floor the rig stands on it (the float spring's bob). */
const VR_RIG_FLOOR_SNAP_M = 0.05;

/** The slide's comfort vignette (private in IWSDK 1.0.1). */
function slideVignette(slide: SlideSystem | undefined): (Mesh & { material: { uniforms: { uAlpha: { value: number } } } }) | undefined {
  return (slide as unknown as { vignette?: Mesh & { material: { uniforms: { uAlpha: { value: number } } } } } | undefined)?.vignette;
}

function clampStep(system: { update(delta: number): void }): void {
  const step = system.update.bind(system);
  system.update = (delta: number) => step(Math.min(delta, VR_LOCOMOTION_MAX_STEP_S));
}

export interface ViewerWorld {
  world: World;
  /** Starts the immersive session; must run inside a user gesture on devices. */
  enter(): void;
  exit(): void;
  destroy(): void;
}

export interface ViewerWorldOptions {
  mode: XrViewMode;
  /** The hologram the route opened: placed and focused on entry. */
  initial: { id: string; url: string };
  /** The feed, for the gallery; paged further with `loadMore`. */
  feed: GalleryFeed;
  loadMore(cursor: string): Promise<GalleryFeed>;
  /** The immersive session ended (exit control, system button or error), with the last focused hologram. */
  onSessionEnd(focusedId: string | null): void;
}

/** Within 4% of the recorded scale a pinch snaps back to life size. */
const PINCH_TRUE_SCALE_SNAP = 0.04;

function pinchScale(scale: number): number {
  const clamped = Math.min(GRAB_SCALE_MAX, Math.max(GRAB_SCALE_MIN, scale));
  return Math.abs(clamped - 1) < PINCH_TRUE_SCALE_SNAP ? 1 : clamped;
}

/**
 * Depth occlusion in AR. Off under the IWER emulator, which computes emulated
 * depth with a synchronous GPU readback every frame that stalls software-GL
 * runners; a development build can turn it on there with `?depth=on`.
 */
function wantsDepthOcclusion(): boolean {
  if (!readIwerRuntime().available) return true;
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("depth") === "on";
}

/**
 * Runs `launch` with extra optional session features: IWSDK's feature flags
 * have no light estimation, which the cloche's AR char reads (3.2).
 * `launchXR` requests its session synchronously.
 */
function withOptionalFeatures(features: string[], launch: () => void): void {
  const xr = navigator.xr;
  if (!xr) return launch();
  const requestSession = xr.requestSession;
  xr.requestSession = (mode, init) => {
    const optionalFeatures = [...new Set([...(init?.optionalFeatures ?? []), ...features])];
    return requestSession.call(xr, mode, { ...init, optionalFeatures });
  };
  try {
    launch();
  } finally {
    xr.requestSession = requestSession;
  }
}

/** Image-based light from the blue-hour gradient: lights the hologram in VR and AR alike. */
function addRoomLight(world: World): void {
  world.activeLevel.value.addComponent(IBLGradient, { sky: BLUE_HOUR_SKY, equator: BLUE_HOUR_EQUATOR, ground: BLUE_HOUR_GROUND, intensity: 1 });
}

/** VR only: the blue-hour dome and floor. AR keeps the camera image as its ground. */
function addVrRoom(world: World): void {
  const level = world.activeLevel.value;
  level.addComponent(DomeGradient, { sky: BLUE_HOUR_SKY, equator: BLUE_HOUR_EQUATOR, ground: BLUE_HOUR_GROUND, intensity: 1 });
  const floor = new Mesh(
    new CircleGeometry(VR_FLOOR_RADIUS_M, 64),
    new MeshStandardMaterial({ color: new Color(DEEP_SEA), roughness: 0.95, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  // Just under the recorded floor (B-022: at y = 0), so a take's own ground draws instead of fighting it.
  floor.position.y = -0.01;
  floor.name = "ViewerFloor";
  world.createTransformEntity(floor, { parent: level });
  // What locomotion walks on: an undrawn disc at the local floor (y = 0), so
  // the player rig stays at floor height and placements keep standing on y = 0.
  // Flat in its geometry: the locomotor can read the mesh on the frame it is
  // created, before IWSDK's transforms have composed an object rotation.
  const walk = new Mesh(new CircleGeometry(VR_FLOOR_RADIUS_M, 64).rotateX(-Math.PI / 2));
  walk.visible = false;
  walk.name = "ViewerWalkSurface";
  world.createTransformEntity(walk, { parent: level }).addComponent(LocomotionEnvironment);
  // Slide (left stick), snap turn (right stick x) and teleport (right stick back, release to land).
  const locomotion = world.getSystem(LocomotionSystem)!;
  locomotion.config.turningAngle.value = VR_SNAP_TURN_DEG;
  locomotion.config.slidingSpeed.value = VR_SLIDE_SPEED_MPS;
  clampStep(locomotion);
  // The slide system registers once the locomotor is ready.
  let slideReady = false;
  const step = locomotion.update.bind(locomotion);
  locomotion.update = (delta: number) => {
    step(delta);
    if (!slideReady) {
      const slide = world.getSystem(SlideSystem);
      if (slide) {
        clampStep(slide);
        // The vignette is an open cylinder before the eyes: a controller's ray
        // crosses its far wall and would stop there. It is never a target.
        const vignette = slideVignette(slide);
        if (vignette) vignette.raycast = () => {};
        slideReady = true;
      }
    }
    // The room is flat: the rig stands on y = 0 rather than on the
    // character's float spring, which bobs a couple of cm while it moves and
    // can sleep a few mm off. IWER and headset poses then stay floor poses.
    const rig = world.player.position;
    if (Math.abs(rig.y) < VR_RIG_FLOOR_SNAP_M) rig.y = 0;
  };
  // The World's loop runs while the opened hologram loads, before this floor
  // exists, and the locomotor falls with nothing under it: stand the rig back
  // on the floor's origin now that there is one.
  locomotion.setPlayerPosition(new Vector3(0, 0, 0));
}

export async function createViewerWorld(container: HTMLDivElement, options: ViewerWorldOptions): Promise<ViewerWorld> {
  const isAr = options.mode === "ar";
  const depthOcclusion = isAr && wantsDepthOcclusion();
  const cache = new HologramAssetCache();
  // Load the opened hologram alongside the World, so entering never waits on it.
  const [created, opened] = await Promise.allSettled([
    World.create(container, {
      xr: {
        sessionMode: isAr ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR,
        referenceSpace: { type: ReferenceSpaceType.LocalFloor },
        features: isAr
          ? { hitTest: true, anchors: true, ...(depthOcclusion ? { depthSensing: { usage: "gpu-optimized" as const } } : {}) }
          : { handTracking: true },
        offer: "none"
      },
      features: {
        // In-thread, so the rig lands where the locomotor puts it on the same frame (no worker lerp).
        locomotion: isAr ? false : { useWorker: false, turningMethod: TurningMethod.SnapTurn, enableJumping: false },
        physics: false,
        grabbing: true,
        spatialUI: true
      }
    }),
    cache.acquire(options.initial.url)
  ]);
  if (created.status === "rejected" || opened.status === "rejected") {
    if (created.status === "fulfilled") created.value.destroy();
    cache.dispose();
    throw created.status === "rejected" ? created.reason : (opened as PromiseRejectedResult).reason;
  }
  const world = created.value;
  // Hologram audio is app-side (HologramPlaybackSystem): IWSDK's AudioSystem
  // cannot seek and ramps on wall-clock time. Its listener stays on the head
  // after it goes and ramps every frame on three's clock, which can step
  // backwards under a test's fake clock, so it goes too.
  (world.getSystem(AudioSystem) as { listener?: Object3D } | undefined)?.listener?.removeFromParent();
  world.unregisterSystem(AudioSystem);
  world.globals.viewer = createViewerContext(options.mode);
  addRoomLight(world);
  if (!isAr) addVrRoom(world);

  world.registerSystem(HologramPlaybackSystem).registerSystem(HologramBubbleSystem).registerSystem(HologramControlsSystem).registerSystem(GallerySystem);
  // IWSDK draws its own occlusion into each DepthOccludable's materials (it
  // turns three's depth-sensing mesh off).
  if (depthOcclusion) world.registerSystem(DepthSensingSystem);
  world.getSystem(HologramBubbleSystem)!.occlusionRequested = depthOcclusion;
  if (isAr) world.registerSystem(ArPlacementSystem).registerSystem(ScreenInputSystem);
  else world.registerSystem(VrPlacementSystem);

  const space = new HologramSpace(world, cache, {
    // A phone has no play glyph within thumb reach of the body; its tap on the focused hologram pauses it.
    tapTogglesPlay: () => viewerContext(world).target === "ar-phone",
    onRemove: (entity) => world.getSystem(ArPlacementSystem)?.forget(entity),
    occludable: depthOcclusion,
    ...(import.meta.env.DEV ? { onPlaced: (record: PlacedHologram) => observePlaced(world, record) } : {})
  });
  const gallery = world.getSystem(GallerySystem)!;
  gallery.configure({ feed: options.feed, space, cache, loadMore: options.loadMore });
  await space.place(options.initial);
  // The opened hologram's own use: the space holds its use from here.
  cache.release(options.initial.url);

  if (isAr) {
    const placement = world.getSystem(ArPlacementSystem)!;
    const screen = world.getSystem(ScreenInputSystem)!;
    screen.onTap = (tap) => {
      if (!tap.hitObject) placement.placeAtTap(tap.ray);
    };
    // Two fingers rescale the focused hologram about its feet (Q13), within the grab's limits.
    let pinchBase = 1;
    screen.onPinchStart = () => {
      pinchBase = focusedRecord(viewerContext(world))?.entity.object3D?.scale.x ?? 1;
    };
    screen.onPinch = (factor) => {
      const object = focusedRecord(viewerContext(world))?.entity.object3D;
      if (object) object.scale.setScalar(pinchScale(pinchBase * factor));
    };
  }

  const xr = world.renderer.xr;
  const onSessionStart = (): void => resumeAudioContext();
  const onSessionEnd = (): void => {
    const c = viewerContext(world);
    const focusedId = focusedRecord(c)?.id ?? null;
    for (const record of c.placed) record.entity.object3D!.visible = false;
    options.onSessionEnd(focusedId);
  };
  xr.addEventListener("sessionstart", onSessionStart);
  xr.addEventListener("sessionend", onSessionEnd);
  if (import.meta.env.DEV) installXrViewerProbe(world, cache, space);

  let destroyed = false;
  return {
    world,
    enter: () => {
      resumeAudioContext();
      if (isAr) withOptionalFeatures(["light-estimation"], () => world.launchXR());
      else world.launchXR();
    },
    exit: () => world.exitXR(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      xr.removeEventListener("sessionstart", onSessionStart);
      xr.removeEventListener("sessionend", onSessionEnd);
      space.dispose();
      delete (window as { __HOLOIM_XR_VIEWER__?: unknown }).__HOLOIM_XR_VIEWER__;
      if (xr.getSession()) world.exitXR();
      world.destroy();
      cache.dispose();
    }
  };
}

/**
 * Opt-in local e2e observer, as the R3F AR view offers it: the AR bubble and
 * floor specs inspect the last placed hologram's model, bubble and cloche,
 * and the real XR cameras and pixels. Development builds only.
 */
function observePlaced(world: World, record: PlacedHologram): void {
  const observer = (window as Window & { __HOLOIM_AR_TEST_OBSERVER__?: (value: unknown) => void }).__HOLOIM_AR_TEST_OBSERVER__;
  if (!observer) return;
  const runtime = record.entity.getValue(HologramPlayback, "runtime") as HologramRuntime | undefined;
  const actions = Object.fromEntries((runtime?.actions ?? []).map((action, index) => [action.getClip().name || `clip-${index}`, action]));
  observer({
    renderer: world.renderer,
    scene: world.scene,
    camera: world.camera,
    model: record.model,
    bubble: record.bubble.bubble,
    actions,
    mixer: runtime?.mixer,
    cloche: { get current() { return record.bubble.shape; } },
    group: { current: record.entity.object3D }
  });
}

/** Development-only window probe the e2e spec reads (`xr-viewer-report.json`). */
function lowestBoneY(model: Object3D): number | null {
  let lowest: number | null = null;
  const at = new Vector3();
  model.traverse((object) => {
    if (!(object as Object3D & { isBone?: boolean }).isBone) return;
    const y = object.getWorldPosition(at).y;
    lowest = lowest === null ? y : Math.min(lowest, y);
  });
  return lowest;
}

function hologramReading(world: World, record: PlacedHologram) {
  const hologram = record.entity;
  const object = hologram.object3D!;
  const runtime = hologram.getValue(HologramPlayback, "runtime") as HologramRuntime | undefined;
  return {
    id: record.id,
    focused: viewerContext(world).focused === hologram,
    placement: record.placement,
    visible: object.visible,
    worldPosition: object.getWorldPosition(new Vector3()).toArray(),
    worldScale: object.getWorldScale(new Vector3()).toArray(),
    yaw: object.rotation.y,
    // A recorded person stays upright: the angle between its up and the world's.
    lowestBoneY: lowestBoneY(record.model),
    tiltRad: new Vector3(0, 1, 0).applyQuaternion(object.getWorldQuaternion(new Quaternion())).angleTo(new Vector3(0, 1, 0)),
    grabbed: hologram.hasComponent(Grabbed),
    recordedSize: new Box3().setFromObject(record.model).getSize(new Vector3()).divideScalar(object.scale.x || 1).toArray(),
    footprintRadius: record.footprintRadius,
    playing: Boolean(hologram.getValue(HologramPlayback, "playing")),
    audible: Boolean(hologram.getValue(HologramPlayback, "audible")),
    clipTime: hologram.getValue(HologramPlayback, "clipTime"),
    duration: hologram.getValue(HologramPlayback, "duration"),
    actionTimes: runtime?.actions.map((action) => action.time) ?? [],
    audio: runtime?.audio
      ? { playing: runtime.audio.playing, scheduledOffset: runtime.audio.scheduledOffset(), duration: runtime.audio.duration }
      : null
  };
}

const UI_ROOT = /^(FootControls|StatusLine|HandDock|GalleryTilePanel\d+|GalleryPage-.+)$/;

/**
 * Uploaded geometries under the XR UI's UIKit documents. UIKit keeps a text's
 * glyph buffers once they have grown, so memory checks compare the rest: the
 * holograms, previews and room. (three's renderer adds a dispose listener to
 * a geometry when it first uploads it.)
 */
function uiGeometries(world: World): number {
  const counted = new Set<unknown>();
  world.scene.traverse((object) => {
    if (!UI_ROOT.test(object.name)) return;
    object.traverse((child) => {
      const geometry = (child as Object3D & { geometry?: { _listeners?: { dispose?: unknown[] } } }).geometry;
      if (geometry?._listeners?.dispose?.length) counted.add(geometry);
    });
  });
  return counted.size;
}

/** Development-only window probe the e2e spec reads (`xr-viewer-report.json`). */
function installXrViewerProbe(world: World, cache: HologramAssetCache, space: HologramSpace): void {
  const gallery = world.getSystem(GallerySystem)!;
  (window as { __HOLOIM_XR_VIEWER__?: unknown }).__HOLOIM_XR_VIEWER__ = {
    world,
    gallery,
    space,
    get hologram(): Entity | null {
      return viewerContext(world).focused;
    },
    /** Holds the focused hologram at `clipTime` (paused), or plays it from there. */
    setClock: (clipTime: number, playing: boolean) => {
      const focused = viewerContext(world).focused;
      if (!focused) return;
      setHologramPlaying(focused, playing);
      seekHologram(focused, clipTime);
    },
    takeFadeLog: () => world.getSystem(HologramControlsSystem)?.takeFadeLog() ?? [],
    snapshot: () => {
      const c = viewerContext(world);
      const session = world.renderer.xr.getSession();
      const focused = focusedRecord(c);
      const holograms = c.placed.map((record) => hologramReading(world, record));
      return {
        mode: c.mode,
        session: session ? { active: true, environmentBlendMode: session.environmentBlendMode ?? null } : { active: false },
        // The focused hologram, as steps 2 and 3 read it.
        placement: focused?.placement ?? { stage: "searching", mode: null, sequence: 0, position: null },
        hologram: focused ? holograms.find((reading) => reading.id === focused.id)! : null,
        focusedId: focused?.id ?? null,
        holograms,
        // The locomotion rig: where the viewer's floor origin stands and how far it has turned.
        player: {
          position: world.player.getWorldPosition(new Vector3()).toArray(),
          yawRad: new Euler().setFromQuaternion(world.player.getWorldQuaternion(new Quaternion()), "YXZ").y,
          vignetteAlpha: slideVignette(world.getSystem(SlideSystem))?.material.uniforms.uAlpha.value ?? 0
        },
        stage: c.stage ? { origin: c.stage.origin.toArray(), forward: c.stage.forward.toArray(), distanceM: c.stage.distanceM, floorY: c.stage.floorY } : null,
        chipWidthM: c.chipWidthM,
        gallery: gallery.probe(),
        cache: cache.keys(),
        controls: world.getSystem(HologramControlsSystem)?.probe() ?? null,
        bubbles: {
          ...world.getSystem(HologramBubbleSystem)!.probe(),
          holograms: c.placed.map((record) => ({
            id: record.id,
            clipping: record.bubble.bubble.active,
            radius: record.bubble.bubble.radius,
            cloche: record.bubble.shape !== null
          }))
        },
        renderer: {
          geometries: world.renderer.info.memory.geometries,
          uiGeometries: uiGeometries(world),
          textures: world.renderer.info.memory.textures,
          calls: world.renderer.info.render.calls
        }
      };
    }
  };
}
