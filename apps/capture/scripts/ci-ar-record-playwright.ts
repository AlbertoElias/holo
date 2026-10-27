import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Download, type Page } from 'playwright';
import * as THREE from 'three';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';
import { emulatePhone, phoneFingerDown, phoneFingerMove, phoneFingerUp, phoneHold, phoneScreenPoint, phoneTap, phoneTargetRayLost, phoneViewOffset, phoneViewerSpaceUnavailable, setHeadPose, type PhoneQuat as Quat, type PhoneVec3 as Vec3 } from '@holoim/tooling-testing/iwer-phone';

import type {} from '../src/runtime/automationHooks';
import type { PointResolutionReport } from '../src/recording/PointResolver';
import { TARGETS } from './lib/pointing-scene.ts';
import {
  assertCameraTake,
  compareNodePositions,
  comparePaths,
  inspectCameraTake,
  CAMERA_NODE_NAME as CAMERA_NODE,
  type CameraTakeReport,
  type MeaningLinkReport,
  type NodeComparison,
  type PathComparison
} from './lib/camera-take-glb.ts';

// Camera author mode (docs/features/archive/ar-recording.md, slice 2a): phone AR in
// IWER with the phone helper records a scripted camera walk and exports a
// camera take. Phases (each a fresh page; every phase also counts its
// downloads and fails on a stray or missing one):
//   phone-a           no query parameter beyond the scene (phone AR records camera takes by default: camera author, performer hidden, dock built), pointing-targets set and a bracket object placed on the desktop first.
//                     Record pressed while the set is still settling is refused. Then Record, a scripted
//                     walk, Recenter pressed mid-take (refused, the frame unchanged), Stop. Every scripted
//                     step must be covered by an exported sample within 1 cm and 1 degree.
//   phone-b           the same walk under a second placement: the take must not change (camera path over
//                     its whole duration, set nodes, the object's translation and rotation).
//   mic-denied        getUserMedia rejects: a silent take with the exact notice, no KHR_audio.
//   session-end       the XR session ends mid-take (with non-finite head poses in the middle of it): the
//                     take is exported, and the held microphone's tracks end without any frame advancing.
//   page-hidden       visibilitychange to hidden mid-take: the take is exported.
//   hidden-at-start   Record waits on the microphone, the page hides, the microphone arrives, the page
//                     shows again: no take starts, nothing downloads, Recenter is refused while it waits.
//   restored-at-start the same, but the page is shown again before the microphone arrives. Ends with a
//                     positive control: Recenter works again once nothing is busy.
//   ended-at-start    the XR session ends while Record waits on the microphone: no take, no live tracks.
//   empty-set         the default (empty) scene: Record is refused, nothing downloads.
//   quest-passthrough Quest 3 (world-space) AR: spectator; Record refused (twice), no take.
//   interaction-undefined  a phone whose interactionMode is undefined: treated like a headset.
//   marks-a/marks-b   slice 4, at a 412x915 portrait phone, the same prepared set and bracket, under two
//                     placements: Record by the dock, then with the head still: a one-frame tap on the bracket
//                     (no hold), a 1 s hold on the bracket, a 1 s hold on empty floor (a hold, no referent), a 1 s
//                     hold that begins on the dock's chip (no hold, no dock action), a drag of 100 apx that ends
//                     before the first simulation step and then stays still past the hold delay (no hold), a finger
//                     still at the screen centre while the head turns 4 degrees as it lands, judged after the hold
//                     delay (a hold, no referent), a finger still while its ray is unplaceable for four frames and the head
//                     turns 4 degrees (a hold, no referent), a 1 s hold that begins on the status chip with the bracket behind it (no hold), a 1 s hold on TargetA, and a
//                     1 s hold on TargetA while the head walks toward it and turns with the finger fixed on the
//                     screen; Stop by the dock. Exactly three recorded links from RecordedAuthorCamera
//                     (RecordedObject, TargetA, TargetA), spans starting at the touch, HOLOIM_meaning version 1,
//                     "no referent" in the resolver's report; to.point of the still holds agrees across the two
//                     placements within 1 cm. While a finger is down each XR frame is 100 ms of page time and the
//                     simulation steps by the same, as a phone's clock does, so the take is the same on any host.
//   marks-low-fps     B-032: the page draws about 4 frames a second on the realtime clock (take time is wall
//                     time), and each lift lands before the app's callback for its frame, as a browser delivers
//                     it. A 0.5 s and a 1 s hold on TargetA each make a link spanning the touch within a frame; a
//                     finger still past the delay that slides 100 apx in the frame it lifts in makes no hold, and
//                     one that stays on the glass while the phone turns 4 degrees in that frame still holds.
//   phone-dock        slice 3, at a 412x915 portrait phone: the bottom dock (Recenter, Record, Exit) laid
//                     out on the screen; Recenter between takes moves the set; Record and Stop by tap export
//                     a take; Exit by tap mid-take exports the second. Screenshots of the view between
//                     takes and while recording go to <artifactDir>/phone-dock-*.png.
//   dock-exit-idle    Exit by tap with no take ends the session; nothing downloads.
// The dock is driven by taps (phoneTap) at the buttons' world positions, read from the page's
// __samplePhoneChrome probe, in phone-a, phone-b, phone-dock and dock-exit-idle. The other phases press
// Record through __toggleRecording. Quest passthrough and a device with no interactionMode must have no dock at all.
// Clocks: after session entry every phase but marks-low-fps freezes the page clock (timers, animation frames,
// performance.now) and releases XR frames one at a time (FRAME_MS of page time each); the app runs its manual
// clock and steps only on advanceTime, without drawing (screenshots draw). Waits on real work (the microphone,
// the export, a download, a track ending) wait on that event, never a fixed sleep.
// How the path is compared: each walk step sets the head pose (in the set frame, converted to the room
// with the live world frame), waits for one XR frame, then advances the simulation by STEP_MS. The
// recorder samples the camera each simulated frame, so one pose is held for several samples. The script
// is a staircase (pose i holds from START + i * STEP to START + (i + 1) * STEP); START, the take time of
// the first step, is the offset with the most covered steps and then the smallest error (`alignmentSec`).
// A step is covered when a translation key inside its window matches within 1 cm AND a rotation key
// (rotation has its own times) inside its window matches within 1 degree.
// AR_RECORD_ONLY=<substring[,substring]> keeps matching phases; AR_RECORD_VIDEO_DIR=<dir> records phone-a
// on video at a watchable pace, and marks-low-fps as it runs. Writes output/ci-ar-record/<phase>.glb and ar-record-report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-ar-record';
const only = process.env.AR_RECORD_ONLY?.split(',');
const videoDir = process.env.AR_RECORD_VIDEO_DIR;

const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const OBJECT_URL = '/fixtures/objects/bracket.glb';
const VIEWPORT = { width: 640, height: 400 };
const PHONE_VIEWPORT = { width: 412, height: 915 };
/** A flat stand-in for the camera image behind the canvas in screenshots; IWER has no passthrough. */
const BACKDROP = 'linear-gradient(#5a5347, #3b362e)';
const STEP_MS = 100;
const STEP_SEC = STEP_MS / 1000;
const WALK_STEPS = 30;
const PATH_TOLERANCE_CM = 1;
const PATH_TOLERANCE_DEG = 1;
const FAKE_MIC_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const SILENT_NOTICE = 'No microphone: this take is silent.';
const SETTLE_NOTICE = 'Wait for the set to settle before recording.';
const RECENTER_NOTICE = 'Stop recording to recenter.';
const HEADSET_NOTICE = 'Only a phone records in AR; a headset in passthrough watches.';
const EMPTY_NOTICE = 'Nothing to record: no part of the set is near.';

const PHASES = [
  'phone-a',
  'phone-b',
  'marks-a',
  'marks-b',
  'marks-low-fps',
  'mic-denied',
  'session-end',
  'page-hidden',
  'hidden-at-start',
  'restored-at-start',
  'ended-at-start',
  'empty-set',
  'quest-passthrough',
  'interaction-undefined',
  'phone-dock',
  'dock-exit-idle'
] as const;
type Phase = (typeof PHASES)[number];

type ArState = {
  sessionMode: string | null;
  worldPosition: { x: number; y: number; z: number };
  cameraAuthor: boolean;
  spectator: boolean;
  performerHidden: boolean;
  placementSettled: boolean;
  interactionMode: string | null;
  recordingState: 'idle' | 'recording' | 'exporting';
  recordingMessage: string | null;
  notice: string | null;
  takeKind: string;
  cameraSamples: number;
  /** The camera take's running time: first to latest camera sample, seconds. */
  takeSec: number;
  /** The finger being tracked for a hold: none, pending (waiting out the delay), dead (a drag) or held. */
  screenHold: { phase: 'none' | 'pending' | 'dead' | 'held'; slopApx: number | null };
  /** Holds the take keeps in its point store. */
  screenHolds: { kept: number; undone: number };
  micPermission: string;
  micHeld: boolean;
};

/** `__samplePhoneChrome`: the dock's three one-glyph docks and the status line. */
type DockId = 'record' | 'recenter' | 'exit';
type DockProbe = {
  visible: boolean;
  metresPerApx: number;
  hitApx: number;
  glyphApx: number;
  buttons: Record<string, { worldPosition: Vec3; recording: boolean }>;
};
type PhoneProbe = {
  built: boolean;
  /** The dock's chip on the screen (CSS px from the top left), null while no control shows. */
  chip: { left: number; top: number; width: number; height: number } | null;
  viewport: { width: number; height: number; fovyDeg: number } | null;
  docks: Partial<Record<DockId, DockProbe>>;
  /** The status line's chip on the screen on a phone, once laid out. */
  statusLine: { visible: boolean; text: string; chip?: { left: number; top: number; width: number; height: number } | null } | null;
};

type StepCoverage = {
  alignmentSec: number;
  maxPositionCm: number;
  maxRotationDeg: number;
  stepsCovered: number;
  stepsMissing: number[];
  durationSec: number;
  scriptDurationSec: number;
};

type MarkScenario = {
  name: string;
  /** Take seconds at the touch's `selectstart` and `selectend`, read from the page. */
  downSec?: number;
  upSec?: number;
  /** Wall-clock milliseconds between them. */
  touchMs?: number;
  holdsBefore: number;
  holdsAfter: number;
  /** Where the tracked finger stood once the touch ended. */
  trackedAfter: string;
  [fact: string]: unknown;
};
type MarkFacts = {
  scenarios: MarkScenario[];
  links: MeaningLinkReport[];
  /** The resolver's report for the take, from the page. */
  resolution: unknown;
};

type PhaseReport = {
  phase: Phase;
  failures: string[];
  notes: Record<string, unknown>;
  ar: Record<string, ArState>;
  takes: Array<{ filename: string; bytes: number; glb: string }>;
  take?: CameraTakeReport;
  scriptVsExport?: StepCoverage;
  worldFrame?: number[];
  marks?: MarkFacts;
  /** Wall time the phase took (diagnostics only, never asserted). */
  seconds?: number;
};

type Run = { browser: Browser; consoleErrors: string[] };
type Pose = { position: Vec3; quaternion: Quat };

const round = (value: number, places = 2) => Number(value.toFixed(places));
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((value, k) => value === b[k]);

// --- The scripted walk, in the set frame ---

const quat = (yaw: number, pitch: number): Quat => {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  return [q.x, q.y, q.z, q.w];
};

/** Translation along an arc with a slow bob, yaw and pitch sweeping; `i` in [0, WALK_STEPS). */
function walkPose(i: number): Pose {
  const a = (i / (WALK_STEPS - 1)) * Math.PI * 0.8;
  return {
    position: [round(0.7 * Math.sin(a), 4), round(1.5 + 0.08 * Math.sin(2 * a), 4), round(0.9 - 0.5 * (1 - Math.cos(a)), 4)],
    quaternion: quat(0.6 * Math.sin(a), -0.2 * Math.sin(a))
  };
}

const toMatrix = (frame: number[]) => new THREE.Matrix4().fromArray(frame);

/** A set-frame pose in the room (what the IWER device is set to). */
function setToRoom(frame: THREE.Matrix4, pose: Pose): Pose {
  const world = new THREE.Vector3(...pose.position).applyMatrix4(frame);
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(frame)).multiply(new THREE.Quaternion(...pose.quaternion));
  return { position: [world.x, world.y, world.z], quaternion: [rotation.x, rotation.y, rotation.z, rotation.w] };
}

// --- Page plumbing ---

type OpenOptions = {
  phone?: boolean | 'interaction-unset';
  scene?: boolean;
  object?: boolean;
  micDenied?: boolean;
  /**
   * 'gate': getUserMedia waits on `window.__micGate` until `__openMicGate()`; 'track': it does not wait.
   * Both record the streams they hand out in `window.__mics`.
   */
  mic?: 'gate' | 'track';
  video?: boolean;
  viewport?: { width: number; height: number };
};

/** Every download a page made, in order. */
const downloadLog = new WeakMap<Page, string[]>();

async function openPage(run: Run, options: OpenOptions): Promise<Page> {
  const context = await createXrContext(run.browser, {
    viewport: options.viewport ?? VIEWPORT,
    acceptDownloads: true,
    ...(options.video && videoDir ? { recordVideo: { dir: videoDir, size: options.viewport ?? VIEWPORT } } : {})
  });
  await context.grantPermissions(['microphone']).catch(() => undefined);
  const page = await context.newPage();
  const downloads: string[] = [];
  downloadLog.set(page, downloads);
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  // tsx compiles with keepNames, which wraps named inner functions of the page.evaluate callbacks in a helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  wireXrConsoleErrors(page, run.consoleErrors);
  if (options.phone) await emulatePhone(page, options.phone === 'interaction-unset' ? { interactionMode: 'unset' } : {});
  if (options.micDenied) {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
  }
  if (options.mic) {
    await page.addInitScript((gated) => {
      const w = window as unknown as { __micGate: Promise<void>; __openMicGate: () => void; __mics: { calls: number; streams: MediaStream[] } };
      w.__mics = { calls: 0, streams: [] };
      w.__micGate = new Promise<void>((resolve) => {
        w.__openMicGate = resolve;
      });
      if (!gated) w.__openMicGate();
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        // The face driver's voice meter asks for the microphone on the desktop; it is not the recording's.
        // Told apart by its constraints: a built bundle minifies the VoiceLevel name out of stacks.
        const audio = constraints?.audio;
        if (typeof audio === 'object' && audio !== null && 'noiseSuppression' in audio) return real(constraints);
        w.__mics.calls += 1;
        await w.__micGate;
        const stream = await real(constraints);
        w.__mics.streams.push(stream);
        return stream;
      };
    }, options.mic === 'gate');
  }
  await attachXrEnvironment(page, { mode: 'iwer' });
  const url = new URL(baseUrl);
  url.searchParams.set('manualClock', '1');
  if (options.scene) {
    url.searchParams.set('scene', SCENE);
    url.searchParams.set('sceneScale', '1');
  }
  if (options.object) url.searchParams.set('object', OBJECT_URL);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__toggleRecording', '__arWorldFrame', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true));
  await waitForIwerRuntime(page);
  return page;
}

