import { deflateSync } from 'node:zlib';

// A tray item near the 8 MB supplied-object limit, built in memory for the
// mid-take load check (docs/features/archive/tray-everywhere.md): a dense, textured
// mesh whose parse, texture decode and upload cost what a large found object
// would. Deterministic: the same bytes every run, so nothing is committed.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An RGB PNG of seeded noise: incompressible, so its bytes are its pixels. */
function noisePng(size, seed) {
  let state = seed >>> 0;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let i = 1; i <= size * 3; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      raw[row + i] = state >>> 24;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const pad4 = (buffer, fill = 0) => (buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4), fill)]) : buffer);

/** A crumpled 0.4 m sheet of `triangles` triangles under a `textureSize`² noise texture. */
export function heavyGlb({ triangles = 76_000, textureSize = 1024 } = {}) {
  const vertices = triangles * 3;
  const positions = new Float32Array(vertices * 3);
  const uvs = new Float32Array(vertices * 2);
  const columns = Math.ceil(Math.sqrt(triangles / 2));
  let v = 0;
  const vertex = (i, j) => {
    const u = i / columns;
    const w = j / columns;
    positions[v * 3] = (u - 0.5) * 0.4;
    positions[v * 3 + 1] = 0.2 + 0.03 * Math.sin(u * 37) * Math.cos(w * 29);
    positions[v * 3 + 2] = (w - 0.5) * 0.4;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = w;
    v += 1;
  };
  for (let t = 0; t < triangles; t += 1) {
    const cell = t >> 1;
    const i = cell % columns;
    const j = Math.floor(cell / columns);
    if (t % 2 === 0) [[i, j], [i + 1, j], [i, j + 1]].forEach(([a, b]) => vertex(a, b));
    else [[i + 1, j], [i + 1, j + 1], [i, j + 1]].forEach(([a, b]) => vertex(a, b));
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], positions[i * 3 + k]);
      max[k] = Math.max(max[k], positions[i * 3 + k]);
    }
  }
  const png = noisePng(textureSize, 0x5eed);
  const positionBytes = Buffer.from(positions.buffer);
  const uvBytes = Buffer.from(uvs.buffer);
  const bin = Buffer.concat([positionBytes, uvBytes, pad4(png)]);
  const json = {
    asset: { version: '2.0', generator: 'holoim heavy-glb fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Heavy sheet', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ name: 'Noise', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 2, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: vertices, type: 'VEC2' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: uvBytes.length },
      { buffer: 0, byteOffset: positionBytes.length + uvBytes.length, byteLength: png.length }
    ],
    buffers: [{ byteLength: bin.length }]
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const total = 12 + 8 + jsonChunk.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, bin]);
}
