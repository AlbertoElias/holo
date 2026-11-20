/**
 * Fits the VR arm pose model (`src/ik/armPoseCoefficients.ts`) to recorded
 * human arms: CMU takes converted by `amc-to-dump.ts`.
 *
 *   node --import tsx scripts/mocap/fit-arm-pose.ts [dump-dir] [--write]
 *
 * The dump directory (default `output/mocap-reach`, git-ignored) holds the
 * dumps; only the coefficients are committed. Without `--write` the script
 * prints the held-out error and changes nothing.
 *
 * Every sample is one arm on one frame, in the torso frame: x out of the body
 * (mirrored per side), y up (hips to chest, square to the hips), z forward.
 *
 * - Elbow pole: the elbow's direction off the shoulder–wrist line, from the
 *   wrist position (shoulder to wrist over arm length, quadratic) and the palm's
 *   across direction (pinky to index knuckle). Weighted by the elbow bend
 *   (a straight arm's pole is noise).
 * - Clavicle protraction: the clavicle's forward angle relative to the
 *   subject's own hanging arm, quadratic in the wrist position.
 *
 * Both are ridge fits. The held-out error leaves one take out at a time.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type V = [number, number, number];
type Frame = Record<string, number[]>;
type Sample = { take: string; side: 'l' | 'r'; p: V; across: V; pole: V | null; bend: number; push: number; down: number };

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V): V => scale(a, 1 / (len(a) || 1));
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const reject = (a: V, axis: V): V => sub(a, scale(axis, dot(a, axis)));

/** The features both fits share: 1, p, and p's quadratic terms (10). The elbow adds the across vector (13). */
export function poseFeatures(p: V, across?: V): number[] {
  const f = [1, p[0], p[1], p[2]];
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) f.push(p[i]! * p[j]!);
  if (across) f.push(across[0], across[1], across[2]);
  return f;
}

function samplesOf(take: string, frames: Frame[]): Sample[] {
  const out: Sample[] = [];
  for (const frame of frames) {
    const at = (bone: string): V => frame[bone]!.slice(4, 7) as V;
    const right = norm(sub(at('rThigh'), at('lThigh')));
    const up = norm(reject(sub(at('chest'), at('hip')), right));
    const forward = cross(up, right);
    for (const side of ['l', 'r'] as const) {
      const outward = side === 'r' ? right : scale(right, -1);
      const torso = (v: V): V => [dot(v, outward), dot(v, up), dot(v, forward)];
      const shoulder = at(`${side}Shldr`);
      const elbow = at(`${side}ForeArm`);
      const wrist = at(`${side}Hand`);
      const armLength = len(sub(elbow, shoulder)) + len(sub(wrist, elbow));
      const w = torso(sub(wrist, shoulder));
      const axis = norm(w);
      const off = reject(torso(sub(elbow, shoulder)), axis);
      const cosBend = dot(norm(sub(elbow, shoulder)), norm(sub(wrist, elbow)));
      const bend = Math.acos(Math.max(-1, Math.min(1, cosBend)));
      const clavicle = norm(torso(sub(shoulder, at(`${side}Collar`))));
      out.push({
        take,
        side,
        p: scale(w, 1 / armLength),
        across: norm(torso(sub(at(`${side}Index1`), at(`${side}Pinky1`)))),
        pole: len(off) > 1e-3 ? norm(off) : null,
        bend,
        push: (Math.asin(Math.max(-1, Math.min(1, clavicle[2]))) * 180) / Math.PI,
        down: -axis[1]
      });
    }
  }
  return out;
}

type Rest = Record<string, { p: V; parent: string | null }>;

/**
 * Arm length (shoulder to elbow to wrist joint) over shoulder height above the
 * lowest foot or toe joint, in the rest pose (z up). The runtime measures the
 * avatar the same way (`AvatarRig.createArmIkChain`).
 */
function armToShoulderHeight(rest: Rest): number {
  const world = new Map<string, V>();
  const at = (bone: string): V => {
    const known = world.get(bone);
    if (known) return known;
    const { p, parent } = rest[bone]!;
    const base = parent ? at(parent) : ([0, 0, 0] as V);
    const result: V = [base[0] + p[0], base[1] + p[1], base[2] + p[2]];
    world.set(bone, result);
    return result;
  };
  const arm = len(sub(at('lForeArm'), at('lShldr'))) + len(sub(at('lHand'), at('lForeArm')));
  const floor = Math.min(at('lFoot')[2], at('lToe')[2], at('rFoot')[2], at('rToe')[2]);
  return arm / (at('lShldr')[2] - floor);
}

/** Solves (XᵀWX + λI) B = XᵀWY for B (columns of Y), by Gaussian elimination. */
function ridge(rows: number[][], ys: number[][], weights: number[], lambda: number): number[][] {
  const n = rows[0]!.length;
  const m = ys[0]!.length;
  const a = Array.from({ length: n }, (_, i) => Array.from({ length: n + m }, (_, j) => (j === i ? lambda : 0)));
  rows.forEach((x, k) => {
    const w = weights[k]!;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i]![j]! += w * x[i]! * x[j]!;
      for (let c = 0; c < m; c++) a[i]![n + c]! += w * x[i]! * ys[k]![c]!;
    }
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / a[col]![col]!;
      for (let j = col; j < n + m; j++) a[r]![j]! -= f * a[col]![j]!;
    }
  }
  return Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, c) => a[i]![n + c]! / a[i]![i]!));
}

const apply = (b: number[][], x: number[]) => b[0]!.map((_, c) => x.reduce((s, xi, i) => s + xi * b[i]![c]!, 0));

function poleOf(b: number[][], s: Sample): V {
  const axis = norm(s.p);
  return norm(reject(apply(b, poseFeatures(s.p, s.across)) as V, axis));
}