const arOf = (page: Page): Promise<ArState> => page.evaluate(() => JSON.parse(window.render_game_to_text()).ar as ArState);
const advance = (page: Page, ms: number) => page.evaluate((value) => window.advanceTime(value), ms);
const worldFrame = (page: Page) => page.evaluate(() => window.__arWorldFrame());
const toggle = (page: Page) => page.evaluate(() => window.__toggleRecording());

/**
 * Page time each released XR frame takes on a frozen page clock. The page's timers, animation frames and
 * `performance.now` (the hold delay, the touch log) run on that clock, so a phase's facts do not depend
 * on how fast the host composites the emulated frames.
 */
const FRAME_MS = 100;
/** Pages whose clock is frozen after session entry: every phase but marks-low-fps (B-032 runs in real time). */
const frozenPages = new WeakSet<Page>();

/** Releases one XR frame on a frozen page, or lets `ms` of page time pass (one frame, then timers due by then). */
async function releaseFrame(page: Page, ms = FRAME_MS): Promise<void> {
  await page.clock.fastForward(ms);
  // A round trip after the jump: page promises settled in the frame have reached this side.
  await page.evaluate(() => 0);
}

/**
 * Waits for a page promise that needs XR frames (a touch, a tap, a frame wait). On a frozen page this
 * releases frames one at a time until it settles, at most `maxFrames` (an Exit tap ends the session
 * mid-touch, and no further frame comes to finish it); otherwise it waits in real time.
 */
async function drive<T>(page: Page, pending: Promise<T>, maxFrames = 200): Promise<{ settled: boolean; frames: number }> {
  let settled = false;
  let failure: unknown;
  const watched = pending.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    }
  );
  if (!frozenPages.has(page)) {
    await watched;
    if (failure) throw failure;
    return { settled: true, frames: 0 };
  }
  let frames = 0;
  while (!settled && frames < maxFrames) {
    await releaseFrame(page);
    frames += 1;
  }
  if (failure) throw failure;
  return { settled, frames };
}

/** One XR frame; the simulation moves only on advanceTime. Real frames on a page in real time (emulated frames take about 150 ms). */
const nextXrFrame = async (page: Page): Promise<void> => {
  const frame = page.evaluate(() => new Promise<void>((resolve) => window.IWER_DEVICE!.activeSession!.requestAnimationFrame(() => resolve())));
  const { settled } = await drive(page, frame, 5);
  if (!settled) throw new Error('no XR frame came on the frozen page clock');
};

/** Page time passes with the simulation still: one frame on a frozen page clock, real time otherwise. */
const pageTimePasses = (page: Page, ms: number) => (frozenPages.has(page) ? releaseFrame(page, ms) : page.waitForTimeout(ms));

/**
 * Starts the AR session from the page's button with the head at `start` (the set is placed over the next frames).
 * Unless `realtime`, the page clock is then frozen and the app draws nothing on its frames (screenshots draw).
 */
async function enterSession(page: Page, start?: { position: Vec3; yaw: number }, realtime = false): Promise<void> {
  await page.evaluate(() => {
    window.IWER_DEVICE!.controlMode = 'programmatic';
  });
  await setHeadPose(page, start?.position ?? [0, 1.6, 0], quat(start?.yaw ?? 0, 0));
  await enterIwerSessionFromButton(page, '#ARButton', { readyCheck: "JSON.parse(window.render_game_to_text()).ar.sessionMode === 'ar'" });
  if (realtime) return;
  // Drawing every frame costs the most on a software-GL runner; only the video draws.
  await page.evaluate((draw) => window.__setManualClock(true, draw), Boolean(videoDir));
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  frozenPages.add(page);
}

/** Advances until the set's placement settles. */
async function settle(page: Page, expectSettled = true): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    if ((await arOf(page)).placementSettled) break;
  }
  if (expectSettled && !(await arOf(page)).placementSettled) throw new Error('placement never settled');
}

async function enterAr(page: Page, start?: { position: Vec3; yaw: number }, expectSettled = true, realtime = false): Promise<void> {
  await enterSession(page, start, realtime);
  await settle(page, expectSettled);
}

/**
 * Keeps the Recenter control's click handler, so it can be pressed while the dock hides it (a take
 * hides everything but Stop). Returns false when the control is not drawn.
 */
const captureRecenter = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const button = document.querySelector('[aria-label="Recenter AR"]') as (HTMLElement & Record<string, unknown>) | null;
    if (!button) return false;
    const key = Object.keys(button).find((name) => name.startsWith('__reactProps'));
    const onClick = key ? (button[key] as { onClick?: (event: object) => void }).onClick : undefined;
    if (!onClick) return false;
    (window as unknown as { __pressRecenter: () => void }).__pressRecenter = () =>
      onClick({ type: 'click', detail: 1, button: 0, currentTarget: button, target: button, preventDefault() {}, stopPropagation() {}, nativeEvent: {} });
    return true;
  });
const pressRecenter = (page: Page) => page.evaluate(() => (window as unknown as { __pressRecenter: () => void }).__pressRecenter());

// --- The phone dock ---

const phoneChrome = (page: Page): Promise<PhoneProbe> => page.evaluate(() => window.__samplePhoneChrome() as unknown as PhoneProbe);

/** The dock after a simulation step has laid it out and shown or hidden its buttons. */
async function dockState(page: Page): Promise<PhoneProbe> {
  await advance(page, STEP_MS);
  return phoneChrome(page);
}

/** What the dock shows, for the report. */
const dockSummary = (probe: PhoneProbe) => ({
  built: probe.built,
  shown: Object.fromEntries((['recenter', 'record', 'exit'] as const).map((id) => [id, probe.docks[id]?.visible ?? false])) as Record<DockId, boolean>,
  recordShape: probe.docks.record?.buttons.record?.recording ? 'stop' : 'record',
  statusLine: probe.statusLine?.text ?? ''
});

/** Failures for a dock that shows exactly `expected` (Exit is always shown once the dock is built). */
function dockFailures(label: string, probe: PhoneProbe, expected: Record<DockId, boolean>): string[] {
  if (!probe.built) return [`${label}: the phone dock is not built`];
  const shown = dockSummary(probe).shown;
  return (Object.keys(expected) as DockId[]).filter((id) => shown[id] !== expected[id]).map((id) => `${label}: ${id} is ${shown[id] ? 'shown' : 'hidden'}, expected ${expected[id] ? 'shown' : 'hidden'}`);
}

/**
 * Taps a dock button where it stands in the room now, with the head still. Throws when the button
 * is not shown, unless `hidden` says the tap is meant for a button that is not (nothing may happen).
 * Exit ends the session mid-tap, so the tap is not waited for past `endsSession`.
 */
async function tapDock(page: Page, id: DockId, options: { hidden?: boolean; endsSession?: boolean } = {}): Promise<void> {
  // Two real frames: the XR camera, and the dock hung on it, have taken the head's latest pose.
  await nextXrFrame(page);
  await nextXrFrame(page);
  const dock = (await phoneChrome(page)).docks[id];
  if (!dock) throw new Error(`the ${id} dock is not built`);
  if (!dock.visible && !options.hidden) throw new Error(`the ${id} dock is not shown`);
  const tap = phoneTap(page, dock.buttons[id]!.worldPosition);
  if (options.endsSession && !frozenPages.has(page)) await Promise.race([tap.catch(() => undefined), page.waitForTimeout(4000)]);
  else if (options.endsSession) await drive(page, tap.catch(() => undefined), 6);
  else await drive(page, tap);
}

/** Where each dock button's centre lands on the screen (CSS px), from the head pose last set and the XR view's fov. */
async function dockOnScreen(page: Page, probe: PhoneProbe): Promise<Record<DockId, { x: number; y: number }>> {
  const head = await page.evaluate(() => {
    const { position: p, quaternion: q } = window.IWER_DEVICE!;
    return { p: [p.x, p.y, p.z] as Vec3, q: [q.x, q.y, q.z, q.w] as Quat };
  });
  const position = new THREE.Vector3(...head.p);
  const inverse = new THREE.Quaternion(...head.q).invert();
  const { width, height, fovyDeg } = probe.viewport!;
  const tan = Math.tan((fovyDeg * Math.PI) / 360);
  const screen = {} as Record<DockId, { x: number; y: number }>;
  for (const id of ['recenter', 'record', 'exit'] as const) {
    const local = new THREE.Vector3(...probe.docks[id]!.buttons[id]!.worldPosition).sub(position).applyQuaternion(inverse);
    const ndcX = local.x / (-local.z * tan * (width / height));
    const ndcY = local.y / (-local.z * tan);
    screen[id] = { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height };
  }
  return screen;
}

/**
 * Prepares the page to be photographed as a phone shows it: the DOM overlay is not there in phone AR
 * (no dom-overlay), and IWER has no camera image, so a flat stand-in sits behind the canvas.
 */
async function showCanvasOnly(page: Page): Promise<void> {
  await page.addStyleTag({ content: `html, body { background: ${BACKDROP} !important; } body * { visibility: hidden !important; background: transparent !important; } body canvas { visibility: visible !important; }` });
}

async function screenshot(page: Page, name: string, report: PhaseReport): Promise<void> {
  // Two frames and a step, drawn: the latest pose and chrome state are on the canvas.
  await page.evaluate(() => window.__setManualClock(true, true));
  await nextXrFrame(page);
  await advance(page, STEP_MS);
  await nextXrFrame(page);
  await nextXrFrame(page);
  const file = path.join(artifactDir, name);
  await page.screenshot({ path: file });
  if (frozenPages.has(page)) await page.evaluate((draw) => window.__setManualClock(true, draw), Boolean(videoDir));
  const shots = (report.notes.screenshots ??= []) as string[];
  shots.push(file);
}

/** A session that is not a camera author has no phone dock: nothing built, nothing to tap. */
async function noDockFailures(page: Page): Promise<string[]> {
  const probe = await dockState(page);
  return probe.built || Object.keys(probe.docks).length > 0 || probe.statusLine ? [`a phone dock exists in a session that is not a camera author (${JSON.stringify(dockSummary(probe))})`] : [];
}

/** Record by a tap on the dock. */
async function startRecordingByDock(page: Page): Promise<void> {
  await tapDock(page, 'record');
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).ar.recordingState === 'recording', null, { timeout: 20000 });
  await advance(page, STEP_MS);
}

async function startRecording(page: Page): Promise<void> {
  await toggle(page);
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).ar.recordingState === 'recording', null, { timeout: 20000 });
  await advance(page, STEP_MS);
}

async function saveDownload(download: Download, phase: string, report: PhaseReport): Promise<string> {
  const glb = path.join(artifactDir, `${phase}.glb`);
  await copyFile(await download.path(), glb);
  report.takes.push({ filename: download.suggestedFilename(), bytes: (await readFile(glb)).length, glb });
  return glb;
}

/**
 * Waits for a download while advancing the simulation and the page clock, so the async export can finish:
 * it also waits on real work (the microphone's recorder, the GLB encode), so each step ends when the download
 * arrives or after a short real wait. On a frozen page the export's own 60 s timeout stays far off (at most
 * 20 s of page time).
 */
async function advanceUntilDownload(page: Page, download: Promise<Download | null>, seconds = 20): Promise<Download | null> {
  let result: Download | null | undefined;
  void download.then((value) => {
    result = value;
  });
  const realWaitMs = frozenPages.has(page) ? 50 : 200;
  for (let i = 0; i < seconds * 5 && result === undefined; i += 1) {
    await advance(page, STEP_MS).catch(() => undefined);
    if (frozenPages.has(page)) await releaseFrame(page, 200);
    await Promise.race([download, new Promise((resolve) => setTimeout(resolve, realWaitMs))]);
  }
  // On a frozen page a slow export takes more real time, not more page time.
  if (result === undefined && frozenPages.has(page)) result = await download;
  return result ?? null;
}

const expectDownload = (page: Page, timeout: number) => page.waitForEvent('download', { timeout }).catch(() => null);

/** Lets any stray second download arrive, then checks the phase made exactly `expected`. */
async function expectDownloadCount(page: Page, report: PhaseReport, expected: number): Promise<void> {
  const frozen = frozenPages.has(page);
  for (let i = 0; i < 10; i += 1) {
    await advance(page, STEP_MS).catch(() => undefined);
    if (frozen) await releaseFrame(page).catch(() => undefined);
    else await page.waitForTimeout(150);
  }
  if (frozen) {
    // An export still running finishes on real work; then a download it starts reaches this side within a moment.
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).ar.recordingState !== 'exporting', null, { timeout: 30000, polling: 50 }).catch(() => undefined);
    await page.waitForEvent('download', { timeout: 300 }).catch(() => undefined);
  }
  const names = downloadLog.get(page) ?? [];
  report.notes.downloads = names;
  if (names.length !== expected) report.failures.push(`${names.length} download(s) [${names.join(', ')}], expected ${expected}`);
}

async function walk(page: Page, frame: THREE.Matrix4, pace: number, between?: (step: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < WALK_STEPS; i += 1) {
    const room = setToRoom(frame, walkPose(i));
    await setHeadPose(page, room.position, room.quaternion);
    await nextXrFrame(page);
    await between?.(i);
    await advance(page, STEP_MS);
    if (pace > 0) await page.waitForTimeout(pace);
  }
}

