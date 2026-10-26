// Captures every reachable state of apps/viewer-web for the UI inventory:
// the feed and upload panel on desktop and phone width, the portal controls,
// the AR route's notices, immersive AR through IWER, and the iOS Quick Look
// entry (iPhone user agent). The API is mocked at the network layer, so no
// API server or database is needed. Usage: node scripts/ui-inventory/viewer-web.mjs
// Seeds the feed with output/ui-inventory/capture-recording.glb when the
// capture run left one, otherwise with capture's avatar fixture.
/* global Buffer, DOMException, HTMLElement, URL, console, document, navigator, process, setInterval, window */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { launchXrBrowser, waitForIwerSession } from '@holoim/tooling-testing/xr-env';

import { DESKTOP, PHONE, createRecorder, loadPlaywright, paddedBox, runs, sleep, startApp, workspaceRoot } from './lib.mjs';

const { chromium } = await loadPlaywright();
const port = Number(process.env.VIEWER_INVENTORY_PORT ?? 3179);
const recordedGlb = path.join(workspaceRoot, 'output/ui-inventory/capture-recording.glb');
const glbPath = existsSync(recordedGlb) ? recordedGlb : path.join(workspaceRoot, 'apps/capture/public/gltf/models/avatar.glb');
const glb = readFileSync(glbPath);
console.log(`viewer: seeding with ${path.relative(workspaceRoot, glbPath)}`);

const app = await startApp({
  app: 'viewer-web',
  port,
  env: { VITE_HMR_CLIENT_PORT: String(port), VITE_IWER_SEM_SCENE: 'office_small', VITE_API_PROXY_TARGET: 'http://127.0.0.1:9' }
});
const rec = createRecorder('viewer-web');
// IWER only activates on localhost; the LAN origin behaves like a browser
// without WebXR emulation (and IWER's Quest user agent does not mask iOS).
const lanHost = process.env.INVENTORY_LAN_HOST ?? Object.values(os.networkInterfaces()).flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
const lanUrl = `https://${lanHost}:${port}/`;
const browser = await launchXrBrowser(chromium);

const FEED = 'src/features/feed/FeedPage.tsx';
const CARD = 'src/features/feed/HologramCard.tsx';
const CANVAS = 'src/features/feed/HologramCardCanvas.tsx';
const UPLOAD = 'src/features/upload/UploadPanel.tsx (packages/ui-dom UiPanel/UiField/UiInput/UiButton/UiNotice)';
const PORTAL = 'src/features/portal/PortalControls.tsx';
const AR = 'src/features/ar/ARView.tsx';
const QUICKLOOK = 'src/features/ar/ARQuickLookLink.tsx';
const IWER = 'Emulated (IWER, Meta Quest 3 profile, office_small synthetic room), not a physical device.';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function hologram(id, overrides = {}) {
  return {
    id,
    url: `/uploads/${id}.glb`,
    usdzUrl: null,
    usdzStatus: 'none',
    quickLookEnabled: false,
    createdAt: '2026-10-20T17:42:00.000Z',
    sizeBytes: glb.length,
    filenameOriginal: `${id}.glb`,
    hologramName: 'Morning walk in the courtyard',
    submittedBy: 'alberto',
    ...overrides
  };
}

const SAMPLE = [
  hologram('walk', {}),
  hologram('wave', { hologramName: 'Waving hello', submittedBy: 'sam' }),
  hologram('dance', { hologramName: 'First dance practice', submittedBy: 'riley' })
];

/**
 * Mocks the API. `feed` is the list response (or 'pending' / an HTTP status),
 * `files` maps a hologram id to 'ok', 'missing', 'corrupt' or 'pending'.
 */
