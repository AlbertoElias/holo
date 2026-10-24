import type {} from 'three';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright';

import { apxToMeters, hitAreaMeters, tokens } from '@holoim/design-tokens';
import { CONTROL_NAMES, PHONE_EDGES, glyphMetrics, recordingText } from '@holoim/xr-ui-core';
import type {} from '../src/runtime/automationHooks';
import type { VrChromeSnapshot } from '../src/ui/VrChrome';

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

// Capture's chrome on every target (docs/features/ui-redesign.md, slice 4),
// chosen from the brief's failure cases:
// - desktop: the dock, the side sheet, handedness stored per device, fonts,
//   and only stop and "Recording 0:12" while a take runs;
// - phone (390 × 844, touch): 44 apx targets clear of the gesture zones and
//   insets, touch words not keyboard help, touch-action on the scene, and
//   look, walk and record by touch;
// - headset (IWER): the record glyph on the non-dominant wrist, nothing
//   head-locked but the status line, no text within 1 m, hit sizes per input,
//   ray and poke commits with their feedback, the fingertip shade, handedness
//   swapping the wrist and the tray hand, and a take whose GLB is the same
//   bytes with chrome shown, hidden, or a chrome-flagged probe in the scene.
// Writes the placement, label-distance and handedness report.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5274/';
const artifacts = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-capture-ui';
await mkdir(artifacts, { recursive: true });

type Box = { x: number; y: number; width: number; height: number };
type Vec3 = [number, number, number];
interface TextState {
  mode: string;
  character: { position: { x: number; y: number; z: number } };
  input: { forward: boolean; back: boolean; left: boolean; right: boolean };
  avatar: { yaw: number };
  objects: { tray: { gesture: { held: boolean; source: string; palmUp: number | null } } };
}

const report: Record<string, unknown> = {};
const consoleErrors: string[] = [];
const browser = await launchXrBrowser(chromium);

function stage(label: string): void {
  console.log(`[capture-ui] ${label}`);
}
function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}
function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}
async function text(page: Page): Promise<TextState> {
  return page.evaluate(() => JSON.parse(window.render_game_to_text()) as TextState);
}
async function open(context: BrowserContext, query: Record<string, string> = {}): Promise<Page> {
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors);
  const url = new URL(baseUrl);
  url.searchParams.set('manualClock', '1');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text', '__sampleChrome']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  return page;
}
async function dockBoxes(page: Page): Promise<Array<{ name: string; box: Box }>> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-capture-dock] button')].map((element) => {
    const rect = element.getBoundingClientRect();
    return { name: element.getAttribute('aria-label') ?? element.textContent ?? '', box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }));
}
async function dockContents(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-capture-dock] button, [data-capture-dock] time')].map((element) => element.getAttribute('aria-label') ?? element.textContent ?? ''));
}

// --- Desktop ---

async function desktopPhase(): Promise<void> {
  const context = await createXrContext(browser, { viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await open(context);
  const dock = await dockBoxes(page);
  for (const { name, box } of dock) assert(Math.min(box.width, box.height) >= tokens.hit.mouse - 0.5, `desktop: ${name} hit ${box.width}×${box.height} under the mouse minimum`);
  assert(dock.some(({ name }) => name === CONTROL_NAMES.startRecording), 'desktop: Record is in the dock');
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    const settings = [...document.querySelectorAll<HTMLElement>('[data-capture-dock] button')].find((element) => element.textContent === 'Settings')!;
    // The word a control draws in place of a glyph carries the type.
    const style = getComputedStyle(settings.querySelector('[data-glyph-word]') ?? settings);
    const loaded = [...document.fonts].filter((face) => face.family.replace(/"/g, '') === 'Figtree' && face.status === 'loaded').map((face) => face.weight);
    return { family: style.fontFamily, weight: style.fontWeight, loaded };
  });
  assert(/^"?Figtree"?,/.test(font.family) && font.loaded.some((range) => { const [low = 0, high = low] = range.split(' ').map(Number); return Number(font.weight) >= low && Number(font.weight) <= high; }), `desktop: dock type is Figtree (${font.family}, loaded ${font.loaded})`);

  // Settings: the side sheet, handedness stored per device.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  const keysText = await page.getByRole('dialog').textContent();
  assert(keysText?.includes('W, A, S and D'), 'desktop: the sheet carries keyboard words');
  // By keyboard: Space on a focused radio chooses it.
  await page.getByRole('radio', { name: 'Left-handed' }).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.getByRole('radio', { name: 'Left-handed' }).getAttribute('aria-checked'), 'true', 'desktop: Space chooses a handedness radio');
  assert.equal(await page.getByRole('radio', { name: 'Right-handed' }).getAttribute('aria-checked'), 'false');
  assert(keysText !== null && (await page.getByRole('dialog').textContent())?.includes('Left-handed: in a headset, Record sits on your right wrist'), 'desktop: the choice is said in words');
  assert.equal(await page.evaluate(() => localStorage.getItem('holoim.handedness')), 'left', 'desktop: handedness stored per device');
  await page.reload({ waitUntil: 'networkidle' });
  await waitForTextContentPrefix(page, '#status', 'loaded');
  const reloaded = await page.evaluate(() => window.__sampleChrome().ui.handedness);
  assert.equal(reloaded, 'left', 'desktop: handedness survives a reload');
  await page.evaluate(() => localStorage.removeItem('holoim.handedness'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForTextContentPrefix(page, '#status', 'loaded');
  assert.equal(await page.evaluate(() => window.__sampleChrome().ui.handedness), 'right', 'desktop: right-handed by default');

  // While a take runs only stop and the running time show.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).click();
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).waitFor();
  await page.evaluate(() => window.advanceTime(2100));
  const recordingDock = await dockContents(page);
  assert.deepEqual(recordingDock, [CONTROL_NAMES.stopRecording, 'Recording 0:02'], `desktop: recording chrome is stop and the time (${recordingDock.join(', ')})`);
  assert.equal(await page.getByRole('dialog').count(), 0, 'desktop: no side sheet while recording');
  const shape = await page.locator('[data-capture-dock] button[aria-label="Stop Recording"] rect').count();
  assert(shape >= 1, 'desktop: stop is the rounded square (shape, not colour)');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).click();
  for (let i = 0; i < 20; i += 1) await page.evaluate(() => window.advanceTime(50));
  await download;
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(artifacts, 'desktop.png') });
  report.desktop = { dock: dock.map(({ name, box }) => ({ name, width: round(box.width, 1), height: round(box.height, 1) })), font, recordingDock };
  await context.close();
}

