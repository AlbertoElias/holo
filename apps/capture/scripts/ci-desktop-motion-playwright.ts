// Desktop keyboard motion quality: walks, strafes, backs up and crouch-walks
// the avatar with keyboard input on the desktop capture page (frozen page
// clock, 30 Hz), samples the body every frame, and grades it with the
// shared motion-quality report (scripts/lib/motion-quality.ts, source
// "desktop"), strictly, on the shipped avatar and on each skeleton the
// avatars check replays (scripts/lib/avatar-fixtures.ts), one page each.
// Samples and reports go to output/ci-desktop-motion/ (<avatar>-samples.json,
// <avatar>-report.json, summary.json). MOTION_QUALITY_REPORT_ONLY=1 reports
// misses without failing; DESKTOP_MOTION_ONLY=<substring> keeps matching avatars.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  attachXrEnvironment, createXrContext, launchXrBrowser, wireXrConsoleErrors,
  waitForPageFunctions, waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';
import type {} from '../src/runtime/automationHooks';
import type { BodySample } from '../src/types/contracts';
import { generateAvatarFixtures } from './lib/avatar-fixtures.ts';
import { framesFromBodySamples, judgeMotion, measureMotion } from './lib/motion-quality';

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
  ['walk', 3, { ...idle, forward: true }],
  ['stop', 1.5, idle],
  ['strafe', 2, { ...idle, left: true }],
  ['stop', 1.5, idle],
  ['back', 2, { ...idle, back: true }],
  ['stop', 1.5, idle],
  ['crouch-walk', 2, { ...idle, forward: true, crouch: true }],
  ['stop', 1.5, idle]
];

// The geometric skeletons the avatars check replays (bone axes, bind pose, facing, scale).
const SKELETONS = ['reoriented-axes', 'a-pose', 't-pose', 't-pose-twisted', 'vrm0-minus-z', 'z-up', 'unreal-cm'];

async function run(page: Page, avatarUrl: string | null) {
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
  url.searchParams.set('scene', '/desktop-motion-floor.gltf');
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('avatarHeight', '1.8');
  if (avatarUrl) url.searchParams.set('avatar', avatarUrl);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__sampleHumanoid', '__setManualClock', '__setMockInput', '__respawnCharacter', '__sampleBody', 'advanceTime']);
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
  for (const [phase, seconds, input] of SCRIPT) {
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
  return { samples, walkClip: humanoid?.locomotion?.clips?.walk ?? null };
}


// At least three quarters of the brisk walk, the avatar's height (1.8 m) per second.
const MIN_WALK_SPEED = 0.75 * 1.8;

type Verdict = ReturnType<typeof judgeMotion>[number];
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
const avatars: Array<{ name: string; url: string | null; walkClip: string }> = [
  { name: 'shipped', url: null, walkClip: 'own' },
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
    const { samples, walkClip } = await run(await context.newPage(), avatar.url);
    await context.close();
    const tag = `[desktop-motion] ${avatar.name}:`;
    const misses: Verdict[] = [];
    if (walkClip !== avatar.walkClip) { console.log(`${tag} walks on a ${walkClip} clip, expected ${avatar.walkClip}: the avatar did not load`); failed = true; }
    if (consoleErrors.length) { console.log(`${tag} browser errors: ${consoleErrors.join(' | ')}`); failed = true; }
    // The shared conversion, so desktop counts the same joints as every other row (not headTop, an end site).
    const metrics = measureMotion(framesFromBodySamples(samples, 'avatar'));
    const verdicts = judgeMotion(metrics, 'desktop');
    await writeFile(path.join(artifactDir, `${avatar.name}-samples.json`), JSON.stringify(samples));
    await writeFile(path.join(artifactDir, `${avatar.name}-report.json`), JSON.stringify({ metrics, verdicts }, null, 2));
    console.log(`${tag} ${JSON.stringify(metrics)}`);
    // The feet's targets get easier as the walk slows: the walk itself must stay brisk (1.8 m/s at 1.8 m, the owner's call).
    const walkSpeed = walkSpeedOf(samples);
    console.log(`${tag} walk speed ${walkSpeed.toFixed(3)} m/s`);
    misses.push(...verdicts.filter((v) => !v.pass));
    if (walkSpeed < MIN_WALK_SPEED) misses.push({ metric: 'walk speed', value: walkSpeed, target: { min: MIN_WALK_SPEED }, pass: false } as Verdict);
    for (const miss of misses) console.log(`${tag} MISS ${miss.metric} = ${miss.value} (target ${JSON.stringify(miss.target)})`);
    if (misses.length) failed = true;
    summary.push({ avatar: avatar.name, walkClip, walkSpeed, metrics, misses: misses.map((m) => m.metric) });
  }
} finally {
  await browser.close();
}
await writeFile(path.join(artifactDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`[desktop-motion] ${failed ? 'FAIL' : 'PASS'}: ${avatars.map((a) => a.name).join(', ')}`);
if (failed && !process.env.MOTION_QUALITY_REPORT_ONLY) process.exitCode = 1;