async function mockApi(page, { feed = { items: SAMPLE, nextCursor: null }, files = {}, upload, single } = {}) {
  await page.route('**/api/holograms?*', async (route) => {
    if (feed === 'pending') return; // never answers
    if (feed === 'offline') return route.abort('connectionrefused');
    if (typeof feed === 'number') return route.fulfill({ status: feed, json: { error: 'Internal server error.' } });
    return route.fulfill({ json: feed });
  });
  await page.route(/\/api\/holograms\/[^/?]+$/, async (route) => {
    const id = route.request().url().split('/').pop();
    if (single === 404) return route.fulfill({ status: 404, json: { error: 'Hologram not found.' } });
    const items = typeof feed === 'object' ? feed.items : SAMPLE;
    const item = items.find((entry) => entry.id === id);
    return item ? route.fulfill({ json: item }) : route.fulfill({ status: 404, json: { error: 'Hologram not found.' } });
  });
  await page.route('**/uploads/**', async (route) => {
    const id = path.basename(new URL(route.request().url()).pathname, '.glb');
    const mode = files[id] ?? 'ok';
    if (mode === 'pending') return;
    if (mode === 'missing') return route.fulfill({ status: 404, body: '' });
    if (mode === 'corrupt') return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: Buffer.from('not a glb file at all, just text bytes') });
    return route.fulfill({ status: 200, contentType: 'model/gltf-binary', headers: { 'accept-ranges': 'bytes' }, body: glb });
  });
  await page.route('**/api/holograms/uploads/initiate', (route) => route.fulfill({ json: { mode: 'multipart' } }));
  await page.route('**/api/holograms', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (upload === 'pending') return;
    if (upload === 'error') return route.fulfill({ status: 413, json: { error: 'File exceeds 25MB limit.' } });
    return route.fulfill({ json: hologram('uploaded', { hologramName: 'New upload', submittedBy: 'alberto', createdAt: new Date().toISOString() }) });
  });
}

async function newPage({ viewport = DESKTOP, phone = false, ios = false, arSupported, initScripts = [] } = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport,
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    userAgent: ios ? IPHONE_UA : phone ? undefined : DESKTOP_UA
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.warn(`  pageerror: ${error.message}`));
  if (typeof arSupported === 'boolean') {
    await page.addInitScript((value) => { window.__HOLOIM_AR_SUPPORTED_OVERRIDE__ = value; }, arSupported);
  }
  if (ios) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'iPhone' });
    });
  }
  for (const script of initScripts) await page.addInitScript(script);
  return page;
}

async function waitRendered(page, index = 0) {
  await page.locator('.feed-card').nth(index).locator('canvas').waitFor({ timeout: 60_000 });
  await page.waitForFunction((i) => document.querySelectorAll('.feed-card')[i]?.dataset.modelState === 'rendered', index, { timeout: 60_000 });
  await sleep(1800);
}

const bubble = (page) => page.locator('.feed-card').first().locator('.feed-card-bubble-shell');

async function dragBubble(page, dx, dy) {
  const box = await bubble(page).boundingBox();
  const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(x + (dx * step) / 10, y + (dy * step) / 10);
  await page.mouse.up();
  await sleep(600);
}

