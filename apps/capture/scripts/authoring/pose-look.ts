/**
 * A look at one moment of a sheet, in less time than a full build.
 *
 *   node --conditions=development --import tsx scripts/authoring/pose-look.ts <sheet.json> --at <seconds> [--out dir] [--compare take.glb] [--first-pass-only] [--watch]
 *
 * The solver carries state from frame to frame (the clearing plan, the lift
 * ease, the twist rate limit, goals fixed at first use, the other performer's
 * last frame), so one frame solved alone does not give the pose of the full
 * build. This command solves frames 0 to f + CLEAR_LOOKAHEAD (39) with every solve pass of the
 * full build, exports that window, opens it in the viewer and saves close
 * pictures of each hand that touches something at that moment, from three
 * angles: from the side the card sees ("card"); from the view around the
 * hand where the least of it is hidden ("best": 24 views are scored with an
 * id render, and a body or an object in front of the hand hides it), at
 * least 30° out of the palm's plane, so it does not look along the palm; and
 * from the side of the palm, edge-on ("profile": the camera in the palm's
 * plane, so the gap between the palm and what it lies on shows directly).
 *
 * `--first-pass-only` stops the solve after its first pass, with no clearing
 * round, for a faster look. The arms are then not cleared from the bodies as
 * in the full take, so its folder, its picture names and its report say
 * "first pass only".
 *
 * `--watch` keeps the viewer servers and the loaded avatars between looks and
 * makes the look again each time the sheet file changes (Ctrl-C stops it).
 * Only the first look measures each avatar's eye view.
 *
 * `--compare take.glb` reads the same frame of a full build and gives the
 * largest bone turn difference (degrees) and the largest palm centre
 * distance (mm) between the two.
 *
 * It writes `pose-look.json` (the phase times, the hands, the pictures and
 * the comparison) and the pictures into the out directory.
 */
import { watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { build, type AvatarCache } from './direct.ts';
import { CLEAR_LOOKAHEAD } from './lib/direct.ts';
import { holdingsOf, parseSheetText, resolveTiming, type BeatSheet } from './lib/beats.ts';
import { findPerformers, parents, parseGlb, readChannels, sampleChannel, type GltfDoc } from './lib/gltf-read.ts';
import { phase, phaseLine } from './lib/phases.ts';
import { REVIEW_PAGE } from './lib/review-page.ts';
import { openTake, startViewer, type ViewerServers } from './lib/viewer-session.ts';
import { BACKGROUND } from './review.ts';

const OUTPUT = fileURLToPath(new URL('../../output/authoring/pose-look/', import.meta.url));
/** Frames solved after the one looked at: later frames change the clearing plan of each round (CLEAR_LOOKAHEAD). */
export const AFTER = CLEAR_LOOKAHEAD;
const SIZE = 720;
const FOV = 40;
/** Camera distance from the hand, metres. */
const DISTANCE = 0.55;
/** Views scored for the "best" picture: 12 turns around the hand at 2 heights. */
const TURNS = 12;
const HEIGHTS = [0.12, 0.4];
/** Pixel size of the id render that scores a view. */
const SCORE_SIZE = 128;
/** The best picture is at least this far round from the card picture, so the two show different sides. */
const MIN_APART_DEG = 60;
/** The best picture looks at the palm's plane from at least 30° out of it (sine), not along the palm. */
const OUT_OF_PALM = 0.5;
/** Views scored for the profile picture: turns about the palm's normal, in the palm's plane. */
const PROFILE_TURNS = 12;
/** The profile camera is not more than about 55° above or below the level (sine), so the view's up stays defined. */
const PROFILE_MAX_UP = 0.8;
export const FIRST_PASS_ONLY = 'first-pass-only';
const HAND_KINDS = new Set(['reach', 'take', 'put', 'aim', 'drop']);

type Side = 'left' | 'right';
interface Hand { readonly performer: string; readonly side: Side; readonly why: string }
/** A hand with its pictures (card, best), the share of the hand each one sees, and where the best view is. */
type Shown = Hand & { pictures: string[]; seen: Record<string, number>; bestTurn: number; bestUp: number; profileTurn?: number };

/** The hands that touch or hold something at `t`: a hand direction under way, or an object held. */
export function touchingHands(sheet: BeatSheet, t: number): Hand[] {
  const out = new Map<string, Hand>();
  const add = (h: Hand) => { const k = `${h.performer}.${h.side}`; if (!out.has(k)) out.set(k, h); };
  for (const b of sheet.beats) for (const d of b.directions) {
    if (!HAND_KINDS.has(d.kind) || !('side' in d) || !d.side) continue;
    const side = d.side;
    const r = resolveTiming(b, d);
    if (t >= r.start && t <= r.end) add({ performer: b.performer, side: side as Side, why: `${d.kind} in beat ${b.id} (${r.start.toFixed(2)}-${r.end.toFixed(2)} s)` });
  }
  for (const h of holdingsOf(sheet).holdings) if (t >= h.from && t <= h.to) add({ performer: h.performer, side: h.side as Side, why: `holds ${h.object}` });
  return [...out.values()];
}

/** Each node's world matrix at time `t` of a take. */
function worldAt(doc: GltfDoc, t: number): { world: THREE.Matrix4[]; local: THREE.Quaternion[] } {
  const nodes = doc.json.nodes ?? [];
  const T = nodes.map((n) => new THREE.Vector3(...((n.translation as number[] | undefined) ?? [0, 0, 0])));
  const R = nodes.map((n) => new THREE.Quaternion(...((n.rotation as number[] | undefined) ?? [0, 0, 0, 1])));
  const S = nodes.map((n) => new THREE.Vector3(...((n.scale as number[] | undefined) ?? [1, 1, 1])));
  const v = new Float64Array(4);
  for (const ch of readChannels(doc)) {
    if (ch.animation !== 0) continue;
    sampleChannel(ch, t, v);
    if (ch.path === 'translation') T[ch.node]!.set(v[0]!, v[1]!, v[2]!);
    else if (ch.path === 'rotation') R[ch.node]!.set(v[0]!, v[1]!, v[2]!, v[3]!).normalize();
    else if (ch.path === 'scale') S[ch.node]!.set(v[0]!, v[1]!, v[2]!);
  }
  const parent = parents(doc.json);
  const world: THREE.Matrix4[] = new Array(nodes.length);
  const of = (i: number): THREE.Matrix4 => {
    if (world[i]) return world[i]!;
    const m = nodes[i]!.matrix ? new THREE.Matrix4().fromArray(nodes[i]!.matrix as number[]) : new THREE.Matrix4().compose(T[i]!, R[i]!, S[i]!);
    world[i] = parent[i]! === -1 ? m : of(parent[i]!).clone().multiply(m);
    return world[i]!;
  };
  nodes.forEach((_, i) => of(i));
  return { world, local: R };
}

export interface PoseDiff {
  /** The largest local turn difference over every humanoid bone of every performer, degrees. */
  readonly boneDeg: number;
  readonly boneAt: string;
  /** The largest palm centre distance, mm. */
  readonly palmMm: number;
  readonly palmAt: string;
  readonly palms: { readonly hand: string; readonly mm: number }[];
}

/**
 * Compares one moment of two takes of the same sheet: each humanoid bone's
 * local turn, and each palm centre (wrist to middle knuckle at 0.6, as
 * `hands.ts` puts it, without its small offset along the palm normal; that
 * offset follows the bones compared above).
 */
export function poseDiff(a: GltfDoc, b: GltfDoc, t: number): PoseDiff {
  const A = worldAt(a, t);
  const B = worldAt(b, t);
  const pa = findPerformers(a);
  const pb = findPerformers(b);
  if (pa.length !== pb.length) throw new Error(`the takes have ${pa.length} and ${pb.length} performers`);
  let boneDeg = 0;
  let boneAt = '';
  const palms: { hand: string; mm: number }[] = [];
  const pos = (w: THREE.Matrix4[], i: number) => new THREE.Vector3().setFromMatrixPosition(w[i]!);
  pa.forEach((p, k) => {
    const q = pb[k]!;
    for (const [bone, ia] of Object.entries(p.mapping.bones) as [string, number][]) {
      const ib = q.mapping.bones[bone as keyof typeof q.mapping.bones];
      if (ib === undefined) continue;
      const d = 2 * Math.acos(Math.min(1, Math.abs(A.local[ia]!.dot(B.local[ib]!)))) * THREE.MathUtils.RAD2DEG;
      if (d > boneDeg) { boneDeg = d; boneAt = `${p.name}.${bone}`; }
    }
    for (const side of ['left', 'right'] as const) {
      const h = p.mapping.bones[`${side}Hand`];
      const m = p.mapping.bones[`${side}MiddleProximal`];
      const hb = q.mapping.bones[`${side}Hand`];
      const mb = q.mapping.bones[`${side}MiddleProximal`];
      if (h === undefined || m === undefined || hb === undefined || mb === undefined) continue;
      const palmA = pos(A.world, h).lerp(pos(A.world, m), 0.6);
      const palmB = pos(B.world, hb).lerp(pos(B.world, mb), 0.6);
      palms.push({ hand: `${p.name}.${side}`, mm: palmA.distanceTo(palmB) * 1000 });
    }
  });
  const worst = palms.reduce((x, y) => (y.mm > x.mm ? y : x), { hand: '', mm: 0 });
  return { boneDeg, boneAt, palmMm: worst.mm, palmAt: worst.hand, palms };
}

export interface PoseLook {
  readonly sheet: string;
  readonly at: number;
  readonly frame: number;
  readonly framesSolved: number;
  readonly seconds: number;
  readonly phases: readonly { name: string; seconds: number }[];
  readonly hands: readonly Shown[];
  readonly note?: string;
  readonly compare?: PoseDiff & { readonly take: string };
  /** Set when the solve stopped after its first pass: "first pass only". */
  readonly solve: 'full' | 'first pass only';
}

export interface LookOptions {
  readonly out?: string;
  readonly compare?: string;
  readonly firstPassOnly?: boolean;
  /** Running viewer servers to use (a warm process); without them the look starts and stops its own. */
  readonly servers?: ViewerServers;
  /** Loaded avatars to keep between looks (a warm process), so that only the first look measures each eye view. */
  readonly avatars?: AvatarCache;
}

export async function poseLook(sheetFile: string, at: number, options: LookOptions = {}): Promise<PoseLook> {
  const started = performance.now();
  const sheet = parseSheetText(await readFile(sheetFile, 'utf8'), basename(sheetFile));
  const fps = sheet.fps ?? 30;
  const total = Math.round(sheet.duration * fps) + 1;
  const frame = Math.round(at * fps);
  if (!(frame >= 0 && frame < total)) throw new Error(`--at ${at} s is outside the take (0 to ${sheet.duration} s)`);
  const t = frame / fps;
  const tag = options.firstPassOnly ? `-${FIRST_PASS_ONLY}` : '';
  const out = resolve(options.out ?? join(OUTPUT, basename(sheetFile).replace(/\.jsonc?$/, ''), `t${t.toFixed(2)}${tag}`));
  await mkdir(out, { recursive: true });
  const glb = join(out, `window${tag}.glb`);
  const framesSolved = Math.min(total, frame + AFTER + 1);
  const built = await build(sheetFile, glb, undefined, undefined, { frames: framesSolved, ...(options.firstPassOnly ? { firstPassOnly: true } : {}) }, options.avatars);
  const phases = built.phases as { name: string; seconds: number }[];

  let hands = touchingHands(sheet, t);
  let note: string | undefined;
  if (!hands.length) {
    note = `no hand touches or holds anything at ${t.toFixed(2)} s: pictures of every hand`;
    hands = sheet.performers.flatMap((p) => (['left', 'right'] as const).map((side) => ({ performer: p.id, side, why: 'no touch at this moment' })));
  }

  const servers = options.servers ?? await phase('viewer start', () => startViewer());
  const shown: Shown[] = [];
  try {
    const open = await phase('viewer open', () => openTake(servers, glb, { viewport: { width: 900, height: 900 }, title: 'Pose' }));
    try {
      await phase('pictures', async () => {
        const { page } = open;
        await page.addScriptTag({ content: REVIEW_PAGE });
        const R = (fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as unknown as { __review: Record<string, (...x: unknown[]) => unknown> }).__review[f as string]!(...(args as unknown[])), [fn, a] as const);
        const init = await R('init', open.url) as { performers: { name: string }[] };
        await R('seek', t);
        const bodies = await R('bodies') as { camera: number[] };
        // The writer names the first performer RecordedAvatar and the others Performer_<id>.
        const indexOf = (id: string): number => {
          const i = init.performers.findIndex((p, k) => (k === 0 ? id === sheet.performers[0]!.id && p.name === 'RecordedAvatar' : p.name === `Performer_${id}`));
          if (i === -1) throw new Error(`no performer ${id} in the viewer (it has ${init.performers.map((p) => p.name).join(', ')})`);
          return i;
        };
        for (const h of hands) {
          const i = indexOf(h.performer);
          const pts = await R('points', i) as Record<string, number[]>;
          const hand = pts[`${h.side}Hand`];
          if (!hand) throw new Error(`the viewer found no ${h.side} hand for ${h.performer}`);
          const target = new THREE.Vector3(...hand);
          const toCard = new THREE.Vector3(...bodies.camera).sub(target).setY(0).normalize();
          const viewAt = (turn: number, up: number) => {
            const dir = toCard.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * THREE.MathUtils.DEG2RAD);
            return { turn, up, position: target.clone().addScaledVector(dir, DISTANCE).add(new THREE.Vector3(0, up, 0)).toArray(), target: target.toArray(), fov: FOV };
          };
          // The palm's normal and its two in-plane axes, from the wrist and the index, middle and little knuckles.
          const at = (name: string) => (pts[`${h.side}${name}`] ? new THREE.Vector3(...pts[`${h.side}${name}`]!) : undefined);
          const [index, middle, little] = [at('Index'), at('Middle'), at('Little')];
          const palm = index && middle && little ? (() => {
            const across = index.clone().sub(little).normalize();
            const up = middle.clone().sub(target).normalize();
            return { across, up, normal: new THREE.Vector3().crossVectors(across, up).normalize() };
          })() : undefined;
          const views = HEIGHTS.flatMap((up) => Array.from({ length: TURNS }, (_, k) => viewAt((360 / TURNS) * k - 180, up)));
          const scores = await R('handView', i, h.side, views, SCORE_SIZE) as { visible: number; total: number }[];
          const scored = views.map((v, k) => ({ ...v, ...scores[k]!, seen: scores[k]!.total ? scores[k]!.visible / scores[k]!.total : 0 }));
          const apart = (turn: number) => Math.abs(((turn % 360) + 540) % 360 - 180);
          const outOfPalm = (v: { position: number[] }) => !palm || Math.abs(new THREE.Vector3(...v.position).sub(target).normalize().dot(palm.normal)) >= OUT_OF_PALM;
          const order = (a: { seen: number; visible: number }, b: { seen: number; visible: number }) => b.seen - a.seen || b.visible - a.visible;
          const best = scored.filter((v) => apart(v.turn) >= MIN_APART_DEG && outOfPalm(v)).sort(order)[0]
            ?? scored.filter((v) => outOfPalm(v)).sort(order)[0] ?? scored.sort(order)[0]!;
          const card = { ...viewAt(0, HEIGHTS[0]!), ...(await R('handView', i, h.side, [viewAt(0, HEIGHTS[0]!)], SCORE_SIZE) as { visible: number; total: number }[])[0]! };
          const pictures: string[] = [];
          const seen: Record<string, number> = {};
          const chosen: [string, { turn: number; position: number[]; target: number[]; visible: number; total: number }][] = [['card', card], ['best', best]];
          let profileTurn: number | undefined;
          if (palm) {
            // In the palm's plane, edge-on: turns about the normal from the palm's sideways axis.
            const sides = Array.from({ length: PROFILE_TURNS }, (_, k) => {
              const turn = (360 / PROFILE_TURNS) * k;
              const dir = palm.across.clone().applyAxisAngle(palm.normal, turn * THREE.MathUtils.DEG2RAD);
              return { turn, dir, position: target.clone().addScaledVector(dir, DISTANCE).toArray(), target: target.toArray(), fov: FOV };
            }).filter((v) => Math.abs(v.dir.y) <= PROFILE_MAX_UP);
            if (sides.length) {
              const ps = await R('handView', i, h.side, sides, SCORE_SIZE) as { visible: number; total: number }[];
              const profile = sides.map((v, k) => ({ ...v, ...ps[k]!, seen: ps[k]!.total ? ps[k]!.visible / ps[k]!.total : 0 })).sort(order)[0]!;
              profileTurn = profile.turn;
              chosen.push(['profile', profile]);
            }
          }
          for (const [name, v] of chosen) {
            const share = v.total ? v.visible / v.total : 0;
            seen[name] = Math.round(share * 1000) / 1000;
            const label = `${h.performer} ${h.side} hand, ${t.toFixed(2)} s, ${name} (${name === 'profile' ? 'edge-on to the palm' : `turn ${v.turn}°`}, ${Math.round(share * 100)}% seen)${options.firstPassOnly ? ', first pass only' : ''}`;
            const shot = await R('close', i, { position: v.position, target: v.target, fov: FOV, width: SIZE, height: SIZE, background: BACKGROUND, label }) as { image: string };
            const file = join(out, `${h.performer}-${h.side}-${name}${tag}.jpg`);
            await writeFile(file, Buffer.from(shot.image.slice(shot.image.indexOf(',') + 1), 'base64'));
            pictures.push(file);
          }
          shown.push({ ...h, pictures, seen, bestTurn: best.turn, bestUp: best.up, ...(profileTurn !== undefined ? { profileTurn } : {}) });
        }
      });
    } finally {
      await open.close();
    }
  } finally {
    if (!options.servers) servers.close();
  }

  let compare: PoseLook['compare'];
  if (options.compare) {
    const full = parseGlb(new Uint8Array(await readFile(options.compare)));
    compare = { take: resolve(options.compare), ...poseDiff(parseGlb(new Uint8Array(await readFile(glb))), full, t) };
  }
  const look: PoseLook = { sheet: resolve(sheetFile), at: t, frame, framesSolved, seconds: (performance.now() - started) / 1000, phases, hands: shown, solve: options.firstPassOnly ? 'first pass only' : 'full', ...(note ? { note } : {}), ...(compare ? { compare } : {}) };
  await writeFile(join(out, 'pose-look.json'), `${JSON.stringify(look, null, 2)}\n`);
  return look;
}

