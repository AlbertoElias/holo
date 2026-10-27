import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, CDPSession, Download, Page } from 'playwright';

import { CONTROL_NAMES } from '@holoim/xr-ui-core';
import {
  attachXrEnvironment,
  createXrContext,
  enterIwerSessionFromButton,
  freezePageClock,
  waitForIwerRuntime,
  waitForPageFunctions,
  waitForTextContentPrefix,
  waitForXrRenderLoop,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

import { HOLOIM_MEANING_EXTENSION, validateHoloimMeaning } from '../../../../packages/meaning/src/index.ts';
import type { HoldsSnapshot } from '../../src/runtime/automationHooks';
import { installHandBlend } from './iwer-hand-blend.ts';
import { TARGETS, type Vec3 } from './pointing-scene.ts';
import { calibrateTipShift, installPointingRig, REST } from './pointing-take.ts';
import { readGlbJson } from './pointing-score.ts';

// Hold to mark "this", and the Halo (docs/features/ui-redesign.md, slice 5),
// on every input the build plan's table names, in the generated
// pointing-targets scene. Each phase records a take, exports it through
// capture's own recorder and reads HOLOIM_meaning from the GLB:
//   desktop: F held on A and on B (mock aim), then the B key's Halo: W held
//     with the mouse at the bottom edge (undo B), E flicked (redo), W flicked
//     (undo); then the dock's Halo glyph clicked, which leaves the ring
//     open with S empty (the dock carries Record), Escape closing it, and a
//     click on E (redo B) and on W (undo B); the dock's Stop ends the take.
//     Expects one recorded link, on A, and the ring drawn whole inside the
//     window while the key holds.
//   phone (390 × 844, touch): a touch moved before the hold delay looks and
//     never holds; a look-side touch held on A (CDP touch at A's
//     projection), then the dock's Halo glyph held and dragged left (W undoes
//     A), and tapped, with a tap on E (redo A); the dock's Stop ends the take.
//     Expects one recorded link on A, from touch.
//   IWER hands: the right index points at A while the left hand holds a
//     thumb–middle pinch; it points at B the same way; the right hand's own
//     thumb–middle pinch drags W (undo B); the left hand's ordinary
//     (thumb–index) pinch over a point at B holds nothing; a marked point at A
//     loses the left hand mid-hold (the mark ends on tracking loss after the
//     grace); the right pinch drags S (stop). Expects A recorded twice with no
//     inferred link over either, and B inferred, since an undone hold
//     suppresses nothing.
//   IWER controllers: the right controller aims at A while the left trigger
//     holds (no chrome commit), then the left thumbstick pressed at rest and
//     tilted: W (undo A), E (redo), S (stop). Expects A recorded.
// Used by ci-held-mark-playwright.ts and by the viewer's pointing pipeline
// spec, which uploads the phone and hands takes.

const SCENE = '/fixtures/scenes/pointing-targets.gltf';
const STEP_MS = 1000 / 30;
const OVERLAP_SEC = 0.05;

export const HELD_MARK_PHASES = ['desktop', 'phone', 'hands', 'controllers'] as const;
export type HeldMarkPhase = (typeof HELD_MARK_PHASES)[number];
export type HeldMarkRun = { browser: Browser; baseUrl: string; artifactDir: string; consoleErrors: string[] };
type Link = { from: string; to: string; start: number; end: number; provenance: string };
export type HeldMarkReport = { phase: HeldMarkPhase; glb: string; links: Link[]; holds: HoldsSnapshot; failures: string[]; notes: Record<string, unknown> };

const round = (value: number) => Number(value.toFixed(2));
const center = (name: string) => TARGETS[name]!.center;
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > OVERLAP_SEC;
const holdsOf = (page: Page) => page.evaluate(() => window.__sampleHolds());

async function openPage(run: HeldMarkRun, options: { viewport: { width: number; height: number }; touch?: boolean; iwer?: boolean }): Promise<Page> {
  const context = await createXrContext(run.browser, {
    viewport: options.viewport,
    acceptDownloads: true,
    ...(options.touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : {})
  });
  const page = await context.newPage();
  // tsx compiles with keepNames, which wraps named inner functions of the
  // page.evaluate callbacks in an __name helper the page lacks.
  await page.addInitScript('globalThis.__name = (target) => target;');
  wireXrConsoleErrors(page, run.consoleErrors);
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"(discarded by the marks check)"}' }));
  if (options.iwer) await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  const url = new URL(run.baseUrl);
  url.searchParams.set('scene', SCENE);
  url.searchParams.set('sceneScale', '1');
  url.searchParams.set('manualClock', '1');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__setMockInput', '__sampleHolds', '__projectToScreen', '__setManualClock']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  return page;
}

