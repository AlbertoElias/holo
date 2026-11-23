// Desktop keyboard motion quality: walks, strafes, backs up and crouch-walks
// the avatar with keyboard input on the desktop capture page (frozen page
// clock, 30 Hz), samples the body every frame, and grades it with the
// shared motion-quality report (scripts/lib/motion-quality.ts, source
// "desktop"), strictly, on the shipped (default) avatar, on the stock avatar and on each skeleton the
// avatars check replays (scripts/lib/avatar-fixtures.ts), one page each.
// Samples and reports go to output/ci-desktop-motion/ (<avatar>-samples.json,
// <avatar>-report.json, summary.json). MOTION_QUALITY_REPORT_ONLY=1 reports
// misses without failing; DESKTOP_MOTION_ONLY=<substring> keeps matching avatars.
// The shipped avatar also walks the default terrain (row "shipped-terrain"), judged
// on its feet against the slopes (no sinking, no floating), and every row reports
// the per-frame cost of animation + body IK (__samplePoseCost).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright';
import {
  attachXrEnvironment, createXrContext, launchXrBrowser, wireXrConsoleErrors,
  waitForPageFunctions, waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';
import type {} from '../src/runtime/automationHooks';
import type { BodySample } from '../src/types/contracts';
import { DEFAULT_AVATAR_URL, STOCK_AVATAR_URL } from '../src/config/runtimeConfig';
import { generateAvatarFixtures } from './lib/avatar-fixtures.ts';
import { judgeGait, measureGait } from './lib/gait-metrics';
import { framesFromBodySamples, judgeMotion, measureMotion, type MotionFrame } from './lib/motion-quality';

type Input = { forward: boolean; back: boolean; left: boolean; right: boolean; crouch: boolean };
const idle: Input = { forward: false, back: false, left: false, right: false, crouch: false };
const FRAME_MS = 1000 / 30;
const artifactDir = path.resolve('output/ci-desktop-motion');
const consoleErrors: string[] = [];
// A flat 40 m floor (the app places its top at y = 0), so ground truth is
// exact; the default terrain's slopes would mix terrain following into the feet.
const FLOOR_Y = 0;
function floorGltf(): string {
  const v = [-20, FLOOR_Y, -20, -20, FLOOR_Y, 20, 20, FLOOR_Y, 20, -20, FLOOR_Y, -20, 20, FLOOR_Y, 20, 20, FLOOR_Y, -20];
  const data = Buffer.from(new Float32Array(v).buffer);
  return JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.3, 0.45, 0.35, 1], metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }], buffers: [{ uri: `data:application/octet-stream;base64,${data.toString('base64')}`, byteLength: data.length }], bufferViews: [{ buffer: 0, byteLength: data.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [-20, FLOOR_Y, -20], max: [20, FLOOR_Y, 20] }] });
}

// Phases: [label, seconds, input, view]. A view toggles the desktop view (V) to it before the phase.
type View = 'first' | 'third';
type Phase = [string, number, Input, View?];
const SCRIPT: Phase[] = [
  ['idle', 1, idle],
  // Long enough for three steady strides after the start, for the gait metrics.
  ['walk', 5, { ...idle, forward: true }],
  ['stop', 1.5, idle],
  // Third person: the body turns and walks forward that way.
  ['strafe', 2, { ...idle, left: true }],
  ['stop', 1.5, idle],
  ['back', 2.5, { ...idle, back: true }],
  ['stop', 1.5, idle],
  ['crouch-walk', 2.5, { ...idle, forward: true, crouch: true }],
  ['stop', 1.5, idle],
  // First person keeps the body on the look: A and D side-step.
  ['fp-left', 2.5, { ...idle, left: true }, 'first'],
  ['stop', 1.5, idle],
  ['fp-right', 2.5, { ...idle, right: true }],
  // Long enough to read the idle's sway standing.
  ['stop', 5, idle, 'third']
];

