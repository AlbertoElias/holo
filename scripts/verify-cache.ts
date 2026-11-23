// Result cache for verify:pr: a step does not run again when the same inputs
// already passed it, in this worktree or another one.
//
// The rule (docs/features/verify-result-cache.md): the cache only removes
// work. verify:pr selects steps from the diff as before; the cache then skips
// a selected step only when everything the step can read is the same as in a
// run that passed. When the cache cannot decide, it is off and the step runs.
//
// Inputs of a step:
//   "tree"  every file git tracks or would track (lint, typecheck, unit,
//           build, knowledge: they read code and Markdown everywhere).
//   "code"  the same files without Markdown, docs/ and the folders in
//           NOT_SUITE_INPUTS (the browser suites; scripts/check-ci-areas.ts
//           guards that nothing outside those folders names them).
// The key does not use the area selector's mapping: the selector decides
// which steps a diff needs, and a gap there must not become a stale pass.
// Every key also holds the git-ignored files the tests read (IGNORED_INPUTS),
// the environment variables the code reads, and the tool versions.
//
// A Playwright step with `specs` keeps one record per spec file: the key of a
// spec is the step's other inputs plus that one spec, so an edited or failed
// spec reruns alone.
//
// Records live in <git common dir>/holoim-verify-cache/, shared by every
// worktree. VERIFY_PR_CACHE_DIR moves the store (tests, experiments).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

/** Bump when the key recipe or the record format changes: every old record stops matching. */
export const CACHE_VERSION = 1;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Folders no suite reads: a change there keeps every "code" key.
 * scripts/check-ci-areas.ts fails when code outside one of them names it.
 */
export const NOT_SUITE_INPUTS = ["apps/capture/scripts/authoring/"];

const REFERENCE_SCAN = /\.([cm]?[jt]sx?|json|jsonc|sh|ya?ml|html|toml|py)$/;
const HASH_COMMENTS = /\.(sh|ya?ml|toml|py)$/;
const BLOCK_COMMENTS = /\.([cm]?[jt]sx?|jsonc)$/;

/**
 * The lines of a file with its whole-line comments made empty. A block
 * comment counts only when it starts a line: "/*" is also part of a glob in a
 * string, and a line read as code by mistake is the safe mistake.
 */
function codeLines(file: string, text: string): string[] {
  const hash = HASH_COMMENTS.test(file);
  const block = BLOCK_COMMENTS.test(file);
  let inBlock = false;
  return text.split("\n").map((line) => {
    if (hash) return /^\s*#/.test(line) ? "" : line;
    if (!block) return line;
    let code = line;
    if (inBlock) {
      const end = code.indexOf("*/");
      if (end < 0) return "";
      code = code.slice(end + 2);
      inBlock = false;
    }
    for (let open = /^\s*\/\*/.exec(code); open; open = /^\s*\/\*/.exec(code)) {
      const end = code.indexOf("*/", open[0].length);
      if (end < 0) {
        inBlock = true;
        return "";
      }
      code = code.slice(end + 2);
    }
    return /^\s*\/\//.test(code) ? "" : code;
  });
}

/**
 * Lines outside a NOT_SUITE_INPUTS folder that name a path in it, as
 * "file:line: text". The folder stays out of the suites' keys only while this
 * is empty. A line names the folder when it has the folder's last path
 * segment as a path segment ("authoring/"). Comment lines do not count. The
 * package.json of the folder's app may hold scripts that run the folder's
 * files; then no other line may name one of those scripts.
 */
