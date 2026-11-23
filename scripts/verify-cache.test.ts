// The result cache decides that a check does not need to run. A wrong "skip"
// is a stale pass: the only failure that matters here. Each test below comes
// from one way the real system can make a stale pass (the table in
// docs/features/verify-result-cache.md), on real git repositories and with
// Playwright's JSON report shape as measured for each end state:
//
//   A. A change is not seen: an unstaged or staged edit, a new untracked file,
//      a deletion, a mode change, an edit in a git-ignored file a suite reads.
//   B. A file is wrongly left out of a suite's inputs (docs, authoring tools),
//      or something outside starts to read a left-out folder.
//   C. A pass from a different environment is used (a variable the code
//      reads, packages that do not match the lockfile).
//   D. A Playwright run that did not prove a spec stores a pass for it: a test
//      that never ran or was interrupted, a run that stopped, an old report,
//      a step that failed outside the tests, a file that was to be left out.
//   E. The list of spec files of a step is wrong: a partial run rewrites it,
//      a new spec file is not in it, a spec depends on another spec's code.
//   F. A pass with a skipped test is used where the skip condition differs.
//   G. The files change while the step runs.
//
// The end-to-end proof (real verify:pr runs) is in the brief's test plan.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  keysOf,
  openCache,
  outsideReferences,
  ResultCache,
  specVerdicts,
  takeSnapshot,
  type CacheStep,
  type PlaywrightReport
} from "./verify-cache.ts";

const TREE: CacheStep = { cache: { inputs: "tree" }, command: "pnpm run check:all", label: "lint" };
const CODE: CacheStep = { cache: { inputs: "code" }, command: "pnpm run test:xr:capture", label: "xr-capture" };
const SPECS: CacheStep = {
  cache: { inputs: "code", specs: { dir: "apps/viewer-web/e2e", report: "output/report.json" } },
  command: "pnpm run test:smoke:pipeline",
  label: "pipeline"
};

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

/** Packages installed from the lockfile, as pnpm leaves them. */
function install(root: string): void {
  write(root, "node_modules/.pnpm/lock.yaml", "lockfileVersion: 9\n");
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "holoim-verify-cache-")));
  made.push(root);
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", "node_modules\noutput\n.env\napps/viewer-web/public/local-places\n");
  write(root, "pnpm-lock.yaml", "lockfileVersion: 9\n");
  write(root, "package.json", "{}\n");
  write(root, "README.md", "# Fixture\n");
  write(root, "docs/guide.md", "A guide.\n");
  write(root, "docs/product/design/tokens.json", "{}\n");
  write(root, "apps/capture/src/main.ts", "export const mode = process.env.XR_TEST_MODE;\n");
  write(root, "apps/capture/scripts/authoring/make.ts", "export const make = 1;\n");
  write(root, "apps/viewer-web/src/app.ts", "export const app = 1;\n");
  write(root, "apps/viewer-web/e2e/helpers.ts", "export const helper = 1;\n");
  write(root, "apps/viewer-web/e2e/a.spec.ts", "import './helpers';\n");
  write(root, "apps/viewer-web/e2e/b.spec.ts", "import './helpers';\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  install(root);
  return root;
}

const key = (root: string, step: CacheStep, env: NodeJS.ProcessEnv = {}) => keysOf(step, takeSnapshot(root, env)).base;

function open(root: string, options: { dir?: string; env?: NodeJS.ProcessEnv; read?: boolean } = {}): ResultCache {
  return new ResultCache({ dir: options.dir ?? path.join(root, "output/cache"), env: options.env ?? {}, read: options.read ?? true, root });
}

type TestEnd = "passed" | "failed" | "declared-skip" | "never-ran" | "interrupted";
/** One test of a Playwright JSON report, as Playwright 1.5x writes each end state. */
const END: Record<TestEnd, { expectedStatus: string; status: string }> = {
  passed: { expectedStatus: "passed", status: "expected" },
  failed: { expectedStatus: "passed", status: "unexpected" },
  "declared-skip": { expectedStatus: "skipped", status: "skipped" },
  "never-ran": { expectedStatus: "passed", status: "skipped" },
  interrupted: { expectedStatus: "passed", status: "skipped" }
};

