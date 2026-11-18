/**
 * Change in the set (slice 1f), computed after the solve from the objects'
 * tracks: water poured from a held tool's tip, particles, and an object
 * responding over time. Everything is plain node animation (translation,
 * rotation, scale; a scale of 0 is absence), which the viewer's mixer plays
 * and the USDZ converter bakes, so it reaches Quick Look; a colour change is
 * a swap between whole-object copies, since no material is animated.
 */
import * as THREE from 'three';

import { aimTargetOf, cueTime, holdingsOf, type BeatSheet, type ChangeState, type Color, type Point, type WorldChange } from './beats.ts';
import type { PropTrack, SolvedTake } from './direct.ts';
import { parseColor } from './props.ts';

const DEG = Math.PI / 180;
const G = 9.81;
const WATER = '#b4e2ff'; // light enough to stand off the card's teal
const SPARK = '#ffd877';
const MOTE = '#f4f0d8';

type Rgb = readonly [number, number, number];

/** Keyed motion for one node, on its own key times (seconds); a path left out stays at rest. */
export interface Keys {
  readonly times: Float32Array;
  readonly translation?: Float32Array;
  readonly rotation?: Float32Array;
  readonly scale?: Float32Array;
}

/** One mesh node of an effect: a unit shape (a sphere 1 across, or a disc 1 across and 2 mm thick), its colour and its keys; it rests at its first key. */
export interface EffectNode {
  readonly name: string;
  readonly shape: 'sphere' | 'disc';
  /** Linear RGB. */
  readonly color: Rgb;
  readonly keys: Keys;
}

/** A pour, burst or drift: one summoned object of its own, present while its motes are. */
export interface Effect {
  readonly id: string;
  readonly kind: 'pour' | 'burst' | 'drift';
  readonly name: string;
  readonly presence: { start: number; end: number }[];
  readonly nodes: EffectNode[];
}

/** How an object's shape changes: a node between its wrapper and its shape, colour copies, presence spans. */
export interface ObjectChange {
  readonly object: string;
  /** Per take frame, when the shape changes: the change node's local pose. */
  readonly pose?: { translation: Float32Array; rotation: Float32Array; scale: Float32Array };
  /** Each set of part colours (linear RGB) and when it shows, [start, end) seconds; one entry when the colour never changes. */
  readonly variants: { colors: Rgb[]; spans: [number, number][] }[];
  /** Undefined when present all through. */
  readonly presence?: { start: number; end: number }[];
}

export interface SolvedWorld {
  readonly effects: Effect[];
  readonly changes: Map<string, ObjectChange>;
  /** One line per change, for the build printout. */
  readonly lines: string[];
}

type Full = { turn: readonly [number, number, number]; scale: number | readonly [number, number, number]; lift: number; color?: Color };

