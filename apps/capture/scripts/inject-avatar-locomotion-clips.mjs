import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

const avatarPath = path.resolve('public/gltf/models/avatar.glb');

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

const REQUIRED_BONES = ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];

const CLIP_DEFS = [
  {
    name: 'Idle',
    times: [0, 0.5, 1.0],
    rotations: {
      Hips: [{ x: 0 }, { x: 1.5 }, { x: 0 }],
      LeftUpLeg: [{ x: 0 }, { x: 2.5 }, { x: 0 }],
      RightUpLeg: [{ x: 0 }, { x: -2.5 }, { x: 0 }],
      LeftLeg: [{ x: 4 }, { x: 6 }, { x: 4 }],
      RightLeg: [{ x: 4 }, { x: 2 }, { x: 4 }],
      LeftFoot: [{ x: -3 }, { x: -1 }, { x: -3 }],
      RightFoot: [{ x: -3 }, { x: -5 }, { x: -3 }]
    }
  },
  {
    name: 'Walk',
    times: [0, 0.2, 0.4, 0.6, 0.8, 1.0],
    rotations: {
      Hips: [{ x: 2 }, { x: 0 }, { x: -2 }, { x: 0 }, { x: 2 }, { x: 2 }],
      LeftUpLeg: [{ x: 24 }, { x: 10 }, { x: -20 }, { x: -8 }, { x: 24 }, { x: 24 }],
      RightUpLeg: [{ x: -20 }, { x: -8 }, { x: 24 }, { x: 10 }, { x: -20 }, { x: -20 }],
      LeftLeg: [{ x: 2 }, { x: 20 }, { x: 8 }, { x: 1 }, { x: 2 }, { x: 2 }],
      RightLeg: [{ x: 8 }, { x: 1 }, { x: 2 }, { x: 20 }, { x: 8 }, { x: 8 }],
      LeftFoot: [{ x: -10 }, { x: 4 }, { x: 10 }, { x: -2 }, { x: -10 }, { x: -10 }],
      RightFoot: [{ x: 10 }, { x: -2 }, { x: -10 }, { x: 4 }, { x: 10 }, { x: 10 }],
      LeftToeBase: [{ x: 4 }, { x: 0 }, { x: -4 }, { x: 0 }, { x: 4 }, { x: 4 }],
      RightToeBase: [{ x: -4 }, { x: 0 }, { x: 4 }, { x: 0 }, { x: -4 }, { x: -4 }]
    }
  },
  {
    name: 'Jump',
    times: [0, 0.15, 0.35, 0.6],
    rotations: {
      Hips: [{ x: 0 }, { x: -12 }, { x: 14 }, { x: 4 }],
      LeftUpLeg: [{ x: 10 }, { x: -26 }, { x: 32 }, { x: 12 }],
      RightUpLeg: [{ x: 10 }, { x: -26 }, { x: 32 }, { x: 12 }],
      LeftLeg: [{ x: 0 }, { x: 44 }, { x: 8 }, { x: 18 }],
      RightLeg: [{ x: 0 }, { x: 44 }, { x: 8 }, { x: 18 }],
      LeftFoot: [{ x: -2 }, { x: 16 }, { x: -12 }, { x: -4 }],
      RightFoot: [{ x: -2 }, { x: 16 }, { x: -12 }, { x: -4 }]
    }
  },
  {
    name: 'Fall',
    times: [0, 0.3, 0.6],
    rotations: {
      Hips: [{ x: 8 }, { x: 8 }, { x: 8 }],
      LeftUpLeg: [{ x: 18 }, { x: 22 }, { x: 18 }],
      RightUpLeg: [{ x: 18 }, { x: 22 }, { x: 18 }],
      LeftLeg: [{ x: 24 }, { x: 30 }, { x: 24 }],
      RightLeg: [{ x: 24 }, { x: 30 }, { x: 24 }],
      LeftFoot: [{ x: -10 }, { x: -12 }, { x: -10 }],
      RightFoot: [{ x: -10 }, { x: -12 }, { x: -10 }]
    }
  }
];

function align4(value) {
  return (value + 3) & ~3;
}

function readGlb(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 20) {
    throw new Error(`Invalid GLB: too small (${buffer.length} bytes).`);
  }
  const magic = buffer.readUInt32LE(0);
  if (magic !== GLB_MAGIC) {
    throw new Error('Invalid GLB header magic.');
  }

  const version = buffer.readUInt32LE(4);
  if (version !== GLB_VERSION) {
    throw new Error(`Unsupported GLB version: ${version}`);
  }

  let offset = 12;
  let jsonText = '';
  let binChunk = Buffer.alloc(0);

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > buffer.length) {
      throw new Error('Invalid GLB chunk bounds.');
    }

    if (chunkType === CHUNK_TYPE_JSON) {
      jsonText = buffer.toString('utf8', chunkStart, chunkEnd);
    } else if (chunkType === CHUNK_TYPE_BIN) {
      binChunk = Buffer.from(buffer.subarray(chunkStart, chunkEnd));
    }

    offset = chunkEnd;
  }

  if (!jsonText) {
    throw new Error('GLB is missing JSON chunk.');
  }

  return {
    json: JSON.parse(jsonText),
    binChunk
  };
}