// --- Comparing the export with the script ---

/** The script as a staircase against the export: every step must be covered, over a take of the script's length. */
function alignScript(report: CameraTakeReport): StepCoverage {
  const translation = report.camera?.path.translation;
  const rotation = report.camera?.path.rotation;
  const scriptDurationSec = (WALK_STEPS + 2) * STEP_SEC;
  const empty: StepCoverage = { alignmentSec: NaN, maxPositionCm: Infinity, maxRotationDeg: Infinity, stepsCovered: 0, stepsMissing: [], durationSec: report.camera?.durationSec ?? 0, scriptDurationSec };
  if (!translation || !rotation) return empty;
  const stepOf = (time: number, start: number) => Math.floor((time - start) / STEP_SEC + 1e-6);
  const positionErrorCm = (step: number, row: number[]) => Math.hypot(...walkPose(step).position.map((v, j) => v - row[j]!)) * 100;
  const rotationErrorDeg = (step: number, row: number[]) => {
    const dot = Math.abs(walkPose(step).quaternion.reduce((sum, v, j) => sum + v * row[j]!, 0)) / (Math.hypot(...row) || 1);
    return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
  };
  const evaluate = (start: number): StepCoverage => {
    const positionOk = new Set<number>();
    const rotationOk = new Set<number>();
    let maxPositionCm = 0;
    let maxRotationDeg = 0;
    translation.times.forEach((time, k) => {
      const step = stepOf(time, start);
      if (step < 0 || step >= WALK_STEPS) return;
      const error = positionErrorCm(step, translation.values[k]!);
      maxPositionCm = Math.max(maxPositionCm, error);
      if (error <= PATH_TOLERANCE_CM) positionOk.add(step);
    });
    // Rotation is read at its own key times and indices, not translation's.
    rotation.times.forEach((time, k) => {
      const step = stepOf(time, start);
      if (step < 0 || step >= WALK_STEPS) return;
      const error = rotationErrorDeg(step, rotation.values[k]!);
      maxRotationDeg = Math.max(maxRotationDeg, error);
      if (error <= PATH_TOLERANCE_DEG) rotationOk.add(step);
    });
    const stepsMissing = Array.from({ length: WALK_STEPS }, (_, step) => step).filter((step) => !(positionOk.has(step) && rotationOk.has(step)));
    return { alignmentSec: round(start, 4), maxPositionCm: round(maxPositionCm), maxRotationDeg: round(maxRotationDeg), stepsCovered: WALK_STEPS - stepsMissing.length, stepsMissing, durationSec: empty.durationSec, scriptDurationSec };
  };
  let best = empty;
  const last = Math.max(translation.times.at(-1) ?? 0, rotation.times.at(-1) ?? 0);
  for (let start = 0; start <= last; start += 0.005) {
    const candidate = evaluate(start);
    const better = candidate.stepsCovered > best.stepsCovered || (candidate.stepsCovered === best.stepsCovered && candidate.maxPositionCm + candidate.maxRotationDeg < best.maxPositionCm + best.maxRotationDeg);
    if (better) best = candidate;
  }
  return best;
}

function checkTake(report: PhaseReport, glb: Buffer, options: { audio: boolean | 'any' }): CameraTakeReport {
  const take = inspectCameraTake(glb);
  report.take = take;
  for (const failure of assertCameraTake(take)) report.failures.push(failure);
  if (options.audio === true && (!take.khrAudio || take.audio.sources < 1 || take.audio.payloadBytes <= 0)) {
    report.failures.push(`KHR_audio does not carry audio although the microphone was granted (${take.audio.sources} source(s), ${take.audio.payloadBytes} bytes)`);
  }
  if (options.audio === false && take.khrAudio) report.failures.push('KHR_audio present although the microphone was denied');
  return take;
}

// --- Phases ---

type Walked = { report: PhaseReport; take: CameraTakeReport | null; frame: number[] };

/** phone-a and phone-b: enter, Record, the scripted walk, Stop, read the GLB. */
async function walkPhase(run: Run, phase: 'phone-a' | 'phone-b', start: { position: Vec3; yaw: number }): Promise<Walked> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true, object: true, video: phase === 'phone-a' });
  const pace = phase === 'phone-a' && videoDir ? 500 : 0;
  try {
    const placement = await placeObjectOnDesktop(page);
    report.notes.objectPlacedOnDesktop = placement;
    if (!placement.placed) report.failures.push('the prepared object was not placed on the desktop before AR');
    await enterSession(page, start);

    // Record while the set is still settling is refused. A placement counts as settled until its first frame, so one step runs first.
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    const early = await arOf(page);
    report.ar.entering = early;
    if (early.placementSettled) {
      report.failures.push('the set was already settled on entry; the settling refusal could not be checked');
    } else {
      await toggle(page);
      await pageTimePasses(page, 150);
      const refused = await arOf(page);
      report.ar.settlingRefused = refused;
      if (refused.notice !== SETTLE_NOTICE) report.failures.push(`Record while settling: notice ${JSON.stringify(refused.notice)}, expected ${JSON.stringify(SETTLE_NOTICE)}`);
      if (refused.recordingState !== 'idle') report.failures.push(`Record while settling left recordingState ${refused.recordingState}`);
      // The dock does not offer Record yet (Exit, and Recenter, between takes, are there).
      const settling = await dockState(page);
      report.notes.dockWhileSettling = dockSummary(settling);
      report.failures.push(...dockFailures('while settling', settling, { record: false, recenter: true, exit: true }));
    }
    await settle(page);
    const settled = await dockState(page);
    report.notes.dockSettled = dockSummary(settled);
    report.failures.push(...dockFailures('after settling', settled, { record: true, recenter: true, exit: true }));

    const frameValues = await worldFrame(page);
    report.worldFrame = frameValues.map((value) => round(value, 4));
    const frame = toMatrix(frameValues);
    report.ar.entered = await arOf(page);
    const ar = report.ar.entered;
    if (!ar.cameraAuthor) report.failures.push('camera author mode is off in a phone AR session');
    if (!ar.performerHidden) report.failures.push('performer visible in camera mode');
    if (ar.interactionMode !== 'screen-space') report.failures.push(`interactionMode ${ar.interactionMode}, expected screen-space`);
    if (!(await captureRecenter(page))) report.failures.push('the Recenter control is not drawn in phone AR');
    if (pace) await page.waitForTimeout(1500);

    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await startRecordingByDock(page);
    report.ar.recording = await arOf(page);
    if (report.ar.recording.takeKind !== 'camera') report.failures.push(`take kind ${report.ar.recording.takeKind}, expected camera`);
    // A take hides Recenter (Record is Stop, Exit stays); a tap where Recenter was does nothing.
    const recordingDock = await dockState(page);
    report.notes.dockWhileRecording = dockSummary(recordingDock);
    report.failures.push(...dockFailures('while recording', recordingDock, { record: true, recenter: false, exit: false }));
    if (dockSummary(recordingDock).recordShape !== 'stop') report.failures.push('Record is not the stop shape while recording');
    await tapDock(page, 'recenter', { hidden: true });
    const hiddenTapped = await arOf(page);
    if (hiddenTapped.notice === RECENTER_NOTICE || hiddenTapped.recordingState !== 'recording') report.failures.push(`a tap on the hidden Recenter did something (notice ${JSON.stringify(hiddenTapped.notice)}, ${hiddenTapped.recordingState})`);
    if (!same(await worldFrame(page), frameValues)) report.failures.push('the set moved when the hidden Recenter was tapped mid-take');
    await tapDock(page, 'exit', { hidden: true, endsSession: true });
    const exitTapped = await arOf(page);
    if (exitTapped.sessionMode !== 'ar' || exitTapped.recordingState !== 'recording') report.failures.push(`a tap on the hidden Exit did something (${exitTapped.sessionMode}, ${exitTapped.recordingState})`);
    // Recenter in the middle of the take is refused: no notice-less success, and the set does not move.
    await walk(page, frame, pace, async (step) => {
      if (step !== 10) return;
      await pressRecenter(page);
      const after = await arOf(page);
      report.ar.recenterMidTake = after;
      if (after.notice !== RECENTER_NOTICE) report.failures.push(`Recenter mid-take: notice ${JSON.stringify(after.notice)}, expected ${JSON.stringify(RECENTER_NOTICE)}`);
      if (after.recordingState !== 'recording') report.failures.push(`Recenter mid-take left recordingState ${after.recordingState}`);
      if (!same(await worldFrame(page), frameValues)) report.failures.push('the set moved when Recenter was pressed mid-take');
    });
    // Hold the last pose one more step so the final step has samples.
    await advance(page, STEP_MS);
    report.ar.walked = await arOf(page);
    const walkedDock = await phoneChrome(page);
    report.notes.statusWhileRecording = walkedDock.statusLine?.text ?? null;
    if (!/^Recording 0:0[1-9]/.test(walkedDock.statusLine?.text ?? '')) report.failures.push(`status line ${JSON.stringify(walkedDock.statusLine?.text)} while recording, expected "Recording 0:0n"`);

    const download = expectDownload(page, 30000);
    await tapDock(page, 'record');
    const saved = await advanceUntilDownload(page, download);
    report.ar.stopped = await arOf(page);
    if (!saved) {
      report.failures.push('no GLB downloaded after Stop');
      return { report, take: null, frame: frameValues };
    }
    const glb = await saveDownload(saved, phase, report);
    if (!saved.suggestedFilename().startsWith('camera-recording-')) report.failures.push(`filename ${saved.suggestedFilename()} is not a camera-recording-*`);
    const take = checkTake(report, await readFile(glb), { audio: true });
    const coverage = alignScript(take);
    report.scriptVsExport = coverage;
    if (coverage.stepsCovered < WALK_STEPS) report.failures.push(`only ${coverage.stepsCovered} of ${WALK_STEPS} scripted steps are covered by exported samples (missing ${coverage.stepsMissing.join(', ')})`);
    if (!(coverage.maxPositionCm <= PATH_TOLERANCE_CM)) report.failures.push(`camera path off the script by ${coverage.maxPositionCm} cm (limit ${PATH_TOLERANCE_CM})`);
    if (!(coverage.maxRotationDeg <= PATH_TOLERANCE_DEG)) report.failures.push(`camera path off the script by ${coverage.maxRotationDeg} deg (limit ${PATH_TOLERANCE_DEG})`);
    if (Math.abs(coverage.durationSec - coverage.scriptDurationSec) > STEP_SEC) report.failures.push(`take lasts ${coverage.durationSec} s, the script ${coverage.scriptDurationSec} s (limit one step)`);
    const xs = take.camera!.path.translation?.values.map((row) => row[0]!) ?? [0];
    report.notes.cameraSpanXMeters = round(Math.max(...xs) - Math.min(...xs));
    if ((report.notes.cameraSpanXMeters as number) < 0.3) report.failures.push('the exported camera barely moved; the walk was not recorded');
    if (take.objects.length !== 1) report.failures.push(`${take.objects.length} event objects in the take, expected the one placed before AR`);
    for (const object of take.objects) {
      const t = object.channels.translation;
      const r = object.channels.rotation;
      if (!t || !r) {
        report.failures.push(`object ${object.name} has no translation/rotation channels`);
      } else {
        // Nothing moves it, so it must stand still in the set frame.
        const span = (track: { values: number[][] }, k: number) => Math.max(...track.values.map((row) => row[k]!)) - Math.min(...track.values.map((row) => row[k]!));
        const driftCm = Math.max(span(t, 0), span(t, 1), span(t, 2)) * 100;
        report.notes.objectDriftCm = round(driftCm);
        report.notes.objectPositionInSet = t.values[0]!.map((v) => round(v, 3));
        if (driftCm > PATH_TOLERANCE_CM) report.failures.push(`object ${object.name} moved ${round(driftCm)} cm in the set frame`);
      }
    }
    await expectDownloadCount(page, report, 1);
    // Between takes again: Recenter is back, and Record is the record shape.
    const afterDock = await dockState(page);
    report.notes.dockAfterStop = dockSummary(afterDock);
    report.failures.push(...dockFailures('after Stop', afterDock, { record: true, recenter: true, exit: true }));
    if (dockSummary(afterDock).recordShape !== 'record') report.failures.push('Record is still the stop shape after the take');
    if (pace) await page.waitForTimeout(1500);
    return { report, take, frame: frameValues };
  } finally {
    await page.context().close();
  }
}

/** Steps the desktop simulation until the prepared object is placed in front of the avatar (a camera author cannot place one). */
async function placeObjectOnDesktop(page: Page): Promise<{ id: string; placed: boolean; steps: number }> {
  for (let steps = 0; steps < 120; steps += 1) {
    const item = await page.evaluate(() => JSON.parse(window.render_game_to_text()).objects.items[0] as { id?: string; placed: boolean } | undefined);
    if (item?.placed) return { id: item.id ?? '', placed: true, steps };
    await advance(page, STEP_MS);
  }
  return { id: '', placed: false, steps: 120 };
}

type ObjectComparison = { name: string; positionCm: number; rotationDeg: number };
type Comparison = { cameraPath: PathComparison; setNodes: NodeComparison; objects: ObjectComparison[]; worldFrameDeltaM: number; worldFrameDeltaDeg: number; durationDeltaSec: number };

