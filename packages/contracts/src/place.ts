// The stored place of a take (docs/features/splat-capture.md, Q4): a
// `RecordedPlace` node whose `HOLOIM_place` extension points at SPZ bytes in
// a buffer view of the same GLB. The node's TRS turns the scan's own frame
// into the take's set frame; a reader applies it as is and never reads the
// floor again. Optional: never in `extensionsRequired`, so an older reader
// plays the take on its floor disc.
//
// Everything here is plain TS with no three and no Spark, so the API checks
// an upload with the same code the viewer runs before it decodes a scan.

export const PLACE_EXTENSION = "HOLOIM_place";
export const PLACE_NODE_NAME = "RecordedPlace";
export const PLACE_EXTENSION_VERSION = 1;
/** Splats a stored place may hold (Q5). */
export const PLACE_STORED_SPLAT_CAP = 200_000;
/** Splats a scan brought into capture may hold, decoded (Q5). */
export const PLACE_INPUT_SPLAT_CAP = 3_000_000;
/** The highest spherical-harmonics degree a stored place carries (Q5). */
export const PLACE_STORED_MAX_SH = 1;

export type PlaceRelation = "set" | "site";

export type PlaceExtension = {
  version: 1;
  bufferView: number;
  splatCount: number;
  maxSh: number;
  provenance: { kind: "reconstruction"; relation: PlaceRelation; app?: string; scannedAt?: string };
};

const SPZ_MAGIC = 0x5053474e; // "NGSP", little-endian
const SPZ_HEADER_BYTES = 16;
/** Bytes an SPZ stream may hold past what its splats need: room for v3 extensions, never a bomb. */
const SPZ_SLACK_BYTES = 1 << 20;
/** Spherical-harmonics coefficients per colour channel past the first, by degree. */
const SH_COEFFICIENTS = [0, 3, 8, 15] as const;

export type SpzHeader = { version: number; numPoints: number; shDegree: number; fractionalBits: number; flags: number };

/** The SPZ versions a reader decodes: 1 (16-bit float positions), 2 (24-bit fixed point) and 3 (a 4-byte rotation). */
export const SPZ_VERSIONS = [1, 2, 3] as const;

/**
 * The bytes a valid SPZ of this header decompresses to, its splats' own arrays
 * after the header: positions (6 bytes in v1, 9 after), alpha, colour, scale,
 * rotation (3 bytes, 4 in v3) and the SH.
 */
export function spzDecodedBytes(header: Pick<SpzHeader, "version" | "numPoints" | "shDegree">): number {
  const coefficients = SH_COEFFICIENTS[header.shDegree as 0 | 1 | 2 | 3] ?? 15;
  const position = header.version === 1 ? 6 : 9;
  const rotation = header.version >= 3 ? 4 : 3;
  return SPZ_HEADER_BYTES + header.numPoints * (position + 1 + 3 + 3 + rotation + coefficients * 3);
}

/** The most a valid SPZ of this header decompresses to: its splats and room for extensions (v3) or trailing bytes. */
export function spzMaxDecodedBytes(header: Pick<SpzHeader, "version" | "numPoints" | "shDegree">): number {
  return spzDecodedBytes(header) + SPZ_SLACK_BYTES;
}

function parseHeader(bytes: Uint8Array): SpzHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SPZ_MAGIC) throw new Error("not an SPZ stream (bad magic)");
  return {
    version: view.getUint32(4, true),
    numPoints: view.getUint32(8, true),
    shDegree: view.getUint8(12),
    fractionalBits: view.getUint8(13),
    flags: view.getUint8(14)
  };
}

/**
 * Reads an SPZ file's header and proves its whole stream decompresses within
 * what that header allows, stopping at the limit: a gzip bomb, a truncated
 * stream or a header that lies about its count is refused before any decoder
 * allocates for it. `maxPoints` caps the header's own count.
 */
export async function checkSpzBytes(bytes: Uint8Array, maxPoints: number): Promise<SpzHeader> {
  if (bytes.byteLength < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error("not a gzip-compressed SPZ file");
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const head = new Uint8Array(SPZ_HEADER_BYTES);
  let total = 0;
  let header: SpzHeader | null = null;
  let limit = Number.POSITIVE_INFINITY;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total < SPZ_HEADER_BYTES) head.set(value.subarray(0, SPZ_HEADER_BYTES - total), total);
      total += value.byteLength;
      if (!header && total >= SPZ_HEADER_BYTES) {
        header = parseHeader(head);
        if (!(SPZ_VERSIONS as readonly number[]).includes(header.version)) throw new Error(`the SPZ's version ${header.version} is not one this reader decodes`);
        if (header.numPoints === 0) throw new Error("the SPZ holds no splats");
        if (header.numPoints > maxPoints) throw new Error(`the SPZ holds ${header.numPoints} splats, over the cap of ${maxPoints}`);
        if (header.shDegree > 3) throw new Error(`the SPZ's SH degree ${header.shDegree} is not one SPZ defines`);
        limit = spzMaxDecodedBytes(header);
      }
      if (total > limit) throw new Error("the SPZ decompresses past what its header allows");
    }
  } catch (error) {
    // Not awaited: a stream cancelled mid-inflate may never settle its cancel (Chromium), and the answer is already known.
    void reader.cancel().catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (!header) throw new Error("the SPZ stream ends inside its header");
  // Every array the header's version and SH degree name, whole: a shorter stream would leave the decoder reading past it.
  if (total < spzDecodedBytes(header)) throw new Error("the SPZ stream is shorter than its header's splats");
  return header;
}