// --- Feed states, desktop and phone -----------------------------------------
for (const surface of !runs('feed') ? [] : [
  { key: 'desktop', label: 'Desktop', options: { viewport: DESKTOP, arSupported: false } },
  { key: 'phone', label: 'Mobile (390x844, Chromium)', options: { viewport: PHONE, phone: true, arSupported: false } }
]) {
  console.log(`viewer: feed ${surface.key}`);
  const meta = (screen, stateName, component, notes = '') => ({ surface: surface.label, route: '/', screen, state: stateName, component, notes });

  let page = await newPage(surface.options);
  await mockApi(page, { feed: 'pending' });
  await page.goto(app.baseUrl);
  await page.getByText('Loading…').waitFor();
  await rec.shot(page, `${surface.key}-feed-loading`, meta('Feed', 'Loading feed', FEED, 'Plain "Loading…" text; no skeleton.'));
  await page.context().close();

  page = await newPage(surface.options);
  await mockApi(page, { feed: { items: [], nextCursor: null } });
  await page.goto(app.baseUrl);
  await sleep(1500);
  await rec.shot(page, `${surface.key}-feed-empty`, meta('Feed', 'Empty (no holograms)', FEED, 'No empty-state message; the feed area is blank.'));
  await page.context().close();

  page = await newPage(surface.options);
  await mockApi(page, { feed: 500 });
  await page.goto(app.baseUrl);
  await page.locator('.feed-error').waitFor();
  await rec.shot(page, `${surface.key}-feed-error-server`, meta('Feed', 'Error: API returned 500', FEED, 'Shows the API error text in .feed-error.'));
  await page.context().close();

  page = await newPage(surface.options);
  await mockApi(page, { feed: 'offline' });
  await page.goto(app.baseUrl);
  await page.locator('.feed-error').waitFor();
  await rec.shot(page, `${surface.key}-feed-error-offline`, meta('Feed', 'Error: API unreachable', FEED, '"Unable to reach API…" message.'));
  await page.context().close();

  page = await newPage(surface.options);
  await mockApi(page, { files: { walk: 'pending' } });
  await page.goto(app.baseUrl);
  await page.getByText('Loading hologram...').first().waitFor();
  await rec.shot(page, `${surface.key}-card-loading`, meta('Feed card', 'Hologram loading (availability check pending)', CARD, '"Loading hologram..." inside the empty bubble.'));
  await page.context().close();

  for (const [mode, label] of [['missing', 'Hologram file missing (404)'], ['corrupt', 'Hologram file corrupted (not a GLB)']]) {
    page = await newPage(surface.options);
    await mockApi(page, { files: { walk: mode } });
    await page.goto(app.baseUrl);
    await page.locator('.feed-card-model-unavailable').first().waitFor();
    await sleep(500);
    await rec.shot(page, `${surface.key}-card-${mode}`, meta('Feed card', label, CARD));
    await page.context().close();
  }

  // Populated and portal states.
  page = await newPage(surface.options);
  await mockApi(page);
  await page.goto(app.baseUrl);
  await waitRendered(page);
  await rec.shot(page, `${surface.key}-feed-populated-playing`, meta('Feed card', 'Populated, active card playing (Follow view)', `${CARD}; ${CANVAS}; ${PORTAL}`, `Recorded hologram in the bubble portal, Pause control, meta line.${surface.key === 'phone' ? ' Upload panel collapsed to "⬆ Upload".' : ' Upload panel expanded on the left.'}`));

  const hasAudio = await page.locator('.audio-mute-button').count();
  if (hasAudio) {
    await rec.shot(page, `${surface.key}-card-audio-muted`, meta('Feed card', 'Audio available, muted (default)', CARD, 'Mute toggle appears only when the GLB carries audio.'), { clip: await page.locator('.feed-card').first().boundingBox() });
  }

  if (surface.key === 'desktop') {
    await page.hover('.portal-control-primary');
    await sleep(300);
    await rec.shot(page, 'desktop-portal-pause-hover', meta('Portal controls', 'Hover on Pause', PORTAL), { clip: await page.locator('.feed-card').first().boundingBox() });
    await bubble(page).focus();
    await sleep(300);
    await rec.shot(page, 'desktop-portal-bubble-focus', meta('Feed card', 'Keyboard focus on the bubble portal', CARD, 'Space pauses, arrows look around, +/- zoom, Escape returns.'), { clip: await page.locator('.feed-card').first().boundingBox() });
    await page.keyboard.press('Space');
  } else {
    await page.tap('.portal-control-primary');
  }
  await sleep(800);
  await rec.shot(page, `${surface.key}-portal-paused`, meta('Portal controls', 'Paused (portal captured)', `${CARD}; ${PORTAL}`, 'Play icon replaces Pause; card gets .portal-captured in the freeze variant.'));

  await dragBubble(page, 160, 40);
  await rec.shot(page, `${surface.key}-portal-free-look`, meta('Portal controls', 'Paused, free look (dragged), Return-to-author control', PORTAL, 'Return control appears once the view leaves Follow.'));
  if (surface.key === 'desktop') {
    await bubble(page).hover();
    for (let i = 0; i < 8; i += 1) { await page.mouse.wheel(0, -240); await sleep(60); }
    await sleep(800);
    await rec.shot(page, 'desktop-portal-zoomed-in', meta('Portal controls', 'Paused, zoomed in to eye level (wheel)', `${CARD}; global.css (--portal-open)`, 'Bubble chrome fades as --portal-open rises.'));
  }
  await page.locator('[aria-label="Return to the author\'s view"]').click();
  await sleep(600);

  // Scroll to the second card.
  await page.locator('.feed-card').nth(1).scrollIntoViewIfNeeded();
  await sleep(2500);
  await rec.shot(page, `${surface.key}-feed-second-card`, meta('Feed', 'Scrolled to the second card', FEED, 'Scroll-snap feed; the active card is the one 70%+ visible.'));
  await page.context().close();

  // Upload panel states.
  page = await newPage(surface.options);
  await mockApi(page, { upload: 'pending' });
  await page.goto(app.baseUrl);
  await sleep(1200);
  if (surface.key === 'phone') {
    await rec.shot(page, 'phone-upload-collapsed', meta('Upload panel', 'Collapsed toggle', UPLOAD), { clip: await paddedBox(page.locator('.upload-toggle'), 40) });
    await page.tap('.upload-toggle');
    await sleep(400);
  }
  await rec.shot(page, `${surface.key}-upload-empty`, meta('Upload panel', 'Expanded, empty form', UPLOAD, 'Upload button disabled until a file is chosen.'));
  await page.locator('.upload-panel input').first().focus();
  await sleep(200);
  await rec.shot(page, `${surface.key}-upload-field-focus`, meta('Upload panel', 'Focus on Hologram name', UPLOAD), { clip: await paddedBox(page.locator('.upload-panel')) });
  await page.setInputFiles('#glb-upload', { name: 'courtyard-walk.glb', mimeType: 'model/gltf-binary', buffer: glb });
  await page.locator('.upload-panel input').nth(1).fill('');
  await page.locator('.upload-panel button[type="submit"]').click();
  await sleep(300);
  await rec.shot(page, `${surface.key}-upload-validation-error`, meta('Upload panel', 'Validation error (missing submitter)', UPLOAD, 'Danger UiNotice under the button.'), { clip: await paddedBox(page.locator('.upload-panel')) });
  await page.locator('.upload-panel input').nth(1).fill('alberto');
  await page.check('#quicklook-enabled');
  await sleep(200);
  await rec.shot(page, `${surface.key}-upload-ready`, meta('Upload panel', 'File selected, Quick Look checked, ready', UPLOAD), { clip: await paddedBox(page.locator('.upload-panel')) });
  await page.locator('.upload-panel button[type="submit"]').click();
  await sleep(300);
  await rec.shot(page, `${surface.key}-upload-uploading`, meta('Upload panel', 'Uploading (in progress)', UPLOAD, 'Fields and button disabled, button reads "Uploading..."; no progress bar or percentage.'), { clip: await paddedBox(page.locator('.upload-panel')) });
  await page.context().close();

  page = await newPage(surface.options);
  await mockApi(page, { upload: 'error' });
  await page.goto(app.baseUrl);
  await sleep(800);
  if (surface.key === 'phone') { await page.tap('.upload-toggle'); await sleep(300); }
  await page.locator('.upload-panel input').first().fill('Courtyard walk');
  await page.locator('.upload-panel input').nth(1).fill('alberto');
  await page.setInputFiles('#glb-upload', { name: 'courtyard-walk.glb', mimeType: 'model/gltf-binary', buffer: glb });
  await page.locator('.upload-panel button[type="submit"]').click();
  await page.getByText('File exceeds 25MB limit.').waitFor();
  await rec.shot(page, `${surface.key}-upload-server-error`, meta('Upload panel', 'Server error (413 too large)', UPLOAD), { clip: await paddedBox(page.locator('.upload-panel')) });
  await page.context().close();
}

