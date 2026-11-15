/**
 * Writes a solved take as one hologram GLB with gltf-transform: every
 * performer's own avatar file, merged, each under a wrapper node that carries
 * its stage placement; the first is `RecordedAvatar` and the only one declared
 * in `HOLOIM_humanoid`, exactly as a captured export does, so the viewer frames
 * and anchors on it. The published format is unchanged; the asset says the
 * take was authored, the way showcase pieces do.
 *
 * Each object the sheet declares is a unit-scale `RecordedObject` wrapper at
 * the scene root with its own position and rotation tracks (none when it
 * never moves), declared in `HOLOIM_objects` with the first performer's holds,
 * exactly as capture exports a grabbed object; a sourced model keeps its file
 * under a static child that scales it to size, and its credit rides on the
 * wrapper and in the asset's copyright.
 */
import { basename } from 'node:path';

import { Document, NodeIO, type Node as GNode } from '@gltf-transform/core';
import { dedup, mergeDocuments } from '@gltf-transform/functions';
import { assertHoloimObjects, formatCredit, HOLOIM_CREDIT_EXTRAS_KEY, HOLOIM_OBJECTS_EXTENSION, HOLOIM_OBJECTS_VERSION, RECORDED_OBJECT_NODE_NAME, type HoloimObjects } from '@holoim/objects';
import type * as THREE from 'three';

import type { PerformerTrack, PropTrack, SolvedTake } from './direct.ts';
import { partGeometry } from './props.ts';

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
  /** Node index of each object's wrapper. */
  readonly objects: { id: string; node: number }[];
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

  const objectNodes: { track: PropTrack; node: GNode }[] = [];
  for (const track of take.props) {
    const node = await writeObject(doc, io, scene, buffer, track, (node, path, values) => {
      const output = doc.createAccessor(`${track.prop.id}.${path}`).setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values)).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(times).setOutput(output).setInterpolation('LINEAR');
      animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
      channels += 1;
    });
    objectNodes.push({ track, node });
  }

  await doc.transform(dedup({ propertyTypes: ['Texture', 'Material'] }));
  let glb: Uint8Array = await io.writeBinary(doc);
  const nodes = doc.getRoot().listNodes();
  const duration = take.times[take.times.length - 1] ?? 0;
  const first = take.tracks[0]?.spec.id;
  const objects: HoloimObjects | undefined = objectNodes.length ? assertHoloimObjects({
    version: HOLOIM_OBJECTS_VERSION,
    objects: objectNodes.map(({ track, node }) => ({
      node: nodes.indexOf(node),
      name: track.prop.name,
      origin: 'prepared',
      source: { name: sourceName(track.prop.spec.source) ?? `sheet:${track.prop.id}`, ...(track.prop.source ? { sha256: track.prop.source.loaded.sha256 } : {}) },
      presence: [{ start: 0, end: round3(duration) }],
      // HOLOIM_objects holds are the recorded avatar's: the first performer's.
      holds: track.holdings.filter((h) => h.performer === first).map((h) => ({ hand: h.side, start: round3(h.from), end: round3(Math.min(h.to, duration)) }))
    }))
  }) : undefined;
  const credits = [...new Set(take.props.flatMap((t) => (t.prop.credit ? [formatCredit(t.prop.credit)] : [])))];
  glb = patchJson(glb, (json) => {
    const sources = [...new Map(take.props.flatMap((t) => (t.prop.source ? [[t.prop.source.loaded.name, { source: t.prop.source.loaded.name, sha256: t.prop.source.loaded.sha256, ...(t.prop.source.loaded.fetchedFrom ? { fetchedFrom: t.prop.source.loaded.fetchedFrom } : {}) }] as const] : []))).values()];
    json.asset = { ...json.asset, extras: { ...(json.asset.extras ?? {}), holoim: { authored: 'synthetic', ...provenance, ...(sources.length ? { sources } : {}) } } };
    // mergeDocuments drops a source's asset fields, so the credits are written here.
    if (credits.length) json.asset.copyright = credits.join('; ');
    if (objects) {
      json.extensions = { ...(json.extensions ?? {}), [HOLOIM_OBJECTS_EXTENSION]: objects };
      json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), HOLOIM_OBJECTS_EXTENSION])];
    }
    if (humanBones && humanBones.size) {
      json.extensions = { ...(json.extensions ?? {}), [HUMANOID]: { humanBones: Object.fromEntries([...humanBones].map(([b, n]) => [b, { node: nodes.indexOf(n) }])) } };
      json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), HUMANOID])];
    }
  });
  return { glb, channels, performers: wrappers.map((w) => ({ id: w.id, node: nodes.indexOf(w.node), name: w.name })), objects: objectNodes.map((o) => ({ id: o.track.prop.id, node: nodes.indexOf(o.node) })) };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** A source as published: a Poly Haven id, or a local file's name only, never the author's path. */
