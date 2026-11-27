/**
 * Writes a solved take as one hologram GLB with gltf-transform: every
 * performer's own avatar file, merged, each under a wrapper node that carries
 * its stage placement; the first is `RecordedAvatar` and the only one declared
 * in `HOLOIM_humanoid`, exactly as a captured export does, so the viewer frames
 * and anchors on it. The published format is unchanged; the asset says the
 * take was authored, the way showcase pieces do, and (`looks`) the look card of
 * each house-base performer given one (one without wears base.json's
 * `defaultLook`, which is not repeated here) and its finish when not clay.
 *
 * Each object the sheet declares is a unit-scale `RecordedObject` wrapper at
 * the scene root with its own position and rotation tracks (none when it
 * never moves), declared in `HOLOIM_objects` with the first performer's holds,
 * exactly as capture exports a grabbed object; a sourced model keeps its file
 * under a static child that scales it to size, and its credit rides on the
 * wrapper and in the asset's copyright.
 */
import { basename } from 'node:path';

import { Document, NodeIO, type Accessor as GAccessor, type Node as GNode } from '@gltf-transform/core';
import { dedup, mergeDocuments } from '@gltf-transform/functions';
import * as THREE from 'three';
import { assertHoloimObjects, formatCredit, HOLOIM_CREDIT_EXTRAS_KEY, HOLOIM_OBJECTS_EXTENSION, HOLOIM_OBJECTS_VERSION, RECORDED_OBJECT_NODE_NAME, type HoloimObjects } from '@holoim/objects';

import { houseFinish } from './beats.ts';
import type { PerformerTrack, PropTrack, SolvedTake } from './direct.ts';
import { partGeometry } from './props.ts';
import type { Effect, Keys, ObjectChange, SolvedWorld } from './world.ts';

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
  /** Node index of each performer's head bone, where a voice is heard from. */
  readonly heads: { id: string; node: number }[];
  /** Node index of each object's wrapper. */
  readonly objects: { id: string; node: number }[];
}

