#!/usr/bin/env node
// Fails when a production viewer bundle carries what only the e2e test build
// may: the XR viewer probe and other test hooks (src/testHooks.ts), or the
// IWER emulator injected at startup. The lazy WebXR emulator chunk that
// @pmndrs/xr loads only when `emulate` is on is part of production and allowed;
// it must just not be reachable from the page's static imports.
//
//   node scripts/check-prod-bundle.mjs [apps/viewer-web/dist]
//
// Run on a test build (output/test-builds/web/<variant>) it must fail.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'apps/viewer-web/dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error(`[check-prod-bundle] No index.html in ${dist}; build the viewer first.`);
  process.exit(2);
}

// Anywhere in the bundle: test hooks, and the IWSDK dev runtime's own code.
const FORBIDDEN_ANYWHERE = ['__HOLOIM_XR_VIEWER__', '__HOLOIM_TEST_MODULES__', '__HOLOIM_AR_TEST_OBSERVER__', '__HOLOIM_FEED_TEST_OBSERVER__', '[IWSDK Dev]'];
// In the startup graph: the IWER emulator itself.
const FORBIDDEN_AT_STARTUP = ['installSEM', 'installDevUI'];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const problems = [];
for (const file of files(dist).filter((name) => /\.(js|mjs|html)$/.test(name))) {
  const text = readFileSync(file, 'utf8');
  for (const marker of FORBIDDEN_ANYWHERE) {
    if (text.includes(marker)) problems.push(`${path.relative(dist, file)} contains ${marker}`);
  }
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
if (problems.length > 0) {
  console.error(`[check-prod-bundle] ${dist} is not a clean production bundle:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`[check-prod-bundle] ${dist}: no test hooks or IWER injection (${seen.size} startup chunks checked).`);