function compareTakes(a: Walked, b: Walked): { comparison: Comparison; failures: string[] } {
  const failures: string[] = [];
  const ta = a.take!;
  const tb = b.take!;
  const frameA = toMatrix(a.frame);
  const frameB = toMatrix(b.frame);
  const deltaM = new THREE.Vector3().setFromMatrixPosition(frameA).distanceTo(new THREE.Vector3().setFromMatrixPosition(frameB));
  const deltaDeg = THREE.MathUtils.radToDeg(new THREE.Quaternion().setFromRotationMatrix(frameA).angleTo(new THREE.Quaternion().setFromRotationMatrix(frameB)));
  const cameraPath = comparePaths(ta.camera!.path, tb.camera!.path);
  const setNodes = compareNodePositions(ta.setNodes, tb.setNodes);
  const durationDeltaSec = round(Math.abs(ta.camera!.durationSec - tb.camera!.durationSec), 6);
  const objects: ObjectComparison[] = ta.objects.map((object, index) => {
    const other = tb.objects[index];
    const [ta1, ra1, tb1, rb1] = [object.channels.translation, object.channels.rotation, other?.channels.translation, other?.channels.rotation];
    if (!ta1 || !ra1 || !tb1 || !rb1) return { name: object.name, positionCm: Infinity, rotationDeg: Infinity };
    const compared = comparePaths({ translation: ta1, rotation: ra1 }, { translation: tb1, rotation: rb1 });
    return { name: object.name, positionCm: compared.maxPositionCm, rotationDeg: compared.maxRotationDeg };
  });
  if (!(deltaM > 0.5 || deltaDeg > 20)) failures.push(`the two placements are too alike (${round(deltaM)} m, ${round(deltaDeg)} deg); the cross-placement check proves nothing`);
  if (!(cameraPath.maxPositionCm <= PATH_TOLERANCE_CM)) failures.push(`camera path differs across placements by ${cameraPath.maxPositionCm} cm`);
  if (!(cameraPath.maxRotationDeg <= PATH_TOLERANCE_DEG)) failures.push(`camera path differs across placements by ${cameraPath.maxRotationDeg} deg`);
  // The comparison runs over the paths' common time range, so a truncated path must also fail on its extent.
  if (!(durationDeltaSec <= STEP_SEC)) failures.push(`the takes' durations differ by ${durationDeltaSec} s (limit one step)`);
  if (!(cameraPath.endDeltaSec <= STEP_SEC) || !(cameraPath.startDeltaSec <= STEP_SEC)) failures.push(`the camera paths cover different time ranges (start ${cameraPath.startDeltaSec} s, end ${cameraPath.endDeltaSec} s apart)`);
  if (ta.camera!.translationKeys !== tb.camera!.translationKeys || ta.camera!.rotationKeys !== tb.camera!.rotationKeys) {
    failures.push(`camera key counts differ across placements (${ta.camera!.translationKeys}/${ta.camera!.rotationKeys} vs ${tb.camera!.translationKeys}/${tb.camera!.rotationKeys})`);
  }
  if (!(setNodes.maxCm <= PATH_TOLERANCE_CM)) failures.push(`set nodes differ across placements by ${setNodes.maxCm} cm`);
  if (setNodes.onlyInA.length > 0 || setNodes.onlyInB.length > 0) failures.push(`set nodes only in one take: ${[...setNodes.onlyInA, ...setNodes.onlyInB].join(', ')}`);
  if (ta.objects.length !== tb.objects.length) failures.push(`object counts differ across placements (${ta.objects.length} vs ${tb.objects.length})`);
  for (const object of objects) {
    if (!(object.positionCm <= PATH_TOLERANCE_CM)) failures.push(`object ${object.name} differs across placements by ${object.positionCm} cm`);
    if (!(object.rotationDeg <= PATH_TOLERANCE_DEG)) failures.push(`object ${object.name} differs across placements by ${object.rotationDeg} deg`);
  }
  return { comparison: { cameraPath, setNodes, objects, worldFrameDeltaM: round(deltaM), worldFrameDeltaDeg: round(deltaDeg), durationDeltaSec }, failures };
}

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
const show = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });

type MicCount = { calls: number; streams: number; tracks: number; liveTracks: number };
const micCount = (page: Page): Promise<MicCount> =>
  page.evaluate(() => {
    const mics = (window as unknown as { __mics: { calls: number; streams: MediaStream[] } }).__mics;
    const tracks = mics.streams.flatMap((stream) => stream.getAudioTracks());
    return { calls: mics.calls, streams: mics.streams.length, tracks: tracks.length, liveTracks: tracks.filter((track) => track.readyState === 'live').length };
  });

/**
 * Opens the gate the held microphone request waits behind, then waits (in real time, without frames) until every
 * pending request has its stream: getUserMedia resolves on real work, not on the page clock.
 */
async function openMicGate(page: Page, report: PhaseReport): Promise<void> {
  await page.evaluate(() => (window as unknown as { __openMicGate: () => void }).__openMicGate());
  try {
    await page.waitForFunction(() => {
      const mics = (window as unknown as { __mics: { calls: number; streams: MediaStream[] } }).__mics;
      return mics.streams.length >= mics.calls;
    }, null, { timeout: 10000, polling: 20 });
  } catch {
    report.failures.push(`the microphone never arrived after its gate opened (${JSON.stringify(await micCount(page))})`);
  }
}

/** Takes that end mid-take: mic-denied (Stop), session-end and page-hidden. */
async function interruptPhase(run: Run, phase: 'mic-denied' | 'session-end' | 'page-hidden'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true, micDenied: phase === 'mic-denied', ...(phase === 'session-end' ? { mic: 'track' as const } : {}) });
  try {
    await enterAr(page);
    const frame = toMatrix(await worldFrame(page));
    report.ar.entered = await arOf(page);
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await startRecording(page);
    report.ar.recording = await arOf(page);
    const notices = new Set<string>();
    const noteMessages = async () => {
      const state = await arOf(page);
      for (const text of [state.notice, state.recordingMessage]) if (text) notices.add(text);
    };
    await noteMessages();
    for (let i = 0; i < 12; i += 1) {
      const room = setToRoom(frame, walkPose(i));
      // Non-finite poses (tracking lost) in the middle of the take must be skipped, never written.
      const lost = phase === 'session-end' && i >= 4 && i <= 6;
      await setHeadPose(page, lost ? [NaN, NaN, NaN] : room.position, room.quaternion);
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }
    await noteMessages();
    const download = expectDownload(page, 30000);
    if (phase === 'session-end') {
      await page.evaluate(() => window.IWER_DEVICE!.activeSession!.end());
      // No frame arrives after the session ends (the page clock stands still): the held microphone must be released
      // by the event itself. Track ends are real events, so this polls in real time for up to 4 s.
      let ended = false;
      for (const deadline = Date.now() + 4000; !ended && Date.now() < deadline; ) {
        const mics = await micCount(page);
        ended = mics.tracks > 0 && mics.liveTracks === 0 && !(await arOf(page)).micHeld;
        report.notes.micAfterEnd = mics;
        if (!ended) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!ended) report.failures.push('the held microphone was still live after the session ended, with no frame advancing');
    } else if (phase === 'page-hidden') {
      await hide(page);
    } else {
      await toggle(page);
    }
    const saved = await advanceUntilDownload(page, download);
    await noteMessages();
    report.ar.after = await arOf(page).catch(() => report.ar.recording!);
    report.notes.messages = [...notices];
    if (!saved) {
      report.failures.push(`no GLB downloaded after ${phase}`);
      return report;
    }
    const glb = await saveDownload(saved, phase, report);
    if (!saved.suggestedFilename().startsWith('camera-recording-')) report.failures.push(`filename ${saved.suggestedFilename()} is not a camera-recording-*`);
    const take = checkTake(report, await readFile(glb), { audio: phase === 'mic-denied' ? false : phase === 'session-end' || phase === 'page-hidden' ? true : 'any' });
    if (phase === 'mic-denied') {
      if (report.ar.recording.micPermission !== 'denied' && report.ar.after.micPermission !== 'denied') report.failures.push(`micPermission ${report.ar.after.micPermission}, expected denied`);
      if (!notices.has(SILENT_NOTICE)) report.failures.push(`notice ${JSON.stringify(SILENT_NOTICE)} never shown (saw ${JSON.stringify([...notices])})`);
    }
    if (phase === 'session-end') {
      const keys = [take.camera!.path.translation, take.camera!.path.rotation];
      report.notes.cameraKeys = keys.map((track) => track?.times.length ?? 0);
    }
    report.notes.khrAudio = take.khrAudio;
    await expectDownloadCount(page, report, 1);
    return report;
  } finally {
    await page.context().close();
  }
}

/**
 * Record waits on the microphone, then the start is cancelled (the page hides, hides and returns,
 * or the session ends) before it resolves: no take begins and nothing downloads.
 */
async function abortAtStartPhase(run: Run, phase: 'hidden-at-start' | 'restored-at-start' | 'ended-at-start'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true, mic: 'gate' });
  try {
    // The AR entry holds the microphone; its request stays pending behind the gate, so Record's start waits on it.
    await enterAr(page);
    report.ar.entered = await arOf(page);
    if (!(await captureRecenter(page))) report.failures.push('the Recenter control is not drawn in phone AR');
    const frameValues = await worldFrame(page);
    const frame = toMatrix(frameValues);
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    const states = new Set<string>();
    const watch = async () => states.add((await arOf(page)).recordingState);
    await toggle(page);
    await pageTimePasses(page, 300);
    report.ar.pending = await arOf(page);
    states.add(report.ar.pending.recordingState);
    if (report.ar.pending.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.pending.recordingState} while the microphone was still pending, expected idle`);
    // Recenter while the start is pending is refused too.
    await pressRecenter(page);
    const recentered = await arOf(page);
    report.ar.recenterWhilePending = recentered;
    if (recentered.notice !== RECENTER_NOTICE) report.failures.push(`Recenter while a start was pending: notice ${JSON.stringify(recentered.notice)}, expected ${JSON.stringify(RECENTER_NOTICE)}`);
    for (let i = 0; i < 4; i += 1) {
      await advance(page, STEP_MS);
      await pageTimePasses(page, 100);
    }
    if (!same(await worldFrame(page), frameValues)) report.failures.push('the set moved when Recenter was pressed while a start was pending');

    if (phase === 'hidden-at-start') {
      // The page hides, the microphone arrives while hidden, then the page shows again.
      await hide(page);
      await pageTimePasses(page, 1500);
      await openMicGate(page, report);
      for (let i = 0; i < 10; i += 1) {
        await advance(page, STEP_MS);
        await pageTimePasses(page, 150);
        await watch();
      }
      report.ar.hiddenAfterGrant = await arOf(page);
      await show(page);
    } else if (phase === 'restored-at-start') {
      // The page hides and shows again before the microphone arrives: the start is still cancelled.
      await hide(page);
      await pageTimePasses(page, 500);
      await show(page);
      await pageTimePasses(page, 500);
      await openMicGate(page, report);
    } else {
      await page.evaluate(() => window.IWER_DEVICE!.activeSession!.end());
      await pageTimePasses(page, 500);
      await openMicGate(page, report);
    }
    for (let i = 0; i < 20; i += 1) {
      await advance(page, STEP_MS);
      await pageTimePasses(page, 150);
      await watch();
    }
    report.ar.after = await arOf(page);
    report.notes.statesSeen = [...states];
    if (states.has('recording') || states.has('exporting')) report.failures.push(`recordingState passed through ${[...states].join(', ')}; no take should have begun`);
    if (report.ar.after.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.after.recordingState} at the end, expected idle`);
    if (report.ar.after.cameraSamples !== 0) report.failures.push(`${report.ar.after.cameraSamples} camera samples recorded for a take that never began`);
    const mics = await micCount(page);
    report.notes.mic = mics;
    // Two calls are expected: the page's startup permission check (its stream is released at once) and the entry hold, which Record's start shares.
    if (mics.calls > 2) report.failures.push(`${mics.calls} getUserMedia calls; the entry hold and Record should share one request`);
    if (phase === 'ended-at-start') {
      if (mics.liveTracks > 0) report.failures.push(`${mics.liveTracks} live microphone track(s) left after the session ended`);
      if (report.ar.after.micHeld) report.failures.push('micHeld is still true after the session ended');
    } else if (mics.liveTracks > 1) {
      report.failures.push(`${mics.liveTracks} live microphone tracks left; only the session's held one may remain`);
    }
    if (phase === 'restored-at-start') {
      // Positive control: with nothing busy, Recenter works (the refusals above are not a dead button).
      const room = setToRoom(frame, { position: [0.8, 1.5, 0.2], quaternion: quat(0, 0) });
      await setHeadPose(page, room.position, room.quaternion);
      await nextXrFrame(page);
      await pressRecenter(page);
      await settle(page, false);
      const moved = toMatrix(await worldFrame(page));
      const delta = new THREE.Vector3().setFromMatrixPosition(moved).distanceTo(new THREE.Vector3().setFromMatrixPosition(frame));
      report.notes.recenterWhenIdleMovedM = round(delta);
      if (delta < 0.3) report.failures.push(`Recenter did not move the set when nothing was busy (${round(delta)} m)`);
    }
    await expectDownloadCount(page, report, 0);
    return report;
  } finally {
    await page.context().close();
  }
}

async function emptySetPhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'empty-set', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: false });
  try {
    await enterAr(page, undefined, false);
    report.ar.entered = await arOf(page);
    if (!report.ar.entered.cameraAuthor) report.failures.push('camera author mode is off in a phone AR session');
    await toggle(page);
    // The notice shows for 4 s of wall-clock time: read it as soon as it is up, not after a fixed wait that a slow machine outlasts.
    for (let i = 0; i < 12; i += 1) {
      await advance(page, STEP_MS);
      await pageTimePasses(page, 100);
      report.ar.after = await arOf(page);
      if (report.ar.after.notice) break;
    }
    if (!report.ar.after) throw new Error('the page was never read');
    if (report.ar.after.recordingState !== 'idle') report.failures.push(`recordingState ${report.ar.after.recordingState} after a refused Record`);
    if (report.ar.after.notice !== EMPTY_NOTICE) report.failures.push(`notice ${JSON.stringify(report.ar.after.notice)}, expected ${JSON.stringify(EMPTY_NOTICE)}`);
    await expectDownloadCount(page, report, 0);
    return report;
  } finally {
    await page.context().close();
  }
}