function report(files: Record<string, TestEnd[]>, options: { errors?: readonly unknown[]; startTime?: number } = {}): PlaywrightReport {
  return {
    errors: [...(options.errors ?? [])],
    stats: { startTime: new Date(options.startTime ?? Date.now()).toISOString() },
    suites: Object.entries(files).map(([file, ends]) => ({
      file,
      specs: ends.slice(0, 1).map((end) => ({ file, tests: [END[end]] })),
      // Tests in a describe block are one level down.
      suites: [{ file, specs: ends.slice(1).map((end) => ({ file, tests: [END[end]] })) }]
    }))
  };
}

/** Runs the step as verify:pr does: decide, write the report the run leaves, record. */
function runSpecs(cache: ResultCache, files: Record<string, TestEnd[]>, options: { code?: number; errors?: readonly unknown[]; reportAge?: number; noReport?: boolean } = {}) {
  const decision = cache.decide(SPECS);
  const startedAt = Date.now();
  rmSync(path.join(cache.root, "output/report.json"), { force: true });
  if (!options.noReport) {
    write(cache.root, "output/report.json", JSON.stringify(report(files, { errors: options.errors ?? [], startTime: startedAt - (options.reportAge ?? 0) })));
  }
  const failed = Object.values(files).some((ends) => ends.some((end) => end !== "passed" && end !== "declared-skip"));
  const log = cache.record(SPECS, decision, { code: options.code ?? (failed ? 1 : 0), seconds: 1, startedAt });
  return { decision, log };
}

const ALL_PASS = { "a.spec.ts": ["passed", "passed"], "b.spec.ts": ["passed"] } satisfies Record<string, TestEnd[]>;

// --- A. Every change to an input changes the key ---

test("A: an unstaged edit, a staged edit, a new file, a deletion and a mode change each change the key", () => {
  const root = makeRepo();
  const clean = key(root, CODE);
  assert.equal(key(root, CODE), clean, "the key of an unchanged tree is stable");

  write(root, "apps/viewer-web/src/app.ts", "export const app = 2;\n");
  const edited = key(root, CODE);
  assert.notEqual(edited, clean, "unstaged edit");

  git(root, "add", "apps/viewer-web/src/app.ts");
  assert.equal(key(root, CODE), edited, "staging the same content keeps the key");
  git(root, "commit", "-q", "-m", "edit");
  assert.equal(key(root, CODE), edited, "committing the same content keeps the key");

  write(root, "apps/viewer-web/src/app.ts", "export const app = 3;\n");
  git(root, "add", "apps/viewer-web/src/app.ts");
  const staged = key(root, CODE);
  assert.notEqual(staged, edited, "staged edit");
  write(root, "apps/viewer-web/src/app.ts", "export const app = 2;\n");
  assert.equal(key(root, CODE), edited, "the key follows the file on disk, not the index");
  git(root, "reset", "-q", "--hard");

  write(root, "apps/viewer-web/src/new.ts", "export {};\n");
  const withNew = key(root, CODE);
  assert.notEqual(withNew, edited, "new untracked file");
  rmSync(path.join(root, "apps/viewer-web/src/new.ts"));
  assert.equal(key(root, CODE), edited);

  rmSync(path.join(root, "apps/viewer-web/src/app.ts"));
  assert.notEqual(key(root, CODE), edited, "deleted file");
  git(root, "checkout", "--", "apps/viewer-web/src/app.ts");

  chmodSync(path.join(root, "apps/viewer-web/src/app.ts"), 0o755);
  assert.notEqual(key(root, CODE), edited, "mode change");
});

test("A: a git-ignored .env file and a downloaded scan are inputs", () => {
  const root = makeRepo();
  const clean = key(root, CODE);
  write(root, "apps/viewer-api/.env", "A=1\n");
  const withEnv = key(root, CODE);
  assert.notEqual(withEnv, clean, "new .env");
  write(root, "apps/viewer-api/.env", "A=2\n");
  assert.notEqual(key(root, CODE), withEnv, "edited .env");
  const before = key(root, CODE);
  write(root, "apps/viewer-web/public/local-places/room/scan.sog", "scan");
  assert.notEqual(key(root, CODE), before, "a scan under local-places");
});

