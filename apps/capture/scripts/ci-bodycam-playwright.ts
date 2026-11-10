import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { chromium, type Download } from 'playwright';
import * as THREE from 'three';
import { CONTROL_NAMES } from '@holoim/xr-ui-core';
import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import type {} from '../src/runtime/automationHooks';
import type { BodycamSnapshot } from '../src/bodycam/snapshot';
import type { HandLandmarks, LandmarkFrame, Point3, Quat4 } from '../src/bodycam/types';
import type { TrackedHandJointName, VrHandSide } from '../src/types/contracts';
import { readGlbJson } from './lib/pointing-score.ts';

// Camera avatar, slice 1 (docs/features/camera-avatar-spike.md): no models and no camera. A committed, synthetic
// landmark stream (generated below from a scripted performance, in the shape MediaPipe's pose and hand landmarkers
// deliver) goes through __setBodycamFrame on a desktop page opened with ?input=camera, under the manual clock. The
// avatar's wrists, fingers and head follow, the take is recorded and exported, and the GLB is read back. Then an IWER
// VR session is entered, which must release the camera source. A last phase starts the live tracker on Chromium's
// fake camera: both models load only then, and a test pattern drives no hand (what a model detects in a real
// picture goes to the report-only runner, bodycam-clip-report.ts). BODYCAM_VIDEO=1 writes frames, a video and a sheet.

const STEP_MS = 1000 / 30;
const DEG = Math.PI / 180;
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-bodycam';
const video = process.env.BODYCAM_VIDEO === '1';
const frameDir = path.join(artifactDir, 'frames');

// ── The scripted performance ───────────────────────────────────────────────
// Built in the author's own frame (x right, y up, z back; hips at the origin, metres) for a right hand; the left
// hand is the right hand's mirror image. A MediaPipe camera frame is that frame turned half a turn about z.

type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
const FINGERS: readonly Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
type Basis = { across: THREE.Vector3; along: THREE.Vector3; normal: THREE.Vector3 };
type HandState = { wrist: THREE.Vector3; basis: THREE.Quaternion; curl: Record<Finger, number>; pinch: number };
type Segment = { name: string; sec: number; right: HandState | null; left: HandState | null; yawDeg: number; poseRight?: HandState; poseLeft?: HandState };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const basisQuaternion = ({ across, along, normal }: Basis) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, along, normal));
const FINGERS_UP: Basis = { across: v(-1, 0, 0), along: v(0, 1, 0), normal: v(0, 0, -1) };
const FINGERS_FORWARD: Basis = { across: v(-1, 0, 0), along: v(0, 0, -1), normal: v(0, -1, 0) };
const FINGERS_DOWN: Basis = { across: v(0, 0, -1), along: v(0, -1, 0), normal: v(-1, 0, 0) };
const curls = (thumb: number, index: number, middle: number, ring: number, pinky: number) => ({ thumb, index, middle, ring, pinky });
const state = (wrist: THREE.Vector3, basis: Basis, curl: Record<Finger, number>, pinch = 0): HandState => ({ wrist, basis: basisQuaternion(basis), curl, pinch });

const HANG = state(v(0.24, -0.12, -0.02), FINGERS_DOWN, curls(0.2, 0.25, 0.25, 0.25, 0.25));
const RAISED = state(v(0.26, 0.55, -0.32), FINGERS_UP, curls(0, 0, 0, 0, 0));
const POINT = state(v(0.24, 0.45, -0.3), FINGERS_FORWARD, curls(0.8, 0, 1, 1, 1));
const FIST = state(v(0.24, 0.45, -0.28), FINGERS_UP, curls(1, 1, 1, 1, 1));
const PINCH = state(v(0.26, 0.55, -0.32), FINGERS_UP, curls(0.3, 0.5, 0, 0, 0), 1);

// `right` is null where the hand landmarker loses the hand (the pose keeps its wrist); `poseRight` is where the
// pose puts that wrist then.
const SEGMENTS: Segment[] = [
  { name: 'rest', sec: 1, right: HANG, left: HANG, yawDeg: 0 },
  { name: 'right-raised', sec: 1.2, right: RAISED, left: HANG, yawDeg: 0 },
  { name: 'point', sec: 1, right: POINT, left: HANG, yawDeg: 0 },
  { name: 'fist', sec: 1, right: FIST, left: HANG, yawDeg: 0 },
  { name: 'open', sec: 1, right: RAISED, left: HANG, yawDeg: 0 },
  { name: 'pinch', sec: 1, right: PINCH, left: HANG, yawDeg: 0 },
  { name: 'head-left', sec: 1.2, right: RAISED, left: HANG, yawDeg: 30 },
  { name: 'head-right', sec: 1.2, right: RAISED, left: HANG, yawDeg: -30 },
  { name: 'head-centre', sec: 0.4, right: RAISED, left: HANG, yawDeg: 0 },
  { name: 'gap', sec: 1.2, right: null, left: HANG, yawDeg: 0, poseRight: RAISED },
  { name: 'both', sec: 1.2, right: RAISED, left: RAISED, yawDeg: 0 },
  { name: 'end-rest', sec: 0.8, right: HANG, left: HANG, yawDeg: 0 },
  // The head is turned when the frames stop, so the stall has something to ease back from.
  { name: 'turn-then-stall', sec: 0.6, right: HANG, left: HANG, yawDeg: 30 }
];
const STALL_SEC = 1;
const BLEND_SEC = 0.25;

