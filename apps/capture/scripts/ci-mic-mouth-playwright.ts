import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO, type AnimationSampler } from '@gltf-transform/core';
import { chromium, type Download, type Page, type Route } from 'playwright';
import { CONTROL_NAMES } from '@holoim/xr-ui-core';

import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  launchXrBrowser,
  resolveSimulationViewport,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import type {} from '../src/runtime/automationHooks';

// The mouth from the microphone in a headset (docs/features/mic-mouth.md). A fixed sound, made here from numbers
// (a pulse train through three formant filters, in a low and a high voice: no recorded and no system voice), is
// the page's microphone. The page runs in emulated VR in real time, records a take and exports it. The check
// reads the face on every frame against the sound's own clock: the jaw follows the loudness, the lips go round
// and wide on the right sounds, silence and quiet room noise leave the mouth closed, a tracked face takes the
// mouth from the microphone, and the exported take carries the same motion and the sound.
const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-mic-mouth';
/** MIC_MOUTH_VIDEO=1: a large view of the mouth, recorded in real time, with the name of each part on screen. */
const video = process.env.MIC_MOUTH_VIDEO === '1';

const RATE = 48000;
const WINDOW = 1024;
// The values of the feature (the brief's table): the check's expected jaw is made from these, not read from the code.
const NOISE_RMS = 0.01;
const FULL_RMS_SPAN = 0.12;
const JAW_GAIN = 0.9;
const JAW_MAX = 0.55;
const OPEN_TAU = 0.04;
const CLOSE_TAU = 0.09;

const MOUTH = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight'] as const;
const CLOSED = 0.02;
// The page runs in real time on a software renderer: 3 to 15 frames a second, by the machine. The sound's parts
// are long enough for 3 a second; with fewer frames than this in a part the check fails as too slow, not as wrong.
const MIN_FRAMES = 4;
const VOWEL_SEC = 2;
const SYLLABLE_SEC = 0.6;
const SYLLABLE_EVERY = 1;

type Vowel = 'ah' | 'ee' | 'oo';
type Voice = { name: string; f0: number; formants: Record<Vowel, [number, number, number]> };
// Average formants of the three corner vowels (Peterson and Barney's tables, 1952), a man's and a woman's voice.
const VOICES: Voice[] = [
  { name: 'low', f0: 120, formants: { ah: [730, 1090, 2440], ee: [270, 2290, 3010], oo: [300, 870, 2240] } },
  { name: 'high', f0: 220, formants: { ah: [850, 1220, 2810], ee: [310, 2790, 3310], oo: [370, 950, 2670] } }
];
const FORMANT_WIDTH = [80, 100, 150];

type Part = { name: string; kind: 'silence' | 'noise' | 'vowel' | 'syllables' | 'tracked'; voice?: string; vowel?: Vowel; start: number; end: number };

/** One vowel, RMS 1: the harmonics of a pulse train, each weighed by three formant resonators. */
function vowelWave(voice: Voice, vowel: Vowel, samples: number): Float32Array {
  const resonance = (f: number, centre: number, width: number): number => {
    const r = Math.exp(-Math.PI * width / RATE);
    const a1 = -2 * r * Math.cos(2 * Math.PI * centre / RATE);
    const a2 = r * r;
    const w = 2 * Math.PI * f / RATE;
    return Math.abs(1 + a1 + a2) / Math.hypot(1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), a1 * Math.sin(w) + a2 * Math.sin(2 * w));
  };
  const out = new Float32Array(samples);
  for (let k = 1; k * voice.f0 < 9000; k += 1) {
    const f = k * voice.f0;
    let amplitude = 1 / k;
    voice.formants[vowel].forEach((centre, index) => { amplitude *= resonance(f, centre, FORMANT_WIDTH[index]!); });
    for (let n = 0; n < samples; n += 1) out[n]! += amplitude * Math.sin(2 * Math.PI * f * n / RATE + k * 1.7);
  }
  let sum = 0;
  for (const value of out) sum += value * value;
  const rms = Math.sqrt(sum / samples);
  for (let n = 0; n < samples; n += 1) out[n]! /= rms;
  return out;
}

