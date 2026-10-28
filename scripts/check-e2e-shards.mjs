#!/usr/bin/env node
// CI runs the viewer's mocked and pipeline suites as shards (one pnpm script
// each, balanced by measured cost). A test no shard selects would silently
// stop gating deploy, and one selected twice wastes a runner, so this lists
// every shard and fails unless the shards together select each test of the
// full suite exactly once. Listing starts no servers; the scripts list in
// parallel (about 1 s each warm, longer on a cold runner).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const webDir = path.join(root, "apps/viewer-web");
const scripts = JSON.parse(readFileSync(path.join(webDir, "package.json"), "utf8")).scripts;

// Full suite → the scripts that split it. The VR job's tests are part of the
// mocked suite's spec files, so they count as one of its shards.
const suites = {
  "test:e2e:mocked": [/^test:e2e:mocked:shard\d+$/, /^test:e2e:xr-viewer-vr:shard\d+$/],
  "test:e2e:pipeline": [/^test:e2e:pipeline:shard\d+$/]
};

async function listTests(script) {
  const { stdout } = await promisify(execFile)("pnpm", ["run", "--silent", script, "--list", "--reporter=list"], {
    cwd: webDir,
    encoding: "utf8",
    env: { ...process.env, CI: "" }
  });
  return stdout.split("\n").filter((line) => line.includes(" › ")).map((line) => line.trim());
}

let failed = false;
for (const [full, patterns] of Object.entries(suites)) {
  const shards = Object.keys(scripts).filter((name) => patterns.some((pattern) => pattern.test(name)));
  const [expected, ...listed] = await Promise.all([full, ...shards].map(listTests));
  const seen = new Map();
  for (const [i, shard] of shards.entries()) {
    for (const test of listed[i]) seen.set(test, [...(seen.get(test) ?? []), shard]);
  }
  const missing = expected.filter((test) => !seen.has(test));
  const twice = [...seen].filter(([, owners]) => owners.length > 1);
  const extra = [...seen.keys()].filter((test) => !expected.includes(test));
  for (const test of missing) console.error(`${full}: no shard runs ${test}`);
  for (const [test, owners] of twice) console.error(`${full}: ${owners.join(" and ")} both run ${test}`);
  for (const test of extra) console.error(`${full}: ${seen.get(test).join(", ")} runs ${test}, which the full suite does not`);
  if (missing.length || twice.length || extra.length) failed = true;
  else console.log(`${full}: ${expected.length} tests, each in exactly one of ${shards.length} shards`);
}
process.exit(failed ? 1 : 0);
