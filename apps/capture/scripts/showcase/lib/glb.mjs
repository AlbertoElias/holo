import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Color } from 'three';

// A small glTF 2.0 binary writer for authored showcase holograms. It takes
// three.js BufferGeometry for shapes and writes exactly what the viewer
// reads: meshes, PBR materials, one animation clip, and KHR_audio sounds
// (one for the whole take, or several, each from a node).
// Meters, +Y up, the floor at y = 0.

/** sRGB hex ("#ffc872") to the linear RGB factors glTF stores. */
export function linear(hex) {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

const FLOAT = 5126;
const USHORT = 5123;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export class Glb {
  constructor({ generator = 'holoim-showcase', clipName = 'ShowcaseTake' } = {}) {
    this.json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }]
    };
    this.chunks = [];
    this.byteLength = 0;
    this.clipName = clipName;
    this.channels = [];
    this.extensionsUsed = new Set();
    this.duration = 0;
  }

  bufferView(bytes, target) {
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(Buffer.alloc(pad));
      this.byteLength += pad;
    }
    const view = { buffer: 0, byteOffset: this.byteLength, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.byteLength += bytes.byteLength;
    return this.json.bufferViews.push(view) - 1;
  }

  accessor(array, type, { target, minMax = false, componentType = FLOAT } = {}) {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    // One NaN vertex is invisible in a plain three.js render but poisons the
    // viewer's measured bounds, and the whole hologram then draws as nothing.
    for (let i = 0; i < array.length; i += 1) {
      if (!Number.isFinite(array[i])) throw new Error(`accessor (${type}, ${array.length / size} items) has a non-finite value at index ${i}`);
    }
    const accessor = {
      bufferView: this.bufferView(array, target),
      componentType,
      count: array.length / size,
      type
    };
    if (minMax) {
      const min = new Array(size).fill(Infinity);
      const max = new Array(size).fill(-Infinity);
      for (let i = 0; i < array.length; i += 1) {
        const k = i % size;
        if (array[i] < min[k]) min[k] = array[i];
        if (array[i] > max[k]) max[k] = array[i];
      }
      accessor.min = min;
      accessor.max = max;
    }
    return this.json.accessors.push(accessor) - 1;
  }

  /** PNG bytes to a texture index. */
  texture(png) {
    this.json.images ??= [];
    this.json.textures ??= [];
    this.json.samplers ??= [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    const image = this.json.images.push({ bufferView: this.bufferView(png), mimeType: 'image/png' }) - 1;
    return this.json.textures.push({ source: image, sampler: 0 }) - 1;
  }

  /**
   * color / emissive are sRGB hex. `emissiveStrength` above 1 needs the
   * viewer's tone mapping to read as light. `unlit` ignores scene lighting.
   */
  material({
    name,
    color = '#ffffff',
    opacity = 1,
    emissive,
    emissiveStrength = 1,
    metallic = 0,
    roughness = 0.9,
    unlit = false,
    blend = opacity < 1,
    doubleSided = false,
    texture
  } = {}) {
    const material = {
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...linear(color), opacity],
        metallicFactor: metallic,
        roughnessFactor: roughness
      }
    };
    if (texture !== undefined) material.pbrMetallicRoughness.baseColorTexture = { index: texture };
    if (emissive) {
      material.emissiveFactor = linear(emissive);
      if (emissiveStrength !== 1) {
        material.extensions = { KHR_materials_emissive_strength: { emissiveStrength } };
        this.extensionsUsed.add('KHR_materials_emissive_strength');
      }
    }
    if (unlit) {
      material.extensions = { ...material.extensions, KHR_materials_unlit: {} };
      this.extensionsUsed.add('KHR_materials_unlit');
    }
    if (blend) material.alphaMode = 'BLEND';
    if (doubleSided) material.doubleSided = true;
    return this.json.materials.push(material) - 1;
  }

  /** A three BufferGeometry (position, optional normal / uv / color, optional index) as a mesh. */
  mesh(name, geometry, material) {
    const attributes = {};
    const put = (key, attribute, type, minMax) => {
      if (!attribute) return;
      attributes[key] = this.accessor(new Float32Array(attribute.array), type, { target: ARRAY_BUFFER, minMax });
    };
    put('POSITION', geometry.attributes.position, 'VEC3', true);
    put('NORMAL', geometry.attributes.normal, 'VEC3');
    // three puts v = 1 at the top of an image; glTF puts v = 0 there.
    const uv = geometry.attributes.uv;
    if (uv) {
      const flipped = new Float32Array(uv.array);
      for (let i = 1; i < flipped.length; i += 2) flipped[i] = 1 - flipped[i];
      attributes.TEXCOORD_0 = this.accessor(flipped, 'VEC2', { target: ARRAY_BUFFER });
    }
    const color = geometry.attributes.color;
    if (color) put('COLOR_0', color, color.itemSize === 4 ? 'VEC4' : 'VEC3');
    const primitive = { attributes, material };
    // Morph targets: three's relative position deltas (morphTargetsRelative),
    // which is what glTF stores. `geometry.userData.weights` sets the mesh's
    // default weights (what shows before the clip's first key applies).
    const morphs = geometry.morphAttributes?.position;
    if (morphs?.length) {
      // Normal deltas ride along when every target has one (three fills a
      // missing one with the base normal, which would add it again).
      const normals = geometry.morphAttributes?.normal;
      const withNormals = normals?.length === morphs.length;
      primitive.targets = morphs.map((target, i) => ({
        POSITION: this.accessor(new Float32Array(target.array), 'VEC3', { target: ARRAY_BUFFER, minMax: true }),
        ...(withNormals ? { NORMAL: this.accessor(new Float32Array(normals[i].array), 'VEC3', { target: ARRAY_BUFFER }) } : {})
      }));
    }
    if (geometry.index) {
      const count = geometry.attributes.position.count;
      const indices = count > 65535 ? new Uint32Array(geometry.index.array) : new Uint16Array(geometry.index.array);
      primitive.indices = this.accessor(indices, 'SCALAR', {
        target: ELEMENT_ARRAY_BUFFER,
        componentType: count > 65535 ? UINT : USHORT
      });
    }
    const mesh = { name, primitives: [primitive] };
    if (morphs?.length) mesh.weights = geometry.userData.weights ?? morphs.map(() => 0);
    return this.json.meshes.push(mesh) - 1;
  }

  /** Adds a node; `parent` is a node index, omitted for a scene root. */
  node({ name, mesh, translation, rotation, scale, parent } = {}) {
    const node = { name };
    if (mesh !== undefined) node.mesh = mesh;
    if (translation) node.translation = translation;
    if (rotation) node.rotation = rotation;
    if (scale) node.scale = scale;
    const index = this.json.nodes.push(node) - 1;
    if (parent === undefined) {
      this.json.scenes[0].nodes.push(index);
    } else {
      const parentNode = this.json.nodes[parent];
      (parentNode.children ??= []).push(index);
    }
    return index;
  }

  /**
   * Keyframes for one node property in the single take clip.
   * `path` is translation, rotation (xyzw quaternions), scale or weights
   * (one value per morph target of the node's mesh); `values` is flat.
   */
  animate(node, animationPath, times, values, interpolation = 'LINEAR') {
    const size = animationPath === 'rotation' ? 4 : animationPath === 'weights' ? this.json.meshes[this.json.nodes[node].mesh].weights.length : 3;
    if (values.length !== times.length * size) {
      throw new Error(`animate(${animationPath}): ${values.length} values for ${times.length} keys`);
    }
    this.duration = Math.max(this.duration, times[times.length - 1]);
    this.channels.push({ node, path: animationPath, times, values, interpolation });
  }

  /**
   * One looping sound for the whole take (KHR_audio, the capture app's shape).
   * Keep its length equal to the clip's so the loop stays in step.
   */
  audio(bytes, mimeType = 'audio/wav') {
    this.sound(bytes, { mimeType });
  }

  /**
   * A looping sound (KHR_audio). With `node`, it comes from that node: a
   * positional emitter on it, heard from wherever the node is as the clip
   * moves it, fainter with distance by `distanceModel` ('inverse', 'linear'
   * or 'exponential'), `refDistance`, `maxDistance` and `rolloffFactor`
   * (metres; Web Audio's meaning and defaults). Without `node`, it is heard
   * the same from everywhere (a global emitter on the scene). Every sound
   * starts with the clip and restarts at each loop: keep each one's length
   * the clip's. Returns the emitter's index.
   */
  sound(bytes, { node, name, gain = 1.0, mimeType = 'audio/wav', distanceModel, refDistance, maxDistance, rolloffFactor } = {}) {
    if (node !== undefined && !this.json.nodes[node]) throw new Error(`sound: no node ${node}`);
    const audio = this.json.extensions?.KHR_audio ?? { audio: [], sources: [], emitters: [] };
    const clip = audio.audio.push({ bufferView: this.bufferView(bytes), mimeType }) - 1;
    const source = audio.sources.push({ audio: clip, autoPlay: false, loop: true }) - 1;
    const emitter = node === undefined ? { type: 'global', sources: [source], gain } : { type: 'positional', sources: [source], gain };
    if (name) emitter.name = name;
    if (node !== undefined) {
      const positional = {};
      if (distanceModel !== undefined) positional.distanceModel = distanceModel;
      if (refDistance !== undefined) positional.refDistance = refDistance;
      if (maxDistance !== undefined) positional.maxDistance = maxDistance;
      if (rolloffFactor !== undefined) positional.rolloffFactor = rolloffFactor;
      emitter.positional = positional;
    }
    const index = audio.emitters.push(emitter) - 1;
    this.json.extensions = { ...this.json.extensions, KHR_audio: audio };
    if (node === undefined) {
      const scene = this.json.scenes[0];
      const emitters = scene.extensions?.KHR_audio?.emitters ?? [];
      scene.extensions = { ...scene.extensions, KHR_audio: { emitters: [...emitters, index] } };
    } else {
      const target = this.json.nodes[node];
      if (target.extensions?.KHR_audio) throw new Error(`sound: node ${node} already has a sound`);
      target.extensions = { ...target.extensions, KHR_audio: { emitter: index } };
    }
    this.extensionsUsed.add('KHR_audio');
    return index;
  }

  /** Free-form provenance on the asset: who authored it and how. */
  provenance(extras) {
    this.json.asset.extras = extras;
  }

  toBuffer() {
    if (this.channels.length > 0) {
      const samplers = [];
      const channels = [];
      const timeAccessors = new Map();
      const valueAccessors = new Map();
      for (const channel of this.channels) {
        const type = channel.path === 'rotation' ? 'VEC4' : channel.path === 'weights' ? 'SCALAR' : 'VEC3';
        // Channels keyed on the same `times` array share one accessor.
        if (!timeAccessors.has(channel.times)) {
          timeAccessors.set(channel.times, this.accessor(new Float32Array(channel.times), 'SCALAR', { minMax: true }));
        }
        // So do channels given the same `values` array (many nodes, one motion).
        if (!valueAccessors.has(channel.values)) {
          valueAccessors.set(channel.values, this.accessor(new Float32Array(channel.values), type));
        }
        const sampler = {
          input: timeAccessors.get(channel.times),
          output: valueAccessors.get(channel.values),
          interpolation: channel.interpolation
        };
        channels.push({ sampler: samplers.push(sampler) - 1, target: { node: channel.node, path: channel.path } });
      }
      this.json.animations = [{ name: this.clipName, samplers, channels }];
      this.channels = [];
    }
    if (this.extensionsUsed.size > 0) this.json.extensionsUsed = [...this.extensionsUsed];

    const pad = (4 - (this.byteLength % 4)) % 4;
    const bin = Buffer.concat([...this.chunks, Buffer.alloc(pad)]);
    this.json.buffers[0].byteLength = bin.byteLength;
    let jsonBytes = Buffer.from(JSON.stringify(this.json), 'utf8');
    const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
    if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBytes.byteLength, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.byteLength, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
  }

  async write(file) {
    const buffer = this.toBuffer();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, buffer);
    return { file, bytes: buffer.byteLength, duration: this.duration };
  }
}

/** Keys `fn(t)` at `fps` over [0, duration], always ending exactly on `duration`. */
export function sample(duration, fps, fn) {
  const count = Math.round(duration * fps);
  const times = [];
  const values = [];
  for (let i = 0; i <= count; i += 1) {
    const t = (i / count) * duration;
    times.push(t);
    values.push(...fn(t));
  }
  return { times, values };
}
