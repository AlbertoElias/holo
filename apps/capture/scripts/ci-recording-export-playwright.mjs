import { chromium } from 'playwright';

import {
  createXrContext,
  launchXrBrowser,
  resolveSimulationViewport,
  waitForPageFunctions,
  waitForTextContentPrefix,
  wireXrConsoleErrors
} from '@holoim/tooling-testing/xr-env';

// B-010: stopping a recording must finish exporting even when the page stops
// delivering animation frames (a headset that went to sleep, an XR session
// that ended mid-export). The GLB downloads, the UI returns to idle, and the
// avatar size unlocks.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];
try {
  const context = await createXrContext(browser, { viewport: resolveSimulationViewport(), acceptDownloads: true });
  const page = await context.newPage();
  wireXrConsoleErrors(page, consoleErrors);
  const url = new URL(baseUrl);
  url.searchParams.set('manualClock', '1');
  await page.goto(url.href, { waitUntil: 'networkidle' });
  await waitForPageFunctions(page, ['advanceTime', 'render_game_to_text']);
  await waitForTextContentPrefix(page, '#status', 'loaded');

  await page.getByRole('button', { name: 'Start Recording' }).click();
  await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
  await page.evaluate(() => window.advanceTime(500));

  // Frames stop for good, as on a sleeping headset.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  const download = page.waitForEvent('download', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Stop Recording' }).click();
  const file = (await download).suggestedFilename();
  assert(file.endsWith('.glb'), `expected a GLB download, got ${file}`);

  await page.getByRole('button', { name: 'Start Recording' }).waitFor({ timeout: 5_000 });
  const locked = await page.evaluate(() => JSON.parse(window.render_game_to_text()).heightAdaptation.recordingSizeLocked);
  assert(locked === false, 'avatar size stayed locked after export');
  assert(consoleErrors.length === 0, `console errors:\n${consoleErrors.join('\n')}`);
  console.log(`Recording export check passed: ${file} exported with frames stalled.`);
} finally {
  await browser.close();
}
