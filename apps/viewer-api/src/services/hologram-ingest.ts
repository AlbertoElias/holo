import { createId } from "@paralleldrive/cuid2";

import { MAX_GLB_BYTES, MAX_GLB_MEGABYTES } from "../lib/constants.js";
import { PlaceRefusal, splitUpload } from "./hologram-split.js";
import { UploadValidationError } from "./hologram-storage.js";
import type { MediaStorage } from "./media-storage.js";

// Storing an upload (hologram-budgets, "One upload, split by the API"): the
// upload is a file on disk; the split checks the place and writes the light
// GLB and the detail SPZ beside it; both are put to storage under one id.
// The light GLB is stored as `<id>.glb` and served until the background
// processing (KTX2 textures, reduced animation) publishes `<id>-light.glb`;
// `<id>.glb` stays as the Quick Look source.

export const GLB_CONTENT_TYPE = "model/gltf-binary";
export const SPZ_CONTENT_TYPE = "application/octet-stream";

export function capMessage(): string {
  return `File exceeds ${MAX_GLB_MEGABYTES}MB limit.`;
}

export function placeDetailKeyFor(filenameStored: string): string {
  return filenameStored.replace(/\.glb$/i, "") + "-place.spz";
}

export function textureDetailKeyFor(filenameStored: string): string {
  return filenameStored.replace(/\.glb$/i, "") + "-textures.glb";
}

export function servedKeyFor(filenameStored: string): string {
  return filenameStored.replace(/\.glb$/i, "") + "-light.glb";
}

export type StoredUpload = {
  filenameStored: string;
  sizeBytes: number;
  placeDetailKey: string | null;
  /** "pending" when the processing has work to do, else "none". */
  processStatus: "pending" | "none";
};

/**
 * Splits the upload at `uploadPath` (temporary files go to `workDir`) and
 * puts the light GLB and the detail SPZ to storage. `putUnchanged`, when
 * given, stores the upload itself when the split left it as it was (a
 * server-side copy from the incoming object instead of a re-upload).
 * Throws `UploadValidationError` (413 over the cap, 422 for a malformed place).
 */
export async function storeUpload(
  storage: MediaStorage,
  uploadPath: string,
  uploadBytes: number,
  workDir: string,
  putUnchanged?: (filenameStored: string) => Promise<void>
): Promise<StoredUpload> {
  if (uploadBytes > MAX_GLB_BYTES) throw new UploadValidationError(capMessage(), 413);
  let split: Awaited<ReturnType<typeof splitUpload>>;
  try {
    split = await splitUpload(uploadPath, workDir);
  } catch (error) {
    if (error instanceof PlaceRefusal) throw new UploadValidationError(error.message, 422);
    throw error;
  }
  const filenameStored = `${createId()}.glb`;
  if (split.kind === "opaque" || split.lightPath === uploadPath) {
    if (putUnchanged) await putUnchanged(filenameStored);
    else await storage.putFile(filenameStored, uploadPath, GLB_CONTENT_TYPE);
    return {
      filenameStored,
      sizeBytes: uploadBytes,
      placeDetailKey: null,
      processStatus: split.kind === "glb" && split.needsProcessing ? "pending" : "none"
    };
  }
  let placeDetailKey: string | null = null;
  if (split.detail) {
    placeDetailKey = placeDetailKeyFor(filenameStored);
    await storage.putFile(placeDetailKey, split.detail.path, SPZ_CONTENT_TYPE);
  }
  try {
    await storage.putFile(filenameStored, split.lightPath, GLB_CONTENT_TYPE);
  } catch (error) {
    if (placeDetailKey) await storage.delete(placeDetailKey).catch(() => undefined);
    throw error;
  }
  return { filenameStored, sizeBytes: split.lightBytes, placeDetailKey, processStatus: split.needsProcessing ? "pending" : "none" };
}
