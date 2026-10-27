import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { launchXrBrowser } from '@holoim/tooling-testing/xr-env';

import { HELD_MARK_PHASES, runHeldMarkPhase, type HeldMarkReport } from './lib/held-mark-takes.ts';

// Hold to mark "this", and the Halo, on every input (docs/features/
// ui-redesign.md, slice 5); the phases are described in lib/held-mark-takes.ts.
// XR_MARKS_ONLY=<substring> keeps only matching phases.
// Writes output/ci-marks/<phase>.glb and marks-report.json.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-marks';
const only = process.env.XR_MARKS_ONLY;
await mkdir(artifactDir, { recursive: true });

const consoleErrors: string[] = [];
const reports: HeldMarkReport[] = [];
const browser = await launchXrBrowser(chromium);
try {
  for (const phase of HELD_MARK_PHASES) {
    if (only && !phase.includes(only)) continue;
    console.log(`[marks] ${phase}`);
    const report = await runHeldMarkPhase({ browser, baseUrl, artifactDir, consoleErrors }, phase);
    reports.push(report);
    console.log(`[marks] ${phase}: ${report.failures.length === 0 ? 'passed' : 'FAILED'}; links ${report.links.map((link) => `${link.provenance} ${link.to} ${link.start}–${link.end}`).join(', ') || '(none)'}`);
  }
  await writeFile(path.join(artifactDir, 'marks-report.json'), JSON.stringify({ reports, consoleErrors }, null, 2));
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.phase}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) throw new Error(`Marks check failed:\n- ${failures.join('\n- ')}`);
  console.log('Marks check passed.');
} finally {
  await browser.close();
}