const mirrorX = (p: THREE.Vector3) => v(-p.x, p.y, p.z);
const toCamera = (p: THREE.Vector3): Point3 => ({ x: -p.x, y: -p.y, z: p.z });

// Right-hand joints in the author's frame, wrist-relative; fingers curl toward the palm.
const KNUCKLES: Record<Exclude<Finger, 'thumb'>, [number, number]> = { index: [0.03, 0.088], middle: [0, 0.09], ring: [-0.025, 0.085], pinky: [-0.05, 0.075] };
const THUMB = { cmc: v(0.025, 0.02, 0), extended: [v(0.06, 0.05, 0.01), v(0.085, 0.075, 0.01), v(0.105, 0.095, 0.01)], curled: [v(0.045, 0.045, 0.03), v(0.03, 0.06, 0.045), v(0.012, 0.07, 0.05)] };

function handJoints(s: HandState): THREE.Vector3[] {
  // Local (across, along, normal) points, then into the author's frame.
  const local: THREE.Vector3[] = new Array(21);
  local[0] = v(0, 0, 0);
  for (const [fi, finger] of (['index', 'middle', 'ring', 'pinky'] as const).entries()) {
    const [a, b] = KNUCKLES[finger];
    const base = 5 + fi * 4;
    let p = v(a, b, 0);
    local[base] = p;
    let theta = 0;
    const lengths = [0.04, 0.025, 0.02];
    const flex = [80, 100, 70];
    for (let k = 0; k < 3; k += 1) {
      theta += flex[k]! * DEG * s.curl[finger];
      p = p.clone().add(v(0, Math.cos(theta), Math.sin(theta)).multiplyScalar(lengths[k]!));
      local[base + 1 + k] = p;
    }
  }
  const indexTip = local[8]!;
  const thumbEnds = THUMB.extended.map((e, i) => e.clone().lerp(THUMB.curled[i]!, s.curl.thumb));
  local[1] = THUMB.cmc;
  const thumbChain = s.pinch > 0 ? [0.4, 0.7, 1].map((f) => THUMB.cmc.clone().lerp(indexTip, f)) : thumbEnds;
  local[2] = thumbChain[0]!;
  local[3] = thumbChain[1]!;
  local[4] = thumbChain[2]!;
  return local.map((p) => p.clone().applyQuaternion(s.basis));
}

const POSE_COUNT = 33;
const SHOULDER_HALF = 0.18;
const toImage = (p: THREE.Vector3) => ({ x: 0.5 - 0.8 * p.x, y: 0.75 - 0.8 * p.y });

function frameFor(right: HandState | null, left: HandState | null, poseRight: HandState, poseLeft: HandState, yawDeg: number, handsReversed: boolean): LandmarkFrame {
  const wristR = poseRight.wrist;
  const wristL = mirrorX(poseLeft.wrist);
  const world: Point3[] = Array.from({ length: POSE_COUNT }, () => ({ x: 0, y: 0, z: 0 }));
  const imageBody: THREE.Vector3[] = Array.from({ length: POSE_COUNT }, () => v(0, 0.5, 0));
  const place = (index: number, p: THREE.Vector3) => {
    world[index] = toCamera(p);
    imageBody[index] = p;
  };
  place(11, v(-SHOULDER_HALF, 0.5, 0));
  place(12, v(SHOULDER_HALF, 0.5, 0));
  place(15, wristL);
  place(16, wristR);
  place(23, v(-0.1, 0, 0));
  place(24, v(0.1, 0, 0));
  place(0, v(0, 0.68, -0.02));
  const image = imageBody.map(toImage);

  const hands: HandLandmarks[] = [];
  const addHand = (s: HandState | null, mirror: boolean) => {
    if (!s) return;
    // The left hand is the right hand reflected across the body's midline.
    const joints = handJoints(s).map((p) => (mirror ? mirrorX(p) : p));
    // The hand model's own origin is its centre, not the wrist: shift it so the converter cannot rely on that.
    const centre = joints.reduce((acc, p) => acc.add(p), v(0, 0, 0)).multiplyScalar(1 / joints.length);
    const wrist = mirror ? mirrorX(s.wrist) : s.wrist;
    const worldPoints = joints.map((p) => toCamera(p.clone().sub(centre)));
    const wristImage = toImage(wrist);
    hands.push({ world: worldPoints, imageWrist: { x: wristImage.x + 0.004, y: wristImage.y - 0.004 } });
  };
  addHand(right, false);
  addHand(left, true);
  if (handsReversed) hands.reverse();

  // Head turned to the author's left by yawDeg: a rotation about the camera frame's y (down) by -yaw.
  const half = (-yawDeg * DEG) / 2;
  const head: Quat4 = [0, Math.sin(half), 0, Math.cos(half)];
  return { pose: { world, image }, hands, head };
}