// On the default terrain: straight ahead over its slopes, then diagonally (forward and left).
const TERRAIN_SCRIPT: Phase[] = [
  ['idle', 1, idle],
  ['walk', 5, { ...idle, forward: true }],
  ['stop', 1.5, idle],
  ['diagonal', 3, { ...idle, forward: true, left: true }],
  ['stop', 1.5, idle]
];
// Feet on slopes (brief acceptance): toe and ankle at most 1.5 cm under the ground under each of them
// (`footBelowGroundCm`), planted feet within 2 cm above it. The shared penetration metric measures the
// lower foot joint against one ground height per foot, from its resting height, so on a slope a toe
// planted downhill of the ankle reads as sunk; on terrain each joint is judged against its own ground.
const TERRAIN_TARGETS = { footBelowGroundCm: { max: 1.5 }, footFloatP95Cm: { max: 2 } } as const;
const FOOT_JOINTS = ['leftToe', 'rightToe', 'leftAnkle', 'rightAnkle'] as const;
// The body is in the air (walked off a ledge) while its hips stand this far (m) above their standing height
// over the ground under it; the leg solver lets the feet go then, so those frames are counted, not judged.
const AIRBORNE_M = 0.25;
// At most this share of the terrain run may be airborne, and the walk must still cover ground: a body stuck
// against a rock, or one floating over the terrain, would otherwise skip every frame and read 0 cm.
const MAX_AIRBORNE_SHARE = 0.1;
const MIN_TERRAIN_WALK_SPEED = 1.0;

/** The deepest any toe or ankle went under the ground straight below it, in cm (0 when never under), on the ground. */
function footBelowGround(samples: Array<{ phase: string; body: BodySample }>): { cm: number; airborneFrames: number } {
  const hipsOverGround = (body: BodySample) => body.bones.hips && body.ground.root ? body.bones.hips[1] - body.ground.root.y : undefined;
  const standing = samples.filter((s) => s.phase === 'idle').map((s) => hipsOverGround(s.body)).filter((h): h is number => h !== undefined).sort((a, b) => a - b);
  const stand = standing[Math.floor(standing.length / 2)] ?? Infinity;
  let deepest = 0, airborneFrames = 0;
  for (const { body } of samples) {
    const over = hipsOverGround(body);
    if (over !== undefined && over > stand + AIRBORNE_M) { airborneFrames++; continue; }
    for (const joint of FOOT_JOINTS) {
      const at = body.bones[joint], ground = body.ground[joint];
      if (at && ground) deepest = Math.max(deepest, ground.y - at[1]);
    }
  }
  return { cm: deepest * 100, airborneFrames };
}
// Animation + body IK per avatar per frame, median. The brief's acceptance is 0.25 ms on the desktop
// test machine; this gate only catches a regression of several times that, because performance.now()
// counts in 0.1 ms steps and hosted runners read 0.30 ms for the same work (B-071).
const POSE_COST_MEDIAN_MS = 1;

// The geometric skeletons the avatars check replays (bone axes, bind pose, facing, scale).
const SKELETONS = ['reoriented-axes', 'a-pose', 't-pose', 't-pose-twisted', 'vrm0-minus-z', 'z-up', 'unreal-cm'];

/** Per frame, what the animation and the leg solver report (render_game_to_text). */
type Loco = {
  state: string; timeScale: number; phase: number | null; directions: Record<string, number>; clipCrouch: number;
  pelvisDrop: number; swayWeight: number; yaw: number; crouch: number;
  legs: Array<{ side: string; mode: string; groundY: number | null; tilt: number | null; slope: number | null; foot: { x: number; y: number; z: number } }>;
};