/** Scores the GLB: valid v0 meaning, and its links in take seconds. */
async function readLinks(run: HeldMarkRun, phase: string, download: Download, failures: string[]): Promise<{ glb: string; links: Link[] }> {
  const glb = path.join(run.artifactDir, `${phase}.glb`);
  await copyFile(await download.path(), glb);
  const gltf = readGlbJson(await readFile(glb));
  const raw = gltf.extensions?.[HOLOIM_MEANING_EXTENSION];
  if (raw === undefined) {
    failures.push(`no ${HOLOIM_MEANING_EXTENSION} in the GLB`);
    return { glb, links: [] };
  }
  const validation = validateHoloimMeaning(raw);
  if (!validation.ok) {
    failures.push(`${HOLOIM_MEANING_EXTENSION} fails the v0 schema: ${validation.errors.join('; ')}`);
    return { glb, links: [] };
  }
  const links = validation.value.marks.map((mark) => ({
    from: mark.anchor.from.bone,
    to: mark.anchor.to.bone ?? gltf.nodes?.[mark.anchor.to.node]?.name ?? `node ${mark.anchor.to.node}`,
    start: round(mark.span.start),
    end: round(mark.span.end),
    provenance: mark.provenance.value
  }));
  return { glb, links };
}

const onTarget = (link: Link, target: string) => link.to === `${target}_RecordedBubble`;

function expectActions(holds: HoldsSnapshot, expected: Array<{ input: string; action: string; done: boolean }>, failures: string[]): void {
  const actual = holds.actions.map(({ input, action, done }) => `${input}:${action}:${done}`);
  const wanted = expected.map(({ input, action, done }) => `${input}:${action}:${done}`);
  if (actual.join(',') !== wanted.join(',')) failures.push(`Halo actions ${actual.join(', ') || '(none)'}, expected ${wanted.join(', ')}`);
}

// --- Desktop ---

