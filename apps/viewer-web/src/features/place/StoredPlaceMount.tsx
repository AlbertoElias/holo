import { useFrame, useThree } from "@react-three/fiber";
import type { ClocheShape } from "@holoim/xr-ui-core";
import { PLACE_DETAIL_SPLAT_CAP, PLACE_STORED_SPLAT_CAP, checkSpzBytes } from "@holoim/contracts";
import { FLOOR_BAND_METERS, SPLAT_EXTENT_SIGMA, domeClipModifier, extentLeavesDome, loadSpark, placeClipFade, type DomeShape } from "@holoim/place";
import { useEffect, useRef, useState } from "react";
import { Vector3 } from "three";
import type { Object3D } from "three";
import type { PackedSplats, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

import { testHooks } from "../../testHooks";
import { placeDrawBudget, thinToBudget } from "./detailBudget";
import type { StoredPlaceRef } from "./storedPlace";

// The take's own stored place (docs/features/splat-capture.md, "The viewer
// reads it"): the SPZ bytes from the GLB's buffer view, header-checked before
// any decode, drawn by Spark under the `RecordedPlace` node at its TRS, which
// the viewer applies as is, and cut by the cloche's dome as slice 1 cuts a
// scan. This module is the card's one door to Spark in production: a lazy
// chunk, loaded only for a take that has `HOLOIM_place`.
//
// The detail level (docs/features/hologram-budgets.md): the GLB carries the
// light place; its detail SPZ is a separate object. Once the light place
// draws and the card is the focused one, the detail is fetched when the page
// is idle, header-checked, thinned to the device's draw budget and swapped in
// under the same node. Losing focus frees it and the light place returns.

/** Draws before the glass, traces and highlights. */
const PLACE_RENDER_ORDER = -100;
/** The shader's dome follows the card's dome by at least this much, metres. */
const CLIP_EPSILON_METERS = 0.001;

export type StoredPlaceReport = {
  status: "loading" | "ready" | "failed";
  error: string | null;
  splatCount: number;
  /** The node's world matrix (column-major) when the splats were placed. */
  nodeWorld: number[];
  /** The plain floor disc the place replaces: hidden once the splats draw. */
  discVisible: boolean;
  /** The disc's world height, and the median height of the stored splats within a few centimetres of it. */
  discY: number;
  floorBandY: number;
  /** The author's lowest foot bone now, world y. */
  feetY: number;
  /** Stored splats the shader shows whose extent leaves the dome where it is now, and how many it shows. */
  outside: number;
  shown: number;
  /** The dome the clip last pushed to the shader. */
  dome: DomeShape | null;
  sorted: boolean;
  decodeMs: number;
  /** The detail level: what was stored, what this device draws of it, and when it swapped in. */
  detail: StoredPlaceDetailReport | null;
};

export type StoredPlaceDetailReport = {
  status: "waiting" | "loading" | "ready" | "failed" | "freed";
  error: string | null;
  storedCount: number;
  shDegree: number;
  drawnCount: number;
  budget: number;
  /** Median height of the detail's splats near the disc, as `floorBandY` is for the light place. */
  floorBandY: number;
  nodeWorld: number[];
  /** Fetch start to swap, milliseconds. */
  loadMs: number;
};

declare global {
  interface Window {
    __HOLOIM_STORED_PLACE__?: StoredPlaceReport;
    /** Test builds: the splats this device draws of a place's detail, in place of Spark's device default. */
    __HOLOIM_PLACE_DRAW_BUDGET__?: number;
  }
}

type Built = { spark: SparkRenderer; mesh: SplatMesh; centers: Float32Array; scale: Float32Array; node: Object3D; discY: number; disposed: boolean };
/** The dome clip's base uniforms, one per drawn level, and the dome they were last set to. */
type Clip = { bases: Vector3[]; applied: DomeShape };

function floorBand(centers: Float32Array, count: number, discY: number): number {
  const band: number[] = [];
  for (let i = 0; i < count; i += 1) if (Math.abs(centers[i * 3 + 1]! - discY) < FLOOR_BAND_METERS) band.push(centers[i * 3 + 1]!);
  band.sort((a, b) => a - b);
  return band.length > 0 ? band[Math.floor(band.length / 2)]! : Number.NaN;
}

function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run, { timeout: 2000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 200);
  return () => window.clearTimeout(handle);
}