// --- AR trigger and AR route notices ------------------------------------------
if (runs('ar')) {
  console.log('viewer: AR');
  // Desktop with IWER: the AR trigger shows on the card.
  let page = await newPage({ viewport: DESKTOP });
  await mockApi(page);
  await page.goto(app.baseUrl);
  await waitRendered(page);
  await page.locator('.ar-trigger-button').first().waitFor({ timeout: 20_000 });
  await page.hover('.ar-trigger-button');
  await sleep(300);
  await rec.shot(page, 'desktop-card-ar-trigger-hover', { surface: 'Desktop (IWER)', route: '/', screen: 'Feed card', state: 'AR trigger visible (WebXR AR supported), hover', component: CARD, notes: `${IWER} The AR icon button only shows where immersive-ar is supported and not on iOS.` }, { clip: await page.locator('.feed-card').first().boundingBox() });
  await page.context().close();

  // AR route loading notice.
  page = await newPage({ viewport: PHONE, phone: true });
  await mockApi(page, { files: { walk: 'pending' } });
  await page.route('**/api/holograms/walk', () => undefined);
  await page.goto(`${app.baseUrl}ar/walk`);
  await page.getByText('Loading hologram...').waitFor();
  await rec.shot(page, 'phone-ar-loading', { surface: 'Mobile (390x844, Chromium)', route: '/ar/:id', screen: 'AR view', state: 'Loading hologram', component: `${AR} (UiNotice)` });
  await page.context().close();

  page = await newPage({ viewport: PHONE, phone: true });
  await mockApi(page, { files: { walk: 'pending' } });
  await page.goto(`${app.baseUrl}ar/walk`);
  await page.getByText('Preparing hologram for AR...').waitFor();
  await rec.shot(page, 'phone-ar-preparing', { surface: 'Mobile (390x844, Chromium)', route: '/ar/:id', screen: 'AR view', state: 'Preparing hologram for AR (model check pending)', component: `${AR} (UiNotice)` });
  await page.context().close();

  page = await newPage({ viewport: PHONE, phone: true });
  await mockApi(page, { single: 404 });
  await page.goto(`${app.baseUrl}ar/does-not-exist`);
  await page.getByText('Back to Feed').waitFor();
  await rec.shot(page, 'phone-ar-not-found', { surface: 'Mobile (390x844, Chromium)', route: '/ar/:id', screen: 'AR view', state: 'Error: hologram not found', component: `${AR} (UiNotice danger, UiButton ghost)` });
  await page.context().close();

  page = await newPage({ viewport: PHONE, phone: true });
  await mockApi(page, { files: { walk: 'missing' } });
  await page.goto(`${app.baseUrl}ar/walk`);
  await page.getByText('Back to Feed').waitFor({ timeout: 30_000 });
  await rec.shot(page, 'phone-ar-file-missing', { surface: 'Mobile (390x844, Chromium)', route: '/ar/:id', screen: 'AR view', state: 'Error: hologram file missing', component: AR });
  await page.context().close();

  // A browser without immersive-ar: LAN origin, so IWER does not activate.
  page = await newPage({ viewport: PHONE, phone: true });
  await mockApi(page);
  if (lanHost) {
    await page.goto(`${lanUrl}ar/walk`);
    await page.getByText('Back to Feed').waitFor({ timeout: 30_000 });
    await rec.shot(page, 'phone-ar-unsupported', { surface: 'Mobile (390x844, Chromium)', route: '/ar/:id', screen: 'AR view', state: 'Error: AR not supported in this browser', component: `${AR}; src/features/ar/arController.ts (resolveArSupportMessage)` });
  }
  await page.context().close();

  // Session refused: IWER present but requestSession rejects.
  page = await newPage({ viewport: PHONE, phone: true, initScripts: [() => {
    // IWER replaces navigator.xr after load, so keep re-patching whichever
    // object is current.
    const refuse = () => Promise.reject(new DOMException('The user denied permission.', 'NotAllowedError'));
    setInterval(() => {
      if (navigator.xr && navigator.xr.requestSession !== refuse) navigator.xr.requestSession = refuse;
    }, 5);
  }] });
  await mockApi(page);
  await page.goto(`${app.baseUrl}ar/walk`);
  await page.getByText('Back to Feed').waitFor({ timeout: 40_000 });
  await rec.shot(page, 'phone-ar-session-failed', { surface: 'Mobile (390x844, Chromium)', route: '/ar/:id', screen: 'AR view', state: 'Error: AR session refused (camera permission denied)', component: AR, notes: 'Stands in for the OS camera-permission denial, which is browser/OS chrome.' });
  await page.context().close();
}

