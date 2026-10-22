// Captures every reachable state of apps/capture for the UI inventory:
// desktop and phone-width 2D, VR and AR through IWER emulation (never a
// physical headset). Usage: node scripts/ui-inventory/capture-app.mjs
// Writes docs/product/design/inventory/capture/*.jpg and manifest.json, and
// saves the exported GLB to output/ui-inventory/ to seed the viewer run.
/* global HTMLElement, console, process, window */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  enterIwerSessionFromButton,
  launchXrBrowser,
  waitForIwerRuntime,
  waitForTextContentPrefix
} from '@holoim/tooling-testing/xr-env';

import { DESKTOP, PHONE, createRecorder, loadPlaywright, sleep, startApp, workspaceRoot } from './lib.mjs';

const { chromium } = await loadPlaywright();
const port = Number(process.env.CAPTURE_INVENTORY_PORT ?? 5179);
const lanHost = process.env.INVENTORY_LAN_HOST ?? Object.values(os.networkInterfaces()).flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
const outputDir = path.join(workspaceRoot, 'output/ui-inventory');
await mkdir(outputDir, { recursive: true });

// VR recordings save raw emulator input as replay fixtures; remove the ones
// this run creates so the hand replay check does not pick them up.
const inputRecordingsDir = path.join(workspaceRoot, 'apps/capture/fixtures/input-recordings');
const existingInputRecordings = new Set(await readdir(inputRecordingsDir).catch(() => []));

const app = await startApp({ app: 'capture', port });
const rec = createRecorder('capture');
const FAKE_MIC = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const browser = await launchXrBrowser(chromium, { args: FAKE_MIC });

const OVERLAY = 'src/ui/CaptureOverlay.tsx';
const ENTRY = 'src/runtime/xrEntry.ts (createEntryButton)';
const VR_PANEL = 'src/ui/VrHud.ts, src/ui/VrRecordingPanel.ts, packages/xr-ui-three (ThreeRecordingActionPanel, ThreeLabelPill)';
const IWER = 'Emulated (IWER, Meta Quest 3 profile), not a physical headset.';

async function openPage(context, url = app.baseUrl) {
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`  pageerror: ${error.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

async function waitLoaded(page) {
  await waitForTextContentPrefix(page, '#status', 'loaded', { timeout: 60_000 });
  await sleep(1500);
}

async function hideIwerDevUi(page) {
  await page.evaluate(() => {
    const devui = window.IWER_DEVICE?.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas]) {
      if (element instanceof HTMLElement) element.style.display = 'none';
    }
  });
}

// Points an emulated controller from its own position at a point given in
// the headset's local frame (metres; -z is forward).
async function aimController(page, side, from, target) {
  await page.evaluate(({ side, from, target }) => {
    const device = window.IWER_DEVICE;
    const head = device.position;
    const controller = device.controllers[side];
    const origin = { x: head.x + from[0], y: head.y + from[1], z: head.z + from[2] };
    const aim = { x: head.x + target[0], y: head.y + target[1], z: head.z + target[2] };
    controller.position.set(origin.x, origin.y, origin.z);
    // Quaternion turning -Z towards the target direction.
    let dx = aim.x - origin.x; let dy = aim.y - origin.y; let dz = aim.z - origin.z;
    const length = Math.hypot(dx, dy, dz); dx /= length; dy /= length; dz /= length;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(dy);
    const cy = Math.cos(yaw / 2); const sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2); const sp = Math.sin(pitch / 2);
    controller.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
  }, { side, from, target });
  await sleep(400);
}

// --- Desktop 2D -------------------------------------------------------------
console.log('capture: desktop');
{
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: DESKTOP, acceptDownloads: true });
  const page = await openPage(context);
  await page.waitForSelector('#status', { timeout: 30_000 });
  await rec.shot(page, 'desktop-loading', { surface: 'Desktop', route: '/', screen: 'Capture runtime', state: 'Loading scene (first paint)', component: OVERLAY, notes: 'Status panel before the scene and avatar finish loading.' });
  await waitLoaded(page);
  await rec.shot(page, 'desktop-third-person-idle', { surface: 'Desktop', route: '/', screen: 'Capture runtime', state: 'Loaded, third-person camera, idle, mic granted', component: `${OVERLAY}; ${ENTRY}`, notes: 'Default view. ENTER VR / ENTER AR buttons are offered because IWER emulation is active on localhost.' });

  await page.hover('#VRButton');
  await sleep(300);
  await rec.shot(page, 'desktop-enter-vr-hover', { surface: 'Desktop', route: '/', screen: 'XR entry buttons', state: 'Hover on ENTER VR', component: ENTRY, notes: 'Buttons go from 50% to 100% opacity on hover; three.js VRButton look.' });
  await page.mouse.move(700, 300);

  await page.keyboard.press('Tab');
  await page.focus('button:has-text("Start Recording")');
  await sleep(200);
  await rec.shot(page, 'desktop-record-button-focus', { surface: 'Desktop', route: '/', screen: 'Recording panel', state: 'Keyboard focus on Start Recording', component: `${OVERLAY}; packages/ui-dom UiButton`, notes: 'Focus ring from packages/ui-dom.' });
  await page.locator('button:has-text("Start Recording")').blur();

  await page.keyboard.down('KeyW');
  await sleep(900);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyV');
  await sleep(800);
  await rec.shot(page, 'desktop-first-person-idle', { surface: 'Desktop', route: '/', screen: 'Capture runtime', state: 'First-person camera (V)', component: OVERLAY, notes: 'Same overlay; camera inside the avatar.' });
  await page.keyboard.press('KeyV');
  await sleep(600);

  await page.click('button:has-text("Start Recording")');
  await page.keyboard.down('KeyW');
  await sleep(1200);
  await rec.shot(page, 'desktop-recording', { surface: 'Desktop', route: '/', screen: 'Recording panel', state: 'Recording (walking)', component: OVERLAY, notes: 'Pill reads "recording"; button turns danger-toned "Stop Recording".' });
  await page.keyboard.up('KeyW');
  await sleep(600);
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.click('button:has-text("Stop Recording")');
  await sleep(120);
  await rec.shot(page, 'desktop-exporting', { surface: 'Desktop', route: '/', screen: 'Recording panel', state: 'Exporting (export progress)', component: OVERLAY, notes: 'Button disabled with the export message; no percentage progress is shown.' });
  const file = await download;
  await file.saveAs(path.join(outputDir, 'capture-recording.glb'));
  await sleep(800);
  await rec.shot(page, 'desktop-after-export', { surface: 'Desktop', route: '/', screen: 'Recording panel', state: 'Idle after export (GLB downloaded)', component: OVERLAY, notes: `The export is a browser download (${file.suggestedFilename()}); there is no in-app success message.` });
  await context.close();
}

// --- Desktop without emulation (plain desktop browser) ----------------------
if (lanHost) {
  console.log('capture: desktop without IWER');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: DESKTOP });
  const page = await openPage(context, `https://${lanHost}:${port}/`);
  await waitLoaded(page);
  await rec.shot(page, 'desktop-no-xr', { surface: 'Desktop', route: '/ (LAN origin, no IWER)', screen: 'XR entry buttons', state: 'No headset: VR NOT SUPPORTED / AR NOT SUPPORTED', component: ENTRY, notes: 'What a desktop browser without a headset sees; IWER only activates on localhost.' });
  await context.close();
}

