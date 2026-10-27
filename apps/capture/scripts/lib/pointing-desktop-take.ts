import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

import { CONTROL_NAMES } from '@holoim/xr-ui-core';
import { waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors, createXrContext } from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import { HOLOIM_MEANING_EXTENSION, meaningFromLabel, validateHoloimMeaning } from '../../../../packages/meaning/src/index.ts';
import type { MeaningLinkProvenance, MeaningProvenance } from '../../../../packages/meaning/src/index.ts';
import type {} from '../../src/runtime/automationHooks';
import type { MockInputState } from '../../src/types/contracts';
import { TARGETS, type Vec3 } from './pointing-scene.ts';
import { readGlbJson, type GltfJson } from './pointing-score.ts';

declare global {
  interface Window {
    __lockEvents?: string[];
    __strayMoves?: Array<[number, number]>;
  }
}

// Self-resolving pointing, desktop side. A scripted desktop take in the
// generated pointing-targets scene, driven through capture's real desktop
// input path where headless Chromium allows and through the mock input hook
// (`point`, `lookYaw`, `aimPitch`) elsewhere:
//   phase 0 (not recording): every way a hold ends — mouseup, keyup, blur,
//     page hidden, pointer lock lost — plus the context menu being cancelled;
//   phase 1 (recording): hold on A (third person, mock point), release, turn,
//     hold on B (first person, a REAL right-button hold under pointer lock),
//     release, turn, hold at the sky (third person, real F key), release.
// Expects two `recorded` links, A then B, three inferred motion spans (one
// per hold) and nothing linked for the sky; the crosshair lands on the target
// and the avatar's index finger lines up with the aim.

const STEP_MS = 1000 / 60;
const TOLERANCE_SEC = 0.35;
const AIM_TOLERANCE_DEG = 12;
const LANDING_TOLERANCE_M = 0.35;
const REST_TOLERANCE_M = 0.06;
const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const VIEWPORT = { width: 960, height: 540 };

const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
const norm = (v: number[]) => v.map((x) => x / Math.hypot(...v));
const angleDeg = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, norm(a).reduce((sum, v, i) => sum + v * norm(b)[i]!, 0)))) * 180) / Math.PI;
const round = (value: number, digits = 2) => Number(value.toFixed(digits));

export type DesktopPointingOptions = {
  browser: Browser;
  baseUrl: string;
  artifactDir: string;
  consoleErrors: string[];
  /** `?avatar=`: records the take on another avatar (the viewer's avatar-formats pipeline spec). */
  avatarUrl?: string;
};

/** The slice of render_game_to_text() this check reads. */
type GameState = {
  mode: string;
  avatar: { x: number; y: number; z: number; yaw: number };
  heightAdaptation: { eyeWorld: { x: number; y: number; z: number } };
  point: { held: boolean; aimPitch: number; landing: Vec3; landed: boolean; direction?: number[] | null };
};

type Crosshair = { display: string; landed: string | undefined; x: number; y: number } | null;

type HoldEntry = {
  name: string;
  view: string;
  target: string | null | undefined;
  start: number;
  end: number;
  crosshair: Crosshair;
  landing: Vec3;
  landed: boolean;
  landingErrorM?: number;
  fingerAimErrorDeg?: number;
  pitchSteer?: { before: number; after: number };
};

type DesktopLink = { from: string; to: string; start: number; end: number; provenance: MeaningLinkProvenance };
type DesktopSpan = { bones: string[]; start: number; end: number; provenance: MeaningProvenance };

export type DesktopPointingReport = {
  label: string;
  useFor: string;
  glb: string;
  sheet: string | null;
  pointerLock: { headlessGrants: boolean; realEvents: string[]; simulated: boolean; strayMoves?: Array<[number, number]> };
  releasePaths: Array<{ path: string; held?: boolean; expected?: boolean; ok: boolean }>;
  restDriftM: { afterReleasePaths: number; afterTake: number };
  holds: HoldEntry[];
  status: 'passed' | 'failed';
  failures: string[];
  links: DesktopLink[];
  spans: DesktopSpan[];
};