async function desktopPhase(run: HeldMarkRun): Promise<HeldMarkReport> {
  const failures: string[] = [];
  const viewport = { width: 960, height: 540 };
  const page = await openPage(run, { viewport });
  const advance = (seconds: number) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * (1000 / 60));
  const eye = async (): Promise<Vec3> => {
    const { x, y, z } = await page.evaluate(() => JSON.parse(window.render_game_to_text()).heightAdaptation.eyeWorld as { x: number; y: number; z: number });
    return [x, y, z];
  };
  const aimAt = async (target: string) => {
    const from = await eye();
    const d = center(target).map((v, i) => v - from[i]!);
    await page.evaluate((arg) => window.__setMockInput(arg), { lookYaw: Math.atan2(-d[0]!, -d[2]!), aimPitch: Math.asin(d[1]! / Math.hypot(...d)) });
  };
  const holdF = async (target: string) => {
    await aimAt(target);
    await advance(0.4);
    await aimAt(target);
    await page.keyboard.down('KeyF');
    await advance(0.3);
    await aimAt(target);
    await advance(1.0);
    await page.keyboard.up('KeyF');
    await advance(0.6);
  };
  // The key's Halo: B down, mouse movement (synthetic: CDP reports no movementX on macOS), B up.
  let mouse = { x: viewport.width / 2, y: viewport.height / 2 };
  type Box = { left: number; top: number; right: number; bottom: number };
  let ringBox: Box | null = null;
  const keyHalo = async (dx: number, dy: number, held: boolean) => {
    await page.keyboard.down('KeyB');
    if (held) await page.waitForTimeout(450);
    const box = await page.evaluate(() => {
      const ring = document.querySelector('[data-capture-key-halo]');
      if (!ring) return null;
      const rects = [...ring.querySelectorAll('*')].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0);
      return { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
    });
    const drawn = box !== null;
    ringBox ??= box;
    await page.evaluate(({ dx, dy, at }) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, clientX: at.x, clientY: at.y, bubbles: true })), { dx, dy, at: mouse });
    await advance(0.1);
    await page.keyboard.up('KeyB');
    await advance(0.2);
    return drawn;
  };

  await page.mouse.move(mouse.x, mouse.y);
  await advance(1.0);
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).evaluate((el) => (el as HTMLElement).click());
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).waitFor();
  await advance(0.5);
  await holdF('TargetA');
  await holdF('TargetB');
  // The mouse resting at the bottom edge, over the dock: the ring moves in to fit.
  mouse = { x: viewport.width / 2, y: viewport.height - 8 };
  await page.mouse.move(mouse.x, mouse.y);
  const ringDrawn = await keyHalo(-90, 0, true);
  if (!ringDrawn) failures.push('the ring is not drawn while B is held');
  // Set inside keyHalo, which TypeScript's narrowing does not see.
  const box = ringBox as Box | null;
  const fits = box !== null && box.left >= 0 && box.top >= 0 && box.right <= viewport.width && box.bottom <= viewport.height;
  if (!fits) failures.push(`the ring summoned at the bottom edge leaves the window: ${JSON.stringify(box)}`);
  const afterUndo = (await holdsOf(page)).holds;
  if (afterUndo.kept !== 1 || afterUndo.undone !== 1) failures.push(`after W: ${JSON.stringify(afterUndo)}, expected one kept and one undone`);
  const said = await page.evaluate(() => document.querySelector('[data-capture-status-line]')?.textContent ?? null);
  if (said !== 'Mark undone') failures.push(`the status line after W says ${JSON.stringify(said)}, expected "Mark undone"`);
  const flickDrawn = await keyHalo(90, 0, false);
  if (flickDrawn) failures.push('a flick drew the ring');
  await keyHalo(-90, 0, false);
  // The dock's Halo glyph clicked: the ring stays open until a direction is clicked.
  const haloGlyph = page.getByRole('img', { name: /^Halo/ });
  const pinnedPlaces = async () => page.evaluate(() => [...document.querySelectorAll('[data-capture-halo] [data-halo-slot]')].map((slot) => slot.getAttribute('data-halo-slot')));
  await haloGlyph.click();
  await advance(0.5);
  const clickedOpen = await pinnedPlaces();
  if (clickedOpen.join(',') !== 'e,w') failures.push(`a click on the Halo glyph shows ${JSON.stringify(clickedOpen)}, expected the ring open with E and W only`);
  await page.keyboard.press('Escape');
  const afterEscape = await pinnedPlaces();
  if (afterEscape.length !== 0) failures.push(`Escape left the clicked ring open: ${JSON.stringify(afterEscape)}`);
  for (const label of ['Redo mark', 'Undo mark']) {
    await haloGlyph.click();
    await page.getByRole('button', { name: label }).click();
    await advance(0.2);
  }
  const afterPicks = await pinnedPlaces();
  if (afterPicks.length !== 0) failures.push(`the ring stayed open after a direction was clicked: ${JSON.stringify(afterPicks)}`);
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).evaluate((el) => (el as HTMLElement).click());
  for (let i = 0; i < 20; i += 1) await advance(0.05);
  const { glb, links } = await readLinks(run, 'desktop', await download, failures);
  const holds = await holdsOf(page);
  expectActions(holds, [
    { input: 'key', action: 'undo', done: true },
    { input: 'key', action: 'redo', done: true },
    { input: 'key', action: 'undo', done: true },
    { input: 'mouse', action: 'redo', done: true },
    { input: 'mouse', action: 'undo', done: true }
  ], failures);
  if (links.length !== 1 || !onTarget(links[0]!, 'TargetA') || links[0]!.provenance !== 'recorded') failures.push(`links ${JSON.stringify(links)}, expected one recorded link on TargetA`);
  await page.context().close();
  return { phase: 'desktop', glb, links, holds, failures, notes: { ringDrawnWhileHeld: ringDrawn, flickDrewRing: flickDrawn, ringBoxAtBottomEdge: ringBox, statusAfterUndo: said, clickedOpen } };
}

