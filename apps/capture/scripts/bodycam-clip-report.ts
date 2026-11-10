import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createHttpsBaseUrl, findAvailablePort, startTestBuildServer, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';
import { ensureTestBuild } from '@holoim/tooling-testing/test-build';
import { writeContactSheet } from '@holoim/tooling-testing/preview';
import { createXrContext, launchXrBrowser, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import type { BodycamLogEntry } from '../src/runtime/automationHooks';
import { assignHandSides } from '../src/bodycam/convert';
import type { HandLandmarks, Point3, Quat4 } from '../src/bodycam/types';
import { type FingerChain, scorePointPose } from '../src/xr/pointPose';

// Report-only (docs/features/camera-avatar-spike.md, slice 2): runs the real MediaPipe models on a video clip played
// as Chromium's fake camera, in real time, on a capture page opened with ?input=camera, and measures what the
// tracker made of it. It asserts nothing about model output and is not part of test:xr.
//
//   pnpm --filter @holoim/capture run bodycam:report <clip> [config.json] [--video] [--hflip] [--cpu] [--headed] [--crop43] [--realtime [--offset <sec>]] [--out <dir>]
//
// config.json (all optional): { distances: { authorToLensM, leftMarkM, rightMarkM },
//   segments: [{ label, startSec, endSec, hand?: 'left'|'right' (default right), target?: 'left-mark'|'right-mark'|'lens' }] }
// Without it only whole-clip measures are reported. Marks lie in the lens plane at lens height, leftMarkM and
// rightMarkM to the author's left and right of the lens; the author's head is authorToLensM straight in front of the lens.
//
// The clip is converted to the format Chromium's fake capture reads (MJPEG, 30 fps, 640 px high); --hflip mirrors
// it first, for a clip recorded as a selfie preview (MediaPipe wants the unmirrored picture).

const DEG = 180 / Math.PI;
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--out', '--offset'].includes(args[i - 1]!)));
const clipPath = positional[0] ? path.resolve(positional[0]) : '';
const configPath = positional[1] ? path.resolve(positional[1]) : null;
const outDir = path.resolve(option('--out') ?? 'output/bodycam');
const wantVideo = flag('--video') || process.env.BODYCAM_VIDEO === '1';
const hflip = flag('--hflip');
const realtime = flag('--realtime');
const headed = flag('--headed');
const mode = realtime ? 'realtime' : 'frame-stepped';
// The fake camera's clip phase against the page clock is good to a few seconds, not a fraction of one (the avatar clip ran
// about 3 s ahead of the call that opened the camera): read samples.json against the clip and pass the shift to line segments up.
const offsetSec = realtime ? Number(option('--offset') ?? '0') : 0;
if (!clipPath) {
  console.error('Usage: bodycam-clip-report.ts <clip> [config.json] [--video] [--hflip] [--cpu] [--headed] [--crop43] [--realtime [--offset <sec>]] [--out <dir>]');
  process.exit(2);
}

interface Segment {
  label: string;
  startSec: number;
  endSec: number;
  hand?: 'left' | 'right';
  target?: 'left-mark' | 'right-mark' | 'lens';
}
interface Config {
  distances?: { authorToLensM: number; leftMarkM: number; rightMarkM: number };
  segments?: Segment[];
}
const config: Config = configPath ? (JSON.parse(await readFile(configPath, 'utf8')) as Config) : {};

// ── Helpers ─────────────────────────────────────────────────────────────────
const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const roundOrNull = (n: number | null | undefined, d = 2): number | null => (n === null || n === undefined || !Number.isFinite(n) ? null : round(n, d));
const percentile = (values: number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))]!;
};
const sub = (a: Point3, b: Point3): Point3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Point3, b: Point3): Point3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const norm = (a: Point3): Point3 => {
  const n = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / n, y: a.y / n, z: a.z / n };
};
const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const angleDeg = (a: Point3, b: Point3): number => Math.acos(Math.min(1, Math.max(-1, dot(norm(a), norm(b))))) * DEG;

const chain = (hand: HandLandmarks, base: number): FingerChain => ({ proximal: hand.world[base], intermediate: hand.world[base + 1], distal: hand.world[base + 2], tip: hand.world[base + 3] });
const scoreHand = (hand: HandLandmarks) => scorePointPose({ thumbTip: hand.world[4], index: chain(hand, 5), middle: chain(hand, 9), ring: chain(hand, 13), pinky: chain(hand, 17) });

