/**
 * The acting report (docs/features/directed-performance.md, slice 0): reads
 * any hologram GLB, authored or captured, and says per performer (found by
 * skin) which bones and face shapes move and when, where the body is frozen,
 * and whether the fingers, face and eyes ever move.
 *
 *   node --conditions=development --import tsx scripts/authoring/acting-report.ts <take.glb> [--against <other.glb>] [--json <out.json>]
 *
 * `--against` compares two takes channel by channel and lists the spans where
 * they differ: revising one beat should change only that beat's span.
 *
 * A channel "changes" when any component leaves its first key by more than
 * the tolerance for its path (quaternion components, metres, weights); its
 * last change is the last key step above a twentieth of that. These are the
 * prototype's tolerances (output/directed-performance/liveness.py).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VRM_HUMANOID_BONES, type VrmHumanoidBone } from '@holoim/meaning';
import { findPerformers, parseGlb, readChannels, sampleChannel, targetNames, type Channel, type ChannelPath, type GltfDoc, type Performer } from './lib/gltf-read.ts';

export const TOLERANCE: Record<ChannelPath, number> = { rotation: 0.004, translation: 0.002, scale: 0.002, weights: 0.02 };
/** Shortest span reported as frozen. */
export const MIN_FROZEN_SEC = 1;
const SAMPLE_HZ = 30;

const FINGER = /(Thumb|Index|Middle|Ring|Little)/;
const EYE_BONES: readonly VrmHumanoidBone[] = ['leftEye', 'rightEye'];
const GAZE_SHAPE = /eyelook|lookup|lookdown|lookleft|lookright/i;

export interface ChannelChange {
  node: string;
  bone?: VrmHumanoidBone;
  path: ChannelPath;
  /** For weights: the morph target. */
  shape?: string;
  maxDelta: number;
  firstChangeSec: number;
  lastChangeSec: number;
}

export interface PerformerReport {
  name: string;
  declared: boolean;
  skins: number;
  joints: number;
  humanoidBones: number;
  channels: number;
  changing: number;
  lastChangeSec: number | null;
  bones: ChannelChange[];
  faceShapes: ChannelChange[];
  /** Morph targets the performer's meshes carry. */
  faceShapeCount: number;
  frozenSpans: { fromSec: number; toSec: number }[];
  frozenSec: number;
  fingers: { bones: number; moving: string[] };
  face: { shapes: number; moving: string[] };
  eyes: { by: 'bones' | 'morphs' | 'none'; moving: boolean };
  verdict: string[];
}

export interface ActingReport {
  file: string;
  generator: string | null;
  authored: unknown;
  durationSec: number;
  channels: number;
  changing: number;
  lastChangeSec: number | null;
  meshesWithMorphTargets: number;
  skins: number;
  performers: PerformerReport[];
  /** Channels on nodes outside every performer (props, cameras, the set). */
  scene: { channels: number; changing: number };
}

interface Analysed { ch: Channel; perTarget: { maxDelta: number; first: number; last: number }[] }

function analyse(ch: Channel): Analysed {
  const tol = TOLERANCE[ch.path];
  const { times, values, width } = ch;
  const n = times.length;
  // Weights are one channel but each target is its own face shape.
  const groups = ch.path === 'weights' ? Array.from({ length: width }, (_, k) => [k]) : [Array.from({ length: width }, (_, k) => k)];
  const perTarget = groups.map((comps) => {
    let maxDelta = 0;
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i += 1) {
      let d = 0;
      let step = 0;
      for (const k of comps) {
        d = Math.max(d, Math.abs(values[i * width + k]! - values[k]!));
        if (i + 1 < n) step = Math.max(step, Math.abs(values[(i + 1) * width + k]! - values[i * width + k]!));
      }
      maxDelta = Math.max(maxDelta, d);
      if (d > tol && first === -1) first = i;
      if (step > tol / 20) last = i + 1;
    }
    return { maxDelta, first: first === -1 ? -1 : times[first]!, last: first === -1 ? -1 : last === -1 ? 0 : times[last]! };
  });
  return { ch, perTarget };
}

