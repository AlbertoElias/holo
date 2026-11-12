import { createWriteStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { once } from "node:events";

// A GLB on disk, read by range: the JSON chunk is parsed, the BIN chunk is
// only located. The upload split and the Q4 processing (hologram-budgets)
// rewrite a GLB as targeted JSON/BIN surgery, never through a glTF library:
// a library read/write drops the HOLOIM_* extensions and the buffer views
// they own. Nothing here holds more than one buffer view in memory at a time.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COPY_CHUNK_BYTES = 1 << 20;

export type GltfBufferView = {
  buffer?: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  [key: string]: unknown;
};

export type GltfAccessor = {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
  [key: string]: unknown;
};

export type GltfJson = {
  asset?: Record<string, unknown>;
  buffers?: Array<{ byteLength: number; uri?: string; [key: string]: unknown }>;
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string; [key: string]: unknown }>;
  textures?: Array<{ source?: number; sampler?: number; extensions?: Record<string, unknown>; [key: string]: unknown }>;
  samplers?: Array<Record<string, unknown>>;
  materials?: Array<Record<string, unknown>>;
  nodes?: Array<{
    name?: string;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  scenes?: Array<{ nodes?: number[]; [key: string]: unknown }>;
  scene?: number;
  animations?: Array<{
    name?: string;
    channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
    samplers: Array<{ input: number; output: number; interpolation?: string }>;
  }>;
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
};

export type GlbFile = {
  handle: FileHandle;
  json: GltfJson;
  /** Where the BIN chunk's bytes start in the file, and how many there are (0 when there is no BIN chunk). */
  binOffset: number;
  binLength: number;
  close(): Promise<void>;
};

export class GlbFormatError extends Error {}

/** Opens a GLB for range reads, or throws `GlbFormatError` when the file is not one. */
export async function openGlb(filePath: string): Promise<GlbFile> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(20);
    if (size < 20 || (await handle.read(header, 0, 20, 0)).bytesRead !== 20) throw new GlbFormatError("not a GLB");
    if (header.readUInt32LE(0) !== GLB_MAGIC) throw new GlbFormatError("not a GLB");
    const declared = header.readUInt32LE(8);
    if (declared > size) throw new GlbFormatError("the GLB is shorter than it declares");
    const jsonLength = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== CHUNK_JSON || 20 + jsonLength > declared) throw new GlbFormatError("the GLB's first chunk is not its JSON");
    const jsonBytes = Buffer.alloc(jsonLength);
    await handle.read(jsonBytes, 0, jsonLength, 20);
    let json: GltfJson;
    try {
      json = JSON.parse(jsonBytes.toString("utf8")) as GltfJson;
    } catch {
      throw new GlbFormatError("the GLB's JSON does not parse");
    }
    let binOffset = 0;
    let binLength = 0;
    const binAt = 20 + jsonLength;
    if (binAt + 8 <= declared) {
      const binHeader = Buffer.alloc(8);
      await handle.read(binHeader, 0, 8, binAt);
      const length = binHeader.readUInt32LE(0);
      if (binHeader.readUInt32LE(4) === CHUNK_BIN && binAt + 8 + length <= declared) {
        binOffset = binAt + 8;
        binLength = length;
      }
    }
    return { handle, json, binOffset, binLength, close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** A buffer view of the GLB's own buffer, with its bounds checked against the BIN chunk. */
export function viewRange(glb: GlbFile, index: number): { offset: number; length: number } {
  const view = glb.json.bufferViews?.[index];
  if (!view || (view.buffer ?? 0) !== 0) throw new GlbFormatError(`buffer view ${index} is not a view of the GLB's own buffer`);
  const offset = view.byteOffset ?? 0;
  const length = view.byteLength;
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > glb.binLength) {
    throw new GlbFormatError(`buffer view ${index} lies outside the GLB's binary chunk`);
  }
  return { offset: glb.binOffset + offset, length };
}

export async function readRange(glb: GlbFile, range: { offset: number; length: number }, into?: Buffer, at = 0): Promise<Buffer> {
  const target = into ?? Buffer.alloc(range.length);
  let done = 0;
  while (done < range.length) {
    const { bytesRead } = await glb.handle.read(target, at + done, range.length - done, range.offset + done);
    if (bytesRead === 0) throw new GlbFormatError("the GLB ends early");
    done += bytesRead;
  }
  return target;
}

export async function readView(glb: GlbFile, index: number): Promise<Buffer> {
  return readRange(glb, viewRange(glb, index));
}

/** The bytes of one buffer view in the written file: a range of a file on disk, or bytes in memory. */
export type ViewSource = { file: FileHandle; offset: number; length: number } | { bytes: Uint8Array };

function sourceLength(source: ViewSource): number {
  return "bytes" in source ? source.bytes.byteLength : source.length;
}

/**
 * Every buffer-view reference a glTF holds: accessors (and their sparse
 * parts), images, and any `bufferView` key inside any `extensions` object
 * (HOLOIM_place, KHR_audio, KHR_draco_mesh_compression...). Calls `visit`
 * with the holder and key so callers can read or rewrite it.
 */
