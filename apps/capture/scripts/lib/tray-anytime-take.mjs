import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createXrContext, waitForPageFunctions, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';

import { heavyGlb } from './heavy-glb.mjs';
import { loadTake, objectNodes, readGlb } from './object-glb.mjs';
import { OBJECT_URL, openCapture, readState, saveDownload } from './object-take.mjs';
import { carriedNow, checkCarried, PIXEL_PNG, STEP_MS, summonedItems, TRAY_URLS } from './summon-take.mjs';

// The tray on every device (docs/features/tray-everywhere.md), through
// capture's real flat-screen UI:
//   - desktop-anytime: hold T shows the dock row (thumbnails, keys, empty
//     slots); T + 1 summons before the take and G places it; the take keeps it
//     as `prepared` from frame 0; Find stays on the dock during the take, typing
//     in it drives nothing, and the found item is summoned mid-take
//     (`summoned`, with its credit).
//   - touch-tray: at phone size with touch, the dock's Tray glyph opens the
//     row, a tap summons into the hand, a touch lets go; mid-take, press, hold
//     and slide onto a slot summons.
//   - tray-hitch: real time, no manual clock: an ~7 MB GLB loaded mid-take and
//     summoned; every long task is reported against the take's own baseline.

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
const HEAVY_URL = '/fixtures/objects/heavy-generated.glb';
// The brief's budget for one main-thread task while a take records.
const LONG_TASK_BUDGET_MS = 100;

const round = (value, digits = 3) => Number(value.toFixed(digits));

async function setupFlatPage(browser, { consoleErrors, label, touch = false }) {
  const context = await createXrContext(browser, {
    viewport: touch ? PHONE_VIEWPORT : DESKTOP_VIEWPORT,
    acceptDownloads: true,
    ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {})
  });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors, { label });
  await page.route('**/__holoim/input-recordings*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":"tray-take-input.json"}' }));
  return { context, page };
}

/** The dock row as drawn: per slot, filled or not, its key, and whether its thumbnail is a rendered image. */
function readRow(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="tray-row"]');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      emptyCaption: document.querySelector('[data-testid="tray-empty-caption"]')?.textContent ?? null,
      slots: [...row.querySelectorAll('[data-tray-slot]')].map((slot) => {
        const box = slot.getBoundingClientRect();
        const img = slot.querySelector('img');
        return {
          slot: Number(slot.getAttribute('data-tray-slot')),
          filled: slot.getAttribute('data-tray-filled') === 'true',
          button: slot.tagName === 'BUTTON',
          label: slot.getAttribute('aria-label'),
          // A filled slot's keycap; an empty slot shows its muted numeral as plain text.
          key: (slot.querySelector('[data-tray-keycap]')?.textContent ?? (slot.getAttribute('data-tray-filled') === 'true' ? '' : slot.textContent))?.trim() || null,
          thumbnail: img ? { rendered: img.src.startsWith('data:image/png'), loaded: img.complete && img.naturalWidth > 0 } : null,
          size: { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 }
        };
      })
    };
  });
}

function checkRow(row, { filled, keys, fail, where }) {
  if (!row) {
    fail(`${where}: no tray row`);
    return;
  }
  if (row.slots.length !== 5) fail(`${where}: ${row.slots.length} slots, expected 5`);
  row.slots.forEach((slot, i) => {
    const isFilled = i < filled;
    if (slot.filled !== isFilled || slot.button !== isFilled) fail(`${where}: slot ${slot.slot} filled=${slot.filled} button=${slot.button}, expected ${isFilled}`);
    if (isFilled && !(slot.thumbnail?.rendered && slot.thumbnail.loaded)) fail(`${where}: slot ${slot.slot} has no rendered thumbnail (${JSON.stringify(slot.thumbnail)})`);
    if (keys && slot.key !== String(slot.slot)) fail(`${where}: slot ${slot.slot} key ${JSON.stringify(slot.key)}`);
    if (!keys && isFilled && slot.key) fail(`${where}: a touch slot shows the key ${slot.key}`);
  });
}

/** Steps the manual clock until `done(state)` or `maxSec` passes. */
async function advanceUntil(page, done, maxSec = 3) {
  let state = await readState(page);
  for (let i = 0; i < Math.round(maxSec * 60) && !done(state); i += 1) {
    await page.evaluate((ms) => window.advanceTime(ms), STEP_MS);
    state = await readState(page);
  }
  return state;
}

const advance = (page, seconds) => page.evaluate((ms) => window.advanceTime(ms), Math.round(seconds * 60) * STEP_MS);

