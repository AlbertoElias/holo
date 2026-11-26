/**
 * A look at one moment of a sheet, in less time than a full build.
 *
 *   node --conditions=development --import tsx scripts/authoring/pose-look.ts <sheet.json> --at <seconds> [--out dir] [--compare take.glb]
 *
 * The solver carries state from frame to frame (the clearing plan, the lift
 * ease, the twist rate limit, goals fixed at first use, the other performer's
 * last frame), so one frame solved alone does not give the pose of the full
 * build. This command solves frames 0 to f + 13 with every solve pass of the
 * full build, exports that window, opens it in the viewer and saves close
 * pictures of each hand that touches something at that moment, from two
 * angles: from the side the card sees and from 90° to its right.
 *
 * `--compare take.glb` reads the same frame of a full build and gives the
 * largest bone turn difference (degrees) and the largest palm centre
 * distance (mm) between the two.
 *
 * It writes `pose-look.json` (the phase times, the hands, the pictures and
 * the comparison) and the pictures into the out directory.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { build } from './direct.ts';
import { holdingsOf, parseSheetText, resolveTiming, type BeatSheet } from './lib/beats.ts';
import { findPerformers, parents, parseGlb, readChannels, sampleChannel, type GltfDoc } from './lib/gltf-read.ts';
import { phase, phaseLine } from './lib/phases.ts';
import { REVIEW_PAGE } from './lib/review-page.ts';
import { openTake, startViewer } from './lib/viewer-session.ts';
import { BACKGROUND } from './review.ts';

const OUTPUT = fileURLToPath(new URL('../../output/authoring/pose-look/', import.meta.url));
/** Frames solved after the one looked at: the clearing plan is widened 4 frames and smoothed with a sigma of 3 frames, so later frames still change it. */
export const AFTER = 13;
const SIZE = 720;
const FOV = 40;
/** Camera distance from the hand, metres. */
const DISTANCE = 0.55;
const HAND_KINDS = new Set(['reach', 'take', 'put', 'aim', 'drop']);

type Side = 'left' | 'right';
interface Hand { readonly performer: string; readonly side: Side; readonly why: string }

/** The hands that touch or hold something at `t`: a hand direction under way, or an object held. */
export function touchingHands(sheet: BeatSheet, t: number): Hand[] {
  const out = new Map<string, Hand>();
  const add = (h: Hand) => { const k = `${h.performer}.${h.side}`; if (!out.has(k)) out.set(k, h); };
  for (const b of sheet.beats) for (const d of b.directions) {
    if (!HAND_KINDS.has(d.kind) || !('side' in d) || !d.side) continue;
    const r = resolveTiming(b, d);
    if (t >= r.start && t <= r.end) add({ performer: b.performer, side: d.side as Side, why: `${d.kind} in beat ${b.id} (${r.start.toFixed(2)}-${r.end.toFixed(2)} s)` });
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
  readonly hands: readonly (Hand & { pictures: string[] })[];
  readonly note?: string;
  readonly compare?: PoseDiff & { readonly take: string };
}

export async function poseLook(sheetFile: string, at: number, options: { out?: string; compare?: string } = {}): Promise<PoseLook> {
  const started = performance.now();
  const sheet = parseSheetText(await readFile(sheetFile, 'utf8'), basename(sheetFile));
  const fps = sheet.fps ?? 30;
  const total = Math.round(sheet.duration * fps) + 1;
  const frame = Math.round(at * fps);
  if (!(frame >= 0 && frame < total)) throw new Error(`--at ${at} s is outside the take (0 to ${sheet.duration} s)`);
  const t = frame / fps;
  const out = resolve(options.out ?? join(OUTPUT, basename(sheetFile).replace(/\.jsonc?$/, ''), `t${t.toFixed(2)}`));
  await mkdir(out, { recursive: true });
  const glb = join(out, 'window.glb');
  const framesSolved = Math.min(total, frame + AFTER + 1);
  const built = await build(sheetFile, glb, undefined, undefined, { frames: framesSolved });
  const phases = built.phases as { name: string; seconds: number }[];

  let hands = touchingHands(sheet, t);
  let note: string | undefined;
  if (!hands.length) {
    note = `no hand touches or holds anything at ${t.toFixed(2)} s: pictures of every hand`;
    hands = sheet.performers.flatMap((p) => (['left', 'right'] as const).map((side) => ({ performer: p.id, side, why: 'no touch at this moment' })));
  }

  const servers = await phase('viewer start', () => startViewer());
  const shown: (Hand & { pictures: string[] })[] = [];
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
          const pictures: string[] = [];
          for (const [name, turn] of [['card', 0], ['side', -90]] as const) {
            const dir = toCard.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), turn * THREE.MathUtils.DEG2RAD);
            const position = target.clone().addScaledVector(dir, DISTANCE).add(new THREE.Vector3(0, 0.12, 0));
            const shot = await R('close', i, { position: position.toArray(), target: target.toArray(), fov: FOV, width: SIZE, height: SIZE, background: BACKGROUND, label: `${h.performer} ${h.side} hand, ${t.toFixed(2)} s, ${name}` }) as { image: string };
            const file = join(out, `${h.performer}-${h.side}-${name}.jpg`);
            await writeFile(file, Buffer.from(shot.image.slice(shot.image.indexOf(',') + 1), 'base64'));
            pictures.push(file);
          }
          shown.push({ ...h, pictures });
        }
      });
    } finally {
      await open.close();
    }
  } finally {
    servers.close();
  }

  let compare: PoseLook['compare'];
  if (options.compare) {
    const full = parseGlb(new Uint8Array(await readFile(options.compare)));
    compare = { take: resolve(options.compare), ...poseDiff(parseGlb(new Uint8Array(await readFile(glb))), full, t) };
  }
  const look: PoseLook = { sheet: resolve(sheetFile), at: t, frame, framesSolved, seconds: (performance.now() - started) / 1000, phases, hands: shown, ...(note ? { note } : {}), ...(compare ? { compare } : {}) };
  await writeFile(join(out, 'pose-look.json'), `${JSON.stringify(look, null, 2)}\n`);
  return look;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i === -1 ? undefined : args.splice(i, 2)[1]; };
  const at = flag('--at');
  const out = flag('--out');
  const compare = flag('--compare');
  const sheetFile = args[0];
  if (!sheetFile || at === undefined || !Number.isFinite(Number(at))) {
    console.error('usage: pose-look.ts <sheet.json> --at <seconds> [--out dir] [--compare take.glb]');
    process.exit(2);
  }
  const look = await poseLook(sheetFile, Number(at), { ...(out ? { out } : {}), ...(compare ? { compare } : {}) });
  console.log(`pose look at ${look.at.toFixed(2)} s (frame ${look.frame}, ${look.framesSolved} frames solved) in ${look.seconds.toFixed(1)} s`);
  console.log(`  phases: ${phaseLine(look.phases)}`);
  if (look.note) console.log(`  ${look.note}`);
  for (const h of look.hands) console.log(`  ${h.performer} ${h.side} (${h.why}): ${h.pictures.join(', ')}`);
  if (look.compare) {
    const c = look.compare;
    console.log(`  against ${c.take}: bones within ${c.boneDeg.toFixed(3)}° (worst ${c.boneAt}), palms within ${c.palmMm.toFixed(3)} mm (worst ${c.palmAt})`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