/** A non-phone AR session (Quest passthrough, or a device with no interactionMode): Record is refused. */
async function headsetPhase(run: Run, phase: 'quest-passthrough' | 'interaction-undefined'): Promise<PhaseReport> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: phase === 'interaction-undefined' ? 'interaction-unset' : false, scene: true });
  try {
    await enterAr(page);
    const ar = await arOf(page);
    report.ar.entered = ar;
    if (ar.cameraAuthor) report.failures.push('camera author mode on');
    if (!ar.spectator) report.failures.push('not a spectator in AR');
    if (ar.performerHidden) report.failures.push('performer hidden in a spectator session');
    if (ar.micHeld) report.failures.push('microphone held open in a spectator session');
    report.failures.push(...(await noDockFailures(page)));
    const expectedMode = phase === 'quest-passthrough' ? 'world-space' : null;
    if (ar.interactionMode !== expectedMode) report.failures.push(`interactionMode ${ar.interactionMode}, expected ${expectedMode}`);
    for (const press of ['first', 'second'] as const) {
      await toggle(page);
      for (let i = 0; i < 8; i += 1) {
        await advance(page, STEP_MS);
        await pageTimePasses(page, 150);
      }
      const after = await arOf(page);
      report.ar[`${press}Record`] = after;
      if (after.recordingState !== 'idle') report.failures.push(`${press} Record: recordingState ${after.recordingState}, expected idle`);
      if (press === 'first' && after.notice !== HEADSET_NOTICE) report.failures.push(`${press} Record: notice ${JSON.stringify(after.notice)}, expected ${JSON.stringify(HEADSET_NOTICE)}`);
      if (after.takeKind === 'camera' || after.cameraSamples > 0) report.failures.push(`${press} Record: a camera take began (kind ${after.takeKind}, ${after.cameraSamples} samples)`);
    }
    await expectDownloadCount(page, report, 0);
    return report;
  } finally {
    await page.context().close();
  }
}

/**
 * The phone dock at a 412x915 portrait phone (slice 3): its layout on the screen, Recenter between
 * takes, only Stop while recording (Recenter and Exit hidden and inert), Record and Stop by tap, and
 * two screenshots of the view: between takes and while recording.
 */
async function dockPhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'phone-dock', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true, viewport: PHONE_VIEWPORT });
  try {
    await enterAr(page);
    report.ar.entered = await arOf(page);
    let frameValues = await worldFrame(page);

    // Layout: Record in the middle of the bottom edge, Recenter and Exit a glyph pitch (hit area + 12 apx) either side.
    const between = await dockState(page);
    report.notes.dockBetweenTakes = dockSummary(between);
    report.failures.push(...dockFailures('between takes', between, { record: true, recenter: true, exit: true }));
    if (!between.built) return report;
    const screen = await dockOnScreen(page, between);
    const metrics = Object.fromEntries((['recenter', 'record', 'exit'] as const).map((id) => [id, { hitApx: between.docks[id]!.hitApx, glyphApx: between.docks[id]!.glyphApx, screenCssPx: { x: round(screen[id].x, 1), y: round(screen[id].y, 1) } }]));
    report.notes.dockLayout = { viewport: between.viewport, ...metrics };
    const { width, height } = PHONE_VIEWPORT;
    const pitch = between.docks.record!.hitApx + 12;
    const near = (a: number, b: number, what: string) => {
      if (Math.abs(a - b) > 1) report.failures.push(`dock layout: ${what} ${round(a, 1)}, expected ${round(b, 1)}`);
    };
    near(screen.record.x, width / 2, 'Record x');
    near(screen.recenter.x, width / 2 - pitch, 'Recenter x');
    near(screen.exit.x, width / 2 + pitch, 'Exit x');
    near(screen.recenter.y, screen.record.y, 'Recenter y');
    near(screen.exit.y, screen.record.y, 'Exit y');
    if (screen.record.y < height * 0.85 || screen.record.y > height) report.failures.push(`dock layout: the dock is at y ${round(screen.record.y, 1)} of ${height}, expected the bottom 15%`);
    if (between.docks.record!.glyphApx !== 36 || between.docks.exit!.glyphApx !== 16 || between.docks.recenter!.glyphApx !== 16) report.failures.push('dock layout: glyphs are not the ring at 36 apx and icons at 16 apx');
    if ((['recenter', 'record', 'exit'] as const).some((id) => between.docks[id]!.hitApx < 44)) report.failures.push('dock layout: a hit area is under 44 apx');
    await showCanvasOnly(page);
    await screenshot(page, 'phone-dock-between-takes.png', report);

    // Recenter between takes moves the set to where the phone now looks.
    const moved = setToRoom(toMatrix(frameValues), { position: [0.8, 1.5, 0.2], quaternion: quat(0.5, 0) });
    await setHeadPose(page, moved.position, moved.quaternion);
    await nextXrFrame(page);
    await tapDock(page, 'recenter');
    await settle(page, false);
    const recentered = await worldFrame(page);
    const delta = new THREE.Vector3().setFromMatrixPosition(toMatrix(recentered)).distanceTo(new THREE.Vector3().setFromMatrixPosition(toMatrix(frameValues)));
    report.notes.recenterByDockMovedM = round(delta);
    if (delta < 0.3) report.failures.push(`Recenter by the dock did not move the set (${round(delta)} m)`);
    frameValues = recentered;
    const frame = toMatrix(frameValues);

    // The take: Record by tap. While it runs only Stop shows; a tap where Recenter or Exit were does nothing.
    const first = setToRoom(frame, walkPose(0));
    await setHeadPose(page, first.position, first.quaternion);
    await nextXrFrame(page);
    await startRecordingByDock(page);
    const recording = await dockState(page);
    report.notes.dockWhileRecording = dockSummary(recording);
    report.failures.push(...dockFailures('while recording', recording, { record: true, recenter: false, exit: false }));
    for (const id of ['exit', 'recenter'] as const) {
      await tapDock(page, id, { hidden: true, endsSession: id === 'exit' });
      const tapped = await arOf(page);
      if (tapped.sessionMode !== 'ar' || tapped.recordingState !== 'recording' || tapped.notice === RECENTER_NOTICE) report.failures.push(`a tap on the hidden ${id} did something (${tapped.sessionMode}, ${tapped.recordingState}, ${JSON.stringify(tapped.notice)})`);
    }
    if (!same(await worldFrame(page), frameValues)) report.failures.push('the set moved while recording');
    for (let i = 0; i < 14; i += 1) {
      const room = setToRoom(frame, walkPose(i));
      await setHeadPose(page, room.position, room.quaternion);
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }
    const walked = await dockState(page);
    report.notes.dockWalked = dockSummary(walked);
    if (dockSummary(walked).recordShape !== 'stop') report.failures.push('Record is not the stop shape while recording');
    if (!/^Recording 0:0[1-9]/.test(walked.statusLine?.text ?? '')) report.failures.push(`status line ${JSON.stringify(walked.statusLine?.text)} while recording, expected "Recording 0:0n"`);
    await screenshot(page, 'phone-dock-recording.png', report);

    // Stop by tap exports exactly one take, and the dock is whole again.
    const stopped = expectDownload(page, 30000);
    await tapDock(page, 'record');
    const saved = await advanceUntilDownload(page, stopped);
    if (!saved) {
      report.failures.push('no GLB downloaded after Stop by the dock');
      return report;
    }
    checkTake(report, await readFile(await saveDownload(saved, 'phone-dock-take', report)), { audio: true });
    await expectDownloadCount(page, report, 1);
    const betweenAgain = await dockState(page);
    report.notes.dockAfterStop = dockSummary(betweenAgain);
    report.failures.push(...dockFailures('after Stop', betweenAgain, { record: true, recenter: true, exit: true }));
    return report;
  } finally {
    await page.context().close();
  }
}

/** Exit by tap with no take running: the session ends, nothing downloads. */
async function dockExitIdlePhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'dock-exit-idle', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true });
  try {
    await enterAr(page);
    report.ar.entered = await arOf(page);
    await tapDock(page, 'exit', { endsSession: true });
    for (let i = 0; i < 5; i += 1) await advance(page, STEP_MS);
    const ended = await arOf(page);
    report.ar.afterExit = ended;
    if (ended.sessionMode !== 'none') report.failures.push(`sessionMode ${ended.sessionMode} after Exit`);
    if (await page.evaluate(() => window.IWER_DEVICE!.activeSession !== null && window.IWER_DEVICE!.activeSession !== undefined)) report.failures.push('the XR session is still active after Exit');
    if ((await phoneChrome(page)).built) report.failures.push('the phone dock is still built after Exit');
    if (ended.micHeld) report.failures.push('the held microphone outlived the session');
    await expectDownloadCount(page, report, 0);
    return report;
  } finally {
    await page.context().close();
  }
}

// --- Marks: fingers held on the screen (slice 4) ---

const MARK_HOLD_MS = 1000;
/** A hold begins at the touch: its span starts within this of the touch's `selectstart`, in take seconds. */
const MARK_START_TOLERANCE_SEC = 0.05;
/** The most a hold's end may trail the finger lifting, in take seconds: one emulated frame (about 150 ms) and a step. */
const MARK_END_TOLERANCE_SEC = 0.3;
/** A tap must stay under the 300 ms hold delay; a host whose emulated frames are slower cannot show it. */
const TAP_LIMIT_MS = 270;
const MARK_POINT_TOLERANCE_CM = 1;

type TouchLog = Array<{ type: 'selectstart' | 'selectend'; takeSec: number; wall: number }>;

/** Logs every touch's start and end with the take's running time, from inside the page. */
const watchTouches = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __touchLog: TouchLog };
    w.__touchLog = [];
    for (const type of ['selectstart', 'selectend'] as const) {
      window.IWER_DEVICE!.activeSession!.addEventListener(type, () => {
        w.__touchLog.push({ type, takeSec: JSON.parse(window.render_game_to_text()).ar.takeSec, wall: performance.now() });
      });
    }
  });
const touchLog = (page: Page) => page.evaluate(() => (window as unknown as { __touchLog: TouchLog }).__touchLog);

/** The camera orientation that looks from `eye` toward `target` (three's lookAt: -Z toward the target, Y up). */
function lookQuat(eye: Vec3, target: Vec3): Quat {
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...eye), new THREE.Vector3(...target), new THREE.Vector3(0, 1, 0));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w];
}

/**
 * Runs `touch` while the simulation advances beside it (the manual clock steps only when asked, and a
 * hold is judged at steps), optionally moving the head as the touch proceeds (`progress` in [0, 1] over
 * the hold's length). On the frozen page clock each XR frame is {@link FRAME_MS} of page time and the
 * simulation steps by the same, as a phone's clock runs: take time is page time, the hold delay and the
 * touch's length are counted on it, and the number of frames and steps is the same on every host.
 */
async function stepWhile(page: Page, touch: Promise<void>, move?: (progress: number) => Promise<void>): Promise<void> {
  if (!frozenPages.has(page)) throw new Error('stepWhile needs the frozen page clock');
  let done = false;
  let failure: unknown;
  const finished = touch.then(
    () => {
      done = true;
    },
    (error: unknown) => {
      done = true;
      failure = error;
    }
  );
  let elapsedMs = 0;
  for (let frames = 0; !done; frames += 1) {
    if (frames > 200) throw new Error('a touch did not finish within 200 frames');
    if (move) await move(Math.min(1, elapsedMs / MARK_HOLD_MS));
    await releaseFrame(page);
    // The step runs after the frame (a round trip), so a touch that ended in this frame is seen as done below.
    await advance(page, FRAME_MS);
    elapsedMs += FRAME_MS;
  }
  await finished;
  if (failure) throw failure;
}

/** One touch of the take, with what the page and the point store made of it. */
async function touchScenario(
  page: Page,
  report: PhaseReport,
  scenarios: MarkScenario[],
  name: string,
  touch: () => Promise<void>,
  expectedNewHolds: number,
  move?: (progress: number) => Promise<void>
): Promise<MarkScenario> {
  const before = await arOf(page);
  const logFrom = (await touchLog(page)).length;
  await stepWhile(page, touch(), move);
  for (let i = 0; i < 3; i += 1) await advance(page, STEP_MS);
  const after = await arOf(page);
  const log = (await touchLog(page)).slice(logFrom);
  const down = log.find((entry) => entry.type === 'selectstart');
  const up = log.find((entry) => entry.type === 'selectend');
  const scenario: MarkScenario = {
    name,
    ...(down ? { downSec: round(down.takeSec, 3) } : {}),
    ...(up ? { upSec: round(up.takeSec, 3) } : {}),
    ...(down && up ? { touchMs: Math.round(up.wall - down.wall) } : {}),
    holdsBefore: before.screenHolds.kept,
    holdsAfter: after.screenHolds.kept,
    trackedAfter: after.screenHold.phase
  };
  scenarios.push(scenario);
  if (!down || !up) report.failures.push(`${name}: the touch left no selectstart/selectend in the page`);
  const added = after.screenHolds.kept - before.screenHolds.kept;
  if (added !== expectedNewHolds) report.failures.push(`${name}: the take kept ${added} new hold(s), expected ${expectedNewHolds}`);
  if (after.screenHold.phase !== 'none') report.failures.push(`${name}: a finger is still tracked after the touch (${after.screenHold.phase})`);
  // None of these touches is a dock action: the take runs on, the session stays, nothing downloads.
  if (after.recordingState !== 'recording' || after.sessionMode !== 'ar') report.failures.push(`${name}: the touch changed the take or the session (${after.recordingState}, ${after.sessionMode})`);
  if ((downloadLog.get(page) ?? []).length > 0) report.failures.push(`${name}: a download began during the take`);
  return scenario;
}

/** The screen distance a finger moves in the early-drag scenario: well past the 22 apx slop. */
const EARLY_DRAG_APX = 100;

/**
 * A finger goes down, moves `EARLY_DRAG_APX` and stays still beyond the hold delay, all before the
 * simulation steps once; then it steps. The finger left its touchdown spot before the first step saw it,
 * so it is a drag: no hold, nothing in the take.
 */
