import {
  AudioSystem,
  DomeGradient,
  Grabbed,
  IBLGradient,
  RayInteractable,
  ReferenceSpaceType,
  SessionMode,
  World,
  type Entity
} from "@iwsdk/core";
import { Box3, BoxGeometry, Quaternion, CircleGeometry, Color, Mesh, MeshBasicMaterial, MeshStandardMaterial, PointLight, Vector3 } from "three";
import type { Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { decodeGltfAudio, resumeAudioContext } from "../hologram/gltfAudio";
import { normalizeSceneAtOrigin } from "../hologram/hologramScene";
import { prepareAnimatedScene } from "../hologram/object3dUtils";
import { freezeBubbleWrapperMotion } from "../ar/arAnimation";
import {
  createHologramRuntime,
  disposeHologramRuntime,
  HologramPlayback,
  HologramPlaybackSystem,
  setHologramPlaying,
  type HologramRuntime
} from "./hologramPlayback";
import { HologramControlsSystem } from "./hologramControls";
import { ArPlacementSystem, VrPlacementSystem } from "./placementSystems";
import { ScreenInputSystem } from "./screenInputBridge";
import { createViewerContext, viewerContext, type XrViewMode } from "./viewerContext";

// Design tokens (docs/product/design/tokens.json): the VR room is the
// blue-hour gradient, and the hologram is lit warm by its own stage light.
const BLUE_HOUR_SKY: [number, number, number, number] = [0.0471, 0.1333, 0.1569, 1]; // ground.top
const BLUE_HOUR_EQUATOR: [number, number, number, number] = [0.3412, 0.3725, 0.3529, 1]; // ground.grey
const BLUE_HOUR_GROUND: [number, number, number, number] = [0.7216, 0.5137, 0.3686, 1]; // ground.horizon
const DEEP_SEA = 0x081a1e;
const STAGE_GLOW = 0xffb066;
const VR_FLOOR_RADIUS_M = 12;

export interface ViewerWorld {
  world: World;
  hologram: Entity;
  /** Starts the immersive session; must run inside a user gesture on devices. */
  enter(): void;
  exit(): void;
  destroy(): void;
}

export interface ViewerWorldOptions {
  mode: XrViewMode;
  modelUrl: string;
  /** The immersive session ended (exit control, system button or error). */
  onSessionEnd(): void;
}

async function loadHologram(modelUrl: string) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(modelUrl);
  const audio = await decodeGltfAudio(gltf).catch((error: unknown) => {
    console.warn("[xr-viewer] Failed to decode KHR_audio data:", error);
    return null;
  });
  return { gltf, audio };
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
  const [world, loaded] = await Promise.all([
    World.create(container, {
      xr: {
        sessionMode: isAr ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR,
        referenceSpace: { type: ReferenceSpaceType.LocalFloor },
        features: isAr ? { hitTest: true, anchors: true } : { handTracking: true },
        offer: "none"
      },
      features: { locomotion: false, physics: false, grabbing: true, spatialUI: true }
    }),
    loadHologram(options.modelUrl)
  ]);
  // Hologram audio is app-side (HologramPlaybackSystem): IWSDK's AudioSystem
  // cannot seek and ramps on wall-clock time.
  world.unregisterSystem(AudioSystem);
  world.globals.viewer = createViewerContext(options.mode);
  addRoomLight(world);
  if (!isAr) addVrRoom(world);

  // Recorded scale, never normalised: true scale is fact.
  const root = cloneSkeleton(loaded.gltf.scene);
  prepareAnimatedScene(root);
  normalizeSceneAtOrigin(root);
  standOnFeet(root);
  root.name = "HologramModel";
  const hologram = world.createTransformEntity(undefined, { parent: world.activeLevel.value });
  hologram.object3D!.name = "Hologram";
  hologram.object3D!.add(root);
  const stageLight = new PointLight(STAGE_GLOW, 1.5, 4, 2);
  stageLight.position.set(0, 0.35, 0.6);
  hologram.object3D!.add(stageLight);
  // Taps and rays hit a body-sized box, not the skinned triangles: forgiving
  // to aim at, and cheap for pointers that move every frame.
  (root as Object3D & { pointerEvents?: string }).pointerEvents = "none";
  const size = new Box3().setFromObject(root).getSize(new Vector3());
  const hitBox = new Mesh(new BoxGeometry(size.x, size.y, Math.max(size.z, 0.3)), new MeshBasicMaterial({ visible: false }));
  hitBox.name = "HologramHitBox";
  hitBox.position.y = size.y / 2;
  hologram.object3D!.add(hitBox);
  const { runtime, duration } = createHologramRuntime(root, freezeBubbleWrapperMotion(loaded.gltf.animations), loaded.audio);
  hologram.addComponent(HologramPlayback, { runtime, duration, playing: duration > 0 });
  hologram.object3D!.visible = false;
  // IWSDK pointers only intersect entities marked interactable.
  hologram.addComponent(RayInteractable);
  // A tap on the hologram pauses or resumes it (screen, ray or poke).
  hologram.object3D!.addEventListener("click" as never, () => {
    setHologramPlaying(hologram, !hologram.getValue(HologramPlayback, "playing"));
  });
  viewerContext(world).focused = hologram;

  world.registerSystem(HologramPlaybackSystem).registerSystem(HologramControlsSystem);
  if (isAr) {
    world.registerSystem(ArPlacementSystem).registerSystem(ScreenInputSystem);
    const placement = world.getSystem(ArPlacementSystem)!;
    world.getSystem(ScreenInputSystem)!.onTap = (tap) => {
      if (!tap.hitObject) placement.placeAtTap(tap.ray);
    };
  } else {
    world.registerSystem(VrPlacementSystem);
  }

  const xr = world.renderer.xr;
  const onSessionStart = (): void => resumeAudioContext();
  const onSessionEnd = (): void => {
    hologram.object3D!.visible = false;
    const c = viewerContext(world);
    c.placement = { ...c.placement, stage: "searching" };
    options.onSessionEnd();
  };
  xr.addEventListener("sessionstart", onSessionStart);
  xr.addEventListener("sessionend", onSessionEnd);
  if (import.meta.env.DEV) installXrViewerProbe(world, hologram, root);

  let destroyed = false;
  return {
    world,
    hologram,
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
      const runtimeValue = hologram.getValue(HologramPlayback, "runtime") as HologramRuntime | undefined;
      if (runtimeValue) disposeHologramRuntime(runtimeValue);
      delete (window as { __HOLOIM_XR_VIEWER__?: unknown }).__HOLOIM_XR_VIEWER__;
      if (xr.getSession()) world.exitXR();
      world.destroy();
    }
  };
}

