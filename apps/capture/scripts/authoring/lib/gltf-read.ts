/**
 * Reads a hologram GLB without three.js: accessors, animation channels, and
 * the performers in it. Only one performer is ever declared in a file
 * (`HOLOIM_humanoid`), so performers are found by skin: skins that share a
 * joint belong to one body, and each body is resolved on its own subtree.
 */
import { readHumanoidDeclaration, resolveHumanoidRig, type HumanoidMapping, type HumanoidNodeCandidate } from '@holoim/meaning';
import { readGlb, type GltfJson } from '../../lib/avatar-fixtures.ts';

export interface GltfDoc {
  readonly json: GltfJson & {
    accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; sparse?: unknown }[];
    bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
    meshes?: { name?: string; extras?: { targetNames?: string[] }; primitives: { attributes: Record<string, number>; targets?: unknown[] }[] }[];
    animations?: { name?: string; channels: { sampler: number; target: { node?: number; path: string } }[]; samplers: { input: number; output: number; interpolation?: string }[] }[];
    asset?: { generator?: string; extras?: Record<string, unknown> };
  };
  readonly bin: Uint8Array;
}

const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGlb(bytes: Uint8Array): GltfDoc {
  return readGlb(bytes) as GltfDoc;
}

/** Accessor as rows of floats (normalized integers scaled as glTF says). */
export function readAccessor(doc: GltfDoc, index: number): { data: Float64Array; size: number; count: number } {
  const acc = doc.json.accessors![index]!;
  if (acc.sparse) throw new Error(`accessor ${index} is sparse; not supported`);
  const size = TYPE_SIZE[acc.type]!;
  const count = acc.count;
  const data = new Float64Array(count * size);
  if (acc.bufferView === undefined) return { data, size, count };
  const bv = doc.json.bufferViews![acc.bufferView]!;
  const view = new DataView(doc.bin.buffer, doc.bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0));
  const bytes = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[acc.componentType]!;
  const stride = bv.byteStride ?? bytes * size;
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < size; k += 1) {
      const at = i * stride + k * bytes;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = view.getFloat32(at, true); break;
        case 5121: v = view.getUint8(at); if (acc.normalized) v /= 255; break;
        case 5123: v = view.getUint16(at, true); if (acc.normalized) v /= 65535; break;
        case 5125: v = view.getUint32(at, true); break;
        case 5120: v = view.getInt8(at); if (acc.normalized) v = Math.max(v / 127, -1); break;
        case 5122: v = view.getInt16(at, true); if (acc.normalized) v = Math.max(v / 32767, -1); break;
        default: throw new Error(`componentType ${acc.componentType}`);
      }
      data[i * size + k] = v;
    }
  }
  return { data, size, count };
}

export type ChannelPath = 'rotation' | 'translation' | 'scale' | 'weights';

export interface Channel {
  readonly animation: number;
  readonly node: number;
  readonly path: ChannelPath;
  readonly interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  readonly times: Float64Array;
  /** Rows of `width` values, one per key (CUBICSPLINE tangents dropped). */
  readonly values: Float64Array;
  readonly width: number;
}

export function readChannels(doc: GltfDoc): Channel[] {
  const out: Channel[] = [];
  (doc.json.animations ?? []).forEach((anim, a) => {
    for (const ch of anim.channels) {
      if (ch.target.node === undefined) continue;
      const sampler = anim.samplers[ch.sampler]!;
      const input = readAccessor(doc, sampler.input);
      const output = readAccessor(doc, sampler.output);
      const interpolation = (sampler.interpolation ?? 'LINEAR') as Channel['interpolation'];
      const keys = input.count;
      const cubic = interpolation === 'CUBICSPLINE';
      const total = output.data.length;
      const width = total / keys / (cubic ? 3 : 1);
      let values = output.data;
      if (cubic) {
        values = new Float64Array(keys * width);
        for (let i = 0; i < keys; i += 1) values.set(output.data.subarray((i * 3 + 1) * width, (i * 3 + 2) * width), i * width);
      }
      if (ch.target.path === 'rotation') alignHemispheres(values);
      out.push({ animation: a, node: ch.target.node, path: ch.target.path as ChannelPath, interpolation, times: input.data, values, width });
    }
  });
  return out;
}

/** q and -q are one rotation: keep each key on the first key's side (then its neighbour's). */
function alignHemispheres(values: Float64Array): void {
  for (let i = 4; i < values.length; i += 4) {
    const dot = values[i]! * values[i - 4]! + values[i + 1]! * values[i - 3]! + values[i + 2]! * values[i - 2]! + values[i + 3]! * values[i - 1]!;
    if (dot < 0) for (let k = 0; k < 4; k += 1) values[i + k] = -values[i + k]!;
  }
}