async function run(page: Page, avatarUrl: string | null, terrain = false, probeAllocations = false) {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__setManualClock', {
      configurable: true,
      set(value: (enabled: boolean) => void) {
        Object.defineProperty(window, '__setManualClock', { value, writable: true, configurable: true });
        value(true);
      }
    });
  });
  wireXrConsoleErrors(page, consoleErrors, { label: 'desktop-motion' });
  await page.route('**/desktop-motion-floor.gltf', (route) => route.fulfill({ contentType: 'model/gltf+json', body: floorGltf() }));
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  const url = new URL(process.env.BASE_URL ?? 'https://127.0.0.1:5374/');
  if (!terrain) {
    url.searchParams.set('scene', '/desktop-motion-floor.gltf');
    url.searchParams.set('sceneScale', '1');
  }
  url.searchParams.set('avatarHeight', '1.8');
  if (avatarUrl) url.searchParams.set('avatar', avatarUrl);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__sampleHumanoid', '__setManualClock', '__setMockInput', '__respawnCharacter', '__sampleBody', '__samplePoseCost', 'advanceTime']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => {
    window.__setManualClock(true);
    window.__respawnCharacter();
    window.__setMockInput({ forward: false, back: false, left: false, right: false, crouch: false });
    window.advanceTime(1000);
  });
  const humanoid = await page.evaluate(() => window.__sampleHumanoid());
  const samples: Row[] = [];
  let timeMs = 0;
  await page.evaluate(() => window.__samplePoseCost(true));
  let view: View = 'third';
  // The leg solver's own allocations over the walking phases (sampled by V8's heap profiler), from after the
  // first idle (attach and its lazy setup are done) to the end.
  const cdp = probeAllocations ? await page.context().newCDPSession(page) : null;
  for (const [phase, seconds, input, nextView] of terrain ? TERRAIN_SCRIPT : SCRIPT) {
    if (nextView && nextView !== view) {
      await page.keyboard.press('KeyV');
      view = nextView;
    }
    if (cdp && phase !== 'idle' && !allocationProbe.started) {
      await cdp.send('Debugger.enable');
      await cdp.send('HeapProfiler.enable');
      // Temporaries die young: without the collected objects the profile keeps only what is still alive.
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: ALLOCATION_SAMPLING_BYTES, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      allocationProbe.started = true;
    }
    const frames = Math.round((seconds * 1000) / FRAME_MS);
    const chunk = await page.evaluate(
      ({ input, frames, frameMs }) => {
        window.__setMockInput(input);
        const out: Array<{ body: BodySample; loco: Loco }> = [];
        for (let i = 0; i < frames; i++) {
          window.advanceTime(frameMs);
          const state = JSON.parse(window.render_game_to_text());
          const l = state.locomotion;
          out.push({
            body: window.__sampleBody(),
            loco: {
              state: l.state, timeScale: l.timeScale, phase: l.gait?.phase ?? null, directions: l.directions ?? {},
              clipCrouch: l.clipCrouch ?? 0, pelvisDrop: l.pelvisDrop ?? 0, swayWeight: l.swayWeight ?? 0,
              yaw: state.avatar.yaw, crouch: state.crouch.poseAmount,
              legs: (l.legs ?? []).map((g: { side: string; mode: string; groundY: number | null; groundTiltDeg: number | null; groundSlopeDeg: number | null; foot: { x: number; y: number; z: number } }) =>
                ({ side: g.side, mode: g.mode, groundY: g.groundY, tilt: g.groundTiltDeg, slope: g.groundSlopeDeg, foot: g.foot }))
            }
          });
        }
        return out;
      },
      { input, frames, frameMs: FRAME_MS }
    );
    for (const { body, loco } of chunk) {
      timeMs += FRAME_MS;
      samples.push({ timeMs, phase, body, loco });
    }
  }
  const poseCost = await page.evaluate(() => window.__samplePoseCost());
  let solverAllocatedBytes: number | null = null;
  if (cdp && allocationProbe.started) {
    const { profile } = await cdp.send('HeapProfiler.stopSampling') as { profile: { head: HeapNode } };
    const range = await solverRange(cdp, profile.head);
    if (!range) throw new Error(`allocation probe: no script defines ${SOLVER_MARKER}() (renamed in TerrainLegSolver?)`);
    solverAllocatedBytes = allocatedIn(profile.head, range, false);
    allocationProbe.started = false;
  }
  return { samples, walkClip: humanoid?.locomotion?.clips?.walk ?? null, poseCost, solverAllocatedBytes };
}

type HeapNode = { callFrame: { url: string; functionName: string; scriptId: string; lineNumber: number; columnNumber: number }; selfSize: number; children: HeapNode[] };
type CodeRange = { scriptId: string; start: [number, number]; end: [number, number] };
// The leg solver's class is found in the served code (bundled and minified in the test build, so no file name or
// source map names it) by a method only it defines; any sample whose stack passes through that class counts.
const SOLVER_MARKER = 'dropPelvis';
const ALLOCATION_SAMPLING_BYTES = 128;
const allocationProbe = { started: false };