export function outsideReferences(folder: string, files: { path: string; text: string }[]): string[] {
  const segment = folder.replace(/\/$/, "").split("/").pop()!;
  // "authoring/" as a path segment, or "authoring" alone as one item of a list: path.join(here, "authoring", "make.ts").
  const names = new RegExp(`(?<![A-Za-z0-9_.-])${segment}/|[,(\\[]\\s*["'\`]${segment}["'\`]\\s*[,)\\]]`);
  const owner = `${folder.split("/").slice(0, 2).join("/")}/package.json`;
  const found: string[] = [];
  const scripts: string[] = [];
  const outside = files.filter((file) => !file.path.startsWith(folder) && REFERENCE_SCAN.test(file.path));
  for (const file of outside) {
    if (file.path !== owner) continue;
    const declared = (JSON.parse(file.text) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, command] of Object.entries(declared)) if (names.test(command)) scripts.push(name);
    for (const [name, command] of Object.entries(declared)) {
      const called = scripts.find((script) => script !== name && new RegExp(`(?<![A-Za-z0-9_:.-])${script}(?![A-Za-z0-9_:.-])`).test(command));
      if (called) found.push(`${file.path}: script "${name}" runs "${called}"`);
    }
  }
  const scriptNames = scripts.map((script) => new RegExp(`(?<![A-Za-z0-9_:.-])${script}(?![A-Za-z0-9_:.-])`));
  for (const file of outside) {
    const shown = file.text.split("\n");
    for (const [index, line] of codeLines(file.path, file.text).entries()) {
      if (!line) continue;
      const namesFolder = file.path !== owner && names.test(line);
      const runsScript = file.path !== owner && scriptNames.some((script) => script.test(line));
      if (namesFolder || runsScript) found.push(`${file.path}:${index + 1}: ${(shown[index] ?? line).trim().slice(0, 120)}`);
    }
  }
  return found;
}

/** Files under docs/ that are code. */
const DOCS_CODE = new Set(["docs/product/design/tokens.json"]);

/**
 * Files git ignores that a suite can read: Vite and the API load .env files,
 * and place-capture.pipeline.spec.ts runs more tests when a downloaded scan
 * is on disk.
 */
const IGNORED_ENV_FILE = /^\.env(\..+)?$/;
const IGNORED_INPUT_DIRS = ["apps/viewer-web/public/local-places"];

/**
 * A run that starts with one of these set cannot be judged. verify:pr sets
 * E2E_PASSED_SPECS itself for one step. With REUSE_DEV_SERVER=1 a suite uses
 * a server that this run did not start, possibly from a different tree.
 */