async function earlyDragScenario(page: Page, report: PhaseReport, scenarios: MarkScenario[], from: Vec3, to: Vec3): Promise<void> {
  const name = 'early-drag';
  const before = await arOf(page);
  await drive(page, phoneFingerDown(page, from));
  await drive(page, phoneFingerMove(page, to));
  await drive(page, phoneFingerMove(page, to));
  await pageTimePasses(page, 400);
  const stepped: ArState[] = [];
  for (let i = 0; i < 3; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    stepped.push(await arOf(page));
  }
  const during = stepped[stepped.length - 1]!;
  await drive(page, phoneFingerUp(page));
  for (let i = 0; i < 3; i += 1) await advance(page, STEP_MS);
  const after = await arOf(page);
  scenarios.push({
    name,
    holdsBefore: before.screenHolds.kept,
    holdsAfter: after.screenHolds.kept,
    trackedAfter: after.screenHold.phase,
    phaseWhileDown: during.screenHold.phase,
    slopWhileDownApx: during.screenHold.slopApx
  });
  if (during.screenHold.phase !== 'dead') report.failures.push(`${name}: the finger moved ${EARLY_DRAG_APX} apx before the first step and the tracked phase is ${during.screenHold.phase}, expected dead`);
  if (stepped.some((facts) => facts.screenHold.phase === 'held') || after.screenHolds.kept !== before.screenHolds.kept) report.failures.push(`${name}: the take kept ${after.screenHolds.kept - before.screenHolds.kept} new hold(s), expected none`);
  if (after.screenHold.phase !== 'none') report.failures.push(`${name}: a finger is still tracked after the touch (${after.screenHold.phase})`);
}

/** How far the head turns between the last frame before touchdown and touchdown: 4 degrees is about 32 apx on the phone viewport, past the 22 apx slop. */
const TURN_AT_TOUCHDOWN_DEG = 4;

/**
 * A finger lands at the centre of the screen as the head turns {@link TURN_AT_TOUCHDOWN_DEG} degrees
 * between the app's last camera update and the touch event; the finger does not move on the glass and the
 * first simulation step comes after the hold delay. The turn is the phone's, not the finger's: the touch
 * must become a hold. (A baseline taken from the app's older camera reads the turn as about 32 apx of drag.)
 */
async function turnAtTouchdownScenario(page: Page, report: PhaseReport, scenarios: MarkScenario[], head: Pose): Promise<void> {
  const name = 'turn-at-touchdown';
  const before = await arOf(page);
  const centre = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2, PHONE_VIEWPORT.height / 2, 1.5);
  const turned = new THREE.Quaternion(...head.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (TURN_AT_TOUCHDOWN_DEG * Math.PI) / 180));
  await drive(page, phoneFingerDown(page, centre, { headPose: { position: head.position, quaternion: [turned.x, turned.y, turned.z, turned.w] } }));
  await pageTimePasses(page, 400);
  const stepped: ArState[] = [];
  for (let i = 0; i < 3; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    stepped.push(await arOf(page));
  }
  const during = stepped[stepped.length - 1]!;
  await drive(page, phoneFingerUp(page));
  for (let i = 0; i < 3; i += 1) await advance(page, STEP_MS);
  const after = await arOf(page);
  scenarios.push({
    name,
    holdsBefore: before.screenHolds.kept,
    holdsAfter: after.screenHolds.kept,
    trackedAfter: after.screenHold.phase,
    phaseWhileDown: during.screenHold.phase,
    slopWhileDownApx: during.screenHold.slopApx
  });
  if (during.screenHold.phase !== 'held') report.failures.push(`${name}: the finger stayed at the screen centre while the head turned ${TURN_AT_TOUCHDOWN_DEG} degrees at touchdown and the tracked phase is ${during.screenHold.phase} (slop ${during.screenHold.slopApx} apx), expected held`);
  if (after.screenHolds.kept !== before.screenHolds.kept + 1) report.failures.push(`${name}: the take kept ${after.screenHolds.kept - before.screenHolds.kept} new hold(s), expected 1`);
  if (after.screenHold.phase !== 'none') report.failures.push(`${name}: a finger is still tracked after the touch (${after.screenHold.phase})`);
  await setHeadPose(page, head.position, head.quaternion);
  await nextXrFrame(page);
  await advance(page, STEP_MS);
}

/**
 * The finger lands and stays still; the runtime cannot place the finger's ray for four frames while the head turns {@link TURN_AT_TOUCHDOWN_DEG} degrees (the viewer pose is fine). The
 * frames without the finger are skipped, never read as the stale ray against that frame's viewer (about
 * 32 apx of drag); once the ray returns the finger is where it was, and past the hold delay it is a hold.
 */
async function targetRayLostScenario(page: Page, report: PhaseReport, scenarios: MarkScenario[], head: Pose): Promise<void> {
  const name = 'target-ray-lost-while-turning';
  const before = await arOf(page);
  const centre = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2, PHONE_VIEWPORT.height / 2, 1.5);
  await drive(page, phoneFingerDown(page, centre));
  // The hold delay is wall time, and a slow machine could latch the hold before the ray is lost and make the
  // check vacuous: the first step after the touchdown is therefore a lost one.
  const turned = new THREE.Quaternion(...head.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (TURN_AT_TOUCHDOWN_DEG * Math.PI) / 180));
  await phoneTargetRayLost(page, true);
  await setHeadPose(page, head.position, [turned.x, turned.y, turned.z, turned.w]);
  const lostSteps: ArState[] = [];
  for (let i = 0; i < 4; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    lostSteps.push(await arOf(page));
  }
  await phoneTargetRayLost(page, false);
  await pageTimePasses(page, 400);
  const stepped: ArState[] = [];
  for (let i = 0; i < 3; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    stepped.push(await arOf(page));
  }
  const during = stepped[stepped.length - 1]!;
  await drive(page, phoneFingerUp(page));
  for (let i = 0; i < 3; i += 1) await advance(page, STEP_MS);
  const after = await arOf(page);
  scenarios.push({
    name,
    holdsBefore: before.screenHolds.kept,
    holdsAfter: after.screenHolds.kept,
    trackedAfter: after.screenHold.phase,
    phaseWhileDown: during.screenHold.phase,
    slopWhileDownApx: during.screenHold.slopApx
  });
  const notPending = lostSteps.find((facts) => facts.screenHold.phase !== 'pending');
  if (notPending) report.failures.push(`${name}: a step without the finger's pose left the tracked phase ${notPending.screenHold.phase} (slop ${notPending.screenHold.slopApx} apx), expected pending${notPending.screenHold.phase === 'dead' ? ': the stale ray was compared with that frame\'s viewer' : ''}`);
  if (during.screenHold.phase !== 'held') report.failures.push(`${name}: the finger stayed still while its ray was lost for several frames and the head turned ${TURN_AT_TOUCHDOWN_DEG} degrees, and the tracked phase is ${during.screenHold.phase} (slop ${during.screenHold.slopApx} apx), expected held`);
  if (after.screenHolds.kept !== before.screenHolds.kept + 1) report.failures.push(`${name}: the take kept ${after.screenHolds.kept - before.screenHolds.kept} new hold(s), expected 1`);
  if (after.screenHold.phase !== 'none') report.failures.push(`${name}: a finger is still tracked after the touch (${after.screenHold.phase})`);
  await setHeadPose(page, head.position, head.quaternion);
  await nextXrFrame(page);
  await advance(page, STEP_MS);
}

/** How far every view is turned against the viewer in the view-offset scenario: 3 degrees is about 24 apx on the phone viewport, past the 22 apx slop. */
const VIEW_OFFSET_DEG = 3;

/** One finger put down at `from`, moved to `to` if given, left still past the hold delay, stepped three times, lifted. */
async function fingerThroughSteps(page: Page, from: Vec3, to?: Vec3): Promise<{ before: ArState; during: ArState; stepped: ArState[]; after: ArState }> {
  const before = await arOf(page);
  await drive(page, phoneFingerDown(page, from));
  if (to) {
    await drive(page, phoneFingerMove(page, to));
    await drive(page, phoneFingerMove(page, to));
  }
  await pageTimePasses(page, 400);
  const stepped: ArState[] = [];
  for (let i = 0; i < 3; i += 1) {
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    stepped.push(await arOf(page));
  }
  const during = stepped[stepped.length - 1]!;
  await drive(page, phoneFingerUp(page));
  for (let i = 0; i < 3; i += 1) await advance(page, STEP_MS);
  return { before, during, stepped, after: await arOf(page) };
}

/**
 * A finger lands at the centre of the screen and stays still, with every XR view turned
 * {@link VIEW_OFFSET_DEG} degrees against the viewer (the spec lets a runtime place a view so): the render
 * camera and the viewer point different ways. The finger's ray is the viewer's, so it has not moved on the
 * glass and must become a hold. (A baseline turned back to world with the render camera's orientation reads
 * the offset as about 24 apx of drag.)
 */
async function viewOffsetScenario(page: Page, report: PhaseReport, scenarios: MarkScenario[]): Promise<void> {
  const name = 'view-offset-stationary';
  await phoneViewOffset(page, VIEW_OFFSET_DEG);
  await nextXrFrame(page);
  const centre = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2, PHONE_VIEWPORT.height / 2, 1.5);
  const { before, during, after } = await fingerThroughSteps(page, centre);
  await phoneViewOffset(page, 0);
  await nextXrFrame(page);
  await advance(page, STEP_MS);
  scenarios.push({
    name,
    holdsBefore: before.screenHolds.kept,
    holdsAfter: after.screenHolds.kept,
    trackedAfter: after.screenHold.phase,
    phaseWhileDown: during.screenHold.phase,
    slopWhileDownApx: during.screenHold.slopApx
  });
  if (during.screenHold.phase !== 'held') report.failures.push(`${name}: the finger stayed still with the views turned ${VIEW_OFFSET_DEG} degrees against the viewer and the tracked phase is ${during.screenHold.phase} (slop ${during.screenHold.slopApx} apx), expected held`);
  if (after.screenHolds.kept !== before.screenHolds.kept + 1) report.failures.push(`${name}: the take kept ${after.screenHolds.kept - before.screenHolds.kept} new hold(s), expected 1`);
  if (after.screenHold.phase !== 'none') report.failures.push(`${name}: a finger is still tracked after the touch (${after.screenHold.phase})`);
}

/**
 * Touches while the touch has no viewer-frame baseline (the viewer space gives no pose against the finger's
 * ray, as when it never resolved). The slop is then the distance between the touchdown and current world
 * rays: a still finger on a still head is a hold, and a finger that moves {@link EARLY_DRAG_APX} before the
 * first step is a drag. Never the older render camera standing in for the viewer.
 */
async function noViewerBaselineScenarios(page: Page, report: PhaseReport, scenarios: MarkScenario[], from: Vec3, to: Vec3): Promise<void> {
  await phoneViewerSpaceUnavailable(page, true);
  const still = await fingerThroughSteps(page, from);
  const drag = await fingerThroughSteps(page, from, to);
  await phoneViewerSpaceUnavailable(page, false);
  for (const [name, run, expected] of [
    ['no-viewer-baseline-stationary', still, 'held'],
    ['no-viewer-baseline-early-drag', drag, 'dead']
  ] as const) {
    scenarios.push({
      name,
      holdsBefore: run.before.screenHolds.kept,
      holdsAfter: run.after.screenHolds.kept,
      trackedAfter: run.after.screenHold.phase,
      phaseWhileDown: run.during.screenHold.phase,
      slopWhileDownApx: run.during.screenHold.slopApx
    });
    if (run.during.screenHold.phase !== expected) report.failures.push(`${name}: the tracked phase is ${run.during.screenHold.phase} (slop ${run.during.screenHold.slopApx} apx), expected ${expected}`);
    const added = run.after.screenHolds.kept - run.before.screenHolds.kept;
    if (added !== (expected === 'held' ? 1 : 0)) report.failures.push(`${name}: the take kept ${added} new hold(s), expected ${expected === 'held' ? 1 : 0}`);
    if (run.after.screenHold.phase !== 'none') report.failures.push(`${name}: a finger is still tracked after the touch (${run.after.screenHold.phase})`);
  }
}

type Marked = { report: PhaseReport; take: CameraTakeReport | null; links: MeaningLinkReport[]; targetAWorld: Vec3 | null };

/**
 * Hold to mark from the camera, under one placement: Record by the dock, then with the head still a
 * tap, holds on the bracket, on empty floor, from the dock's chip and on TargetA, and a hold on TargetA
 * while the head walks toward it and turns with the finger fixed on the screen. Stop by the dock; the
 * links in the export are the facts.
 */