/** The [line, column] extent of the class that defines SOLVER_MARKER, in the script that holds it. */
async function solverRange(cdp: CDPSession, head: HeapNode): Promise<CodeRange | null> {
  const ids = new Set<string>();
  const walk = (node: HeapNode) => { if (node.callFrame.scriptId && node.callFrame.scriptId !== '0') ids.add(node.callFrame.scriptId); node.children.forEach(walk); };
  walk(head);
  const definition = new RegExp(`(^|[{};\\s])${SOLVER_MARKER}\\s*\\([^)]*\\)\\s*\\{`, 'm');
  for (const scriptId of ids) {
    const { scriptSource: source } = await cdp.send('Debugger.getScriptSource', { scriptId }) as { scriptSource: string };
    const at = source.search(definition);
    if (at < 0) continue;
    // The innermost class whose braces enclose the definition.
    const classes = [...source.slice(0, at).matchAll(/\bclass\b[^{]*\{/g)].reverse();
    for (const match of classes) {
      let depth = 0, end = -1;
      for (let i = match.index! + match[0].length - 1; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) { end = i; break; }
      }
      if (end > at) return { scriptId, start: lineColumn(source, match.index!), end: lineColumn(source, end) };
    }
  }
  return null;
}
function lineColumn(source: string, offset: number): [number, number] {
  const before = source.slice(0, offset);
  const line = before.split('\n').length - 1;
  return [line, offset - (before.lastIndexOf('\n') + 1)];
}
const within = (f: HeapNode['callFrame'], r: CodeRange) => f.scriptId === r.scriptId &&
  (f.lineNumber > r.start[0] || (f.lineNumber === r.start[0] && f.columnNumber >= r.start[1])) &&
  (f.lineNumber < r.end[0] || (f.lineNumber === r.end[0] && f.columnNumber <= r.end[1]));
/** The bytes sampled under the solver: in its own code or in what it calls (each sample stands for about the sampling interval). */
function allocatedIn(node: HeapNode, range: CodeRange, inside: boolean): number {
  const here = inside || within(node.callFrame, range);
  let bytes = here ? node.selfSize : 0;
  for (const child of node.children) bytes += allocatedIn(child, range, here);
  return bytes;
}


// At least three quarters of the brisk walk, the avatar's height (1.8 m) per second.
const MIN_WALK_SPEED = 0.75 * 1.8;

type Verdict = ReturnType<typeof judgeMotion>[number];
type Sample = { timeMs: number; phase: string };

// Idle and stop frames from HELD_AFTER_MS into the phase: the keys are released and
// the avatar has settled, so any shake there is noise (jitter is judged on these).
const HELD_AFTER_MS = 600;
function markHeld(frames: MotionFrame[], samples: Sample[]): MotionFrame[] {
  let start = 0;
  return frames.map((f, i) => {
    const phase = samples[i]!.phase;
    if (i === 0 || samples[i - 1]!.phase !== phase) start = samples[i]!.timeMs;
    return { ...f, held: (phase === 'idle' || phase === 'stop') && samples[i]!.timeMs - start >= HELD_AFTER_MS };
  });
}
// The walk after its first second (the start-up), for the gait metrics.
function steadyWalk(frames: MotionFrame[], samples: Sample[]): MotionFrame[] {
  const start = samples.find((s) => s.phase === 'walk')!.timeMs;
  return frames.filter((_, i) => samples[i]!.phase === 'walk' && samples[i]!.timeMs - start >= 1000);
}
function walkSpeedOf(samples: Array<{ timeMs: number; phase: string; body: BodySample }>): number {
  const start = samples.find((s) => s.phase === 'walk')!.timeMs;
  const walk = samples.filter((sample) => sample.phase === 'walk' && sample.timeMs - start >= 500);
  const from = walk[0]?.body.bones.hips, to = walk.at(-1)?.body.bones.hips;
  return from && to ? Math.hypot(to[0] - from[0], to[2] - from[2]) / ((walk.at(-1)!.timeMs - walk[0]!.timeMs) / 1000) : 0;
}

type Row = { timeMs: number; phase: string; body: BodySample; loco: Loco };
type Vec = [number, number, number];

/** Indices of the `which` run of `phase` (0 the first, -1 the last), from `afterMs` into it. */
function phaseRun(samples: Row[], phase: string, which: number, afterMs: number): number[] {
  const runs: number[][] = [];
  samples.forEach((s, i) => {
    if (s.phase !== phase) return;
    if (i === 0 || samples[i - 1]!.phase !== phase) runs.push([]);
    runs.at(-1)!.push(i);
  });
  const run = runs.at(which) ?? [];
  const start = run.length ? samples[run[0]!]!.timeMs : 0;
  return run.filter((i) => samples[i]!.timeMs - start >= afterMs);
}
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
const quantile = (v: number[], q: number) => (v.length ? [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(q * v.length))]! : null);
// The body's left in the world, from the avatar's yaw (forward is (-sin, 0, -cos), as the motor lays the keys).
const leftOf = (yaw: number): Vec => [-Math.cos(yaw), 0, Math.sin(yaw)];
const hipsOverGround = (b: BodySample) => (b.bones.hips && b.ground.root ? b.bones.hips[1] - b.ground.root.y : null);

