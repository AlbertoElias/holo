import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  launchXrBrowser,
  resumePageClock,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';

// The capture take lifecycle (RecordingSession), replayed from a TLA+ model
// (B-049). Each phase is a fresh desktop page on the manual clock with a
// microphone the check answers by hand, so every ordering is exact. Phases:
//   start-window    Record pressed; the microphone has not answered. The take is starting: avatar
//                   size is locked, so the take must read as busy (`isTakeBusy`, what placement
//                   reads), a scan load must be refused as it is while recording, a second Record is
//                   refused, and one microphone request serves the start. Then the microphone arrives,
//                   the take records and Stop exports one GLB.
//   mic-order       The early permission probe (`requestMicPermission`) and the take's own request are
//                   separate getUserMedia calls. The take's request is granted and the take records; then
//                   the probe is refused. The UI must not say there is no microphone while one records,
//                   and the exported take carries the audio.
//   toggle-races    Record twice in one task: one take. Stop twice in one task: one export, one download.
//   performer-ends  A performer take is not a camera take: a hidden page and a VR session's end mid-start
//                   and mid-take leave it running (the performer walks on; Stop exports once). Not a
//                   defect; the phase pins it so the camera-only `endCameraTake` stays deliberate.
// CHECK_ONLY=<substring[,substring]> keeps matching phases. Writes output/ci-take-lifecycle/report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-take-lifecycle';
const only = process.env.CHECK_ONLY?.split(',');
const FAKE_MIC_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const BUSY_NOTICE = 'Stop recording to change the place.';
const NO_MIC_TEXT = 'No microphone: takes save without sound.';

const PHASES = ['start-window', 'mic-order', 'toggle-races', 'performer-ends'] as const;
type Phase = (typeof PHASES)[number];

type Mic = { calls: number; pending: number };
type Win = Window & {
  __micCalls: Array<{ settle: (how: 'grant' | 'deny') => void; settled: boolean }>;
  IWER_DEVICE?: { activeSession?: { end(): void } };
};

type Reading = {
  recordingState: string;
  recordingSizeLocked: boolean;
  recordingTakeBusy: boolean | undefined;
  micPermission: string;
  notice: string | null;
};

interface PhaseReport {
  phase: Phase;
  failures: string[];
  notes: Record<string, unknown>;
}

const downloads = new WeakMap<Page, { names: string[]; paths: Promise<string>[] }>();

async function openPage(browser: Browser, consoleErrors: string[], options: { query?: string; vr?: boolean }): Promise<Page> {
  const context = await createXrContext(browser, { viewport: { width: 640, height: 400 }, acceptDownloads: true });
  await context.grantPermissions(['microphone']).catch(() => undefined);
  const page = await context.newPage();
  const log = { names: [] as string[], paths: [] as Promise<string>[] };
  downloads.set(page, log);
  page.on('download', (download) => {
    log.names.push(download.suggestedFilename());
    log.paths.push(download.path().then((p) => p ?? ''));
  });
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  wireXrConsoleErrors(page, consoleErrors);
  // Every recording microphone request waits for the check to answer it. The face driver's voice meter is another request.
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    w.__micCalls = [];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      const audio = constraints?.audio;
      if (typeof audio === 'object' && audio !== null && 'noiseSuppression' in audio) return real(constraints);
      return new Promise<MediaStream>((resolve, reject) => {
        const call = {
          settled: false,
          settle: (how: 'grant' | 'deny') => {
            call.settled = true;
            if (how === 'grant') real(constraints).then(resolve, reject);
            else reject(new DOMException('Permission denied', 'NotAllowedError'));
          }
        };
        w.__micCalls.push(call);
      });
    };
  });
  await attachXrEnvironment(page, { mode: 'iwer' });
  const url = new URL(baseUrl);
  url.searchParams.set('manualClock', '1');
  for (const pair of (options.query ?? '').split('&').filter(Boolean)) {
    const [key, value = ''] = pair.split('=');
    url.searchParams.set(key!, value);
  }
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__toggleRecording', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await page.evaluate(() => window.__setManualClock(true));
  await waitForIwerRuntime(page);
  if (options.vr) {
    await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
    await freezePageClock(page);
    await waitForXrRenderLoop(page);
  }
  return page;
}

const read = (page: Page): Promise<Reading> =>
  page.evaluate(() => {
    const state = JSON.parse(window.render_game_to_text());
    const ui = state.ar;
    return {
      recordingState: ui.recordingState,
      recordingSizeLocked: state.heightAdaptation.recordingSizeLocked,
      recordingTakeBusy: state.heightAdaptation.recordingTakeBusy,
      micPermission: ui.micPermission,
      notice: ui.notice
    };
  });
const advance = (page: Page, ms: number) => page.evaluate((value) => window.advanceTime(value), ms);
const toggle = (page: Page) => page.evaluate(() => window.__toggleRecording());
const micCalls = (page: Page): Promise<Mic> =>
  page.evaluate(() => {
    const calls = (window as unknown as Win).__micCalls;
    return { calls: calls.length, pending: calls.filter((call) => !call.settled).length };
  });
