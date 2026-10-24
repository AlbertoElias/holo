import * as THREE from 'three';

import { HOLOIM_OBJECTS_EXTENSION, RECORDED_OBJECT_NODE_NAME, validateHoloimObjects } from '../../../../packages/objects/src/index.ts';

// Reads an exported take's object without a renderer: the GLB's JSON and
// binary chunks, the first clip's channels, and any node's pose at a key
// frame, composed through its parents. Every channel of a capture export
// shares one time accessor, so key `i` is the same instant on every node.

const COMPONENTS = { SCALAR: 1, VEC3: 3, VEC4: 4 };

export function readGlb(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength + 8;
  const bin = buffer.subarray(binStart, binStart + buffer.readUInt32LE(20 + jsonLength));
  return { json, bin };
}

function readAccessor({ json, bin }, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const width = COMPONENTS[accessor.type];
  if (accessor.componentType !== 5126) throw new Error(`accessor ${index}: expected float components`);
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? width * 4;
  const out = new Float32Array(accessor.count * width);
  for (let i = 0; i < accessor.count; i += 1) {
    for (let k = 0; k < width; k += 1) out[i * width + k] = bin.readFloatLE(offset + i * stride + k * 4);
  }
  return out;
}

/** The take: JSON, per-node channels of the first clip, key times, parents, and the objects extension. */
export function loadTake(buffer) {
  const glb = readGlb(buffer);
  const { json } = glb;
  const animation = json.animations?.[0];
  if (!animation) throw new Error('no animation in the GLB');
  const channels = new Map();
  let times;
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler];
    times ??= readAccessor(glb, sampler.input);
    const entry = channels.get(channel.target.node) ?? {};
    entry[channel.target.path] = { values: readAccessor(glb, sampler.output), interpolation: sampler.interpolation ?? 'LINEAR', keys: json.accessors[sampler.input].count };
    channels.set(channel.target.node, entry);
  }
  const parents = new Map();
  json.nodes.forEach((node, index) => (node.children ?? []).forEach((child) => parents.set(child, index)));
  const extension = json.extensions?.[HOLOIM_OBJECTS_EXTENSION];
  const validation = extension === undefined ? null : validateHoloimObjects(extension);
  return { ...glb, channels, times: Array.from(times), parents, extension, validation };
}

export function findNode(take, name) {
  return take.json.nodes.findIndex((node) => node.name === name);
}

export function objectNodes(take) {
  return take.json.nodes.flatMap((node, index) => (node.name === RECORDED_OBJECT_NODE_NAME ? [index] : []));
}

/** Node-local matrix at key `i`: animated channels where present, the node's rest TRS elsewhere. */
function localAt(take, nodeIndex, i, out) {
  const node = take.json.nodes[nodeIndex];
  const channels = take.channels.get(nodeIndex) ?? {};
  const t = channels.translation ? Array.from(channels.translation.values.subarray(i * 3, i * 3 + 3)) : node.translation ?? [0, 0, 0];
  const r = channels.rotation ? Array.from(channels.rotation.values.subarray(i * 4, i * 4 + 4)) : node.rotation ?? [0, 0, 0, 1];
  const s = channels.scale ? Array.from(channels.scale.values.subarray(i * 3, i * 3 + 3)) : node.scale ?? [1, 1, 1];
  if (node.matrix) return out.fromArray(node.matrix);
  return out.compose(new THREE.Vector3(...t), new THREE.Quaternion(...r), new THREE.Vector3(...s));
}

/** World (scene-root) matrix of a node at key `i`. */
export function worldAt(take, nodeIndex, i) {
  const out = localAt(take, nodeIndex, i, new THREE.Matrix4());
  const local = new THREE.Matrix4();
  for (let parent = take.parents.get(nodeIndex); parent !== undefined; parent = take.parents.get(parent)) {
    out.premultiply(localAt(take, parent, i, local));
  }
  return out;
}

/** Position and rotation of a matrix with its scale removed. */
export function rigidPose(matrix) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  matrix.decompose(position, quaternion, new THREE.Vector3());
  return { position, quaternion };
}

/** `b` in the frame of `a` (both rigid poses). */
export function relativePose(a, b) {
  const inverse = a.quaternion.clone().invert();
  return {
    position: b.position.clone().sub(a.position).applyQuaternion(inverse),
    quaternion: inverse.multiply(b.quaternion).normalize()
  };
}

export function angleDeg(a, b) {
  return THREE.MathUtils.radToDeg(a.angleTo(b));
}
