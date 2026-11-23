// Morph targets as sparse accessors. A face shape moves a small part of a mesh: on the house base, 44 shapes on a
// body of 8 196 vertices were 4.6 MB of position deltas, 96% of them exact zeros. A sparse accessor stores only the
// rows that are not zero, so the take plays the same values from about 0.2 MB. Nothing is rounded.

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ROW_BYTES = 12;

interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }
interface Accessor {
  bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string;
  sparse?: { count: number; indices: { bufferView: number; componentType: number }; values: { bufferView: number } };
}
interface Gltf {
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: BufferView[];
  accessors?: Accessor[];
  meshes?: { primitives: { targets?: Record<string, number>[] }[] }[];
}

const pad4 = (length: number) => (length + 3) & ~3;

/**
 * Rewrites a binary glTF so that each morph target's POSITION and NORMAL deltas are sparse accessors, where that is
 * smaller.
 * Returns the input when it is not a one-buffer GLB or when no target gets smaller.
 */
export function sparseMorphTargets(glb: ArrayBuffer): ArrayBuffer {
  const header = new DataView(glb);
  if (glb.byteLength < 28 || header.getUint32(0, true) !== GLB_MAGIC || header.getUint32(16, true) !== CHUNK_JSON) return glb;
  const jsonLength = header.getUint32(12, true);
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 > glb.byteLength || header.getUint32(binHeader + 4, true) !== CHUNK_BIN) return glb;
  const bin = new Uint8Array(glb, binHeader + 8, header.getUint32(binHeader, true));
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as Gltf;
  const views = gltf.bufferViews;
  const accessors = gltf.accessors;
  if (!views || !accessors || gltf.buffers?.length !== 1 || gltf.buffers[0]!.uri !== undefined) return glb;
  if (views.some((view) => view.buffer !== 0)) return glb;

  const users = new Map<number, number>();
  for (const accessor of accessors) {
    if (accessor.bufferView !== undefined) users.set(accessor.bufferView, (users.get(accessor.bufferView) ?? 0) + 1);
  }
  const targets = new Set<number>();
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      for (const target of primitive.targets ?? []) {
        for (const delta of [target.POSITION, target.NORMAL]) if (delta !== undefined) targets.add(delta);
      }
    }
  }

  // The bytes of each buffer view after the rewrite. A view that no target owns keeps its bytes.
  const payloads: Uint8Array[] = views.map((view) => bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
  let changed = false;
  for (const index of targets) {
    const accessor = accessors[index];
    if (!accessor || accessor.sparse || accessor.bufferView === undefined || accessor.byteOffset) continue;
    if (accessor.componentType !== FLOAT || accessor.type !== 'VEC3' || users.get(accessor.bufferView) !== 1) continue;
    const view = views[accessor.bufferView]!;
    if ((view.byteStride ?? ROW_BYTES) !== ROW_BYTES || view.byteLength < accessor.count * ROW_BYTES) continue;
    const start = view.byteOffset ?? 0;
    const words = new DataView(bin.buffer, bin.byteOffset + start, accessor.count * ROW_BYTES);
    const rows: number[] = [];
    for (let row = 0; row < accessor.count; row += 1) {
      // A row is kept when any of its bits is set. That keeps -0 too: the copy is exact, not only equal.
      const at = row * ROW_BYTES;
      if (words.getUint32(at) | words.getUint32(at + 4) | words.getUint32(at + 8)) rows.push(row);
    }
    // glTF asks for one sparse row at least: a target that moves nothing keeps its first row, which is zero.
    if (rows.length === 0) rows.push(0);
    const wide = accessor.count > 0xffff;
    const indexBytes = wide ? 4 : 2;
    if (pad4(rows.length * indexBytes) + rows.length * ROW_BYTES >= accessor.count * ROW_BYTES) continue;

    const values = new Uint8Array(rows.length * ROW_BYTES);
    const indices = new Uint8Array(rows.length * indexBytes);
    const indexView = new DataView(indices.buffer);
    rows.forEach((row, slot) => {
      values.set(bin.subarray(start + row * ROW_BYTES, start + (row + 1) * ROW_BYTES), slot * ROW_BYTES);
      if (wide) indexView.setUint32(slot * 4, row, true);
      else indexView.setUint16(slot * 2, row, true);
    });
    // The target's own view becomes the values, so no index of a view moves; the indices get a new view.
    const valuesView = accessor.bufferView;
    payloads[valuesView] = values;
    views[valuesView] = { buffer: 0, byteLength: values.byteLength };
    views.push({ buffer: 0, byteLength: indices.byteLength });
    payloads.push(indices);
    delete accessor.bufferView;
    delete accessor.byteOffset;
    accessor.sparse = {
      count: rows.length,
      indices: { bufferView: views.length - 1, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT },
      values: { bufferView: valuesView }
    };
    changed = true;
  }
  if (!changed) return glb;

  let binLength = 0;
  views.forEach((view, index) => {
    view.byteOffset = binLength;
    binLength = pad4(binLength + payloads[index]!.byteLength);
  });
  gltf.buffers[0]!.byteLength = binLength;
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadded = pad4(json.byteLength);
  const out = new ArrayBuffer(12 + 8 + jsonPadded + 8 + binLength);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, header.getUint32(4, true), true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.fill(0x20, 20, 20 + jsonPadded);
  bytes.set(json, 20);
  const binStart = 20 + jsonPadded;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, CHUNK_BIN, true);
  views.forEach((entry, index) => bytes.set(payloads[index]!, binStart + 8 + entry.byteOffset!));
  return out;
}