// --- Immersive AR (IWER) -------------------------------------------------------
for (const variant of !runs('immersive') ? [] : [
  { key: 'placed', label: 'Placed on a surface (hit-test)', hitTest: true, viewport: DESKTOP, surface: 'AR (IWER)' },
  { key: 'phone-placed', label: 'Placed on a surface (hit-test)', hitTest: true, viewport: PHONE, surface: 'AR (IWER, phone portrait)' },
  { key: 'phone-no-hit-test', label: 'No hit-test or planes: waiting, then fallback placement', hitTest: false, viewport: PHONE, surface: 'AR (IWER, phone portrait)' }
]) {
  console.log(`viewer: immersive AR ${variant.key}`);
  const initScripts = variant.hitTest ? [] : [() => {
    let value;
    Object.defineProperty(window, 'IWER_DEVICE', {
      configurable: true,
      get: () => value,
      set: (device) => {
        value = device;
        const features = device?.supportedFeatures;
        for (const feature of ['hit-test', 'plane-detection', 'mesh-detection']) {
          const index = features?.indexOf(feature) ?? -1;
          if (index >= 0) features.splice(index, 1);
        }
        if (device?.sem) {
          Object.defineProperty(device.sem, 'trackedPlanes', { configurable: true, get: () => new Set() });
          Object.defineProperty(device.sem, 'trackedMeshes', { configurable: true, get: () => new Set() });
        }
      }
    });
  }];
  const page = await newPage({ viewport: variant.viewport, initScripts });
  await mockApi(page);
  await page.goto(`${app.baseUrl}ar/walk`);
  await waitForIwerSession(page, { timeout: 60_000 });
  await page.evaluate(() => {
    const devui = window.IWER_DEVICE?.devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas]) if (element instanceof HTMLElement) element.style.display = 'none';
  });
  await sleep(400);
  const stage = await page.locator('.ar-view-container').getAttribute('data-placement-stage');
  await rec.shot(page, `ar-${variant.key}-entering`, { surface: variant.surface, route: '/ar/:id', screen: 'Immersive AR', state: `Session started, placement stage "${stage}"`, component: `${AR}; packages/xr-ui-r3f HeadLockedActionBar; src/features/ar/ARHologramModel.tsx`, notes: `${IWER} The head-locked 3D action bar (Exit AR, Recenter Model, placement status) is what shows in-session; the DOM overlay copies of those buttons sit under IWER's composited view. The bar's apparent size depends on the emulated field of view.` });
  await page.waitForFunction(() => document.querySelector('.ar-view-container')?.dataset.placementAnchored === 'true' || /fallback|timeout/.test(document.querySelector('.ar-view-container')?.dataset.placementReason ?? ''), null, { timeout: 30_000 }).catch(() => undefined);
  await sleep(2500);
  const placed = await page.locator('.ar-view-container').evaluate((root) => `${root.dataset.placementStage} / ${root.dataset.placementMode} / ${root.dataset.placementReason}`);
  await rec.shot(page, `ar-${variant.key}-settled`, { surface: variant.surface, route: '/ar/:id', screen: 'Immersive AR', state: `${variant.label} (stage/mode/reason: ${placed})`, component: `${AR}; src/features/ar/ARHologramModel.tsx; src/features/ar/ARBubbleAura.tsx`, notes: `${IWER} No camera passthrough in emulation; the background is IWER's synthetic room.` });
  if (variant.key === 'placed') {
    // Look down at the placed hologram; the action bar stays head-locked.
    await page.evaluate(() => {
      const device = window.IWER_DEVICE;
      device.controlMode = 'programmatic';
      const pitch = -0.6;
      device.quaternion.set(Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2));
    });
    await sleep(1500);
    await rec.shot(page, 'ar-placed-look-down', { surface: variant.surface, route: '/ar/:id', screen: 'Immersive AR', state: 'Head pitched down: the action bar follows the head and still fills the view', component: 'src/features/ar/ARHologramModel.tsx; src/features/ar/ARBubbleAura.tsx; packages/xr-ui-r3f HeadLockedActionBar', notes: IWER });
  }
  await page.context().close();
}