/** The fixed sound and its parts. */
function buildSound(): { pcm: Float32Array; parts: Part[] } {
  const chunks: Float32Array[] = [];
  const parts: Part[] = [];
  let at = 0;
  const push = (name: string, kind: Part['kind'], samples: Float32Array, extra: Partial<Part> = {}) => {
    parts.push({ name, kind, start: at, end: at + samples.length / RATE, ...extra });
    chunks.push(samples);
    at += samples.length / RATE;
  };
  const silence = (sec: number) => new Float32Array(Math.round(sec * RATE));
  // 30 ms in and out: a voice does not start with a click.
  const shaped = (wave: Float32Array, rms: number): Float32Array => {
    const ramp = Math.round(0.03 * RATE);
    return wave.map((value, n) => value * rms * Math.min(1, n / ramp, (wave.length - 1 - n) / ramp));
  };
  push('silence-start', 'silence', silence(0.8));
  for (const voice of VOICES) {
    for (const vowel of ['ah', 'ee', 'oo'] as const) {
      push(`${voice.name}-${vowel}`, 'vowel', shaped(vowelWave(voice, vowel, Math.round(VOWEL_SEC * RATE)), 0.1), { voice: voice.name, vowel });
      push(`${voice.name}-${vowel}-gap`, 'silence', silence(0.8));
    }
    // Four syllables of unequal loudness: the jaw has to follow each one.
    const run = new Float32Array(Math.round(SYLLABLE_EVERY * 4 * RATE));
    [0.1, 0.04, 0.07, 0.05].forEach((rms, index) => run.set(shaped(vowelWave(voice, 'ah', Math.round(SYLLABLE_SEC * RATE)), rms), Math.round(index * SYLLABLE_EVERY * RATE)));
    push(`${voice.name}-syllables`, 'syllables', run, { voice: voice.name });
    push(`${voice.name}-rest`, 'silence', silence(1));
  }
  // Room noise under the threshold: a fixed pseudo-random hiss at RMS 0.004.
  let seed = 0x1234;
  const noise = silence(2).map(() => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296 * 2 - 1) * 0.004 * Math.sqrt(3);
  });
  push('room-noise', 'noise', noise);
  // The tracked part: the check sets a tracked face (mouth closed) in this silence, then the voice is loud.
  push('silence-before-tracked', 'silence', silence(0.8));
  push('tracked-ah', 'tracked', shaped(vowelWave(VOICES[0]!, 'ah', Math.round(VOWEL_SEC * RATE)), 0.1));
  push('silence-end', 'silence', silence(0.5));
  const pcm = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.length; }
  return { pcm, parts };
}

/** The jaw the feature's values give for this sound, on a 2 ms grid: level of the last 1024 samples, cap, smoothing. */
function expectedJaw(pcm: Float32Array): { step: number; values: Float32Array } {
  const step = 0.002;
  const hop = Math.round(step * RATE);
  const values = new Float32Array(Math.floor(pcm.length / hop));
  let jaw = 0;
  for (let i = 0; i < values.length; i += 1) {
    const end = i * hop;
    let sum = 0;
    for (let n = Math.max(0, end - WINDOW); n < end; n += 1) sum += pcm[n]! * pcm[n]!;
    const level = Math.min(1, Math.max(0, (Math.sqrt(sum / WINDOW) - NOISE_RMS) / FULL_RMS_SPAN));
    const target = Math.min(JAW_MAX, JAW_GAIN * level);
    jaw += (target - jaw) * (1 - Math.exp(-step / (target > jaw ? OPEN_TAU : CLOSE_TAU)));
    values[i] = jaw;
  }
  return { step, values };
}

function wavOf(pcm: Float32Array): Buffer {
  const out = Buffer.alloc(44 + pcm.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcm.length * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((value, n) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + n * 2));
  return out;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i += 1) { ab += (a[i]! - meanA) * (b[i]! - meanB); aa += (a[i]! - meanA) ** 2; bb += (b[i]! - meanB) ** 2; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** One frame of the run. `t`: the sound's clock (s from its start); `p`: the page's clock (s). */
type Row = { t: number; p: number; source: string; weights: Record<string, number>; head: Record<string, number> };
type MicWindow = Window & {
  __mic: {
    context: AudioContext | null;
    bus: GainNode | null;
    calls: Array<{ meter: boolean; p: number }>;
    contexts: Array<{ context: AudioContext; madeIn: string }>;
    settled: number;
    startAt: number | null;
    ended: boolean;
    rows: Row[];
  };
};

const { pcm, parts } = buildSound();
const soundSec = pcm.length / RATE;
const expected = expectedJaw(pcm);
const expectedAt = (t: number): number => (t < 0 ? 0 : expected.values[Math.min(expected.values.length - 1, Math.round(t / expected.step))]!);
const part = (name: string): Part => parts.find((entry) => entry.name === name)!;

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
await writeFile(path.join(artifactDir, 'mic-mouth.wav'), wavOf(pcm));

// No fake-device flags and no autoplay flag: the page's microphone is the stub below, and its audio contexts run
// because the check presses a real key first, as a person's first action does.
// MIC_MOUTH_GPU=metal (or another ANGLE backend): the video on the machine's graphics card, for a smooth picture.
const browser = await launchXrBrowser(chromium, process.env.MIC_MOUTH_GPU ? { args: [`--use-angle=${process.env.MIC_MOUTH_GPU}`] } : {});
const consoleErrors: string[] = [];
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};
const report: Record<string, unknown> = { soundSec: round(soundSec), parts: parts.map((entry) => ({ ...entry, start: round(entry.start), end: round(entry.end) })) };

