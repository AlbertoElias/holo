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
import { chromium, type Page } from 'playwright';
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

// Phases: [label, seconds, input].
const SCRIPT: Array<[string, number, Input]> = [
  ['idle', 1, idle],
  // Long enough for three steady strides after the start, for the gait metrics.
  ['walk', 5, { ...idle, forward: true }],
  ['stop', 1.5, idle],
  ['strafe', 2, { ...idle, left: true }],
  ['stop', 1.5, idle],
  ['back', 2, { ...idle, back: true }],
  ['stop', 1.5, idle],
  ['crouch-walk', 2, { ...idle, forward: true, crouch: true }],
  ['stop', 1.5, idle]
];

// On the default terrain: straight ahead over its slopes, then diagonally (forward and left).
const TERRAIN_SCRIPT: Array<[string, number, Input]> = [
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

async function run(page: Page, avatarUrl: string | null, terrain = false) {
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
  const samples: Array<{ timeMs: number; phase: string; body: BodySample }> = [];
  let timeMs = 0;
  await page.evaluate(() => window.__samplePoseCost(true));
  for (const [phase, seconds, input] of terrain ? TERRAIN_SCRIPT : SCRIPT) {
    const frames = Math.round((seconds * 1000) / FRAME_MS);
    const chunk = await page.evaluate(
      ({ input, frames, frameMs }) => {
        window.__setMockInput(input);
        const out: BodySample[] = [];
        for (let i = 0; i < frames; i++) {
          window.advanceTime(frameMs);
          out.push(window.__sampleBody());
        }
        return out;
      },
      { input, frames, frameMs: FRAME_MS }
    );
    for (const body of chunk) {
      timeMs += FRAME_MS;
      samples.push({ timeMs, phase, body });
    }
  }
  const poseCost = await page.evaluate(() => window.__samplePoseCost());
  return { samples, walkClip: humanoid?.locomotion?.clips?.walk ?? null, poseCost };
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
    const { samples, walkClip, poseCost } = await run(await context.newPage(), avatar.url, avatar.terrain);
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
    verdicts.push({ metric: 'poseCostMedianMs', value: poseCost.medianMs, target: { max: POSE_COST_MEDIAN_MS }, pass: poseCost.medianMs <= POSE_COST_MEDIAN_MS } as unknown as Verdict);
    await writeFile(path.join(artifactDir, `${avatar.name}-samples.json`), JSON.stringify(samples));
    await writeFile(path.join(artifactDir, `${avatar.name}-report.json`), JSON.stringify({ metrics, footBelowGroundCm: belowGround, airborneFrames, gait, poseCost, verdicts }, null, 2));
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
    summary.push({ avatar: avatar.name, walkClip, walkSpeed, metrics, gait, poseCost, misses: misses.map((m) => m.metric) });
  }
} finally {
  await browser.close();
}
await writeFile(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`[desktop-motion] ${failed ? 'FAIL' : 'PASS'}: ${avatars.map((a) => a.name).join(', ')}`);
if (failed && !process.env.MOTION_QUALITY_REPORT_ONLY) process.exitCode = 1;