// --- B. What a suite does not read ---

test("B: docs, Markdown and the authoring tools change the tree key and not a suite's key", () => {
  const root = makeRepo();
  const code = key(root, CODE);
  let tree = key(root, TREE);
  for (const [file, text] of [
    ["docs/guide.md", "Changed.\n"],
    ["README.md", "# Changed\n"],
    ["apps/capture/scripts/authoring/make.ts", "export const make = 2;\n"],
    ["apps/capture/NOTES.md", "new\n"]
  ] as const) {
    write(root, file, text);
    assert.equal(key(root, CODE), code, `${file} is not an input of a browser suite`);
    assert.notEqual(key(root, TREE), tree, `${file} is an input of lint, unit and build`);
    tree = key(root, TREE);
  }
  write(root, "docs/product/design/tokens.json", '{"a":1}\n');
  assert.notEqual(key(root, CODE), code, "the design tokens are code");
});

test("B: a reference to a left-out folder from outside is found; comments and its own package script are not", () => {
  const folder = "apps/capture/scripts/authoring/";
  const pkg = (scripts: Record<string, string>) => ({ path: "apps/capture/package.json", text: JSON.stringify({ scripts }, null, 2) });
  const own = { "test:authoring:face-bar": "tsx scripts/authoring/face-bar-check.ts" };
  const quiet = [
    pkg(own),
    { path: "apps/capture/src/a.ts", text: "// made by scripts/authoring/house.ts\n/**\n * See `scripts/authoring/base.json`.\n */\nexport {};\n" },
    { path: "apps/capture/scripts/authoring/make.ts", text: 'import "./lib/x.ts";\n' },
    { path: ".agents/x.ts", text: 'const skill = ".agents/skills/hologram-authoring/SKILL.md";\n' }
  ];
  assert.deepEqual(outsideReferences(folder, quiet), []);

  const imported = outsideReferences(folder, [...quiet, { path: "apps/capture/scripts/lib/take.ts", text: 'import { make } from "../authoring/make.ts";\n' }]);
  assert.equal(imported.length, 1);
  assert.match(imported[0]!, /^apps\/capture\/scripts\/lib\/take\.ts:1:/);

  const spec = outsideReferences(folder, [...quiet, { path: "apps/viewer-web/e2e/x.spec.ts", text: 'const f = path.resolve(dir, "../../capture/scripts/authoring/out.glb");\n' }]);
  assert.equal(spec.length, 1);

  const workflow = outsideReferences(folder, [...quiet, { path: ".github/workflows/ci.yml", text: "      - run: pnpm --filter @holoim/capture run test:authoring:face-bar\n" }]);
  assert.equal(workflow.length, 1, "a workflow that runs the folder's script reads the folder");

  const chained = outsideReferences(folder, [pkg({ ...own, test: "vitest run && pnpm run test:authoring:face-bar" })]);
  assert.equal(chained.length, 1, "a suite script that runs the folder's script reads the folder");
});

// --- C. The environment ---

test("C: a variable the code reads is in the key; ports and verify:pr's own switches are not", () => {
  const root = makeRepo();
  const plain = key(root, CODE, {});
  assert.notEqual(key(root, CODE, { XR_TEST_MODE: "iwer" }), plain, "XR_TEST_MODE is read by apps/capture/src/main.ts");
  assert.notEqual(key(root, CODE, { XR_TEST_MODE: "iwer" }), key(root, CODE, { XR_TEST_MODE: "live" }));
  assert.notEqual(key(root, CODE, { VITE_ANYTHING: "1" }), plain, "tool variables count without a read in the code");
  assert.notEqual(key(root, CODE, { CI: "true" }), plain);
  assert.equal(key(root, CODE, { HOME: "/x", E2E_API_PORT: "4001", DEV_PORT: "9", VERIFY_PR_NO_LOCK: "1", UNRELATED: "1" }), plain);

  write(root, "apps/viewer-web/playwright.config.ts", "export const url = process.env.E2E_BASE_URL;\n");
  const local = key(root, CODE, { E2E_BASE_URL: "https://localhost:3174" });
  assert.equal(key(root, CODE, { E2E_BASE_URL: "https://localhost:4174" }), local, "a moved local port tests the same thing");
  assert.notEqual(key(root, CODE, { E2E_BASE_URL: "https://staging.example.com" }), local, "another host does not");
});

