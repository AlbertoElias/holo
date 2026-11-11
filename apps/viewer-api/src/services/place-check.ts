import { readGlbChunks, readStoredPlace } from "@holoim/contracts";

/**
 * Why a GLB's stored place (`HOLOIM_place`, docs/features/splat-capture.md)
 * is refused, or null when it has none or a sound one: one node, an optional
 * extension, bytes inside the binary chunk, and an SPZ header that matches
 * the extension and a stream that stays within it. Validation only: the place
 * is stored and served inside the GLB, as ever. A file that is not a readable
 * GLB is left to the checks that already judge that.
 */
export async function storedPlaceProblem(bytes: Uint8Array): Promise<string | null> {
  let chunks: ReturnType<typeof readGlbChunks>;
  try {
    chunks = readGlbChunks(bytes);
  } catch {
    return null;
  }
  try {
    await readStoredPlace(bytes, chunks);
    return null;
  } catch (error) {
    return `The hologram's stored place is malformed: ${error instanceof Error ? error.message : String(error)}.`;
  }
}
