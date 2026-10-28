import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { launchXrBrowser } from '@holoim/tooling-testing/xr-env';
import { writeContactSheet } from '@holoim/tooling-testing/preview';

import { runDesktopObjectTake, runIwerObjectTake } from './lib/object-take.mjs';
import { runIwerObjectPhysics } from './lib/object-physics.mjs';
import { runDesktopMouseObject, runPhoneTouchObject } from './lib/object-pointer.mjs';
import { runFloorReach, runMouseFloorReach, runPhoneFloorReach } from './lib/object-reach.mjs';

// Explain with an object (PRD-043): an IWER controller take and a desktop
// take load the bracket fixture, grab it, move and turn it, put it down, and
// export; each GLB is checked against what capture read during the take (see
// lib/object-take.mjs). Slice 3 adds the crouch-and-reach runs (lib/object-reach.mjs). A third run drives the physics scenarios (throw, drop,
// catch, bounds; lib/object-physics.mjs) and writes object-physics-report.json. Writes output/ci-object/report.json, per-take GLBs,
// screenshots and a contact sheet.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = path.resolve(process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-object');
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];
try {
  // OBJECT_ONLY=reach,mouseReach,phoneReach runs a subset while iterating; the full tier runs everything.
  const only = process.env.OBJECT_ONLY ? new Set(process.env.OBJECT_ONLY.split(',')) : null;
  const runs = [
    ['iwer', () => runIwerObjectTake({ browser, baseUrl, artifactDir, consoleErrors })],
    ['desktop', () => runDesktopObjectTake({ browser, baseUrl, captureRoot: process.cwd(), artifactDir, consoleErrors })],
    ['physics', () => runIwerObjectPhysics({ browser, baseUrl, artifactDir, consoleErrors })],
    ['mouse', () => runDesktopMouseObject({ browser, baseUrl, consoleErrors })],
    ['phone', () => runPhoneTouchObject({ browser, baseUrl, consoleErrors })],
    ['reach', () => runFloorReach({ browser, baseUrl, artifactDir, consoleErrors })],
    ['mouseReach', () => runMouseFloorReach({ browser, baseUrl, consoleErrors })],
    ['phoneReach', () => runPhoneFloorReach({ browser, baseUrl, consoleErrors })]
  ];
  const takes = [];
  for (const [name, run] of runs) if (!only || only.has(name)) takes.push(await run());
  const sheet = writeContactSheet(artifactDir, path.join(artifactDir, 'object-sheet.jpg'));
  const failures = [...takes.flatMap((take) => take.failures.map((message) => `${take.label}: ${message}`)), ...consoleErrors.map((error) => `console: ${error}`)];
  const report = { status: failures.length ? 'fail' : 'pass', failures, takes, sheet: sheet ?? null };
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  for (const take of takes) console.log(`[object] ${take.label}: ${take.status ?? 'fail'}${take.failures.length ? `\n  ${take.failures.join('\n  ')}` : ''}`);
  if (consoleErrors.length) console.log(`[object] console errors:\n  ${consoleErrors.join('\n  ')}`);
  console.log(`[object] report: ${path.join(artifactDir, 'report.json')}`);
  if (failures.length) process.exitCode = 1;
} finally {
  await browser.close();
}