const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** Maximal spans of at least MIN_FROZEN_SEC where every channel stays within tolerance of the span's start. */
function frozenSpans(channels: Channel[], duration: number): { fromSec: number; toSec: number }[] {
  const steps = Math.max(1, Math.round(duration * SAMPLE_HZ));
  const grid = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * duration);
  const samples = channels.map((ch) => {
    const out: Float64Array[] = [];
    const buf = new Float64Array(ch.width);
    for (const t of grid) out.push(Float64Array.from(sampleChannel(ch, t, buf)));
    return out;
  });
  const spans: { fromSec: number; toSec: number }[] = [];
  let start = 0;
  while (start < grid.length - 1) {
    let end = start;
    const lo = samples.map((s) => Float64Array.from(s[start]!));
    const hi = samples.map((s) => Float64Array.from(s[start]!));
    outer: for (let i = start + 1; i < grid.length; i += 1) {
      for (let c = 0; c < channels.length; c += 1) {
        const tol = TOLERANCE[channels[c]!.path];
        const v = samples[c]![i]!;
        for (let k = 0; k < v.length; k += 1) {
          const a = Math.min(lo[c]![k]!, v[k]!);
          const b = Math.max(hi[c]![k]!, v[k]!);
          if (b - a > tol) break outer;
          lo[c]![k] = a;
          hi[c]![k] = b;
        }
      }
      end = i;
    }
    if (grid[end]! - grid[start]! >= MIN_FROZEN_SEC - 1e-9) spans.push({ fromSec: round(grid[start]!, 2), toSec: round(grid[end]!, 2) });
    start = Math.max(end, start + 1);
  }
  return spans;
}

function durationOf(channels: Channel[]): number {
  return channels.reduce((d, ch) => Math.max(d, ch.times[ch.times.length - 1] ?? 0), 0);
}

export function actingReport(doc: GltfDoc, file: string): ActingReport {
  const json = doc.json;
  const nodes = json.nodes ?? [];
  const channels = readChannels(doc);
  const analysed = channels.map(analyse);
  const duration = durationOf(channels);
  const performers = findPerformers(doc);
  const ownerOf = (node: number): Performer | undefined => performers.find((p) => p.subtree.has(node));
  const moving = (a: Analysed): boolean => a.perTarget.some((t) => t.first !== -1);
  const lastOf = (list: Analysed[]): number | null => {
    const times = list.flatMap((a) => a.perTarget.filter((t) => t.first !== -1).map((t) => t.last));
    return times.length ? round(Math.max(...times), 2) : null;
  };

  const performerReports = performers.map((p): PerformerReport => {
    const mine = analysed.filter((a) => ownerOf(a.ch.node) === p);
    const boneOf = new Map<number, VrmHumanoidBone>();
    for (const b of VRM_HUMANOID_BONES) { const i = p.mapping.bones[b]; if (i !== undefined) boneOf.set(i, b); }
    const bones: ChannelChange[] = [];
    const faceShapes: ChannelChange[] = [];
    for (const a of mine) {
      const node = nodes[a.ch.node]?.name ?? `#${a.ch.node}`;
      if (a.ch.path === 'weights') {
        const mesh = nodes[a.ch.node]?.mesh;
        const names = mesh === undefined ? [] : targetNames(doc, mesh);
        a.perTarget.forEach((t, k) => {
          if (t.first === -1) return;
          faceShapes.push({ node, path: 'weights', shape: names[k] ?? `target${k}`, maxDelta: round(t.maxDelta), firstChangeSec: round(t.first, 2), lastChangeSec: round(t.last, 2) });
        });
        continue;
      }
      const t = a.perTarget[0]!;
      if (t.first === -1) continue;
      const bone = boneOf.get(a.ch.node);
      bones.push({ node, ...(bone ? { bone } : {}), path: a.ch.path, maxDelta: round(t.maxDelta), firstChangeSec: round(t.first, 2), lastChangeSec: round(t.last, 2) });
    }
    bones.sort((x, y) => x.firstChangeSec - y.firstChangeSec);
    faceShapes.sort((x, y) => x.firstChangeSec - y.firstChangeSec);

    const fingerBones = VRM_HUMANOID_BONES.filter((b) => FINGER.test(b) && p.mapping.bones[b] !== undefined);
    const fingerMoving = bones.filter((b) => b.bone && FINGER.test(b.bone)).map((b) => b.bone!);
    const morphMeshes = [...p.meshNodes].map((n) => nodes[n]!.mesh).filter((m): m is number => m !== undefined);
    const shapeCount = morphMeshes.reduce((s, m) => s + targetNames(doc, m).length, 0);
    const eyeBones = EYE_BONES.filter((b) => p.mapping.bones[b] !== undefined);
    const gazeShapes = morphMeshes.some((m) => targetNames(doc, m).some((n) => GAZE_SHAPE.test(n)));
    const eyesBy = eyeBones.length === 2 ? 'bones' : gazeShapes ? 'morphs' : 'none';
    const eyesMoving = bones.some((b) => b.bone && EYE_BONES.includes(b.bone)) || faceShapes.some((s) => GAZE_SHAPE.test(s.shape ?? ''));
    const frozen = frozenSpans(mine.map((a) => a.ch), duration);
    const frozenSec = round(frozen.reduce((s, f) => s + f.toSec - f.fromSec, 0), 2);
    const last = lastOf(mine);

    const verdict: string[] = [];
    if (!mine.some(moving)) verdict.push('never moves');
    if (frozenSec > 0) verdict.push(`frozen ${frozenSec} of ${round(duration, 1)} s`);
    if (last !== null && duration - last >= MIN_FROZEN_SEC) verdict.push(`nothing moves after ${last} s`);
    if (fingerBones.length === 0) verdict.push('no finger bones');
    else if (fingerMoving.length === 0) verdict.push('fingers never move');
    if (shapeCount === 0) verdict.push('no face shapes');
    else if (faceShapes.length === 0) verdict.push('face never moves');
    if (eyesBy === 'none') verdict.push('nothing turns the eyes');
    else if (!eyesMoving) verdict.push('eyes never move');

    return {
      name: p.name,
      declared: p.declared,
      skins: p.skins.length,
      joints: p.joints.size,
      humanoidBones: Object.keys(p.mapping.bones).length,
      channels: mine.length,
      changing: mine.filter(moving).length,
      lastChangeSec: last,
      bones,
      faceShapes,
      faceShapeCount: shapeCount,
      frozenSpans: frozen,
      frozenSec,
      fingers: { bones: fingerBones.length, moving: fingerMoving },
      face: { shapes: shapeCount, moving: [...new Set(faceShapes.map((s) => s.shape!))] },
      eyes: { by: eyesBy, moving: eyesMoving },
      verdict
    };
  });

  const sceneChannels = analysed.filter((a) => !ownerOf(a.ch.node));
  return {
    file,
    generator: json.asset?.generator ?? null,
    authored: (json.asset?.extras as { holoim?: { authored?: unknown } } | undefined)?.holoim?.authored ?? null,
    durationSec: round(duration, 3),
    channels: channels.length,
    changing: analysed.filter(moving).length,
    lastChangeSec: lastOf(analysed),
    meshesWithMorphTargets: (json.meshes ?? []).filter((m) => m.primitives.some((pr) => (pr.targets?.length ?? 0) > 0)).length,
    skins: (json.skins ?? []).length,
    performers: performerReports,
    scene: { channels: sceneChannels.length, changing: sceneChannels.filter(moving).length }
  };
}