// --- iOS Quick Look entry (iPhone user agent in Chromium) ---------------------
if (runs('quicklook')) console.log('viewer: Quick Look');
for (const [key, overrides, label] of !runs('quicklook') ? [] : [
  ['ready', { quickLookEnabled: true, usdzStatus: 'ready', usdzUrl: '/uploads/walk.usdz' }, 'USDZ ready: "View in your room" link (rel="ar")'],
  ['preparing', { quickLookEnabled: true, usdzStatus: 'processing' }, 'USDZ converting: "Preparing preview…" (disabled)'],
  ['failed', { quickLookEnabled: true, usdzStatus: 'failed' }, 'USDZ failed: "Preview unavailable" (disabled)']
]) {
  const page = await newPage({ viewport: PHONE, phone: true, ios: true });
  await mockApi(page, { feed: { items: [hologram('walk', overrides), SAMPLE[1]], nextCursor: null } });
  await page.goto(lanUrl);
  await waitRendered(page);
  await page.locator('.ar-quicklook-link').first().waitFor();
  await rec.shot(page, `phone-ios-quicklook-${key}`, { surface: 'Mobile (iPhone UA, Chromium)', route: '/', screen: 'Feed card, Quick Look entry', state: label, component: QUICKLOOK, notes: 'Emulated iOS detection (user agent and platform). Real iOS Safari captures are under ios-sim-*.' });
  await page.context().close();
}

await rec.save();
await browser.close();
await app.stop();
console.log(`viewer: ${rec.entries.length} screenshots`);