/** Development-only window probe the e2e spec reads (`xr-viewer-report.json`). */
/**
 * normalizeSceneAtOrigin stands the model on its bounds, but a skinned mesh's
 * bounds follow bone matrices a fresh clone has not computed, so a recorded
 * person can float about a hip height off the floor. Re-stand it on its
 * posed vertices.
 */
function standOnFeet(root: Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as Object3D & { isSkinnedMesh?: boolean; skeleton?: { update(): void } };
    if (mesh.isSkinnedMesh) mesh.skeleton?.update();
  });
  const bounds = new Box3().setFromObject(root, true);
  if (!bounds.isEmpty() && Number.isFinite(bounds.min.y)) root.position.y -= bounds.min.y;
}

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

function installXrViewerProbe(world: World, hologram: Entity, model: Object3D): void {
  const size = new Box3().setFromObject(model).getSize(new Vector3());
  (window as { __HOLOIM_XR_VIEWER__?: unknown }).__HOLOIM_XR_VIEWER__ = {
    world,
    hologram,
    snapshot: () => {
      const c = viewerContext(world);
      const runtime = hologram.getValue(HologramPlayback, "runtime") as HologramRuntime | undefined;
      const object = hologram.object3D!;
      const worldPosition = object.getWorldPosition(new Vector3());
      const session = world.renderer.xr.getSession();
      return {
        mode: c.mode,
        session: session ? { active: true, environmentBlendMode: session.environmentBlendMode ?? null } : { active: false },
        placement: c.placement,
        hologram: {
          visible: object.visible,
          worldPosition: worldPosition.toArray(),
          worldScale: object.getWorldScale(new Vector3()).toArray(),
          yaw: object.rotation.y,
          // A recorded person stays upright: the angle between its up and the world's.
          lowestBoneY: lowestBoneY(model),
          tiltRad: new Vector3(0, 1, 0).applyQuaternion(object.getWorldQuaternion(new Quaternion())).angleTo(new Vector3(0, 1, 0)),
          grabbed: hologram.hasComponent(Grabbed),
          recordedSize: size.toArray(),
          playing: Boolean(hologram.getValue(HologramPlayback, "playing")),
          clipTime: hologram.getValue(HologramPlayback, "clipTime"),
          duration: hologram.getValue(HologramPlayback, "duration"),
          actionTimes: runtime?.actions.map((action) => action.time) ?? [],
          audio: runtime?.audio
            ? { playing: runtime.audio.playing, scheduledOffset: runtime.audio.scheduledOffset(), duration: runtime.audio.duration }
            : null
        },
        controls: world.getSystem(HologramControlsSystem)?.probe() ?? null,
        renderer: {
          geometries: world.renderer.info.memory.geometries,
          textures: world.renderer.info.memory.textures,
          calls: world.renderer.info.render.calls
        }
      };
    }
  };
}