/** Euler angles (degrees) of a rotation in the YXZ order, as three.js reads them: yaw about y, pitch about x, roll about z. */
function eulerYxz([x, y, z, w]: Quat4): { yaw: number; pitch: number; roll: number } {
  const m02 = 2 * (x * z + y * w);
  const m12 = 2 * (y * z - x * w);
  const m22 = 1 - 2 * (x * x + y * y);
  const m10 = 2 * (x * y + z * w);
  const m11 = 1 - 2 * (x * x + z * z);
  const pitch = Math.asin(-Math.min(1, Math.max(-1, m12)));
  return { yaw: Math.atan2(m02, m22) * DEG, pitch: pitch * DEG, roll: Math.atan2(m10, m11) * DEG };
}

// ── Convert the clip ────────────────────────────────────────────────────────
await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, 'frames'), { recursive: true });
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height,r_frame_rate', '-of', 'json', clipPath], { encoding: 'utf8' });
if (probe.status !== 0) throw new Error(`ffprobe could not read ${clipPath}: ${probe.stderr}`);
const info = JSON.parse(probe.stdout) as { format: { duration: string }; streams: Array<{ width?: number; height?: number; r_frame_rate?: string }> };
const clipSec = Number(info.format.duration);
const [num, den] = (info.streams[0]?.r_frame_rate ?? '30/1').split('/').map(Number);
const clipFps = Math.min(30, Math.round(((num ?? 30) / (den || 1)) * 100) / 100);
const clipFrames = Math.round(clipSec * clipFps);
const steppedClip = path.join(outDir, 'stepped-clip.webm');
const avatarSources: Array<{ left: string; right: string }> = [];
const fakeCamera = path.join(outDir, 'fake-camera.mjpeg');
// --crop43 (frame-stepped): what the app's own 640 by 480 camera request delivers from a wider clip, a centre crop; it
// enlarges a small face (the face model misses the whole avatar clip at full frame) and can crop hands at the edges.
const portrait = (info.streams[0]?.height ?? 0) > (info.streams[0]?.width ?? 0);
const crop = portrait ? '480:640' : '640:480';
const filters = [...(hflip ? ['hflip'] : []), `fps=${realtime ? 30 : clipFps}`, ...(flag('--crop43') && !realtime ? [`scale=${crop}:force_original_aspect_ratio=increase`, `crop=${crop}`] : ['scale=-2:640'])].join(',');
// Real time: MJPEG for Chromium's fake capture. Frame-stepped: VP8 WebM, which Playwright's Chromium decodes (it has no H.264).
const converted = realtime
  ? spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', clipPath, '-an', '-vf', filters, '-q:v', '3', '-f', 'mjpeg', fakeCamera], { stdio: 'inherit' })
  : spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', clipPath, '-an', '-vf', filters, '-c:v', 'libvpx', '-b:v', '8M', '-crf', '6', '-g', '1', steppedClip], { stdio: 'inherit' });
if (converted.status !== 0) throw new Error('ffmpeg could not convert the clip');
console.log(`[bodycam-report] clip ${path.basename(clipPath)}: ${round(clipSec)} s, ${mode}, converted with ${filters}`);

