import { BoxGeometry, SphereGeometry, type BufferGeometry } from "three";

// A deliberately oversized red object sits outside the recorded sphere. The
// animated green object is inside it. Unlit colors make the pixel oracle
// independent of lighting, textures, driver-specific PBR, or room geometry.
export function diagnosticGltf(): Buffer {
  const buffers: Buffer[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let byteLength = 0;
  function attribute(values: Float32Array | Uint16Array | Uint32Array, size: number): number {
    const source = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const padded = Buffer.alloc(Math.ceil(source.length / 4) * 4);
    source.copy(padded);
    buffers.push(padded);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: source.length });
    byteLength += padded.length;
    const rows = Array.from({ length: values.length / size }, (_, index) => Array.from(values.slice(index * size, (index + 1) * size)));
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: values instanceof Float32Array ? 5126 : values instanceof Uint32Array ? 5125 : 5123,
      count: rows.length,
      type: size === 1 ? "SCALAR" : `VEC${size}`,
      min: Array.from({ length: size }, (_, index) => Math.min(...rows.map((row) => row[index]!))),
      max: Array.from({ length: size }, (_, index) => Math.max(...rows.map((row) => row[index]!)))
    });
    return accessors.length - 1;
  }
  function primitive(geometry: BufferGeometry, material: number) {
    return { attributes: { POSITION: attribute(geometry.getAttribute("position").array as Float32Array, 3), NORMAL: attribute(geometry.getAttribute("normal").array as Float32Array, 3) }, indices: attribute(geometry.index!.array as Uint16Array, 1), material };
  }
  const meshes = [
    { primitives: [primitive(new SphereGeometry(2, 32, 24), 0)] },
    { primitives: [primitive(new BoxGeometry(0.5, 0.5, 0.5), 1)] },
    { primitives: [primitive(new BoxGeometry(0.6, 0.6, 0.6), 2)] }
  ];
  const input = attribute(new Float32Array([0, 1, 2]), 1);
  const output = attribute(new Float32Array([-0.4, 2, 0, 0.4, 2, 0, -0.4, 2, 0]), 3);
  const json = JSON.stringify({
    asset: { version: "2.0" }, extensionsUsed: ["KHR_materials_unlit"], scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: "RecordedBubbleSphere", mesh: 0, translation: [0, 2, 0] }, { name: "RecordedAvatar", mesh: 1, translation: [0, 2, 0] }, { name: "OutsideMarker", mesh: 2, translation: [2.7, 2, 0] }],
    meshes,
    materials: [[0.1, 0.4, 0.8, 0.2], [0, 1, 0, 1], [1, 0, 0, 1]].map((color) => ({ pbrMetallicRoughness: { baseColorFactor: color }, extensions: { KHR_materials_unlit: {} }, alphaMode: color[3]! < 1 ? "BLEND" : "OPAQUE" })),
    animations: [{ name: "RecordedMotion", samplers: [{ input, output }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }, { sampler: 0, target: { node: 0, path: "translation" } }] }],
    accessors, bufferViews, buffers: [{ byteLength, uri: `data:application/octet-stream;base64,${Buffer.concat(buffers).toString("base64")}` }]
  });
  const padded = Buffer.from(json + " ".repeat((4 - Buffer.byteLength(json) % 4) % 4));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded]);
}