export async function runDesktopPointingCheck({ browser, baseUrl, artifactDir, consoleErrors, avatarUrl }: DesktopPointingOptions): Promise<DesktopPointingReport> {
  const label = 'desktop-pointing-targets';
  const failures: string[] = [];
  const fail = (message: string) => failures.push(message);
  const context = await createXrContext(browser, { viewport: VIEWPORT, acceptDownloads: true });
  const page: Page = await context.newPage();
  // tsx compiles with keepNames, which wraps named inner functions of the
  // page.evaluate callbacks in an __name helper the page lacks.
  await page.addInitScript('globalThis.__name = (target) => target;');
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const url = new URL(baseUrl);
  url.searchParams.set('scene', SCENE);
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('manualClock', '1');
  if (avatarUrl) url.searchParams.set('avatar', avatarUrl);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__setMockInput', '__sampleHands', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');

  const state = (): Promise<GameState> => page.evaluate(() => JSON.parse(window.render_game_to_text()) as GameState);
  let elapsed = 0;
  let recording = false;
  const advance = async (seconds: number) => {
    const steps = Math.max(1, Math.round((seconds * 1000) / STEP_MS));
    await page.evaluate((ms) => window.advanceTime(ms), steps * STEP_MS);
    if (recording) elapsed += steps * STEP_MS / 1000;
  };
  // The wrist in the avatar's own frame. Real CDP mouse moves carry platform-
  // dependent movementX (Linux derives it from position, macOS reports none),
  // which turns the body, so poses compare independent of facing.
  const wristLocal = async () => {
    const [{ avatar }, hands] = await Promise.all([state(), page.evaluate(() => window.__sampleHands())]);
    const [x, y, z] = hands.right.avatar.wrist!;
    const dx = x - avatar.x;
    const dz = z - avatar.z;
    const cos = Math.cos(avatar.yaw);
    const sin = Math.sin(avatar.yaw);
    return [dx * cos - dz * sin, y - avatar.y, dx * sin + dz * cos];
  };
  const mock = (payload: MockInputState) => page.evaluate((arg) => window.__setMockInput(arg), payload);
  const held = async () => (await state()).point.held;
  const canvasCenter = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  // --- Pointer lock: record whether headless Chromium grants it, then always simulate it. ---
  await page.evaluate(() => {
    window.__lockEvents = [];
    document.addEventListener('pointerlockchange', () => window.__lockEvents!.push('change'));
    document.addEventListener('pointerlockerror', () => window.__lockEvents!.push('error'));
  });
  await page.mouse.click(canvasCenter.x, canvasCenter.y);
  await page.waitForTimeout(400);
  const realLock = await page.evaluate(() => ({ granted: document.pointerLockElement === document.querySelector('canvas'), events: window.__lockEvents! }));
  // macOS Chromium rejects the request ("WrongDocumentError: The root document
  // of this element is not valid for pointer lock"); Linux headless Chromium
  // grants it, and then reports the cursor warping between the viewport origin
  // and its centre as trusted mousemoves of ±(480, 270) px at wall-clock
  // moments, each turning the view by over a radian (B-019: on a fast runner
  // one landed mid-hold and moved the aim off B). So the real lock is released
  // and the lock is always simulated at the DOM API boundary: capture's own
  // click handler still calls requestPointerLock and its handlers still read
  // document.pointerLockElement, while the right button, F key and mouse
  // movement are real CDP input, identical on every host.
  if (realLock.granted) {
    await page.evaluate(() => new Promise((resolve) => {
      document.addEventListener('pointerlockchange', resolve, { once: true });
      document.exitPointerLock();
    }));
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    let locked = false;
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => (locked ? canvas : null) });
    canvas.requestPointerLock = () => {
      locked = true;
      document.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    };
    document.exitPointerLock = () => {
      locked = false;
      document.dispatchEvent(new Event('pointerlockchange'));
    };
    // CDP clicks stay at the canvas centre, so real input under the lock never
    // moves the view; only the take's own synthetic pitch steer does.
    window.__strayMoves = [];
    document.addEventListener('mousemove', (event) => {
      if (locked && event.isTrusted && (event.movementX || event.movementY)) window.__strayMoves!.push([event.movementX, event.movementY]);
    }, true);
  });
  const pointerLock: DesktopPointingReport['pointerLock'] = { headlessGrants: realLock.granted, realEvents: realLock.events, simulated: true };
  await page.mouse.click(canvasCenter.x, canvasCenter.y);
  await page.waitForTimeout(100);
  if (!(await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas')))) throw new Error('the pointer lock stand-in did not engage');
  const relock = async () => {
    if (await page.evaluate(() => document.pointerLockElement === document.querySelector('canvas'))) return;
    await page.mouse.click(canvasCenter.x, canvasCenter.y);
    await page.waitForTimeout(300);
  };

  // --- Phase 0: release paths (not recording, so nothing is exported). ---
  await advance(1.0);
  const baseline = await wristLocal();
  const releasePaths: DesktopPointingReport['releasePaths'] = [];
  const expectHeld = async (name: string, expected: boolean) => {
    await advance(0.1);
    const actual = await held();
    releasePaths.push({ path: name, held: actual, expected, ok: actual === expected });
    if (actual !== expected) fail(`release path ${name}: held is ${actual}, expected ${expected}`);
  };
  await relock();
  await page.mouse.down({ button: 'right' });
  await expectHeld('mousedown (right, locked)', true);
  await advance(0.4);
  await page.mouse.up({ button: 'right' });
  await expectHeld('mouseup', false);
  await page.keyboard.down('KeyF');
  await expectHeld('keydown F', true);
  await page.keyboard.up('KeyF');
  await expectHeld('keyup F', false);
  await page.keyboard.down('KeyF');
  await advance(0.1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expectHeld('blur', false);
  await page.keyboard.up('KeyF');
  await page.keyboard.down('KeyF');
  await advance(0.1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete (document as { hidden?: boolean }).hidden;
  });
  await expectHeld('page hidden', false);
  await page.keyboard.up('KeyF');
  await relock();
  await page.mouse.down({ button: 'right' });
  await advance(0.1);
  await page.evaluate(() => document.exitPointerLock());
  await advance(0.1);
  await expectHeld('pointer lock lost', false);
  await page.mouse.up({ button: 'right' });
  const menuPrevented = await page.evaluate(() => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('canvas')!.dispatchEvent(event);
    return event.defaultPrevented;
  });
  releasePaths.push({ path: 'contextmenu cancelled', ok: menuPrevented });
  if (!menuPrevented) fail('the context menu opened on the canvas');
  // Mouse-up with the cursor off the canvas still ends it (document listener).
  await advance(0.6);
  const settled = await wristLocal();
  const restDrift = Math.hypot(...sub(settled, baseline));
  if (restDrift > REST_TOLERANCE_M) fail(`arm did not return to its locomotion pose after release: wrist is ${round(restDrift, 3)} m from baseline (limit ${REST_TOLERANCE_M})`);

  // --- Phase 1: the recorded take. ---
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).evaluate((el) => (el as HTMLElement).click());
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).waitFor();
  recording = true;
  await advance(1.0);

  const frameDir = path.join(artifactDir, `${label}-frames`);
  await mkdir(frameDir, { recursive: true });
  let shotIndex = 0;
  const shoot = async (name: string) => {
    // The scene and crosshair only: no app chrome. Close in on the avatar.
    await page.evaluate(() => {
      document.getElementById('ui-root')!.style.display = 'none';
      window.__setManualClock(true, true);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await page.screenshot({ path: path.join(frameDir, `${String(shotIndex).padStart(2, '0')}-${name}.png`), clip: { x: 200, y: 60, width: 560, height: 360 } });
    shotIndex += 1;
    await page.evaluate(() => {
      document.getElementById('ui-root')!.style.display = '';
      window.__setManualClock(true, false);
    });
  };
  await shoot('idle');

  const aimAt = (point: number[], eye: number[]) => {
    const d = sub(point, eye);
    return { lookYaw: Math.atan2(-d[0]!, -d[2]!), aimPitch: Math.asin(d[1]! / Math.hypot(...d)) };
  };
  const holds: HoldEntry[] = [];
  const takeHold = async ({ name, view, target, sky, press, release }: {
    name: string;
    view: 'first' | 'third';
    target?: string;
    sky?: boolean;
    press: () => Promise<unknown>;
    release: () => Promise<unknown>;
  }) => {
    const wantFirst = view === 'first';
    if ((await state()).mode === 'first' !== wantFirst) {
      await page.keyboard.press('KeyV');
      await advance(0.3);
    }
    const eyeNow = async (): Promise<Vec3> => {
      const eye = (await state()).heightAdaptation.eyeWorld;
      return [eye.x, eye.y, eye.z];
    };
    const aimFor = async () => (sky ? { lookYaw: 0.25, aimPitch: 0.6 } : aimAt(TARGETS[target!]!.center, await eyeNow()));
    // Face the target first; the eye shifts a little as the body turns.
    await mock(await aimFor());
    await advance(0.3);
    await mock(await aimFor());
    await advance(0.1);
    const start = elapsed;
    await press();
    await advance(0.1);
    // Pressing starts the aim level (third person); steer it onto the target.
    await mock(await aimFor());
    await advance(0.3);
    // Vertical mouse movement under pointer lock steers the aim pitch (a synthetic move: CDP cannot report movementY for a simulated lock).
    let pitchSteer: { before: number; after: number } | undefined;
    if (name === 'B') {
      const before = (await state()).point.aimPitch;
      await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 12, bubbles: true })));
      await advance(0.1);
      const after = (await state()).point.aimPitch;
      pitchSteer = { before: round(before, 3), after: round(after, 3) };
      if (!(after < before)) fail('B: moving the mouse down under pointer lock did not lower the aim pitch');
      await mock(await aimFor());
    }
    await advance(0.5);
    const mid = await state();
    const crosshair: Crosshair = await page.evaluate(() => {
      const element = document.getElementById('point-crosshair');
      const rect = element?.getBoundingClientRect();
      return element ? { display: getComputedStyle(element).display, landed: element.dataset.landed, x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 } : null;
    });
    const hands = await page.evaluate(() => window.__sampleHands());
    const tip = hands.right.avatar['index-finger-tip']!;
    const proximal = hands.right.avatar['index-finger-phalanx-proximal']!;
    const direction = mid.point;
    await shoot(`${name}-${view}`);
    await advance(0.4);
    const end = elapsed;
    await release();
    await advance(0.8);
    const entry: HoldEntry = { name, view, target: sky ? null : target, start: round(start), end: round(end), crosshair, landing: direction.landing, landed: direction.landed };
    if (!crosshair || crosshair.display !== 'block') fail(`${name}: the crosshair is not shown while the point action is held`);
    else if (crosshair.x < 0 || crosshair.y < 0 || crosshair.x > VIEWPORT.width || crosshair.y > VIEWPORT.height) fail(`${name}: the crosshair is off screen at (${round(crosshair.x)}, ${round(crosshair.y)})`);
    if (sky) {
      if (direction.landed) fail('sky: the aim ray landed on geometry');
      if (crosshair?.landed !== 'false') fail('sky: the crosshair should show the no-landing style');
    } else {
      const miss = Math.hypot(...sub(direction.landing, TARGETS[target!]!.center));
      entry.landingErrorM = round(miss);
      if (!direction.landed || miss > LANDING_TOLERANCE_M) fail(`${name}: the aim ray lands ${round(miss)} m from ${target} (limit ${LANDING_TOLERANCE_M})`);
    }
    // The finger really lines up with the aim: tip minus proximal against the eye ray.
    const aimDir = mid.point.direction;
    if (aimDir) {
      entry.fingerAimErrorDeg = round(angleDeg(sub(tip, proximal), aimDir));
      if (entry.fingerAimErrorDeg > AIM_TOLERANCE_DEG) fail(`${name}: the index finger is ${entry.fingerAimErrorDeg}° off the aim (limit ${AIM_TOLERANCE_DEG}°)`);
    }
    if (pitchSteer) entry.pitchSteer = pitchSteer;
    holds.push(entry);
  };
  const turn = async (yaw: number) => {
    await mock({ lookYaw: yaw });
    await advance(0.6);
  };

  await takeHold({
    name: 'A', view: 'third', target: 'TargetA',
    press: () => mock({ point: true }), release: () => mock({ point: false })
  });
  await turn(1.1);
  await takeHold({
    name: 'B', view: 'first', target: 'TargetB',
    press: async () => {
      await relock();
      await page.mouse.down({ button: 'right' });
    },
    release: () => page.mouse.up({ button: 'right' })
  });
  await turn(-0.9);
  await takeHold({
    name: 'sky', view: 'third', sky: true,
    press: () => page.keyboard.down('KeyF'), release: () => page.keyboard.up('KeyF')
  });
  // Face the way the baseline did, so the wrist compares like for like.
  await mock({ lookYaw: 0 });
  await advance(0.8);
  await shoot('after');
  const after = await wristLocal();
  const afterDrift = Math.hypot(...sub(after, baseline));
  if (afterDrift > REST_TOLERANCE_M) fail(`arm did not return to its locomotion pose after the take: wrist is ${round(afterDrift, 3)} m from baseline (limit ${REST_TOLERANCE_M})`);

  const downloaded = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).evaluate((el) => (el as HTMLElement).click());
  const download = await downloaded;
  const glbPath = path.join(artifactDir, `${label}.glb`);
  await copyFile(await download.path(), glbPath);
  const gltf = readGlbJson(await readFile(glbPath));

  const score = scoreDesktop({ gltf, holds });
  failures.push(...score.failures);
  pointerLock.strayMoves = await page.evaluate(() => window.__strayMoves!);
  if (pointerLock.strayMoves.length > 0) fail(`${pointerLock.strayMoves.length} trusted mouse movement(s) reached capture under the lock, first ${pointerLock.strayMoves[0]}: the take's aim depends on host timing`);
  const sheet = writeContactSheet(frameDir, path.join(artifactDir, `${label}-sheet.jpg`));
  const report: DesktopPointingReport = {
    label,
    useFor: 'desktop point action',
    glb: glbPath,
    sheet,
    pointerLock,
    releasePaths,
    restDriftM: { afterReleasePaths: round(restDrift, 3), afterTake: round(afterDrift, 3) },
    holds,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    links: score.links,
    spans: score.spans
  };
  await writeFile(path.join(artifactDir, `${label}-report.json`), JSON.stringify(report, null, 2));
  await context.close();
  return report;
}