// ── A capture server (or the one BASE_URL names) ────────────────────────────
const host = process.env.DEV_HOST ?? '127.0.0.1';
let server: ChildProcess | null = null;
let baseUrl = process.env.BASE_URL ?? '';
if (!baseUrl) {
  ensureTestBuild('capture', { ...process.env });
  const port = await findAvailablePort(host, Number(process.env.DEV_PORT ?? '5174'), 40);
  server = startTestBuildServer({ app: 'capture', host, port, cwd: process.cwd(), env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
  baseUrl = createHttpsBaseUrl(host, port);
  await waitForServer(baseUrl, Number(process.env.STARTUP_TIMEOUT_MS ?? '60000'), server);
}

// ── Run the models on the clip, in real time ────────────────────────────────
const entries: Array<BodycamLogEntry & { clipSec: number }> = [];
const consoleErrors: string[] = [];
let tracker: { delegate: 'GPU' | 'CPU'; feedHz: number; poseHz: number; handHz: number } | null = null;
let windowSecs = { start: 0, end: 0 };
let sheetCount = 0;
let videoRel: { avatarVideo: string; avatarStartSec: number } | null = null;
const fakeArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${fakeCamera}`];
// Headed Chromium keeps the real GPU; the shared XR launch options force software GL (SwiftShader).
const browser = headed ? await chromium.launch({ headless: false, args: realtime ? fakeArgs : [] }) : await launchXrBrowser(chromium, { args: realtime ? fakeArgs : [] });
let renderer = 'unknown';
let faceDelegate: 'GPU' | 'CPU' | null = null;
let steppedWallSec = 0;
const stepped: { frames: number; fps: number; width: number; height: number } | null = realtime ? null : { frames: clipFrames, fps: clipFps, width: 0, height: 0 };
try {
  const context = await createXrContext(browser, {
    viewport: { width: 640, height: 480 },
    permissions: ['camera'],
    ...(wantVideo && realtime ? { recordVideo: { dir: path.join(outDir, 'avatar-video'), size: { width: 640, height: 480 } } } : {})
  });
  const page = await context.newPage();
  const pageOpenedWall = Date.now();
  wireXrConsoleErrors(page, consoleErrors, { label: 'bodycam-report' });
  const url = new URL(baseUrl);
  url.searchParams.set('input', 'camera');
  if (!realtime) url.searchParams.set('manualClock', '1');
  if (flag('--cpu')) url.searchParams.set('mpDelegate', 'cpu');
  if (!realtime) await page.route('**/__bodycam-clip.webm', (route) => route.fulfill({ path: steppedClip, contentType: 'video/webm' }));
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__toggleFaceCamera', '__bodycamTap', '__drainBodycamLog', '__sampleBodycamTracker', ...(realtime ? [] : ['advanceTime', '__setManualClock', '__bodycamSteppedStart'])]);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  });
  await page.evaluate(() => window.__bodycamTap(true));
  const raw: BodycamLogEntry[] = [];

  if (!realtime && stepped) {
    // Frame-stepped: every clip frame is seeked to, run through face, pose and hands, fed, and the manual clock advances one frame.
    await page.evaluate(() => window.__setManualClock(true, true));
    const started = await page.evaluate(() => window.__bodycamSteppedStart('/__bodycam-clip.webm'));
    tracker = { delegate: started.delegate, feedHz: 0, poseHz: 0, handHz: 0 };
    faceDelegate = started.faceDelegate;
    stepped.width = started.width;
    stepped.height = started.height;
    const begun = Date.now();
    const stepMs = 1000 / stepped.fps;
    for (let i = 0; i < stepped.frames; i += 1) {
      await page.evaluate(([index, fps]) => window.__bodycamSteppedFrame(index as number, fps as number), [i, stepped.fps]);
      await page.evaluate((ms: number) => window.advanceTime(ms), stepMs);
      const sampled = await page.evaluate(() => {
        const snap = window.__sampleBodycam();
        return { log: window.__drainBodycamLog(), left: snap.hands.left.source, right: snap.hands.right.source };
      });
      raw.push(...sampled.log);
      avatarSources.push({ left: sampled.left, right: sampled.right });
      if (wantVideo || i % Math.max(1, Math.floor(stepped.frames / 12)) === 0) {
        await page.screenshot({ path: path.join(outDir, 'frames', `${String(wantVideo ? i : sheetCount).padStart(5, '0')}.png`) });
        sheetCount += 1;
      }
      if (i % 25 === 0) console.log(`[bodycam-report] frame ${i + 1}/${stepped.frames} (${round((Date.now() - begun) / 1000, 0)} s)`);
    }
    steppedWallSec = (Date.now() - begun) / 1000;
    for (const entry of raw) entries.push({ ...entry, clipSec: entry.nowMs / 1000 - 1 / stepped.fps });
    windowSecs = { start: 0, end: clipSec };
    await context.close();
  } else {
    // Real time: Chromium's fake camera plays the clip on a loop; only the tracking rate is meaningful here.
    const clock = await page.evaluate(() => {
      const t0 = performance.now();
      window.__toggleFaceCamera();
      return { t0, wall: Date.now() };
    });
    const t0 = clock.t0;
    const loopMs = clipSec * 1000;
    const deadline = Date.now() + 15 * 60_000;
    let firstFrameMs: number | null = null;
    let windowStartMs = 0;
    let nextShot = 0;
    for (;;) {
      await page.waitForTimeout(250);
      const polled = await page.evaluate(() => ({ log: window.__drainBodycamLog(), now: performance.now(), tracker: window.__sampleBodycamTracker() }));
      raw.push(...polled.log);
      if (polled.tracker) {
        tracker = { delegate: polled.tracker.delegate, feedHz: polled.tracker.feedHz, poseHz: polled.tracker.poseHz, handHz: polled.tracker.handHz };
        faceDelegate = polled.tracker.cameraDelegate;
      }
      if (!firstFrameMs && polled.log[0]) {
        firstFrameMs = polled.log[0].nowMs;
        // Measure one whole clip loop that starts after the models are running.
        const loops = Math.ceil((firstFrameMs - t0 + 1000) / loopMs);
        windowStartMs = t0 + loops * loopMs;
        windowSecs = { start: loops * clipSec, end: (loops + 1) * clipSec };
        console.log(`[bodycam-report] tracking began ${round((firstFrameMs - t0) / 1000)} s after the camera opened (${polled.tracker?.delegate}); measuring clip loop ${loops + 1}`);
      }
      const state = await page.evaluate(() => window.__sampleFace().camera);
      if (state === 'denied' || state === 'unavailable') throw new Error(`the fake camera ended in state ${state}`);
      if (firstFrameMs && polled.now >= windowStartMs + (nextShot * loopMs) / 12 && nextShot < 12) {
        await page.screenshot({ path: path.join(outDir, 'frames', `${String(nextShot).padStart(2, '0')}.png`) });
        nextShot += 1;
      }
      if (firstFrameMs && polled.now > windowStartMs + loopMs + 300) break;
      if (Date.now() > deadline) throw new Error('the clip report ran out of time (15 min)');
    }
    sheetCount = nextShot;
    for (const entry of raw) {
      const inLoop = (entry.nowMs - windowStartMs) / 1000;
      if (inLoop >= 0 && inLoop < clipSec) entries.push({ ...entry, clipSec: (((inLoop + offsetSec) % clipSec) + clipSec) % clipSec });
    }
    if (wantVideo) {
      const video = page.video();
      await context.close();
      const file = video ? await video.path() : null;
      if (file) videoRel = { avatarVideo: file, avatarStartSec: (clock.wall - pageOpenedWall) / 1000 + (windowStartMs - t0) / 1000 - offsetSec };
    } else {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await stopProcess(server);
}

// ── Measure ─────────────────────────────────────────────────────────────────
type Side = 'left' | 'right';
interface HandObs {
  clipSec: number;
  side: Side;
  hand: HandLandmarks;
  score: number | null;
  pinchM: number | null;
  ray: Point3 | null;
  tipPoseWorld: Point3 | null;
  nosePoseWorld: Point3 | null;
}
const handEntries = entries.filter((e) => e.ran !== 'pose');
const poseEntries = entries.filter((e) => e.ran !== 'hands');
const observations: HandObs[] = [];
const confusion = { assignedRightLabelLeft: 0, assignedRightLabelRight: 0, assignedLeftLabelLeft: 0, assignedLeftLabelRight: 0 };
let handsSeen = 0;
let handsUnassigned = 0;
const handCountHistogram = [0, 0, 0];
for (const entry of handEntries) {
  const hands = entry.frame.hands ?? [];
  handCountHistogram[Math.min(2, hands.length)] = (handCountHistogram[Math.min(2, hands.length)] ?? 0) + 1;
  const pose = entry.frame.pose;
  const sides = pose ? assignHandSides(hands, pose.image) : hands.map(() => null);
  for (const [i, hand] of hands.entries()) {
    handsSeen += 1;
    const side = sides[i];
    if (!side) {
      handsUnassigned += 1;
      continue;
    }
    if (hand.label) {
      const key = `assigned${side === 'right' ? 'Right' : 'Left'}Label${hand.label === 'Left' ? 'Left' : 'Right'}` as keyof typeof confusion;
      confusion[key] += 1;
    }
    const score = scoreHand(hand);
    const index = chain(hand, 5);
    const ray = index.proximal && index.tip ? norm(sub(index.tip, index.proximal)) : null;
    const poseWrist = pose?.world[side === 'left' ? 15 : 16];
    const tipPoseWorld = poseWrist && hand.world[0] && hand.world[8] ? add(poseWrist, sub(hand.world[8], hand.world[0])) : null;
    observations.push({
      clipSec: entry.clipSec,
      side,
      hand,
      score: score?.score ?? null,
      pinchM: score?.pinchDistance ?? null,
      ray,
      tipPoseWorld,
      nosePoseWorld: pose?.world[0] ?? null
    });
  }
}

/** Fraction of hand-model runs in a range with the side's hand assigned, and the longest stretch without it. */
function coverage(side: Side, from: number, to: number) {
  const runs = handEntries.filter((e) => e.clipSec >= from && e.clipSec < to);
  const times = observations.filter((o) => o.side === side && o.clipSec >= from && o.clipSec < to).map((o) => o.clipSec);
  const edges = [from, ...times, to];
  let longestGap = 0;
  for (let i = 1; i < edges.length; i += 1) longestGap = Math.max(longestGap, edges[i]! - edges[i - 1]!);
  return { runs: runs.length, frames: times.length, coverage: runs.length ? times.length / runs.length : null, longestGapSec: times.length ? longestGap : to - from };
}

/** The pointing path's own low-pass on the index ray (time constant 0.09 s), applied to the frames at the model's rate. */
function filteredRays(obs: HandObs[]): Point3[] {
  const out: Point3[] = [];
  let current: Point3 | null = null;
  let last = 0;
  for (const o of obs) {
    if (!o.ray) continue;
    const dt = o.clipSec - last;
    if (!current || dt > 0.25) current = o.ray;
    else {
      const alpha = 1 - Math.exp(-dt / 0.09);
      current = norm({ x: current.x + (o.ray.x - current.x) * alpha, y: current.y + (o.ray.y - current.y) * alpha, z: current.z + (o.ray.z - current.z) * alpha });
    }
    last = o.clipSec;
    out.push(current);
  }
  return out;
}

function jitter(rays: Point3[]) {
  if (rays.length < 3) return { frames: rays.length, p50Deg: null, p95Deg: null };
  const centre = norm(rays.reduce((acc, r) => add(acc, r), { x: 0, y: 0, z: 0 }));
  const deviations = rays.map((r) => angleDeg(r, centre));
  return { frames: rays.length, p50Deg: roundOrNull(percentile(deviations, 50)), p95Deg: roundOrNull(percentile(deviations, 95)) };
}

function describe(from: number, to: number, side: Side, target?: Segment['target']) {
  const obs = observations.filter((o) => o.side === side && o.clipSec >= from && o.clipSec < to);
  const scores = obs.flatMap((o) => (o.score === null ? [] : [o.score]));
  const pinch = obs.flatMap((o) => (o.pinchM === null ? [] : [o.pinchM * 100]));
  const raw = jitter(obs.flatMap((o) => (o.ray ? [o.ray] : [])));
  const filtered = jitter(filteredRays(obs));
  let aim: { frames: number; medianErrorDeg: number | null; p95ErrorDeg: number | null; note: string } | null = null;
  const d = config.distances;
  if (target && d) {
    const targetPoint: Point3 = target === 'lens' ? { x: 0, y: 0, z: 0 } : { x: target === 'left-mark' ? d.leftMarkM : -d.rightMarkM, y: 0, z: 0 };
    const errors: number[] = [];
    for (const o of obs) {
      if (!o.ray || !o.tipPoseWorld || !o.nosePoseWorld || (o.score ?? 0) < 0.35) continue;
      const tip = add({ x: 0, y: 0, z: d.authorToLensM }, sub(o.tipPoseWorld, o.nosePoseWorld));
      errors.push(angleDeg(o.ray, sub(targetPoint, tip)));
    }
    aim = { frames: errors.length, medianErrorDeg: roundOrNull(percentile(errors, 50)), p95ErrorDeg: roundOrNull(percentile(errors, 95)), note: 'index ray (proximal to tip, raw) against fingertip-to-target, frames scoring 0.35 or more' };
  }
  return {
    hand: side,
    ...(target ? { target } : {}),
    coverage: ((c) => ({ handModelRuns: c.runs, withHand: c.frames, coverage: roundOrNull(c.coverage), longestGapSec: roundOrNull(c.longestGapSec) }))(coverage(side, from, to)),
    pointScore: { frames: scores.length, p10: roundOrNull(percentile(scores, 10)), median: roundOrNull(percentile(scores, 50)), p90: roundOrNull(percentile(scores, 90)), fractionAtLeast0_6: scores.length ? roundOrNull(scores.filter((s) => s >= 0.6).length / scores.length) : null, fractionUnder0_35: scores.length ? roundOrNull(scores.filter((s) => s < 0.35).length / scores.length) : null },
    indexRayJitterRaw: raw,
    indexRayJitterFiltered: filtered,
    thumbToIndexCm: { frames: pinch.length, min: roundOrNull(percentile(pinch, 0)), median: roundOrNull(percentile(pinch, 50)), p10: roundOrNull(percentile(pinch, 10)) },
    ...(aim ? { aim } : {})
  };
}

// Head, from every frame's head rotation.
const headFrames = entries.flatMap((e) => (e.frame.head ? [eulerYxz(e.frame.head)] : []));
const headStat = (pick: (e: { yaw: number; pitch: number; roll: number }) => number) => {
  const values = headFrames.map(pick);
  return { p5: roundOrNull(percentile(values, 5), 1), median: roundOrNull(percentile(values, 50), 1), p95: roundOrNull(percentile(values, 95), 1) };
};

const intervals: number[] = [];
for (let i = 1; i < entries.length; i += 1) intervals.push(entries[i]!.nowMs - entries[i - 1]!.nowMs);
const windowSeconds = clipSec;
const segments = (config.segments ?? []).map((s) => ({
  label: s.label,
  startSec: s.startSec,
  endSec: s.endSec,
  ...describe(s.startSec, s.endSec, s.hand ?? 'right', s.target)
}));

const whole = { left: describe(0, clipSec, 'left'), right: describe(0, clipSec, 'right') };
const report = {
  clip: path.basename(clipPath),
  clipSec: round(clipSec),
  convertedWith: filters,
  note: 'Report only: nothing here is a pass or fail; the lead reads it against the brief\'s bars.',
  mode,
  run: {
    mode,
    headed,
    webglRenderer: renderer,
    softwareGl: /swiftshader|llvmpipe|software/i.test(renderer),
    poseHandDelegate: tracker?.delegate ?? null,
    faceDelegate,
    framing: flag('--crop43') && !realtime ? `centre crop to ${crop} (the app's camera request)` : 'full frame scaled to 640 px high',
    clipFrames: realtime ? null : clipFrames,
    clipFps: realtime ? null : clipFps,
    sampledFrames: entries.length,
    sampledVersusClipFrames: realtime ? 'not applicable: real-time sampling keeps only what the tracker managed' : `${entries.length} of ${clipFrames}`,
    steppedWallSeconds: realtime ? null : round(steppedWallSec, 1),
    measuredWindowClipSec: [0, round(windowSeconds)],
    clipTime: realtime
      ? `loop ${Math.round(windowSecs.start / clipSec) + 1} of the looping fake camera; page time since the camera opened${offsetSec ? ` shifted by ${offsetSec} s (--offset)` : ''}; the phase can be a few seconds off, so check samples.json against the clip`
      : 'exact: every frame of the clip was seeked to, so clip time is frame index over fps',
    consoleErrors: consoleErrors.filter((line) => !/INFO: Created TensorFlow Lite/.test(line))
  },
  trackingRate: {
    producedBy: realtime ? `real-time fake camera, ${headed ? 'headed' : 'headless'}, renderer ${renderer}` : 'not measured in frame-stepped mode (every frame is processed, however slowly): the rate figures below describe only this run\'s wall time',
    landmarkFramesPerSec: realtime ? round(entries.length / windowSeconds, 1) : null,
    poseRunsPerSec: realtime ? round(poseEntries.length / windowSeconds, 1) : null,
    handRunsPerSec: realtime ? round(handEntries.length / windowSeconds, 1) : null,
    medianFrameIntervalMs: realtime ? roundOrNull(percentile(intervals, 50), 0) : null,
    p95FrameIntervalMs: realtime ? roundOrNull(percentile(intervals, 95), 0) : null,
    steppedFramesPerWallSec: realtime ? null : round(entries.length / Math.max(steppedWallSec, 1e-3), 2),
    bar: '20 fps on a mid-range phone, from a real-time run on a real GPU only'
  },
  detection: {
    poseRuns: poseEntries.length,
    poseDetected: poseEntries.filter((e) => e.frame.pose).length,
    handRuns: handEntries.length,
    handsPerRun: { none: handCountHistogram[0], one: handCountHistogram[1], two: handCountHistogram[2] },
    handsSeen,
    handsUnassignedToAPoseWrist: handsUnassigned,
    framesWithHeadRotation: entries.filter((e) => e.frame.head).length
  },
  sides: {
    note: 'Side by nearest pose wrist against MediaPipe\'s own label on this unmirrored picture (the label assumes a mirror, so it should read the opposite).',
    ...confusion
  },
  head: {
    note: 'Rotation of the converted head quaternion (x image right, y down, z away; identity facing the camera), YXZ degrees. Yaw is about +y (down), so a turn to the author\'s left reads negative; pitch about +x.',
    yawDeg: headStat((h) => h.yaw),
    pitchDeg: headStat((h) => h.pitch),
    rollDeg: headStat((h) => h.roll)
  },
  wholeClip: whole,
  segments,
  geometry: config.distances ?? null
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
// Every sampled frame in brief, for reading a segment by eye: clip time, which model ran, detections, head angles.
await writeFile(
  path.join(outDir, 'samples.json'),
  JSON.stringify(
    entries.map((e, i) => ({ clipSec: round(e.clipSec, 2), ...(avatarSources[i] ? { avatarHands: avatarSources[i] } : {}), ran: e.ran, pose: Boolean(e.frame.pose), ...(e.frame.pose ? { noseOffsetX: round(e.frame.pose.image[0]!.x - (e.frame.pose.image[7]!.x + e.frame.pose.image[8]!.x) / 2, 3) } : {}), hands: e.frame.hands?.length ?? 0, ...(e.frame.head ? { head: ((h) => ({ yaw: round(h.yaw, 1), pitch: round(h.pitch, 1), roll: round(h.roll, 1) }))(eulerYxz(e.frame.head)) } : {}) }))
  )
);
console.log(`[bodycam-report] ${mode}: ${entries.length} frames (${report.run.sampledVersusClipFrames}) on ${report.run.poseHandDelegate}/${renderer}; pose ${report.detection.poseDetected}/${report.detection.poseRuns}, hands none/one/two ${handCountHistogram.join('/')}, head ${report.detection.framesWithHeadRotation}`);

// ── Artifacts ───────────────────────────────────────────────────────────────
if (sheetCount > 0) {
  const sheet = writeContactSheet(path.join(outDir, 'frames'), path.join(outDir, 'avatar-sheet.jpg'));
  if (sheet) console.log(`[bodycam-report] contact sheet of the avatar across the measured loop: ${sheet}`);
}
if (!realtime && wantVideo) {
  // Frame-stepped: the clip (left) and the avatar (right) frame for frame, so the alignment is exact.
  const sideBySide = path.join(outDir, 'side-by-side.mp4');
  const result = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-y', '-i', steppedClip, '-framerate', String(clipFps), '-i', path.join(outDir, 'frames', '%05d.png'), '-filter_complex', '[0:v]scale=-2:480[a];[1:v]scale=-2:480[b];[a][b]hstack=inputs=2,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-shortest', sideBySide],
    { stdio: 'inherit' }
  );
  console.log(result.status === 0 ? `[bodycam-report] side-by-side video: ${sideBySide}` : '[bodycam-report] ffmpeg could not write the side-by-side video');
}
if (videoRel) {
  // Clip as MediaPipe saw it (left), the avatar over the same loop (right). Alignment is to a fraction of a second.
  const sideBySide = path.join(outDir, 'side-by-side.mp4');
  const result = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-y', '-i', fakeCamera, '-ss', String(Math.max(0, videoRel.avatarStartSec)), '-t', String(clipSec), '-i', videoRel.avatarVideo, '-filter_complex', '[0:v]fps=25,scale=-2:480[a];[1:v]fps=25,scale=-2:480[b];[a][b]hstack=inputs=2,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-shortest', sideBySide],
    { stdio: 'inherit' }
  );
  console.log(result.status === 0 ? `[bodycam-report] side-by-side video: ${sideBySide}` : '[bodycam-report] ffmpeg could not write the side-by-side video');
}
console.log(`[bodycam-report] report: ${path.join(outDir, 'report.json')}`);
