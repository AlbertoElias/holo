import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { launchXrBrowser } from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import { VOICE_BROWSER_ARGS, runDesktopVoiceTake, runIwerFindTake, runIwerVoiceTake } from './lib/find-take.mjs';
import { runDesktopFindTake, runDesktopSummonTake, runIwerHandsSummonTake, runIwerSummonTake } from './lib/summon-take.mjs';

// Summon and place while speaking (PRD-045): IWER controller, IWER hands and
// desktop takes open the tray with its held gesture, summon and place items,
// and export; each GLB is checked against what capture read during the take
// (see lib/summon-take.mjs). Find (PRD-060) on the desktop and in the
// headset, with voice, summons a found object (see lib/find-take.mjs). Writes output/ci-summon/report.json, per-take
// GLBs, screenshots and a contact sheet.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = path.resolve(process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-summon');
const only = process.env.SUMMON_ONLY;
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
// Voice phases record a fake mic; the other takes keep the default (no mic).
let voiceBrowser = null;
const withMic = async () => (voiceBrowser ??= await launchXrBrowser(chromium, { args: VOICE_BROWSER_ARGS }));
const consoleErrors = [];
try {
  const phases = [
    ['controllers', () => runIwerSummonTake({ browser, baseUrl, artifactDir, consoleErrors })],
    ['hands', () => runIwerHandsSummonTake({ browser, baseUrl, artifactDir, consoleErrors })],
    ['desktop', () => runDesktopSummonTake({ browser, baseUrl, captureRoot: process.cwd(), artifactDir, consoleErrors })],
    ['find', () => runDesktopFindTake({ browser, baseUrl, captureRoot: process.cwd(), artifactDir, consoleErrors })],
    ['headset-find', () => runIwerFindTake({ browser, baseUrl, captureRoot: process.cwd(), artifactDir, consoleErrors })],
    ['headset-voice', async () => runIwerVoiceTake({ browser: await withMic(), baseUrl, captureRoot: process.cwd(), artifactDir, consoleErrors })],
    ['desktop-voice', async () => runDesktopVoiceTake({ browser: await withMic(), baseUrl, captureRoot: process.cwd(), artifactDir, consoleErrors })]
  ];
  const takes = [];
  for (const [name, run] of phases) if (!only || only === name) takes.push(await run());
  const sheet = writeContactSheet(artifactDir, path.join(artifactDir, 'summon-sheet.jpg'));
  const failures = [...takes.flatMap((take) => take.failures.map((message) => `${take.label}: ${message}`)), ...consoleErrors.map((error) => `console: ${error}`)];
  const report = { status: failures.length ? 'fail' : 'pass', failures, takes, sheet: sheet ?? null };
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  for (const take of takes) console.log(`[summon] ${take.label}: ${take.status ?? 'fail'}${take.failures.length ? `\n  ${take.failures.join('\n  ')}` : ''}`);
  if (consoleErrors.length) console.log(`[summon] console errors:\n  ${consoleErrors.join('\n  ')}`);
  console.log(`[summon] report: ${path.join(artifactDir, 'report.json')}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
  await voiceBrowser?.close();
}
