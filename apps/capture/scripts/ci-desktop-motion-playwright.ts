// Desktop keyboard motion quality: walks, strafes, backs up and crouch-walks
// the avatar with keyboard input on the desktop capture page (frozen page
// clock, 30 Hz), samples the body every frame, and grades it with the
// shared motion-quality report (scripts/lib/motion-quality.ts, source
// "desktop"). Samples and report go to output/ci-desktop-motion/.
// MOTION_QUALITY_REPORT_ONLY=1 reports misses without failing.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  attachXrEnvironment, createXrContext, launchXrBrowser, wireXrConsoleErrors,
  waitForPageFunctions, waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';
import type {} from '../src/runtime/automationHooks';
import type { BodySample } from '../src/types/contracts';
import { judgeMotion, measureMotion, type JointName, type MotionFrame, type Vec3 } from './lib/motion-quality';

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

async function run(page: Page) {
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
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', '__setMockInput', '__respawnCharacter', '__sampleBody', 'advanceTime']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => {
    window.__setManualClock(true);
    window.__respawnCharacter();
    window.__setMockInput({ forward: false, back: false, left: false, right: false, crouch: false });
    window.advanceTime(1000);
  });
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
  return samples;
}

function toFrames(samples: Array<{ timeMs: number; body: BodySample }>): MotionFrame[] {
  return samples.map(({ timeMs, body }) => {
    const joints: MotionFrame['joints'] = {};
    for (const [name, v] of Object.entries(body.bones)) if (v) joints[name as JointName] = v as Vec3;
    const g = body.ground;
    return { timeSec: timeMs / 1000, joints, ground: { left: g.leftToe?.y ?? g.leftAnkle?.y ?? 0, right: g.rightToe?.y ?? g.rightAnkle?.y ?? 0 } };
  });
}

// At least three quarters of the brisk walk, the avatar's height (1.8 m) per second.
const MIN_WALK_SPEED = 0.75 * 1.8;

await mkdir(artifactDir, { recursive: true });
const browser = await launchXrBrowser(chromium);
try {
  const context = await createXrContext(browser, { viewport: { width: 960, height: 720 } });
  const samples = await run(await context.newPage());
  if (consoleErrors.length) throw new Error(`Browser errors: ${consoleErrors.join(' | ')}`);
  const metrics = measureMotion(toFrames(samples));
  const verdicts = judgeMotion(metrics, 'desktop');
  await writeFile(path.join(artifactDir, 'desktop-keyboard-samples.json'), JSON.stringify(samples));
  await writeFile(path.join(artifactDir, 'desktop-keyboard-report.json'), JSON.stringify({ metrics, verdicts }, null, 2));
  console.log(`[desktop-motion] ${JSON.stringify(metrics)}`);
  // The feet's targets get easier as the walk slows: the walk itself must stay brisk (1.8 m/s at 1.8 m, the owner's call).
  const walk = samples.filter((sample) => sample.phase === 'walk' && sample.timeMs - samples.find((s) => s.phase === 'walk')!.timeMs >= 500);
  const from = walk[0]?.body.bones.hips, to = walk.at(-1)?.body.bones.hips;
  const walkSpeed = from && to ? Math.hypot(to[0] - from[0], to[2] - from[2]) / ((walk.at(-1)!.timeMs - walk[0]!.timeMs) / 1000) : 0;
  console.log(`[desktop-motion] walk speed ${walkSpeed.toFixed(3)} m/s`);
  const misses = verdicts.filter((v) => !v.pass);
  if (walkSpeed < MIN_WALK_SPEED) misses.push({ metric: 'walk speed', value: walkSpeed, target: { min: MIN_WALK_SPEED }, pass: false } as (typeof verdicts)[number]);
  for (const miss of misses) console.log(`[desktop-motion] MISS ${miss.metric} = ${miss.value} (target ${JSON.stringify(miss.target)})`);
  if (misses.length && !process.env.MOTION_QUALITY_REPORT_ONLY) process.exitCode = 1;
} finally {
  await browser.close();
}
