import { tokens } from "@holoim/design-tokens";
import {
  AudioSystem,
  DomeGradient,
  Grabbed,
  IBLGradient,
  ReferenceSpaceType,
  SessionMode,
  World,
  type Entity
} from "@iwsdk/core";
import { Box3, CircleGeometry, Color, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import type { Object3D } from "three";

import { resumeAudioContext } from "../hologram/gltfAudio";
import { HologramAssetCache } from "./hologramAssets";
import { HologramPlayback, HologramPlaybackSystem, type HologramRuntime } from "./hologramPlayback";
import { HologramControlsSystem } from "./hologramControls";
import { HologramSpace } from "./hologramSpace";
import { GallerySystem, type GalleryFeed } from "./gallerySystem";
import { ArPlacementSystem, VrPlacementSystem } from "./placementSystems";
import { ScreenInputSystem } from "./screenInputBridge";
import { createViewerContext, focusedRecord, viewerContext, type PlacedHologram, type XrViewMode } from "./viewerContext";

// Design tokens (docs/product/design/tokens.json): the VR room is the
// blue-hour gradient, and the hologram is lit warm by its own stage light.
const BLUE_HOUR_SKY: [number, number, number, number] = [0.0471, 0.1333, 0.1569, 1]; // ground.top
const BLUE_HOUR_EQUATOR: [number, number, number, number] = [0.3412, 0.3725, 0.3529, 1]; // ground.grey
const BLUE_HOUR_GROUND: [number, number, number, number] = [0.7216, 0.5137, 0.3686, 1]; // ground.horizon
const DEEP_SEA = tokens.color.deepSea;
const VR_FLOOR_RADIUS_M = 12;

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
  floor.name = "ViewerFloor";
  world.createTransformEntity(floor, { parent: level });
}

export async function createViewerWorld(container: HTMLDivElement, options: ViewerWorldOptions): Promise<ViewerWorld> {
  const isAr = options.mode === "ar";
  const cache = new HologramAssetCache();
  // Load the opened hologram alongside the World, so entering never waits on it.
  const [created, opened] = await Promise.allSettled([
    World.create(container, {
      xr: {
        sessionMode: isAr ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR,
        referenceSpace: { type: ReferenceSpaceType.LocalFloor },
        features: isAr ? { hitTest: true, anchors: true } : { handTracking: true },
        offer: "none"
      },
      features: { locomotion: false, physics: false, grabbing: true, spatialUI: true }
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
  // cannot seek and ramps on wall-clock time.
  world.unregisterSystem(AudioSystem);
  world.globals.viewer = createViewerContext(options.mode);
  addRoomLight(world);
  if (!isAr) addVrRoom(world);

  world.registerSystem(HologramPlaybackSystem).registerSystem(HologramControlsSystem).registerSystem(GallerySystem);
  if (isAr) world.registerSystem(ArPlacementSystem).registerSystem(ScreenInputSystem);
  else world.registerSystem(VrPlacementSystem);

  const space = new HologramSpace(world, cache, {
    // A phone has no play glyph within thumb reach of the body; its tap on the focused hologram pauses it.
    tapTogglesPlay: () => viewerContext(world).target === "ar-phone",
    onRemove: (entity) => world.getSystem(ArPlacementSystem)?.forget(entity)
  });
  const gallery = world.getSystem(GallerySystem)!;
  gallery.configure({ feed: options.feed, space, cache, loadMore: options.loadMore });
  await space.place(options.initial);
  // The opened hologram's own use: the space holds its use from here.
  cache.release(options.initial.url);

  if (isAr) {
    const placement = world.getSystem(ArPlacementSystem)!;
    world.getSystem(ScreenInputSystem)!.onTap = (tap) => {
      if (!tap.hitObject) placement.placeAtTap(tap.ray);
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
      world.launchXR();
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
        stage: c.stage ? { origin: c.stage.origin.toArray(), forward: c.stage.forward.toArray(), distanceM: c.stage.distanceM, floorY: c.stage.floorY } : null,
        chipWidthM: c.chipWidthM,
        gallery: gallery.probe(),
        cache: cache.keys(),
        controls: world.getSystem(HologramControlsSystem)?.probe() ?? null,
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