const answerMic = (page: Page, index: number, how: 'grant' | 'deny') =>
  page.evaluate(([i, h]) => (window as unknown as Win).__micCalls[i as number]!.settle(h as 'grant' | 'deny'), [index, how] as const);
const loadPlace = (page: Page) => page.evaluate(() => window.__loadPlaceUrl('/e2e-missing/never.ply'));
const placeStatus = (page: Page) => page.evaluate(() => window.__samplePlace()?.status ?? null);

async function waitFor(page: Page, what: string, test: (reading: Reading) => boolean, timeoutMs = 10_000): Promise<Reading> {
  const start = Date.now();
  for (;;) {
    const reading = await read(page);
    if (test(reading)) return reading;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(reading)}`);
    await advance(page, 50);
    await page.waitForTimeout(25);
  }
}

async function waitDownloads(page: Page, count: number): Promise<string[]> {
  const log = downloads.get(page)!;
  const start = Date.now();
  while (log.names.length < count && Date.now() - start < 15_000) await page.waitForTimeout(50);
  return log.names;
}

async function glbText(page: Page, index: number): Promise<string> {
  const file = await downloads.get(page)!.paths[index];
  return file ? (await readFile(file)).toString('latin1') : '';
}

// --- Phases ---

async function startWindow(browser: Browser, consoleErrors: string[]): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'start-window', failures: [], notes: {} };
  const fail = (message: string) => report.failures.push(message);
  const page = await openPage(browser, consoleErrors, { query: 'placeCapture=1' });
  try {
    const mics0 = await micCalls(page);
    await toggle(page); // Record
    await waitFor(page, 'the start to lock the size', (r) => r.recordingSizeLocked);
    const during = await read(page);
    report.notes.during = during;
    if (during.recordingState !== 'idle') fail(`while the microphone is pending the state is ${during.recordingState}, not idle`);
    if (during.recordingTakeBusy !== true) fail(`size is locked (a take is starting) but isTakeBusy reads ${String(during.recordingTakeBusy)}`);
    const refused = await loadPlace(page);
    const afterLoad = await read(page);
    report.notes.scanLoadWhileStarting = { returned: refused, notice: afterLoad.notice, placeStatus: await placeStatus(page) };
    if (afterLoad.notice !== BUSY_NOTICE) fail(`a scan load while the take is starting was not refused as one while recording is (notice ${JSON.stringify(afterLoad.notice)}, place ${String(await placeStatus(page))})`);
    await toggle(page); // a second Record in the window
    const mics1 = await micCalls(page);
    report.notes.micCalls = { atLoad: mics0, whileStarting: mics1 };
    if (mics1.calls - mics0.calls !== 1) fail(`Record in the window made ${mics1.calls - mics0.calls} microphone requests, expected 1`);
    await answerMic(page, mics1.calls - 1, 'grant');
    await waitFor(page, 'recording', (r) => r.recordingState === 'recording');
    const recording = await read(page);
    if (recording.recordingTakeBusy !== true || !recording.recordingSizeLocked) fail('recording is not busy and locked');
    await advance(page, 500);
    await toggle(page); // Stop
    const names = await waitDownloads(page, 1);
    await waitFor(page, 'idle', (r) => r.recordingState === 'idle');
    const end = await read(page);
    report.notes.end = end;
    if (names.length !== 1) fail(`${names.length} downloads, expected 1`);
    if (end.recordingSizeLocked || end.recordingTakeBusy === true) fail('the take is still busy after the export');
  } finally {
    await page.context().close();
  }
  return report;
}

async function micOrder(browser: Browser, consoleErrors: string[]): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'mic-order', failures: [], notes: {} };
  const fail = (message: string) => report.failures.push(message);
  const page = await openPage(browser, consoleErrors, {});
  try {
    const probe = 0; // requestMicPermission() at load: its own getUserMedia
    const mics0 = await micCalls(page);
    if (mics0.calls !== 1) fail(`${mics0.calls} microphone requests at load, expected the one probe`);
    await toggle(page);
    await waitFor(page, 'the take request', () => true);
    await page.waitForFunction(() => (window as unknown as Win).__micCalls.length >= 2);
    await answerMic(page, 1, 'grant'); // the take's request
    await waitFor(page, 'recording', (r) => r.recordingState === 'recording');
    const granted = await read(page);
    report.notes.afterTakeGrant = granted;
    if (granted.micPermission !== 'granted') fail(`the take's microphone arrived but the UI says ${granted.micPermission}`);
    await answerMic(page, probe, 'deny'); // the probe is refused, late
    await advance(page, 200);
    const late = await read(page);
    report.notes.afterLateProbeDenial = late;
    const overlay = await page.evaluate(() => document.body.innerText);
    report.notes.overlayShowsNoMic = overlay.includes(NO_MIC_TEXT);
    if (late.micPermission !== 'granted') fail(`a late refusal of the probe made the UI say ${late.micPermission} while the take records with a microphone`);
    if (overlay.includes(NO_MIC_TEXT)) fail(`the page says "${NO_MIC_TEXT}" while the take records with a microphone`);
    await advance(page, 400);
    await toggle(page);
    await waitDownloads(page, 1);
    const hasAudio = (await glbText(page, 0)).includes('KHR_audio');
    report.notes.exportedAudio = hasAudio;
    if (!hasAudio) fail('the exported take has no audio although the microphone recorded');
  } finally {
    await page.context().close();
  }
  return report;
}