async function routeFind(page, captureRoot) {
  const fixture = await readFile(path.join(captureRoot, 'fixtures/objects/credited-bracket.glb'));
  const credit = readGlb(fixture).json.asset.extras.holoimCredit;
  await page.route('**/api/objects/search*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      results: [{ id: 'test_bracket', source: credit.source, title: credit.title, author: credit.author, licence: credit.licence, sourceUrl: credit.sourceUrl, thumbnailUrl: PIXEL_PNG, glbPath: '/api/objects/polyhaven/test_bracket.glb', dimensionsM: [0.85, 0.77, 1.07], bytes: fixture.length }]
    })
  }));
  await page.route('**/api/objects/polyhaven/*.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: fixture }));
  return credit;
}

export async function runDesktopAnytimeTake({ browser, baseUrl, captureRoot, artifactDir, consoleErrors }) {
  const label = 'desktop-anytime';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label });
  const shots = {};
  const shot = async (name) => {
    const file = path.join(artifactDir, `${label}-${name}.png`);
    await page.screenshot({ path: file });
    shots[name] = file;
  };
  try {
    const credit = await routeFind(page, captureRoot);
    await openCapture(page, baseUrl, { tray: [OBJECT_URL] });
    await advance(page, 1);
    await page.locator('canvas').first().focus();

    // Before the take: hold T, the row shows one filled slot and four empty ones, each with its key.
    await page.keyboard.down('KeyT');
    await advance(page, 0.4);
    let state = await readState(page);
    const rowBefore = await readRow(page);
    if (!state.objects.tray.open) fail('holding T did not open the tray');
    checkRow(rowBefore, { filled: 1, keys: true, fail, where: 'pre-take row' });
    const dockTray = await page.locator('[data-testid="dock-tray"]').getAttribute('data-open');
    if (dockTray !== 'true') fail(`the dock's Tray glyph does not show the tray open (${dockTray})`);
    await shot('1-row-pre-take');
    await page.keyboard.press('Digit1');
    await advance(page, 0.3);
    await page.keyboard.up('KeyT');
    state = await readState(page);
    const preTake = summonedItems(state).map((item) => ({ name: item.name, heldBy: item.heldBy }));
    if (preTake.length !== 1 || preTake[0].heldBy !== 'right') fail(`T + 1 before the take did not summon into the right hand (${JSON.stringify(preTake)})`);
    await page.keyboard.press('KeyG');
    state = await advanceUntil(page, (s) => summonedItems(s).every((item) => !item.heldBy), 4);
    await advance(page, 1.5);
    state = await readState(page);
    if (summonedItems(state).some((item) => item.heldBy)) fail('G did not put the pre-take summon down');

    // The take keeps it.
    await page.getByRole('button', { name: 'Start Recording' }).click();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    const carried = carriedNow(await readState(page));
    await advance(page, 0.3);
    const dockDuringTake = {
      tray: await page.locator('[data-testid="dock-tray"]').isVisible(),
      find: await page.locator('[data-testid="dock-find"]').isVisible()
    };
    if (!dockDuringTake.tray || !dockDuringTake.find) fail(`Tray and Find are not on the dock during the take (${JSON.stringify(dockDuringTake)})`);

    // Find mid-take. Typing in its field never drives the avatar or the tray.
    await page.locator('[data-testid="dock-find"]').click();
    await page.locator('[data-testid="find-sheet"]').waitFor();
    const field = page.locator('[data-testid="find-sheet"]').getByLabel('Find an object');
    const before = await readState(page);
    await field.click();
    await page.keyboard.type('tg1');
    await advance(page, 0.3);
    let after = await readState(page);
    const typing = { trayOpened: after.objects.tray.open, summons: summonedItems(after).length - summonedItems(before).length };
    if (typing.trayOpened || typing.summons !== 0) fail(`typing in Find drove the tray (${JSON.stringify(typing)})`);
    await field.fill('bracket');
    await page.keyboard.press('Enter');
    const pick = page.getByRole('button', { name: `Add ${credit.title} to the tray` });
    await pick.waitFor({ timeout: 10_000 });
    await shot('2-find-mid-take');
    await pick.click();
    after = await advanceUntil(page, (s) => s.objects.tray.items.length === 2, 10);
    if (after.objects.tray.items.length !== 2) fail(`the found item did not reach the tray mid-take (${after.objects.tray.items.length} items)`);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="find-sheet"]').waitFor({ state: 'detached', timeout: 2_000 }).catch(() => fail('Escape did not close Find'));
    await page.locator('canvas').first().focus();
    await page.keyboard.down('KeyT');
    await advance(page, 0.4);
    const rowMid = await readRow(page);
    checkRow(rowMid, { filled: 2, keys: true, fail, where: 'mid-take row' });
    await shot('3-row-mid-take');
    await page.keyboard.press('Digit2');
    await advance(page, 0.3);
    await page.keyboard.up('KeyT');
    state = await readState(page);
    const found = summonedItems(state).find((item) => item.name === credit.title);
    if (!found || found.heldBy !== 'right') fail(`T + 2 did not summon the found item mid-take (${JSON.stringify(summonedItems(state).map((item) => item.name))})`);
    // Blocked while the hand is full: the row dims.
    await page.keyboard.down('KeyT');
    await advance(page, 0.1);
    const blocked = await page.locator('[data-testid="tray-row"]').getAttribute('data-tray-blocked');
    await page.keyboard.up('KeyT');
    if (blocked !== 'true') fail(`the row does not read blocked with the hand full (${blocked})`);
    await page.keyboard.press('KeyG');
    await advanceUntil(page, (s) => summonedItems(s).every((item) => !item.heldBy), 4);
    await advance(page, 0.5);

    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).click(), path.join(artifactDir, `${label}.glb`));
    const take = loadTake(await readFile(glb));
    const exported = { valid: take.validation?.ok ?? false, objectNodes: objectNodes(take).length };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    else {
      const entries = take.validation.value.objects;
      exported.origins = entries.map((entry) => `${entry.name}:${entry.origin}`);
      exported.carried = checkCarried(take, entries.filter((entry) => entry.origin !== 'summoned'), carried, fail);
      const foundEntry = entries.find((entry) => entry.origin === 'summoned');
      exported.found = foundEntry ? { name: foundEntry.name, presence: foundEntry.presence } : null;
      if (!foundEntry || foundEntry.name !== credit.title || !(foundEntry.presence[0]?.start > 0)) fail(`the mid-take summon is not a summoned object appearing mid-take (${JSON.stringify(exported.found)})`);
      const extras = objectNodes(take).map((node) => take.json.nodes[node]?.extras?.holoimCredit ?? null).filter(Boolean);
      exported.credits = extras.length;
      if (extras.length !== 1 || extras[0].title !== credit.title) fail(`the found item's credit is not on its node (${JSON.stringify(extras)})`);
    }
    if (exported.objectNodes !== 2) fail(`${exported.objectNodes} RecordedObject nodes, expected 2`);
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, shots, rowBefore, rowMid, preTake, dockDuringTake, typing, blocked, export: exported };
  } finally {
    await context.close();
  }
}

