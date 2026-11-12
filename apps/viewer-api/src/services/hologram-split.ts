import { writeFile } from "node:fs/promises";
import path from "node:path";

import { PLACE_EXTENSION, readStoredPlace, type GlbChunks, type PlaceExtension, type SpzHeader } from "@holoim/contracts";

import { forEachViewReference, GlbFormatError, openGlb, readRange, rewriteGlb, viewRange, type GlbFile, type GltfJson } from "./glb-file.js";

// The upload split (docs/features/hologram-budgets.md, "One upload, split by
// the API"): an upload's `HOLOIM_place` may carry a `detail` level, a second
// SPZ in the same GLB. The API checks both SPZ streams, stores the detail's
// bytes as their own object and stores a light GLB without them. Works on a
// file on disk: the JSON is parsed, the place's two views are the only bytes
// read into memory, and the light GLB is copied range by range.

export class PlaceRefusal extends Error {}

export type SplitUpload =
  /** Not a readable GLB: stored as uploaded, as before (other checks judge such files). */
  | { kind: "opaque" }
  | {
      kind: "glb";
      /** The GLB to store: the upload itself when it had no detail. */
      lightPath: string;
      lightBytes: number;
      detail: { path: string; bytes: number; header: SpzHeader } | null;
      /** Whether the Q4 processing (textures, animation) has anything to do. */
      needsProcessing: boolean;
    };

function placeMessage(error: unknown): string {
  return `The hologram's stored place is malformed: ${error instanceof Error ? error.message : String(error)}.`;
}

function cloneJson(json: GltfJson): GltfJson {
  return JSON.parse(JSON.stringify(json)) as GltfJson;
}

function placeHolder(json: GltfJson): { node: number; extension: Record<string, unknown> } | null {
  const index = (json.nodes ?? []).findIndex((node) => node.extensions?.[PLACE_EXTENSION] !== undefined);
  if (index < 0) return null;
  const extension = json.nodes![index]!.extensions![PLACE_EXTENSION];
  return { node: index, extension: (extension && typeof extension === "object" ? extension : {}) as Record<string, unknown> };
}

/**
 * Checks the place with the contracts' own reader on a GLB that holds only
 * the place's views: the same header, count, SH and decompressed-size checks
 * the viewer runs, with one copy of the SPZ bytes in memory.
 */
async function checkPlace(glb: GlbFile): Promise<{ place: Awaited<ReturnType<typeof readStoredPlace>> }> {
  const json = glb.json;
  const placeViews = new Set<number>();
  for (const node of json.nodes ?? []) {
    const extension = node.extensions?.[PLACE_EXTENSION] as Partial<PlaceExtension> | undefined;
    if (!extension || typeof extension !== "object") continue;
    for (const index of [extension.bufferView, extension.detail?.bufferView]) {
      if (typeof index === "number" && Number.isInteger(index) && json.bufferViews?.[index]) placeViews.add(index);
    }
  }
  const ranges = new Map<number, { offset: number; length: number } | null>();
  let total = 0;
  for (const index of placeViews) {
    try {
      const range = viewRange(glb, index);
      ranges.set(index, range);
      total += Math.ceil(range.length / 4) * 4;
    } catch {
      ranges.set(index, null);
    }
  }
  const bin = Buffer.alloc(total);
  const bufferViews = (json.bufferViews ?? []).map((view) => ({ ...view }));
  let at = 0;
  for (const [index, range] of ranges) {
    const view = bufferViews[index]!;
    if (!range) {
      // Outside the real BIN chunk: keep it outside this one too, so the reader says so.
      view.byteOffset = total + 1;
      continue;
    }
    await readRange(glb, range, bin, at);
    view.byteOffset = at;
    at += Math.ceil(range.length / 4) * 4;
  }
  const chunks: GlbChunks = { json: { ...json, bufferViews } as GlbChunks["json"], bin };
  const place = await readStoredPlace(new Uint8Array(0), chunks);
  return { place };
}

/** Whether `processHologram` would change anything: an embedded PNG/JPEG texture or a reducible animation track. */
export function needsProcessing(json: GltfJson): boolean {
  const images = (json.images ?? []).some((image) => typeof image.bufferView === "number" && (image.mimeType === "image/png" || image.mimeType === "image/jpeg"));
  const animation = (json.animations ?? []).some((clip) =>
    clip.channels.some((channel) => {
      const sampler = clip.samplers[channel.sampler];
      return (
        sampler &&
        (sampler.interpolation ?? "LINEAR") === "LINEAR" &&
        ["translation", "rotation", "scale"].includes(channel.target.path) &&
        (json.accessors?.[sampler.input]?.count ?? 0) > 2
      );
    })
  );
  return images || animation;
}