function writeGlb(filePath, json, binChunk) {
  const paddedBin = align4(binChunk.length) === binChunk.length ? binChunk : Buffer.concat([binChunk, Buffer.alloc(align4(binChunk.length) - binChunk.length)]);
  const jsonText = JSON.stringify(json);
  const jsonBufferRaw = Buffer.from(jsonText, 'utf8');
  const jsonBuffer = align4(jsonBufferRaw.length) === jsonBufferRaw.length
    ? jsonBufferRaw
    : Buffer.concat([jsonBufferRaw, Buffer.alloc(align4(jsonBufferRaw.length) - jsonBufferRaw.length, 0x20)]);

  const totalLength = 12 + 8 + jsonBuffer.length + 8 + paddedBin.length;

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonBuffer.length, 0);
  jsonChunkHeader.writeUInt32LE(CHUNK_TYPE_JSON, 4);

  const binChunkHeader = Buffer.alloc(8);
  binChunkHeader.writeUInt32LE(paddedBin.length, 0);
  binChunkHeader.writeUInt32LE(CHUNK_TYPE_BIN, 4);

  const output = Buffer.concat([header, jsonChunkHeader, jsonBuffer, binChunkHeader, paddedBin]);
  fs.writeFileSync(filePath, output);
}

function appendFloatAccessor(json, state, values, type, count, min, max) {
  const floatArray = Float32Array.from(values);
  const valueBytes = Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);

  const alignedOffset = align4(state.bin.length);
  if (alignedOffset > state.bin.length) {
    state.bin = Buffer.concat([state.bin, Buffer.alloc(alignedOffset - state.bin.length)]);
  }
  const byteOffset = state.bin.length;
  state.bin = Buffer.concat([state.bin, valueBytes]);

  const bufferViewIndex = json.bufferViews.length;
  json.bufferViews.push({
    buffer: 0,
    byteOffset,
    byteLength: valueBytes.length
  });

  const accessorIndex = json.accessors.length;
  const accessor = {
    bufferView: bufferViewIndex,
    byteOffset: 0,
    componentType: 5126,
    count,
    type
  };
  if (min) accessor.min = min;
  if (max) accessor.max = max;
  json.accessors.push(accessor);
  return accessorIndex;
}

function getNodeIndexByNameMap(json) {
  const map = new Map();
  for (let i = 0; i < json.nodes.length; i += 1) {
    const node = json.nodes[i];
    if (typeof node?.name === 'string') {
      map.set(node.name, i);
    }
  }
  return map;
}

function toRadians(degrees) {
  return THREE.MathUtils.degToRad(degrees);
}

function getNodeBaseQuaternion(node) {
  const rotation = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
  return new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]);
}

function buildRotationValues(node, keyframes) {
  const baseQuaternion = getNodeBaseQuaternion(node);
  const values = [];

  for (const keyframe of keyframes) {
    const delta = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        toRadians(keyframe.x ?? 0),
        toRadians(keyframe.y ?? 0),
        toRadians(keyframe.z ?? 0),
        'XYZ'
      )
    );
    const result = baseQuaternion.clone().multiply(delta).normalize();
    values.push(result.x, result.y, result.z, result.w);
  }

  return values;
}

function injectLocomotionClips(avatarJson, avatarBin) {
  if (!Array.isArray(avatarJson.accessors) || !Array.isArray(avatarJson.bufferViews) || !Array.isArray(avatarJson.nodes)) {
    throw new Error('Unexpected avatar GLB JSON structure.');
  }
  if (!Array.isArray(avatarJson.buffers) || avatarJson.buffers.length === 0) {
    throw new Error('Avatar GLB is missing buffers metadata.');
  }

  const nodeByName = getNodeIndexByNameMap(avatarJson);
  for (const requiredBone of REQUIRED_BONES) {
    if (!nodeByName.has(requiredBone)) {
      throw new Error(`Missing required bone in avatar: ${requiredBone}`);
    }
  }

  avatarJson.animations = [];
  const state = { bin: Buffer.from(avatarBin) };

  for (const clipDef of CLIP_DEFS) {
    const samplers = [];
    const channels = [];
    const times = clipDef.times;
    const inputAccessor = appendFloatAccessor(
      avatarJson,
      state,
      times,
      'SCALAR',
      times.length,
      [Math.min(...times)],
      [Math.max(...times)]
    );

    for (const [boneName, keyframes] of Object.entries(clipDef.rotations)) {
      if (keyframes.length !== times.length) {
        throw new Error(`Clip ${clipDef.name} has mismatched keyframe count for ${boneName}.`);
      }
      const nodeIndex = nodeByName.get(boneName);
      if (nodeIndex === undefined) continue;
      const node = avatarJson.nodes[nodeIndex];
      const rotationValues = buildRotationValues(node, keyframes);

      const outputAccessor = appendFloatAccessor(
        avatarJson,
        state,
        rotationValues,
        'VEC4',
        times.length
      );

      const samplerIndex = samplers.length;
      samplers.push({
        input: inputAccessor,
        output: outputAccessor,
        interpolation: 'LINEAR'
      });
      channels.push({
        sampler: samplerIndex,
        target: {
          node: nodeIndex,
          path: 'rotation'
        }
      });
    }

    avatarJson.animations.push({
      name: clipDef.name,
      samplers,
      channels
    });
  }

  avatarJson.buffers[0].byteLength = state.bin.length;
  return state.bin;
}

const { json: avatarJson, binChunk: avatarBin } = readGlb(avatarPath);
const updatedBin = injectLocomotionClips(avatarJson, avatarBin);
writeGlb(avatarPath, avatarJson, updatedBin);

const clipNames = (avatarJson.animations ?? []).map((clip) => clip.name).join(', ');
console.log(`Updated ${avatarPath}`);
console.log(`Injected clips: ${clipNames}`);