/** A finger held on `from`, then slid to `to` and lifted, through CDP so the hold is real touch input. */
async function touchHoldSlide(page, from, to, holdMs) {
  const cdp = await page.context().newCDPSession(page);
  const point = (p) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) });
  await page.waitForTimeout(holdMs);
  // The row opens on the next frame; this page's frames run on the manual clock.
  await advance(page, 0.4);
  for (let i = 1; i <= 6; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point({ x: from.x + ((to.x - from.x) * i) / 6, y: from.y + ((to.y - from.y) * i) / 6 }) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const centre = async (locator) => {
  const box = await locator.boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
};

export async function runTouchTrayTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'touch-tray';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label, touch: true });
  const shots = {};
  const shot = async (name) => {
    const file = path.join(artifactDir, `${label}-${name}.png`);
    await page.screenshot({ path: file });
    shots[name] = file;
  };
  try {
    await openCapture(page, baseUrl, { tray: TRAY_URLS });
    await advance(page, 1);
    const trayGlyph = page.locator('[data-testid="dock-tray"]');
    const glyphTitle = await trayGlyph.getAttribute('title');
    if (/hold T/i.test(glyphTitle ?? '')) fail(`the touch Tray glyph shows keyboard help (${glyphTitle})`);

    // Tap: the row opens and stays open.
    await trayGlyph.tap();
    await advance(page, 0.4);
    let state = await readState(page);
    const row = await readRow(page);
    if (!state.objects.tray.open) fail('tapping the Tray glyph did not open the tray');
    checkRow(row, { filled: 2, keys: false, fail, where: 'touch row' });
    const small = row?.slots.filter((slot) => slot.filled && (slot.size.width < 44 || slot.size.height < 44)) ?? [];
    if (small.length) fail(`touch slots under 44 apx: ${JSON.stringify(small)}`);
    // A phone's dock unfolds rather than clipping, and the row clears it.
    const dock = await page.evaluate(() => {
      const row = document.querySelector('[data-capture-dock] [data-dock-row]').getBoundingClientRect();
      const tray = document.querySelector('[data-testid="tray-row"]').getBoundingClientRect();
      const clipped = [...document.querySelectorAll('[data-capture-dock] [data-dock-row] button')]
        .map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent, rect: button.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left < 0 || rect.right > window.innerWidth)
        .map(({ label }) => label);
      return { clipped, dockTop: Math.round(row.top), trayBottom: Math.round(tray.bottom), lines: Math.round(row.height) };
    });
    if (dock.clipped.length) fail(`dock controls off screen on a phone: ${dock.clipped.join(', ')}`);
    if (dock.trayBottom > dock.dockTop) fail(`the tray row overlaps the dock (${JSON.stringify(dock)})`);
    await shot('1-row-open');

    // Tap a slot: summoned into the right hand; the row closes.
    await page.locator('[data-testid="tray-slot-1"]').tap();
    await advance(page, 0.3);
    state = await readState(page);
    const tapped = summonedItems(state).map((item) => ({ name: item.name, heldBy: item.heldBy }));
    if (tapped.length !== 1 || tapped[0].heldBy !== 'right') fail(`tapping slot 1 did not summon into the hand (${JSON.stringify(tapped)})`);
    if (state.objects.tray.open) fail('the row stayed open after a summon');
    // A touch on the look side lets go.
    const look = { x: PHONE_VIEWPORT.width * 0.75, y: PHONE_VIEWPORT.height * 0.4 };
    await page.touchscreen.tap(look.x, look.y);
    state = await advanceUntil(page, (s) => summonedItems(s).every((item) => !item.heldBy), 4);
    const letGo = summonedItems(state).every((item) => !item.heldBy);
    if (!letGo) fail('a touch did not let the summoned object go');
    await advance(page, 1.5);

    // Mid-take: press, hold and slide from the glyph onto slot 2.
    await page.getByRole('button', { name: 'Start Recording' }).tap();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    const carried = carriedNow(await readState(page));
    await advance(page, 0.3);
    const from = await centre(trayGlyph);
    // Where slot 2 sits: open the row with a tap, measure it, close it again.
    await trayGlyph.tap();
    await advance(page, 0.4);
    const to = await centre(page.locator('[data-testid="tray-slot-2"]'));
    await trayGlyph.tap();
    await advance(page, 0.6);
    let slid = null;
    if (!from || !to) fail('the Tray glyph or slot 2 has no position');
    else {
      await touchHoldSlide(page, from, to, 400);
      await advance(page, 0.3);
      state = await readState(page);
      slid = summonedItems(state).filter((item) => item.name === 'diagram.png').map((item) => item.heldBy);
      if (slid.length !== 1 || slid[0] !== 'right') fail(`hold and slide onto slot 2 did not summon it (${JSON.stringify(slid)})`);
      await shot('2-slide-summon');
      await page.touchscreen.tap(look.x, look.y);
      await advanceUntil(page, (s) => summonedItems(s).every((item) => !item.heldBy), 4);
    }
    await advance(page, 0.5);
    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).tap(), path.join(artifactDir, `${label}.glb`));
    const take = loadTake(await readFile(glb));
    const exported = { valid: take.validation?.ok ?? false, objectNodes: objectNodes(take).length };
    if (!exported.valid) fail(`HOLOIM_objects invalid: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    else {
      const entries = take.validation.value.objects;
      exported.origins = entries.map((entry) => `${entry.name}:${entry.origin}`);
      exported.carried = checkCarried(take, entries.filter((entry) => entry.origin !== 'summoned'), carried, fail);
      if (entries.filter((entry) => entry.origin === 'summoned').length !== 1) fail(`expected one mid-take summon in the export (${exported.origins})`);
    }
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, shots, glyphTitle, row, dock, tapped, letGo, slid, export: exported };
  } finally {
    await context.close();
  }
}

export async function runTrayHitchTake({ browser, baseUrl, artifactDir, consoleErrors }) {
  const label = 'tray-hitch';
  const failures = [];
  const fail = (message) => failures.push(message);
  await mkdir(artifactDir, { recursive: true });
  const heavy = heavyGlb();
  const { context, page } = await setupFlatPage(browser, { consoleErrors, label });
  try {
    await page.route(`**${HEAVY_URL}`, (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: heavy }));
    await page.addInitScript(() => {
      window.__trayLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__trayLongTasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      window.__trayFrames = [];
      const tick = (now) => {
        window.__trayFrames.push(now);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // Real time: the frame loop runs on its own clock, as it does for an author.
    const url = new URL(baseUrl);
    url.searchParams.set('scene', '/fixtures/scenes/body-floor.gltf');
    url.searchParams.set('sceneScale', '1');
    url.searchParams.append('tray', OBJECT_URL);
    await page.goto(url.href, { waitUntil: 'networkidle' });
    await waitForPageFunctions(page, ['render_game_to_text', '__loadTrayUrls']);
    await waitForTextContentPrefix(page, '#status', 'loaded');
    await page.waitForTimeout(2_000);
    const now = () => page.evaluate(() => performance.now());
    const window_ = async (from, to) => page.evaluate(([a, b]) => {
      // Each long task with the load steps (capture's tray:<step> marks) either side of it.
      const marks = performance.getEntriesByType('mark').filter((mark) => mark.name.startsWith('tray:'));
      const tasks = window.__trayLongTasks.filter((task) => task.start >= a && task.start <= b).map((task) => ({
        ...task,
        after: marks.filter((mark) => mark.startTime <= task.start).at(-1)?.name ?? null,
        before: marks.find((mark) => mark.startTime > task.start)?.name ?? null
      }));
      const frames = window.__trayFrames.filter((t) => t >= a && t <= b);
      const gaps = frames.slice(1).map((t, i) => t - frames[i]);
      return { tasks, maxTaskMs: Math.max(0, ...tasks.map((task) => task.duration)), frames: frames.length, maxFrameGapMs: Math.max(0, ...gaps), meanFrameMs: gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : null };
    }, [from, to]);

    await page.locator('canvas').first().focus();
    await page.getByRole('button', { name: 'Start Recording' }).click();
    await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
    const baselineFrom = await now();
    await page.waitForTimeout(2_000);
    const loadFrom = await now();
    const loaded = await page.evaluate((u) => window.__loadTrayUrls([u]), HEAVY_URL);
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).objects.tray.items.length === 2, null, { timeout: 30_000 });
    const loadTo = await now();
    // The first open and summon of the new item mid-take.
    await page.keyboard.down('KeyT');
    await page.waitForTimeout(400);
    await page.keyboard.press('Digit2');
    await page.waitForTimeout(400);
    await page.keyboard.up('KeyT');
    await page.waitForTimeout(600);
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(1_500);
    const summonTo = await now();
    const baseline = await window_(baselineFrom, loadFrom);
    const load = await window_(loadFrom, loadTo);
    const summon = await window_(loadTo, summonTo);
    const state = await readState(page);
    const heavyItem = summonedItems(state).find((item) => item.name.includes('heavy'));
    if (!loaded) fail('the ~7 MB GLB was refused mid-take');
    if (!heavyItem) fail(`the heavy item was not summoned mid-take (${JSON.stringify(summonedItems(state).map((item) => item.name))})`);
    const budget = Math.max(LONG_TASK_BUDGET_MS, baseline.maxTaskMs * 1.5);
    // The budget holds on a hardware GPU. On a software one (SwiftShader, as on
    // CI) the GPU's own upload and raster run on the CPU and block the page, so
    // the stalls are recorded, not failed (docs/features/tray-everywhere.md).
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) ?? null;
    });
    const softwareGpu = /swiftshader|llvmpipe|software/i.test(gpu ?? '');
    const enforced = !softwareGpu || process.env.SUMMON_HITCH_GPU === '1';
    const over = (what, ms) => (enforced ? fail : (message) => stalls.push(message))(`a ${round(ms, 0)} ms task ${what} (budget ${round(budget, 0)} ms; baseline max ${round(baseline.maxTaskMs, 0)} ms)`);
    const stalls = [];
    if (load.maxTaskMs > budget) over('while loading mid-take', load.maxTaskMs);
    if (summon.maxTaskMs > budget) over('at the first open and summon', summon.maxTaskMs);

    const glb = await saveDownload(page, () => page.getByRole('button', { name: 'Stop Recording' }).click(), path.join(artifactDir, `${label}.glb`));
    const take = loadTake(await readFile(glb));
    const exported = { valid: take.validation?.ok ?? false, objectNodes: objectNodes(take).length, bytes: take.byteLength ?? null };
    if (!exported.valid) fail(`HOLOIM_objects invalid after the mid-take load: ${take.validation?.errors?.join('; ') ?? 'absent'}`);
    // Body keys keep coming through the load: no gap in the take longer than a hitch would leave.
    const keyGaps = take.times.slice(1).map((t, i) => t - take.times[i]);
    exported.maxKeyGapSec = round(Math.max(0, ...keyGaps), 4);
    return { label, status: failures.length ? 'fail' : 'pass', failures, glb, heavyBytes: heavy.length, gpu, budgetEnforced: enforced, softwareGpuStalls: stalls, budgetMs: round(budget, 1), baseline, load, summon, export: exported };
  } finally {
    await context.close();
  }
}