export function forEachViewReference(json: GltfJson, visit: (holder: Record<string, unknown>, key: string, index: number) => void): void {
  const inExtensions = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inExtensions);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key === "bufferView" && typeof child === "number") visit(record, key, child);
      else inExtensions(child);
    }
  };
  const walkExtensions = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walkExtensions);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "extensions") inExtensions(child);
      else if (key !== "extras") walkExtensions(child);
    }
  };
  for (const accessor of json.accessors ?? []) {
    const record = accessor as Record<string, unknown>;
    if (typeof record.bufferView === "number") visit(record, "bufferView", record.bufferView);
    const sparse = record.sparse as { indices?: Record<string, unknown>; values?: Record<string, unknown> } | undefined;
    for (const part of [sparse?.indices, sparse?.values]) {
      if (part && typeof part.bufferView === "number") visit(part, "bufferView", part.bufferView);
    }
  }
  for (const image of json.images ?? []) {
    const record = image as Record<string, unknown>;
    if (typeof record.bufferView === "number") visit(record, "bufferView", record.bufferView);
  }
  walkExtensions(json);
}

/**
 * Writes a GLB whose buffer 0 holds `views` in order: each view's JSON entry
 * (`json.bufferViews[i]`) keeps its own fields (stride, target, name) and gets
 * a fresh 4-byte-aligned offset and its new length. Views of other buffers
 * are left as they are. File ranges are copied through a fixed 1 MB buffer.
 */
export async function writeGlb(filePath: string, json: GltfJson, views: Array<ViewSource | null>): Promise<number> {
  const bufferViews = json.bufferViews ?? [];
  let cursor = 0;
  const placed: Array<{ source: ViewSource; at: number }> = [];
  bufferViews.forEach((view, index) => {
    if ((view.buffer ?? 0) !== 0) return;
    const source = views[index];
    if (!source) throw new Error(`buffer view ${index} has no bytes to write`);
    cursor = Math.ceil(cursor / 4) * 4;
    const length = sourceLength(source);
    view.byteOffset = cursor;
    view.byteLength = length;
    if (view.byteOffset === 0) delete view.byteOffset;
    placed.push({ source, at: cursor });
    cursor += length;
  });
  const binLength = Math.ceil(cursor / 4) * 4;
  if (json.buffers?.[0]) {
    json.buffers[0].byteLength = binLength;
  } else if (binLength > 0) {
    json.buffers = [{ byteLength: binLength }];
  }
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = Math.ceil(jsonBytes.length / 4) * 4;
  const total = 12 + 8 + jsonPadded + (binLength > 0 ? 8 + binLength : 0);

  const out = createWriteStream(filePath);
  const write = async (chunk: Uint8Array) => {
    if (!out.write(chunk)) await once(out, "drain");
  };
  const done = once(out, "finish");
  try {
    const header = Buffer.alloc(20);
    header.writeUInt32LE(GLB_MAGIC, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    header.writeUInt32LE(jsonPadded, 12);
    header.writeUInt32LE(CHUNK_JSON, 16);
    await write(header);
    await write(jsonBytes);
    if (jsonPadded > jsonBytes.length) await write(Buffer.alloc(jsonPadded - jsonBytes.length, 0x20));
    if (binLength > 0) {
      const binHeader = Buffer.alloc(8);
      binHeader.writeUInt32LE(binLength, 0);
      binHeader.writeUInt32LE(CHUNK_BIN, 4);
      await write(binHeader);
      let written = 0;
      const scratch = Buffer.alloc(COPY_CHUNK_BYTES);
      for (const { source, at } of placed) {
        if (at > written) await write(Buffer.alloc(at - written));
        written = at;
        if ("bytes" in source) {
          await write(source.bytes);
          written += source.bytes.byteLength;
          continue;
        }
        let copied = 0;
        while (copied < source.length) {
          const want = Math.min(COPY_CHUNK_BYTES, source.length - copied);
          const { bytesRead } = await source.file.read(scratch, 0, want, source.offset + copied);
          if (bytesRead === 0) throw new GlbFormatError("a source file ends early");
          // A copy: the stream may hold the chunk after `write` returns.
          await write(Buffer.from(scratch.subarray(0, bytesRead)));
          copied += bytesRead;
        }
        written += source.length;
      }
      if (binLength > written) await write(Buffer.alloc(binLength - written));
    }
    out.end();
    await done;
  } catch (error) {
    out.destroy();
    throw error;
  }
  return total;
}

/**
 * Rewrites a GLB's views: `replace` gives new bytes for some views (a new
 * view is pushed onto `json.bufferViews` first and given its bytes here),
 * `drop` removes views nothing may reference any more. Every reference is renumbered;
 * a reference left to a dropped view is an error, never a dangling index.
 */
export async function rewriteGlb(
  glb: GlbFile,
  json: GltfJson,
  outPath: string,
  edits: { drop?: Iterable<number>; replace?: Map<number, ViewSource> } = {}
): Promise<number> {
  const drop = new Set(edits.drop ?? []);
  const original = json.bufferViews ?? [];
  const sources: Array<ViewSource | null> = [];
  const remap = new Map<number, number>();
  const kept: GltfBufferView[] = [];
  original.forEach((view, index) => {
    if (drop.has(index)) return;
    remap.set(index, kept.length);
    kept.push(view);
    if ((view.buffer ?? 0) !== 0) {
      sources.push(null);
      return;
    }
    const replaced = edits.replace?.get(index);
    if (replaced) {
      sources.push(replaced);
      return;
    }
    const range = viewRange(glb, index);
    sources.push({ file: glb.handle, offset: range.offset, length: range.length });
  });
  forEachViewReference(json, (holder, key, index) => {
    const next = remap.get(index);
    if (next === undefined) throw new Error(`a reference to buffer view ${index} remains after it was dropped`);
    holder[key] = next;
  });
  json.bufferViews = kept;
  if (kept.length === 0) delete json.bufferViews;
  return writeGlb(outPath, json, sources);
}