// --- Phone ---

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id: number }>): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : points.map(({ x, y, id }) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
}

async function phonePhase(): Promise<void> {
  const viewport = { width: 390, height: 844 };
  const context = await createXrContext(browser, { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, acceptDownloads: true });
  const page = await open(context);
  const cdp = await context.newCDPSession(page);
  const dock = await dockBoxes(page);
  const zones = { side: PHONE_EDGES.side, bottom: PHONE_EDGES.bottom };
  for (const { name, box } of dock) {
    assert(box.width >= tokens.hit.touch - 0.5 && box.height >= tokens.hit.touch - 0.5, `phone: ${name} ${box.width}×${box.height} under 44 apx`);
    assert(box.x >= zones.side && box.x + box.width <= viewport.width - zones.side, `phone: ${name} enters a back-swipe edge`);
    assert(box.y + box.height <= viewport.height - zones.bottom, `phone: ${name} enters the home bar`);
  }
  const touchAction = await page.evaluate(() => getComputedStyle(document.querySelector('#app canvas')!).touchAction);
  assert.equal(touchAction, 'none', 'phone: the scene takes touch, the page does not scroll');

  await page.getByRole('button', { name: 'Settings' }).tap();
  const sheet = await page.getByRole('dialog', { name: 'Settings' }).textContent();
  assert(sheet?.includes('Drag on the left of the screen to walk') && !sheet.includes('W, A, S'), 'phone: touch words, never keyboard help');
  await page.getByRole('button', { name: 'Close' }).tap();
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  // Look: a drag on the right of the scene turns the view.
  const before = await text(page);
  await touch(cdp, 'touchStart', [{ x: 300, y: 400, id: 1 }]);
  for (let step = 1; step <= 6; step += 1) await touch(cdp, 'touchMove', [{ x: 300 - step * 15, y: 400, id: 1 }]);
  await touch(cdp, 'touchEnd', []);
  const looked = await text(page);
  assert(looked.avatar.yaw - before.avatar.yaw > 0.3, `phone: dragging left turns the view left (${before.avatar.yaw} → ${looked.avatar.yaw})`);

  // A touch in the back-swipe edge is the system's.
  await touch(cdp, 'touchStart', [{ x: zones.side / 2, y: 600, id: 2 }]);
  await touch(cdp, 'touchMove', [{ x: zones.side / 2, y: 540, id: 2 }]);
  const edge = await page.evaluate(() => window.__sampleChrome().touch);
  await touch(cdp, 'touchEnd', []);
  assert.equal(edge.stick, null, 'phone: no stick from the gesture edge');
  const homeBar = await text(page);
  await touch(cdp, 'touchStart', [{ x: 100, y: viewport.height - zones.bottom / 2, id: 4 }]);
  await touch(cdp, 'touchMove', [{ x: 160, y: viewport.height - zones.bottom / 2 - 30, id: 4 }]);
  const bar = await page.evaluate(() => window.__sampleChrome().touch);
  await touch(cdp, 'touchEnd', []);
  assert(bar.stick === null && bar.looking === 0 && (await text(page)).avatar.yaw === homeBar.avatar.yaw, 'phone: no stick and no look from the home bar');

  // Walk: the stick appears under the finger on the left; up walks forward.
  const start = await text(page);
  await touch(cdp, 'touchStart', [{ x: 100, y: 600, id: 3 }]);
  await touch(cdp, 'touchMove', [{ x: 100, y: 540, id: 3 }]);
  const stick = await page.evaluate(() => ({ chrome: window.__sampleChrome().touch, ring: getComputedStyle(document.querySelector('[data-touch-stick="ring"]')!).display }));
  const walking = await text(page);
  await page.evaluate(() => window.advanceTime(1000));
  const walked = await text(page);
  await touch(cdp, 'touchEnd', []);
  const stopped = await text(page);
  assert(stick.chrome.stick && stick.ring === 'block', 'phone: the stick shows while held');
  assert(walking.input.forward && !walking.input.back, 'phone: up on the stick walks forward');
  const moved = Math.hypot(walked.character.position.x - start.character.position.x, walked.character.position.z - start.character.position.z);
  assert(moved > 0.5, `phone: the character walked (${moved.toFixed(2)} m)`);
  assert(!stopped.input.forward, 'phone: release stops walking');

  // Record by touch.
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).tap();
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).waitFor();
  await page.evaluate(() => window.advanceTime(1100));
  const recordingDock = await dockContents(page);
  assert.deepEqual(recordingDock, [CONTROL_NAMES.stopRecording, 'Recording 0:01'], 'phone: recording chrome is stop and the time');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: CONTROL_NAMES.stopRecording }).tap();
  for (let i = 0; i < 20; i += 1) await page.evaluate(() => window.advanceTime(50));
  await download;
  await page.getByRole('button', { name: CONTROL_NAMES.startRecording }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(artifacts, 'phone.png') });
  report.phone = {
    viewport,
    zones,
    dock: dock.map(({ name, box }) => ({ name, box: { x: round(box.x, 1), y: round(box.y, 1), width: round(box.width, 1), height: round(box.height, 1) } })),
    look: { yawBefore: round(before.avatar.yaw), yawAfter: round(looked.avatar.yaw) },
    walk: { movedM: round(moved, 3) },
    recordingDock
  };
  await context.close();
}