async function marksPhase(run: Run, phase: 'marks-a' | 'marks-b', start: { position: Vec3; yaw: number }): Promise<Marked> {
  const report: PhaseReport = { phase, failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true, object: true, viewport: PHONE_VIEWPORT });
  const scenarios: MarkScenario[] = [];
  try {
    const placement = await placeObjectOnDesktop(page);
    if (!placement.placed) report.failures.push('the prepared object was not placed on the desktop before AR');
    await enterAr(page, start);
    const frame = toMatrix(await worldFrame(page));
    report.worldFrame = frame.toArray().map((value) => round(value, 4));
    report.ar.entered = await arOf(page);
    const room = (point: Vec3): Vec3 => {
      const v = new THREE.Vector3(...point).applyMatrix4(frame);
      return [v.x, v.y, v.z];
    };
    // Where to aim, in the room as placed: the bracket's centre (the object is in the set, so it moved with it).
    const item = await page.evaluate(() => JSON.parse(window.render_game_to_text()).objects.items[0] as { boundsMin: Vec3; boundsMax: Vec3 });
    const bracket = item.boundsMin.map((value, k) => (value + item.boundsMax[k]!) / 2) as Vec3;
    const targetA = room(TARGETS.TargetA!.center);
    const floor = room([0.7, 0, -0.4]);
    report.notes.aim = { bracketInRoom: bracket.map((v) => round(v, 3)), targetAInRoom: targetA.map((v) => round(v, 3)), floorInRoom: floor.map((v) => round(v, 3)) };

    const eye: Vec3 = [0, 1.5, 0.6];
    const standing = setToRoom(frame, { position: eye, quaternion: lookQuat(eye, [0, 1.5, -1.5]) });
    await setHeadPose(page, standing.position, standing.quaternion);
    await nextXrFrame(page);
    // The dock hangs on the camera in a simulation step: one step, so it stands where this head is.
    await advance(page, STEP_MS);
    await startRecordingByDock(page);
    await watchTouches(page);
    for (let i = 0; i < 3; i += 1) {
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }

    // A one-frame tap never marks: it ends before the 300 ms hold delay.
    const tap = await touchScenario(page, report, scenarios, 'tap-on-bracket', () => phoneTap(page, bracket), 0);
    if ((tap.touchMs ?? Infinity) > TAP_LIMIT_MS) report.failures.push(`tap-on-bracket: the tap lasted ${tap.touchMs} ms; emulated frames are too slow to show a tap under the 300 ms hold delay`);

    await touchScenario(page, report, scenarios, 'hold-on-bracket', () => phoneHold(page, bracket, MARK_HOLD_MS), 1);
    // Floor where the set has none: a hold the take keeps, with nothing to name.
    await touchScenario(page, report, scenarios, 'hold-on-empty-floor', () => phoneHold(page, floor, MARK_HOLD_MS), 1);

    // A hold that begins on the dock: the chip around Record, beside the ring's hit area.
    const dock = await dockState(page);
    report.notes.dockWhileHolding = dockSummary(dock);
    if (!dock.chip) {
      report.failures.push('the dock reports no chip while recording');
    } else {
      const chipPoint = await phoneScreenPoint(page, dock.chip.left + dock.chip.width - 8, dock.chip.top + dock.chip.height / 2, 1);
      report.notes.chip = dock.chip;
      await touchScenario(page, report, scenarios, 'hold-on-dock-chip', () => phoneHold(page, chipPoint, MARK_HOLD_MS), 0);
    }

    // A drag that is over before the simulation takes its first step, then still past the hold delay: a drag, never a hold.
    const dragFrom = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2, PHONE_VIEWPORT.height / 2, 1.5);
    const dragTo = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2 + EARLY_DRAG_APX, PHONE_VIEWPORT.height / 2, 1.5);
    await earlyDragScenario(page, report, scenarios, dragFrom, dragTo);
    // A finger that stays put while the head turns as it lands is a hold.
    await turnAtTouchdownScenario(page, report, scenarios, standing);
    // A finger whose ray the runtime cannot place for some frames, while the head turns, is skipped on those frames.
    await targetRayLostScenario(page, report, scenarios, standing);
    // The views turned against the viewer, and a touch with no viewer-frame baseline.
    await viewOffsetScenario(page, report, scenarios);
    await noViewerBaselineScenarios(page, report, scenarios, dragFrom, dragTo);

    // A hold that begins on the status chip with the bracket behind it: the chip is chrome and does nothing.
    const status = (await dockState(page)).statusLine?.chip;
    if (!status || !dock.viewport) {
      report.failures.push('the status line reports no chip while recording');
    } else {
      report.notes.statusChip = status;
      const cx = status.left + status.width / 2;
      const cy = status.top + status.height / 2;
      // Turn the head so the ray through the chip's centre passes through the bracket.
      const tan = Math.tan((dock.viewport.fovyDeg * Math.PI) / 360);
      const toChip = new THREE.Vector3(((cx / dock.viewport.width) * 2 - 1) * tan * (dock.viewport.width / dock.viewport.height), (1 - (cy / dock.viewport.height) * 2) * tan, -1).normalize();
      const aimed = new THREE.Quaternion(...lookQuat(standing.position, bracket)).multiply(new THREE.Quaternion().setFromUnitVectors(toChip, new THREE.Vector3(0, 0, -1)));
      await setHeadPose(page, standing.position, [aimed.x, aimed.y, aimed.z, aimed.w]);
      await nextXrFrame(page);
      await advance(page, STEP_MS);
      const chipPoint = await phoneScreenPoint(page, cx, cy, 1);
      const behind = new THREE.Vector3(...chipPoint).sub(new THREE.Vector3(...standing.position)).angleTo(new THREE.Vector3(...bracket).sub(new THREE.Vector3(...standing.position)));
      report.notes.statusChipRayToBracketDeg = round((behind * 180) / Math.PI, 3);
      if (behind > (1 * Math.PI) / 180) report.failures.push(`the ray through the status chip misses the bracket by ${round((behind * 180) / Math.PI, 2)} degrees; the scenario does not test a hold with an object behind the chip`);
      await touchScenario(page, report, scenarios, 'hold-on-status-chip', () => phoneHold(page, chipPoint, MARK_HOLD_MS), 0);
      await setHeadPose(page, standing.position, standing.quaternion);
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }

    await touchScenario(page, report, scenarios, 'hold-on-target-a', () => phoneHold(page, targetA, MARK_HOLD_MS), 1);

    // The finger stays on the screen while the head walks 0.3 m toward TargetA and turns 8 degrees: the
    // ray sweeps 8 degrees across the target, 64 px of the world's direction but none on the screen.
    const walkEye = (progress: number): Pose => {
      const position: Vec3 = [TARGETS.TargetA!.center[0], TARGETS.TargetA!.center[1], -1.2 - 0.3 * progress];
      return setToRoom(frame, { position, quaternion: quat((8 * Math.PI / 180) * progress, 0) });
    };
    const walkStart = walkEye(0);
    await setHeadPose(page, walkStart.position, walkStart.quaternion);
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    await touchScenario(
      page,
      report,
      scenarios,
      'hold-on-target-a-walking',
      () => phoneHold(page, targetA, MARK_HOLD_MS, { screenLocked: true }),
      1,
      async (progress) => {
        const pose = walkEye(progress);
        await setHeadPose(page, pose.position, pose.quaternion);
      }
    );

    // Stop by the dock, then read what the export made of it.
    const download = expectDownload(page, 30000);
    await tapDock(page, 'record');
    const saved = await advanceUntilDownload(page, download);
    if (!saved) {
      report.failures.push('no GLB downloaded after Stop');
      report.marks = { scenarios, links: [], resolution: null };
      return { report, take: null, links: [], targetAWorld: null };
    }
    const glb = await saveDownload(saved, phase, report);
    const take = checkTake(report, await readFile(glb), { audio: true });
    await expectDownloadCount(page, report, 1);
    const resolution = (await page.evaluate(() => window.__lastPointReport())) as PointResolutionReport | null;
    const links = [...take.meaningLinks].sort((a, b) => a.span.start - b.span.start);
    report.marks = { scenarios, links, resolution };
    checkMarkLinks(report, take, links, scenarios, resolution);
    const targetANode = take.setNodes.find((node) => node.name.startsWith('TargetA'));
    const targetALink = links.find((link) => link.to.nodeName.startsWith('TargetA'));
    const targetAWorld = targetANode && targetALink?.to.point ? (targetALink.to.point.map((v, k) => v + targetANode.worldTranslation[k]!) as Vec3) : null;
    return { report, take, links, targetAWorld };
  } finally {
    await page.context().close();
  }
}

/** The low-frame-rate phase's frame interval: about 4 fps, so the frame after a touchdown comes before the 300 ms hold delay ends. */
const LOW_FPS_FRAME_MS = 250;
/** Frames this far apart, or more, show the phase ran at a low frame rate; faster frames prove nothing. */
const LOW_FPS_MIN_GAP_MS = 200;
/** Holds of the low-frame-rate phase, by the wall time the finger waits before it lifts on the next frame. */
const LOW_FPS_HOLDS = [
  // Lifts on the second frame after the touch: the first came before the hold delay ended, and the lift lands with the next.
  { name: 'hold-half-second', waitMs: 450 },
  { name: 'hold-one-second', waitMs: 950 },
  // The phone turns TURN_AT_TOUCHDOWN_DEG in the frame the finger lifts in, the finger still on the glass: still a hold.
  // It waits less: the turn takes the frame before the lift (the second after the touch), after the app drew it.
  { name: 'turn-at-lift', waitMs: 150, turn: true },
  // Down at the screen centre and still past the delay, then slides EARLY_DRAG_APX in the frame it lifts in: a drag, never a hold.
  { name: 'slide-at-lift', waitMs: 450, slide: true }
] as const;
const LOW_FPS_LINKED = LOW_FPS_HOLDS.filter((hold) => !('slide' in hold));

/** Every animation frame of the page waits `ms` first (0 restores the browser's), so a phone draws a few frames a second. */
const slowFrames = (page: Page, ms: number) =>
  page.evaluate((interval) => {
    const w = window as unknown as { __rafs?: { raf: typeof requestAnimationFrame; caf: typeof cancelAnimationFrame } };
    w.__rafs ??= { raf: window.requestAnimationFrame.bind(window), caf: window.cancelAnimationFrame.bind(window) };
    const { raf, caf } = w.__rafs;
    if (interval <= 0) {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = caf;
      return;
    }
    // Ids far above the browser's, so a frame requested before the switch is still cancelled by its own id.
    const waiting = new Map<number, { timer: number; frame?: number }>();
    let next = 1e9;
    window.requestAnimationFrame = (callback) => {
      const id = (next += 1);
      const entry: { timer: number; frame?: number } = {
        timer: window.setTimeout(() => {
          entry.frame = raf((time) => {
            waiting.delete(id);
            callback(time);
          });
        }, interval)
      };
      waiting.set(id, entry);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const entry = waiting.get(id);
      if (!entry) return caf(id);
      window.clearTimeout(entry.timer);
      if (entry.frame !== undefined) caf(entry.frame);
      waiting.delete(id);
    };
  }, ms);

/** Wall-clock times of the XR session's frames from now on, read back by `xrFrameTimes`. */
const watchXrFrames = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __xrFrameTimes: number[] };
    w.__xrFrameTimes = [];
    const session = window.IWER_DEVICE!.activeSession!;
    const tick = () => {
      w.__xrFrameTimes.push(performance.now());
      if (window.IWER_DEVICE!.activeSession === session) session.requestAnimationFrame(tick);
    };
    session.requestAnimationFrame(tick);
  });
const xrFrameTimes = (page: Page) => page.evaluate(() => (window as unknown as { __xrFrameTimes: number[] }).__xrFrameTimes.slice());

/**
 * Holds on a phone that draws about 4 frames a second (B-032), on the realtime clock a phone runs: each frame steps
 * once by its whole interval, so take time is wall time. A finger held past the 300 ms hold delay and the 0.4 s
 * dwell marks whatever the frame rate, even when it lifts on the frame after the one that came too early to see
 * the delay end; its link spans the touch to within a frame.
 */
async function lowFpsMarksPhase(run: Run): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'marks-low-fps', failures: [], notes: {}, ar: {}, takes: [] };
  const page = await openPage(run, { phone: true, scene: true, viewport: PHONE_VIEWPORT, video: true });
  const scenarios: MarkScenario[] = [];
  try {
    // B-032's point is the realtime clock at a low frame rate, so this phase alone keeps the page clock real.
    await enterAr(page, { position: [0, 1.6, 0], yaw: 0 }, true, true);
    const frame = toMatrix(await worldFrame(page));
    const targetA = new THREE.Vector3(...TARGETS.TargetA!.center).applyMatrix4(frame).toArray() as Vec3;
    const eye: Vec3 = [0, 1.5, 0.6];
    const standing = setToRoom(frame, { position: eye, quaternion: lookQuat(eye, [0, 1.5, -1.5]) });
    await setHeadPose(page, standing.position, standing.quaternion);
    await nextXrFrame(page);
    await advance(page, STEP_MS);
    await startRecordingByDock(page);
    await watchTouches(page);
    for (let i = 0; i < 3; i += 1) {
      await nextXrFrame(page);
      await advance(page, STEP_MS);
    }

    await slowFrames(page, LOW_FPS_FRAME_MS);
    await page.evaluate(() => window.__setManualClock(false));
    const centre = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2, PHONE_VIEWPORT.height / 2, 1.5);
    const slid = await phoneScreenPoint(page, PHONE_VIEWPORT.width / 2 + EARLY_DRAG_APX, PHONE_VIEWPORT.height / 2, 1.5);
    await watchXrFrames(page);
    for (const hold of LOW_FPS_HOLDS) {
      const slide = 'slide' in hold;
      const before = await arOf(page);
      const logFrom = (await touchLog(page)).length;
      await drive(page, phoneFingerDown(page, slide ? centre : targetA));
      await page.waitForTimeout(hold.waitMs);
      // The lift reaches the app before its frame's step, as a phone's browser delivers it.
      if ('turn' in hold) {
        // The head turns about its own up axis and the finger keeps its place on the screen: it turns with the head.
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (TURN_AT_TOUCHDOWN_DEG * Math.PI) / 180);
        const head = new THREE.Quaternion(...standing.quaternion);
        const eyeAt = new THREE.Vector3(...standing.position);
        const local = new THREE.Vector3(...targetA).sub(eyeAt).applyQuaternion(head.clone().invert());
        const turned = head.clone().multiply(turn);
        const at = local.applyQuaternion(turned).add(eyeAt).toArray() as Vec3;
        await drive(page, phoneFingerUp(page, { aheadOfApp: true, at, headPose: { position: standing.position, quaternion: [turned.x, turned.y, turned.z, turned.w] } }));
        await setHeadPose(page, standing.position, standing.quaternion);
      } else {
        await drive(page, phoneFingerUp(page, { aheadOfApp: true, ...(slide ? { at: slid } : {}) }));
      }
      await nextXrFrame(page);
      const after = await arOf(page);
      const log = (await touchLog(page)).slice(logFrom);
      const down = log.find((entry) => entry.type === 'selectstart');
      const up = log.find((entry) => entry.type === 'selectend');
      scenarios.push({
        name: hold.name,
        ...(down ? { downSec: round(down.takeSec, 3) } : {}),
        ...(up ? { upSec: round(up.takeSec, 3) } : {}),
        ...(down && up ? { touchMs: Math.round(up.wall - down.wall) } : {}),
        holdsBefore: before.screenHolds.kept,
        holdsAfter: after.screenHolds.kept,
        trackedAfter: after.screenHold.phase
      });
      if (!down || !up) report.failures.push(`${hold.name}: the touch left no selectstart/selectend in the page`);
      const expected = slide ? 0 : 1;
      if (after.screenHolds.kept !== before.screenHolds.kept + expected) report.failures.push(`${hold.name}: the take kept ${after.screenHolds.kept - before.screenHolds.kept} new hold(s), expected ${expected}`);
    }
    const times = await xrFrameTimes(page);
    await page.evaluate(() => window.__setManualClock(true));
    await slowFrames(page, 0);
    const gaps = times.slice(1).map((time, i) => time - times[i]!).sort((a, b) => a - b);
    const medianGapMs = gaps.length > 0 ? Math.round(gaps[Math.floor(gaps.length / 2)]!) : 0;
    report.notes.lowFps = { frames: times.length, medianGapMs, fps: medianGapMs > 0 ? round(1000 / medianGapMs, 1) : 0 };
    if (medianGapMs < LOW_FPS_MIN_GAP_MS) report.failures.push(`frames came every ${medianGapMs} ms during the holds, under ${LOW_FPS_MIN_GAP_MS} ms; the phase did not run at a low frame rate`);

    const download = expectDownload(page, 30000);
    await tapDock(page, 'record');
    const saved = await advanceUntilDownload(page, download);
    if (!saved) {
      report.failures.push('no GLB downloaded after Stop');
      report.marks = { scenarios, links: [], resolution: null };
      return report;
    }
    const take = checkTake(report, await readFile(await saveDownload(saved, report.phase, report)), { audio: true });
    const resolution = (await page.evaluate(() => window.__lastPointReport())) as PointResolutionReport | null;
    const links = [...take.meaningLinks].sort((a, b) => a.span.start - b.span.start);
    report.marks = { scenarios, links, resolution };
    const unlinked = resolution?.runs.filter((resolved) => !resolved.linked) ?? [];
    if (unlinked.length > 0) report.failures.push(`resolution: unlinked runs ${JSON.stringify(unlinked.map((resolved) => `${resolved.start}..${resolved.end} ${resolved.reason}`))}, expected none`);
    if (links.length !== LOW_FPS_LINKED.length) report.failures.push(`${links.length} link(s) in the take, expected ${LOW_FPS_LINKED.length} (one per hold on TargetA)`);
    // Input lands on the step after the frame it came in, so a span may trail its touch by a frame at either end.
    const frameSec = Math.max(medianGapMs, LOW_FPS_FRAME_MS) / 1000;
    if (links.length !== LOW_FPS_LINKED.length) return report;
    links.forEach((link, i) => {
      const touch = scenarios.find((scenario) => scenario.name === LOW_FPS_LINKED[i]!.name);
      if (!link.to.nodeName.startsWith('TargetA')) report.failures.push(`link ${i}: to node ${JSON.stringify(link.to.nodeName)}, expected TargetA`);
      if (touch?.downSec === undefined || touch.upSec === undefined || touch.touchMs === undefined) return;
      if (Math.abs(link.span.start - touch.downSec) > frameSec + MARK_START_TOLERANCE_SEC) report.failures.push(`link ${i} (${touch.name}): span starts at ${link.span.start} s, the touch at ${touch.downSec} s (limit one frame, ${round(frameSec, 3)} s)`);
      if (Math.abs(link.span.end - touch.upSec) > frameSec + MARK_START_TOLERANCE_SEC) report.failures.push(`link ${i} (${touch.name}): span ends at ${link.span.end} s, the finger lifted at ${touch.upSec} s (limit one frame, ${round(frameSec, 3)} s)`);
      // Take time is wall time: the span is as long as the finger was down.
      const lengthSec = link.span.end - link.span.start;
      if (Math.abs(lengthSec - touch.touchMs / 1000) > frameSec) report.failures.push(`link ${i} (${touch.name}): span lasts ${round(lengthSec, 3)} s, the finger was down ${touch.touchMs} ms (limit one frame)`);
    });
    return report;
  } finally {
    await page.context().close();
  }
}