// Slice 2 (docs/features/realistic-avatar-motion.md), on the 1.8 m avatar. Back-up and crouch gait targets are
// anchored on their source takes as this code reads them (CMU 143_39, 136_10); the strafe's lateral gap keeps the
// feet from crossing; the slope tilt is judged on faces steep enough to tell a tilted foot from a flat one.
const SLICE2_TARGETS = {
  backWeight: { min: 0.8 },
  backKneeSwingFlexMaxDeg: { min: 40, max: 76 },
  backCadenceStepsPerMin: { min: 160, max: 220 },
  backSwingAlongTravelShare: { min: 0.95 },
  strafeWeight: { min: 0.8 },
  strafeLateralGapRatio: { min: 0.04 },
  crouchWeight: { min: 0.6 },
  crouchHipsDropRatio: { min: 0.05 },
  crouchKneeMidStanceFlexDeg: { min: 74.7, max: 91.3 },
  idleHeadSwayCm: { min: 0.5, max: 3 },
  solverAllocatedBytes: { max: 0 }
} as const;
const TERRAIN_SLICE2_TARGETS = {
  slopeFootTiltP95Deg: { max: 8 },
  standingLowerFootFloatP95Cm: { max: 1.5 }
} as const;
const SLOPE_MIN_DEG = 10;
const ARM_SEGMENTS = [['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'], ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist']] as const;

/** How fast any upper arm or forearm turns (°/s, between successive frames): max and p99 over the run. */
function armTurnRate(samples: Row[]): { maxDegS: number | null; p99DegS: number | null } {
  const rates: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    const dt = (b.timeMs - a.timeMs) / 1000;
    if (!(dt > 0)) continue;
    for (const [from, to] of ARM_SEGMENTS) {
      const pa = a.body.bones[from], qa = a.body.bones[to], pb = b.body.bones[from], qb = b.body.bones[to];
      if (!pa || !qa || !pb || !qb) continue;
      const u: Vec = [qa[0] - pa[0], qa[1] - pa[1], qa[2] - pa[2]], v: Vec = [qb[0] - pb[0], qb[1] - pb[1], qb[2] - pb[2]];
      const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
      rates.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI / dt);
    }
  }
  return { maxDegS: rates.length ? Math.max(...rates) : null, p99DegS: quantile(rates, 0.99) };
}