const RESERVED_ENV = ["E2E_PASSED_SPECS", "REUSE_DEV_SERVER"];
/** Read by the code but without effect on a verdict: where servers listen, and verify:pr's own switches. */
const NEUTRAL_ENV = /^(E2E_API_PORT|E2E_POLYHAVEN_PORT|E2E_POLYPIZZA_PORT|KNOWLEDGE_E2E_PORT|DEV_PORT|TEST_API_PORT|VERIFY_PR_\w+|CLAUDE_PROJECT_DIR|GITHUB_STEP_SUMMARY|HOME|PATH|PWD|TMPDIR|USER|SHELL)$/;
/** Variables the tools read (not the repo's code), and prefixes the code builds names from. */
const TOOL_ENV = /^(CI|DEBUG|PWDEBUG|NODE_ENV|(PLAYWRIGHT|PW|VITE|VITEST|XR|E2E|HOLOIM|CAPTURE)_\w+)$/;
const ENV_READ = /\benv(?:\.|\[\s*["'])([A-Z][A-Z0-9_]+)/g;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
/** The repo's own code: apps, packages, scripts and root-level files (not the vendored skills). */
const ENV_SCAN_ROOT = /^(apps\/|packages\/|scripts\/|[^/]+$)/;

/** The cache cannot decide. The message says why; every step runs and nothing is stored. */
export class CacheOff extends Error {}

export interface StepCache {
  inputs: "tree" | "code";
  /** The step makes files later steps load (dist). When skipped, it still runs before the first later step that runs. */
  artifact?: boolean;
  /** Playwright step: `report` is its JSON report, `dir` its test directory (both from the repo root). */
  specs?: { dir: string; report: string };
}

export interface CacheStep {
  cache?: StepCache;
  command: string;
  label: string;
}

export interface TreeFile {
  /** Content id: the git blob id the file has, or would have when committed. */
  id: string;
  mode: string;
  path: string;
}

export interface Snapshot {
  /** [name, value] of each set variable the code or its tools read. */
  env: [string, string][];
  files: TreeFile[];
  /** A spec imports another spec, so spec files cannot be judged one by one. */
  specsShareCode: boolean;
  toolchain: string;
}

export interface PassRecord {
  branch: string;
  commit: string;
  file?: string;
  label: string;
  passedAt: string;
  seconds: number;
  /** Spec files: tests that were skipped. A skip can depend on this worktree's disk, so the record holds only here. */
  skipped?: number;
  worktree: string;
}

interface SpecSet {
  files: string[];
}

export interface Decision {
  action: "run" | "skip";
  /** Extra environment for the step (the spec files to leave out). */
  env: Record<string, string>;
  /** Keys computed before the step; `record` stores a pass only when they still hold after it. */
  keys: StepKeys | null;
  /** One line for the log. */
  note: string;
  /** Spec files left out of this run because they already passed. */
  passedSpecs: string[];
}

export interface StepKeys {
  base: string;
  specs: Record<string, string>;
}

const SPEC_FILE = /\.spec\.[cm]?[jt]sx?$/;
const SPEC_IMPORT = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["'`][^"'`]*\.spec(?:\.[cm]?[jt]sx?)?["'`]/;

function sha(algorithm: string, ...parts: (string | Buffer)[]): string {
  const hash = createHash(algorithm);
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function git(root: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input })
  });
  if (result.status !== 0) throw new CacheOff(`git ${args[0]} failed`);
  return result.stdout;
}

const nulList = (output: string): string[] => output.split("\0").filter(Boolean);

/**
 * Every file git tracks or would track, with the content it has on disk now.
 * A clean file takes its blob id from the index. A modified or untracked file
 * is hashed from the working tree with git's own filters, so the same content
 * has the same id before and after a commit. A file missing from disk is
 * recorded as deleted.
 */
export function readTree(root: string): Map<string, { id: string; mode: string }> {
  const files = new Map<string, { id: string; mode: string }>();
  for (const entry of nulList(git(root, ["ls-files", "-s", "-z"]))) {
    const tab = entry.indexOf("\t");
    const [mode, id, stage] = entry.slice(0, tab).split(" ");
    if (!mode || !id || stage !== "0") throw new CacheOff("the git index has unmerged paths");
    files.set(entry.slice(tab + 1), { id, mode });
  }
  // `git update-index --assume-unchanged` and `--skip-worktree` hide an edit
  // from `ls-files -m` (tags: a lowercase letter, or S). Those files are
  // hashed from disk too.
  const hidden = nulList(git(root, ["ls-files", "-v", "-z"]))
    .filter((entry) => /^[a-zS] /.test(entry))
    .map((entry) => entry.slice(2));
  const dirty = new Set([
    ...nulList(git(root, ["ls-files", "-m", "-z"])),
    ...nulList(git(root, ["ls-files", "-o", "--exclude-standard", "-z"])),
    ...hidden
  ]);
  const toHash: { file: string; mode: string }[] = [];
  for (const file of dirty) {
    const stat = lstatSync(path.join(root, file), { throwIfNoEntry: false });
    if (!stat) {
      files.set(file, { id: "deleted", mode: "000000" });
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(path.join(root, file));
      files.set(file, { id: sha("sha1", `blob ${Buffer.byteLength(target)}\0`, target), mode: "120000" });
    } else if (stat.isFile() && !file.includes("\n")) {
      toHash.push({ file, mode: stat.mode & 0o111 ? "100755" : "100644" });
    } else {
      throw new CacheOff(`cannot hash ${file} (not a regular file)`);
    }
  }
  if (toHash.length > 0) {
    const ids = git(root, ["hash-object", "--stdin-paths"], `${toHash.map((entry) => entry.file).join("\n")}\n`)
      .split("\n")
      .filter(Boolean);
    if (ids.length !== toHash.length) throw new CacheOff("git hash-object did not answer for every file");
    for (const [index, entry] of toHash.entries()) files.set(entry.file, { id: ids[index]!, mode: entry.mode });
  }
  return files;
}

/** The git-ignored files a suite can read (see IGNORED_INPUT_DIRS), as tree entries. */
function readIgnoredInputs(root: string): TreeFile[] {
  const found: TreeFile[] = [];
  const add = (file: string) => found.push({ id: sha("sha256", readFileSync(path.join(root, file))), mode: "ignored", path: file });
  const entries = (dir: string) => {
    try {
      return readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const packageDirs = ["apps", "packages"].flatMap((parent) =>
    entries(parent).filter((entry) => entry.isDirectory()).map((entry) => `${parent}/${entry.name}`)
  );
  // A symbolic link counts as what it points to: the suites read through it.
  const kind = (file: string, entry: Dirent): "dir" | "file" | "other" => {
    let stat: { isDirectory(): boolean; isFile(): boolean } | undefined = entry;
    if (entry.isSymbolicLink()) {
      try {
        stat = statSync(path.join(root, file), { throwIfNoEntry: false });
      } catch {
        stat = undefined; // a link that points to itself
      }
    }
    return stat?.isFile() ? "file" : stat?.isDirectory() ? "dir" : "other";
  };
  for (const dir of [".", ...packageDirs]) {
    for (const entry of entries(dir)) {
      const file = path.posix.join(dir, entry.name);
      if (IGNORED_ENV_FILE.test(entry.name) && kind(file, entry) === "file") add(file);
    }
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 12) throw new CacheOff(`${dir} is nested too deep to read (a link that points to its own parent?)`);
    for (const entry of entries(dir)) {
      const child = `${dir}/${entry.name}`;
      const type = kind(child, entry);
      if (type === "dir") walk(child, depth + 1);
      else if (type === "file") add(child);
    }
  };
  for (const dir of IGNORED_INPUT_DIRS) walk(dir, 0);
  return found;
}

/**
 * The set environment variables that can change a verdict: each one the
 * repo's code reads (`env.NAME`), and the ones its tools read. A local URL
 * counts without its port, so a run on moved ports shares its results.
 */
export function readEnv(root: string, files: TreeFile[], env: NodeJS.ProcessEnv): [string, string][] {
  const names = new Set<string>();
  for (const file of files) {
    if (!CODE_FILE.test(file.path) || !ENV_SCAN_ROOT.test(file.path) || file.id === "deleted" || file.mode === "120000") continue;
    for (const match of readFileSync(path.join(root, file.path), "utf8").matchAll(ENV_READ)) names.add(match[1]!);
  }
  for (const name of Object.keys(env)) if (TOOL_ENV.test(name)) names.add(name);
  const set: [string, string][] = [];
  for (const name of [...names].sort()) {
    const value = env[name];
    if (value === undefined || value === "" || NEUTRAL_ENV.test(name)) continue;
    set.push([name, name.endsWith("_URL") ? withoutLocalPort(value) : value]);
  }
  return set;
}

function withoutLocalPort(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return value;
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return value;
  }
}

/**
 * The Python that the pipeline specs and the API's USDZ tools run
 * (USDZ_PYTHON, else python3 on PATH): its version and each installed
 * package's version. Read one time for each interpreter in a process.
 */
const pythonSeen = new Map<string, string>();
function pythonTools(env: NodeJS.ProcessEnv): string {
  const python = env.USDZ_PYTHON || "python3";
  const key = `${python}\0${env.PATH ?? ""}`;
  let tools = pythonSeen.get(key);
  if (tools === undefined) {
    const probe = "import sys, importlib.metadata as m; print(sys.version); print(sorted(str(d.metadata['Name']) + '==' + d.version for d in m.distributions()))";
    const result = spawnSync(python, ["-c", probe], { encoding: "utf8", env, timeout: 20_000 });
    tools = result.status === 0 ? `python-${sha("sha256", result.stdout).slice(0, 16)}` : "python-none";
    pythonSeen.set(key, tools);
  }
  return tools;
}

export function takeSnapshot(root: string, env: NodeJS.ProcessEnv = process.env): Snapshot {
  // A pass with packages that do not match the lockfile says nothing about the lockfile's tree.
  const installed = path.join(root, "node_modules/.pnpm/lock.yaml");
  const lockfile = path.join(root, "pnpm-lock.yaml");
  if (!existsSync(installed) || !existsSync(lockfile) || !readFileSync(installed).equals(readFileSync(lockfile))) {
    throw new CacheOff("node_modules does not match pnpm-lock.yaml (run pnpm install)");
  }
  const tree = readTree(root);
  const files: TreeFile[] = [...tree.keys()].sort().map((file) => ({ ...tree.get(file)!, path: file }));
  const tracked = new Set(tree.keys());
  for (const file of readIgnoredInputs(root)) if (!tracked.has(file.path)) files.push(file);
  // A spec file, or a helper beside the spec files, that imports a spec file.
  const specDirs = new Set(files.filter((file) => SPEC_FILE.test(file.path)).map((file) => `${path.posix.dirname(file.path)}/`));
  const specsShareCode = files.some((file) => {
    if (!CODE_FILE.test(file.path) || file.id === "deleted" || file.mode === "120000") return false;
    if (![...specDirs].some((dir) => file.path.startsWith(dir))) return false;
    return SPEC_IMPORT.test(readFileSync(path.join(root, file.path), "utf8"));
  });
  return {
    env: readEnv(root, files, env),
    files,
    specsShareCode,
    toolchain: `${process.platform}-${process.arch}-node${process.version}-${pythonTools(env)}`
  };
}

/** True when a browser suite can read the file. */
export function isCodeInput(file: string): boolean {
  if (DOCS_CODE.has(file)) return true;
  if (file.endsWith(".md") || file.startsWith("docs/")) return false;
  return !NOT_SUITE_INPUTS.some((folder) => file.startsWith(folder));
}

/** The files a step can read. */
export function inputsOf(step: CacheStep, snapshot: Snapshot): TreeFile[] {
  return step.cache?.inputs === "tree" ? snapshot.files : snapshot.files.filter((file) => isCodeInput(file.path));
}

function isSpecOf(step: CacheStep, file: string): boolean {
  const dir = step.cache?.specs?.dir;
  return dir !== undefined && file.startsWith(`${dir}/`) && SPEC_FILE.test(file);
}

/**
 * `base` covers every input of the step. For a step with spec records it
 * leaves the spec files of its test directory out, and `specs` has one key
 * per spec file (by its path under that directory).
 */
export function keysOf(step: CacheStep, snapshot: Snapshot): StepKeys {
  const bySpec = step.cache?.specs !== undefined && !snapshot.specsShareCode;
  const inputs = inputsOf(step, snapshot);
  const shared = bySpec ? inputs.filter((file) => !isSpecOf(step, file.path)) : inputs;
  const base = sha(
    "sha256",
    JSON.stringify({
      bySpec,
      command: step.command,
      env: snapshot.env,
      files: shared.map((file) => [file.path, file.mode, file.id]),
      label: step.label,
      // The names of the spec files (not their content): a new, removed or renamed spec makes a new file set.
      specFiles: bySpec ? inputs.filter((file) => isSpecOf(step, file.path) && file.id !== "deleted").map((file) => file.path) : [],
      toolchain: snapshot.toolchain,
      version: CACHE_VERSION
    })
  );
  const specs: Record<string, string> = {};
  if (bySpec) {
    const dir = step.cache!.specs!.dir;
    for (const file of inputs) {
      if (!isSpecOf(step, file.path) || file.id === "deleted") continue;
      specs[file.path.slice(dir.length + 1)] = sha("sha256", JSON.stringify([base, file.path, file.mode, file.id]));
    }
  }
  return { base, specs };
}

interface ReportTest {
  expectedStatus?: string;
  status?: string;
}
interface ReportSuite {
  file?: string;
  specs?: { file?: string; tests?: ReportTest[] }[];
  suites?: ReportSuite[];
}
export interface PlaywrightReport {
  errors?: unknown[];
  stats?: { startTime?: string };
  suites?: ReportSuite[];
}

export interface SpecVerdict {
  passed: boolean;
  skipped: number;
}

/**
 * The verdict of each spec file in a Playwright JSON report, or null when the
 * report cannot be trusted as a whole (a top-level error: global timeout,
 * max failures, a failed server or setup).
 *
 * A test counts only when it ran and met its expectation, or is a declared
 * skip. A test that never ran or was interrupted has status "skipped" with
 * expected status "passed", so its file does not pass.
 */
export function specVerdicts(report: PlaywrightReport): Map<string, SpecVerdict> | null {
  if (!Array.isArray(report.errors) || report.errors.length > 0 || !Array.isArray(report.suites)) return null;
  const verdicts = new Map<string, SpecVerdict>();
  const ran = (test: ReportTest) => test.status === "expected" || test.status === "flaky";
  const declaredSkip = (test: ReportTest) => test.status === "skipped" && test.expectedStatus === "skipped";
  const walk = (suite: ReportSuite, parentFile: string | undefined) => {
    const suiteFile = suite.file ?? parentFile;
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suiteFile;
      if (!file) continue;
      const tests = spec.tests ?? [];
      const verdict = verdicts.get(file) ?? { passed: true, skipped: 0 };
      verdict.passed &&= tests.length > 0 && tests.every((test) => ran(test) || declaredSkip(test));
      verdict.skipped += tests.filter(declaredSkip).length;
      verdicts.set(file, verdict);
    }
    for (const child of suite.suites ?? []) walk(child, suiteFile);
  };
  for (const suite of report.suites) walk(suite, undefined);
  return verdicts;
}

function describe(record: PassRecord): string {
  const when = record.passedAt.slice(0, 16).replace("T", " ");
  return `${when} UTC in ${record.worktree} (${record.branch} ${record.commit})`;
}

export class ResultCache {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly read: boolean;
  readonly root: string;

  constructor(options: { dir: string; env?: NodeJS.ProcessEnv; read: boolean; root: string }) {
    this.dir = options.dir;
    this.env = options.env ?? process.env;
    this.read = options.read;
    this.root = options.root;
  }

  private load<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, `${name}.json`), "utf8")) as T;
    } catch {
      return null;
    }
  }

  private store(name: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${name}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(temporary, target);
  }

  /** Removes records older than 14 days. */
  prune(now = Date.now()): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      const stat = statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile() && now - stat.mtimeMs > MAX_AGE_MS) rmSync(file, { force: true });
    }
  }

  private specRecord(key: string | undefined): PassRecord | null {
    const record = key ? this.load<PassRecord>(`spec-${key}`) : null;
    // A skip can depend on files git ignores, so a pass with skips holds only where it ran.
    return record && (!record.skipped || record.worktree === this.root) ? record : null;
  }

  /** Run or skip, decided on the files as they are on disk now. Throws CacheOff when it cannot decide. */
  decide(step: CacheStep): Decision {
    const run = (keys: StepKeys | null): Decision => ({ action: "run", env: {}, keys, note: "", passedSpecs: [] });
    if (!step.cache) return run(null);
    const keys = keysOf(step, takeSnapshot(this.root, this.env));
    if (!this.read) return run(keys);
    if (step.cache.specs && Object.keys(keys.specs).length > 0) {
      const set = this.load<SpecSet>(`set-${keys.base}`);
      if (!set || set.files.length === 0) return run(keys);
      const records = set.files.map((file) => this.specRecord(keys.specs[file]));
      const passed = set.files.filter((_, index) => records[index]);
      if (passed.length === 0) return run(keys);
      if (passed.length < set.files.length) {
        return {
          action: "run",
          env: { E2E_PASSED_SPECS: passed.join(",") },
          keys,
          note: `${set.files.length - passed.length} of ${set.files.length} spec files; the others passed with the same inputs`,
          passedSpecs: passed
        };
      }
      const oldest = (records as PassRecord[]).reduce((a, b) => (a.passedAt < b.passedAt ? a : b));
      return {
        action: "skip",
        env: {},
        keys,
        note: `all ${set.files.length} spec files passed with the same inputs, the oldest ${describe(oldest)}`,
        passedSpecs: passed
      };
    }
    const record = this.load<PassRecord>(`step-${keys.base}`);
    return record ? { action: "skip", env: {}, keys, note: `the same inputs passed ${describe(record)}`, passedSpecs: [] } : run(keys);
  }

  /**
   * Stores what a finished step proved. Returns lines for the log.
   * Nothing is stored when the inputs changed while the step ran.
   */
  record(step: CacheStep, decision: Decision, result: { code: number; seconds: number; startedAt: number }): string[] {
    if (!step.cache || !decision.keys) return [];
    const specs = step.cache.specs;
    const bySpec = specs !== undefined && Object.keys(decision.keys.specs).length > 0;
    if (result.code !== 0 && !bySpec) return [];
    const after = keysOf(step, takeSnapshot(this.root, this.env));
    if (after.base !== decision.keys.base) return [`${step.label}: its inputs changed during the run; no pass stored`];
    const base: PassRecord = {
      branch: git(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
      commit: git(this.root, ["rev-parse", "--short", "HEAD"]).trim(),
      label: step.label,
      passedAt: new Date().toISOString(),
      seconds: result.seconds,
      worktree: this.root
    };
    if (!bySpec) {
      this.store(`step-${after.base}`, base);
      return [];
    }
    let report: PlaywrightReport;
    try {
      report = JSON.parse(readFileSync(path.join(this.root, specs.report), "utf8")) as PlaywrightReport;
    } catch {
      return [`${step.label}: no Playwright report at ${specs.report}; no pass stored`];
    }
    const started = Date.parse(report.stats?.startTime ?? "");
    if (!(started >= result.startedAt - 1000)) return [`${step.label}: the Playwright report is not from this run; no pass stored`];
    const verdicts = specVerdicts(report);
    if (!verdicts) return [`${step.label}: the Playwright run did not complete; no pass stored`];
    const ran = [...verdicts.keys()].sort();
    if (ran.some((file) => decision.passedSpecs.includes(file))) return [`${step.label}: a spec file ran that was to be left out; no pass stored`];
    // A failed step with no failed spec file failed outside the tests (a server, a script after them): the report does not explain it.
    if (result.code !== 0 && ran.every((file) => verdicts.get(file)!.passed)) return [`${step.label}: the step failed but no spec file did; no pass stored`];
    // Only a full run names the files of the step. A partial run adds passes and never changes the set.
    if (decision.passedSpecs.length === 0) this.store(`set-${after.base}`, { files: ran } satisfies SpecSet);
    const stored: string[] = [];
    for (const file of ran) {
      const key = after.specs[file];
      const verdict = verdicts.get(file)!;
      if (!verdict.passed || !key || key !== decision.keys.specs[file]) continue;
      this.store(`spec-${key}`, { ...base, file, skipped: verdict.skipped } satisfies PassRecord);
      stored.push(file);
    }
    return ran.length === stored.length ? [] : [`${step.label}: stored a pass for ${stored.length} of ${ran.length} spec files`];
  }
}

/**
 * Opens the cache for a run, or says why it is off.
 * `read: false` (--no-cache, --full) runs every step and still stores passes.
 */
export function openCache(options: { env?: NodeJS.ProcessEnv; read: boolean; root?: string }): ResultCache | { off: string } {
  const env = options.env ?? process.env;
  const reserved = RESERVED_ENV.filter((name) => env[name]);
  if (reserved.length > 0) return { off: `${reserved.join(", ")} is set` };
  try {
    const root = options.root ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
    const dir = env.VERIFY_PR_CACHE_DIR
      ? path.resolve(env.VERIFY_PR_CACHE_DIR)
      : path.join(path.resolve(root, git(root, ["rev-parse", "--git-common-dir"]).trim()), "holoim-verify-cache", `v${CACHE_VERSION}`);
    const cache = new ResultCache({ dir, env, read: options.read, root });
    takeSnapshot(root, env);
    cache.prune();
    return cache;
  } catch (error) {
    if (error instanceof CacheOff) return { off: error.message };
    throw error;
  }
}