test("C: the cache is off when packages do not match the lockfile, and when a run starts with E2E_PASSED_SPECS set", () => {
  const root = makeRepo();
  const dir = path.join(root, "output/cache");
  assert.ok(openCache({ env: { VERIFY_PR_CACHE_DIR: dir }, read: true, root }) instanceof ResultCache);

  const reserved = openCache({ env: { E2E_PASSED_SPECS: "a.spec.ts", VERIFY_PR_CACHE_DIR: dir }, read: true, root });
  assert.ok("off" in reserved && /E2E_PASSED_SPECS/.test(reserved.off));

  write(root, "pnpm-lock.yaml", "lockfileVersion: 9\n# a new dependency\n");
  const stale = openCache({ env: { VERIFY_PR_CACHE_DIR: dir }, read: true, root });
  assert.ok("off" in stale && /pnpm install/.test(stale.off));
  rmSync(path.join(root, "node_modules"), { recursive: true });
  assert.ok("off" in openCache({ env: { VERIFY_PR_CACHE_DIR: dir }, read: true, root }), "no packages installed");
});

// --- Shared between worktrees ---

test("a pass from one worktree is used in another with the same files, and not with a different file", () => {
  const root = makeRepo();
  const other = `${root}-other`;
  made.push(other);
  git(root, "worktree", "add", "-q", other, "-b", "second");
  install(other);
  const dir = path.join(root, "output/cache");

  const first = open(root, { dir });
  const decision = first.decide(CODE);
  assert.equal(decision.action, "run");
  assert.deepEqual(first.record(CODE, decision, { code: 0, seconds: 144, startedAt: Date.now() }), []);

  const second = open(other, { dir });
  const reused = second.decide(CODE);
  assert.equal(reused.action, "skip");
  assert.ok(reused.note.includes(root), "the skip names the worktree that passed");
  assert.equal(second.decide(TREE).action, "run", "another step has its own key");

  write(other, "apps/capture/src/main.ts", "export const mode = 1;\n");
  assert.equal(second.decide(CODE).action, "run");
  assert.equal(first.decide(CODE).action, "skip", "the first worktree did not change");
});

test("a failed step stores nothing; --no-cache does not read but stores", () => {
  const root = makeRepo();
  const cache = open(root);
  cache.record(CODE, cache.decide(CODE), { code: 1, seconds: 1, startedAt: Date.now() });
  assert.equal(cache.decide(CODE).action, "run");

  const noRead = open(root, { read: false });
  const decision = noRead.decide(CODE);
  noRead.record(CODE, decision, { code: 0, seconds: 1, startedAt: Date.now() });
  assert.equal(noRead.decide(CODE).action, "run", "a run that does not read the cache runs every step");
  assert.equal(cache.decide(CODE).action, "skip", "and its passes are stored");
});

// --- D. What a Playwright run proved ---

test("D: the verdict of each end state of a test", () => {
  const verdicts = specVerdicts(
    report({
      "pass.spec.ts": ["passed", "passed"],
      "fail.spec.ts": ["passed", "failed"],
      "skip.spec.ts": ["passed", "declared-skip", "declared-skip"],
      "never.spec.ts": ["passed", "never-ran"],
      "cut.spec.ts": ["interrupted"]
    })
  )!;
  assert.deepEqual(verdicts.get("pass.spec.ts"), { passed: true, skipped: 0 });
  assert.deepEqual(verdicts.get("fail.spec.ts"), { passed: false, skipped: 0 });
  assert.deepEqual(verdicts.get("skip.spec.ts"), { passed: true, skipped: 2 });
  assert.equal(verdicts.get("never.spec.ts")!.passed, false, "a test that never ran proves nothing");
  assert.equal(verdicts.get("cut.spec.ts")!.passed, false, "an interrupted test proves nothing");
  assert.equal(specVerdicts(report({ "pass.spec.ts": ["passed"] }, { errors: [{ message: "Timed out waiting 960s for the test suite to run" }] })), null);
  assert.equal(specVerdicts({ suites: [] }), null, "a report without the errors list is not a Playwright report");
});