/** The slice 2 measurements of a flat-floor row; null where the avatar has no directional clips. */
function sliceTwoFlat(samples: Row[], frames: MotionFrame[], heightM: number) {
  if (!samples.some((s) => 'back' in s.loco.directions)) return null;
  const pick = (idx: number[]) => idx.map((i) => frames[i]!);
  const back = phaseRun(samples, 'back', 0, 700);
  const backGait = measureGait(pick(back), heightM);
  // The swing foot travels the way the body goes (backward), never forward against it.
  const along: number[] = [];
  for (const i of back) {
    if (i === 0) continue;
    const a = samples[i - 1]!, b = samples[i]!;
    const travel = [b.body.bones.hips![0] - a.body.bones.hips![0], b.body.bones.hips![2] - a.body.bones.hips![2]];
    const t = Math.hypot(travel[0]!, travel[1]!) || 1;
    for (const ankle of ['leftAnkle', 'rightAnkle'] as const) {
      const p = a.body.bones[ankle], q = b.body.bones[ankle];
      if (!p || !q) continue;
      const step = ((q[0] - p[0]) * travel[0]! + (q[2] - p[2]) * travel[1]!) / t;
      // A swing: the foot moves faster than half the body.
      if (Math.abs(step) > 0.5 * t) along.push(step > 0 ? 1 : 0);
    }
  }
  const strafe = [...phaseRun(samples, 'fp-left', 0, 700), ...phaseRun(samples, 'fp-right', 0, 700)];
  const gaps = strafe.map((i) => {
    const b = samples[i]!.body.bones, l = leftOf(samples[i]!.loco.yaw);
    return ((b.leftAnkle![0] - b.rightAnkle![0]) * l[0] + (b.leftAnkle![2] - b.rightAnkle![2]) * l[2]) / heightM;
  });
  const crouch = phaseRun(samples, 'crouch-walk', 0, 1000);
  const crouchGait = measureGait(pick(crouch), heightM);
  const standing = phaseRun(samples, 'idle', 0, 0).map((i) => hipsOverGround(samples[i]!.body)).filter((h): h is number => h !== null);
  const crouched = crouch.map((i) => hipsOverGround(samples[i]!.body)).filter((h): h is number => h !== null);
  const still = phaseRun(samples, 'stop', -1, 600);
  const heads = still.map((i) => samples[i]!.body.bones.head).filter((h): h is Vec => !!h);
  const centre = heads.length ? [0, 1, 2].map((k) => mean(heads.map((h) => h[k]!))!) : null;
  const sway = centre ? Math.max(...heads.map((h) => Math.hypot(h[0] - centre[0]!, h[1] - centre[1]!, h[2] - centre[2]!))) : null;
  const weight = (idx: number[], ...keys: string[]) => mean(idx.map((i) => keys.reduce((sum, k) => sum + (samples[i]!.loco.directions[k] ?? 0), 0)));
  return {
    backWeight: weight(back, 'back', 'crouchBack'),
    backKneeSwingFlexMaxDeg: backGait.kneeSwingFlexMaxDeg,
    backCadenceStepsPerMin: backGait.cadenceStepsPerMin,
    backSwingAlongTravelShare: mean(along),
    strafeWeight: weight(strafe, 'left', 'right'),
    strafeLateralGapRatio: gaps.length ? Math.min(...gaps) : null,
    crouchWeight: weight(crouch, 'crouch', 'crouchBack'),
    crouchHipsDropRatio: standing.length && crouched.length ? (mean(standing)! - mean(crouched)!) / heightM : null,
    crouchKneeMidStanceFlexDeg: crouchGait.kneeMidStanceFlexDeg,
    idleHeadSwayCm: sway === null ? null : sway * 100,
    idleSwayWeight: mean(still.map((i) => samples[i]!.loco.swayWeight)),
    ...Object.fromEntries(Object.entries(armTurnRate(samples)).map(([k, v]) => [`arm${k[0]!.toUpperCase()}${k.slice(1)}`, v]))
  };
}

/** The slice 2 measurements of the terrain row: planted feet against steep ground, the lower foot standing. */
function sliceTwoTerrain(samples: Row[]) {
  const tilts: number[] = [];
  for (const s of samples) for (const leg of s.loco.legs) {
    if (leg.mode === 'pinned' && leg.slope !== null && leg.slope >= SLOPE_MIN_DEG && leg.tilt !== null) tilts.push(leg.tilt);
  }
  const floats: number[] = [];
  for (const run of [phaseRun(samples, 'stop', 0, 600), phaseRun(samples, 'stop', -1, 600)]) {
    for (const i of run) {
      const b = samples[i]!.body;
      // The lower foot: the one whose ground is lower; its float is its lowest joint over the ground under it.
      const lower = (['left', 'right'] as const).map((side) => ({ side, ground: b.ground[`${side}Ankle`]?.y ?? Infinity })).sort((x, y) => x.ground - y.ground)[0]!.side;
      const over = (['Ankle', 'Toe'] as const).map((j) => {
        const at = b.bones[`${lower}${j}`], ground = b.ground[`${lower}${j}`];
        return at && ground ? at[1] - ground.y : Infinity;
      });
      const lowest = Math.min(...over);
      if (Number.isFinite(lowest)) floats.push(lowest * 100);
    }
  }
  return { slopeFootTiltP95Deg: quantile(tilts, 0.95), slopeFootTiltMaxDeg: tilts.length ? Math.max(...tilts) : null, slopeFrames: tilts.length, standingLowerFootFloatP95Cm: quantile(floats, 0.95) };
}