// ---------------------------------------------------------------------------
// Comparing two takes
// ---------------------------------------------------------------------------

export interface TakeDiff {
  /** Spans (merged across channels) where the takes differ beyond tolerance. */
  spans: { fromSec: number; toSec: number; channels: number }[];
  /** Channels in only one of the takes. */
  unmatched: string[];
}

function channelKeys(doc: GltfDoc): Map<string, Channel> {
  const nodes = doc.json.nodes ?? [];
  const performers = findPerformers(doc);
  const out = new Map<string, Channel>();
  for (const ch of readChannels(doc)) {
    const p = performers.find((q) => q.subtree.has(ch.node));
    out.set(`${p ? `p${p.index}` : 'scene'}/${nodes[ch.node]?.name ?? ch.node}/${ch.path}`, ch);
  }
  return out;
}

/** Node index per `<performer>/<node name>` key, for every node. */
function nodeKeys(doc: GltfDoc): Map<string, number> {
  const performers = findPerformers(doc);
  const out = new Map<string, number>();
  (doc.json.nodes ?? []).forEach((n, i) => {
    const p = performers.find((q) => q.subtree.has(i));
    out.set(`${p ? `p${p.index}` : 'scene'}/${n.name ?? i}`, i);
  });
  return out;
}

/**
 * A take writes no channel for a node that never moves, so a channel present
 * in one take only is compared with that node's rest value in the other.
 */
function restChannel(doc: GltfDoc, keys: Map<string, number>, key: string, like: Channel): Channel | undefined {
  const node = keys.get(key.slice(0, key.lastIndexOf('/')));
  const n = node === undefined ? undefined : doc.json.nodes?.[node];
  if (!n || n.matrix) return undefined;
  const mesh = n.mesh === undefined ? undefined : (doc.json.meshes?.[n.mesh] as { weights?: number[] } | undefined);
  const rest = { rotation: n.rotation ?? [0, 0, 0, 1], translation: n.translation ?? [0, 0, 0], scale: n.scale ?? [1, 1, 1], weights: mesh?.weights ?? new Array<number>(like.width).fill(0) }[like.path];
  if (rest.length !== like.width) return undefined;
  return { ...like, node: node!, interpolation: 'STEP', times: new Float64Array([0]), values: Float64Array.from(rest) };
}

