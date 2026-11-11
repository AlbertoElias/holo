#!/usr/bin/env node
// Fails when a production viewer bundle carries what only the e2e test build
// may: the XR viewer probe and other test hooks (src/testHooks.ts), or the
// IWER emulator injected at startup. The lazy WebXR emulator chunk that
// @pmndrs/xr loads only when `emulate` is on is part of production and allowed;
// it must just not be reachable from the page's static imports.
//
// Spark (the scanned place, docs/features/splat-capture.md) is a lazy chunk:
// allowed in the bundle, never in the startup graph.
//
//   node scripts/check-prod-bundle.mjs [apps/viewer-web/dist]
//   node scripts/check-prod-bundle.mjs apps/capture/dist --capture
//
// `--capture` checks only the place's rules: capture carries IWER on purpose.
// Run on a viewer test build (output/test-builds/web/<variant>) it must fail.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const capture = args.includes('--capture');
const dist = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? 'apps/viewer-web/dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`[check-prod-bundle] No index.html in ${dist}; build the app first.`);
  process.exit(2);
}

// Anywhere in the bundle: test hooks, the IWSDK dev runtime's own code, and the
// scanned places' reports (docs/features/splat-place.md, splat-capture.md).
const FORBIDDEN_ANYWHERE = capture
  ? []
  : ['__HOLOIM_XR_VIEWER__', '__HOLOIM_TEST_MODULES__', '__HOLOIM_AR_TEST_OBSERVER__', '__HOLOIM_FEED_TEST_OBSERVER__', '[IWSDK Dev]', '__HOLOIM_PLACE__', '__HOLOIM_STORED_PLACE__'];
// Spark's renderer and the place's clip shader: in a lazy chunk only.
const SPARK_MARKERS = ['SparkRenderer', 'place_clip_fade'];
// In the startup graph: the IWER emulator itself (viewer), and Spark (both).
const FORBIDDEN_AT_STARTUP = capture ? SPARK_MARKERS : ['installSEM', 'installDevUI', ...SPARK_MARKERS];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const problems = [];
const sparkChunks = [];
for (const file of files(dist).filter((name) => /\.(js|mjs|html)$/.test(name))) {
  const text = readFileSync(file, 'utf8');
  for (const marker of FORBIDDEN_ANYWHERE) {
    if (text.includes(marker)) problems.push(`${path.relative(dist, file)} contains ${marker}`);
  }
  if (SPARK_MARKERS.some((marker) => text.includes(marker))) sparkChunks.push(file);
}

// Static import graph from index.html: module scripts, modulepreloads and
// `import ... from "./x.js"` / `import "./x.js"` (not dynamic import()).
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const queue = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.js)"/g)].map((match) => path.join(dist, match[1]));
const seen = new Set();
while (queue.length > 0) {
  const file = queue.shift();
  if (seen.has(file) || !existsSync(file)) continue;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const marker of FORBIDDEN_AT_STARTUP) {
    if (text.includes(marker)) problems.push(`${path.relative(dist, file)} (loaded at startup) contains ${marker}`);
  }
  for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
    queue.push(path.resolve(path.dirname(file), match[1]));
  }
}

if (seen.size === 0) problems.push('index.html loads no script; the check found nothing to inspect');
// The place is built in: a bundle without its lazy chunk means this check looked at the wrong thing.
if (sparkChunks.length === 0) problems.push('no chunk carries Spark; the scanned place is missing from the build');
if (problems.length > 0) {
  console.error(`[check-prod-bundle] ${dist} is not a clean production bundle:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(capture
  ? `[check-prod-bundle] ${dist}: Spark only in lazy chunks (${seen.size} startup chunks checked, ${sparkChunks.length} lazy).`
  : `[check-prod-bundle] ${dist}: no test hooks or IWER injection, Spark only in lazy chunks (${seen.size} startup chunks checked, ${sparkChunks.length} lazy).`);