function scoreDesktop({ gltf, holds }: { gltf: GltfJson; holds: HoldEntry[] }): { failures: string[]; links: DesktopLink[]; spans: DesktopSpan[] } {
  const failures: string[] = [];
  const raw = gltf.extensions?.[HOLOIM_MEANING_EXTENSION];
  if (raw === undefined) return { failures: [`no ${HOLOIM_MEANING_EXTENSION} in the desktop take's GLB`], links: [], spans: [] };
  const validation = validateHoloimMeaning(raw);
  if (!validation.ok) return { failures: [`${HOLOIM_MEANING_EXTENSION} fails the schema: ${validation.errors.join('; ')}`], links: [], spans: [] };
  if (!(gltf.extensionsUsed ?? []).includes(HOLOIM_MEANING_EXTENSION)) failures.push('extension missing from extensionsUsed');
  if ((gltf.extensionsRequired ?? []).includes(HOLOIM_MEANING_EXTENSION)) failures.push('extension listed in extensionsRequired');
  const nodeNames = (gltf.nodes ?? []).map((node) => node.name ?? '');
  if (nodeNames.some((name) => /crosshair/i.test(name))) failures.push('the crosshair appears in the export');

  const links: DesktopLink[] = validation.value.marks.map((mark) => ({
    from: meaningFromLabel(mark.anchor.from),
    to: mark.anchor.to.bone ?? gltf.nodes?.[mark.anchor.to.node]?.name ?? `node ${mark.anchor.to.node}`,
    start: round(mark.span.start),
    end: round(mark.span.end),
    provenance: mark.provenance
  }));
  const spans: DesktopSpan[] = (validation.value.spans ?? []).map((span) => ({ bones: span.bones, start: round(span.span.start), end: round(span.span.end), provenance: span.provenance }));

  const linked = holds.filter((hold) => hold.target);
  if (links.length !== linked.length) failures.push(`${links.length} link(s) for ${linked.length} held point(s) with a target`);
  linked.forEach((hold, index) => {
    const link = links[index];
    if (!link) return;
    if (link.to !== `${hold.target}_RecordedBubble`) failures.push(`${hold.name}: link ${index + 1} goes to ${link.to}, expected ${hold.target}`);
    if (link.provenance.value !== 'recorded') failures.push(`${hold.name}: provenance ${link.provenance.value}, expected recorded`);
    if (link.from !== 'rightIndexDistal') failures.push(`${hold.name}: from ${link.from}, expected rightIndexDistal`);
    if (Math.abs(link.start - hold.start) > TOLERANCE_SEC + 0.1 || Math.abs(link.end - hold.end) > TOLERANCE_SEC) {
      failures.push(`${hold.name}: link ${link.start}–${link.end} s is not within ${TOLERANCE_SEC} s of the hold ${hold.start}–${hold.end} s`);
    }
  });
  for (const hold of holds.filter((entry) => !entry.target)) {
    for (const link of links) {
      if (Math.min(link.end, hold.end) - Math.max(link.start, hold.start) > 0.05) failures.push(`${hold.name}: a link overlaps the sky hold`);
    }
  }
  if (spans.length !== holds.length) failures.push(`${spans.length} motion span(s) for ${holds.length} hold(s)`);
  holds.forEach((hold, index) => {
    const span = spans[index];
    if (!span) return;
    if (span.provenance.value !== 'inferred') failures.push(`${hold.name}: motion span provenance ${span.provenance.value}, expected inferred`);
    if (!span.bones.includes('rightUpperArm') || !span.bones.includes('rightHand')) failures.push(`${hold.name}: motion span bones ${span.bones.join(',')} lack the arm`);
    if (span.start > hold.start + TOLERANCE_SEC || span.end < hold.end - TOLERANCE_SEC) failures.push(`${hold.name}: motion span ${span.start}–${span.end} s does not cover the hold ${hold.start}–${hold.end} s`);
  });
  return { failures, links, spans };
}
