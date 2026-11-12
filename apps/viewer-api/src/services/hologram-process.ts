import { open, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { reduceAnimations, type AnimationReport } from "./animation-reduce.js";
import { forEachViewReference, openGlb, readView, rewriteGlb, writeGlb, type GltfJson, type ViewSource } from "./glb-file.js";
import { encodeKtx2, fitWithin, imageSize, KTX2_MIME, type ImageSize, type TextureRole } from "./ktx2.js";

// Q4 processing of a stored light GLB (docs/features/hologram-budgets.md):
// textures to KTX2, those over 1024 px downscaled to 1024 with their full
// size kept in a separate textures GLB, and the recorded animation reduced
// and quantized. Targeted JSON/BIN surgery: nodes keep their order and every
// HOLOIM_* extension (and KHR_audio) keeps its JSON and its bytes, with
// buffer view indices renumbered. Runs in the background worker: the encoder
// takes tens of seconds on a 4096 px texture.

export const SERVED_TEXTURE_MAX_SIDE = 1024;
/**
 * Resource caps. toktx peaked at ~1.1 GB on one 4096 x 4096 texture, so a
 * larger image would not fit the 2 GB machine: such an image keeps its
 * original PNG/JPEG. The per-GLB budget bounds the encode time (~30 s per
 * 4096 px image); images past it also keep their originals.
 */
export const MAX_TEXTURE_PIXELS = 4096 * 4096;
export const MAX_GLB_TEXTURE_PIXELS = 4 * MAX_TEXTURE_PIXELS;
/** One toktx run's wall limit; a run past it fails the job, which the worker retries then marks failed. */
export const TOKTX_TIMEOUT_MS = 5 * 60_000;
const BASISU = "KHR_texture_basisu";

export type TextureReport = {
  image: number;
  role: TextureRole;
  source: ImageSize & { bytes: number; mimeType: string };
  light: ImageSize & { bytes: number };
  /** Present when the image was downscaled: the full-size KTX2 in the textures GLB. */
  full?: ImageSize & { bytes: number };
  ms: number;
};

export type SkippedTexture = { image: number; reason: "too-large" | "glb-budget" | "unreadable"; width?: number; height?: number };

export type ProcessReport = {
  sourceBytes: number;
  lightBytes: number;
  texturesBytes: number;
  textures: TextureReport[];
  /** Images kept as uploaded (PNG/JPEG), and why. */
  skippedTextures: SkippedTexture[];
  animation: AnimationReport;
  ms: { textures: number; animation: number; write: number; total: number };
};

export type ProcessResult = {
  lightPath: string;
  /** The full-size textures GLB, written only when a texture was downscaled. */
  texturesPath: string | null;
  report: ProcessReport;
};

function cloneJson(json: GltfJson): GltfJson {
  return JSON.parse(JSON.stringify(json)) as GltfJson;
}

function textureIndex(slot: unknown): number | null {
  const index = (slot as { index?: unknown } | undefined)?.index;
  return typeof index === "number" && Number.isInteger(index) ? index : null;
}

/** How each texture is sampled: normals keep directions, metal/roughness/occlusion are linear data, the rest is color. */
function textureRoles(json: GltfJson): Map<number, TextureRole> {
  const roles = new Map<number, TextureRole>();
  const set = (index: number | null, role: TextureRole) => {
    if (index === null) return;
    const current = roles.get(index);
    if (current === "normal") return;
    if (role === "normal" || current === undefined || (current === "data" && role === "color")) roles.set(index, role);
  };
  const visit = (value: unknown, key: string | null): void => {
    if (Array.isArray(value)) return value.forEach((item) => visit(item, null));
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (key && /texture$/i.test(key) && typeof record.index === "number") {
      const role: TextureRole = /normal/i.test(key) ? "normal" : /(metallicroughness|occlusion|roughness|thickness|transmission|clearcoat(?!normal)|iridescence(?!.*color))/i.test(key) ? "data" : "color";
      set(textureIndex(record), role);
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  for (const material of json.materials ?? []) visit(material, null);
  return roles;
}

function extensionList(list: string[] | undefined, name: string): string[] {
  return list?.includes(name) ? list : [...(list ?? []), name];
}

/**
 * Processes the GLB at `sourcePath` into `workDir`: `light.glb` (served) and,
 * when a texture was over 1024 px, `textures.glb` (the full-size KTX2s, one
 * texture entry per light-GLB texture, same order; an entry without the
 * extension means "use the light texture").
 */
export async function processHologram(sourcePath: string, workDir: string): Promise<ProcessResult> {
  const started = performance.now();
  const glb = await openGlb(sourcePath);
  const handles: FileHandle[] = [];
  try {
    const json = cloneJson(glb.json);
    const replace = new Map<number, ViewSource>();
    const orphanCandidates = new Set<number>();
    const reports: TextureReport[] = [];
    const skipped: SkippedTexture[] = [];
    let budget = MAX_GLB_TEXTURE_PIXELS;
    const fullImages: Array<{ texture: number; source: ViewSource; bytes: number }> = [];
    const pushView = (source: ViewSource, bytes: number): number => {
      json.bufferViews ??= [];
      const index = json.bufferViews.push({ buffer: 0, byteLength: bytes }) - 1;
      replace.set(index, source);
      return index;
    };
    const openFile = async (filePath: string): Promise<{ source: ViewSource; bytes: number }> => {
      const handle = await open(filePath, "r");
      handles.push(handle);
      const bytes = (await handle.stat()).size;
      return { source: { file: handle, offset: 0, length: bytes }, bytes };
    };

    // ---- textures ----
    const texturesStarted = performance.now();
    const roles = textureRoles(json);
    const imageRole = new Map<number, TextureRole>();
    (json.textures ?? []).forEach((texture, index) => {
      if (typeof texture.source !== "number") return;
      const role = roles.get(index) ?? "color";
      const current = imageRole.get(texture.source);
      imageRole.set(texture.source, current === "normal" || role === "normal" ? "normal" : current === "color" || role === "color" ? "color" : "data");
    });
    const converted = new Map<number, { downscaled: boolean; fullImage?: number }>();
    for (const [imageIndex, role] of imageRole) {
      const image = json.images?.[imageIndex];
      if (!image || typeof image.bufferView !== "number" || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")) continue;
      const imageStarted = performance.now();
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      const inputPath = path.join(workDir, `image-${imageIndex}.${ext}`);
      let size: ImageSize;
      let sourceBytes: number;
      {
        // One image's bytes in memory at a time, released before the encoder
        // runs; the header's size is checked before anything is written.
        const bytes = await readView(glb, image.bufferView);
        const read = imageSize(bytes);
        if (!read || !(read.width > 0 && read.height > 0)) {
          skipped.push({ image: imageIndex, reason: "unreadable" });
          continue;
        }
        const pixels = read.width * read.height;
        if (pixels > MAX_TEXTURE_PIXELS) {
          skipped.push({ image: imageIndex, reason: "too-large", ...read });
          continue;
        }
        if (pixels > budget) {
          skipped.push({ image: imageIndex, reason: "glb-budget", ...read });
          continue;
        }
        budget -= pixels;
        size = read;
        sourceBytes = bytes.byteLength;
        await writeFile(inputPath, bytes);
      }
      const served = fitWithin(size, SERVED_TEXTURE_MAX_SIDE);
      const downscaled = served.width !== size.width || served.height !== size.height;
      const lightPath = path.join(workDir, `image-${imageIndex}-light.ktx2`);
      await encodeKtx2(inputPath, lightPath, { role, timeoutMs: TOKTX_TIMEOUT_MS, ...(downscaled ? { resize: served } : {}) });
      const light = await openFile(lightPath);
      orphanCandidates.add(image.bufferView);
      image.bufferView = pushView(light.source, light.bytes);
      image.mimeType = KTX2_MIME;
      const report: TextureReport = {
        image: imageIndex,
        role,
        source: { ...size, bytes: sourceBytes, mimeType: ext === "png" ? "image/png" : "image/jpeg" },
        light: { ...served, bytes: light.bytes },
        ms: 0
      };
      if (downscaled) {
        const fullPath = path.join(workDir, `image-${imageIndex}-full.ktx2`);
        await encodeKtx2(inputPath, fullPath, { role, timeoutMs: TOKTX_TIMEOUT_MS });
        const full = await openFile(fullPath);
        fullImages.push({ texture: imageIndex, ...full });
        report.full = { ...size, bytes: full.bytes };
      }
      converted.set(imageIndex, { downscaled });
      report.ms = Math.round(performance.now() - imageStarted);
      reports.push(report);
    }
    let usesBasisu = false;
    for (const texture of json.textures ?? []) {
      if (typeof texture.source !== "number" || !converted.has(texture.source)) continue;
      texture.extensions = { ...(texture.extensions ?? {}), [BASISU]: { source: texture.source } };
      delete texture.source;
      usesBasisu = true;
    }
    if (usesBasisu) {
      json.extensionsUsed = extensionList(json.extensionsUsed, BASISU);
      json.extensionsRequired = extensionList(json.extensionsRequired, BASISU);
    }
    const texturesMs = performance.now() - texturesStarted;

    // ---- animation ----
    const animationStarted = performance.now();
    const { orphaned, report: animation } = await reduceAnimations(glb, json, replace);
    for (const index of orphaned) orphanCandidates.add(index);
    const animationMs = performance.now() - animationStarted;

    // ---- write ----
    const writeStarted = performance.now();
    const referenced = new Set<number>();
    forEachViewReference(json, (_holder, _key, index) => referenced.add(index));
    const drop = [...orphanCandidates].filter((index) => !referenced.has(index));
    const lightPath = path.join(workDir, "light.glb");
    const lightBytes = await rewriteGlb(glb, json, lightPath, { drop, replace });

    let texturesPath: string | null = null;
    let texturesBytes = 0;
    if (fullImages.length > 0) {
      texturesPath = path.join(workDir, "textures.glb");
      texturesBytes = await writeTexturesGlb(texturesPath, glb.json, fullImages);
    }
    const writeMs = performance.now() - writeStarted;
    return {
      lightPath,
      texturesPath,
      report: {
        sourceBytes: (await stat(sourcePath)).size,
        lightBytes,
        texturesBytes,
        textures: reports,
        skippedTextures: skipped,
        animation,
        ms: {
          textures: Math.round(texturesMs),
          animation: Math.round(animationMs),
          write: Math.round(writeMs),
          total: Math.round(performance.now() - started)
        }
      }
    };
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
    await glb.close();
  }
}

/**
 * The textures GLB: no scene, a `textures` array as long as the light GLB's
 * (same order), and for each texture whose image was downscaled a
 * KHR_texture_basisu source holding the full-size KTX2. Other entries are
 * empty objects.
 */
async function writeTexturesGlb(
  outPath: string,
  original: GltfJson,
  fullImages: Array<{ texture: number; source: ViewSource; bytes: number }>
): Promise<number> {
  const imageToFull = new Map<number, number>();
  const images: NonNullable<GltfJson["images"]> = [];
  const bufferViews: NonNullable<GltfJson["bufferViews"]> = [];
  const views: ViewSource[] = [];
  for (const full of fullImages) {
    imageToFull.set(full.texture, images.length);
    bufferViews.push({ buffer: 0, byteLength: full.bytes });
    images.push({ bufferView: bufferViews.length - 1, mimeType: KTX2_MIME });
    views.push(full.source);
  }
  const textures = (original.textures ?? []).map((texture) => {
    const fullImage = typeof texture.source === "number" ? imageToFull.get(texture.source) : undefined;
    if (fullImage === undefined) return {};
    return { ...(typeof texture.sampler === "number" ? { sampler: texture.sampler } : {}), extensions: { [BASISU]: { source: fullImage } } };
  });
  const json: GltfJson = {
    asset: { version: "2.0", generator: "HoloIM viewer-api texture detail" },
    extensionsUsed: [BASISU],
    extensionsRequired: [BASISU],
    buffers: [{ byteLength: 0 }],
    bufferViews,
    images,
    ...(original.samplers ? { samplers: original.samplers } : {}),
    textures
  };
  return writeGlb(outPath, json, views);
}