export function diffTakes(a: GltfDoc, b: GltfDoc): TakeDiff {
  const ka = channelKeys(a);
  const kb = channelKeys(b);
  const duration = Math.max(durationOf([...ka.values()]), durationOf([...kb.values()]));
  const steps = Math.max(1, Math.round(duration * SAMPLE_HZ));
  const differs = new Array<number>(steps + 1).fill(0);
  const na = nodeKeys(a);
  const nb = nodeKeys(b);
  const unmatched: string[] = [];
  const pairs: [string, Channel, Channel | undefined][] = [
    ...[...ka].map(([key, ca]): [string, Channel, Channel | undefined] => [key, ca, kb.get(key) ?? restChannel(b, nb, key, ca)]),
    ...[...kb].filter(([key]) => !ka.has(key)).map(([key, cb]): [string, Channel, Channel | undefined] => [key, cb, restChannel(a, na, key, cb)])
  ];
  for (const [key, ca, cb] of pairs) {
    if (!kb.has(key) || !ka.has(key)) unmatched.push(key);
    if (!cb || cb.width !== ca.width) continue;
    const tol = TOLERANCE[ca.path];
    const va = new Float64Array(ca.width);
    const vb = new Float64Array(cb.width);
    for (let i = 0; i <= steps; i += 1) {
      const t = (i / steps) * duration;
      sampleChannel(ca, t, va);
      sampleChannel(cb, t, vb);
      let d = 0;
      for (let k = 0; k < va.length; k += 1) d = Math.max(d, Math.abs(va[k]! - vb[k]!));
      if (d > tol) differs[i]! += 1;
    }
  }
  const spans: TakeDiff['spans'] = [];
  for (let i = 0; i <= steps; i += 1) {
    if (!differs[i]) continue;
    let j = i;
    let most = 0;
    while (j <= steps && differs[j]) { most = Math.max(most, differs[j]!); j += 1; }
    spans.push({ fromSec: round((i / steps) * duration, 2), toSec: round(((j - 1) / steps) * duration, 2), channels: most });
    i = j;
  }
  return { spans, unmatched };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function summarize(r: ActingReport): string {
  const lines = [
    `${r.file}: ${r.channels} channels over ${r.durationSec.toFixed(1)} s, ${r.changing} change` +
      (r.lastChangeSec !== null ? `, last change at ${r.lastChangeSec.toFixed(1)} s` : '') +
      ` | meshes with morph targets: ${r.meshesWithMorphTargets} | skins: ${r.skins}` +
      (r.authored ? ` | authored: ${String(r.authored)}` : '')
  ];
  if (r.performers.length === 0) lines.push('  no skinned performer: nothing here can be read as a body (unskinned figures count as scene)');
  for (const p of r.performers) {
    lines.push(`  ${p.name}${p.declared ? ' (declared)' : ''}: ${p.changing}/${p.channels} channels change` +
      (p.lastChangeSec !== null ? `, last at ${p.lastChangeSec.toFixed(1)} s` : '') +
      `; ${p.bones.length} bones, ${p.faceShapes.length}/${p.faceShapeCount} face shapes, fingers ${p.fingers.moving.length}/${p.fingers.bones}, eyes ${p.eyes.moving ? 'move' : 'still'} (${p.eyes.by})`);
    if (p.frozenSpans.length) lines.push(`    frozen: ${p.frozenSpans.map((s) => `${s.fromSec}-${s.toSec} s`).join(', ')}`);
    if (p.verdict.length) lines.push(`    ${p.verdict.join('; ')}`);
  }
  if (r.scene.channels) lines.push(`  scene: ${r.scene.changing}/${r.scene.channels} channels change`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const against = flag('--against');
  const jsonOut = flag('--json');
  const file = args[0];
  if (!file) {
    console.error('usage: acting-report.ts <take.glb> [--against <other.glb>] [--json <out.json>]');
    process.exit(2);
  }
  const doc = parseGlb(new Uint8Array(await readFile(file)));
  const report = actingReport(doc, basename(file));
  console.log(summarize(report));
  let diff: TakeDiff | undefined;
  if (against) {
    diff = diffTakes(parseGlb(new Uint8Array(await readFile(against))), doc);
    console.log(`  against ${basename(against)}: ${diff.spans.length ? diff.spans.map((s) => `${s.fromSec}-${s.toSec} s (${s.channels} ch)`).join(', ') : 'no difference'}` +
      (diff.unmatched.length ? `; ${diff.unmatched.length} channels in one take only` : ''));
  }
  if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(diff ? { ...report, against: { file: basename(against!), ...diff } } : report, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