export async function writeTake(take: SolvedTake, provenance: Provenance, world?: SolvedWorld): Promise<WrittenTake> {
  const io = new NodeIO();
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  const animation = doc.createAnimation('Take');
  const times = doc.createAccessor('time').setType('SCALAR').setArray(new Float32Array(take.times)).setBuffer(buffer);
  let channels = 0;
  const wrappers: { id: string; node: GNode; name: string }[] = [];
  const heads: { id: string; node: GNode }[] = [];
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
    const headBone = track.avatar.bind.get('head')?.bone;
    const headNode = headBone ? nodeOf(headBone) : undefined;
    if (headNode) heads.push({ id: track.spec.id, node: headNode });
  }

  /** A track on its own key times (a world change's), stepping or linear. */
  const keyed: Keyed = (node, path, input, values, interpolation = 'LINEAR') => {
    const output = doc.createAccessor(`${node.getName()}.${path}`).setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(interpolation);
    animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
    channels += 1;
  };
  const keyTimes = (values: Float32Array): GAccessor => doc.createAccessor('time').setType('SCALAR').setArray(new Float32Array(values)).setBuffer(buffer);
  const duration = take.times[take.times.length - 1] ?? 0;
  /** Presence as a STEP scale track on a node: 0 outside the spans. Nothing when present all through. */
  const presenceTrack = (node: GNode, spans: readonly { start: number; end: number }[]): void => {
    // Spans are rounded to the millisecond and the take's times are float32: an end within 1 ms of the last frame is the end.
    const toEnd = (end: number): boolean => end >= duration - 1e-3;
    if (spans.length === 1 && spans[0]!.start <= 0 && toEnd(spans[0]!.end)) return;
    const keys: [number, number][] = [[0, 0]];
    for (const sp of spans) { keys.push([sp.start, 1]); if (!toEnd(sp.end)) keys.push([sp.end, 0]); }
    // A later key at the same time wins (an object present from 0).
    const merged = keys.filter((k, i) => !(keys[i + 1] && keys[i + 1]![0] === k[0]));
    node.setScale(merged[0]![1] ? [1, 1, 1] : [0, 0, 0]);
    keyed(node, 'scale', keyTimes(new Float32Array(merged.map((k) => k[0]))), new Float32Array(merged.flatMap((k) => [k[1], k[1], k[1]])), 'STEP');
  };

  const objectNodes: { track: PropTrack; node: GNode; change?: ObjectChange }[] = [];
  for (const track of take.props) {
    const change = world?.changes.get(track.prop.id);
    const node = await writeObject(doc, io, scene, buffer, track, (node, path, values) => {
      const output = doc.createAccessor(`${track.prop.id}.${path}`).setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values)).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(times).setOutput(output).setInterpolation('LINEAR');
      animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
      channels += 1;
    }, change && { change, keyed, keyTimes, times, presenceTrack });
    objectNodes.push({ track, node, ...(change ? { change } : {}) });
  }
  const effectNodes: { effect: Effect; node: GNode }[] = [];
  for (const effect of world?.effects ?? []) {
    if (!effect.nodes.length) continue;
    effectNodes.push({ effect, node: writeEffect(doc, scene, buffer, effect, keyed, keyTimes, presenceTrack) });
  }

  await doc.transform(dedup({ propertyTypes: ['Texture', 'Material'] }));
  let glb: Uint8Array = await io.writeBinary(doc);
  const nodes = doc.getRoot().listNodes();
  const first = take.tracks[0]?.spec.id;
  const objects: HoloimObjects | undefined = objectNodes.length || effectNodes.length ? assertHoloimObjects({
    version: HOLOIM_OBJECTS_VERSION,
    objects: [...objectNodes.map(({ track, node, change }) => ({
      node: nodes.indexOf(node),
      name: track.prop.name,
      origin: 'prepared',
      source: { name: sourceName(track.prop.spec.source) ?? `sheet:${track.prop.id}`, ...(track.prop.source ? { sha256: track.prop.source.loaded.sha256 } : {}) },
      presence: change?.presence ?? [{ start: 0, end: round3(duration) }],
      // HOLOIM_objects holds are the recorded avatar's: the first performer's. A short window (a pose look) leaves out
      // the holds that start after its last frame.
      holds: track.holdings.filter((h) => h.performer === first && h.from <= duration).map((h) => ({ hand: h.side, start: round3(h.from), end: round3(Math.min(h.to, duration)) }))
    })), ...effectNodes.map(({ effect, node }) => ({
      node: nodes.indexOf(node),
      name: effect.name,
      // Placed during the take, by the direction rather than a hand.
      origin: 'summoned' as const,
      source: { name: `effect:${effect.kind}` },
      presence: effect.presence,
      holds: []
    }))]
  }) : undefined;
  const credits = [...new Set(take.props.flatMap((t) => (t.prop.credit ? [formatCredit(t.prop.credit)] : [])))];
  glb = patchJson(glb, (json) => {
    const sources = [...new Map(take.props.flatMap((t) => (t.prop.source ? [[t.prop.source.loaded.name, { source: t.prop.source.loaded.name, sha256: t.prop.source.loaded.sha256, ...(t.prop.source.loaded.fetchedFrom ? { fetchedFrom: t.prop.source.loaded.fetchedFrom } : {}) }] as const] : []))).values()];
    // The look card of each house-base performer given one, so the take says how its people were dressed.
    const looks = take.tracks.flatMap((t) => {
      const finish = houseFinish(t.spec.avatar);
      return t.spec.look || (finish && finish !== 'clay') ? [{ performer: t.spec.id, ...(t.spec.look ? { look: t.spec.look } : {}), ...(finish && finish !== 'clay' ? { finish } : {}) }] : [];
    });
    json.asset = { ...json.asset, extras: { ...(json.asset.extras ?? {}), holoim: { authored: 'synthetic', ...provenance, ...(sources.length ? { sources } : {}), ...(looks.length ? { looks } : {}) } } };
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
  return { glb, channels, performers: wrappers.map((w) => ({ id: w.id, node: nodes.indexOf(w.node), name: w.name })), heads: heads.map((h) => ({ id: h.id, node: nodes.indexOf(h.node) })), objects: objectNodes.map((o) => ({ id: o.track.prop.id, node: nodes.indexOf(o.node) })) };
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** A source as published: a Poly Haven id, or a local file's name only, never the author's path. */
const sourceName = (source: string | undefined): string | undefined => (source === undefined || source.startsWith('polyhaven:') ? source : basename(source));

/** One object: its wrapper (rest pose = first frame; tracks only if it moves), and its parts or its source model. */
type Keyed = (node: GNode, path: 'translation' | 'rotation' | 'scale', input: GAccessor, values: Float32Array, interpolation?: 'LINEAR' | 'STEP') => void;

/** What a world change needs to write an object's response. */
interface ChangeWriter {
  readonly change: ObjectChange;
  readonly keyed: Keyed;
  readonly keyTimes: (values: Float32Array) => GAccessor;
  readonly times: GAccessor;
  readonly presenceTrack: (node: GNode, spans: readonly { start: number; end: number }[]) => void;
}

async function writeObject(doc: Document, io: NodeIO, scene: ReturnType<Document['createScene']>, buffer: ReturnType<Document['createBuffer']>, track: PropTrack, add: (node: GNode, path: 'translation' | 'rotation', values: Float32Array) => void, cw?: ChangeWriter): Promise<GNode> {
  const { prop } = track;
  const wrapper = doc.createNode(RECORDED_OBJECT_NODE_NAME)
    .setTranslation(Array.from(track.position.subarray(0, 3)) as [number, number, number])
    .setRotation(Array.from(track.rotation.subarray(0, 4)) as [number, number, number, number]);
  if (prop.credit) wrapper.setExtras({ [HOLOIM_CREDIT_EXTRAS_KEY]: prop.credit });
  scene.addChild(wrapper);
  if (moves(track.position, 3, EPS_TRANSLATION)) add(wrapper, 'translation', track.position);
  if (moves(track.rotation, 4, EPS_ROTATION)) add(wrapper, 'rotation', continuous(track.rotation));
  // A changing object's shape hangs from a node of its own between the wrapper and the shape (slice 1f).
  let holder = wrapper;
  if (cw) {
    if (cw.change.presence) cw.presenceTrack(wrapper, cw.change.presence);
    const pose = cw.change.pose;
    holder = doc.createNode(`${prop.id}-change`);
    wrapper.addChild(holder);
    if (pose) {
      holder.setTranslation(Array.from(pose.translation.subarray(0, 3)) as [number, number, number])
        .setRotation(Array.from(pose.rotation.subarray(0, 4)) as [number, number, number, number])
        .setScale(Array.from(pose.scale.subarray(0, 3)) as [number, number, number]);
      if (moves(pose.translation, 3, EPS_TRANSLATION)) cw.keyed(holder, 'translation', cw.times, pose.translation);
      if (moves(pose.rotation, 4, EPS_ROTATION)) cw.keyed(holder, 'rotation', cw.times, continuous(pose.rotation));
      if (moves(pose.scale, 3, EPS_TRANSLATION)) cw.keyed(holder, 'scale', cw.times, pose.scale);
    }
  }

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
    holder.addChild(model);
    for (const r of roots) model.addChild(map.get(r) as GNode);
    return wrapper;
  }

  // One copy of the shape per colour it takes; a copy shows (STEP scale) only in its spans.
  const variants = cw?.change.variants ?? [{ colors: prop.parts.map((p) => p.color), spans: [] as [number, number][] }];
  const geometry = prop.parts.map((part) => {
    const g = partGeometry(part);
    const out = {
      position: doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.getAttribute('position')!.array as Float32Array)).setBuffer(buffer),
      normal: doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.getAttribute('normal')!.array as Float32Array)).setBuffer(buffer),
      index: doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(g.getIndex()!.array)).setBuffer(buffer)
    };
    g.dispose();
    return out;
  });
  for (const [k, variant] of variants.entries()) {
    const suffix = k === 0 ? '' : `-${k + 1}`;
    const mesh = doc.createMesh(`${prop.id}${suffix}`);
    for (const [i, part] of prop.parts.entries()) {
      const material = doc.createMaterial(`${prop.id}-${part.name ?? i}${suffix}`).setBaseColorFactor([...variant.colors[i]!, 1] as [number, number, number, number]).setRoughnessFactor(0.8).setMetallicFactor(0);
      mesh.addPrimitive(doc.createPrimitive()
        .setAttribute('POSITION', geometry[i]!.position).setAttribute('NORMAL', geometry[i]!.normal).setIndices(geometry[i]!.index)
        .setMaterial(material));
    }
    const node = doc.createNode(`${prop.id}${suffix}`).setMesh(mesh);
    holder.addChild(node);
    if (cw && variants.length > 1) cw.presenceTrack(node, variant.spans.map(([start, end]) => ({ start, end })));
  }
  return wrapper;
}