// The stream: one frame per step of 1/30 s, parameters blended across each segment's first BLEND_SEC.
function* stream(): Generator<{ frame: LandmarkFrame; segment: string; segmentIndex: number; timeSec: number; rightPresent: boolean; leftPresent: boolean }> {
  let timeSec = 0;
  let prev = SEGMENTS[0]!;
  for (const [segmentIndex, seg] of SEGMENTS.entries()) {
    const steps = Math.round(seg.sec / (STEP_MS / 1000));
    for (let i = 0; i < steps; i += 1) {
      const t = Math.min(1, (i * (STEP_MS / 1000)) / BLEND_SEC);
      const blend = (a: HandState, b: HandState): HandState => ({
        wrist: a.wrist.clone().lerp(b.wrist, t),
        basis: a.basis.clone().slerp(b.basis, t),
        curl: Object.fromEntries(FINGERS.map((f) => [f, a.curl[f] + (b.curl[f] - a.curl[f]) * t])) as Record<Finger, number>,
        pinch: b.pinch
      });
      const fromR = prev.right ?? prev.poseRight ?? HANG;
      const toR = seg.right ?? seg.poseRight ?? HANG;
      const fromL = prev.left ?? HANG;
      const toL = seg.left ?? HANG;
      const stateR = blend(fromR, toR);
      const stateL = blend(fromL, toL);
      const yaw = (prev.yawDeg + (seg.yawDeg - prev.yawDeg) * t);
      // The two hands arrive in either order: sides come from the pose wrists, not from the list.
      const frame = frameFor(seg.right ? stateR : null, seg.left ? stateL : null, stateR, stateL, yaw, segmentIndex % 2 === 1);
      yield { frame, segment: seg.name, segmentIndex, timeSec, rightPresent: Boolean(seg.right), leftPresent: Boolean(seg.left) };
      timeSec += STEP_MS / 1000;
    }
    prev = seg;
  }
}

// ── The check ───────────────────────────────────────────────────────────────

type Sample = { frame: number; timeSec: number; segment: string; segmentIndex: number; fed: Record<VrHandSide, boolean>; snap: BodycamSnapshot };
type Vec3 = [number, number, number];
const dist = (a: readonly number[] | undefined, b: readonly number[] | undefined): number => (a && b ? Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) : NaN);
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });

// Chromium's fake camera (a test pattern, never a person) for the live-tracker phase.
const browser = await launchXrBrowser(chromium, { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const consoleErrors: string[] = [];
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

try {
  const context = await createXrContext(browser, { viewport: { width: 960, height: 540 }, acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label: 'bodycam' });
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  // Stopping an IWER session's recording uploads its input to the dev server's fixture sink; not a fixture here.
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the bodycam check)"}' }));
  const url = new URL(baseUrl);
  url.searchParams.set('manualClock', '1');
  url.searchParams.set('input', 'camera');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', '__setManualClock', '__setBodycamFrame', '__sampleBodycam', '__sampleHumanoid']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true, true));
  await waitForIwerRuntime(page);
  const humanoid = await page.evaluate(() => window.__sampleHumanoid());
  check(Boolean(humanoid), 'no humanoid binding');
  const boneNode = (bone: string): string | undefined => (humanoid?.bones as Record<string, string | undefined>)[bone];

  // Before any frame the source is idle: the desktop path is untouched.
  await page.evaluate(() => window.advanceTime(200));
  const idle = await page.evaluate(() => window.__sampleBodycam());
  check(!idle.canvasFlipped, 'the canvas was flipped before any camera frame');
  check(idle.enabled && !idle.active && !idle.cameraDriven, `before any frame: enabled ${idle.enabled}, active ${idle.active}, driven ${idle.cameraDriven}`);

  const clickButton = (name: string) => page.evaluate((label: string) => {
    const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label);
    if (!button) throw new Error(`no button "${label}"`);
    button.click();
  }, name);
  await clickButton(CONTROL_NAMES.startRecording);

  const samples: Sample[] = [];
  const screenXs: Record<string, { width: number; left: number | null; right: number | null; flipped: boolean }> = {};
  const sheetMarks = new Set<number>();
  let frameIndex = 0;
  let lastSegment = -1;
  const performance_ = [...stream()];
  for (const [i, item] of performance_.entries()) {
    await page.evaluate((f) => window.__setBodycamFrame(f), item.frame);
    await page.evaluate((ms: number) => window.advanceTime(ms), STEP_MS);
    const snap: BodycamSnapshot = await page.evaluate(() => window.__sampleBodycam());
    samples.push({ frame: frameIndex, timeSec: item.timeSec, segment: item.segment, segmentIndex: item.segmentIndex, fed: { left: item.leftPresent, right: item.rightPresent }, snap });
    const last = performance_[i + 1]?.segmentIndex !== item.segmentIndex;
    if (last && (item.segment === 'right-raised' || item.segment === 'both')) {
      // Where the author sees each wrist: projected through the view camera, then flipped like the canvas is.
      screenXs[item.segment] = await page.evaluate(() => {
        const snap = window.__sampleBodycam();
        const l = snap.hands.left.avatar.wrist ? window.__projectToScreen(snap.hands.left.avatar.wrist) : null;
        const r = snap.hands.right.avatar.wrist ? window.__projectToScreen(snap.hands.right.avatar.wrist) : null;
        const w = window.innerWidth;
        return { width: w, left: l ? (snap.canvasFlipped ? w - l.x : l.x) : null, right: r ? (snap.canvasFlipped ? w - r.x : r.x) : null, flipped: snap.canvasFlipped };
      });
    }
    if (video || (last && !sheetMarks.has(item.segmentIndex))) {
      await page.screenshot({ path: path.join(frameDir, `${String(video ? frameIndex : item.segmentIndex).padStart(5, '0')}.png`) });
      if (last) sheetMarks.add(item.segmentIndex);
    }
    lastSegment = item.segmentIndex;
    frameIndex += 1;
  }
  void lastSegment;

  // The frames stop while the head is turned: the head and neck must ease back, not snap.
  const stall: Array<{ timeSec: number; head: number[] }> = [];
  for (let k = 0; k < Math.round(STALL_SEC * 60); k += 1) {
    await page.evaluate(() => window.advanceTime(1000 / 60));
    const snap: BodycamSnapshot = await page.evaluate(() => window.__sampleBodycam());
    stall.push({ timeSec: k / 60, head: snap.head.head! });
  }
  const recordedTake = (await page.evaluate(() => window.__sampleBodycam(true))).recorded!;

  // ── Assertions ──────────────────────────────────────────────────────────
  const end = (name: string): Sample => [...samples].reverse().find((s) => s.segment === name)!;
  const during = (name: string): Sample[] => samples.filter((s) => s.segment === name);
  const wrist = (s: Sample, side: VrHandSide): Vec3 | undefined => s.snap.hands[side].avatar.wrist as Vec3 | undefined;
  const sources = new Set<string>();
  for (const s of samples) for (const side of ['left', 'right'] as const) sources.add(s.snap.hands[side].source);

  // 1. Sides and mirror, in screen space as the author sees it (the canvas is flipped like a selfie preview).
  const raised = end('right-raised');
  const rest = end('rest');
  const seen = screenXs['right-raised']!;
  const seenBoth = screenXs.both!;
  const screenGap = seen.right !== null && seen.left !== null ? seen.right - seen.left : NaN;
  const rise = wrist(raised, 'right')![1] - wrist(rest, 'right')![1];
  const leftDrift = dist(wrist(raised, 'left'), wrist(rest, 'left'));
  check(seen.flipped && samples.slice(3).every((s) => s.snap.canvasFlipped), 'the canvas was not flipped for every camera-driven frame');
  check(screenGap > 40, `the right wrist is ${round(screenGap, 1)} px right of the left wrist on the author's screen, want > 40`);
  check(Boolean(seenBoth.right !== null && seenBoth.left !== null && seenBoth.right > seenBoth.left), 'with both hands raised the right wrist is not right of the left on screen');
  check(rise > 0.25, `right wrist rose ${round(rise)} m, want > 0.25`);
  check(leftDrift < 0.1, `left wrist drifted ${round(leftDrift)} m while only the right hand moved`);
  // The avatar's face points at the view camera: its facing is opposite the camera's view direction.
  const faceDots = samples.slice(10).map((s) => s.snap.faceForward[0] * s.snap.viewForward[0] + s.snap.faceForward[1] * s.snap.viewForward[1] + s.snap.faceForward[2] * s.snap.viewForward[2]);
  const faceDotWorst = Math.max(...faceDots);
  check(faceDotWorst < -0.85, `the avatar's face is not toward the view camera (facing . view worst ${round(faceDotWorst)}, want < -0.85)`);
  const both = end('both');
  check(wrist(both, 'left')![1] - wrist(rest, 'left')![1] > 0.25 && wrist(both, 'right')![1] - wrist(rest, 'right')![1] > 0.25, 'both wrists did not rise in the both-hands segment');

  // 2. The body does not turn, crouch or walk; the camera avatar is never VR embodiment.
  const first = samples[10]!;
  const bodyYawRange = Math.max(...samples.slice(10).map((s) => Math.abs(s.snap.body.rootYaw - first.snap.body.rootYaw)));
  const rootMove = Math.max(...samples.slice(10).map((s) => dist(s.snap.body.rootPosition, first.snap.body.rootPosition)));
  const hipsRange = Math.max(...samples.slice(10).map((s) => Math.abs((s.snap.body.hipsY ?? 0) - (first.snap.body.hipsY ?? 0))));
  check(bodyYawRange < 1e-6, `the body turned ${round(bodyYawRange / DEG)}°`);
  check(rootMove < 0.01, `the avatar root moved ${round(rootMove)} m`);
  check(hipsRange < 0.03, `the hips moved ${round(hipsRange)} m (a crouch?)`);
  check(samples.every((s) => !s.snap.vrActive && !s.snap.xrPresenting), 'vrActive or xrPresenting turned true during the camera performance');
  check(samples.slice(2).every((s) => s.snap.cameraDriven), 'the camera source was not driving once frames arrived');

  // 3. Head: turns with the author's head (avatar's left is +Y), relative to the neutral head, body still.
  const headAngles = (s: Sample) => {
    const q = (a: [number, number, number, number]) => new THREE.Quaternion(a[0], a[1], a[2], a[3]);
    const neutral = q(end('rest').snap.head.head!);
    const delta = q(s.snap.head.head!).multiply(neutral.clone().invert());
    const euler = new THREE.Euler().setFromQuaternion(delta, 'YXZ');
    return { yawDeg: euler.y / DEG, pitchDeg: euler.x / DEG, rollDeg: euler.z / DEG };
  };
  check(Boolean(end('rest').snap.head.head), 'the avatar has no head bone');
  const leftTurn = headAngles(end('head-left'));
  const rightTurn = headAngles(end('head-right'));
  check(Math.abs(leftTurn.yawDeg - 30) < 8 && Math.abs(leftTurn.pitchDeg) < 8 && Math.abs(leftTurn.rollDeg) < 8, `head-left read ${JSON.stringify(leftTurn)}, want yaw 30°`);
  check(Math.abs(rightTurn.yawDeg + 30) < 8 && Math.abs(rightTurn.pitchDeg) < 8 && Math.abs(rightTurn.rollDeg) < 8, `head-right read ${JSON.stringify(rightTurn)}, want yaw -30°`);

  // 4. Fingers: a fist curls them, an open hand extends them (tip-to-wrist, avatar bones).
  const reach = (s: Sample, side: VrHandSide) => {
    const w = wrist(s, side)!;
    return ['index', 'middle', 'ring', 'pinky'].reduce((total, f) => total + dist(s.snap.hands[side].avatar[`${f}-finger-tip` as TrackedHandJointName] ?? s.snap.hands[side].avatar[`${f}-finger-phalanx-distal` as TrackedHandJointName], w), 0);
  };
  const fistReach = reach(end('fist'), 'right');
  const openReach = reach(end('open'), 'right');
  check(fistReach < openReach * 0.8, `fist reach ${round(fistReach)} is not under 0.8 of open reach ${round(openReach)}`);
  const pinchTracked = dist(end('pinch').snap.hands.right.tracked['thumb-tip'], end('pinch').snap.hands.right.tracked['index-finger-tip']);
  const pinchAvatar = dist(end('pinch').snap.hands.right.avatar['thumb-tip'], end('pinch').snap.hands.right.avatar['index-finger-tip']);
  check(pinchTracked < 0.01, `camera pinch distance ${round(pinchTracked)} m`);

  // 5. Every driven hand frame is camera-hand; nothing is xr-hand, mock or controller.
  const badSource = samples.flatMap((s) => (['left', 'right'] as const).filter((side) => s.fed[side] && s.snap.hands[side].source !== 'camera-hand').map((side) => `${s.segment}#${s.frame} ${side}=${s.snap.hands[side].source}`));
  check(badSource.length === 0, `driven hand frames not camera-hand: ${badSource.slice(0, 5).join(', ')}`);
  for (const forbidden of ['xr-hand', 'mock', 'controller', 'fallback']) check(!sources.has(forbidden), `a hand reported source ${forbidden}`);

  // 6. A lost hand holds at most 0.5 s, then eases to rest.
  const gap = during('gap');
  const gapStartWrist = wrist(end('head-centre'), 'right')!;
  const lostAt = gap[0]!.timeSec;
  const movedAt = gap.find((s) => dist(wrist(s, 'right'), gapStartWrist) > 0.02);
  const heldSec = movedAt ? movedAt.timeSec - lostAt : Infinity;
  const gapEndWrist = wrist(end('gap'), 'right');
  const toRest = dist(gapEndWrist, wrist(rest, 'right'));
  check(heldSec >= 0.35 && heldSec <= 0.65, `the lost hand stayed frozen for ${round(heldSec)} s, want about 0.5 s`);
  check(toRest < 0.15, `after the gap the wrist is ${round(toRest)} m from rest`);
  check(gap.every((s) => s.snap.hands.right.source !== 'camera-hand'), 'a lost hand still reported camera-hand');
  const gapSources = [...new Set(gap.map((s) => s.snap.hands.right.source))];
  const recovered = end('both').snap.hands.right.source === 'camera-hand';
  check(recovered, 'the right hand did not return to camera-hand after the gap');

  // 7. The take itself: every recorded frame with a driven hand says camera-hand; none says xr-hand or mock.
  const T0 = samples[0]!.snap.simSec - 2 / 60;
  const fedAt = (k: number, side: VrHandSide): boolean => (samples[Math.min(Math.max(k, 0), samples.length - 1)]?.fed[side] ?? false);
  let drivenFrames = 0;
  let wrongDriven = 0;
  const recordedSources = new Set<string>();
  let missing = 0;
  for (const [i, t] of recordedTake.times.entries()) {
    if (t < T0 + 0.1) continue;
    const k = Math.floor((t - T0) / (STEP_MS / 1000));
    if (k >= samples.length) continue;
    for (const side of ['left', 'right'] as const) {
      const source = recordedTake[side][i]!;
      recordedSources.add(source);
      if (source === 'missing') missing += 1;
      if (fedAt(k - 1, side) && fedAt(k, side) && fedAt(k + 1, side)) {
        drivenFrames += 1;
        if (source !== 'camera-hand') wrongDriven += 1;
      }
    }
  }
  check(missing === 0, `${missing} recorded hand-side frames carry no handSources`);
  check(drivenFrames > 400, `only ${drivenFrames} recorded driven hand frames were found`);
  check(wrongDriven === 0, `${wrongDriven} of ${drivenFrames} recorded driven hand frames are not camera-hand`);
  for (const forbidden of ['xr-hand', 'mock', 'controller', 'fallback']) check(!recordedSources.has(forbidden), `the take recorded a hand source ${forbidden}`);

  // 8. Frames stop with the head turned: no single-step jump, and it is back by the end.
  const headQ = (a: number[]) => new THREE.Quaternion(a[0], a[1], a[2], a[3]);
  const neutralHead = headQ(end('rest').snap.head.head!);
  const stallAngles = stall.map((s) => headQ(s.head).angleTo(neutralHead) / DEG);
  let stallStep = 0;
  for (let k = 1; k < stall.length; k += 1) stallStep = Math.max(stallStep, headQ(stall[k]!.head).angleTo(headQ(stall[k - 1]!.head)) / DEG);
  const stallStart = headAngles(end('turn-then-stall')).yawDeg;
  check(Math.abs(stallStart - 30) < 8, `the head was at ${round(stallStart, 1)}° when the frames stopped, want 30°`);
  check(stallStep <= 3, `the head jumped ${round(stallStep, 1)}° in one step when the frames stopped, want <= 3°`);
  check(stallAngles[stallAngles.length - 1]! < 4, `the head is still ${round(stallAngles[stallAngles.length - 1]!, 1)}° off the animated pose ${STALL_SEC} s after the stall`);

  // ── Export ──────────────────────────────────────────────────────────────
  const download = page.waitForEvent('download', { timeout: 60_000 });
  const exportStarted = performance.now();
  await clickButton(CONTROL_NAMES.stopRecording);
  let file: Download | null = null;
  void download.then((d: Download) => { file = d; });
  for (let waited = 0; !file && waited < 60_000; waited += STEP_MS) {
    await page.evaluate((ms: number) => window.advanceTime(ms), STEP_MS);
    await page.waitForTimeout(20);
  }
  const glbPath = path.join(artifactDir, 'bodycam.glb');
  await (await download).saveAs(glbPath);
  const exportMs = Math.round(performance.now() - exportStarted);
  const glb = await verifyExport(glbPath, boneNode);
  for (const message of glb.failures) failures.push(`export: ${message}`);

  // ── VR entry releases the camera source ────────────────────────────────
  const framesBefore = (await page.evaluate(() => window.__sampleBodycam())).frames;
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate(() => window.advanceTime(200));
  await page.evaluate((f) => window.__setBodycamFrame(f), performance_[0]!.frame);
  await page.evaluate(() => window.advanceTime(200));
  const vr = await page.evaluate(() => window.__sampleBodycam());
  check(vr.xrPresenting && vr.vrActive, `the IWER session did not present (xr ${vr.xrPresenting}, vr ${vr.vrActive})`);
  check(!vr.active && !vr.cameraDriven, `the camera source survived VR entry (active ${vr.active}, driven ${vr.cameraDriven})`);
  check(vr.frames === framesBefore, 'a frame fed while presenting was accepted');
  check(!vr.canvasFlipped, 'the canvas stayed flipped in VR');
  check(!['camera-hand'].includes(vr.hands.left.source) && !['camera-hand'].includes(vr.hands.right.source), 'a hand still reported camera-hand in VR');

  // ── The live tracker on a fake camera ───────────────────────────────────
  const live = await liveTrackerPhase(); // its checks add to `failures` themselves

  // ── Artifacts ───────────────────────────────────────────────────────────
  if (video) {
    const videoPath = path.join(artifactDir, 'bodycam.mp4');
    const encoded = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '30', '-i', path.join(frameDir, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', videoPath], { stdio: 'inherit' });
    console.log(encoded.status === 0 ? `[bodycam] video: ${videoPath}` : '[bodycam] ffmpeg unavailable; frames kept as PNGs');
  }
  const sheet = writeContactSheet(frameDir, path.join(artifactDir, 'bodycam-sheet.jpg'));
  if (sheet) console.log(`[bodycam] contact sheet: ${sheet}`);
  const report = {
    frames: samples.length,
    shoulderWidthM: round(samples[0]!.snap.shoulderWidth),
    sides: { rightRightOfLeftOnScreenPx: round(screenGap, 1), bothRaised: { leftPx: seenBoth.left, rightPx: seenBoth.right }, screenWidthPx: seen.width, rightRiseM: round(rise), leftDriftM: round(leftDrift) },
    faceToCamera: { worstFacingDotView: round(faceDotWorst) },
    provenance: { recordedFrames: recordedTake.times.length, drivenHandFrames: drivenFrames, drivenNotCameraHand: wrongDriven, sourcesInTake: [...recordedSources].sort() },
    stall: { headAtStopDeg: round(stallStart, 1), maxStepDeg: round(stallStep, 2), finalOffDeg: round(stallAngles[stallAngles.length - 1]!, 1) },
    body: { rootYawChangeDeg: round(bodyYawRange / DEG), rootMoveM: round(rootMove), hipsRangeM: round(hipsRange), vrActiveEver: samples.some((s) => s.snap.vrActive) },
    head: { leftTurn: roundAngles(leftTurn), rightTurn: roundAngles(rightTurn) },
    fingers: { fistReachM: round(fistReach), openReachM: round(openReach), ratio: round(fistReach / openReach), pinchCameraM: round(pinchTracked), pinchAvatarM: round(pinchAvatar) },
    sources: [...sources].sort(),
    drivenFramesNotCameraHand: badSource.length,
    hold: { frozenSec: round(heldSec), sourcesInGap: gapSources, endDistanceToRestM: round(toRest), recovered },
    export: { ...glb.summary, exportMs },
    liveTracker: live.summary,
    viewer: 'not run: only the viewer-web pipeline specs (RUN_E2E_PIPELINE) upload a take and play it, and they start their own API, viewer and capture servers',
    vrEntry: { canvasFlipped: vr.canvasFlipped, active: vr.active, cameraDriven: vr.cameraDriven, framesIgnored: vr.frames === framesBefore },
    failures
  };
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(artifactDir, 'samples.json'), JSON.stringify(samples.map(({ frame, segment, fed, snap }) => ({ frame, segment, fed, source: { left: snap.hands.left.source, right: snap.hands.right.source }, rightWrist: snap.hands.right.avatar.wrist, leftWrist: snap.hands.left.avatar.wrist, head: snap.head.head, root: snap.body }))));
  console.log(`[bodycam] ${samples.length} frames; sides ${round(screenGap, 1)} px, frozen ${round(heldSec)} s, fist/open ${round(fistReach / openReach)}; export ${glb.summary.bytes} bytes in ${exportMs} ms`);
  const errors = consoleErrors.filter((line) => !/INFO: Created TensorFlow Lite/.test(line));
  if (errors.length > 0) failures.push(`console errors:\n${errors.join('\n')}`);
  if (failures.length > 0) throw new Error(`Bodycam check failed:\n- ${failures.join('\n- ')}`);
  console.log('Bodycam check passed.');
} finally {
  await browser.close();
}