async function toggleRaces(browser: Browser, consoleErrors: string[]): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'toggle-races', failures: [], notes: {} };
  const fail = (message: string) => report.failures.push(message);
  const page = await openPage(browser, consoleErrors, {});
  try {
    const before = await micCalls(page);
    // Two Record presses in one task: the second sees a take that is starting.
    await page.evaluate(() => {
      window.__toggleRecording();
      window.__toggleRecording();
    });
    await page.waitForFunction(() => (window as unknown as Win).__micCalls.length >= 2);
    const after = await micCalls(page);
    report.notes.micCalls = { before, after };
    if (after.calls - before.calls !== 1) fail(`two Record presses made ${after.calls - before.calls} microphone requests, expected 1`);
    await answerMic(page, after.calls - 1, 'grant');
    await waitFor(page, 'recording', (r) => r.recordingState === 'recording');
    await advance(page, 400);
    // Two Stop presses in one task: the second sees an export in progress.
    await page.evaluate(() => {
      window.__toggleRecording();
      window.__toggleRecording();
    });
    const names = await waitDownloads(page, 1);
    await waitFor(page, 'idle', (r) => r.recordingState === 'idle');
    await page.waitForTimeout(500);
    const total = downloads.get(page)!.names.length;
    report.notes.downloads = total;
    if (names.length < 1 || total !== 1) fail(`${total} downloads after two Stop presses, expected 1`);
    const end = await read(page);
    if (end.recordingState !== 'idle' || end.recordingSizeLocked) fail(`after the export: ${JSON.stringify(end)}`);
  } finally {
    await page.context().close();
  }
  return report;
}

async function performerEnds(browser: Browser, consoleErrors: string[]): Promise<PhaseReport> {
  const report: PhaseReport = { phase: 'performer-ends', failures: [], notes: {} };
  const fail = (message: string) => report.failures.push(message);
  const page = await openPage(browser, consoleErrors, { vr: true });
  try {
    // A hidden page and the session's end while the microphone is pending.
    await toggle(page);
    await page.waitForFunction(() => (window as unknown as Win).__micCalls.length >= 2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.evaluate(() => (window as unknown as Win).IWER_DEVICE!.activeSession!.end());
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // The session's frames are gone; timers run again (the export's wait for a frame has its own timeout).
    await resumePageClock(page);
    const calls = await micCalls(page);
    await answerMic(page, calls.calls - 1, 'grant');
    await waitFor(page, 'the start to finish', (r) => r.recordingState === 'recording');
    report.notes.startedAfterSessionEnd = await read(page);
    await advance(page, 400);
    // A hidden page mid-take.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenMidTake = await read(page);
    report.notes.hiddenMidTake = hiddenMidTake;
    if (hiddenMidTake.recordingState !== 'recording') fail(`a hidden page ended the performer take (${hiddenMidTake.recordingState})`);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await toggle(page);
    const names = await waitDownloads(page, 1);
    await waitFor(page, 'idle', (r) => r.recordingState === 'idle');
    if (names.length !== 1) fail(`${names.length} downloads, expected 1`);
    const end = await read(page);
    if (end.recordingSizeLocked) fail('the size stayed locked after the export');
  } finally {
    await page.context().close();
  }
  return report;
}

const RUNNERS: Record<Phase, (browser: Browser, consoleErrors: string[]) => Promise<PhaseReport>> = {
  'start-window': startWindow,
  'mic-order': micOrder,
  'toggle-races': toggleRaces,
  'performer-ends': performerEnds
};

const browser = await launchXrBrowser(chromium, { args: FAKE_MIC_ARGS });
const consoleErrors: string[] = [];
const reports: PhaseReport[] = [];
try {
  for (const phase of PHASES) {
    if (only && !only.some((part) => phase.includes(part))) continue;
    try {
      reports.push(await RUNNERS[phase](browser, consoleErrors));
    } catch (error) {
      reports.push({ phase, failures: [`threw: ${(error as Error).message}`], notes: {} });
    }
  }
} finally {
  await browser.close();
}
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify({ reports, consoleErrors }, null, 2));
let failed = false;
for (const report of reports) {
  console.log(`[take-lifecycle] ${report.phase}: ${report.failures.length === 0 ? 'ok' : 'FAILED'}`);
  for (const failure of report.failures) console.log(`  - ${failure}`);
  failed ||= report.failures.length > 0;
}
if (consoleErrors.length > 0) {
  console.log(`console errors:\n${consoleErrors.join('\n')}`);
  failed = true;
}
if (failed) process.exit(1);
console.log('Take lifecycle check passed.');