/** The facts of the take's links against the touches that made them. */
function checkMarkLinks(report: PhaseReport, take: CameraTakeReport, links: MeaningLinkReport[], scenarios: MarkScenario[], resolution: PointResolutionReport | null): void {
  if (take.meaningVersion !== 1) report.failures.push(`HOLOIM_meaning version ${take.meaningVersion}, expected 1 (a camera link)`);
  const expected = [
    { scenario: 'hold-on-bracket', to: 'RecordedObject' },
    { scenario: 'hold-on-target-a', to: 'TargetA' },
    { scenario: 'hold-on-target-a-walking', to: 'TargetA' }
  ];
  if (links.length !== expected.length) report.failures.push(`${links.length} link(s) in the take, expected exactly ${expected.length} (bracket, TargetA, TargetA walking); the tap, the floor and the chip must make none`);
  const cameraNode = take.camera?.nodeIndex;
  links.forEach((link, i) => {
    const want = expected[i];
    if (link.from.camera !== true || link.from.bone !== undefined) report.failures.push(`link ${i}: from is not the camera form (${JSON.stringify(link.from)})`);
    if (link.from.nodeName !== CAMERA_NODE) report.failures.push(`link ${i}: from names node ${JSON.stringify(link.from.nodeName)}, expected ${CAMERA_NODE}`);
    if (link.from.node !== cameraNode) report.failures.push(`link ${i}: from.node ${link.from.node} is not the camera node ${cameraNode}`);
    if (link.provenance !== 'recorded') report.failures.push(`link ${i}: provenance ${link.provenance}, expected recorded`);
    if (!want) return;
    if (!link.to.nodeName.startsWith(want.to)) report.failures.push(`link ${i} (${want.scenario}): to node ${JSON.stringify(link.to.nodeName)}, expected ${want.to}`);
    if (!link.to.point || link.to.point.some((v) => !Number.isFinite(v))) report.failures.push(`link ${i}: to.point is missing or not finite`);
    const touch = scenarios.find((scenario) => scenario.name === want.scenario);
    if (touch?.downSec === undefined || touch.upSec === undefined) return;
    // The span starts at the touch, not 300 ms later when the hold qualified, and ends when the finger lifted.
    if (Math.abs(link.span.start - touch.downSec) > MARK_START_TOLERANCE_SEC) report.failures.push(`link ${i} (${want.scenario}): span starts at ${link.span.start} s, the touch at ${touch.downSec} s (limit ${MARK_START_TOLERANCE_SEC})`);
    if (Math.abs(link.span.end - touch.upSec) > MARK_END_TOLERANCE_SEC) report.failures.push(`link ${i} (${want.scenario}): span ends at ${link.span.end} s, the finger lifted at ${touch.upSec} s (limit ${MARK_END_TOLERANCE_SEC})`);
    // A hold lasts at least the 300 ms hold delay; its length beyond that follows the emulated frames, which vary with the machine's load.
    if (link.span.end - link.span.start < 0.3) report.failures.push(`link ${i} (${want.scenario}): span ${link.span.start}..${link.span.end} s is shorter than the 300 ms hold delay`);
  });
  const targetANode = take.setNodes.find((node) => node.name.startsWith('TargetA'));
  const stillLink = links[1];
  if (targetANode && stillLink?.to.point) {
    const world = stillLink.to.point.map((v, k) => v + targetANode.worldTranslation[k]!);
    const centre = TARGETS.TargetA!.center;
    const offM = Math.hypot(...world.map((v, k) => v - centre[k]!));
    report.notes.targetAHitFromCentreM = round(offM, 3);
    if (offM > 0.45) report.failures.push(`the TargetA hit is ${round(offM, 3)} m from the box's centre; the ray did not land on the box`);
  }
  if (!resolution) {
    report.failures.push('the page reported no point resolution for the take');
    return;
  }
  const holds = resolution.aimHolds;
  if (holds.length !== 8 || holds.some((hold) => hold.input !== 'screen')) report.failures.push(`resolution lists ${holds.length} hold(s) [${holds.map((hold) => hold.input).join(', ')}], expected 8 screen holds (bracket, floor, turn at touchdown, target ray lost, view offset, no viewer baseline, TargetA, TargetA walking)`);
  const unlinked = resolution.runs.filter((resolved) => !resolved.linked);
  if (unlinked.length !== 5 || unlinked.some((resolved) => resolved.reason !== 'no referent')) report.failures.push(`resolution: unlinked runs ${JSON.stringify(unlinked.map((resolved) => resolved.reason))}, expected exactly five "no referent" (the floor, the turn at touchdown, the target ray lost, the view offset, no viewer baseline)`);
  if (resolution.runs.filter((resolved) => resolved.linked).length !== links.length) report.failures.push('resolution: linked runs and links in the file differ');
}

// --- Main ---

await mkdir(artifactDir, { recursive: true });
if (videoDir) await mkdir(videoDir, { recursive: true });
const consoleErrors: string[] = [];
const reports: PhaseReport[] = [];
const startedAt = Date.now();
const browser = await launchXrBrowser(chromium, { args: FAKE_MIC_ARGS });
const run: Run = { browser, consoleErrors };
const selected = (phase: Phase) => !only || only.some((part) => phase.includes(part));
let comparison: Comparison | undefined;
let marksComparison: unknown;
try {
  const walked: Partial<Record<'phone-a' | 'phone-b', Walked>> = {};
  const marked: Partial<Record<'marks-a' | 'marks-b', Marked>> = {};
  let phaseStartedAt = Date.now();
  const finish = (report: PhaseReport) => {
    report.seconds = round((Date.now() - phaseStartedAt) / 1000, 1);
    reports.push(report);
    const s = report.scriptVsExport;
    console.log(`[ar-record] ${report.phase}: ${report.failures.length === 0 ? 'passed' : 'FAILED'} in ${report.seconds} s${s ? `; script error ${s.maxPositionCm} cm, ${s.maxRotationDeg} deg, ${s.stepsCovered}/${WALK_STEPS} steps` : ''}${report.take?.camera ? `; camera keys ${report.take.camera.translationKeys}` : ''}`);
  };
  for (const phase of PHASES) {
    if (!selected(phase)) continue;
    console.log(`[ar-record] ${phase}`);
    phaseStartedAt = Date.now();
    if (phase === 'phone-a') {
      walked[phase] = await walkPhase(run, phase, { position: [0, 1.6, 0], yaw: 0 });
      finish(walked[phase]!.report);
    } else if (phase === 'phone-b') {
      walked[phase] = await walkPhase(run, phase, { position: [1.2, 1.6, -0.8], yaw: 1.2 });
      finish(walked[phase]!.report);
    } else if (phase === 'marks-a') {
      marked[phase] = await marksPhase(run, phase, { position: [0, 1.6, 0], yaw: 0 });
      finish(marked[phase]!.report);
    } else if (phase === 'marks-b') {
      // A quarter turn: the room-axis bounds of the bracket then still centre on the bracket, so both placements aim at the same point of it.
      marked[phase] = await marksPhase(run, phase, { position: [1.2, 1.6, -0.8], yaw: Math.PI / 2 });
      finish(marked[phase]!.report);
    } else if (phase === 'marks-low-fps') {
      finish(await lowFpsMarksPhase(run));
    } else if (phase === 'mic-denied' || phase === 'session-end' || phase === 'page-hidden') {
      finish(await interruptPhase(run, phase));
    } else if (phase === 'hidden-at-start' || phase === 'restored-at-start' || phase === 'ended-at-start') {
      finish(await abortAtStartPhase(run, phase));
    } else if (phase === 'empty-set') {
      finish(await emptySetPhase(run));
    } else if (phase === 'quest-passthrough' || phase === 'interaction-undefined') {
      finish(await headsetPhase(run, phase));
    } else if (phase === 'phone-dock') {
      finish(await dockPhase(run));
    } else {
      finish(await dockExitIdlePhase(run));
    }
  }
  if (walked['phone-a']?.take && walked['phone-b']?.take) {
    const compared = compareTakes(walked['phone-a'], walked['phone-b']);
    comparison = compared.comparison;
    walked['phone-b'].report.failures.push(...compared.failures);
    console.log(
      `[ar-record] placements differ by ${comparison.worldFrameDeltaM} m, ${comparison.worldFrameDeltaDeg} deg; camera path ${comparison.cameraPath.maxPositionCm} cm, ${comparison.cameraPath.maxRotationDeg} deg over ${comparison.cameraPath.samples} samples; set nodes ${comparison.setNodes.maxCm} cm; object ${comparison.objects.map((o) => `${o.positionCm} cm ${o.rotationDeg} deg`).join(', ')}`
    );
  }
  if (marked['marks-a']?.take && marked['marks-b']?.take) {
    // The same holds under two placements: where each landed, in the node it hit, agrees.
    const a = marked['marks-a'];
    const b = marked['marks-b'];
    const reportB = b.report;
    const toPointDiffCm = a.links.map((link, i) => {
      const other = b.links[i];
      return link.to.point && other?.to.point ? round(Math.hypot(...link.to.point.map((v, k) => v - other.to.point![k]!)) * 100, 3) : Infinity;
    });
    // The walking hold's ray sweeps with wall-clock frames, so only the still holds are held to the centimetre.
    const stillIndices = [0, 1];
    for (const i of stillIndices) {
      if (!(toPointDiffCm[i]! <= MARK_POINT_TOLERANCE_CM)) reportB.failures.push(`link ${i}: to.point differs across placements by ${toPointDiffCm[i]} cm (limit ${MARK_POINT_TOLERANCE_CM})`);
    }
    if (a.links.length !== b.links.length || a.links.some((link, i) => link.to.nodeName !== b.links[i]?.to.nodeName)) reportB.failures.push('the two placements made different links');
    const deltaM = new THREE.Vector3().setFromMatrixPosition(toMatrix(a.report.worldFrame!)).distanceTo(new THREE.Vector3().setFromMatrixPosition(toMatrix(b.report.worldFrame!)));
    if (!(deltaM > 0.5)) reportB.failures.push(`the two placements are too alike (${round(deltaM)} m); the cross-placement mark check proves nothing`);
    marksComparison = { toPointDiffCm, stillHoldsToleranceCm: MARK_POINT_TOLERANCE_CM, placementDeltaM: round(deltaM) };
    console.log(`[ar-record] marks: to.point differs across placements by ${toPointDiffCm.join(', ')} cm (${a.links.length} links; placements ${round(deltaM)} m apart)`);
  }
  await writeFile(path.join(artifactDir, 'ar-record-report.json'), JSON.stringify({ reports, comparison, marksComparison, consoleErrors, seconds: round((Date.now() - startedAt) / 1000, 1) }, null, 2));
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.phase}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) throw new Error(`AR recording check failed:\n- ${failures.join('\n- ')}`);
  console.log('AR recording check passed.');
} finally {
  await browser.close();
}