/**
 * Deterministic claims only. Before the camera starts, a camera-input page has fetched neither the pose nor the
 * hand model; after it starts on Chromium's fake device both load, nothing throws, and the test pattern (no person)
 * drives no hand. Nothing here asserts what a model detects.
 */
async function liveTrackerPhase() {
  const context = await createXrContext(browser, { viewport: { width: 640, height: 360 }, permissions: ['camera'] });
  const page = await context.newPage();
  const errors: string[] = [];
  wireXrConsoleErrors(page, errors, { label: 'bodycam-live' });
  const taskResponses = new Map<string, number>();
  const taskRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.task')) taskRequests.push(path.basename(new URL(request.url()).pathname));
  });
  page.on('response', (response) => {
    if (response.url().endsWith('.task')) taskResponses.set(path.basename(new URL(response.url()).pathname), response.status());
  });
  const url = new URL(baseUrl);
  url.searchParams.set('input', 'camera');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__toggleFaceCamera', '__sampleBodycam', '__sampleBodycamTracker']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.waitForTimeout(1500);
  const before = [...taskRequests];
  check(!before.some((name) => /pose_landmarker|hand_landmarker/.test(name)), `before the camera started the page fetched ${before.join(', ')}`);
  check((await page.evaluate(() => window.__sampleBodycamTracker())) === null, 'a tracker existed before the camera started');

  await page.evaluate(() => window.__toggleFaceCamera());
  const started = await page.waitForFunction(() => {
    const tracker = window.__sampleBodycamTracker();
    return tracker && tracker.frames > 0 ? { delegate: tracker.delegate, camera: tracker.camera } : null;
  }, undefined, { timeout: 150_000, polling: 500 }).then((handle) => handle.jsonValue()).catch(() => null);
  check(Boolean(started), 'the live tracker never produced a frame on the fake camera within 150 s');
  // A few seconds more of the test pattern.
  await page.waitForTimeout(3000);
  const tracker = await page.evaluate(() => window.__sampleBodycamTracker());
  const snap = await page.evaluate(() => window.__sampleBodycam());
  const after = [...taskRequests];
  for (const name of ['pose_landmarker_full.task', 'hand_landmarker.task']) {
    check(taskResponses.get(name) === 200, `${name} was not loaded after the camera started (status ${taskResponses.get(name)})`);
  }
  check(errors.filter((line) => !/INFO: Created TensorFlow Lite/.test(line)).length === 0, `errors while tracking the fake camera: ${errors.join(' | ')}`);
  check(snap.hands.left.source !== 'camera-hand' && snap.hands.right.source !== 'camera-hand', `the test pattern drove a hand (left ${snap.hands.left.source}, right ${snap.hands.right.source})`);
  check(!snap.vrActive, 'vrActive turned true under the live tracker');
  const faceBefore = await page.evaluate(() => window.__sampleFace().camera);
  check(faceBefore === 'tracking' || faceBefore === 'no-face', `face camera state ${faceBefore} while the tracker ran`);

  // Toggling the camera off stops body tracking too, and releases the source.
  await page.evaluate(() => window.__toggleFaceCamera());
  await page.waitForTimeout(500);
  check((await page.evaluate(() => window.__sampleBodycamTracker())) === null, 'the tracker kept running after the camera was toggled off');
  const stopped = await page.evaluate(() => window.__sampleBodycam());
  check(!stopped.active && !stopped.cameraDriven, `the camera source survived the toggle off (active ${stopped.active})`);
  await context.close();
  return {
    summary: { tasksBeforeCamera: before, tasksAfterCamera: after, delegate: tracker?.delegate ?? null, trackerFrames: tracker?.frames ?? 0, feedHz: round(tracker?.feedHz ?? 0, 1), drivenHandSources: [snap.hands.left.source, snap.hands.right.source] }
  };
}