test("D: a failed spec file reruns alone; the files that passed are left out", () => {
  const root = makeRepo();
  const cache = open(root);
  const first = runSpecs(cache, { "a.spec.ts": ["passed", "passed"], "b.spec.ts": ["passed", "failed"] });
  assert.equal(first.decision.action, "run");
  assert.deepEqual(first.decision.env, {}, "the first run is a full run");

  const second = cache.decide(SPECS);
  assert.equal(second.action, "run");
  assert.deepEqual(second.env, { E2E_PASSED_SPECS: "a.spec.ts" });

  // The rerun: only b runs, and passes.
  runSpecs(cache, { "b.spec.ts": ["passed", "passed"] });
  const third = cache.decide(SPECS);
  assert.equal(third.action, "skip");
  assert.match(third.note, /all 2 spec files/);
});

test("D: a run that did not complete stores no pass", () => {
  for (const [name, options] of [
    ["a top-level error (global timeout, failed server)", { errors: [{ message: "global timeout" }], code: 1 }],
    ["a report from an earlier run", { reportAge: 60_000 }],
    ["no report", { noReport: true }],
    ["a step that failed with every spec file passing", { code: 1 }]
  ] as const) {
    const root = makeRepo();
    const cache = open(root);
    const { log } = runSpecs(cache, ALL_PASS, options);
    assert.equal(log.length, 1, name);
    assert.match(log[0]!, /no pass stored/, name);
    const next = cache.decide(SPECS);
    assert.equal(next.action, "run", name);
    assert.deepEqual(next.env, {}, name);
  }
});

test("D: a never-run or interrupted test stores no pass for its file", () => {
  const root = makeRepo();
  const cache = open(root);
  runSpecs(cache, { "a.spec.ts": ["passed", "never-ran"], "b.spec.ts": ["passed"] });
  assert.deepEqual(cache.decide(SPECS).env, { E2E_PASSED_SPECS: "b.spec.ts" });
});

test("D: a rerun in which a left-out file ran stores nothing", () => {
  const root = makeRepo();
  const cache = open(root);
  runSpecs(cache, { "a.spec.ts": ["passed"], "b.spec.ts": ["failed"] });
  // E2E_PASSED_SPECS did not reach Playwright: a ran again.
  const { log } = runSpecs(cache, ALL_PASS);
  assert.match(log[0]!, /was to be left out/);
  assert.deepEqual(cache.decide(SPECS).env, { E2E_PASSED_SPECS: "a.spec.ts" }, "b has no pass");
});

// --- E. The spec files of a step ---

test("E: an edited spec reruns alone; an edited helper reruns every spec", () => {
  const root = makeRepo();
  const cache = open(root);
  runSpecs(cache, ALL_PASS);
  assert.equal(cache.decide(SPECS).action, "skip");

  write(root, "apps/viewer-web/e2e/b.spec.ts", "import './helpers';\n// changed\n");
  assert.deepEqual(cache.decide(SPECS).env, { E2E_PASSED_SPECS: "a.spec.ts" });
  assert.equal(cache.decide(CODE).action, "run", "a step with one record for all its inputs sees the spec edit too");

  write(root, "apps/viewer-web/e2e/helpers.ts", "export const helper = 2;\n");
  const afterHelper = cache.decide(SPECS);
  assert.equal(afterHelper.action, "run");
  assert.deepEqual(afterHelper.env, {});
});