// --- Microphone denied -------------------------------------------------------
{
  console.log('capture: mic denied');
  const plain = await launchXrBrowser(chromium);
  const context = await plain.newContext({ ignoreHTTPSErrors: true, viewport: DESKTOP });
  const page = await openPage(context);
  await rec.shot(page, 'desktop-mic-pending', { surface: 'Desktop', route: '/', screen: 'Capture runtime', state: 'Microphone permission pending', component: OVERLAY, notes: 'Headless run: the permission prompt itself is browser chrome and is not in the page.' });
  await waitLoaded(page);
  await rec.shot(page, 'desktop-mic-denied', { surface: 'Desktop', route: '/', screen: 'Capture runtime', state: 'Microphone permission denied', component: OVERLAY, notes: 'Warning notice: recording exports without audio.' });
  await context.close();
  await plain.close();
}

// --- Phone width -------------------------------------------------------------
{
  console.log('capture: phone');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await openPage(context);
  await waitLoaded(page);
  await rec.shot(page, 'phone-idle', { surface: 'Mobile (390x844, Chromium)', route: '/', screen: 'Capture runtime', state: 'Loaded, idle', component: `${OVERLAY}; ${ENTRY}`, notes: 'Mode pill reads "mobile". Panels overlap the scene; ENTER VR/AR shown because of IWER on localhost.' });
  await page.tap('button:has-text("Start Recording")');
  await sleep(1000);
  await rec.shot(page, 'phone-recording', { surface: 'Mobile (390x844, Chromium)', route: '/', screen: 'Recording panel', state: 'Recording', component: OVERLAY, notes: 'No touch locomotion controls exist on phones.' });
  await page.tap('button:has-text("Stop Recording")');
  await sleep(2500);
  await context.close();
}

