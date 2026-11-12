import * as THREE from 'three';
import type { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { MAX_HOLOGRAM_BYTES, PLACE_INPUT_SPLAT_CAP, checkSpzBytes } from '@holoim/contracts';
import { FLOOR_BAND_METERS, SPLAT_EXTENT_SIGMA, decodeScan, plyVertexCount, type DecodedScan } from '@holoim/place';

import type { AvatarRig } from '../avatar/AvatarRig';
import type { CaptureObjects } from '../objects/CaptureObjects';
import type { CharacterMotor } from '../physics/CharacterMotor';
import type { CaptureStage } from '../runtime/captureStage';
import type { UIStateStore } from '../ui/UIStateStore';
import { createPlaceFloor, PLACE_FLOOR_NAME } from './placeFloor';
import { cropScanToTake, type PlaceCrop } from './placeExport';

// A scanned place as capture's set (docs/features/splat-capture.md, slice 2a):
// a `.spz` or `.ply` from the picker or `?place=`, read for its way up and
// its floor, stood with that floor's middle on the set's origin at true
// scale, and drawn by Spark. The set it replaces leaves the scene: the floor
// disc becomes `avatar.worldModel`, and the motor and the props' physics are
// rebuilt on it. The splats are never part of the set: only pointing casts
// against them, on purpose.

/** Spark's raycast skips splats fainter than this: a faint floater does not catch a point. */
export const PLACE_RAYCAST_MIN_OPACITY = 0.5;
/** The share of the floor band's splats that sets where the scan ends, for the floor's fade. */
const SCAN_EDGE_QUANTILE = 0.95;

export type PlaceSource = { kind: 'file'; file: File } | { kind: 'url'; url: string };

/** The scan placed in the set frame. `quaternion` turns the file's axes to y up; `position` puts the floor's middle at the origin. */
export type LivePlace = {
  name: string;
  scan: DecodedScan;
  quaternion: THREE.Quaternion;
  position: THREE.Vector3;
  /** What is drawn: Spark's LoD keeps it within the device's splat budget. */
  mesh: SplatMesh;
  /** What pointing casts against: every splat of the scan, never drawn (hidden). */
  cast: SplatMesh;
  /** The scan's LoD tree: built in the background only for a scan over Spark's budget. `released` once swapped out. */
  lod: { state: 'none' | 'building' | 'ready' | 'failed'; ms: number; released: boolean };
  floor: THREE.Mesh;
  scanRadius: number;
  /** The set's floor band as placed: the median height of the scan's floor splats, world y (0 when placed right). */
  floorBandY: number;
};

export type PlaceExportPayload = {
  crop: PlaceCrop;
  spz: Uint8Array;
  maxSh: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** The crop as a raycastable splat mesh at the node's transform: pointing resolves against what is stored. */
  raycast: SplatMesh;
  writeMs: number;
};

/** What checks read (`__samplePlace`). */
export type PlaceCaptureReport = {
  status: 'none' | 'loading' | 'ready' | 'error';
  name: string | null;
  message: string | null;
  splatsLoaded: number;
  /** The drawn mesh has a LoD tree, so Spark's per-device budget caps what it draws. */
  drawnWithLod: boolean;
  lodState: LivePlace['lod']['state'];
  lodMs: number;
  /** The splats Spark draws at most on this device; a scan over it gets a LoD tree. */
  lodBudget: number;
  /** Pointing casts against every splat of the scan, on a mesh that is never drawn. */
  castAtFullResolution: boolean;
  flipped: boolean;
  upright: string;
  floorFound: boolean;
  /** The floor's height in the scan's own y-up frame. */
  floorFoundY: number;
  floorBandY: number;
  /** The floor band's middle in the scan's own y-up frame: what stands on the set's origin. */
  floorMiddle: { x: number; z: number } | null;
  scanRadius: number;
  decodeMs: number;
  loads: number;
  /** The set every consumer reads, and whether the stage's own ground still draws. */
  worldModel: string | null;
  groundVisible: boolean;
  previousSetAttached: boolean;
  lastExport: { kept: number; inBox: number; thinned: number; spzBytes: number; maxSpzBytes: number | null; cropMs: number; writeMs: number; box: { min: number[]; max: number[] }; disc: { center: { x: number; z: number }; radius: number }; dome: unknown } | null;
};

export interface CapturePlaceDeps {
  stage: CaptureStage;
  avatar: AvatarRig;
  motor: CharacterMotor;
  objects: CaptureObjects;
  ui: UIStateStore;
  flip: boolean | null;
  /** A take is starting, recording or exporting: the set never changes under one. */
  isTakeBusy: () => boolean;
}

function fileNameOf(source: PlaceSource): string {
  if (source.kind === 'file') return source.file.name;
  try {
    return new URL(source.url, window.location.href).pathname.split('/').pop() || source.url;
  } catch {
    return source.url;
  }
}

async function readBytes(source: PlaceSource): Promise<Uint8Array> {
  if (source.kind === 'file') return new Uint8Array(await source.file.arrayBuffer());
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`the scan could not be fetched (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The splat count a file declares, refused over the cap before anything is decoded. */
async function checkDeclaredSize(bytes: Uint8Array, name: string): Promise<void> {
  const lower = name.toLowerCase();
  if (lower.endsWith('.spz')) {
    await checkSpzBytes(bytes, PLACE_INPUT_SPLAT_CAP);
    return;
  }
  if (lower.endsWith('.ply')) {
    const count = plyVertexCount(bytes);
    if (count === null) throw new Error('the file is not a PLY scan');
    if (count > PLACE_INPUT_SPLAT_CAP) throw new Error(`the scan has ${count.toLocaleString('en')} splats, over the ${PLACE_INPUT_SPLAT_CAP.toLocaleString('en')} a place may have`);
    if (count === 0) throw new Error('the scan has no splats');
    return;
  }
  throw new Error('a place is a .spz or .ply scan');
}

/**
 * Spark's raycast counts the splats a render last updated: none for a mesh
 * that has not drawn (the export's crop and the hidden cast mesh never do,
 * and the checks step without drawing). Given the count alone it casts
 * against every splat of its own packed array. On a LoD mesh it would read
 * the LoD's indices instead (and the renderer rewrites them every frame), so
 * the meshes cast against are made with `enableLod: false` and never drawn.
 */
/** Thinning passes at Stop before the place is written as it is: SPZ size is close to linear in splats. */
const MAX_FIT_PASSES = 4;
/** Each pass aims a little under the bytes left, so one pass usually fits. */
const FIT_SHRINK = 0.95;
/** The upload's cap, shared with the API. */
const GLB_BYTE_BUDGET = MAX_HOLOGRAM_BYTES;

function castsEverySplat(mesh: SplatMesh, numSplats: number): void {
  mesh.raycastIndices = { numSplats, indices: null as unknown as Uint32Array };
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)]!;
}

export class CapturePlace {
  private live: LivePlace | null = null;
  private sparkRenderer: SparkRenderer | null = null;
  private previousSet: THREE.Object3D | undefined;
  private loading = false;
  private loads = 0;
  private lastExport: PlaceCaptureReport['lastExport'] = null;
  private byteBudget = GLB_BYTE_BUDGET;
  private lodBudgetOverride: number | null = null;

  constructor(private readonly deps: CapturePlaceDeps) {}

  get current(): LivePlace | null {
    return this.live;
  }

  /**
   * Brings a scan in. Any failure (unreadable, over the cap, no floor) leaves
   * the set as it was, with one message; a take in progress refuses it.
   */
  async load(source: PlaceSource): Promise<boolean> {
    const { ui } = this.deps;
    const name = fileNameOf(source);
    if (this.loading) return false;
    if (this.deps.isTakeBusy()) {
      ui.flashNotice('Stop recording to change the place.');
      return false;
    }
    this.loading = true;
    const was = ui.getState().place;
    ui.setPlaceState({ ...was, status: 'loading', name, message: null });
    try {
      const bytes = await readBytes(source);
      await checkDeclaredSize(bytes, name);
      const scan = await decodeScan({ bytes, fileName: name, flip: this.deps.flip });
      if (scan.numSplats > PLACE_INPUT_SPLAT_CAP) throw new Error(`the scan has ${scan.numSplats.toLocaleString('en')} splats, over the cap`);
      if (!scan.floor.found) throw new Error('no floor was found in the scan');
      if (this.deps.isTakeBusy()) throw new Error('a take started while the scan was read');
      this.apply(await this.build(name, scan));
      this.loads += 1;
      ui.setPlaceState({ ...ui.getState().place, status: 'ready', name, message: null });
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = `${name} was not used as the place: ${reason}.`;
      console.warn(message, error);
      // The set stays what it was; a scan already in place stays too.
      ui.setPlaceState({ ...ui.getState().place, status: this.live ? 'ready' : 'error', name: this.live?.name ?? name, message });
      ui.flashNotice(message, 8000);
      return false;
    } finally {
      this.loading = false;
    }
  }

  private async build(name: string, scan: DecodedScan): Promise<LivePlace> {
    const S = scan.spark;
    const quaternion = new THREE.Quaternion(scan.flip ? 1 : 0, 0, 0, scan.flip ? 0 : 1);
    const position = new THREE.Vector3(-scan.floor.x, -scan.floor.floorY, -scan.floor.z);
    // Where the scan ends: most of its floor band lies within this of the floor's middle.
    const distances: number[] = [];
    const band: number[] = [];
    for (let i = 0; i < scan.numSplats; i += 1) {
      const y = scan.centers[i * 3 + 1]! - scan.floor.floorY;
      if (Math.abs(y) > FLOOR_BAND_METERS || scan.opacity[i]! < 0.1) continue;
      distances.push(Math.hypot(scan.centers[i * 3]! - scan.floor.x, scan.centers[i * 3 + 2]! - scan.floor.z));
      band.push(y);
    }
    distances.sort((a, b) => a - b);
    const scanRadius = Math.max(1, distances[Math.floor(distances.length * SCAN_EDGE_QUANTILE)] ?? 1);
    const packedSplats = new S.PackedSplats({ packedArray: scan.packedArray, numSplats: scan.numSplats, splatEncoding: scan.encoding });
    // Drawn with Spark's LoD (its per-device budget caps the splats drawn); cast against at full resolution by a
    // second mesh over the same packed splats, hidden so the renderer never draws or re-indexes it.
    // Spark's budgets (desktop 2.5 M, Quest 500 k) only cap a mesh with a LoD tree. A scan under the budget draws
    // whole either way, so the tree is built only above it, and in the background: it can take minutes of worker
    // time for a million splats with SH, and the scan draws whole until Spark finds the tree on the mesh.
    const lod: LivePlace['lod'] = { state: 'none', ms: 0, released: false };
    if (scan.numSplats > this.lodBudget(S)) {
      lod.state = 'building';
      const lodStarted = performance.now();
      packedSplats.createLodSplats().then(
        () => {
          lod.ms = performance.now() - lodStarted;
          lod.state = 'ready';
          if (lod.released) packedSplats.disposeLodSplats();
        },
        (error: unknown) => {
          lod.state = 'failed';
          console.warn('[place] the LoD tree was not built; the scan draws whole', error);
        }
      );
    }
    const mesh = new S.SplatMesh({ packedSplats, raycastable: false });
    const cast = new S.SplatMesh({ packedSplats, raycastable: true, minRaycastOpacity: PLACE_RAYCAST_MIN_OPACITY, enableLod: false });
    await Promise.all([mesh.initialized, cast.initialized]);
    castsEverySplat(cast, scan.numSplats);
    mesh.name = 'PlaceSplats';
    cast.name = 'PlaceSplatsCast';
    cast.visible = false;
    for (const splats of [mesh, cast]) {
      splats.position.copy(position);
      splats.quaternion.copy(quaternion);
    }
    return { name, scan, quaternion, position, mesh: mesh as SplatMesh, cast: cast as SplatMesh, lod, floor: createPlaceFloor(scanRadius), scanRadius, floorBandY: median(band) };
  }

  /** The swap: the disc becomes the set, the scan is drawn, the motor and props rebuild. */
  private apply(next: LivePlace): void {
    const { stage, avatar, motor, objects } = this.deps;
    const old = this.live;
    if (!this.sparkRenderer) {
      const S = next.scan.spark;
      this.sparkRenderer = new S.SparkRenderer({ renderer: stage.renderer, maxStdDev: SPLAT_EXTENT_SIGMA });
      stage.scene.add(this.sparkRenderer as unknown as THREE.Object3D);
    }
    stage.worldGroup.add(next.mesh as unknown as THREE.Object3D, next.cast as unknown as THREE.Object3D);
    const replaced = avatar.replaceWorldModel(next.floor);
    // The first scan replaces the loaded set; a later one replaces the earlier scan's disc.
    if (!old) this.previousSet = replaced;
    stage.ground.visible = false;
    avatar.pointTargets.length = 0;
    avatar.pointTargets.push(next.cast as unknown as THREE.Object3D);
    motor.replaceWorld(avatar);
    objects.resetPhysics();
    if (old) {
      old.lod.released = true;
      for (const splats of [old.mesh, old.cast]) {
        (splats as unknown as THREE.Object3D).removeFromParent();
        splats.dispose();
      }
      old.floor.geometry.dispose();
      (old.floor.material as THREE.Material).dispose();
    }
    this.live = next;
  }

  /**
   * The stored place for the take that just stopped: the scan cropped to the
   * take's reach (Q7), thinned to the cap (Q5), written as SPZ with SH 0.
   * `path` is the avatar root over the take, in the set frame.
   */
  async prepareExport(path: readonly THREE.Vector3[], maxSpzBytes = Number.POSITIVE_INFINITY): Promise<PlaceExportPayload | null> {
    const live = this.live;
    if (!live) return null;
    const S = live.scan.spark;
    let crop = cropScanToTake(live.scan, path, this.deps.avatar.avatarHeight);
    if (crop.numSplats === 0) throw new Error('No part of the place lies within the take\'s reach.');
    const started = performance.now();
    let packed = new S.PackedSplats({ packedArray: crop.packedArray, numSplats: crop.numSplats, splatEncoding: live.scan.encoding });
    let { fileBytes } = await S.writeSpz(packed, { maxSh: 0 });
    // Over the bytes the take leaves, thinned again by distance from the path (from the scan's own splats) until it fits.
    for (let pass = 0; fileBytes.byteLength > maxSpzBytes && pass < MAX_FIT_PASSES; pass += 1) {
      const cap = Math.max(1, Math.floor(crop.numSplats * (maxSpzBytes / fileBytes.byteLength) * FIT_SHRINK));
      crop = cropScanToTake(live.scan, path, this.deps.avatar.avatarHeight, cap);
      packed.dispose();
      packed = new S.PackedSplats({ packedArray: crop.packedArray, numSplats: crop.numSplats, splatEncoding: live.scan.encoding });
      ({ fileBytes } = await S.writeSpz(packed, { maxSh: 0 }));
    }
    const writeMs = performance.now() - started;
    const raycast = new S.SplatMesh({ packedSplats: packed, raycastable: true, minRaycastOpacity: PLACE_RAYCAST_MIN_OPACITY, enableLod: false });
    await raycast.initialized;
    castsEverySplat(raycast, crop.numSplats);
    raycast.position.copy(live.position);
    raycast.quaternion.copy(live.quaternion);
    raycast.updateMatrixWorld(true);
    this.lastExport = {
      kept: crop.numSplats,
      inBox: crop.inBox,
      thinned: crop.thinned,
      spzBytes: fileBytes.byteLength,
      maxSpzBytes: Number.isFinite(maxSpzBytes) ? maxSpzBytes : null,
      cropMs: crop.cropMs,
      writeMs,
      box: { min: crop.box.min.toArray(), max: crop.box.max.toArray() },
      disc: crop.disc,
      dome: crop.dome
    };
    return { crop, spz: fileBytes, maxSh: 0, position: live.position.clone(), quaternion: live.quaternion.clone(), raycast: raycast as SplatMesh, writeMs };
  }

  /** Spark's own per-device draw budget (`SparkRenderer.defaultSplatTarget`), or the automation hook's. */
  private lodBudget(S: DecodedScan['spark']): number {
    if (this.lodBudgetOverride !== null) return this.lodBudgetOverride;
    return S.isOculus() ? 500_000 : S.isVisionPro() ? 750_000 : S.isAndroid() ? 1_000_000 : S.isIos() ? 1_500_000 : 2_500_000;
  }

  /** Automation only: a lower LoD budget for the next load, so a check can draw a small scan through Spark's LoD. */
  setLodBudget(splats: number | null): void {
    this.lodBudgetOverride = splats;
  }

  /** The take's size cap, which the place is thinned to fit at Stop. */
  glbByteBudget(): number {
    return this.byteBudget;
  }

  /** Automation only: a lower cap, so a check can make a take's place thin to fit without a 100 MB take. */
  setGlbByteBudget(bytes: number | null): void {
    this.byteBudget = bytes === null ? GLB_BYTE_BUDGET : Math.min(GLB_BYTE_BUDGET, Math.max(0, bytes));
  }

  report(): PlaceCaptureReport {
    const { ui, avatar, stage } = this.deps;
    const state = ui.getState().place;
    const live = this.live;
    return {
      status: state.status,
      name: state.name,
      message: state.message,
      splatsLoaded: live?.scan.numSplats ?? 0,
      drawnWithLod: live ? Boolean(live.mesh.packedSplats?.lodSplats) && live.mesh.enableLod !== false && !live.mesh.raycastable : false,
      lodState: live?.lod.state ?? 'none',
      lodMs: live?.lod.ms ?? 0,
      lodBudget: live ? this.lodBudget(live.scan.spark) : 0,
      castAtFullResolution: live ? live.cast.enableLod === false && !live.cast.visible && live.cast.raycastIndices?.numSplats === live.scan.numSplats : false,
      flipped: live?.scan.flip ?? false,
      upright: live?.scan.upright ?? '',
      floorFound: live?.scan.floor.found ?? false,
      floorFoundY: live?.scan.floor.floorY ?? Number.NaN,
      floorBandY: live?.floorBandY ?? Number.NaN,
      floorMiddle: live ? { x: live.scan.floor.x, z: live.scan.floor.z } : null,
      scanRadius: live?.scanRadius ?? 0,
      decodeMs: live?.scan.decodeMs ?? 0,
      loads: this.loads,
      worldModel: avatar.worldModel?.name ?? null,
      groundVisible: stage.ground.visible,
      previousSetAttached: Boolean(this.previousSet?.parent),
      lastExport: this.lastExport
    };
  }

  /**
   * What the set's consumers would hit at each (x, z): a cast down through
   * the set (as feet and terrain sampling cast), and a cast through the whole
   * world group less the avatar and the splats, to show no old set is left to
   * answer either.
   */
  probeCasts(points: ReadonlyArray<[number, number]>): Array<{ set: string | null; setY: number | null; world: string[] }> {
    const { avatar, stage } = this.deps;
    const raycaster = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    stage.worldGroup.updateMatrixWorld(true);
    const splats = new Set<unknown>([this.live?.mesh, this.live?.cast]);
    const others = stage.worldGroup.children.filter((child) => child !== avatar.avatarRoot && !splats.has(child));
    return points.map(([x, z]) => {
      raycaster.set(new THREE.Vector3(x, 50, z), down);
      const setHit = avatar.worldModel ? raycaster.intersectObject(avatar.worldModel, true)[0] : undefined;
      const world = raycaster.intersectObjects(others, true).map((hit) => hit.object.name || hit.object.type);
      return { set: setHit ? setHit.object.name : null, setY: setHit ? setHit.point.y : null, world: [...new Set(world)] };
    });
  }

  static readonly FLOOR_NAME = PLACE_FLOOR_NAME;
}