export function print(look: PoseLook): void {
  console.log(`pose look at ${look.at.toFixed(2)} s (frame ${look.frame}, ${look.framesSolved} frames solved, ${look.solve}) in ${look.seconds.toFixed(1)} s`);
  console.log(`  phases: ${phaseLine(look.phases)}`);
  if (look.note) console.log(`  ${look.note}`);
  for (const h of look.hands) console.log(`  ${h.performer} ${h.side} (${h.why}; seen card ${h.seen.card}, best ${h.seen.best} at turn ${h.bestTurn}°): ${h.pictures.join(', ')}`);
  if (look.compare) {
    const c = look.compare;
    console.log(`  against ${c.take}: bones within ${c.boneDeg.toFixed(3)}° (worst ${c.boneAt}), palms within ${c.palmMm.toFixed(3)} mm (worst ${c.palmAt})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const has = (name: string): boolean => { const i = args.indexOf(name); if (i !== -1) args.splice(i, 1); return i !== -1; };
  const at = flag('--at');
  const out = flag('--out');
  const compare = flag('--compare');
  const firstPassOnly = has('--first-pass-only');
  const watching = has('--watch');
  const sheetFile = args[0];
  if (!sheetFile || at === undefined || !Number.isFinite(Number(at))) {
    console.error('usage: pose-look.ts <sheet.json> --at <seconds> [--out dir] [--compare take.glb] [--first-pass-only] [--watch]');
    process.exit(2);
  }
  const options: LookOptions = { ...(out ? { out } : {}), ...(compare ? { compare } : {}), ...(firstPassOnly ? { firstPassOnly } : {}) };
  if (!watching) { print(await poseLook(sheetFile, Number(at), options)); return; }
  const servers = await phase('viewer start', () => startViewer());
  const avatars: AvatarCache = new Map();
  let running = false, again = false;
  const look = async (): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try { print(await poseLook(sheetFile, Number(at), { ...options, servers, avatars })); } catch (e) { console.error(`look failed: ${(e as Error).message}`); }
    running = false;
    if (again) { again = false; await look(); }
  };
  await look();
  console.log(`watching ${sheetFile}; each save makes the look again (Ctrl-C stops)`);
  let timer: NodeJS.Timeout | undefined;
  watch(sheetFile, () => { clearTimeout(timer); timer = setTimeout(() => void look(), 200); });
  process.on('SIGINT', () => { servers.close(); process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