const SPHERE = (): THREE.BufferGeometry => new THREE.SphereGeometry(0.5, 10, 7);
const DISC = (): THREE.BufferGeometry => new THREE.CylinderGeometry(0.5, 0.5, 0.002, 32).translate(0, 0.001, 0);

/** A pour, burst or drift: a summoned wrapper at the origin, present in its spans, with one keyed node per mote sharing a mesh per colour. */
function writeEffect(doc: Document, scene: ReturnType<Document['createScene']>, buffer: ReturnType<Document['createBuffer']>, effect: Effect, keyed: Keyed, keyTimes: (v: Float32Array) => GAccessor, presenceTrack: (node: GNode, spans: readonly { start: number; end: number }[]) => void): GNode {
  const wrapper = doc.createNode(RECORDED_OBJECT_NODE_NAME);
  scene.addChild(wrapper);
  presenceTrack(wrapper, effect.presence);
  const meshes = new Map<string, ReturnType<Document['createMesh']>>();
  const meshFor = (shape: 'sphere' | 'disc', color: readonly [number, number, number]): ReturnType<Document['createMesh']> => {
    const key = `${shape}:${color.join(',')}`;
    const hit = meshes.get(key);
    if (hit) return hit;
    const g = shape === 'sphere' ? SPHERE() : DISC();
    const material = doc.createMaterial(`${effect.id}-${meshes.size + 1}`).setBaseColorFactor([...color, 1] as [number, number, number, number]).setRoughnessFactor(shape === 'sphere' ? 0.25 : 0.95).setMetallicFactor(0);
    // A pour's drops glow in their own colour, so the side away from the key light stays pale instead of going grey on the card's teal; other effects stay lit.
    if (effect.kind === 'pour') material.setEmissiveFactor(color as [number, number, number]);
    const mesh = doc.createMesh(`${effect.id}-${shape}`).addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.getAttribute('position')!.array as Float32Array)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.getAttribute('normal')!.array as Float32Array)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(g.getIndex()!.array)).setBuffer(buffer))
      .setMaterial(material));
    g.dispose();
    meshes.set(key, mesh);
    return mesh;
  };
  for (const n of effect.nodes) {
    const node = doc.createNode(n.name).setMesh(meshFor(n.shape, n.color));
    wrapper.addChild(node);
    const k: Keys = n.keys;
    if (k.translation) node.setTranslation(Array.from(k.translation.subarray(0, 3)) as [number, number, number]);
    if (k.rotation) node.setRotation(Array.from(k.rotation.subarray(0, 4)) as [number, number, number, number]);
    if (k.scale) node.setScale(Array.from(k.scale.subarray(0, 3)) as [number, number, number]);
    const input = keyTimes(k.times);
    if (k.translation) keyed(node, 'translation', input, k.translation);
    if (k.rotation) keyed(node, 'rotation', input, k.rotation);
    if (k.scale) keyed(node, 'scale', input, k.scale);
  }
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