async function openPage(options: { denied: boolean; refuseMeter?: boolean; label: string }): Promise<Page> {
  // The software renderer's cost grows with the pixel count: the numbers need only the checks' small canvas.
  const viewport = video ? { width: 1280, height: 720 } : resolveSimulationViewport();
  const context = await createXrContext(browser, { viewport, acceptDownloads: true, ...(video && !options.denied && !options.refuseMeter ? { recordVideo: { dir: path.join(artifactDir, 'video'), size: viewport } } : {}) });
  const page = await context.newPage();
  // tsx compiles with keepNames, which wraps named inner functions of the page.evaluate callbacks in a helper the page lacks.
  await page.addInitScript('globalThis.__name = globalThis.__name || ((target) => target);');
  wireXrConsoleErrors(page, consoleErrors, { label: options.label });
  await page.addInitScript(({ denied, refuseMeter }) => {
    const w = window as unknown as MicWindow;
    w.__mic = { context: null, bus: null, calls: [], contexts: [], settled: 0, startAt: null, ended: false, rows: [] };
    // Every audio context the page makes, for the report: a suspended one reads silence.
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.__mic.contexts.push({ context: this, madeIn: `${this.state}${navigator.userActivation.hasBeenActive ? ' after a user action' : ''}` });
      }
    };
    // Every caller (the recorder, then the face's voice meter) gets the same sound on a stream of its own: the
    // recorder stops its tracks when a take ends, and that must not silence the meter.
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const audio = constraints?.audio;
      if (!audio || constraints?.video) throw new DOMException('This check has no camera', 'NotFoundError');
      const meter = typeof audio === 'object' && 'noiseSuppression' in audio;
      w.__mic.calls.push({ meter, p: performance.now() / 1000 });
      if (denied || (refuseMeter && meter)) throw new DOMException('Permission denied', 'NotAllowedError');
      if (!w.__mic.context) {
        w.__mic.context = new AudioContext({ sampleRate: 48000 });
        w.__mic.bus = w.__mic.context.createGain();
      }
      const destination = w.__mic.context.createMediaStreamDestination();
      w.__mic.bus!.connect(destination);
      return destination.stream;
    };
  }, { denied: options.denied, refuseMeter: options.refuseMeter === true });
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  await page.route('**/__holoim/input-recordings*', (route: Route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the mic mouth check)"}' }));
  const pageUrl = new URL(baseUrl);
  if (process.env.XR_AVATAR_URL) pageUrl.searchParams.set('avatar', process.env.XR_AVATAR_URL);
  await page.goto(pageUrl.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setFaceInput', '__sampleFace', '__setSpectatorView']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await waitForIwerRuntime(page);
  // The app asks for the microphone when it loads, and the face's meter opens its stream on the first frame after
  // the grant. Wait for that before any user action: the meter's audio context is then made suspended, which is
  // the hard case (a headset that remembers the grant).
  if (options.refuseMeter) await page.waitForFunction(() => (window as unknown as MicWindow).__mic.calls.some((call) => call.meter), undefined, { timeout: 60_000 });
  else if (!options.denied) await page.waitForFunction(() => (window as unknown as MicWindow).__mic.contexts.length >= 2, undefined, { timeout: 60_000 });
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate((hide: boolean) => {
    window.__setSpectatorView('face', { faceFrame: 'mouth' });
    if (!hide) return;
    const devui = window.IWER_DEVICE!.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas, document.getElementById('ui-root'), document.getElementById('VRButton'), document.getElementById('ARButton')]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  }, video);
  // A person's first action: without one the browser keeps new audio contexts suspended.
  await page.keyboard.press('Shift');
  return page;
}