// --- Phone ---

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number }>): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : points.map(({ x, y }, id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
}

async function phonePhase(run: HeldMarkRun): Promise<HeldMarkReport> {
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  const page = await openPage(run, { viewport, touch: true });
  const cdp = await page.context().newCDPSession(page);
  const advance = (seconds: number) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * (1000 / 60));
  await advance(1.0);
  // Face A, so it sits on the look side of the screen.
  const eye = await page.evaluate(() => JSON.parse(window.render_game_to_text()).heightAdaptation.eyeWorld as { x: number; z: number });
  await page.evaluate((yaw) => window.__setMockInput({ lookYaw: yaw }), Math.atan2(-(center('TargetA')[0] - eye.x), -(center('TargetA')[2] - eye.z)));
  await advance(0.6);
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).tap();
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).waitFor();
  await advance(0.5);
  const at = await page.evaluate((point) => window.__projectToScreen(point), center('TargetA'));
  if (!at || at.x < viewport.width * 0.4) throw new Error(`phone: TargetA projects to ${JSON.stringify(at)}, not on the look side`);
  // Moving out of the slop before the hold delay makes it a look drag.
  await touch(cdp, 'touchStart', [{ x: at.x, y: at.y + 60 }]);
  await touch(cdp, 'touchMove', [{ x: at.x + 40, y: at.y + 60 }]);
  await page.waitForTimeout(450);
  const dragPhase = (await holdsOf(page)).touch;
  await touch(cdp, 'touchEnd', []);
  if (dragPhase !== 'idle') failures.push(`a touch moved 40 px before the delay is ${dragPhase}, not a look`);
  await page.evaluate((yaw) => window.__setMockInput({ lookYaw: yaw }), Math.atan2(-(center('TargetA')[0] - eye.x), -(center('TargetA')[2] - eye.z)));
  await advance(0.4);
  await touch(cdp, 'touchStart', [at]);
  await page.waitForTimeout(450);
  await advance(0.1);
  const holdPhase = (await holdsOf(page)).touch;
  if (holdPhase !== 'held') failures.push(`a touch resting 450 ms is ${holdPhase}, not held`);
  const landed = await page.evaluate(() => JSON.parse(window.render_game_to_text()).point as { held: boolean; landed: boolean });
  if (!landed.held || !landed.landed) failures.push(`the touch hold's ray: ${JSON.stringify(landed)}`);
  await advance(1.2);
  await touch(cdp, 'touchEnd', []);
  await advance(0.6);
  // The dock's Halo glyph: held, then dragged left to W; then tapped, and E tapped.
  const glyph = await page.getByRole('img', { name: /^Halo/ }).boundingBox();
  if (!glyph) throw new Error('phone: no Halo glyph in the dock while recording');
  const start = { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 };
  await touch(cdp, 'touchStart', [start]);
  await page.waitForTimeout(450);
  const ringShown = await page.locator('[data-capture-halo] [data-halo-ring], [data-capture-halo] svg circle').count();
  for (const step of [20, 40, 60, 80]) await touch(cdp, 'touchMove', [{ x: start.x - step, y: start.y }]);
  await touch(cdp, 'touchEnd', []);
  await advance(0.2);
  await touch(cdp, 'touchStart', [start]);
  await touch(cdp, 'touchEnd', []);
  await advance(0.2);
  await page.getByRole('button', { name: 'Redo mark' }).tap();
  await advance(0.2);
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).tap();
  for (let i = 0; i < 20; i += 1) await advance(0.05);
  const { glb, links } = await readLinks(run, 'phone', await download, failures);
  const holds = await holdsOf(page);
  expectActions(holds, [{ input: 'touch', action: 'undo', done: true }, { input: 'touch', action: 'redo', done: true }], failures);
  if (links.length !== 1 || !onTarget(links[0]!, 'TargetA') || links[0]!.provenance !== 'recorded') failures.push(`links ${JSON.stringify(links)}, expected one recorded link on TargetA`);
  await page.context().close();
  return { phase: 'phone', glb, links, holds, failures, notes: { touchAt: at, haloGlyph: start, ringElements: ringShown } };
}

// --- Headset (IWER) ---

async function openHeadset(run: HeldMarkRun, mode: 'hand' | 'controller'): Promise<Page> {
  const page = await openPage(run, { viewport: { width: 480, height: 480 }, iwer: true });
  await page.evaluate((input) => {
    window.__setManualClock(true, false);
    window.IWER_DEVICE!.primaryInputMode = input;
  }, mode);
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await page.evaluate(() => {
    window.IWER_DEVICE!.controlMode = 'programmatic';
  });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  await page.evaluate(() => window.__setFrameStepping(true, false));
  return page;
}

