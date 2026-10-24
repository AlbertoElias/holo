import { mkdir, readdir } from 'node:fs/promises';
import { chromium } from 'playwright';

import { filterReplayFixtures, launchXrBrowser, mapWithConcurrency } from '@holoim/tooling-testing/xr-env';

import { runDesktopPointingCheck } from './lib/pointing-desktop-take.mjs';
import { replayPointingTake } from './lib/pointing-iwer-replay.mjs';

// Self-resolving pointing, headset side. Replays labelled input takes through
// the real WebXR path (IWER ActionPlayer → XRHand joints → retargeter →
// avatar), records and exports with capture's own recorder, reads
// HOLOIM_meaning from the exported GLB, and scores its links against the
// labels in fixtures/pointing-labels/:
//   - headset-open-fist-pinch-point-wave-reach: a real headset take; one link
//     per labelled point, timed within 0.5 s, and silence elsewhere. Its ray
//     hits arbitrary things in the replay scene, so referents are not scored.
//   - iwer-pointing-targets: a synthetic take in a generated scene; links on
//     the named targets and the avatar's own hand, none for sky or a brief
//     point.
// Until capture writes the extension the check fails with "no HOLOIM_meaning".
//
// XR_REPLAY_ONLY=<substring> keeps only matching labels files;
// POINTING_CONCURRENCY sets how many takes replay at once (default 2).
// Writes output/ci-pointing/<label>-{report.json,sheet.jpg,.glb}.

const baseUrl = process.env.BASE_URL ?? 'https://127.0.0.1:5174/';
const labelsDir = process.env.POINTING_LABELS ?? 'fixtures/pointing-labels';
const artifactDir = process.env.XR_TEST_ARTIFACT_DIR ?? 'output/ci-pointing';
const concurrency = Math.max(1, Number(process.env.POINTING_CONCURRENCY ?? 2));

// The scripted desktop take (lib/pointing-desktop-take.mjs) has no labels file.
const replayFilter = process.env.XR_REPLAY_ONLY;
const runDesktop = !replayFilter || 'desktop-pointing-targets'.includes(replayFilter);
const allLabelFiles = (await readdir(labelsDir).catch(() => [])).filter((name) => name.endsWith('.json')).sort();
const labelFiles = runDesktop && replayFilter && !allLabelFiles.some((name) => name.includes(replayFilter)) ? [] : filterReplayFixtures(allLabelFiles);
if (labelFiles.length === 0 && !runDesktop) throw new Error(`No pointing labels in ${labelsDir}.`);
await mkdir(artifactDir, { recursive: true });

const browser = await launchXrBrowser(chromium);
const consoleErrors = [];

function format(report) {
  const lines = [`[pointing] ${report.label}: ${report.status}, ${report.links.length} link(s)`];
  for (const match of report.matches) {
    lines.push(match.link
      ? `  ${match.ok ? 'ok  ' : 'FAIL'} ${match.point}: ${match.link.start}–${match.link.end} s (label ${match.label.start}–${match.label.end}) ${match.link.from} → ${match.link.to}`
      : `  MISS ${match.point}`);
  }
  for (const window of report.silence) lines.push(`  ${window.links ? 'FAIL' : 'ok  '} silent ${window.window} ${window.start}–${window.end} s: ${window.links} intruding link(s)`);
  if (report.sheet) lines.push(`  sheet: ${report.sheet}`);
  return lines.join('\n');
}

try {
  const reports = await mapWithConcurrency(labelFiles, concurrency, (labelFile) => replayPointingTake({
    browser, baseUrl, captureRoot: process.cwd(), labelsDir, artifactDir, consoleErrors, labelFile
  }));
  for (const report of reports) console.log(format(report));
  if (runDesktop) {
    const desktop = await runDesktopPointingCheck({ browser, baseUrl, artifactDir, consoleErrors });
    console.log(`[pointing] ${desktop.label}: ${desktop.status}, ${desktop.links.length} link(s), ${desktop.spans.length} span(s)\n  sheet: ${desktop.sheet}`);
    reports.push({ ...desktop, matches: [], silence: [] });
  }
  const failures = reports.flatMap((report) => report.failures.map((failure) => `${report.label}: ${failure}`));
  if (consoleErrors.length > 0) failures.push(`console errors:\n${consoleErrors.join('\n')}`);
  if (failures.length > 0) throw new Error(`Pointing check failed:\n- ${failures.join('\n- ')}`);
  console.log('Pointing check passed.');
} finally {
  await browser.close();
}