const clickButton = (page: Page, name: string) => page.evaluate((label: string) => {
  const button = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === label);
  if (!button) throw new Error(`no button "${label}"`);
  button.click();
}, name);
const micState = (page: Page): Promise<string | null> => page.evaluate(() => /"micPermission":"(\w+)"/.exec(window.render_game_to_text())?.[1] ?? null);

try {
  // ---- The run with the sound.
  const page = await openPage({ denied: false, label: 'mic-mouth' });
  const recordClickAt = await page.evaluate(() => performance.now() / 1000);
  await clickButton(page, CONTROL_NAMES.startRecording);
  // The app's own request (when it loads, as before this feature) is first; the face's meter opens its stream
  // only after that one was granted, and one time.
  await page.waitForFunction(() => (window as unknown as MicWindow).__mic.calls.some((call) => call.meter), undefined, { timeout: 30_000 });
  const calls = await page.evaluate(() => (window as unknown as MicWindow).__mic.calls);
  report.requests = calls.map((call) => (call.meter ? 'meter' : 'recorder'));
  check(!calls[0]!.meter && calls.filter((call) => call.meter).length === 1, `microphone requests: ${JSON.stringify(report.requests)}; want the recorder first and the meter one time`);
  check((await micState(page)) === 'granted', `microphone state ${await micState(page)} after the recording started`);
  // The first frames of a take are slow (the recorder starts): the sound starts after twelve frames of the take.
  await page.evaluate(() => {
    const w = window as unknown as MicWindow;
    const count = () => {
      w.__mic.settled += 1;
      if (w.__mic.settled < 12) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
  });
  await page.waitForFunction(() => (window as unknown as MicWindow).__mic.settled >= 12, undefined, { timeout: 60_000 });

  // Play the sound into the microphone, and read the face on every frame against the sound's clock.
  const int16 = Int16Array.from(pcm, (value) => Math.round(Math.max(-1, Math.min(1, value)) * 32767));
  const contextState = await page.evaluate(async ({ base64, partList, showCaption }) => {
    const w = window as unknown as MicWindow;
    const context = w.__mic.context!;
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const samples = new Int16Array(bytes.buffer);
    const buffer = context.createBuffer(1, samples.length, 48000);
    const channel = buffer.getChannelData(0);
    for (let n = 0; n < samples.length; n += 1) channel[n] = samples[n]! / 32767;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(w.__mic.bus!);
    source.onended = () => { w.__mic.ended = true; };
    const startAt = context.currentTime + 0.5;
    source.start(startAt);
    w.__mic.startAt = startAt;

    const caption = showCaption ? document.createElement('div') : null;
    // A white square for the first 0.3 s of the sound: the video's sound is laid on the frame where it appears.
    const marker = showCaption ? document.createElement('div') : null;
    if (caption && marker) {
      caption.style.cssText = 'position:fixed;left:24px;bottom:20px;z-index:99999;font:600 26px system-ui;color:#fff;background:rgba(0,0,0,.6);padding:8px 14px;border-radius:6px';
      marker.style.cssText = 'position:fixed;left:0;top:0;width:48px;height:48px;z-index:99999;background:#fff;display:none';
      document.body.append(caption, marker);
    }
    const names = ['jawOpen', 'mouthFunnel', 'mouthPucker', 'mouthStretchLeft', 'mouthStretchRight'];
    const frame = () => {
      const t = context.currentTime - startAt;
      const snapshot = window.__sampleFace();
      const head: Record<string, number> = {};
      for (const [key, value] of Object.entries(snapshot.influences)) {
        const name = key.split(':')[1]!;
        if (names.includes(name)) head[name] = Math.max(head[name] ?? 0, value);
      }
      const weights: Record<string, number> = {};
      for (const [name, value] of Object.entries(snapshot.weights)) if (value) weights[name] = value;
      w.__mic.rows.push({ t, p: performance.now() / 1000, source: snapshot.expressionSource, weights, head });
      if (caption && marker) {
        const now = partList.find((entry) => t >= entry.start && t < entry.end);
        caption.textContent = t < 0 ? 'microphone: silence' : `microphone: ${now ? now.label : 'silence'} · mouth from: ${snapshot.expressionSource === 'liveness' ? 'the microphone' : 'the tracked face'}`;
        marker.style.display = t >= 0 && t < 0.3 ? 'block' : 'none';
      }
      if (!w.__mic.ended) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    return context.state;
  }, {
    base64: Buffer.from(int16.buffer).toString('base64'),
    partList: parts.map((entry) => ({
      start: entry.start,
      end: entry.end,
      label: entry.kind === 'vowel' ? `"${entry.vowel}" (${entry.voice} voice)` : entry.kind === 'syllables' ? `four syllables (${entry.voice} voice)` : entry.kind === 'noise' ? 'quiet room noise' : entry.kind === 'tracked' ? 'loud "ah"' : 'silence'
    })),
    showCaption: video
  });
  // Reported, not judged: on a very slow page the first frame can come after the first user action.
  report.meterContextMadeSuspended = await page.evaluate(() => (window as unknown as MicWindow).__mic.contexts[1]?.madeIn === 'suspended');
  check(contextState === 'running', `the microphone stub's audio context is ${contextState}`);
  check(await page.evaluate(() => navigator.userActivation.hasBeenActive), 'the page did not count a user action');

  // A tracked face (mouth closed) arrives in the silence before the last loud sound: it takes the mouth.
  const trackedFrom = part('silence-before-tracked').start + 0.1;
  await page.waitForFunction((from) => {
    const mic = (window as unknown as MicWindow).__mic;
    return mic.context!.currentTime - mic.startAt! >= from;
  }, trackedFrom, { timeout: 120_000 });
  await page.evaluate(() => window.__setFaceInput({ weights: {} }));
  await page.waitForFunction(() => (window as unknown as MicWindow).__mic.ended, undefined, { timeout: 60_000 });
  const rows: Row[] = await page.evaluate(() => (window as unknown as MicWindow).__mic.rows);
  report.audioContexts = await page.evaluate(() => (window as unknown as MicWindow).__mic.contexts.map((entry) => `made ${entry.madeIn}, now ${entry.context.state}`));
  await page.evaluate(() => window.__setFaceInput(null));
  await writeFile(path.join(artifactDir, 'mic-mouth-rows.json'), JSON.stringify(rows));

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await clickButton(page, CONTROL_NAMES.stopRecording);
  const file: Download = await download;
  // The whole take, its stop included: the meter asked one time only.
  const callsAtEnd = await page.evaluate(() => (window as unknown as MicWindow).__mic.calls);
  report.requestsAtEnd = callsAtEnd.map((call) => (call.meter ? 'meter' : 'recorder'));
  check(callsAtEnd.filter((call) => call.meter).length === 1, `microphone requests at the end of the take: ${JSON.stringify(report.requestsAtEnd)}; want the meter one time`);
  const glbPath = path.join(artifactDir, 'mic-mouth-take.glb');
  await file.saveAs(glbPath);
  if (video) {
    const recorded = page.video();
    await page.context().close();
    if (recorded) await recorded.saveAs(path.join(artifactDir, 'mic-mouth-raw.webm'));
  } else {
    await page.context().close();
  }

  // ---- Numbers from the face.
  const live = rows.filter((row) => row.source === 'liveness' && row.t >= 0);
  const inside = (row: Row, entry: Part, from = 0, to = 0) => row.t >= entry.start + from && row.t < entry.end + to;
  const mouthMax = (list: Row[]): number => Math.max(0, ...list.flatMap((row) => MOUTH.map((name) => row.head[name] ?? 0)));
  const mean = (list: Row[], name: string): number => list.reduce((sum, row) => sum + (row.head[name] ?? 0), 0) / Math.max(1, list.length);
  const enough = (list: Row[], what: string): boolean => {
    check(list.length >= MIN_FRAMES, `${what}: only ${list.length} frames (the page ran too slowly to judge)`);
    return list.length >= MIN_FRAMES;
  };
  report.frames = rows.length;
  report.framesPerSec = round(rows.length / (rows[rows.length - 1]!.p - rows[0]!.p));

  // A1: the jaw follows the loudness in the voiced parts, at the best lag (the meter hears the sound a little late).
  const voiced = live.filter((row) => parts.some((entry) => (entry.kind === 'vowel' || entry.kind === 'syllables') && inside(row, entry, 0, 0.2)));
  if (enough(voiced, 'voiced parts')) {
    let best = { lagMs: 0, r: -1 };
    for (let lagMs = 0; lagMs <= 150; lagMs += 5) {
      const r = pearson(voiced.map((row) => row.head.jawOpen ?? 0), voiced.map((row) => expectedAt(row.t - lagMs / 1000)));
      if (r > best.r) best = { lagMs, r };
    }
    report.jaw = { correlation: round(best.r), lagMs: best.lagMs, frames: voiced.length };
    check(best.r >= 0.8, `the jaw does not follow the loudness: correlation ${best.r.toFixed(3)} at ${best.lagMs} ms, want at least 0.8`);
  }
  const loud: Record<string, { jawPeak: number; funnel: number; stretch: number; frames: number }> = {};
  for (const entry of parts.filter((item) => item.kind === 'vowel')) {
    const peakRows = live.filter((row) => inside(row, entry, 0, 0.1));
    const steady = live.filter((row) => inside(row, entry, 0.25, 0));
    if (!enough(steady, entry.name)) continue;
    const result = { jawPeak: round(Math.max(0, ...peakRows.map((row) => row.head.jawOpen ?? 0))), funnel: round(mean(steady, 'mouthFunnel')), stretch: round(mean(steady, 'mouthStretchLeft')), frames: steady.length };
    loud[entry.name] = result;
    check(result.jawPeak >= 0.25, `${entry.name}: the jaw opens to ${result.jawPeak}, want at least 0.25`);
    // A4: round lips on "oo", wide lips on "ee", neither on "ah", in both voices.
    if (entry.vowel === 'oo') check(result.funnel >= 0.2 && result.funnel > result.stretch, `${entry.name}: lips not round (funnel ${result.funnel}, stretch ${result.stretch})`);
    if (entry.vowel === 'ee') check(result.stretch >= 0.2 && result.stretch > result.funnel, `${entry.name}: lips not wide (stretch ${result.stretch}, funnel ${result.funnel})`);
    if (entry.vowel === 'ah') check(result.funnel < 0.15 && result.stretch < 0.15, `${entry.name}: lips shaped on an open sound (funnel ${result.funnel}, stretch ${result.stretch})`);
  }
  report.loud = loud;
  // The four syllables: the jaw's peak in each follows the syllable's loudness.
  const syllables: Record<string, number[]> = {};
  for (const entry of parts.filter((item) => item.kind === 'syllables')) {
    const peaks = [0, 1, 2, 3].map((index) => round(Math.max(0, ...live.filter((row) => row.t >= entry.start + index * SYLLABLE_EVERY && row.t < entry.start + index * SYLLABLE_EVERY + SYLLABLE_SEC + 0.1).map((row) => row.head.jawOpen ?? 0))));
    syllables[entry.name] = peaks;
    // Loudness order of the four: 1st > 3rd > 4th > 2nd.
    check(peaks[0]! > peaks[2]! && peaks[2]! > peaks[3]! && peaks[3]! > peaks[1]! && peaks[1]! > 0.05, `${entry.name}: jaw peaks ${peaks.join(', ')} do not follow the loudness of the syllables`);
  }
  report.syllableJawPeaks = syllables;

  // A2: silence closes the mouth (0.4 s after the last sound).
  const silent = live.filter((row) => parts.some((entry) => entry.kind === 'silence' && entry.end - entry.start >= 0.8 && entry.name !== 'silence-before-tracked' && inside(row, entry, entry.name === 'silence-start' ? 0 : 0.4, 0)));
  if (enough(silent, 'silent parts')) {
    report.silenceMouthMax = round(mouthMax(silent));
    check(mouthMax(silent) <= CLOSED, `the mouth moves in silence: ${mouthMax(silent).toFixed(3)}`);
  }
  // A3: room noise under the threshold does not move it.
  const noisy = live.filter((row) => inside(row, part('room-noise'), 0.1, 0));
  if (enough(noisy, 'room noise')) {
    report.roomNoiseMouthMax = round(mouthMax(noisy));
    check(mouthMax(noisy) <= CLOSED, `room noise under the threshold moves the mouth: ${mouthMax(noisy).toFixed(3)}`);
  }
  // A5: sound moves the mouth and the jaw only; the rest is what liveness does without sound (blinks, lids with the gaze).
  const moved = new Map<string, number>();
  for (const row of live) for (const [name, value] of Object.entries(row.weights)) moved.set(name, Math.max(moved.get(name) ?? 0, value));
  const other = [...moved].filter(([name, value]) => value > 0.001 && !(MOUTH as readonly string[]).includes(name) && !/^eye(Blink|Look)/.test(name));
  report.channelsMoved = Object.fromEntries([...moved].filter(([, value]) => value > 0.001).map(([name, value]) => [name, round(value)]));
  check(other.length === 0, `sound moved channels outside the mouth: ${other.map(([name, value]) => `${name} ${value.toFixed(3)}`).join(', ')}`);
  // A6: with a tracked face the microphone does not move the mouth (0.25 s crossfade, then the loud sound).
  const tracked = rows.filter((row) => inside(row, part('tracked-ah'), 0, 0));
  if (enough(tracked, 'tracked part')) {
    report.tracked = { source: [...new Set(tracked.map((row) => row.source))], mouthMax: round(mouthMax(tracked)), frames: tracked.length };
    check(tracked.every((row) => row.source === 'automation'), 'the tracked face did not take the expression');
    check(mouthMax(tracked) <= CLOSED, `the microphone moved the mouth under a tracked face: ${mouthMax(tracked).toFixed(3)}`);
  }

  // ---- A7: the exported take carries the same mouth, and the sound.
  const gltf = await new NodeIO().read(glbPath);
  const root = gltf.getRoot();
  const mesh = root.listMeshes().find((item) => ((item.getExtras().targetNames ?? []) as string[]).includes('jawOpen'));
  const names = (mesh?.getExtras().targetNames ?? []) as string[];
  const nodes = root.listNodes().filter((node) => node.getMesh() === mesh);
  let sampler: AnimationSampler | null = null;
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      if (channel.getTargetPath() === 'weights' && nodes.includes(channel.getTargetNode()!)) sampler = channel.getSampler();
    }
  }
  check(Boolean(mesh && sampler), 'the exported take has no weights track on the head');
  if (mesh && sampler) {
    const times = sampler.getInput()!.getArray()!;
    const values = sampler.getOutput()!.getArray()!;
    const count = names.length;
    const track = (name: string) => {
      const index = names.indexOf(name);
      let key = 0;
      return (time: number): number => {
        if (time < times[key]!) key = 0;
        while (key + 1 < times.length && times[key + 1]! <= time) key += 1;
        const next = Math.min(key + 1, times.length - 1);
        const mix = next === key ? 0 : Math.min(1, Math.max(0, (time - times[key]!) / (times[next]! - times[key]!)));
        return values[key * count + index]! * (1 - mix) + values[next * count + index]! * mix;
      };
    };
    // The take's clock starts near the Record press: find the offset where the exported jaw lies on the sampled jaw.
    // A sampled frame and an exported key are the same frame of the app, read at two instants of it. So after the
    // fit each sampled value has to be in the export within one key of its time; no curve between keys is compared.
    const keyNear = (time: number): number => {
      let low = 0;
      let high = times.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (times[middle]! < time) low = middle + 1;
        else high = middle;
      }
      return low > 0 && time - times[low - 1]! < times[low]! - time ? low - 1 : low;
    };
    const errorOf = (offset: number, name: string, reach: number): number => {
      const index = names.indexOf(name);
      let sum = 0;
      for (const row of live) {
        const key = keyNear(row.p - offset);
        let best = Infinity;
        for (let k = Math.max(0, key - reach); k <= Math.min(times.length - 1, key + reach); k += 1) best = Math.min(best, Math.abs(values[k * count + index]! - (row.head[name] ?? 0)));
        sum += best * best;
      }
      return Math.sqrt(sum / live.length);
    };
    let offset = recordClickAt;
    let bestError = Infinity;
    for (let candidate = recordClickAt - 1; candidate <= recordClickAt + 5; candidate += 0.01) {
      const value = errorOf(candidate, 'jawOpen', 0);
      if (value < bestError) [bestError, offset] = [value, candidate];
    }
    const exported: Record<string, { rmsError: number; correlation: number; peak: number; facePeak: number }> = {};
    for (const name of ['jawOpen', 'mouthFunnel', 'mouthStretchLeft']) {
      const at = track(name);
      const series = live.map((row) => at(row.p - offset));
      const facePeak = Math.max(...live.map((row) => row.head[name] ?? 0));
      const result = { rmsError: round(errorOf(offset, name, 1)), correlation: round(pearson(series, live.map((row) => row.head[name] ?? 0))), peak: round(Math.max(...series)), facePeak: round(facePeak) };
      exported[name] = result;
      check(result.rmsError <= 0.02 && result.correlation >= 0.8 && Math.abs(result.peak - result.facePeak) <= 0.02, `export: ${name} differs from the face (RMS error ${result.rmsError}, correlation ${result.correlation}, peak ${result.peak} against ${result.facePeak})`);
    }
    const glb = await readFile(glbPath);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as { bufferViews?: Array<{ byteLength: number }> };
    const jsonText = JSON.stringify(json);
    const audioView = /"bufferView":(\d+),"mimeType":"audio\/[^"]+"|"mimeType":"audio\/[^"]+","bufferView":(\d+)/.exec(jsonText);
    const audioBytes = audioView ? json.bufferViews?.[Number(audioView[1] ?? audioView[2])]?.byteLength ?? 0 : 0;
    report.export = { bytes: glb.length, keys: times.length, durationSec: round(times[times.length - 1]!), takeStartsBeforeSoundSec: round(live[0]!.p - live[0]!.t - offset), channels: exported, audioBytes };
    check(audioBytes > 10_000, `the exported take carries ${audioBytes} bytes of sound`);
  }

  // ---- A8, second half: with the microphone denied the mouth stays closed and the meter never asks for it.
  const deniedPage = await openPage({ denied: true, label: 'mic-mouth denied' });
  await clickButton(deniedPage, CONTROL_NAMES.startRecording);
  await deniedPage.waitForFunction(() => /"micPermission":"denied"/.test(window.render_game_to_text()), undefined, { timeout: 30_000 });
  // Twenty more frames with the answer known: the meter would have asked by now.
  const deniedRows = await deniedPage.evaluate(() => new Promise<Array<Record<string, number>>>((resolve) => {
    const out: Array<Record<string, number>> = [];
    const frame = () => {
      out.push(window.__sampleFace().weights as Record<string, number>);
      if (out.length < 20) requestAnimationFrame(frame);
      else resolve(out);
    };
    requestAnimationFrame(frame);
  }));
  const deniedCalls = await deniedPage.evaluate(() => (window as unknown as MicWindow).__mic.calls);
  const deniedMouth = Math.max(0, ...deniedRows.flatMap((weights) => MOUTH.map((name) => weights[name] ?? 0)));
  report.denied = { requests: deniedCalls.map((call) => (call.meter ? 'meter' : 'recorder')), mouthMax: round(deniedMouth) };
  check(deniedCalls.length > 0 && deniedCalls.every((call) => !call.meter), `microphone denied: requests ${JSON.stringify(report.denied)}; the meter must not ask`);
  check(deniedMouth <= CLOSED, `microphone denied: the mouth moves (${deniedMouth.toFixed(3)})`);
  await deniedPage.context().close();

  // ---- A8, third part: the app's request is granted, the meter's own request is refused. The meter does not ask
  // again on each frame, and the mouth stays closed.
  const refusedPage = await openPage({ denied: false, refuseMeter: true, label: 'mic-mouth meter refused' });
  await clickButton(refusedPage, CONTROL_NAMES.startRecording);
  const refusedRows = await refusedPage.evaluate(() => new Promise<Array<Record<string, number>>>((resolve) => {
    const out: Array<Record<string, number>> = [];
    const frame = () => {
      out.push(window.__sampleFace().weights as Record<string, number>);
      if (out.length < 30) requestAnimationFrame(frame);
      else resolve(out);
    };
    requestAnimationFrame(frame);
  }));
  const refusedCalls = await refusedPage.evaluate(() => (window as unknown as MicWindow).__mic.calls);
  const refusedMouth = Math.max(0, ...refusedRows.flatMap((weights) => MOUTH.map((name) => weights[name] ?? 0)));
  report.meterRefused = { requests: refusedCalls.map((call) => (call.meter ? 'meter' : 'recorder')), mouthMax: round(refusedMouth), micState: await micState(refusedPage) };
  check(refusedCalls.filter((call) => call.meter).length === 1, `meter refused: requests ${JSON.stringify(report.meterRefused)}; want the meter one time`);
  check(refusedMouth <= CLOSED, `meter refused: the mouth moves (${refusedMouth.toFixed(3)})`);
  await refusedPage.context().close();
} finally {
  await browser.close();
}

// A denied microphone is this check's own doing; the browser reports nothing for it, the app shows its notice.
if (consoleErrors.length) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
await writeFile(path.join(artifactDir, 'mic-mouth-report.json'), JSON.stringify({ ...report, failures, consoleErrors }, null, 2));
console.log(`[mic-mouth] ${JSON.stringify({ requests: report.requests, audioContexts: report.audioContexts, meterContextMadeSuspended: report.meterContextMadeSuspended, jaw: report.jaw, loud: report.loud, syllableJawPeaks: report.syllableJawPeaks, silenceMouthMax: report.silenceMouthMax, roomNoiseMouthMax: report.roomNoiseMouthMax, tracked: report.tracked, export: report.export, denied: report.denied, meterRefused: report.meterRefused, requestsAtEnd: report.requestsAtEnd, channelsMoved: report.channelsMoved, framesPerSec: report.framesPerSec })}`);
if (failures.length) {
  console.error(`[mic-mouth] FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('[mic-mouth] passed');