const steps = (page: Page, seconds: number) => page.clock.runFor(Math.max(1, Math.round(seconds / (STEP_MS / 1000))) * STEP_MS);

/** Clicks a dock button and steps one frame; the dock still answers clicks in XR. */
const clickByText = (page: Page, text: string) => page.evaluate((name) => {
  [...document.querySelectorAll('button')].find((button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name)?.click();
}, text);

/** Export runs on animation frames; release them until the file lands. */
async function settleDownload(page: Page, downloaded: Promise<Download>): Promise<Download> {
  let settled = false;
  downloaded.then(() => { settled = true; }, () => { settled = true; });
  for (let attempt = 0; attempt < 1200 && !settled; attempt += 1) {
    await page.clock.runFor(100);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return downloaded;
}

async function handsPhase(run: HeldMarkRun): Promise<HeldMarkReport> {
  const failures: string[] = [];
  const page = await openHeadset(run, 'hand');
  await page.evaluate(installHandBlend);
  await page.evaluate(installPointingRig);
  // A thumb–middle pinch per hand: IWER's default pose with the middle
  // fingertip moved onto the thumb tip; the index stays clear of the thumb.
  const pinchGap = await page.evaluate(() => {
    const gaps: Record<string, { middle: number; index: number }> = {};
    for (const side of ['left', 'right'] as const) {
      const hand = window.IWER_DEVICE!.hands[side]!;
      type Pose = { jointTransforms: Record<string, { offsetMatrix: Float32Array; radius: number }>; gripOffsetMatrix?: Float32Array };
      const internals = hand as unknown as Record<symbol, { poses: Record<string, Pose> } | undefined>;
      const key = Object.getOwnPropertySymbols(hand).find((symbol) => internals[symbol]?.poses)!;
      const { poses } = internals[key]!;
      const base = poses.default!;
      const jointTransforms = Object.fromEntries(Object.entries(base.jointTransforms).map(([joint, value]) => [joint, { offsetMatrix: new Float32Array(value.offsetMatrix), radius: value.radius }]));
      const thumb = jointTransforms['thumb-tip']!.offsetMatrix;
      const middle = jointTransforms['middle-finger-tip']!.offsetMatrix;
      const index = jointTransforms['index-finger-tip']!.offsetMatrix;
      for (const i of [12, 13, 14]) middle[i] = thumb[i]!;
      poses.middlePinch = base.gripOffsetMatrix ? { jointTransforms, gripOffsetMatrix: base.gripOffsetMatrix } : { jointTransforms };
      gaps[side] = { middle: 0, index: Math.hypot(index[12]! - thumb[12]!, index[13]! - thumb[13]!, index[14]! - thumb[14]!) };
    }
    return gaps;
  });
  const TIP: Vec3 = [0.26, 1.3, -0.5];
  await page.evaluate((rest) => window.__applyPointState!({ right: { s: 0, rest: rest.right }, left: { pos: rest.left } }), REST);
  await steps(page, 0.5);
  const tipShift = await calibrateTipShift({ page, stepMs: STEP_MS, readRightTip: () => page.evaluate(() => window.__sampleHands().right.tracked['index-finger-tip']!) });
  const shifted = (point: Vec3) => point.map((v, i) => v - tipShift[i]!) as Vec3;
  let rightPos = REST.right;
  type LeftPose = boolean | 'pinch' | 'lost';
  const frame = async ({ s, aim, leftPinch, rightPinch }: { s: number; aim: Vec3; leftPinch: LeftPose; rightPinch: boolean }) => {
    await page.evaluate(({ state, leftPinch, rightPinch, rightPos }) => {
      window.__applyPointState!(state);
      // The hands share IWER's pose table, so its one "blend" pose cannot
      // hold two shapes; a pinching hand takes the pinch pose by id instead.
      const pinch = (side: 'left' | 'right', poseId = 'middlePinch') => {
        const hand = window.IWER_DEVICE!.hands[side]!;
        hand.poseId = poseId;
        hand.updatePinchValue(0);
        hand.updateHandPose();
      };
      const left = window.IWER_DEVICE!.hands.left!;
      if (left.connected !== (leftPinch !== 'lost')) left.connected = leftPinch !== 'lost';
      if (leftPinch === true || leftPinch === 'lost') pinch('left');
      // IWER's own pinch pose: thumb and index, the Grab verb's pinch.
      if (leftPinch === 'pinch') pinch('left', 'pinch');
      if (rightPinch) {
        pinch('right');
        window.IWER_DEVICE!.hands.right!.position.set(...rightPos);
      }
    }, { state: { right: { s, tip: shifted(TIP), aim: shifted(aim), rest: REST.right }, left: { pos: REST.left } }, leftPinch, rightPinch, rightPos });
    await page.clock.runFor(STEP_MS);
  };
  const play = async (seconds: number, state: Parameters<typeof frame>[0] | ((t: number) => Parameters<typeof frame>[0])) => {
    const n = Math.max(1, Math.round(seconds / (STEP_MS / 1000)));
    for (let i = 1; i <= n; i += 1) await frame(typeof state === 'function' ? state(i / n) : state);
  };
  const midHold: unknown[] = [];
  const lost: unknown[] = [];
  const point = async (target: string, mark: LeftPose, lostAfterSec?: number) => {
    await play(0.5, (t) => ({ s: t, aim: center(target), leftPinch: false, rightPinch: false }));
    await play(0.3, { s: 1, aim: center(target), leftPinch: false, rightPinch: false });
    if (lostAfterSec !== undefined) {
      await play(lostAfterSec, { s: 1, aim: center(target), leftPinch: mark, rightPinch: false });
      await play(0.1, { s: 1, aim: center(target), leftPinch: 'lost', rightPinch: false });
      lost.push(await page.evaluate(() => {
        const left = window.__sampleHands().left as unknown as Record<string, unknown>;
        return { holds: window.__sampleHolds().headset.mark, keys: Object.keys(left), source: left.source ?? left.poseSource, tracked: Object.keys((left.tracked ?? {}) as object).length, connected: window.IWER_DEVICE!.hands.left!.connected, sources: [...(window.IWER_DEVICE!.activeSession?.inputSources ?? [])].map((x) => `${x.handedness}:${x.hand ? 'hand' : 'ctl'}`) };
      }));
      await play(0.5, { s: 1, aim: center(target), leftPinch: 'lost', rightPinch: false });
      await play(0.6, { s: 1, aim: center(target), leftPinch: false, rightPinch: false });
      await play(0.5, (t) => ({ s: 1 - t, aim: center(target), leftPinch: false, rightPinch: false }));
      await play(0.6, { s: 0, aim: center(target), leftPinch: false, rightPinch: false });
      return;
    }
    await play(0.6, { s: 1, aim: center(target), leftPinch: mark, rightPinch: false });
    if (mark === true) {
      midHold.push(await page.evaluate(() => {
        const hands = window.__sampleHands();
        const gap = (side: 'left' | 'right', a: string, b: string) => {
          const tracked = hands[side].tracked as Record<string, number[] | undefined>;
          const p = tracked[a];
          const q = tracked[b];
          return p && q ? Number(Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!).toFixed(3)) : null;
        };
        const { mark, pinches, halo } = window.__sampleHolds().headset;
        return { mark: mark.phase, pinches, halo, thumbMiddle: { left: gap('left', 'thumb-tip', 'middle-finger-tip'), right: gap('right', 'thumb-tip', 'middle-finger-tip') }, thumbIndex: { left: gap('left', 'thumb-tip', 'index-finger-tip'), right: gap('right', 'thumb-tip', 'index-finger-tip') } };
      }));
    }
    await play(0.6, { s: 1, aim: center(target), leftPinch: mark, rightPinch: false });
    await play(0.3, { s: 1, aim: center(target), leftPinch: false, rightPinch: false });
    await play(0.5, (t) => ({ s: 1 - t, aim: center(target), leftPinch: false, rightPinch: false }));
    await play(0.6, { s: 0, aim: center(target), leftPinch: false, rightPinch: false });
  };
  // The dominant hand's own thumb–middle pinch, held and dragged.
  const pinchHalo = async (dx: number, dy: number) => {
    const origin: Vec3 = [0.18, 1.3, -0.4];
    rightPos = origin;
    await play(0.5, { s: 0, aim: center('TargetA'), leftPinch: false, rightPinch: true });
    await play(0.4, (t) => {
      rightPos = [origin[0] + dx * t, origin[1] + dy * t, origin[2]];
      return { s: 0, aim: center('TargetA'), leftPinch: false, rightPinch: true };
    });
    await play(0.2, { s: 0, aim: center('TargetA'), leftPinch: false, rightPinch: true });
    rightPos = REST.right;
    await play(0.5, { s: 0, aim: center('TargetA'), leftPinch: false, rightPinch: false });
  };

  await clickByText(page, CONTROL_NAMES.startRecording);
  await steps(page, 0.6);
  await point('TargetA', true);
  const afterA = await holdsOf(page);
  if (afterA.holds.kept !== 1) failures.push(`after the marked point at A: ${JSON.stringify(afterA.holds)}, expected one kept hold (pinch gaps ${JSON.stringify(pinchGap)})`);
  await point('TargetB', true);
  await pinchHalo(-0.12, 0);
  const afterUndo = await holdsOf(page);
  if (afterUndo.holds.kept !== 1 || afterUndo.holds.undone !== 1) failures.push(`after the hand's W: ${JSON.stringify(afterUndo.holds)}, expected one kept and one undone`);
  // An ordinary (thumb–index) pinch on the holding hand never marks.
  await point('TargetB', 'pinch');
  const afterPinch = await holdsOf(page);
  if (afterPinch.holds.kept !== 1 || afterPinch.headset.mark.phase !== 'idle') failures.push(`an ordinary pinch held a mark: ${JSON.stringify(afterPinch.holds)}`);
  // The holding hand lost mid-hold: the mark ends after the grace and keeps what it had.
  await point('TargetA', true, 0.8);
  const afterLoss = await holdsOf(page);
  const lostEnd = afterLoss.headset.log.find((entry) => entry.kind === 'mark' && entry.phase === 'end' && entry.reason === 'trackingLost');
  if (!lostEnd) failures.push(`no mark ended by tracking loss: ${JSON.stringify(afterLoss.headset.log.filter((entry) => entry.kind === 'mark'))}`);
  if (afterLoss.holds.kept !== 2) failures.push(`after the lost hand: ${JSON.stringify(afterLoss.holds)}, expected two kept holds`);
  const downloaded = page.waitForEvent('download', { timeout: 120_000 });
  await pinchHalo(0, -0.12);
  const { glb, links } = await readLinks(run, 'hands', await settleDownload(page, downloaded), failures);
  const holds = await holdsOf(page);
  expectActions(holds, [{ input: 'hands', action: 'undo', done: true }, { input: 'hands', action: 'record', done: true }], failures);
  const recordedA = links.filter((link) => onTarget(link, 'TargetA') && link.provenance === 'recorded');
  if (recordedA.length !== 2) failures.push(`${recordedA.length} recorded link(s) on TargetA, expected 2`);
  for (const held of recordedA) {
    for (const other of links.filter((link) => link.provenance === 'inferred' && overlaps(link, held))) failures.push(`inferred link ${other.to} ${other.start}–${other.end} s overlaps the held mark ${held.start}–${held.end} s`);
  }
  if (!links.some((link) => onTarget(link, 'TargetB') && link.provenance === 'inferred')) failures.push('no inferred link on TargetB: the undone hold should leave the point to inference');
  if (links.some((link) => onTarget(link, 'TargetB') && link.provenance === 'recorded')) failures.push('a recorded link on TargetB survived its undo');
  const markLog = holds.headset.log.filter((entry) => entry.kind === 'mark');
  if (markLog.some((entry) => entry.kind === 'mark' && !entry.input.startsWith('left:'))) failures.push(`a mark held by the dominant hand: ${JSON.stringify(markLog)}`);
  await page.context().close();
  return { phase: 'hands', glb, links, holds, failures, notes: { pinchGap, tipShift, midHold, lost } };
}

async function controllersPhase(run: HeldMarkRun): Promise<HeldMarkReport> {
  const failures: string[] = [];
  const page = await openHeadset(run, 'controller');
  // Puts a controller at `from` (world) and turns its −Z toward a world point.
  const aim = (side: 'left' | 'right', from: Vec3, target: Vec3) => page.evaluate(({ side, from, target }) => {
    const device = window.IWER_DEVICE!;
    const head = window.__sampleChrome().vr.head;
    const offset = [head[0]! - device.position.x, head[1]! - device.position.y, head[2]! - device.position.z];
    const controller = device.controllers[side]!;
    controller.position.set(from[0] - offset[0]!, from[1] - offset[1]!, from[2] - offset[2]!);
    const d = target.map((v, i) => v - from[i]!);
    const length = Math.hypot(...d);
    const [x, y, z] = d.map((v) => v / length) as [number, number, number];
    const w = 1 - z;
    if (w < 1e-6) controller.quaternion.set(0, 1, 0, 0);
    else {
      const half = Math.hypot(y, -x, w);
      controller.quaternion.set(y / half, -x / half, 0, w / half);
    }
  }, { side, from, target });
  const left = (fn: string, ...args: unknown[]) => page.evaluate(({ fn, args }) => {
    const controller = window.IWER_DEVICE!.controllers.left! as unknown as Record<string, (...rest: unknown[]) => void>;
    controller[fn]!(...args);
  }, { fn, args });
  // Left controller out to the side, pointing down: its ray rests on nothing.
  const leftRest = () => aim('left', [-0.3, 1.0, -0.3], [-0.6, 0, -0.4]);
  const stickHalo = async (x: number, y: number) => {
    await left('updateButtonValue', 'thumbstick', 1);
    await steps(page, 0.1);
    await left('updateAxes', 'thumbstick', x, y);
    await steps(page, 0.5);
    await left('updateButtonValue', 'thumbstick', 0);
    await steps(page, 0.1);
    await left('updateAxes', 'thumbstick', 0, 0);
    await steps(page, 0.4);
  };

  await leftRest();
  await aim('right', [0.22, 1.2, -0.3], center('TargetB'));
  await steps(page, 1.0);
  await clickByText(page, CONTROL_NAMES.startRecording);
  await steps(page, 0.6);
  await aim('right', [0.22, 1.2, -0.3], center('TargetA'));
  await steps(page, 0.4);
  await left('updateButtonValue', 'trigger', 1);
  await steps(page, 1.4);
  await left('updateButtonValue', 'trigger', 0);
  await steps(page, 0.6);
  const afterMark = await holdsOf(page);
  const recording = await page.evaluate(() => window.__sampleChrome().ui.recordingState);
  if (recording !== 'recording') failures.push(`the left trigger hold changed the take: ${recording}`);
  if (afterMark.holds.kept !== 1) failures.push(`after the trigger hold: ${JSON.stringify(afterMark.holds)}, expected one kept hold`);
  const marks = afterMark.headset.log.filter((entry) => entry.kind === 'mark').map((entry) => entry.kind === 'mark' && `${entry.input}:${entry.phase}:${entry.reason ?? ''}`);
  if (marks.join(',') !== 'left:trigger:start:,left:trigger:end:release') failures.push(`trigger mark log ${marks.join(', ')}`);
  await aim('right', [0.22, 1.2, -0.3], [0.6, 0, -0.4]);
  await stickHalo(-1, 0);
  const afterUndo = (await holdsOf(page)).holds;
  await stickHalo(1, 0);
  const afterRedo = (await holdsOf(page)).holds;
  if (afterUndo.undone !== 1 || afterRedo.kept !== 1 || afterRedo.undone !== 0) failures.push(`undo then redo: ${JSON.stringify({ afterUndo, afterRedo })}`);
  const downloaded = page.waitForEvent('download', { timeout: 120_000 });
  await stickHalo(0, 1);
  const { glb, links } = await readLinks(run, 'controllers', await settleDownload(page, downloaded), failures);
  const holds = await holdsOf(page);
  expectActions(holds, [
    { input: 'controllers', action: 'undo', done: true },
    { input: 'controllers', action: 'redo', done: true },
    { input: 'controllers', action: 'record', done: true }
  ], failures);
  if (links.length !== 1 || !onTarget(links[0]!, 'TargetA') || links[0]!.provenance !== 'recorded') failures.push(`links ${JSON.stringify(links)}, expected one recorded link on TargetA`);
  await page.context().close();
  return { phase: 'controllers', glb, links, holds, failures, notes: {} };
}


const PHASES: Record<HeldMarkPhase, (run: HeldMarkRun) => Promise<HeldMarkReport>> = { desktop: desktopPhase, phone: phonePhase, hands: handsPhase, controllers: controllersPhase };

/** Records one phase's take and scores its export; the report's `glb` is the file. */
export function runHeldMarkPhase(run: HeldMarkRun, phase: HeldMarkPhase): Promise<HeldMarkReport> {
  return PHASES[phase](run);
}