// --- Headset ---

async function frames(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await page.clock.runFor(17);
    await page.evaluate(() => window.advanceTime(1000 / 60));
  }
}
/** Steps frames until the page predicate holds; polling on rAF stalls under the frozen clock. */
async function until(page: Page, predicate: () => boolean, label: string, maxFrames = 600): Promise<void> {
  for (let i = 0; i < maxFrames; i += 10) {
    if (await page.evaluate(predicate)) return;
    await frames(page, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`headset: timed out waiting for ${label}`);
}
async function chrome(page: Page): Promise<VrChromeSnapshot> {
  return page.evaluate(() => window.__sampleChrome().vr);
}
/**
 * Puts a controller at `from` (world) and turns its −Z toward a world point.
 * The rig carries a translation but no rotation, so the head's world-minus-
 * device offset maps world points into device space.
 */
async function aim(page: Page, side: 'left' | 'right', from: Vec3, target: readonly number[]): Promise<void> {
  await page.evaluate(({ side, from, target }) => {
    const device = window.IWER_DEVICE!;
    const head = window.__sampleChrome().vr.head;
    const offset = [head[0]! - device.position.x, head[1]! - device.position.y, head[2]! - device.position.z];
    const controller = device.controllers[side]!;
    controller.position.set(from[0] - offset[0]!, from[1] - offset[1]!, from[2] - offset[2]!);
    const dx = target[0]! - from[0];
    const dy = target[1]! - from[1];
    const dz = target[2]! - from[2];
    const length = Math.hypot(dx, dy, dz);
    // The shortest rotation taking (0, 0, −1) onto the aim, as a quaternion.
    const [x, y, z] = [dx / length, dy / length, dz / length];
    const w = 1 - z;
    if (w < 1e-6) controller.quaternion.set(0, 1, 0, 0);
    else {
      const half = Math.hypot(y, -x, w);
      controller.quaternion.set(y / half, -x / half, 0, w / half);
    }
  }, { side, from, target: [...target] });
}
async function select(page: Page, side: 'left' | 'right'): Promise<void> {
  await page.evaluate((hand) => window.IWER_DEVICE!.controllers[hand]!.updateButtonValue('trigger', 1), side);
  await frames(page, 2);
  await page.evaluate((hand) => window.IWER_DEVICE!.controllers[hand]!.updateButtonValue('trigger', 0), side);
  await frames(page, 2);
}
/** Moves the dominant hand so its index tip sits `heightM` above the wrist glyph's centre. */
async function pokeTo(page: Page, side: 'left' | 'right', heightM: number): Promise<VrChromeSnapshot> {
  for (let pass = 0; pass < 4; pass += 1) {
    const snapshot = await chrome(page);
    const target = await page.evaluate(() => window.__chromeTarget('record'));
    assert(snapshot.poke.tip && snapshot.poke.glyphNormal && target, 'headset: poke needs a tracked tip and the glyph');
    const goal = target.map((value, i) => value + snapshot.poke.glyphNormal![i]! * heightM);
    const delta = goal.map((value, i) => value - snapshot.poke.tip![i]!);
    await page.evaluate(({ side, delta }) => {
      const hand = window.IWER_DEVICE!.hands[side]!;
      hand.position.set(hand.position.x + delta[0]!, hand.position.y + delta[1]!, hand.position.z + delta[2]!);
    }, { side, delta });
    await frames(page, 2);
  }
  return chrome(page);
}

function placement(snapshot: VrChromeSnapshot): Record<string, unknown> {
  return {
    handedness: snapshot.handedness,
    wrist: snapshot.wrist && { hand: snapshot.wrist.hand, input: snapshot.wrist.input, offsetFromWristM: snapshot.wrist.anchor ? round(distance(snapshot.wrist.position, snapshot.wrist.anchor)) : null, hitSizeM: round(snapshot.wrist.hitSizeM), drawnSizeM: round(snapshot.wrist.drawnSizeM) },
    panel: snapshot.panel && { visible: snapshot.panel.visible, distanceFromHeadM: round(snapshot.panel.distanceFromHeadM), rows: snapshot.panel.rows.map((row) => ({ id: row.id, text: row.text, distanceFromHeadM: round(row.distanceFromHeadM), hitHeightM: round(row.hitHeightM) })) },
    statusLine: snapshot.statusLine && { visible: snapshot.statusLine.visible, text: snapshot.statusLine.text, distanceFromHeadM: round(snapshot.statusLine.distanceFromHeadM) },
    labels: snapshot.labels.map((label) => ({ name: label.name, text: label.text, distanceFromHeadM: round(label.distanceFromHeadM) }))
  };
}
function assertNoNearText(snapshot: VrChromeSnapshot, label: string): void {
  for (const shown of snapshot.labels) assert(shown.distanceFromHeadM >= tokens.type.headsetLabelMinDistanceM, `${label}: "${shown.text}" shows ${shown.distanceFromHeadM.toFixed(2)} m from the head`);
}

async function headsetPhase(): Promise<void> {
  const context = await createXrContext(browser, { viewport: { width: 480, height: 480 }, acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors);
  await attachXrEnvironment(page, { mode: 'iwer', cacheClearState: true });
  await page.route('**/__holoim/input-recordings**', (route) => route.fulfill({ json: { path: 'ui-test-input.json' } }));
  const url = new URL(baseUrl);
  url.searchParams.set('scene', '/fixtures/scenes/body-floor.gltf');
  url.searchParams.set('sceneScale', '1');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['__setManualClock', 'render_game_to_text', 'advanceTime', '__sampleChrome']);
  await waitForTextContentPrefix(page, '#status', 'loaded');
  await waitForIwerRuntime(page);
  await page.evaluate(() => {
    window.__setManualClock(true, false);
    window.advanceTime(2000);
    window.__setRetainLastTake(true);
    const device = window.IWER_DEVICE!;
    device.controlMode = 'programmatic';
    device.primaryInputMode = 'controller';
    device.position.set(0, 1.6, 0);
    device.quaternion.set(0, 0, 0, 1);
    device.controllers.left!.position.set(-0.22, 1.1, -0.3);
    device.controllers.right!.position.set(0.22, 1.1, -0.3);
  });
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
  // Text loads its atlases on real time; let it arrive, then settle the height fit.
  await until(page, () => window.__sampleChrome().vr.panel !== null, 'the headset text to load');
  await frames(page, 90);

  const idle = await chrome(page);
  const unscaledRing = glyphMetrics({ headset: false }).ringApx;
  assert(idle.wrist?.visible && idle.wrist.hand === 'left' && idle.wrist.input === 'ray', `headset: record on the left wrist for a right-handed controller user (${JSON.stringify(idle.wrist)})`);
  assert(Math.abs(distance(idle.wrist.position, idle.wrist.anchor!) - tokens.placement.wristOffsetM) < 0.002, 'headset: the wrist row sits 4 cm off the wrist');
  assert(Math.abs(idle.wrist.drawnSizeM - apxToMeters(unscaledRing, tokens.placement.armReachM, { headset: true })) < 1e-6, 'headset: the record ring is drawn at 2.5×');
  assert(idle.wrist.hitSizeM >= hitAreaMeters('ray', unscaledRing * tokens.size.headsetScale, tokens.placement.armReachM, { headset: false }) - 1e-6, 'headset: the record glyph takes a ray minimum');
  assert(idle.panel?.visible && idle.panel.distanceFromHeadM >= tokens.placement.worldPanelMinM, `headset: settings on a world panel 1 m away or more (${idle.panel?.distanceFromHeadM})`);
  for (const row of idle.panel.rows) assert(row.hitHeightM >= hitAreaMeters('ray', 0, idle.panel.distanceFromHeadM, { headset: false }) - 1e-3, `headset: row ${row.id} hit under a ray minimum`);
  assert(!idle.statusLine?.visible, 'headset: the status line holds nothing while idle');
  assertNoNearText(idle, 'headset idle');

  // Nothing but the status line follows the head: walk and turn it.
  await page.evaluate(() => {
    const device = window.IWER_DEVICE!;
    device.position.set(0.3, 1.5, 0.2);
    device.quaternion.set(0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12));
  });
  await frames(page, 10);
  const walkedHead = await chrome(page);
  const panelMoved = distance(walkedHead.panel!.position, idle.panel.position);
  const wristMoved = distance(walkedHead.wrist!.position, idle.wrist.position);
  assert(panelMoved < 1e-4, `headset: the world panel stays as the head moves (${panelMoved})`);
  // The head moves 36 cm and turns 30°; the rig's height and body settle may nudge the grip by under a millimetre.
  assert(wristMoved < 0.005, `headset: the wrist row follows the wrist, not the head (${wristMoved})`);
  await page.evaluate(() => {
    const device = window.IWER_DEVICE!;
    device.position.set(0, 1.6, 0);
    device.quaternion.set(0, 0, 0, 1);
  });
  await frames(page, 10);

  stage('headset: ray record');
  // Record with the dominant controller's ray on the wrist glyph.
  const record = (await page.evaluate(() => window.__chromeTarget('record')))!;
  await aim(page, 'right', [0.15, 1.35, -0.15], record);
  await frames(page, 3);
  const hovering = await chrome(page);
  // Held on a controller the glyph sits inside the avatar's sleeve: it must still be seen.
  assert(hovering.wrist && (hovering.wrist.occludedBy === null || hovering.wrist.drawnOverBody), `headset: Record is in view on a controller (behind ${hovering.wrist?.occludedBy})`);
  assert.equal(hovering.rays.find((ray) => ray.side === 'right')?.hit, 'record', 'headset: the right ray rests on the record glyph');
  await select(page, 'right');
  await until(page, () => window.__sampleChrome().ui.recordingState === 'recording', 'the take to start');
  await frames(page, 70);
  const recording = await chrome(page);
  // XR frames under load can run ahead of the manual clock by a frame or two,
  // so the line must carry the take's own running time, whatever second it is.
  const elapsedMs = await page.evaluate(() => window.__sampleChrome().ui.recordingElapsedMs);
  assert(elapsedMs >= 1000 && recording.statusLine?.visible && recording.statusLine.text === recordingText(elapsedMs), `headset: "${recordingText(elapsedMs)}" on the periphery status line (${recording.statusLine?.text})`);
  assert(recording.wrist?.visible && recording.wrist.recording, 'headset: the wrist carries stop');
  assert(!recording.panel?.visible, 'headset: the world panel hides while recording');
  assert(recording.labels.length === 1 && recording.labels[0]!.text.startsWith('Recording'), `headset: only the running time is text while recording (${recording.labels.map((l) => l.text).join(', ')})`);
  assert(recording.rays.every((ray) => !ray.visible || ray.hit === 'record'), 'headset: rays show only on the stop control while recording');
  assertNoNearText(recording, 'headset recording');

  stage('headset: status line follow');
  // The status line follows lazily: still within 20 degrees, then back.
  // The line eases in when the take starts; measure the follow once it rests.
  let statusBefore = recording.statusLine.position;
  for (let i = 0; i < 30; i += 1) {
    await frames(page, 5);
    const now = (await chrome(page)).statusLine!.position;
    const settled = distance(now, statusBefore) < 1e-4;
    statusBefore = now;
    if (settled) break;
  }
  await page.evaluate(() => window.IWER_DEVICE!.quaternion.set(0, Math.sin((10 * Math.PI) / 360), 0, Math.cos((10 * Math.PI) / 360)));
  await frames(page, 10);
  const small = await chrome(page);
  await page.evaluate(() => window.IWER_DEVICE!.quaternion.set(0, Math.sin((40 * Math.PI) / 360), 0, Math.cos((40 * Math.PI) / 360)));
  await frames(page, 60);
  const large = await chrome(page);
  assert(distance(small.statusLine!.position, statusBefore) < 1e-3, `headset: a 10° turn leaves the status line where it is (moved ${distance(small.statusLine!.position, statusBefore).toFixed(4)} m)`);
  assert(distance(large.statusLine!.position, statusBefore) > 0.3, 'headset: a 40° turn brings the status line back');
  await page.evaluate(() => window.IWER_DEVICE!.quaternion.set(0, 0, 0, 1));
  await frames(page, 60);

  stage('headset: poke stop');
  // Stop with a poke: switch to hands; the wrist takes the poke minimum.
  await page.evaluate(() => {
    window.IWER_DEVICE!.primaryInputMode = 'hand';
    window.IWER_DEVICE!.hands.left!.position.set(-0.2, 1.15, -0.3);
    window.IWER_DEVICE!.hands.right!.position.set(0.2, 1.15, -0.3);
  });
  await frames(page, 20);
  const hands = await chrome(page);
  assert(hands.wrist && (hands.wrist.occludedBy === null || hands.wrist.drawnOverBody), `headset: Record is in view on a tracked hand (behind ${hands.wrist?.occludedBy})`);
  assert(hands.wrist?.input === 'poke', `headset: a tracked dominant hand pokes (${hands.wrist?.input})`);
  assert(hands.wrist.hitSizeM >= Math.max(tokens.hit.pokeFloorMm / 1000, hitAreaMeters('poke', 0, tokens.placement.armReachM, { headset: false })) - 1e-6, 'headset: a poke hit area of 72 apx and at least 20 mm');
  const approach = await pokeTo(page, 'right', 0.06);
  assert(approach.fingertipShade.visible && approach.fingertipShade.radiusM > hands.wrist.drawnSizeM / 2, 'headset: the fingertip shade shows, wide, before contact');
  const nearer = await pokeTo(page, 'right', 0.02);
  assert(nearer.fingertipShade.radiusM < approach.fingertipShade.radiusM, 'headset: the shade sharpens as the finger nears');
  const download = page.waitForEvent('download');
  await pokeTo(page, 'right', -0.005);
  await until(page, () => window.__sampleChrome().ui.recordingState !== 'recording', 'the poke to stop the take');
  // A held finger is one press: it never toggles again until it lifts away.
  await frames(page, 30);
  const poked = await chrome(page);
  assert.equal(poked.feedback.ticks, hands.feedback.ticks + 1, 'headset: one poke, one tick');
  assert.equal(poked.feedback.commits, hands.feedback.commits + 1, 'headset: one poke, one commit');
  await page.evaluate(() => window.IWER_DEVICE!.hands.right!.position.set(0.2, 1.15, -0.3));
  for (let i = 0; i < 20; i += 1) {
    await page.clock.runFor(50);
    await page.evaluate(() => window.advanceTime(50));
  }
  const glb = path.join(artifacts, 'headset-take.glb');
  await (await download).saveAs(glb);
  await until(page, () => window.__sampleChrome().ui.recordingState === 'idle', 'the export to finish');
  // A fingertip that arrives behind the face, never above it, does not start a take.
  await frames(page, 10);
  const away = await chrome(page);
  await pokeTo(page, 'right', -0.02);
  await frames(page, 10);
  const behind = await chrome(page);
  assert.equal(await page.evaluate(() => window.__sampleChrome().ui.recordingState), 'idle', 'headset: a tip arriving from behind the glyph does not start a take');
  assert.equal(behind.feedback.commits, away.feedback.commits, 'headset: no commit from behind');
  await page.evaluate(() => window.IWER_DEVICE!.hands.right!.position.set(0.2, 1.15, -0.3));
  await frames(page, 10);

  stage('headset: export bytes');
  // A take without marks: the same bytes with chrome shown, hidden, or a
  // chrome-flagged probe in the scene; a plain probe changes them (control).
  // The exporter clones the live avatar, so each comparison is a re-export at
  // the same frozen moment, with a repeat as the determinism control; the
  // download carries the pose of the moment it was taken.
  const downloaded = digest(await readFile(glb));
  const shown = await reexport(page);
  const repeat = await reexport(page);
  await page.evaluate(() => window.__setChromeVisible(false));
  const hidden = await reexport(page);
  await page.evaluate(() => window.__setChromeVisible(true));
  await page.evaluate(() => window.__setChromeProbe('flagged'));
  const flagged = await reexport(page);
  await page.evaluate(() => window.__setChromeProbe('chrome'));
  const chromeInWorld = await reexport(page);
  await page.evaluate(() => window.__setChromeProbe('plain'));
  const plain = await reexport(page);
  await page.evaluate(() => window.__setChromeProbe('none'));
  assert(shown && shown.byteLength > 0, 'export: the take re-exports');
  assert.equal(repeat?.canonical, shown.canonical, 'export: re-exporting is deterministic');
  assert.equal(hidden?.canonical, shown.canonical, 'export: hiding chrome changes no byte');
  assert.equal(flagged?.canonical, shown.canonical, 'export: a chrome-flagged mesh in the scene changes no byte');
  // Chrome hangs off the scene, outside what the exporter walks; inside the
  // scene model is the case the flag exists for.
  assert.equal(chromeInWorld?.canonical, shown.canonical, 'export: every headset chrome object, visible inside the scene model, changes no byte');
  assert.notEqual(plain?.canonical, shown.canonical, 'export control: a plain mesh in the same place is exported');
  report.export = { downloaded, chromeShown: shown, repeat, chromeHidden: hidden, flaggedProbe: flagged, chromeInSceneModel: chromeInWorld, plainProbe: plain };

  stage('headset: handedness');
  // Handedness: the panel row swaps it; the wrist and the tray hand follow.
  await page.evaluate(() => {
    window.IWER_DEVICE!.primaryInputMode = 'controller';
    window.IWER_DEVICE!.controllers.left!.position.set(-0.22, 1.1, -0.3);
    window.IWER_DEVICE!.controllers.right!.position.set(0.22, 1.1, -0.3);
  });
  await frames(page, 20);
  const right = await chrome(page);
  const handRow = (await page.evaluate(() => window.__chromeTarget('hand')))!;
  const refitRow = (await page.evaluate(() => window.__chromeTarget('refit')))!;
  // The non-dominant ray rests on Refit while the dominant selects the hand row: only the firing ray commits.
  await aim(page, 'left', [-0.15, 1.35, -0.15], refitRow);
  await aim(page, 'right', [0.15, 1.35, -0.15], handRow);
  await frames(page, 3);
  await select(page, 'right');
  await frames(page, 10);
  const left = await chrome(page);
  assert.equal(left.feedback.commits, right.feedback.commits + 1, 'handedness: one select, one commit');
  assert(!(await page.evaluate(() => window.__sampleChrome().ui.heightFit.pending)), 'handedness: the ray resting on Refit did not refit');
  const stored = await page.evaluate(() => localStorage.getItem('holoim.handedness'));
  assert.equal(left.handedness, 'left', 'handedness: the panel row swaps it');
  assert.equal(stored, 'left', 'handedness: stored per device');
  assert.equal(left.wrist?.hand, 'right', 'handedness: the record glyph moves to the right wrist');
  // Left-handed, the left ray presses Record on the right wrist; the right
  // ray never does. (Record rides the right controller, so it stays put.)
  await page.evaluate(() => window.IWER_DEVICE!.controllers.right!.position.set(0.22, 1.1, -0.3));
  await frames(page, 3);
  const leftRecord = (await page.evaluate(() => window.__chromeTarget('record')))!;
  await aim(page, 'left', [-0.1, 1.35, -0.15], leftRecord);
  await frames(page, 3);
  const leftRays = await chrome(page);
  assert.equal(leftRays.rays.find((ray) => ray.side === 'left')?.hit, 'record', 'handedness: the dominant (left) ray rests on Record');
  assert.equal(leftRays.rays.find((ray) => ray.side === 'right')?.hit ?? null, null, 'handedness: the carrying (right) ray never reaches its own wrist');
  const tray = await trayHands(page);
  assert(tray.right.held && !tray.left.held, `handedness: the left-handed hold the tray with the right palm (${JSON.stringify(tray)})`);
  // Back to right-handed: the left ray on the hand row now.
  await aim(page, 'right', [0.15, 1.1, -0.3], [0.15, 0, -2]);
  await aim(page, 'left', [-0.15, 1.35, -0.15], handRow);
  await frames(page, 3);
  await select(page, 'left');
  await frames(page, 10);
  const restored = await chrome(page);
  assert.equal(restored.handedness, 'right', 'handedness: the dominant (left) ray swaps it back');
  const trayRight = await trayHands(page);
  assert(trayRight.left.held && !trayRight.right.held, `handedness: the right-handed hold the tray with the left palm (${JSON.stringify(trayRight)})`);

  stage('headset: one controller');
  // One controller on: a select commits once, and the wrist does not ride the pointing hand.
  await page.evaluate(() => { window.IWER_DEVICE!.controllers.left!.connected = false; });
  await frames(page, 10);
  await aim(page, 'right', [0.15, 1.35, -0.15], handRow);
  await frames(page, 3);
  const lone = await chrome(page);
  await select(page, 'right');
  await frames(page, 10);
  const loneAfter = await chrome(page);
  assert(!lone.wrist?.visible, `one controller: Record hides with the carrying controller gone (${JSON.stringify(lone.wrist)})`);
  assert.equal(loneAfter.handedness, 'left', 'one controller: one select swaps handedness once');
  assert.equal(loneAfter.feedback.commits, lone.feedback.commits + 1, 'one controller: one select, one commit');
  await select(page, 'right');
  await frames(page, 10);
  await page.evaluate(() => { window.IWER_DEVICE!.controllers.left!.connected = true; });
  await frames(page, 10);
  assert.equal((await chrome(page)).handedness, 'right', 'one controller: swapped back');

  stage('headset: labels within 1 m');
  // Step to 0.8 m from the panel: its labels hide, and a hidden row takes no hits.
  const panelAt = (await chrome(page)).panel!.position;
  // Walk there in 10 cm steps: one large jump reads as a tracking jump, and the rig absorbs it.
  for (let step = 0; step < 20; step += 1) {
    const remaining = await page.evaluate((at) => {
      const device = window.IWER_DEVICE!;
      const head = window.__sampleChrome().vr.head;
      const dx = at[0]! - head[0]!;
      const dz = at[2]! + 0.8 - head[2]!;
      const length = Math.hypot(dx, dz);
      const move = Math.min(0.1, length);
      if (length > 1e-3) device.position.set(device.position.x + (dx / length) * move, device.position.y, device.position.z + (dz / length) * move);
      return length;
    }, panelAt);
    await frames(page, 3);
    if (remaining < 0.02) break;
  }
  await frames(page, 10);
  const nearRow = (await page.evaluate(() => window.__chromeTarget('hand')))!;
  const nearHead = (await chrome(page)).head;
  await aim(page, 'right', [nearHead[0]! + 0.15, nearHead[1]! - 0.25, nearHead[2]! - 0.15], nearRow);
  await frames(page, 3);
  const close = await chrome(page);
  assert(distance(close.head, panelAt) < tokens.type.headsetLabelMinDistanceM, `labels: the head is within 1 m of the panel (${distance(close.head, panelAt).toFixed(2)} m)`);
  assert.deepEqual(close.labels, [], `labels: none shows within 1 m (${close.labels.map((l) => `${l.text} ${l.distanceFromHeadM.toFixed(2)} m`).join(', ')})`);
  assert.equal(close.rays.find((ray) => ray.side === 'right')?.hit ?? null, null, 'labels: a row hidden within 1 m takes no hits');
  await page.evaluate(() => window.IWER_DEVICE!.position.set(0, 1.6, 0));
  await frames(page, 10);

  await page.screenshot({ path: path.join(artifacts, 'headset.png') });
  report.headset = {
    idle: placement(idle),
    walkedHead: { panelMovedM: panelMoved, wristMovedM: wristMoved },
    recording: placement(recording),
    statusLineFollow: { after10DegM: round(distance(small.statusLine!.position, statusBefore)), after40DegM: round(distance(large.statusLine!.position, statusBefore)) },
    wristInView: { controller: { occludedBy: hovering.wrist.occludedBy, drawnOverBody: hovering.wrist.drawnOverBody }, hand: { occludedBy: hands.wrist.occludedBy, drawnOverBody: hands.wrist.drawnOverBody } },
    poke: { hitSizeM: round(hands.wrist.hitSizeM), shadeRadiusAt6cmM: round(approach.fingertipShade.radiusM), shadeRadiusAt2cmM: round(nearer.fingertipShade.radiusM), ticks: poked.feedback.ticks },
    feedback: poked.feedback,
    handedness: { right: placement(right), left: placement(left), trayLeftHanded: tray, trayRightHanded: trayRight }
  };
  await context.close();
}

