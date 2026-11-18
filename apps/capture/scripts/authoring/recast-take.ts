/**
 * Step 2 of slice 4a (docs/features/directed-performance.md): plays an
 * imported take on other avatars and states in numbers what each loses.
 *
 *   node --conditions=development --import tsx scripts/authoring/recast-take.ts <take.json|recorded.glb> --to <avatar> [--to <avatar> …] [--out <dir>]
 *
 * `<avatar>` is `stock`, `fixture:<name>` (the audition's fixtures) or a GLB
 * path. For each it writes `<out>/<take>.<avatar>.glb` and adds a column to
 * `<out>/<take>.recast.md` / `.recast.json` (default out: output/take-input).
 *
 * The loss report compares three bodies: the take as recorded, the recast
 * (hips follow the take, scaled by leg length) and what capture's
 * rotation-only retargeting would keep (hips fixed at bind). Rows: hips
 * travel and height range; contacts (foot skate, float, penetration from
 * motion-quality); limb directions and the wrist's place relative to the
 * shoulder per arm length; the face channels the recording kept, of 52 ARKit,
 * that the target shows; and gaze.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { ARKIT_BLENDSHAPES } from '@holoim/avatar-face';

import { measureMotion, type JointName, type MotionFrame, type MotionMetrics } from '../lib/motion-quality.ts';
import { loadAvatar, type LoadedAvatar } from './lib/avatar.ts';
import { resolveAvatar } from './direct.ts';
import { recastTake, type Recast } from './lib/recast.ts';
import { importTake, takeMotion, type Take } from './lib/take.ts';
import { writeTake } from './lib/write-glb.ts';

export async function readTake(file: string): Promise<Take> {
  return /\.glb$/i.test(file) ? importTake(file) : (JSON.parse(await readFile(file, 'utf8')) as Take);
}

const SEGMENTS: ReadonlyArray<readonly [string, JointName, JointName]> = [
  ['upper arm L', 'leftShoulder', 'leftElbow'], ['forearm L', 'leftElbow', 'leftWrist'],
  ['upper arm R', 'rightShoulder', 'rightElbow'], ['forearm R', 'rightElbow', 'rightWrist'],
  ['thigh L', 'leftHip', 'leftKnee'], ['shin L', 'leftKnee', 'leftAnkle'],
  ['thigh R', 'rightHip', 'rightKnee'], ['shin R', 'rightKnee', 'rightAnkle'],
  ['spine', 'hips', 'chest'], ['neck', 'neck', 'head']
];

const p95 = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]! : 0; };
const r = (v: number, places = 3): number => Number(v.toFixed(places));
const at = (m: MotionFrame, j: JointName): THREE.Vector3 => new THREE.Vector3(...(m.joints[j] ?? [0, 0, 0]));
/** A joint segment, or undefined when either joint is missing (never measured against the origin). */
const seg = (m: MotionFrame, from: JointName, to: JointName): THREE.Vector3 | undefined => (m.joints[from] && m.joints[to] ? at(m, to).sub(at(m, from)) : undefined);

interface Body {
  /** Horizontal distance the hips travel, metres. */
  readonly hipsTravel: number;
  /** Hips height range over the take, metres. */
  readonly hipsRange: number;
  /** Hips height below the body's own standing bind, at the take's lowest, metres. */
  readonly hipsDrop: number;
  /** Median over the take of the lower ankle's height above its bind height, cm: + floats, − sinks into the floor. */
  readonly feetOffFloorCm: number;
  readonly contacts: Pick<MotionMetrics, 'footSkateMaxCm' | 'footSkateShare' | 'footFloatP95Cm' | 'footPenetrationCm'>;
}