/** Channel value at `t` (LINEAR is component-wise, which is what the report needs for change detection). */
export function sampleChannel(ch: Channel, t: number, out: Float64Array): Float64Array {
  const { times, values, width } = ch;
  const n = times.length;
  if (t <= times[0]! || n === 1) { out.set(values.subarray(0, width)); return out; }
  if (t >= times[n - 1]!) { out.set(values.subarray((n - 1) * width, n * width)); return out; }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid]! <= t) lo = mid; else hi = mid; }
  if (ch.interpolation === 'STEP') { out.set(values.subarray(lo * width, (lo + 1) * width)); return out; }
  const f = (t - times[lo]!) / (times[hi]! - times[lo]!);
  for (let k = 0; k < width; k += 1) out[k] = values[lo * width + k]! * (1 - f) + values[hi * width + k]! * f;
  return out;
}

// ---------------------------------------------------------------------------
// Performers
// ---------------------------------------------------------------------------

export interface Performer {
  readonly index: number;
  /** The highest node that holds this body and no other. */
  readonly root: number;
  readonly name: string;
  readonly skins: number[];
  readonly joints: Set<number>;
  readonly meshNodes: Set<number>;
  /** Every node under `root`. */
  readonly subtree: Set<number>;
  readonly mapping: HumanoidMapping;
  readonly declared: boolean;
}

export function parents(json: GltfJson): Int32Array {
  const nodes = json.nodes ?? [];
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => { for (const c of n.children ?? []) parent[c] = i; });
  return parent;
}

function subtreeOf(json: GltfJson, root: number): Set<number> {
  const out = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const i = stack.pop()!;
    out.add(i);
    for (const c of json.nodes![i]!.children ?? []) stack.push(c);
  }
  return out;
}

export function findPerformers(doc: GltfDoc): Performer[] {
  const json = doc.json;
  const nodes = json.nodes ?? [];
  const skins = json.skins ?? [];
  // Union skins that share a joint.
  const group = skins.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
  const owner = new Map<number, number>();
  skins.forEach((s, i) => {
    for (const j of s.joints) {
      const o = owner.get(j);
      if (o === undefined) owner.set(j, i);
      else group[find(i)] = find(o);
    }
  });
  const bodies = new Map<number, { skins: number[]; joints: Set<number>; meshNodes: Set<number> }>();
  skins.forEach((s, i) => {
    const g = find(i);
    const body = bodies.get(g) ?? { skins: [], joints: new Set<number>(), meshNodes: new Set<number>() };
    body.skins.push(i);
    for (const j of s.joints) body.joints.add(j);
    bodies.set(g, body);
  });
  nodes.forEach((n, i) => {
    if (n.skin === undefined) return;
    bodies.get(find(n.skin))?.meshNodes.add(i);
  });
  // Bodies that are only a prop (fewer than 10 joints) are not performers.
  const list = [...bodies.values()].filter((b) => b.joints.size >= 10);
  const parent = parents(json);
  const ancestors = (i: number): number[] => { const out: number[] = []; for (let p = i; p !== -1; p = parent[p]!) out.push(p); return out; };
  const allOf = list.map((b) => new Set([...b.joints, ...b.meshNodes]));
  const declaration = readHumanoidDeclaration(json);
  const declaredNodes = new Set(Object.values(declaration?.bones ?? {}).filter((v): v is number => typeof v === 'number'));

  const performers = list.map((body, index) => {
    const mine = allOf[index]!;
    // Lowest common ancestor of the joints, then up while no other body is inside.
    const chains = [...body.joints].map((j) => ancestors(j).reverse());
    let lca = -1;
    for (let d = 0; ; d += 1) {
      const at = chains[0]![d];
      if (at === undefined || chains.some((c) => c[d] !== at)) break;
      lca = at;
    }
    if (lca === -1) lca = [...body.joints][0]!;
    let root = lca;
    for (let p = parent[root]!; p !== -1; p = parent[p]!) {
      const sub = subtreeOf(json, p);
      if (allOf.some((other, k) => k !== index && [...other].some((n) => sub.has(n)))) break;
      root = p;
    }
    const subtree = subtreeOf(json, root);
    for (const m of body.meshNodes) for (const a of ancestors(m)) subtree.add(a);
    const candidates: HumanoidNodeCandidate[] = [];
    const seen = new Set<number>();
    for (const j of body.joints) { seen.add(j); candidates.push({ name: nodes[j]?.name ?? '', index: j, isJoint: true }); }
    for (const n of subtree) if (!seen.has(n) && mine.has(n) === false) candidates.push({ name: nodes[n]?.name ?? '', index: n, isJoint: false });
    const declared = [...declaredNodes].some((n) => body.joints.has(n));
    const mapping = resolveHumanoidRig(candidates, declared ? declaration : undefined);
    return { index, root, name: nodes[root]?.name ?? `#${root}`, skins: body.skins, joints: body.joints, meshNodes: body.meshNodes, subtree, mapping, declared };
  });
  // File order: the declared performer first, then by root index.
  return performers.sort((a, b) => Number(b.declared) - Number(a.declared) || a.root - b.root).map((p, index) => ({ ...p, index }));
}

export function targetNames(doc: GltfDoc, meshIndex: number): string[] {
  const mesh = doc.json.meshes![meshIndex]!;
  const count = mesh.primitives[0]?.targets?.length ?? 0;
  const names = mesh.extras?.targetNames ?? [];
  return Array.from({ length: count }, (_, i) => names[i] ?? `target${i}`);
}