/** mulberry32: a seeded stream per change, so one change's motes never move when another is added. */
function stream(salt: number): () => number {
  let s = Math.imul(salt + 1, 0x9e3779b1) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Quintic ease. */
const smoother = (x: number): number => { const t = Math.min(1, Math.max(0, x)); return t * t * t * (t * (6 * t - 15) + 10); };
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const sameColors = (a: readonly Rgb[], b: readonly Rgb[]): boolean => a.every((c, i) => c.every((x, k) => x === b[i]![k]));

interface Flight { readonly from: THREE.Vector3; readonly to: THREE.Vector3; readonly vy: number; readonly te: number; readonly T: number }

export function solveWorld(sheet: BeatSheet, take: SolvedTake): SolvedWorld {
  const effects: Effect[] = [];
  const changes = new Map<string, ObjectChange>();
  const lines: string[] = [];
  const world = sheet.world ?? [];
  if (!world.length) return { effects, changes, lines };
  const duration = take.times[take.times.length - 1] ?? sheet.duration;
  const tracks = new Map(take.props.map((t) => [t.prop.id, t]));
  const { holdings } = holdingsOf(sheet);
  const frameAt = (t: number): number => Math.min(take.times.length - 1, Math.max(0, Math.round(t * take.fps)));
  const poseAt = (tr: PropTrack, f: number): { p: THREE.Vector3; q: THREE.Quaternion } => ({
    p: new THREE.Vector3().fromArray(tr.position, f * 3), q: new THREE.Quaternion().fromArray(tr.rotation, f * 4)
  });
  /** A world point at a frame (validated: an object point, a numeric mark or numbers). */
  const pointAt = (p: Point, f: number): THREE.Vector3 => {
    if (Array.isArray(p)) return new THREE.Vector3(p[0], p[1], p[2]);
    const s = p as string;
    const dot = s.indexOf('.');
    if (dot < 0) return pointAt(sheet.marks![s] as Point, f);
    const tr = tracks.get(s.slice(0, dot))!;
    const { p: at, q } = poseAt(tr, f);
    return tr.prop.anchors.get(s.slice(dot + 1))!.clone().applyQuaternion(q).add(at);
  };
  const named = (p: Point): string => (typeof p === 'string' ? p : 'the point');
  /** The colour of what a point lies on: the named part's, else the object's first part's. */
  const surfaceColor = (p: Point): Rgb | undefined => {
    if (typeof p !== 'string' || !p.includes('.')) return undefined;
    const [id, name] = p.split('.') as [string, string];
    const prop = tracks.get(id)?.prop;
    return (prop?.parts.find((x) => x.name === name) ?? prop?.parts[0])?.color;
  };

  for (const [i, w] of world.entries()) {
    const id = `${w.kind}-${i + 1}`;
    if (w.kind === 'pour') effects.push(pour(w, id, i));
    else if (w.kind === 'burst') effects.push(burst(w, id, i));
    else if (w.kind === 'drift') effects.push(drift(w, id, i));
  }
  for (const id of new Set(world.flatMap((w) => (w.kind === 'change' ? [w.object] : [])))) changes.set(id, objectChange(id));
  return { effects, changes, lines };

  function pour(w: Extract<WorldChange, { kind: 'pour' }>, id: string, salt: number): Effect {
    const tr = tracks.get(w.object)!;
    const tool = tr.prop.tool!;
    const onto = w.onto ?? aimTargetOf(sheet, holdings, w.object)!;
    const tilt = w.tilt ?? 0;
    const rate = w.rate ?? 60;
    const speed = w.speed ?? 0.8;
    // About 5 px wide on the card (a 16 mm stream read as "thin", slice 1g).
    const size = w.size ?? 0.03;
    const wetRadius = w.wet === false ? 0 : typeof w.wet === 'number' ? w.wet : 0.06;
    const color = parseColor(w.color ?? WATER);
    const rnd = stream(salt);
    const nodes: EffectNode[] = [];
    const landings: { t: number; at: THREE.Vector3 }[] = [];
    let owed = 0;
    let first = Infinity;
    let misses = 0;
    const flights: Flight[] = [];
    for (let f = 0; f < take.times.length - 1; f += 1) {
      const t = take.times[f]!;
      const { p, q } = poseAt(tr, f);
      const axis = tool.axis.clone().applyQuaternion(q).normalize();
      const below = -Math.asin(Math.max(-1, Math.min(1, axis.y))) / DEG;
      if (below <= tilt) { owed = 0; continue; }
      // Flow rises over the first 25° past the threshold, from a trickle to full.
      const flow = rate * Math.max(0.25, Math.min(1, (below - tilt) / 25));
      owed += flow / take.fps;
      const tip = tool.tip.clone().applyQuaternion(q).add(p);
      while (owed >= 1) {
        owed -= 1;
        // Spread over the frame, so a steady flow leaves at an even beat.
        const te = t + (1 - (owed * take.fps) / flow) / take.fps;
        const target = pointAt(onto, frameAt(te));
        const a = rnd() * Math.PI * 2;
        const rr = (Math.sqrt(rnd()) * Math.max(wetRadius, 0.03)) / 3;
        target.x += Math.cos(a) * rr;
        target.z += Math.sin(a) * rr;
        const vy = speed * axis.y;
        const disc = vy * vy + 2 * G * (tip.y - target.y);
        if (disc <= 0) { misses += 1; continue; }
        const T = (vy + Math.sqrt(disc)) / G;
        if (te + T > duration) continue;
        flights.push({ from: tip.clone(), to: target, vy, te, T });
        landings.push({ t: te + T, at: target });
        first = Math.min(first, te);
      }
    }
    // About fifteen drops are in the air at once: each node carries one after
    // another, hidden between them, so a pour is a few dozen nodes, not one per
    // drop (every node costs Quick Look a prim and its readback a sample).
    const slots: { flights: Flight[]; last: number }[] = [];
    for (const fl of flights) {
      const span = onGrid(fl.te, fl.te + fl.T);
      const slot = slots.find((x) => span[0]!.t > x.last);
      if (slot) { slot.flights.push(fl); slot.last = span[span.length - 1]!.t; }
      else slots.push({ flights: [fl], last: span[span.length - 1]!.t });
    }
    for (const [k, slot] of slots.entries()) nodes.push(drops(`${id}-drop-${k + 1}`, slot.flights, size, color));
    if (!nodes.length) {
      lines.push(`${id} from ${w.object}: no water; its tool never points more than ${tilt}° below the horizontal`);
      return { id, kind: 'pour', name: 'Water', presence: [{ start: 0, end: 0 }], nodes };
    }
    // Launched in order, but a longer fall can land later than the drop after it.
    landings.sort((a, b) => a.t - b.t);
    const aim = pointAt(onto, frameAt(landings[0]!.t));
    const spread = Math.max(...landings.map((l) => Math.hypot(l.at.x - aim.x, l.at.z - aim.z)));
    const lastLanding = landings[landings.length - 1]!.t;
    if (wetRadius > 0) {
      // The wet patch grows with the water landed (its area with the water), on what it lies on, and stays.
      const f0 = Math.floor(landings[0]!.t * take.fps);
      const f1 = Math.min(take.times.length - 1, Math.ceil(lastLanding * take.fps));
      const n = f1 - f0 + 1;
      const times = new Float32Array(n);
      const scale = new Float32Array(n * 3);
      const translation = new Float32Array(n * 3);
      for (let f = f0; f <= f1; f += 1) {
        const t = take.times[f]!;
        const r = wetRadius * Math.sqrt(landings.filter((l) => l.t <= t).length / landings.length);
        times[f - f0] = t;
        scale.set(r > 0 ? [r * 2, 1, r * 2] : [0, 0, 0], (f - f0) * 3); // all three zero: the converter's absence
        pointAt(onto, f).add(new THREE.Vector3(0, 0.0015, 0)).toArray(translation, (f - f0) * 3);
      }
      const under = surfaceColor(onto) ?? [0.3, 0.22, 0.15];
      nodes.push({ name: `${id}-wet`, shape: 'disc', color: under.map((c) => c * 0.42) as unknown as Rgb, keys: { times, scale, translation } });
    }
    lines.push(`${id} from ${w.object}: ${landings.length} drops on ${nodes.length} nodes, ${r3(first)} to ${r3(lastLanding)} s, landing within ${(spread * 1000).toFixed(0)} mm of ${named(onto)}` +
      (wetRadius > 0 ? `; a wet patch ${(wetRadius * 200).toFixed(0)} cm across, kept to the end` : '') + (misses ? `; ${misses} drops could not fall to it` : ''));
    return { id, kind: 'pour', name: 'Water', presence: [{ start: r3(first), end: r3(wetRadius > 0 ? duration : lastLanding) }], nodes };
  }

  function burst(w: Extract<WorldChange, { kind: 'burst' }>, id: string, salt: number): Effect {
    const t0 = cueTime(sheet, w.when)!;
    const life = Math.min(w.life ?? 1.2, duration - t0);
    const spread = w.spread ?? 0.25;
    const size = w.size ?? 0.018;
    const color = parseColor(w.color ?? SPARK);
    const rnd = stream(salt);
    const nodes: EffectNode[] = [];
    const at = pointAt(w.at, frameAt(t0));
    for (let k = 0; life > 0 && k < (w.count ?? 24); k += 1) {
      // Out over the upper half, eased to a stop, sinking a little, shrinking away.
      const dir = new THREE.Vector3(rnd() * 2 - 1, rnd() * 0.9 + 0.1, rnd() * 2 - 1).normalize();
      const reach = spread * (0.5 + 0.5 * rnd());
      const own = life * (0.7 + 0.3 * rnd());
      nodes.push(mote(`${id}-${k + 1}`, t0, own, size * (0.7 + 0.6 * rnd()), color,
        (u) => at.clone().addScaledVector(dir, reach * (1 - (1 - u) ** 3)).add(new THREE.Vector3(0, -0.15 * spread * u * u, 0)), (u) => 1 - u));
    }
    lines.push(`${id} at ${named(w.at)}: ${nodes.length} motes from ${r3(t0)} s, gone by ${r3(t0 + Math.max(0, life))} s`);
    return { id, kind: 'burst', name: 'Burst', presence: [{ start: r3(t0), end: r3(t0 + Math.max(0, life)) }], nodes };
  }

  function drift(w: Extract<WorldChange, { kind: 'drift' }>, id: string, salt: number): Effect {
    const t0 = cueTime(sheet, w.when)!;
    const t1 = cueTime(sheet, w.until)!;
    const life = w.life ?? 2;
    const rise = w.rise ?? 0.3;
    const spread = w.spread ?? 0.12;
    const size = w.size ?? 0.012;
    const color = parseColor(w.color ?? MOTE);
    const rnd = stream(salt);
    const nodes: EffectNode[] = [];
    const count = w.count ?? 12;
    let end = t0;
    for (let k = 0; k < count; k += 1) {
      const start = t0 + ((t1 - t0) * (k + rnd())) / count;
      const own = Math.min(life * (0.75 + 0.5 * rnd()), duration - start);
      const base = pointAt(w.at, frameAt(start)).add(new THREE.Vector3((rnd() * 2 - 1) * spread, 0, (rnd() * 2 - 1) * spread));
      const phase = rnd() * Math.PI * 2;
      const s = size * (0.7 + 0.6 * rnd());
      if (own <= 0) continue;
      nodes.push(mote(`${id}-${k + 1}`, start, own, s, color,
        (u) => base.clone().add(new THREE.Vector3(Math.sin(phase + u * 5) * 0.02, rise * u, Math.cos(phase + u * 4) * 0.02)), (u) => Math.sin(Math.PI * u)));
      end = Math.max(end, start + own);
    }
    lines.push(`${id} at ${named(w.at)}: ${nodes.length} motes rising from ${r3(t0)} to ${r3(t1)} s`);
    return { id, kind: 'drift', name: 'Drift', presence: [{ start: r3(t0), end: r3(end) }], nodes };
  }

  function objectChange(object: string): ObjectChange {
    const prop = tracks.get(object)!.prop;
    const mine = world.filter((w): w is Extract<WorldChange, { kind: 'change' }> => w.kind === 'change' && w.object === object)
      .map((w) => ({ w, t: cueTime(sheet, w.when)! })).sort((a, b) => a.t - b.t);
    const shows = mine.filter((m) => m.w.show !== undefined);
    const moves = mine.filter((m) => m.w.show === undefined);
    const original: Rgb[] = prop.parts.map((p) => p.color);
    const neutral: Full = { turn: [0, 0, 0], scale: 1, lift: 0 };
    /** A state with what it leaves out taken from `base`. */
    const over = (s: ChangeState, base: Full): Full => {
      const color = 'color' in s ? s.color : base.color;
      return { turn: s.turn ?? base.turn, scale: s.scale ?? base.scale, lift: s.lift ?? base.lift, ...(color !== undefined ? { color } : {}) };
    };
    // Each change runs from its `from` (or where the one before left it) to its own values (or as the sheet made it).
    const segments: { t0: number; t1: number; a: Full; b: Full; steps: number }[] = [];
    const initial = moves[0]?.w.from ? over(moves[0].w.from, neutral) : neutral;
    let state = initial;
    for (const { w, t } of moves) {
      const a = w.from ? over(w.from, state) : state;
      const b = over({ ...(w.turn ? { turn: w.turn } : {}), ...(w.scale !== undefined ? { scale: w.scale } : {}), ...(w.lift !== undefined ? { lift: w.lift } : {}), ...(w.color !== undefined ? { color: w.color } : {}) }, { ...neutral });
      segments.push({ t0: t, t1: t + (w.over ?? 1.5), a, b, steps: w.steps ?? 4 });
      state = b;
    }
    const stateAt = (t: number): { a: Full; b: Full; u: number } => {
      let s = initial;
      for (const seg of segments) {
        if (t < seg.t0) return { a: s, b: s, u: 0 };
        if (t < seg.t1) return { a: seg.a, b: seg.b, u: smoother((t - seg.t0) / Math.max(1e-6, seg.t1 - seg.t0)) };
        s = seg.b;
      }
      return { a: s, b: s, u: 0 };
    };
    const vec = (s: Full['scale']): THREE.Vector3 => (typeof s === 'number' ? new THREE.Vector3(s, s, s) : new THREE.Vector3(...s));
    const quat = (turn: Full['turn']): THREE.Quaternion => new THREE.Quaternion().setFromEuler(new THREE.Euler(turn[0] * DEG, turn[1] * DEG, turn[2] * DEG, 'XYZ'));
    const n = take.times.length;
    const translation = new Float32Array(n * 3);
    const rotation = new Float32Array(n * 4);
    const scale = new Float32Array(n * 3);
    for (let f = 0; f < n; f += 1) {
      const { a, b, u } = stateAt(take.times[f]!);
      translation.set([0, a.lift + (b.lift - a.lift) * u, 0], f * 3);
      quat(a.turn).slerp(quat(b.turn), u).toArray(rotation, f * 4);
      vec(a.scale).lerp(vec(b.scale), u).toArray(scale, f * 3);
    }
    // Colours: each change's steps, evenly over it, held between changes.
    const tint = (s: Full): Rgb[] => (s.color !== undefined ? original.map(() => parseColor(s.color)) : original);
    const timeline: { t: number; colors: Rgb[] }[] = [{ t: 0, colors: tint(initial) }];
    for (const seg of segments) {
      const a = tint(seg.a);
      const b = tint(seg.b);
      if (sameColors(a, b)) { timeline.push({ t: seg.t0, colors: a }); continue; }
      for (let k = 0; k < seg.steps; k += 1) {
        const u = k / (seg.steps - 1);
        timeline.push({ t: seg.t0 + ((seg.t1 - seg.t0) * k) / seg.steps, colors: u === 1 ? b : a.map((c, i) => c.map((x, j) => x + (b[i]![j]! - x) * u) as unknown as Rgb) });
      }
    }
    const variants: ObjectChange['variants'] = [];
    for (const [k, entry] of timeline.entries()) {
      const end = timeline[k + 1]?.t ?? Infinity;
      if (end <= entry.t) continue;
      let v = variants.find((x) => sameColors(x.colors, entry.colors));
      if (!v) { v = { colors: entry.colors, spans: [] }; variants.push(v); }
      const lastSpan = v.spans[v.spans.length - 1];
      if (lastSpan && lastSpan[1] === entry.t) lastSpan[1] = end;
      else v.spans.push([entry.t, end]);
    }
    let presence: ObjectChange['presence'];
    if (shows.length) {
      const spans: { start: number; end: number }[] = [];
      let open: number | undefined = shows[0]!.w.show ? undefined : 0;
      for (const { w, t } of shows) {
        if (w.show && open === undefined) open = t;
        else if (!w.show && open !== undefined) {
          // Hidden from the first frame is no span at all.
          if (t > open) spans.push({ start: r3(open), end: r3(t) });
          open = undefined;
        }
      }
      if (open !== undefined) spans.push({ start: r3(open), end: r3(duration) });
      presence = spans.length ? spans : [{ start: 0, end: 0 }];
    }
    lines.push(`${object} changes: ${[
      ...segments.map((s) => `${r3(s.t0)} to ${r3(s.t1)} s`),
      ...(variants.length > 1 ? [`${variants.length} colour steps`] : []),
      ...(presence ? [`present ${presence.map((p) => `${p.start}-${p.end} s`).join(', ')}`] : [])
    ].join('; ')}`);
    return { object, ...(segments.length ? { pose: { translation, rotation, scale } } : {}), variants, ...(presence ? { presence } : {}) };
  }

  /** Drops one after another on one node: each falls under gravity from its speed along the axis, travels straight across and is stretched along its velocity; hidden between them. */
  function drops(name: string, flights: readonly Flight[], size: number, color: Rgb): EffectNode {
    const keys: { t: number; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (const { from, to, vy, te, T } of flights) {
      for (const { t, inside } of onGrid(te, te + T)) {
        const tau = Math.min(T, Math.max(0, t - te));
        const p = from.clone().lerp(to, tau / T);
        p.y = from.y + vy * tau - (G * tau * tau) / 2;
        const v = new THREE.Vector3((to.x - from.x) / T, vy - G * tau, (to.z - from.z) / T);
        // Stretched past the distance it falls in a frame, so the drops overlap: a stream, not beads.
        const len = Math.min(0.12, Math.max(size * 2, (1.5 * v.length()) / take.fps));
        const on = inside ? 1 : 0;
        keys.push({ t, p, q: new THREE.Quaternion().setFromUnitVectors(up, v.normalize()), s: new THREE.Vector3(size * on, len * on, size * on) });
      }
    }
    const times = new Float32Array(keys.length);
    const translation = new Float32Array(keys.length * 3);
    const rotation = new Float32Array(keys.length * 4);
    const scale = new Float32Array(keys.length * 3);
    for (const [k, key] of keys.entries()) {
      times[k] = key.t;
      key.p.toArray(translation, k * 3);
      key.q.toArray(rotation, k * 4);
      key.s.toArray(scale, k * 3);
    }
    return { name, shape: 'sphere', color, keys: { times, translation, rotation: continuous(rotation), scale } };
  }

  /** A mote alive from `t0` for `life` seconds: its path, and its size's share, over its life (0..1). */
  function mote(name: string, t0: number, life: number, size: number, color: Rgb, path: (u: number) => THREE.Vector3, share: (u: number) => number): EffectNode {
    const grid = onGrid(t0, t0 + life);
    const times = new Float32Array(grid.length);
    const translation = new Float32Array(grid.length * 3);
    const scale = new Float32Array(grid.length * 3);
    for (const [k, { t, inside }] of grid.entries()) {
      const u = Math.min(1, Math.max(0, (t - t0) / life));
      times[k] = t;
      path(u).toArray(translation, k * 3);
      const s = inside ? size * Math.max(0.15, share(u)) : 0;
      scale.set([s, s, s], k * 3);
    }
    return { name, shape: 'sphere', color, keys: { times, translation, scale } };
  }

  /**
   * The take's own frames from the last one at or before `t0` to the first at
   * or after `t1`; `inside` is true strictly between. Keys on the shared frame
   * grid keep a hundred drops from adding a hundred key times to every
   * consumer that samples them (the Quick Look readback does).
   */
  function onGrid(t0: number, t1: number): { t: number; inside: boolean }[] {
    const times = take.times;
    let i0 = 0;
    while (i0 + 1 < times.length && times[i0 + 1]! <= t0) i0 += 1;
    let i1 = i0;
    while (i1 + 1 < times.length && times[i1]! < t1) i1 += 1;
    const out: { t: number; inside: boolean }[] = [];
    for (let i = i0; i <= Math.max(i1, i0 + 1) && i < times.length; i += 1) out.push({ t: times[i]!, inside: times[i]! > t0 && times[i]! < t1 });
    return out;
  }
}

/** Keeps each quaternion in the hemisphere of the one before. */
function continuous(values: Float32Array): Float32Array {
  const out = values.slice();
  for (let i = 4; i < out.length; i += 4) {
    const dot = out[i]! * out[i - 4]! + out[i + 1]! * out[i - 3]! + out[i + 2]! * out[i - 2]! + out[i + 3]! * out[i - 1]!;
    if (dot < 0) for (let k = 0; k < 4; k += 1) out[i + k] = -out[i + k]!;
  }
  return out;
}