export default function StoredPlaceMount({ place, readBytes, detailUrl = null, detailWanted = false, scene, shape, shift, readFeetY, onShown, onFailed }: {
  place: StoredPlaceRef;
  /** The detail level's SPZ (the DTO's `placeDetailUrl`), null for a take without one. */
  detailUrl?: string | null;
  /** The card is the focused one: only then is the detail fetched and kept. */
  detailWanted?: boolean;
  /** The buffer view's bytes, from the loader's own parse of the GLB. */
  readBytes: () => Promise<ArrayBuffer>;
  /** The take as the card draws it: the `RecordedPlace` node and the disc are in it. */
  scene: Object3D;
  /** The fitted dome, null until the card has fitted it. */
  shape: ClocheShape | null;
  shift: Vector3;
  readFeetY: () => number;
  onShown: () => void;
  onFailed: (error: unknown) => void;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [built, setBuilt] = useState<Built | null>(null);
  const clip = useRef<Clip | null>(null);
  const detailMesh = useRef<SplatMesh | null>(null);
  const report = useRef<StoredPlaceReport | null>(null);

  useEffect(() => {
    if (!shape) return undefined;
    let live = true;
    let made: Built | null = null;
    const started = performance.now();
    const node = scene.getObjectByName(place.nodeName);
    const disc = scene.getObjectByName("RecordedSceneBubble");
    const state: StoredPlaceReport = {
      status: "loading", error: null, splatCount: 0, nodeWorld: [], discVisible: disc?.visible ?? false, discY: Number.NaN, floorBandY: Number.NaN,
      feetY: Number.NaN, outside: 0, shown: 0, dome: null, sorted: false, decodeMs: 0, detail: null
    };
    report.current = state;
    if (testHooks) window.__HOLOIM_STORED_PLACE__ = state;
    const fail = (error: unknown) => {
      if (!live) return;
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      onFailed(error);
    };
    (async () => {
      if (!node) throw new Error(`no ${place.nodeName} node in the take`);
      const spz = new Uint8Array(await readBytes());
      // A gzip bomb or a lying count is refused here, before Spark allocates anything for it.
      const header = await checkSpzBytes(spz, PLACE_STORED_SPLAT_CAP);
      if (header.numPoints !== place.extension.splatCount) throw new Error(`the SPZ header says ${header.numPoints} splats, the extension ${place.extension.splatCount}`);
      if (header.shDegree !== place.extension.maxSh) throw new Error(`the SPZ header's SH degree is ${header.shDegree}, the extension's ${place.extension.maxSh}`);
      const S = await loadSpark();
      if (!live) return;
      const packedSplats = new S.PackedSplats({ fileBytes: spz, fileType: S.SplatFileType.SPZ });
      await packedSplats.initialized;
      if (!live) return;
      scene.updateWorldMatrix(true, true);
      const world = node.matrixWorld;
      const count = packedSplats.numSplats;
      const centers = new Float32Array(count * 3);
      const scale = new Float32Array(count);
      const at = new Vector3();
      packedSplats.forEachSplat((index, center, scales) => {
        at.copy(center).applyMatrix4(world);
        centers[index * 3] = at.x;
        centers[index * 3 + 1] = at.y;
        centers[index * 3 + 2] = at.z;
        scale[index] = Math.max(scales.x, scales.y, scales.z);
      });
      const base = new Vector3(shape.base.x, shape.base.y, shape.base.z).add(shift);
      const { modifier, base: dynoBase } = domeClipModifier(S, { base, radii: shape.radii, exponent: shape.exponent });
      const applied: DomeShape = { base: { x: base.x, y: base.y, z: base.z }, radii: { ...shape.radii }, exponent: shape.exponent };
      clip.current = { bases: [dynoBase.value], applied };
      const mesh = new S.SplatMesh({ packedSplats, worldModifier: modifier });
      mesh.name = "RecordedPlaceSplats";
      const spark = new S.SparkRenderer({ renderer: gl, maxStdDev: SPLAT_EXTENT_SIGMA, enableLod: false, onDirty: () => invalidate() });
      spark.renderOrder = PLACE_RENDER_ORDER;
      // Splat colours are display-ready; Spark's shader takes no tone mapping (slice 1).
      spark.material.toneMapped = false;
      node.add(mesh as unknown as Object3D);
      const discY = disc ? (disc.getObjectByName("RecordedPlaceFloor") ?? disc).getWorldPosition(new Vector3()).y : 0;
      made = { spark, mesh, centers, scale, node, discY, disposed: false };
      state.splatCount = count;
      state.nodeWorld = world.toArray();
      state.discY = discY;
      state.floorBandY = floorBand(centers, count, discY);
      state.dome = applied;
      state.decodeMs = performance.now() - started;
      state.status = "ready";
      setBuilt(made);
      onShown();
      state.discVisible = disc?.visible ?? false;
      invalidate();
    })().catch(fail);
    return () => {
      live = false;
      if (made) {
        made.disposed = true;
        (made.mesh as unknown as Object3D).removeFromParent();
        made.mesh.dispose();
        made.spark.dispose();
      }
      setBuilt(null);
      clip.current = null;
      if (testHooks && window.__HOLOIM_STORED_PLACE__ === state) delete window.__HOLOIM_STORED_PLACE__;
    };
    // Placed once, against the dome as it was fitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, scene, gl, shape === null]);

  useFrame(() => {
    const state = clip.current;
    const current = built;
    if (!state || !current || !shape) return;
    if (testHooks && report.current) {
      const now = report.current;
      now.feetY = readFeetY();
      now.sorted = current.spark.orderingTexture !== null && !current.spark.sorting && !current.spark.sortDirty;
    }
    const x = shape.base.x + shift.x;
    const y = shape.base.y + shift.y;
    const z = shape.base.z + shift.z;
    const first = state.bases[0]!;
    if (Math.hypot(x - first.x, y - first.y, z - first.z) < CLIP_EPSILON_METERS) return;
    for (const base of state.bases) base.set(x, y, z);
    state.applied = { base: { x, y, z }, radii: state.applied.radii, exponent: state.applied.exponent };
    if (report.current) report.current.dome = state.applied;
    current.mesh.updateVersion();
    detailMesh.current?.updateVersion();
    invalidate();
  });

  // The detail level, for the focused card only, after the light place draws.
  useEffect(() => {
    if (!built || !detailUrl || !detailWanted) return undefined;
    const now = report.current;
    if (!now) return undefined;
    let live = true;
    let packed: PackedSplats | null = null;
    let mesh: SplatMesh | null = null;
    let base: Vector3 | null = null;
    const abort = new AbortController();
    const detail: StoredPlaceDetailReport = {
      status: "waiting", error: null, storedCount: 0, shDegree: 0, drawnCount: 0, budget: 0, floorBandY: Number.NaN, nodeWorld: [], loadMs: 0
    };
    now.detail = detail;
    const cancelIdle = whenIdle(() => {
      const started = performance.now();
      detail.status = "loading";
      (async () => {
        const response = await fetch(detailUrl, { signal: abort.signal });
        if (!response.ok) throw new Error(`the detail place answered ${response.status}`);
        const spz = new Uint8Array(await response.arrayBuffer());
        if (!live) return;
        // The same refusal as the light place's, under the detail's own cap.
        const header = await checkSpzBytes(spz, PLACE_DETAIL_SPLAT_CAP);
        const S = await loadSpark();
        if (!live) return;
        const decoded = new S.PackedSplats({ fileBytes: spz, fileType: S.SplatFileType.SPZ });
        packed = decoded;
        await decoded.initialized;
        if (!live) return;
        const budget = (testHooks ? window.__HOLOIM_PLACE_DRAW_BUDGET__ : undefined) ?? placeDrawBudget(S);
        const drawn = thinToBudget(S, decoded, budget);
        packed = drawn;
        const state = clip.current;
        if (!state) return;
        const { modifier, base: dynoBase } = domeClipModifier(S, {
          base: new Vector3(state.applied.base.x, state.applied.base.y, state.applied.base.z),
          radii: state.applied.radii,
          exponent: state.applied.exponent
        });
        base = dynoBase.value;
        state.bases.push(base);
        mesh = new S.SplatMesh({ packedSplats: drawn, worldModifier: modifier });
        mesh.name = "RecordedPlaceDetailSplats";
        built.node.updateWorldMatrix(true, false);
        const world = built.node.matrixWorld;
        const count = drawn.numSplats;
        const centers = new Float32Array(count * 3);
        const at = new Vector3();
        drawn.forEachSplat((index, center) => {
          at.copy(center).applyMatrix4(world);
          centers[index * 3] = at.x;
          centers[index * 3 + 1] = at.y;
          centers[index * 3 + 2] = at.z;
        });
        // The swap: same node, same TRS; the light mesh steps aside until focus leaves.
        built.node.add(mesh as unknown as Object3D);
        (built.mesh as unknown as Object3D).removeFromParent();
        detailMesh.current = mesh;
        detail.storedCount = header.numPoints;
        detail.shDegree = header.shDegree;
        detail.drawnCount = count;
        detail.budget = budget;
        detail.floorBandY = floorBand(centers, count, built.discY);
        detail.nodeWorld = world.toArray();
        detail.loadMs = performance.now() - started;
        detail.status = "ready";
        invalidate();
      })().catch((error: unknown) => {
        if (!live) return;
        detail.status = "failed";
        detail.error = error instanceof Error ? error.message : String(error);
        console.warn("The hologram's detail place did not load; the light place stays.", error);
      });
    });
    return () => {
      live = false;
      cancelIdle();
      abort.abort();
      if (mesh) {
        (mesh as unknown as Object3D).removeFromParent();
        mesh.dispose();
        if (!built.disposed) built.node.add(built.mesh as unknown as Object3D);
      }
      packed?.dispose();
      if (base && clip.current) clip.current.bases = clip.current.bases.filter((value) => value !== base);
      if (detailMesh.current === mesh) detailMesh.current = null;
      detail.status = "freed";
      invalidate();
    };
  }, [built, detailUrl, detailWanted, invalidate]);

  // The clip proof, on demand (it walks every stored splat): `window.__HOLOIM_STORED_PLACE_OUTSIDE__()`.
  useEffect(() => {
    if (!testHooks || !built) return undefined;
    const probe = () => {
      const dome = clip.current?.applied;
      if (!dome) return { outside: 0, shown: 0 };
      let shown = 0;
      let outside = 0;
      const point = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < built.scale.length; i += 1) {
        point.x = built.centers[i * 3]!;
        point.y = built.centers[i * 3 + 1]!;
        point.z = built.centers[i * 3 + 2]!;
        if (placeClipFade(dome, point, built.scale[i]!) <= 0.001) continue;
        shown += 1;
        if (extentLeavesDome(dome, point, built.scale[i]!)) outside += 1;
      }
      if (report.current) {
        report.current.outside = outside;
        report.current.shown = shown;
      }
      return { outside, shown };
    };
    (window as unknown as { __HOLOIM_STORED_PLACE_OUTSIDE__?: typeof probe }).__HOLOIM_STORED_PLACE_OUTSIDE__ = probe;
    return () => {
      delete (window as unknown as { __HOLOIM_STORED_PLACE_OUTSIDE__?: typeof probe }).__HOLOIM_STORED_PLACE_OUTSIDE__;
    };
  }, [built]);

  return built ? <primitive object={built.spark as unknown as Object3D} /> : null;
}