function body(motion: MotionFrame[], hipsBind: number, ankleBind: number): Body {
  let travel = 0;
  const ys = motion.map((m) => at(m, 'hips').y);
  for (let i = 1; i < motion.length; i += 1) {
    const a = at(motion[i - 1]!, 'hips'); const b = at(motion[i]!, 'hips');
    travel += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const m = measureMotion(motion);
  const ankles = motion.map((f) => Math.min(at(f, 'leftAnkle').y, at(f, 'rightAnkle').y) - ankleBind).sort((x, y) => x - y);
  return {
    hipsTravel: r(travel), hipsRange: r(Math.max(...ys) - Math.min(...ys)), hipsDrop: r(hipsBind - Math.min(...ys)), feetOffFloorCm: r((ankles[Math.floor(ankles.length / 2)] ?? 0) * 100, 1),
    contacts: { footSkateMaxCm: m.footSkateMaxCm, footSkateShare: m.footSkateShare, footFloatP95Cm: m.footFloatP95Cm, footPenetrationCm: m.footPenetrationCm }
  };
}

export interface Loss {
  readonly avatar: string;
  readonly file: string;
  readonly scale: number;
  readonly maxBindCorrectionDeg: number;
  readonly missingBones: string[];
  readonly recast: Body;
  readonly rotationOnly: Body;
  /** p95 angle between the recorded and the recast limb, per segment, degrees. */
  readonly limbP95Deg: Record<string, number>;
  /** p95 of the wrist's place from its shoulder, recorded vs recast, as a share of arm length, per side. */
  readonly wristP95Share: { left: number; right: number };
  readonly face: { readonly recorded: number; readonly moving: string[]; readonly shown: number; readonly lostOnTarget: string[]; readonly gazeBy: string };
}

function lossOf(take: Take, spec: string, a: LoadedAvatar, recast: Recast, fixed: Recast): Loss {
  const src = takeMotion(take);
  const out = recast.solved.tracks[0]!.motion;
  // Directions are compared in each body's own frame: the target's body is fixed for the take.
  const toBody = (v: THREE.Vector3): THREE.Vector3 => a.body.worldToLocal(v.clone()).sub(a.body.worldToLocal(new THREE.Vector3()));
  const limb: Record<string, number> = {};
  for (const [name, from, to] of SEGMENTS) {
    const errs: number[] = [];
    for (let f = 0; f < take.frames; f += 1) {
      const s = seg(src[f]!, from, to); const o = seg(out[f]!, from, to);
      if (!s || !o) continue;
      const t = toBody(o);
      if (s.lengthSq() > 1e-8 && t.lengthSq() > 1e-8) errs.push(s.angleTo(t) * THREE.MathUtils.RAD2DEG);
    }
    limb[name] = r(p95(errs), 1);
  }
  const len = (side: 'left' | 'right'): number => {
    const b = (bone: string): THREE.Vector3 => a.bind.get(bone as never)!.rootPosition;
    return b(`${side}UpperArm`).distanceTo(b(`${side}Hand`));
  };
  const armT = (len('left') + len('right')) / 2;
  const wrist = (side: 'left' | 'right'): number => {
    const sh = `${side}Shoulder` as JointName; const wr = `${side}Wrist` as JointName;
    const errs: number[] = [];
    for (let f = 0; f < take.frames; f += 1) {
      const s = seg(src[f]!, sh, wr); const o = seg(out[f]!, sh, wr);
      if (!s || !o) continue;
      errs.push(s.divideScalar(take.measures.armLength).distanceTo(toBody(o).divideScalar(armT)));
    }
    return r(p95(errs));
  };
  const faceReport = a.face.report();
  const recorded = Object.keys(take.face).filter((c) => (ARKIT_BLENDSHAPES as readonly string[]).includes(c));
  const moving = recorded.filter((c) => { const w = take.face[c as keyof Take['face']]!; return Math.max(...w) - Math.min(...w) > 0.02; });
  const bound = new Set<string>(faceReport.boundChannels);
  const unroutable = new Set<string>(faceReport.unroutableChannels);
  const lost = recorded.filter((c) => !bound.has(c) && unroutable.has(c));
  const hipsBindT = a.body.localToWorld(a.bind.get('hips')!.rootPosition.clone()).y;
  const ankleBindT = Math.min(a.body.localToWorld(a.bind.get('leftFoot')!.rootPosition.clone()).y, a.body.localToWorld(a.bind.get('rightFoot')!.rootPosition.clone()).y);
  return {
    avatar: spec, file: basename(a.file), scale: recast.scale,
    maxBindCorrectionDeg: Math.max(0, ...Object.values(recast.correctionDeg).map(Number)),
    missingBones: recast.missing,
    recast: body(out, hipsBindT, ankleBindT), rotationOnly: body(fixed.solved.tracks[0]!.motion, hipsBindT, ankleBindT),
    limbP95Deg: limb, wristP95Share: { left: wrist('left'), right: wrist('right') },
    face: { recorded: recorded.length, moving, shown: recorded.length - lost.length, lostOnTarget: lost, gazeBy: faceReport.gazeBy }
  };
}

const n = (v: number | null): string => (v === null ? 'n/a' : String(r(v, 2)));

export function lossMarkdown(take: Take, losses: Loss[]): string {
  const b = take.measures.bind;
  const src = body(takeMotion(take), take.measures.hipHeight, Math.min(b.leftFoot![1], b.rightFoot![1]));
  const cols = ['recorded', ...losses.flatMap((l) => [`${l.avatar} recast`, `${l.avatar} rotation-only`])];
  const row = (label: string, recorded: string, f: (l: Loss) => [string, string]): string => `| ${label} | ${recorded} | ${losses.flatMap((l) => f(l)).join(' | ')} |`;
  const lines = [
    `# Recast: ${take.source.file}`,
    '',
    `The take as recorded, each recast (hips follow the take scaled by leg length) and what rotation-only retargeting (hips fixed at bind, as capture's \`retargetClips\` keeps them; this tool's bind correction on every limb, where \`retargetClips\` corrects the arms and hands only) keeps on the same avatar.`,
    '',
    `| | ${cols.join(' | ')} |`,
    `|---|${cols.map(() => '---').join('|')}|`,
    row('leg scale', '1', (l) => [String(l.scale), String(l.scale)]),
    row('largest bind correction °', '0', (l) => [String(l.maxBindCorrectionDeg), String(l.maxBindCorrectionDeg)]),
    row('hips travel m', String(src.hipsTravel), (l) => [String(l.recast.hipsTravel), String(l.rotationOnly.hipsTravel)]),
    row('hips height range m', String(src.hipsRange), (l) => [String(l.recast.hipsRange), String(l.rotationOnly.hipsRange)]),
    row('hips drop below bind m', String(src.hipsDrop), (l) => [String(l.recast.hipsDrop), String(l.rotationOnly.hipsDrop)]),
    row('feet off the floor, median cm (+ float, − sink)', n(src.feetOffFloorCm), (l) => [n(l.recast.feetOffFloorCm), n(l.rotationOnly.feetOffFloorCm)]),
    row('foot skate worst cm', n(src.contacts.footSkateMaxCm), (l) => [n(l.recast.contacts.footSkateMaxCm), n(l.rotationOnly.contacts.footSkateMaxCm)]),
    row('foot float p95 cm', n(src.contacts.footFloatP95Cm), (l) => [n(l.recast.contacts.footFloatP95Cm), n(l.rotationOnly.contacts.footFloatP95Cm)]),
    row('foot penetration cm', n(src.contacts.footPenetrationCm), (l) => [n(l.recast.contacts.footPenetrationCm), n(l.rotationOnly.contacts.footPenetrationCm)]),
    row('worst limb p95 °', '0', (l) => { const v = String(Math.max(...Object.values(l.limbP95Deg))); return [v, v]; }),
    row('wrist place p95 (share of arm) L / R', '0 / 0', (l) => { const v = `${l.wristP95Share.left} / ${l.wristP95Share.right}`; return [v, v]; }),
    row('face channels shown, of those recorded', `${losses[0]?.face.recorded ?? 0}`, (l) => [`${l.face.shown}`, `${l.face.shown}`]),
    row('gaze carried by', 'eye bones', (l) => [l.face.gazeBy, l.face.gazeBy]),
    '',
    '## What is lost',
    '',
    `- **Hips travel.** Rotation-only retargeting keeps the hips at bind: it drops ${src.hipsTravel} m of travel and ${src.hipsDrop} m of drop below standing${src.hipsDrop > 0.05 ? ' (the performer is lower than standing: the legs bend but the body does not come down, so the feet float off the floor by the feet row above)' : ''}. The recast keeps both, scaled by leg length.`,
    `- **Contacts.** The recording carries no contact (no planted-foot or hand-on-object flags), only rotations; a recast re-derives where the feet are from the rotations and the new leg lengths, so any skate or penetration above is the new body's, not the performer's. A hand on a surface or another body is not kept at all.`,
    `- **Face detail.** The recording kept ${losses[0]?.face.recorded ?? 0} of ${ARKIT_BLENDSHAPES.length} ARKit channels, the ones its avatar had shapes for; ${ARKIT_BLENDSHAPES.length - (losses[0]?.face.recorded ?? 0)} were lost at record time, before any recast. Of those kept, ${losses[0]?.face.moving.length ?? 0} move in this take (${losses[0]?.face.moving.join(', ') || 'none'}). Per target, the channels the target cannot show: ${losses.map((l) => `${l.avatar} ${l.face.lostOnTarget.length ? l.face.lostOnTarget.join(', ') : 'none'}`).join('; ')}.${losses.filter((l) => l.face.gazeBy === 'none').map((l) => ` ${l.avatar} has neither eye bones nor eyeLook shapes, so the recorded gaze is lost on it.`).join('')}`,
    `- **Hand goals.** Fingers and wrists are copied as rotations: on a body whose arms differ, the hand lands elsewhere relative to the shoulder (the wrist place row) and nothing re-aims it, because the recording does not say what the hand was reaching for.`,
    ''
  ];
  for (const l of losses) {
    lines.push(`### ${l.avatar} (${l.file})`, '', `- limb p95 °: ${Object.entries(l.limbP95Deg).map(([k, v]) => `${k} ${v}`).join(', ')}`, `- bones of the take this avatar lacks: ${l.missingBones.length ? l.missingBones.join(', ') : 'none'}`, '');
  }
  return lines.join('\n');
}

const slug = (spec: string): string => basename(spec).replace(/^fixture:/, '').replace(/\.glb$/i, '').replace(/[^a-z0-9-]+/gi, '-');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const targets = flags('--to');
  if (!file || !targets.length) throw new Error('usage: recast-take.ts <take.json|recorded.glb> --to <avatar> [--to …] [--out <dir>]');
  const out = resolve(flags('--out')[0] ?? 'output/take-input');
  await mkdir(out, { recursive: true });
  const take = await readTake(resolve(file));
  const name = basename(file).replace(/\.(take\.json|glb)$/i, '');
  const losses: Loss[] = [];
  for (const spec of targets) {
    const avatarFile = await resolveAvatar(spec, join(process.cwd(), 'sheet.json'));
    const a = await loadAvatar(avatarFile);
    const fixed = recastTake(take, a, { hips: 'fixed', avatarSpec: spec });
    const recast = recastTake(take, a, { avatarSpec: spec, title: `${name} on ${spec}` });
    const written = await writeTake(recast.solved, { author: 'recorded performer, recast by the authoring tool', title: `${name} on ${spec}`, method: 'imported take recast', source: take.source.file, sourceSha256: take.source.sha256, avatar: spec });
    const glb = join(out, `${name}.${slug(spec)}.glb`);
    await writeFile(glb, written.glb);
    losses.push(lossOf(take, spec === 'stock' || spec.startsWith('fixture:') ? spec : slug(spec), a, recast, fixed));
    console.log(`wrote ${glb} (${written.channels} channels)`);
  }
  const md = lossMarkdown(take, losses);
  await writeFile(join(out, `${name}.recast.md`), md);
  await writeFile(join(out, `${name}.recast.json`), JSON.stringify({ take: take.source, losses }, null, 2));
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