/** Checks the place and writes the detail SPZ to `workDir`; the in-memory copy is gone when this returns. */
async function checkAndExtractDetail(glb: GlbFile, workDir: string): Promise<{ view: number; path: string; bytes: number; header: SpzHeader } | null> {
  let place: Awaited<ReturnType<typeof checkPlace>>["place"];
  try {
    ({ place } = await checkPlace(glb));
  } catch (error) {
    throw new PlaceRefusal(placeMessage(error));
  }
  if (!place?.detail || !place.extension.detail) return null;
  const detailPath = path.join(workDir, "place-detail.spz");
  await writeFile(detailPath, place.detail.spz);
  return { view: place.extension.detail.bufferView, path: detailPath, bytes: place.detail.spz.byteLength, header: place.detail.header };
}

/**
 * Splits an upload on disk into the light GLB and the detail SPZ (in
 * `workDir`). Throws `PlaceRefusal` with the message the uploader sees when
 * the place (either level) is malformed.
 */
export async function splitUpload(uploadPath: string, workDir: string): Promise<SplitUpload> {
  let glb: GlbFile;
  try {
    glb = await openGlb(uploadPath);
  } catch (error) {
    if (error instanceof GlbFormatError) return { kind: "opaque" };
    throw error;
  }
  try {
    const detail = await checkAndExtractDetail(glb, workDir);
    const processing = needsProcessing(glb.json);
    if (!detail) {
      const uploadBytes = (await glb.handle.stat()).size;
      return { kind: "glb", lightPath: uploadPath, lightBytes: uploadBytes, detail: null, needsProcessing: processing };
    }
    const { view: detailView, ...detailFile } = detail;

    const json = cloneJson(glb.json);
    const holder = placeHolder(json)!;
    delete holder.extension.detail;
    const lightPath = path.join(workDir, "light.glb");
    let lightBytes: number;
    try {
      lightBytes = await rewriteGlb(glb, json, lightPath, { drop: [detailView] });
    } catch (error) {
      throw new PlaceRefusal(placeMessage(new Error(`its detail buffer view is used by more than the place (${error instanceof Error ? error.message : String(error)})`)));
    }
    return { kind: "glb", lightPath, lightBytes, detail: detailFile, needsProcessing: processing };
  } finally {
    await glb.close();
  }
}

/**
 * The Quick Look converter's input (hologram-budgets, Q4): the stored light
 * GLB (PNG/JPEG textures, unquantized animation) without any place, written
 * to `outPath`. Returns the path to convert: `glbPath` itself when there is
 * no place to remove or the file is not a GLB.
 */
export async function quickLookInput(glbPath: string, outPath: string): Promise<string> {
  let glb: GlbFile;
  try {
    glb = await openGlb(glbPath);
  } catch (error) {
    if (error instanceof GlbFormatError) return glbPath;
    throw error;
  }
  try {
    const json = cloneJson(glb.json);
    const placeViews = new Set<number>();
    for (const node of json.nodes ?? []) {
      const extension = node.extensions?.[PLACE_EXTENSION] as Partial<PlaceExtension> | undefined;
      if (extension === undefined) continue;
      for (const index of [extension?.bufferView, extension?.detail?.bufferView]) if (typeof index === "number") placeViews.add(index);
      delete node.extensions![PLACE_EXTENSION];
      if (Object.keys(node.extensions!).length === 0) delete node.extensions;
    }
    if (!json.extensionsUsed?.includes(PLACE_EXTENSION) && placeViews.size === 0) return glbPath;
    for (const key of ["extensionsUsed", "extensionsRequired"] as const) {
      const remaining = json[key]?.filter((name) => name !== PLACE_EXTENSION);
      if (remaining?.length) json[key] = remaining;
      else delete json[key];
    }
    const referenced = new Set<number>();
    forEachViewReference(json, (_holder, _key, index) => referenced.add(index));
    const drop = [...placeViews].filter((index) => !referenced.has(index) && json.bufferViews?.[index]);
    await rewriteGlb(glb, json, outPath, { drop });
    return outPath;
  } finally {
    await glb.close();
  }
}