const percentile = (values: number[], q: number) => {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const round = (v: number, digits = 4) => Number(v.toFixed(digits));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const dir = args.find((a) => !a.startsWith('--')) ?? 'output/mocap-reach';
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no dumps in ${dir}; convert CMU takes with amc-to-dump.ts`);

  const all: Sample[] = [];
  const armToShoulder = new Map<string, number>();
  for (const file of files) {
    const dump = JSON.parse(await readFile(path.join(dir, file), 'utf8')) as { frames: Frame[]; rest: Rest };
    all.push(...samplesOf(file.replace(/\.json$/, ''), dump.frames));
    armToShoulder.set(file.split('_')[0]!, armToShoulderHeight(dump.rest));
  }
  const armRatio = percentile([...armToShoulder.values()], 0.5);

  // Clavicle protraction relative to the subject's own hanging arm (per side).
  const subjectSide = (s: Sample) => `${s.take.split('_')[0]}/${s.side}`;
  const hanging = new Map<string, number[]>();
  for (const s of all) {
    if (s.down <= 0.93) continue;
    const key = subjectSide(s);
    if (!hanging.has(key)) hanging.set(key, []);
    hanging.get(key)!.push(s.push);
  }
  const pushRel = all.map((s) => s.push - percentile(hanging.get(subjectSide(s)) ?? [s.push], 0.5));

  const elbowSet = all.filter((s) => s.pole && s.bend > (10 * Math.PI) / 180);
  const elbowWeight = (s: Sample) => Math.max(0.05, Math.sin(s.bend));
  const takes = [...new Set(all.map((s) => s.take))];

  const heldOut: number[] = [];
  const pushResidual: number[] = [];
  for (const take of takes) {
    const train = elbowSet.filter((s) => s.take !== take);
    const b = ridge(train.map((s) => poseFeatures(s.p, s.across)), train.map((s) => s.pole!), train.map(elbowWeight), 1e-2);
    for (const s of elbowSet) if (s.take === take) heldOut.push((Math.acos(Math.max(-1, Math.min(1, dot(poleOf(b, s), s.pole!)))) * 180) / Math.PI);
    const ci = all.map((s, i) => i).filter((i) => all[i]!.take !== take);
    const bc = ridge(ci.map((i) => poseFeatures(all[i]!.p)), ci.map((i) => [pushRel[i]!]), ci.map(() => 1), 1e-2);
    all.forEach((s, i) => { if (s.take === take) pushResidual.push(pushRel[i]! - apply(bc, poseFeatures(s.p))[0]!); });
  }
  const variance = (v: number[]) => { const m = v.reduce((a, x) => a + x, 0) / v.length; return v.reduce((a, x) => a + (x - m) ** 2, 0) / v.length; };
  console.log(`${files.length} takes, ${all.length} arm samples, ${elbowSet.length} bent`);
  console.log(`elbow pole held out: median ${percentile(heldOut, 0.5).toFixed(1)}°, p90 ${percentile(heldOut, 0.9).toFixed(1)}°`);
  console.log(`arm / shoulder height over ${armToShoulder.size} subjects: median ${armRatio.toFixed(3)}, range ${Math.min(...armToShoulder.values()).toFixed(3)}–${Math.max(...armToShoulder.values()).toFixed(3)}`);
  console.log(`clavicle protraction held out: R² ${(1 - variance(pushResidual) / variance(pushRel)).toFixed(2)}`);

  const elbow = ridge(elbowSet.map((s) => poseFeatures(s.p, s.across)), elbowSet.map((s) => s.pole!), elbowSet.map(elbowWeight), 1e-2);
  const clavicle = ridge(all.map((s) => poseFeatures(s.p)), pushRel.map((v) => [v]), all.map(() => 1), 1e-2);
  const pRange = [0, 1, 2].map((k) => [round(percentile(all.map((s) => s.p[k]!), 0.01), 3), round(percentile(all.map((s) => s.p[k]!), 0.99), 3)]);
  const pushRange = [round(percentile(pushRel, 0.01), 1), round(percentile(pushRel, 0.99), 1)];

  const source = `// Generated by scripts/mocap/fit-arm-pose.ts from ${files.length} CMU takes
// (${all.length} arm samples). Do not edit; rerun the fit with --write.
// Torso frame: x out of the body (mirrored per side), y up, z forward.

/** Elbow pole = features(p, across) · ELBOW_POLE (13 × 3); held out median ${percentile(heldOut, 0.5).toFixed(1)}°. */
export const ELBOW_POLE: ReadonlyArray<readonly [number, number, number]> = ${JSON.stringify(elbow.map((r) => r.map((v) => round(v))))};

/** Clavicle protraction (degrees from the hanging arm) = features(p) · CLAVICLE_PROTRACTION (10). */
export const CLAVICLE_PROTRACTION: ReadonlyArray<number> = ${JSON.stringify(clavicle.map((r) => round(r[0]!, 3)))};

/** The 1st and 99th percentiles of p (shoulder to wrist over arm length) per torso axis. */
export const WRIST_RANGE: ReadonlyArray<readonly [number, number]> = ${JSON.stringify(pRange)};

/** Median arm length over shoulder height (above the lowest foot or toe joint), ${armToShoulder.size} subjects. */
export const ARM_TO_SHOULDER_HEIGHT = ${round(armRatio, 3)};

/** The 1st and 99th percentiles of the recorded protraction, in degrees. */
export const PROTRACTION_RANGE: readonly [number, number] = ${JSON.stringify(pushRange)};
`;
  if (write) {
    await writeFile('src/ik/armPoseCoefficients.ts', source);
    console.log('wrote src/ik/armPoseCoefficients.ts');
  }
}

await main();
