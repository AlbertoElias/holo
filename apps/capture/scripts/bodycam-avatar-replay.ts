import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, chromium } from 'playwright';
import { createHttpsBaseUrl, findAvailablePort, startTestBuildServer, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';
import { ensureTestBuild } from '@holoim/tooling-testing/test-build';
import { createXrContext, launchXrBrowser, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import type { BodycamLogEntry } from '../src/runtime/automationHooks';
import { assignHandSides } from '../src/bodycam/convert';
import type { HandLandmarks, LandmarkFrame, Point2 } from '../src/bodycam/types';
import type { BodySample, HandSample, VrHandSide } from '../src/types/contracts';
import { generateAvatarFixtures } from './lib/avatar-fixtures.ts';
import { LOST_HAND_POP_MAX_MS2, cameraMotionFrame, cameraPointRays, lostHandPopMax } from './lib/camera-motion';
import { judgeMotion, measureMotion, type MotionFrame, type Vec3 } from './lib/motion-quality';

// The camera avatar on every supported skeleton (docs/features/archive/natural-avatar-motion.md, gap 2). The landmarks a
// bodycam:report run saved (its landmarks.json) drive the real app's avatar frame by frame under the manual clock, with
// no models: once on the shipped avatar and once per fixture the avatars check generates. Each run's bones and hands go
// through the motion-quality instrument as source 'camera'. The pointing ray graded is the app's own (PointDetector on
// the camera's hand joints, wrist to tip). --holds takes a bodycam:report config: its segments are the pointing holds,
// and a segment with target 'lens' is graded for aim. The direction from the fingertip to the lens is the camera's
// line of sight to the fingertip's image point, reversed, which needs only the config's camera field of view.
// bodycam:report --avatars runs this on its own landmarks.json and config.
//
// Usage: bodycam-avatar-replay.ts <landmarks.json> [--holds <config.json>] [--only <substring>] [--out <dir>] [--regrade] [--shots <from>:<to>]
// --regrade grades the samples a previous run saved in --out, without a browser. --shots saves a screenshot of each
// frame in that range (frame indexes) to <out>/<avatar>-shots/, for looking at what a number describes.
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const landmarksPath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--out', '--only', '--holds', '--shots'].includes(args[i - 1]!)));
if (!landmarksPath) {
  console.error('Usage: bodycam-avatar-replay.ts <landmarks.json> [--holds <config.json>] [--only <substring>] [--out <dir>] [--regrade] [--shots <from>:<to>]');
  process.exit(2);
}
const outDir = path.resolve(option('--out') ?? 'output/bodycam-avatars');
const only = option('--only');
const regrade = flag('--regrade');
const [shotFrom, shotTo] = (option('--shots') ?? '-1:-1').split(':').map(Number) as [number, number];
const holdsPath = option('--holds');
type HoldConfig = { camera?: { imageXFovDeg: number; imageYFovDeg: number }; segments?: Array<{ label: string; hand?: VrHandSide; startSec: number; endSec: number; target?: string }> };
const holdConfig: HoldConfig = holdsPath ? (JSON.parse(await readFile(path.resolve(holdsPath), 'utf8')) as HoldConfig) : {};
// The picture's field of view, its own x and y: the config's camera, else the iPhone 15 Pro main camera, 1x, 4K portrait.
const [fovX, fovY] = holdConfig.camera ? [holdConfig.camera.imageXFovDeg, holdConfig.camera.imageYFovDeg] : [45.7, 73.7];
const saved = JSON.parse(await readFile(path.resolve(landmarksPath), 'utf8')) as { entries: Array<BodycamLogEntry & { clipSec: number }> };
const entries = saved.entries;
if (entries.length < 2) throw new Error(`${landmarksPath} holds ${entries.length} frames`);
const WARM_UP_MS = 1000;
const stepMs = ((entries.at(-1)!.clipSec - entries[0]!.clipSec) / (entries.length - 1)) * 1000;

// ── Pointing holds ──────────────────────────────────────────────────────────
// The config's segments, in clip seconds.
// The point score cannot find them on a lens clip: a finger aimed into the lens is foreshortened and reads as
// curled, so the aim clip's holds were found from where the pose wrist sits still and checked by eye
// (docs/features/archive/natural-avatar-motion.md, gap 2).
type Hold = { label: string; side: VrHandSide; startSec: number; endSec: number; lens: boolean };
const holds: Hold[] = (holdConfig.segments ?? []).map((g) => ({ label: g.label, side: g.hand ?? 'right', startSec: g.startSec, endSec: g.endSec, lens: g.target === 'lens' }));
const holdAt = (i: number): Hold | undefined => holds.find((h) => entries[i]!.clipSec >= h.startSec && entries[i]!.clipSec <= h.endSec);
function handOf(frame: LandmarkFrame, side: VrHandSide): HandLandmarks | null {
  const hands = (frame.hands ?? []).slice(0, 2);
  if (!frame.pose || hands.length === 0) return null;
  const sides = assignHandSides(hands, frame.pose.image);
  const at = sides.indexOf(side);
  return at >= 0 ? hands[at]! : null;
}
console.log(`[avatar-replay] ${entries.length} frames at ${(1000 / stepMs).toFixed(2)} fps; ${holds.length} holds`);

// The lens direction from the fingertip, in the lens frame (x image right, y down, z away from the lens).
const DEG = Math.PI / 180;
function lensFromTip(p: Point2): Vec3 {
  const v: Vec3 = [-Math.tan((fovX / 2) * DEG) * (2 * p.x - 1), -Math.tan((fovY / 2) * DEG) * (2 * p.y - 1), -1];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
}
// The lens frame reaches the world through the half turn about z (convert.ts toBody) and then a yaw, the author's body
// turn and the avatar's facing; the yaw is fitted per frame from the hand's wrist-to-tip vector, which the app moves
// rigidly (HandLandmarks.world, then the camera's joints the app places in the world).
const toBody = (v: Vec3): Vec3 => [-v[0], -v[1], v[2]];
function yawFit(lens: Vec3, world: Vec3): number | null {
  const a = toBody(lens);
  const c = a[0] * world[0] + a[2] * world[2];
  const s = a[2] * world[0] - a[0] * world[2];
  return Math.hypot(c, s) > 0.3 * Math.hypot(...a) * Math.hypot(...world) ? Math.atan2(s, c) : null;
}
const yawBy = (v: Vec3, t: number): Vec3 => [v[0] * Math.cos(t) + v[2] * Math.sin(t), v[1], -v[0] * Math.sin(t) + v[2] * Math.cos(t)];

// ── Drive each avatar ───────────────────────────────────────────────────────
type Sample = { timeMs: number; body: BodySample; hands: Record<VrHandSide, HandSample> };
await mkdir(outDir, { recursive: true });
const fixtures = (await generateAvatarFixtures(path.join(outDir, 'fixtures'))).filter((f) => f.name !== 'unmappable');
const avatars = [{ name: 'shipped', url: null as string | null }, ...fixtures.map((f) => ({ name: f.name, url: `/${path.relative(process.cwd(), f.file).split(path.sep).join('/')}` }))].filter((a) => !only || a.name.includes(only));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
let server: ChildProcess | null = null;
let baseUrl = process.env.BASE_URL ?? '';
if (!baseUrl && !regrade) {
  ensureTestBuild('capture', { ...process.env });
  const host = process.env.DEV_HOST ?? '127.0.0.1';
  const port = await findAvailablePort(host, Number(process.env.DEV_PORT ?? '5174'), 40);
  server = startTestBuildServer({ app: 'capture', host, port, cwd: process.cwd(), env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
  baseUrl = createHttpsBaseUrl(host, port);
  await waitForServer(baseUrl, Number(process.env.STARTUP_TIMEOUT_MS ?? '60000'), server);
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const angle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b) || 1)))) / DEG;
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]! : null);
const lensTip = (frame: LandmarkFrame, side: VrHandSide, hand: HandLandmarks): Point2 | null => hand.imageIndexTip ?? frame.pose?.image[side === 'left' ? 19 : 20] ?? null;