type GlbJson = {
  nodes?: Array<{ name?: string; extensions?: Record<string, unknown> }>;
  bufferViews?: Array<{ buffer?: number; byteOffset?: number; byteLength?: number }>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
};

export type GlbChunks = { json: GlbJson; bin: Uint8Array | null };

/** The JSON and BIN chunks of a GLB, or an error naming what is wrong. */
export function readGlbChunks(glb: Uint8Array): GlbChunks {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const declared = view.getUint32(8, true);
  if (declared > glb.byteLength) throw new Error("the GLB is shorter than it declares");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > declared) throw new Error("the GLB's first chunk is not its JSON");
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as GlbJson;
  let bin: Uint8Array | null = null;
  const binAt = 20 + jsonLength;
  if (binAt + 8 <= declared) {
    const binLength = view.getUint32(binAt, true);
    if (view.getUint32(binAt + 4, true) === 0x004e4942 && binAt + 8 + binLength <= declared) bin = glb.subarray(binAt + 8, binAt + 8 + binLength);
  }
  return { json, bin };
}

export type StoredPlace = { nodeIndex: number; extension: PlaceExtension; spz: Uint8Array; header: SpzHeader };

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** The extension's JSON as written, or an error naming the field that is wrong. */
export function parsePlaceExtension(value: unknown): PlaceExtension {
  if (!value || typeof value !== "object") throw new Error(`${PLACE_EXTENSION} is not an object`);
  const ext = value as Record<string, unknown>;
  if (ext.version !== PLACE_EXTENSION_VERSION) throw new Error(`${PLACE_EXTENSION} version ${String(ext.version)} is not ${PLACE_EXTENSION_VERSION}`);
  if (!isInteger(ext.bufferView, 0, Number.MAX_SAFE_INTEGER)) throw new Error(`${PLACE_EXTENSION}.bufferView is not an index`);
  if (!isInteger(ext.splatCount, 1, PLACE_STORED_SPLAT_CAP)) throw new Error(`${PLACE_EXTENSION}.splatCount is not between 1 and ${PLACE_STORED_SPLAT_CAP}`);
  if (!isInteger(ext.maxSh, 0, PLACE_STORED_MAX_SH)) throw new Error(`${PLACE_EXTENSION}.maxSh is not between 0 and ${PLACE_STORED_MAX_SH}`);
  const provenance = ext.provenance as Record<string, unknown> | undefined;
  if (!provenance || provenance.kind !== "reconstruction" || (provenance.relation !== "set" && provenance.relation !== "site")) {
    throw new Error(`${PLACE_EXTENSION}.provenance is not a reconstruction used as a set or a site`);
  }
  return value as PlaceExtension;
}

/**
 * The GLB's stored place, checked: one `RecordedPlace` node at most, an
 * optional extension, a buffer view inside the BIN chunk, and SPZ bytes whose
 * header matches the extension and whose stream stays within it. Null for a
 * GLB without a place; throws for a malformed one.
 */
export async function readStoredPlace(glb: Uint8Array, chunks: GlbChunks = readGlbChunks(glb)): Promise<StoredPlace | null> {
  const { json, bin } = chunks;
  const holders = (json.nodes ?? []).flatMap((node, index) => (node.extensions?.[PLACE_EXTENSION] === undefined ? [] : [index]));
  if (holders.length === 0) {
    if (json.extensionsRequired?.includes(PLACE_EXTENSION)) throw new Error(`${PLACE_EXTENSION} is required but no node carries it`);
    return null;
  }
  if (holders.length > 1) throw new Error(`${holders.length} nodes carry ${PLACE_EXTENSION}; a take has one place`);
  if (json.extensionsRequired?.includes(PLACE_EXTENSION)) throw new Error(`${PLACE_EXTENSION} must be optional, never required`);
  if (!json.extensionsUsed?.includes(PLACE_EXTENSION)) throw new Error(`${PLACE_EXTENSION} is not listed in extensionsUsed`);
  const nodeIndex = holders[0]!;
  const extension = parsePlaceExtension(json.nodes![nodeIndex]!.extensions![PLACE_EXTENSION]);
  const bufferView = json.bufferViews?.[extension.bufferView];
  if (!bufferView || (bufferView.buffer ?? 0) !== 0) throw new Error(`${PLACE_EXTENSION}.bufferView does not name a view of the GLB's own buffer`);
  const offset = bufferView.byteOffset ?? 0;
  const length = bufferView.byteLength ?? 0;
  if (!bin || !isInteger(offset, 0, bin.byteLength) || !isInteger(length, 1, bin.byteLength - offset)) {
    throw new Error(`${PLACE_EXTENSION}'s bytes lie outside the GLB's binary chunk`);
  }
  const spz = bin.subarray(offset, offset + length);
  const header = await checkSpzBytes(spz, PLACE_STORED_SPLAT_CAP);
  if (header.numPoints !== extension.splatCount) throw new Error(`the SPZ header says ${header.numPoints} splats, the extension ${extension.splatCount}`);
  if (header.shDegree !== extension.maxSh) throw new Error(`the SPZ header says SH degree ${header.shDegree}, the extension ${extension.maxSh}`);
  return { nodeIndex, extension, spz, header };
}
