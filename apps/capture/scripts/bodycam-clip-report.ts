import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createHttpsBaseUrl, findAvailablePort, startTestBuildServer, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';
import { ensureTestBuild, testBuildDir } from '@holoim/tooling-testing/test-build';
import { writeContactSheet } from '@holoim/tooling-testing/preview';
import { createXrContext, launchXrBrowser, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';
import { headYawFromPose } from '../src/bodycam/convert';
import type { BodycamLogEntry } from '../src/runtime/automationHooks';
import { assignHandSides } from '../src/bodycam/convert';
import type { HandLandmarks, Point3, Quat4 } from '../src/bodycam/types';
import { type FingerChain, scorePointPose } from '../src/xr/pointPose';

// Report-only (docs/features/camera-avatar-spike.md, slice 2): runs the real MediaPipe models on a video clip played
// as Chromium's fake camera, in real time, on a capture page opened with ?input=camera, and measures what the
// tracker made of it. It asserts nothing about model output and is not part of test:xr.
//
//   pnpm --filter @holoim/capture run bodycam:report <clip> [config.json] [--video] [--hflip] [--cpu] [--headed] [--crop43] [--realtime [--offset <sec>]] [--out <dir>]
//   pnpm --filter @holoim/capture run bodycam:report <clip> [config.json] --from-landmarks <dir>/landmarks.json --out <other dir>
//
// Every run writes landmarks.json: the models' per-frame output and the run's facts. --from-landmarks re-measures that
// file in seconds without the browser or the models, so a filter or ray change can be tried without a new 12-minute run.
//
// config.json (all optional): { distances: { authorToLensM, leftMarkM?, rightMarkM?, noseAboveLensM? },
//   marks?: { <name>: { leftM?, upM?, behindLensM? } }, camera?: { imageXFovDeg, imageYFovDeg },
//   segments: [{ label, startSec, endSec, hand?: 'left'|'right' (default right), target?: 'lens'|'left-mark'|'right-mark'|<mark name> }] }
// Without it only whole-clip measures are reported. leftMarkM and rightMarkM are marks at lens height in the lens
// plane, to the author's left and right of the lens. A named mark sits leftM to the author's left of the lens, upM above
// it and behindLensM behind the lens plane (all default 0). The author's nose is authorToLensM straight in front of the
// lens and noseAboveLensM above it (default 0). camera is the recorded picture's field of view, for the
// perspective-corrected rays (default: iPhone 15 Pro main camera, 1x, 4K held upright).
//
// The clip is converted to the format Chromium's fake capture reads (MJPEG, 30 fps, 640 px high); --hflip mirrors
// it first, for a clip recorded as a selfie preview (MediaPipe wants the unmirrored picture).

const DEG = 180 / Math.PI;
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--out', '--offset', '--from-landmarks'].includes(args[i - 1]!)));
const clipPath = positional[0] ? path.resolve(positional[0]) : '';
const configPath = positional[1] ? path.resolve(positional[1]) : null;
const outDir = path.resolve(option('--out') ?? 'output/bodycam');
/** What a run saves for --from-landmarks: the models' output per frame and the run facts the report prints. */
interface SavedRun {
  realtime: boolean;
  headed: boolean;
  filters: string;
  renderer: string;
  faceDelegate: 'GPU' | 'CPU' | null;
  tracker: { delegate: 'GPU' | 'CPU'; feedHz: number; poseHz: number; handHz: number } | null;
  steppedWallSec: number;
  windowSecs: { start: number; end: number };
  consoleErrors: string[];
  avatarSources: Array<{ left: string; right: string }>;
  entries: Array<BodycamLogEntry & { clipSec: number }>;
}
const fromLandmarks = option('--from-landmarks');
// Read before the output directory is cleared, in case it is the same directory.
const saved: SavedRun | null = fromLandmarks ? (JSON.parse(await readFile(path.resolve(fromLandmarks), 'utf8')) as SavedRun) : null;
const wantVideo = (flag('--video') || process.env.BODYCAM_VIDEO === '1') && !saved;
const hflip = flag('--hflip');
const realtime = saved ? saved.realtime : flag('--realtime');
const headed = saved ? saved.headed : flag('--headed');
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
  target?: string;
}
interface Config {
  distances?: { authorToLensM: number; leftMarkM?: number; rightMarkM?: number; noseAboveLensM?: number };
  marks?: Record<string, { leftM?: number; upM?: number; behindLensM?: number }>;
  camera?: { imageXFovDeg: number; imageYFovDeg: number };
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

const scaleHalf = (a: Point3): Point3 => ({ x: a.x / 2, y: a.y / 2, z: a.z / 2 });
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
const servedClip = path.join(testBuildDir('capture', { ...process.env }), '__bodycam-clip.webm');
const avatarSources: Array<{ left: string; right: string }> = [];
const fakeCamera = path.join(outDir, 'fake-camera.mjpeg');
// --crop43 (frame-stepped): what the app's own 640 by 480 camera request delivers from a wider clip, a centre crop; it
// enlarges a small face (the face model misses the whole avatar clip at full frame) and can crop hands at the edges.
const portrait = (info.streams[0]?.height ?? 0) > (info.streams[0]?.width ?? 0);
const crop = portrait ? '480:640' : '640:480';
const filters = saved?.filters ?? [...(hflip ? ['hflip'] : []), `fps=${realtime ? 30 : clipFps}`, ...(flag('--crop43') && !realtime ? [`scale=${crop}:force_original_aspect_ratio=increase`, `crop=${crop}`] : ['scale=-2:640'])].join(',');
// Real time: MJPEG for Chromium's fake capture. Frame-stepped: VP8 WebM, which Playwright's Chromium decodes (it has no H.264).
const converted = saved
  ? { status: 0 }
  : realtime
  ? spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', clipPath, '-an', '-vf', filters, '-q:v', '3', '-f', 'mjpeg', fakeCamera], { stdio: 'inherit' })
  : spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', clipPath, '-an', '-vf', filters, '-c:v', 'libvpx', '-b:v', '8M', '-crf', '6', '-g', '1', steppedClip], { stdio: 'inherit' });
if (converted.status !== 0) throw new Error('ffmpeg could not convert the clip');
console.log(`[bodycam-report] clip ${path.basename(clipPath)}: ${round(clipSec)} s, ${mode}, ${saved ? `re-measured from ${fromLandmarks}` : `converted with ${filters}`}`);

// ── A capture server (or the one BASE_URL names) ────────────────────────────
const host = process.env.DEV_HOST ?? '127.0.0.1';
let server: ChildProcess | null = null;
let baseUrl = process.env.BASE_URL ?? '';
if (!baseUrl && !saved) {
  ensureTestBuild('capture', { ...process.env });
  // The test build serves HTTPS with a self-signed certificate; waitForServer polls it with this process's own fetch,
  // which refuses that certificate unless this is set here too (as run-xr-checks.ts does), not only on the server's env.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
let renderer = 'unknown';
let faceDelegate: 'GPU' | 'CPU' | null = null;
let steppedWallSec = 0;
const stepped: { frames: number; fps: number; width: number; height: number } | null = realtime ? null : { frames: clipFrames, fps: clipFps, width: 0, height: 0 };
if (saved) {
  entries.push(...saved.entries);
  avatarSources.push(...saved.avatarSources);
  consoleErrors.push(...saved.consoleErrors);
  renderer = saved.renderer;
  faceDelegate = saved.faceDelegate;
  tracker = saved.tracker;
  steppedWallSec = saved.steppedWallSec;
  windowSecs = saved.windowSecs;
} else {
const fakeArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${fakeCamera}`];
// Headed Chromium keeps the real GPU; the shared XR launch options force software GL (SwiftShader).
const browser = headed ? await chromium.launch({ headless: false, args: realtime ? fakeArgs : [] }) : await launchXrBrowser(chromium, { args: realtime ? fakeArgs : [] });
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
  // Served by the capture server itself, from its build directory: one reply with a whole long clip exceeds the 100 MB
  // message limit of the browser's control pipe (route.fulfill) and kills the browser. A BASE_URL server must serve that directory.
  if (!realtime) await copyFile(steppedClip, servedClip);
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
  await rm(servedClip, { force: true });
  await browser.close();
  await stopProcess(server);
}
const savedRun: SavedRun = { realtime, headed, filters, renderer, faceDelegate, tracker, steppedWallSec, windowSecs, consoleErrors, avatarSources, entries };
await writeFile(path.join(outDir, 'landmarks.json'), JSON.stringify(savedRun));
console.log(`[bodycam-report] landmarks for --from-landmarks: ${path.join(outDir, 'landmarks.json')}`);
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
  /** Midpoint of the pose model's two eyes (landmarks 2 and 5). */
  eyesPoseWorld: Point3 | null;
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
      nosePoseWorld: pose?.world[0] ?? null,
      eyesPoseWorld: pose?.world[2] && pose.world[5] ? scaleHalf(add(pose.world[2], pose.world[5])) : null
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

/** A segment's target in the lens frame (x image right = the author's left, y down, z away from the lens), or null. */
function targetPointOf(target: string | undefined): Point3 | null {
  const d = config.distances;
  if (!target || !d) return null;
  if (target === 'lens') return { x: 0, y: 0, z: 0 };
  if (target === 'left-mark' && d.leftMarkM !== undefined) return { x: d.leftMarkM, y: 0, z: 0 };
  if (target === 'right-mark' && d.rightMarkM !== undefined) return { x: -d.rightMarkM, y: 0, z: 0 };
  const mark = config.marks?.[target];
  return mark ? { x: mark.leftM ?? 0, y: -(mark.upM ?? 0), z: -(mark.behindLensM ?? 0) } : null;
}

/** The fingertip in the lens frame: the pose's fingertip relative to its nose, from where the nose stands. */
function fingertipInLensFrame(o: HandObs): Point3 | null {
  const d = config.distances;
  if (!d || !o.tipPoseWorld || !o.nosePoseWorld) return null;
  return add({ x: 0, y: -(d.noseAboveLensM ?? 0), z: d.authorToLensM }, sub(o.tipPoseWorld, o.nosePoseWorld));
}

function describe(from: number, to: number, side: Side, target?: Segment['target']) {
  const obs = observations.filter((o) => o.side === side && o.clipSec >= from && o.clipSec < to);
  const scores = obs.flatMap((o) => (o.score === null ? [] : [o.score]));
  const pinch = obs.flatMap((o) => (o.pinchM === null ? [] : [o.pinchM * 100]));
  const raw = jitter(obs.flatMap((o) => (o.ray ? [o.ray] : [])));
  const filtered = jitter(filteredRays(obs));
  // Mean directions (x image right, y down, z away from the lens), to read the aim error against the picture by eye.
  let aimRays: { meanIndexRay: Point3 | null; meanFingertipToTarget: Point3 | null } | null = null;
  const meanDir = (rays: Point3[]): Point3 | null => {
    if (!rays.length) return null;
    const sum = rays.reduce((a, r) => add(a, r), { x: 0, y: 0, z: 0 });
    const n = norm(sum);
    return { x: round(n.x, 3), y: round(n.y, 3), z: round(n.z, 3) };
  };
  let aim: { frames: number; medianErrorDeg: number | null; p95ErrorDeg: number | null; note: string } | null = null;
  const targetPoint = targetPointOf(target);
  if (targetPoint) {
    const errors: number[] = [];
    const used: Array<{ ray: Point3; toTarget: Point3 }> = [];
    for (const o of obs) {
      const tip = fingertipInLensFrame(o);
      if (!o.ray || !tip || (o.score ?? 0) < 0.35) continue;
      errors.push(angleDeg(o.ray, sub(targetPoint, tip)));
      used.push({ ray: o.ray, toTarget: norm(sub(targetPoint, tip)) });
    }
    aimRays = { meanIndexRay: meanDir(used.map((u) => u.ray)), meanFingertipToTarget: meanDir(used.map((u) => u.toTarget)) };
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
    meanIndexRayAll: meanDir(obs.flatMap((o) => (o.ray ? [o.ray] : []))),
    ...(aim ? { aim } : {}),
    ...(aimRays ? { aimRays } : {})
  };
}

// ── Ray jitter study (brief, next step "ray jitter") ────────────────────────
// Which ray and which filter hold still enough for POINT_ANGULAR_TOLERANCE_DEG (3.5 deg), and what each costs in lag.
// Jitter here is deviation from the ray's own centred 1 s moving mean, inside the held middle of a segment (0.3 s
// trimmed at each end), so the hand moving into the pose and slow drift of the aim are not counted as noise.
// eye-tip: from between the eyes through the fingertip, both from the pose model's world frame (the fingertip placed as
// the pose wrist plus the hand model's wrist-to-tip offset, as the aim measure does); people aim by sighting past the tip.
type RayKind = 'mcp-tip' | 'wrist-tip' | 'fit-5-8' | 'eye-tip';
type RayFilter = { name: string; kind: 'none' } | { name: string; kind: 'lowpass'; tauSec: number } | { name: string; kind: 'one-euro'; minCutoffHz: number; beta: number; dCutoffHz: number };
const RAY_KINDS: RayKind[] = ['mcp-tip', 'wrist-tip', 'fit-5-8', 'eye-tip'];
const RAY_FILTERS: RayFilter[] = [
  { name: 'none', kind: 'none' },
  { name: 'lowpass 0.09 s (current)', kind: 'lowpass', tauSec: 0.09 },
  { name: 'lowpass 0.15 s', kind: 'lowpass', tauSec: 0.15 },
  { name: 'lowpass 0.25 s', kind: 'lowpass', tauSec: 0.25 },
  { name: 'lowpass 0.4 s', kind: 'lowpass', tauSec: 0.4 },
  { name: 'one-euro 0.3 Hz b1', kind: 'one-euro', minCutoffHz: 0.3, beta: 1, dCutoffHz: 1 },
  { name: 'one-euro 0.5 Hz b0.5', kind: 'one-euro', minCutoffHz: 0.5, beta: 0.5, dCutoffHz: 1 },
  { name: 'one-euro 0.5 Hz b2', kind: 'one-euro', minCutoffHz: 0.5, beta: 2, dCutoffHz: 1 },
  { name: 'one-euro 1 Hz b0.5', kind: 'one-euro', minCutoffHz: 1, beta: 0.5, dCutoffHz: 1 },
  { name: 'one-euro 1 Hz b2', kind: 'one-euro', minCutoffHz: 1, beta: 2, dCutoffHz: 1 }
];
const scale = (a: Point3, k: number): Point3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const lerp3 = (a: Point3, b: Point3, t: number): Point3 => add(a, scale(sub(b, a), t));

/** The index ray of one kind, in the hand model's world frame. */
function rayOf(o: HandObs, kind: RayKind): Point3 | null {
  if (kind === 'eye-tip') return o.eyesPoseWorld && o.tipPoseWorld ? norm(sub(o.tipPoseWorld, o.eyesPoseWorld)) : null;
  const w = o.hand.world;
  if (kind === 'mcp-tip') return w[5] && w[8] ? norm(sub(w[8], w[5])) : null;
  if (kind === 'wrist-tip') return w[0] && w[8] ? norm(sub(w[8], w[0])) : null;
  // Principal axis of the four index points (power iteration on their covariance), oriented knuckle to tip.
  const pts = [w[5], w[6], w[7], w[8]];
  if (pts.some((q) => !q)) return null;
  const c = scale(pts.reduce((acc: Point3, q) => add(acc, q!), { x: 0, y: 0, z: 0 }), 1 / 4);
  const d = pts.map((q) => sub(q!, c));
  let v = norm(sub(w[8]!, w[5]!));
  for (let i = 0; i < 20; i += 1) v = norm(d.reduce((acc: Point3, q) => add(acc, scale(q, dot(q, v))), { x: 0, y: 0, z: 0 }));
  return dot(v, sub(w[8]!, w[5]!)) < 0 ? scale(v, -1) : v;
}

/** Runs one filter over a time-ordered ray sequence; a gap over 0.25 s restarts it, as the existing path does. */
function runFilter(samples: Array<{ t: number; ray: Point3 }>, filter: RayFilter): Point3[] {
  const out: Point3[] = [];
  let current: Point3 | null = null;
  let dHat: Point3 = { x: 0, y: 0, z: 0 };
  let lastRaw: Point3 | null = null;
  let last = 0;
  const smoothing = (cutoffHz: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoffHz * dt));
  for (const { t, ray } of samples) {
    const dt = t - last;
    if (!current || !lastRaw || dt > 0.25 || dt <= 0) {
      current = ray;
      dHat = { x: 0, y: 0, z: 0 };
    } else if (filter.kind === 'lowpass') {
      current = norm(lerp3(current, ray, 1 - Math.exp(-dt / filter.tauSec)));
    } else if (filter.kind === 'one-euro') {
      dHat = lerp3(dHat, scale(sub(ray, lastRaw), 1 / dt), smoothing(filter.dCutoffHz, dt));
      const cutoff = filter.minCutoffHz + filter.beta * Math.hypot(dHat.x, dHat.y, dHat.z);
      current = norm(lerp3(current, ray, smoothing(cutoff, dt)));
    } else {
      current = ray;
    }
    lastRaw = ray;
    last = t;
    out.push(current);
  }
  return out;
}

/** Time a filter takes to come within 3.5 deg of a 40 deg aim change and stay there, at 30 frames per second. */
function stepLagSec(filter: RayFilter): number | null {
  const fps = 30;
  const from = { x: 0, y: 0, z: 1 };
  const to = { x: Math.sin(40 / DEG), y: 0, z: Math.cos(40 / DEG) };
  const samples = Array.from({ length: fps * 3 }, (_, i) => ({ t: (i + 1) / fps, ray: i < fps ? from : to }));
  const out = runFilter(samples, filter);
  let settled: number | null = null;
  for (let i = fps; i < out.length; i += 1) {
    if (angleDeg(out[i]!, to) <= 3.5) settled ??= samples[i]!.t - samples[fps]!.t;
    else settled = null;
  }
  return roundOrNull(settled, 3);
}

function rayStudySegment(seg: Segment, kind: RayKind, filter: RayFilter) {
  const side = seg.hand ?? 'right';
  // Filter across the segment and the 1 s before it, so the filter is warm when the held window starts.
  const samples = observations
    .filter((o) => o.side === side && o.clipSec >= seg.startSec - 1 && o.clipSec < seg.endSec)
    .flatMap((o) => {
      const ray = rayOf(o, kind);
      return ray ? [{ t: o.clipSec, ray, o }] : [];
    });
  const filtered = runFilter(samples, filter);
  // Aim error against the brief's assumed mark layout, as describe() reads it (marks in the lens plane, rough distances).
  const targetPoint = targetPointOf(seg.target);
  const aimErrors: number[] = [];
  const from = seg.startSec + 0.3;
  const to = seg.endSec - 0.3;
  const holdDev: number[] = [];
  const steps: number[] = [];
  const held: Point3[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const t = samples[i]!.t;
    if (t < from || t >= to) continue;
    const near = samples.filter((q) => Math.abs(q.t - t) <= 0.5).map((q) => q.ray);
    const slow = norm(near.reduce((acc, r) => add(acc, r), { x: 0, y: 0, z: 0 }));
    holdDev.push(angleDeg(filtered[i]!, slow));
    held.push(filtered[i]!);
    const o = samples[i]!.o;
    const tip = fingertipInLensFrame(o);
    if (targetPoint && tip && (o.score ?? 0) >= 0.35) aimErrors.push(angleDeg(filtered[i]!, sub(targetPoint, tip)));
    if (i > 0 && t - samples[i - 1]!.t < 0.1) steps.push(angleDeg(filtered[i]!, filtered[i - 1]!));
  }
  const mean = held.length ? norm(held.reduce((acc, r) => add(acc, r), { x: 0, y: 0, z: 0 })) : null;
  return {
    frames: holdDev.length,
    holdP50Deg: roundOrNull(percentile(holdDev, 50)),
    holdP95Deg: roundOrNull(percentile(holdDev, 95)),
    meanDevP95Deg: mean ? roundOrNull(percentile(held.map((r) => angleDeg(r, mean)), 95)) : null,
    stepP95Deg: roundOrNull(percentile(steps, 95)),
    aimMedianErrorDeg: targetPoint ? roundOrNull(percentile(aimErrors, 50), 1) : null,
    mean
  };
}

/** From the end of one held segment, how long until the ray stays within 5 deg of the next segment's held mean for 0.3 s. */
function settleSec(prev: Segment, next: Segment, kind: RayKind, filter: RayFilter, target: Point3): number | null {
  const side = next.hand ?? 'right';
  const samples = observations
    .filter((o) => o.side === side && o.clipSec >= prev.startSec && o.clipSec < next.endSec)
    .flatMap((o) => {
      const ray = rayOf(o, kind);
      return ray ? [{ t: o.clipSec, ray }] : [];
    });
  const out = runFilter(samples, filter);
  let since: number | null = null;
  for (let i = 0; i < samples.length; i += 1) {
    const t = samples[i]!.t;
    if (t < prev.endSec) continue;
    if (angleDeg(out[i]!, target) <= 5) {
      since ??= t;
      if (t - since >= 0.3) return round(since - prev.endSec, 2);
    } else since = null;
  }
  return null;
}

const studySegments = config.segments ?? [];
const pointingSegs = studySegments.filter((s) => s.target);
const restSegs = studySegments.filter((s) => /at rest|raised alone \(right\)/.test(s.label));
const transitions = pointingSegs.slice(1).flatMap((next, i) => (pointingSegs[i]!.hand === next.hand ? [{ prev: pointingSegs[i]!, next }] : []));
const rayJitterStudy = studySegments.length
  ? {
      note: 'holdP95Deg: p95 deviation of the filtered ray from the raw ray\'s centred 1 s moving mean, in the segment trimmed by 0.3 s at each end; the bar is 3.5 deg (POINT_ANGULAR_TOLERANCE_DEG). stepLagSec: a 40 deg aim change to within 3.5 deg, synthetic, 30 fps. settleSec: from the end of one pointing segment until the ray holds within 5 deg of the next one\'s held mean (the same ray, unfiltered) for 0.3 s. shiftFromCurrentDeg: angle between this ray\'s held mean and the mcp-tip ray\'s, per pointing segment.',
      pointingSegments: pointingSegs.map((s) => s.label),
      restSegments: restSegs.map((s) => s.label),
      variants: RAY_KINDS.flatMap((kind) =>
        RAY_FILTERS.map((filter) => {
          const pointing = pointingSegs.map((s) => ({ label: s.label, ...rayStudySegment(s, kind, filter) }));
          const rest = restSegs.map((s) => ({ label: s.label, ...rayStudySegment(s, kind, filter) }));
          const pointingP95 = pointing.flatMap((r) => (r.holdP95Deg === null ? [] : [r.holdP95Deg]));
          return {
            ray: kind,
            filter: filter.name,
            worstPointingHoldP95Deg: pointingP95.length ? Math.max(...pointingP95) : null,
            worstRestHoldP95Deg: ((v) => (v.length ? Math.max(...v) : null))(rest.flatMap((r) => (r.holdP95Deg === null ? [] : [r.holdP95Deg]))),
            stepLagSec: stepLagSec(filter),
            settleSec: transitions.map(({ prev, next }) => {
              const target = rayStudySegment(next, kind, RAY_FILTERS[0]!).mean;
              return { from: prev.label, to: next.label, sec: target ? settleSec(prev, next, kind, filter, target) : null };
            }),
            shiftFromCurrentDeg: pointing.map((r, i) => {
              const ref = rayStudySegment(pointingSegs[i]!, 'mcp-tip', RAY_FILTERS[0]!).mean;
              return r.mean && ref ? round(angleDeg(r.mean, ref), 1) : null;
            }),
            pointing: pointing.map(({ mean: _mean, ...r }) => r),
            rest: rest.map(({ mean: _mean, ...r }) => r)
          };
        })
      )
    }
  : null;
if (rayJitterStudy) {
  console.log('[bodycam-report] ray jitter study (hold p95 deg; worst pointing segment | per pointing segment | worst rest | step lag s | settle s | shift deg | aim median deg)');
  for (const v of rayJitterStudy.variants) {
    console.log(`  ${v.ray.padEnd(9)} ${v.filter.padEnd(26)} ${String(v.worstPointingHoldP95Deg).padStart(6)} | ${v.pointing.map((r) => r.holdP95Deg).join(' ')} | ${v.worstRestHoldP95Deg} | ${v.stepLagSec} | ${v.settleSec.map((x) => x.sec).join(' ')} | ${v.shiftFromCurrentDeg.join(' ')} | ${v.pointing.map((r) => r.aimMedianErrorDeg).join(' ')}`);
  }
}

// ── Aim study ───────────────────────────────────────────────────────────────
// Each aim segment against its measured target, for the knuckle and wrist rays, as the hand model gives them and
// perspective-corrected. The hand model sees a crop around the hand and may give the finger's direction relative to
// its own line of sight rather than the lens's axis; the corrected ray turns it by the angle between the lens axis and
// the line of sight to the hand's wrist in the picture. Raw rays (no filter) over the segment trimmed by 0.3 s at each
// end, frames scoring 0.35 or more. Signed errors: ray minus target direction, yaw positive toward the author's left
// (image right), pitch positive up.
const camera = config.camera ?? { imageXFovDeg: 45.7, imageYFovDeg: 73.7 };
function lineOfSight(o: HandObs): Point3 {
  const w = o.hand.imageWrist;
  return norm({ x: Math.tan(camera.imageXFovDeg / 2 / DEG) * (2 * w.x - 1), y: Math.tan(camera.imageYFovDeg / 2 / DEG) * (2 * w.y - 1), z: 1 });
}
/** Rotates v by the rotation that takes the lens axis (0, 0, 1) onto the unit vector to. */
function fromLensAxis(to: Point3, v: Point3): Point3 {
  const axis = { x: -to.y, y: to.x, z: 0 };
  const s = Math.hypot(axis.x, axis.y);
  if (s < 1e-9) return v;
  const k = scale(axis, 1 / s);
  const theta = Math.atan2(s, to.z);
  const cross = { x: k.y * v.z - k.z * v.y, y: k.z * v.x - k.x * v.z, z: k.x * v.y - k.y * v.x };
  return add(add(scale(v, Math.cos(theta)), scale(cross, Math.sin(theta))), scale(k, dot(k, v) * (1 - Math.cos(theta))));
}
const yawDeg = (v: Point3): number => Math.atan2(v.x, v.z) * DEG;
const pitchDeg = (v: Point3): number => Math.atan2(-v.y, Math.hypot(v.x, v.z)) * DEG;
const AIM_RAYS: Array<{ name: string; kind: RayKind; perspective: boolean }> = [
  { name: 'knuckle-tip', kind: 'mcp-tip', perspective: false },
  { name: 'knuckle-tip corrected', kind: 'mcp-tip', perspective: true },
  { name: 'wrist-tip', kind: 'wrist-tip', perspective: false },
  { name: 'wrist-tip corrected', kind: 'wrist-tip', perspective: true }
];
const aimStudy = {
  note: 'Raw rays against fingertip-to-target over each aim segment (trimmed 0.3 s each end, score 0.35 or more). Signed: ray minus target, yaw + toward the author\'s left (image right), pitch + up. Corrected: turned by the line of sight to the hand in the picture.',
  camera,
  segments: (config.segments ?? []).flatMap((seg) => {
    const targetPoint = targetPointOf(seg.target);
    if (!targetPoint) return [];
    const obs = observations.filter((o) => o.side === (seg.hand ?? 'right') && o.clipSec >= seg.startSec + 0.3 && o.clipSec < seg.endSec - 0.3 && (o.score ?? 0) >= 0.35);
    return [{
      label: seg.label,
      target: seg.target,
      rays: AIM_RAYS.map((r) => {
        const errors: number[] = [];
        const yaws: number[] = [];
        const pitches: number[] = [];
        for (const o of obs) {
          const tip = fingertipInLensFrame(o);
          const raw = rayOf(o, r.kind);
          if (!tip || !raw) continue;
          const ray = r.perspective ? norm(fromLensAxis(lineOfSight(o), raw)) : raw;
          const toTarget = norm(sub(targetPoint, tip));
          errors.push(angleDeg(ray, toTarget));
          yaws.push(yawDeg(ray) - yawDeg(toTarget));
          pitches.push(pitchDeg(ray) - pitchDeg(toTarget));
        }
        return { ray: r.name, frames: errors.length, medianErrorDeg: roundOrNull(percentile(errors, 50), 1), p95ErrorDeg: roundOrNull(percentile(errors, 95), 1), medianYawErrorDeg: roundOrNull(percentile(yaws, 50), 1), medianPitchErrorDeg: roundOrNull(percentile(pitches, 50), 1) };
      })
    }];
  })
};
if (aimStudy.segments.length) {
  console.log('[bodycam-report] aim study (median error deg, signed yaw/pitch deg; frames)');
  for (const seg of aimStudy.segments) console.log(`  ${seg.label.padEnd(36)} ${seg.rays.map((r) => `${r.ray} ${r.medianErrorDeg} (${r.medianYawErrorDeg}/${r.medianPitchErrorDeg}) n${r.frames}`).join(' | ')}`);
}

// Head, from every frame's head rotation.
const headFrames = entries.flatMap((e) => (e.frame.head ? [eulerYxz(e.frame.head)] : []));
const headStat = (pick: (e: { yaw: number; pitch: number; roll: number }) => number) => {
  const values = headFrames.map(pick);
  return { p5: roundOrNull(percentile(values, 5), 1), median: roundOrNull(percentile(values, 50), 1), p95: roundOrNull(percentile(values, 95), 1) };
};
// Where the face model loses the face, the avatar takes the head's yaw from the pose's nose and ears instead.
const poseHeadFrames = entries.flatMap((e) => (!e.frame.head && e.frame.pose ? [{ clipSec: e.clipSec, head: headYawFromPose(e.frame.pose.image) }] : []));
const poseHeadFallback = {
  note: 'Frames with no face but a pose: the head yaw then comes from the nose offset from the ear midpoint (convert.ts headYawFromPose), pitch level.',
  frames: poseHeadFrames.length,
  framesWithYaw: poseHeadFrames.filter((f) => f.head).length,
  yawDeg: ((values: number[]) => ({ min: roundOrNull(Math.min(...values), 1), median: roundOrNull(percentile(values, 50), 1), max: roundOrNull(Math.max(...values), 1) }))(poseHeadFrames.flatMap((f) => (f.head ? [eulerYxz(f.head).yaw] : [])))
};
// Head angles per segment: what the author's head did, not a lens-facing reference (the author often looks down at the
// screen or hands). Face frames only, plus the share of the segment the pose fallback covered.
const headBySegment = (config.segments ?? []).map((s) => {
  const inSeg = entries.filter((e) => e.clipSec >= s.startSec && e.clipSec < s.endSec);
  const face = inSeg.flatMap((e) => (e.frame.head ? [eulerYxz(e.frame.head)] : []));
  const median = (pick: (e: { yaw: number; pitch: number; roll: number }) => number) => roundOrNull(percentile(face.map(pick), 50), 1);
  return {
    label: s.label,
    frames: inSeg.length,
    faceFrames: face.length,
    poseFallbackFrames: inSeg.filter((e) => !e.frame.head && e.frame.pose && headYawFromPose(e.frame.pose.image)).length,
    yawMedianDeg: median((h) => h.yaw),
    pitchMedianDeg: median((h) => h.pitch),
    poseFallbackYawMedianDeg: roundOrNull(percentile(inSeg.flatMap((e) => { const h = !e.frame.head && e.frame.pose ? headYawFromPose(e.frame.pose.image) : null; return h ? [eulerYxz(h).yaw] : []; }), 50), 1)
  };
});

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
    rollDeg: headStat((h) => h.roll),
    poseFallback: poseHeadFallback,
    bySegment: headBySegment
  },
  wholeClip: whole,
  segments,
  rayJitterStudy,
  geometry: config.distances ? { ...config.distances, marks: config.marks ?? null, camera } : null,
  aimStudy
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
console.log(`[bodycam-report] head: face ${report.detection.framesWithHeadRotation} frames; pose fallback ${poseHeadFallback.framesWithYaw}/${poseHeadFallback.frames} frames, yaw ${poseHeadFallback.yawDeg.min}..${poseHeadFallback.yawDeg.max} (median ${poseHeadFallback.yawDeg.median})`);
for (const h of headBySegment) console.log(`  ${h.label.padEnd(44)} face ${h.faceFrames}/${h.frames} fallback ${h.poseFallbackFrames}  yaw ${h.yawMedianDeg} pitch ${h.pitchMedianDeg}${h.poseFallbackFrames ? ` (fallback yaw ${h.poseFallbackYawMedianDeg})` : ''}`);

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