// --- VR (IWER) ---------------------------------------------------------------
{
  console.log('capture: VR');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: DESKTOP, acceptDownloads: true });
  const page = await openPage(context);
  await waitLoaded(page);
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => JSON.parse(window.render_game_to_text()).mode === 'vr' });
  // IWER's DevUI rewrites device poses every frame unless control is programmatic.
  await page.evaluate(() => { window.IWER_DEVICE.controlMode = 'programmatic'; });
  await sleep(300);
  await rec.shot(page, 'vr-entry-with-iwer-devui', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'Immersive VR session', state: 'Just entered: height fit pending ("Hold neutral posture…"), IWER DevUI visible', component: `${VR_PANEL}; ${OVERLAY}`, notes: `${IWER} The IWER DevUI controls are emulator chrome, not HoloIM UI.` });
  await hideIwerDevUi(page);
  await sleep(2500);
  await rec.shot(page, 'vr-idle-controllers', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Idle, height fitted, controllers with aim rays', component: VR_PANEL, notes: `${IWER} Floating Start Recording and Refit height pills under the view; the 2D overlay stays on the flat page.` });

  // Aim the right controller at the record pill, then at the refit pill.
  await aimController(page, 'right', [0.18, -0.35, -0.15], [0, -0.2, -0.55]);
  await rec.shot(page, 'vr-hover-record', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Controller ray hovering the record pill', component: VR_PANEL, notes: `${IWER} Ray turns white and shortens to the panel on hover.` });
  await aimController(page, 'right', [0.18, -0.35, -0.15], [0, -0.32, -0.55]);
  await rec.shot(page, 'vr-hover-refit', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Controller ray hovering Refit height', component: VR_PANEL, notes: IWER });

  await sleep(2500);

  await page.keyboard.press('KeyR');
  await sleep(1200);
  await rec.shot(page, 'vr-recording', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Recording; refit locked', component: VR_PANEL, notes: `${IWER} Pill turns red "Stop Recording"; refit pill greys to "Refit after recording".` });
  const download = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null);
  await page.keyboard.press('KeyR');
  await sleep(80);
  await rec.shot(page, 'vr-exporting', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Exporting', component: VR_PANEL, notes: `${IWER} Amber pill with the export message.` });
  await download;
  await sleep(1000);

  // Hand tracking: hands up, right index touching the record pill.
  await page.evaluate(() => { window.IWER_DEVICE.primaryInputMode = 'hand'; });
  await page.evaluate(() => {
    const device = window.IWER_DEVICE; const head = device.position;
    device.hands.left.position.set(head.x - 0.2, head.y - 0.35, head.z - 0.35);
    device.hands.right.position.set(head.x + 0.2, head.y - 0.35, head.z - 0.35);
  });
  await sleep(1200);
  await rec.shot(page, 'vr-hands-idle', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Hand tracking, hands raised (no controllers)', component: `${VR_PANEL}; src/xr/HandEmbodiment.ts`, notes: `${IWER} Hands drive the avatar's hands; no aim rays. Touching the pill presses it.` });
  await page.evaluate(() => {
    const device = window.IWER_DEVICE; const head = device.position;
    device.hands.right.position.set(head.x + 0.02, head.y - 0.2, head.z - 0.5);
  });
  await sleep(1500);
  await rec.shot(page, 'vr-hand-touch-record', { surface: 'VR (IWER)', route: '/ → ENTER VR', screen: 'VR recording panel', state: 'Hand touch on the record pill (starts recording)', component: VR_PANEL, notes: `${IWER} Touch radius 0.14 m.` });
  const handDownload = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null);
  if (await page.locator('button:has-text("Stop Recording")').count()) {
    await page.keyboard.press('KeyR');
    await handDownload;
  }
  await context.close();
}

// --- AR (IWER) ---------------------------------------------------------------
{
  console.log('capture: AR');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: DESKTOP });
  const page = await openPage(context);
  await waitLoaded(page);
  await waitForIwerRuntime(page);
  await enterIwerSessionFromButton(page, '#ARButton', { timeout: 30_000 }).catch((error) => console.warn(`  AR entry: ${error.message.split('\n')[0]}`));
  console.log(`  AR mode: ${await page.evaluate(() => JSON.parse(window.render_game_to_text()).mode)}, session: ${await page.evaluate(() => Boolean(window.IWER_DEVICE?.activeSession))}`);
  await hideIwerDevUi(page);
  await sleep(2500);
  await rec.shot(page, 'ar-session', { surface: 'AR (IWER)', route: '/ → ENTER AR', screen: 'Capture AR spectator', state: 'Immersive AR session, idle', component: `src/xr/ArSpectator.ts; ${OVERLAY}`, notes: `${IWER} Overlay status switches to AR. IWER has no camera passthrough, so the spectator shows the scene; the recording panel with Recenter AR did not appear in this capture.` });
  await context.close();
}

for (const name of await readdir(inputRecordingsDir).catch(() => [])) {
  if (!existingInputRecordings.has(name)) await rm(path.join(inputRecordingsDir, name));
}
await rec.save();
await browser.close();
await app.stop();
await copyFile(path.join(outputDir, 'capture-recording.glb'), path.join(outputDir, 'seed.glb')).catch(() => undefined);
console.log(`capture: ${rec.entries.length} screenshots`);