function judge(values: Record<string, number | null>, targets: Record<string, { min?: number; max?: number }>): Verdict[] {
  return Object.entries(targets).map(([metric, target]) => {
    const value = values[metric] ?? null;
    const pass = value !== null && (target.min === undefined || value >= target.min) && (target.max === undefined || value <= target.max);
    return { metric, value, target, pass } as unknown as Verdict;
  });
}

// Each run replaces the last, so the report never mixes this run's avatars with an older run's.
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const only = process.env.DESKTOP_MOTION_ONLY;
const fixtures = (await generateAvatarFixtures(path.join(artifactDir, 'fixtures'))).filter((f) => SKELETONS.includes(f.name));
// walkClip: what the binding report must say walks the avatar, so a fixture that failed to load
// (and left the shipped avatar, which walks on its own clip) cannot pass for it.
const defaultIsStock = (DEFAULT_AVATAR_URL as string) === STOCK_AVATAR_URL;
const avatars: Array<{ name: string; url: string | null; walkClip: string; terrain?: boolean }> = [
  // The default avatar (the house base) has no clips of its own; the stock avatar, which the fixtures are made from, has.
  { name: 'shipped', url: null, walkClip: defaultIsStock ? 'own' : 'retargeted' },
  { name: 'shipped-terrain', url: null, walkClip: defaultIsStock ? 'own' : 'retargeted', terrain: true },
  ...(defaultIsStock ? [] : [{ name: 'stock', url: STOCK_AVATAR_URL, walkClip: 'own' }]),
  ...fixtures.map((f) => ({ name: f.name, url: `/${path.relative(process.cwd(), f.file).split(path.sep).join('/')}`, walkClip: f.expect.ownClips ? 'own' : 'retargeted' }))
].filter((a) => !only || a.name.includes(only));
const lost = SKELETONS.filter((name) => !fixtures.some((f) => f.name === name));
if (lost.length) throw new Error(`no generated fixture for ${lost.join(', ')} (renamed in scripts/lib/avatar-fixtures.ts?)`);
if (!avatars.length) throw new Error(`DESKTOP_MOTION_ONLY=${only} matches no avatar`);
const summary: Record<string, unknown>[] = [];
let failed = false;
const browser = await launchXrBrowser(chromium);
try {
  for (const avatar of avatars) {
    const context = await createXrContext(browser, { viewport: { width: 960, height: 720 } });
    consoleErrors.length = 0;
    const { samples, walkClip, poseCost, solverAllocatedBytes } = await run(await context.newPage(), avatar.url, avatar.terrain, avatar.name === 'shipped');
    await context.close();
    const tag = `[desktop-motion] ${avatar.name}:`;
    const misses: Verdict[] = [];
    if (walkClip !== avatar.walkClip) { console.log(`${tag} walks on a ${walkClip} clip, expected ${avatar.walkClip}: the avatar did not load`); failed = true; }
    if (consoleErrors.length) { console.log(`${tag} browser errors: ${consoleErrors.join(' | ')}`); failed = true; }
    // The shared conversion, so desktop counts the same joints as every other row (not headTop, an end site).
    const frames = markHeld(framesFromBodySamples(samples, 'avatar'), samples);
    const metrics = measureMotion(frames);
    const gait = measureGait(steadyWalk(frames, samples), 1.8);
    // On terrain the slopes bend the walk, so only the feet against the ground are judged there.
    const { cm: belowGround, airborneFrames } = footBelowGround(samples);
    const verdicts = avatar.terrain
      ? [
          { metric: 'footBelowGroundCm', value: belowGround, target: TERRAIN_TARGETS.footBelowGroundCm, pass: belowGround <= TERRAIN_TARGETS.footBelowGroundCm.max } as unknown as Verdict,
          ...judgeMotion(metrics, 'desktop').filter((v) => v.metric in TERRAIN_TARGETS).map((v) => {
            const target = TERRAIN_TARGETS[v.metric as keyof typeof TERRAIN_TARGETS];
            return { ...v, target, pass: v.value !== null && v.value <= target.max } as Verdict;
          })
        ]
      : [...judgeMotion(metrics, 'desktop'), ...judgeGait(gait).map((v) => ({ ...v, metric: `gait.${v.metric}` }) as Verdict)];
    // Slice 2: the directional, crouch and slope behaviour, the idle's sway, the solver's allocations.
    const slice2 = avatar.terrain ? sliceTwoTerrain(samples) : sliceTwoFlat(samples, frames, 1.8);
    if (slice2) {
      const values: Record<string, number | null> = { ...slice2, solverAllocatedBytes };
      const targets: Record<string, { min?: number; max?: number }> = avatar.terrain ? TERRAIN_SLICE2_TARGETS : { ...SLICE2_TARGETS };
      if (solverAllocatedBytes === null) delete targets.solverAllocatedBytes;
      verdicts.push(...judge(values, targets).map((v) => ({ ...v, metric: `slice2.${v.metric}` }) as Verdict));
      console.log(`${tag} slice2 ${JSON.stringify(values)}`);
    }
    verdicts.push({ metric: 'poseCostMedianMs', value: poseCost.medianMs, target: { max: POSE_COST_MEDIAN_MS }, pass: poseCost.medianMs <= POSE_COST_MEDIAN_MS } as unknown as Verdict);
    await writeFile(path.join(artifactDir, `${avatar.name}-samples.json`), JSON.stringify(samples));
    await writeFile(path.join(artifactDir, `${avatar.name}-report.json`), JSON.stringify({ metrics, footBelowGroundCm: belowGround, airborneFrames, gait, poseCost, slice2, solverAllocatedBytes, verdicts }, null, 2));
    console.log(`${tag} ${JSON.stringify(metrics)}`);
    console.log(`${tag} gait ${JSON.stringify(gait)}`);
    console.log(`${tag} pose cost ${JSON.stringify(poseCost)}`);
    if (avatar.terrain) console.log(`${tag} feet below ground ${belowGround.toFixed(2)} cm (${airborneFrames} airborne frames not judged)`);
    // The feet's targets get easier as the walk slows: the walk itself must stay brisk (1.8 m/s at 1.8 m, the owner's call).
    const walkSpeed = walkSpeedOf(samples);
    console.log(`${tag} walk speed ${walkSpeed.toFixed(3)} m/s`);
    misses.push(...verdicts.filter((v) => !v.pass));
    if (!avatar.terrain && walkSpeed < MIN_WALK_SPEED) misses.push({ metric: 'walk speed', value: walkSpeed, target: { min: MIN_WALK_SPEED }, pass: false } as Verdict);
    if (avatar.terrain && walkSpeed < MIN_TERRAIN_WALK_SPEED) misses.push({ metric: 'walk speed', value: walkSpeed, target: { min: MIN_TERRAIN_WALK_SPEED }, pass: false } as Verdict);
    if (avatar.terrain && airborneFrames > samples.length * MAX_AIRBORNE_SHARE) misses.push({ metric: 'airborneFrames', value: airborneFrames, target: { max: Math.floor(samples.length * MAX_AIRBORNE_SHARE) }, pass: false } as Verdict);
    for (const miss of misses) console.log(`${tag} MISS ${miss.metric} = ${miss.value} (target ${JSON.stringify(miss.target)})`);
    if (misses.length) failed = true;
    summary.push({ avatar: avatar.name, walkClip, walkSpeed, metrics, gait, poseCost, slice2, misses: misses.map((m) => m.metric) });
  }
} finally {
  await browser.close();
}
await writeFile(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`[desktop-motion] ${failed ? 'FAIL' : 'PASS'}: ${avatars.map((a) => a.name).join(', ')}`);
if (failed && !process.env.MOTION_QUALITY_REPORT_ONLY) process.exitCode = 1;