interface TakeDigest { sha256: string; canonical: string; byteLength: number }
/**
 * A GLB's raw SHA-256 and a canonical one. three's GLTFExporter appends each
 * texture's bufferView when its async encode resolves, so the same take can
 * order its images differently between exports; the canonical digest names
 * every bufferView by the hash of its bytes, so it changes only with content.
 */
function digest(glb: Buffer): TakeDigest {
  const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as { bufferViews?: Array<{ byteOffset?: number; byteLength: number }> };
  const binStart = 20 + jsonLength + 8;
  const views = (json.bufferViews ?? []).map((view) => sha(glb.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength)));
  delete json.bufferViews;
  const canonical = JSON.stringify(json, (key, value: unknown) => (key === 'bufferView' && typeof value === 'number' ? views[value] : value));
  return { sha256: sha(glb), canonical: sha(canonical), byteLength: glb.byteLength };
}

/** Re-exports the retained take, running the frozen page clock so the exporter's timers fire. */
async function reexport(page: Page): Promise<TakeDigest | null> {
  await page.evaluate(() => {
    const slot = window as unknown as { __uiReexport?: { done: boolean; value: unknown } };
    slot.__uiReexport = { done: false, value: null };
    void window.__reexportLastTake().then((value) => { slot.__uiReexport = { done: true, value }; });
  });
  for (let i = 0; i < 400; i += 1) {
    const result = await page.evaluate(() => (window as unknown as { __uiReexport: { done: boolean; value: { base64: string } | null } }).__uiReexport);
    if (result.done) return result.value && digest(Buffer.from(result.value.base64, 'base64'));
    await page.clock.runFor(50);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('export: the re-export never finished');
}

/** Turns each palm up in turn (hands input) and reads whether the tray gesture holds. */
async function trayHands(page: Page): Promise<Record<'left' | 'right', { held: boolean; palmUp: number | null }>> {
  await page.evaluate(() => {
    window.IWER_DEVICE!.primaryInputMode = 'hand';
    window.IWER_DEVICE!.hands.left!.position.set(-0.2, 1.15, -0.3);
    window.IWER_DEVICE!.hands.right!.position.set(0.2, 1.15, -0.3);
  });
  const result: Record<'left' | 'right', { held: boolean; palmUp: number | null }> = { left: { held: false, palmUp: null }, right: { held: false, palmUp: null } };
  for (const side of ['left', 'right'] as const) {
    // Palm up: roll the hand half a turn about its forward axis.
    await page.evaluate((hand) => window.IWER_DEVICE!.hands[hand]!.quaternion.set(0, 0, 1, 0), side);
    await frames(page, 30);
    const state = await text(page);
    result[side] = { held: state.objects.tray.gesture.held, palmUp: state.objects.tray.gesture.palmUp };
    await page.evaluate((hand) => window.IWER_DEVICE!.hands[hand]!.quaternion.set(0, 0, 0, 1), side);
    await frames(page, 30);
  }
  await page.evaluate(() => { window.IWER_DEVICE!.primaryInputMode = 'controller'; });
  await frames(page, 10);
  return result;
}

try {
  const only = process.env.UI_PHASE;
  if (!only || only === 'desktop') await desktopPhase();
  if (!only || only === 'phone') await phonePhase();
  if (!only || only === 'headset') await headsetPhase();
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join('\n')}`);
  await writeFile(path.join(artifacts, 'ui-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[capture-ui] pass; report ${path.join(artifacts, 'ui-report.json')}`);
} catch (error) {
  await writeFile(path.join(artifacts, 'ui-report.json'), `${JSON.stringify({ ...report, error: String(error) }, null, 2)}\n`);
  throw error;
} finally {
  await browser.close();
}