function roundAngles(a: { yawDeg: number; pitchDeg: number; rollDeg: number }) {
  return { yawDeg: round(a.yawDeg, 1), pitchDeg: round(a.pitchDeg, 1), rollDeg: round(a.rollDeg, 1) };
}

/**
 * The GLB's rotation tracks must show an arm, a finger and the head moving, and the meaning layer must carry no
 * recorded hand span, mark or trace from camera hands.
 */
async function verifyExport(glbPath: string, boneNode: (bone: string) => string | undefined) {
  const out: string[] = [];
  const document = await new NodeIO().read(glbPath);
  const root = document.getRoot();
  const travel = new Map<string, number>();
  let duration = 0;
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      const sampler = channel.getSampler()!;
      duration = Math.max(duration, sampler.getInput()!.getMax([0])[0]!);
      const node = channel.getTargetNode();
      if (channel.getTargetPath() !== 'rotation' || !node) continue;
      const values = sampler.getOutput()!.getArray()!;
      const first = new THREE.Quaternion(values[0], values[1], values[2], values[3]);
      let max = 0;
      for (let i = 4; i < values.length; i += 4) max = Math.max(max, first.angleTo(new THREE.Quaternion(values[i], values[i + 1], values[i + 2], values[i + 3])));
      travel.set(node.getName(), Math.max(travel.get(node.getName()) ?? 0, max / DEG));
    }
  }
  const moved = (bones: string[]): number => Math.max(0, ...bones.map((b) => travel.get(boneNode(b) ?? '') ?? 0));
  const arm = moved(['rightUpperArm', 'rightLowerArm', 'rightHand']);
  const finger = moved(['rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal', 'rightMiddleProximal', 'rightThumbProximal']);
  const head = moved(['head', 'neck']);
  if (arm < 20) out.push(`arm tracks moved ${round(arm, 1)}°, want >= 20°`);
  if (finger < 20) out.push(`finger tracks moved ${round(finger, 1)}°, want >= 20°`);
  if (head < 10) out.push(`head tracks moved ${round(head, 1)}°, want >= 10°`);
  const json = readGlbJson(await readFile(glbPath)) as { extensions?: Record<string, { version?: number; marks?: unknown[]; spans?: unknown[]; traces?: unknown[] } | undefined> };
  const meaning = json.extensions?.HOLOIM_meaning;
  const recordedSpans = (meaning?.spans ?? []).length;
  const marks = (meaning?.marks ?? []).length;
  const traces = (meaning?.traces ?? []).length;
  if (recordedSpans > 0) out.push(`HOLOIM_meaning carries ${recordedSpans} motion spans from camera hands`);
  if (marks > 0) out.push(`HOLOIM_meaning carries ${marks} pointing links from camera hands`);
  if (traces > 0) out.push(`HOLOIM_meaning carries ${traces} hand traces from camera hands`);
  return {
    failures: out,
    summary: { bytes: (await readFile(glbPath)).length, durationSec: round(duration), armTravelDeg: round(arm, 1), fingerTravelDeg: round(finger, 1), headTravelDeg: round(head, 1), meaning: meaning ? { version: meaning.version, spans: recordedSpans, marks, traces } : 'absent' }
  };
}