function grade(samples: Sample[]) {
  const cameraSamples = samples.map((s) => ({ ...s, timeSec: s.timeMs / 1000 }));
  const rays = cameraPointRays(cameraSamples);
  const aimBySide: Record<VrHandSide, number[]> = { left: [], right: [] };
  const holdErrors: Array<{ label: string; medianDeg: number | null; frames: number }> = holds.map((h) => ({ label: h.label, medianDeg: null, frames: 0 }));
  const perHold: number[][] = holds.map(() => []);
  const frames: MotionFrame[] = samples.map((s, i) => {
    const frame = cameraMotionFrame(cameraSamples[i]!);
    // One ray per frame: the hand inside a pointing hold.
    const hold = holdAt(i);
    const ray = hold ? rays[i]![hold.side] : undefined;
    if (hold && ray) {
      frame.aimRay = ray;
      const hand = handOf(entries[i]!.frame, hold.side);
      const tracked = s.hands[hold.side].tracked;
      const tip = hand && lensTip(entries[i]!.frame, hold.side, hand);
      if (hold.lens && hand && tip && tracked.wrist && tracked['index-finger-tip']) {
        const w = hand.world[0]!;
        const t = hand.world[8]!;
        const yaw = yawFit([t.x - w.x, t.y - w.y, t.z - w.z], sub(tracked['index-finger-tip'], tracked.wrist));
        if (yaw !== null) {
          frame.aimTarget = yawBy(toBody(lensFromTip(tip)), yaw);
          const error = angle(ray, frame.aimTarget);
          aimBySide[hold.side].push(error);
          perHold[holds.indexOf(hold)]!.push(error);
        }
      }
    }
    return frame;
  });
  holds.forEach((_, k) => {
    holdErrors[k]!.medianDeg = median(perHold[k]!);
    holdErrors[k]!.frames = perHold[k]!.length;
  });
  const metrics = measureMotion(frames);
  const lostPop = lostHandPopMax(cameraSamples);
  const verdicts = [...judgeMotion(metrics, 'camera'), { metric: 'lostHandPopMaxMS2', value: lostPop, target: { max: LOST_HAND_POP_MAX_MS2 }, pass: lostPop !== null && lostPop <= LOST_HAND_POP_MAX_MS2 }];
  return { metrics: { ...metrics, lostHandPopMaxMS2: lostPop }, verdicts, aim: { left: median(aimBySide.left), right: median(aimBySide.right), holds: holdErrors } };
}