test("E: a partial run does not change the list of spec files", () => {
  const root = makeRepo();
  const cache = open(root);
  runSpecs(cache, { "a.spec.ts": ["failed"], "b.spec.ts": ["passed"] });
  runSpecs(cache, { "a.spec.ts": ["failed"] });
  // If the partial run had rewritten the list to [a], b would no longer be needed and a pass of a alone
  // would skip the step; if it had been lost, the next run would be a full run.
  assert.deepEqual(cache.decide(SPECS).env, { E2E_PASSED_SPECS: "b.spec.ts" });
  runSpecs(cache, { "a.spec.ts": ["passed"] });
  assert.match(cache.decide(SPECS).note, /all 2 spec files/);
});

test("E: a new spec file makes a full run", () => {
  const root = makeRepo();
  const cache = open(root);
  runSpecs(cache, ALL_PASS);
  write(root, "apps/viewer-web/e2e/c.spec.ts", "import './helpers';\n");
  const decision = cache.decide(SPECS);
  assert.equal(decision.action, "run");
  assert.deepEqual(decision.env, {}, "the stored list does not name c, so it cannot be trusted");
});

test("E: when a spec imports another spec, the step has one record", () => {
  const root = makeRepo();
  write(root, "apps/viewer-web/e2e/b.spec.ts", "import { shared } from './a.spec';\n");
  const cache = open(root);
  assert.deepEqual(keysOf(SPECS, takeSnapshot(root, {})).specs, {});
  runSpecs(cache, { "a.spec.ts": ["passed"], "b.spec.ts": ["failed"] });
  assert.deepEqual(cache.decide(SPECS).env, {}, "no file is left out");
  runSpecs(cache, ALL_PASS);
  assert.equal(cache.decide(SPECS).action, "skip");
  write(root, "apps/viewer-web/e2e/a.spec.ts", "export const shared = 2;\n");
  const edited = cache.decide(SPECS);
  assert.equal(edited.action, "run");
  assert.deepEqual(edited.env, {});
});

// --- F. Skipped tests ---

test("F: a pass with a skipped test is used only in the worktree that made it", () => {
  const root = makeRepo();
  const other = `${root}-other`;
  made.push(other);
  git(root, "worktree", "add", "-q", other, "-b", "second");
  install(other);
  const dir = path.join(root, "output/cache");
  const first = open(root, { dir });
  runSpecs(first, { "a.spec.ts": ["passed", "declared-skip"], "b.spec.ts": ["passed"] });
  assert.equal(first.decide(SPECS).action, "skip", "the same worktree skips the same tests again");
  // Another worktree can have what the skipped test waits for (a file git ignores), so it runs that file.
  assert.deepEqual(open(other, { dir }).decide(SPECS).env, { E2E_PASSED_SPECS: "b.spec.ts" });
});

// --- G. Files that change during a step ---

test("G: a file that changes while the step runs stores no pass", () => {
  const root = makeRepo();
  const cache = open(root);
  const decision = cache.decide(CODE);
  write(root, "apps/capture/src/main.ts", "export const mode = 2;\n");
  const log = cache.record(CODE, decision, { code: 0, seconds: 1, startedAt: Date.now() });
  assert.match(log[0]!, /changed during the run/);
  assert.equal(cache.decide(CODE).action, "run");
  git(root, "checkout", "--", "apps/capture/src/main.ts");
  assert.equal(cache.decide(CODE).action, "run", "the run on the first content was not stored either");

  const specs = cache.decide(SPECS);
  write(root, "apps/viewer-web/e2e/a.spec.ts", "// edited during the run\n");
  write(root, "output/report.json", JSON.stringify(report(ALL_PASS)));
  cache.record(SPECS, specs, { code: 0, seconds: 1, startedAt: Date.now() - 500 });
  assert.deepEqual(cache.decide(SPECS).env, { E2E_PASSED_SPECS: "b.spec.ts" }, "only the spec that did not change has a pass");
});

test("records older than 14 days are removed", () => {
  const root = makeRepo();
  const cache = open(root);
  cache.record(CODE, cache.decide(CODE), { code: 0, seconds: 1, startedAt: Date.now() });
  const [file] = readdirSync(cache.dir);
  const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(cache.dir, file!), old, old);
  cache.prune();
  assert.deepEqual(readdirSync(cache.dir), []);
  assert.equal(cache.decide(CODE).action, "run");
});