const sourceName = (source: string | undefined): string | undefined => (source === undefined || source.startsWith('polyhaven:') ? source : basename(source));

/** One object: its wrapper (rest pose = first frame; tracks only if it moves), and its parts or its source model. */
async function writeObject(doc: Document, io: NodeIO, scene: ReturnType<Document['createScene']>, buffer: ReturnType<Document['createBuffer']>, track: PropTrack, add: (node: GNode, path: 'translation' | 'rotation', values: Float32Array) => void): Promise<GNode> {
  const { prop } = track;
  const wrapper = doc.createNode(RECORDED_OBJECT_NODE_NAME)
    .setTranslation(Array.from(track.position.subarray(0, 3)) as [number, number, number])
    .setRotation(Array.from(track.rotation.subarray(0, 4)) as [number, number, number, number]);
  if (prop.credit) wrapper.setExtras({ [HOLOIM_CREDIT_EXTRAS_KEY]: prop.credit });
  scene.addChild(wrapper);
  if (moves(track.position, 3, EPS_TRANSLATION)) add(wrapper, 'translation', track.position);
  if (moves(track.rotation, 4, EPS_ROTATION)) add(wrapper, 'rotation', continuous(track.rotation));

  if (prop.source) {
    const src = await io.readBinary(new Uint8Array(prop.source.loaded.bytes));
    for (const a of src.getRoot().listAnimations()) a.dispose();
    const srcScene = src.getRoot().getDefaultScene() ?? src.getRoot().listScenes()[0]!;
    const roots = srcScene.listChildren();
    const map = mergeDocuments(doc, src);
    for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();
    for (const b of doc.getRoot().listBuffers()) if (b !== buffer) b.dispose();
    for (const a of doc.getRoot().listAccessors()) a.setBuffer(buffer);
    const model = doc.createNode(`${prop.id}-model`)
      .setScale([prop.source.scale, prop.source.scale, prop.source.scale])
      .setTranslation(prop.source.offset.toArray() as [number, number, number]);
    wrapper.addChild(model);
    for (const r of roots) model.addChild(map.get(r) as GNode);
    return wrapper;
  }

  const mesh = doc.createMesh(prop.id);
  for (const [i, part] of prop.parts.entries()) {
    const g = partGeometry(part);
    const position = g.getAttribute('position')!.array as Float32Array;
    const normal = g.getAttribute('normal')!.array as Float32Array;
    const index = g.getIndex()!.array;
    const material = doc.createMaterial(`${prop.id}-${part.name ?? i}`).setBaseColorFactor([...part.color, 1] as [number, number, number, number]).setRoughnessFactor(0.8).setMetallicFactor(0);
    const primitive = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(position)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(normal)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(index)).setBuffer(buffer))
      .setMaterial(material);
    mesh.addPrimitive(primitive);
    g.dispose();
  }
  wrapper.addChild(doc.createNode(prop.id).setMesh(mesh));
  return wrapper;
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