const consoleErrors: string[] = [];
const results: Array<{ avatar: string } & ReturnType<typeof grade>> = [];

async function drive(browser: Browser, avatar: (typeof avatars)[number]): Promise<Sample[]> {
  const context = await createXrContext(browser, { viewport: { width: 640, height: 480 } });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label: `avatar-replay ${avatar.name}` });
  const url = new URL(baseUrl);
  url.searchParams.set('input', 'camera');
  url.searchParams.set('manualClock', '1');
  if (avatar.url) url.searchParams.set('avatar', avatar.url);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', '__setManualClock', '__setBodycamFrame', '__sampleHands', '__sampleBody']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  // Draw only when shooting: the grade needs no pixels, the shots do.
  await page.evaluate((draw) => window.__setManualClock(true, draw), shotTo >= 0);
  // The avatar settles onto the ground in its first 0.2 s; let it, so the grade's rest window sees it standing.
  await page.evaluate((ms) => window.advanceTime(ms), WARM_UP_MS);
  const samples: Sample[] = [];
  const shotDir = path.join(outDir, `${avatar.name}-shots`);
  if (shotTo >= 0) await mkdir(shotDir, { recursive: true });
  for (let i = 0; i < entries.length; ) {
    // One frame per step inside the shot range, so each gets its screenshot.
    const shooting = i >= shotFrom && i <= shotTo;
    const size = shooting ? 1 : Math.min(40, i < shotFrom ? shotFrom - i : 40);
    const batch = entries.slice(i, i + size).map((e) => e.frame);
    const got = await page.evaluate(
      ([frames, ms]) =>
        (frames as LandmarkFrame[]).map((f) => {
          window.__setBodycamFrame(f);
          window.advanceTime(ms as number);
          return { timeMs: performance.now(), body: window.__sampleBody(), hands: window.__sampleHands() };
        }),
      [batch, stepMs] as const
    );
    for (const [k, g] of got.entries()) samples.push({ ...g, timeMs: (i + k) * stepMs });
    if (shooting) await page.screenshot({ path: path.join(shotDir, `${String(i).padStart(5, '0')}.png`) });
    i += size;
  }
  await context.close();
  await writeFile(path.join(outDir, `${avatar.name}-samples.json`), JSON.stringify(samples));
  return samples;
}

const browser = regrade ? null : await launchXrBrowser(chromium);
try {
  for (const avatar of avatars) {
    const begun = Date.now();
    const samples = browser ? await drive(browser, avatar) : (JSON.parse(await readFile(path.join(outDir, `${avatar.name}-samples.json`), 'utf8')) as Sample[]);
    const graded = grade(samples);
    results.push({ avatar: avatar.name, ...graded });
    const misses = graded.verdicts.filter((v) => !v.pass).map((v) => `${v.metric} ${v.value === null ? 'unmeasured' : v.value.toFixed(2)}`);
    console.log(`[avatar-replay] ${avatar.name.padEnd(18)} ${((Date.now() - begun) / 1000).toFixed(0)} s  ${misses.length ? `MISS ${misses.join(', ')}` : 'meets every camera target'}  aim median L ${graded.aim.left?.toFixed(1) ?? '-'} R ${graded.aim.right?.toFixed(1) ?? '-'} deg`);
  }
} finally {
  await browser?.close();
  await stopProcess(server);
}
await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ landmarks: path.resolve(landmarksPath), holds: holdsPath ? path.resolve(holdsPath) : null, fovDeg: [fovX, fovY], consoleErrors, results }, null, 2));
console.log(`[avatar-replay] report: ${path.join(outDir, 'report.json')}${consoleErrors.length ? `; ${consoleErrors.length} browser errors` : ''}`);
if (consoleErrors.length) process.exitCode = 1;
