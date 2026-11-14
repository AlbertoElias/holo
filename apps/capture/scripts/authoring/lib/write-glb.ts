/**
 * Writes a solved take as one hologram GLB with gltf-transform: every
 * performer's own avatar file, merged, each under a wrapper node that carries
 * its stage placement; the first is `RecordedAvatar` and the only one declared
 * in `HOLOIM_humanoid`, exactly as a captured export does, so the viewer frames
 * and anchors on it. The published format is unchanged; the asset says the
 * take was authored, the way showcase pieces do.
 */
import { Document, NodeIO, type Node as GNode } from '@gltf-transform/core';
import { dedup, mergeDocuments } from '@gltf-transform/functions';
import type * as THREE from 'three';

import type { PerformerTrack, SolvedTake } from './direct.ts';

const HUMANOID = 'HOLOIM_humanoid';
const EPS_ROTATION = 1e-5;
const EPS_TRANSLATION = 1e-5;
const EPS_WEIGHT = 1e-4;

export interface Provenance {
  readonly author: string;
  readonly title: string;
  readonly method: string;
  readonly [key: string]: unknown;
}

export interface WrittenTake {
  readonly glb: Uint8Array;
  readonly channels: number;
  /** Node index of each performer's wrapper. */
  readonly performers: { id: string; node: number; name: string }[];
}

export async function writeTake(take: SolvedTake, provenance: Provenance): Promise<WrittenTake> {
  const io = new NodeIO();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  const animation = doc.createAnimation('Take');
  const times = doc.createAccessor('time').setType('SCALAR').setArray(new Float32Array(take.times)).setBuffer(buffer);
  let channels = 0;
  const wrappers: { id: string; node: GNode; name: string }[] = [];
  let humanBones: Map<string, GNode> | undefined;

  for (const [index, track] of take.tracks.entries()) {
    const src = await io.readBinary(new Uint8Array(track.avatar.bytes));
    // A take carries only its own motion: the avatar's library clips stay out.
    for (const a of src.getRoot().listAnimations()) {
      for (const s of a.listSamplers()) { s.getInput()?.dispose(); s.getOutput()?.dispose(); s.dispose(); }
      for (const c of a.listChannels()) c.dispose();
      a.dispose();
    }
    const srcNodes = src.getRoot().listNodes();
    const srcScene = src.getRoot().getDefaultScene() ?? src.getRoot().listScenes()[0]!;
    const roots = srcScene.listChildren();
    const map = mergeDocuments(doc, src);
    for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();
    for (const b of doc.getRoot().listBuffers()) if (b !== buffer) b.dispose();
    for (const a of doc.getRoot().listAccessors()) a.setBuffer(buffer);

    const name = index === 0 ? 'RecordedAvatar' : `Performer_${track.spec.id}`;
    const wrapper = doc.createNode(name);
    scene.addChild(wrapper);
    let parent = wrapper;
    if (track.avatar.facingCorrection) {
      const facing = doc.createNode('HumanoidFacing').setRotation(track.avatar.facingCorrection.toArray() as [number, number, number, number]);
      wrapper.addChild(facing);
      parent = facing;
    }
    for (const r of roots) parent.addChild(map.get(r) as GNode);
    wrappers.push({ id: track.spec.id, node: wrapper, name });

    const nodeOf = (o: THREE.Object3D): GNode | undefined => {
      if (o === track.avatar.frame) return wrapper;
      const i = track.avatar.nodeIndex.get(o);
      return i === undefined ? undefined : (map.get(srcNodes[i]!) as GNode | undefined);
    };
    const add = (node: GNode, path: 'rotation' | 'translation' | 'weights', values: Float32Array): void => {
      const output = doc.createAccessor(`${node.getName()}.${path}`).setType(path === 'rotation' ? 'VEC4' : path === 'translation' ? 'VEC3' : 'SCALAR').setArray(new Float32Array(values)).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(times).setOutput(output).setInterpolation('LINEAR');
      animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
      channels += 1;
    };

    add(wrapper, 'translation', track.root.position);
    add(wrapper, 'rotation', track.root.rotation);
    for (const [o, values] of track.rotations) {
      const node = nodeOf(o);
      if (node && moves(values, 4, EPS_ROTATION)) add(node, 'rotation', continuous(values));
    }
    for (const [o, values] of track.translations) {
      const node = nodeOf(o);
      if (node && moves(values, 3, EPS_TRANSLATION)) add(node, 'translation', values);
    }
    for (const [o, w] of track.weights) {
      const node = nodeOf(o);
      if (node && moves(w.values, w.targets, EPS_WEIGHT)) add(node, 'weights', w.values);
    }
    if (index === 0) humanBones = humanBoneNodes(track, nodeOf);
  }

  await doc.transform(dedup({ propertyTypes: ['Texture', 'Material'] }));
  let glb: Uint8Array = await io.writeBinary(doc);
  const nodes = doc.getRoot().listNodes();
  glb = patchJson(glb, (json) => {
    json.asset = { ...json.asset, extras: { ...(json.asset.extras ?? {}), holoim: { authored: 'synthetic', ...provenance } } };
    if (humanBones && humanBones.size) {
      json.extensions = { ...(json.extensions ?? {}), [HUMANOID]: { humanBones: Object.fromEntries([...humanBones].map(([b, n]) => [b, { node: nodes.indexOf(n) }])) } };
      json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), HUMANOID])];
    }
  });
  return { glb, channels, performers: wrappers.map((w) => ({ id: w.id, node: nodes.indexOf(w.node), name: w.name })) };
}

function humanBoneNodes(track: PerformerTrack, nodeOf: (o: THREE.Object3D) => GNode | undefined): Map<string, GNode> {
  const out = new Map<string, GNode>();
  for (const [name, b] of track.avatar.bind) {
    const node = nodeOf(b.bone);
    if (node) out.set(name, node);
  }
  return out;
}

function moves(values: Float32Array, width: number, eps: number): boolean {
  for (let i = width; i < values.length; i += 1) if (Math.abs(values[i]! - values[i % width]!) > eps) return true;
  return false;
}

/** Keeps each quaternion in the hemisphere of the one before, so linear sampling never spins the long way. */
function continuous(values: Float32Array): Float32Array {
  const out = values.slice();
  for (let i = 4; i < out.length; i += 4) {
    const dot = out[i]! * out[i - 4]! + out[i + 1]! * out[i - 3]! + out[i + 2]! * out[i - 2]! + out[i + 3]! * out[i - 1]!;
    if (dot < 0) for (let k = 0; k < 4; k += 1) out[i + k] = -out[i + k]!;
  }
  return out;
}

interface Json {
  asset: { extras?: Record<string, unknown> } & Record<string, unknown>;
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
}

function patchJson(glb: Uint8Array, patch: (json: Json) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Json;
  patch(json);
  const text = JSON.stringify(json);
  const bytes = new TextEncoder().encode(text + ' '.repeat((4 - (Buffer.byteLength(text) % 4)) % 4));
  const rest = glb.subarray(20 + jsonLength);
  const out = new Uint8Array(20 + bytes.byteLength + rest.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.byteLength, true);
  v.setUint32(12, bytes.byteLength, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(bytes, 20);
  out.set(rest, 20 + bytes.byteLength);
  return out;
}
