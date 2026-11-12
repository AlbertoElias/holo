// Guards scripts/ci-changed-areas.sh, the selector that decides which CI suites
// run. Skipped jobs report green, so a change the selector cannot see makes
// every suite skip and CI pass on untested code. This feeds changed-file lists
// through the real selector (CI_AREAS_FILES_FROM) and fails if one is ignored.
//
// Failure modes the cases are built from:
//   1. A new or renamed source path under apps/ or packages/ matches no
//      pattern and selects nothing.      -> every tracked non-doc file, one by one
//   2. A new top-level directory or root file is missed.  -> synthetic new paths
//   3. A source edit mixed with docs is swallowed as docs-only. -> mixed lists
//   4. A docs-only change drags in code areas (wasted CI) or is not recognised
//      as docs-only.                      -> every tracked doc file, and all together
//   5. A workflow, script, lockfile or shared-package edit selects nothing
//      without being a declared no-suite change. -> invariant over every tracked file
//   6. An empty or unusable diff is silently green. -> empty list, bad base
//   7. The CI gate stops enforcing the rule.        -> ci.yml wiring check
//
// The invariant behind all of them: every result either selects an area, is
// docs_only, or sets no_suite (docs and CI plumbing only); never none of these.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const selector = path.join(root, "scripts/ci-changed-areas.sh");
const areaKeys = ["quality", "capture_xr", "e2e", "pipeline", "portal", "usdz_tools", "api", "web", "capture_app"];

type Result = Record<string, boolean>;

const workDir = mkdtempSync(path.join(tmpdir(), "ci-areas-"));
let counter = 0;

function select(files: string[]): Promise<Result> {
  const listFile = path.join(workDir, `files-${counter++}.txt`);
  writeFileSync(listFile, files.join("\n") + "\n");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [selector], {
      cwd: root,
      env: { ...process.env, CI_AREAS_FILES_FROM: listFile },
      stdio: ["ignore", "pipe", "ignore"]
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`selector exited ${code} for ${files.join(", ")}`));
      const result: Result = {};
      for (const line of out.split("\n")) {
        const [key, value] = line.split("=");
        if (key && value) result[key] = value === "true";
      }
      resolve(result);
    });
  });
}

const selected = (r: Result) => areaKeys.filter((key) => r[key]);

const failures: string[] = [];
let checked = 0;
function expect(ok: boolean, message: string) {
  checked++;
  if (!ok) failures.push(message);
}

// The invariant: never "nothing selected, not docs, not declared no-suite".
function expectNotSilentlySkipped(label: string, r: Result) {
  expect(
    selected(r).length > 0 || r.docs_only === true || r.no_suite === true,
    `${label}: selects no area and is neither docs_only nor no_suite (every suite would skip green)`
  );
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await fn(items[next++] as T);
    })
  );
}

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 })
  .split("\n")
  .filter(Boolean);

// Paths that are docs by extension or directory but that the selector treats as code.
const codeLikeDocs = (f: string) =>
  f.startsWith("apps/knowledge/") ||
  f === "docs/product/design/tokens.json" ||
  /^(apps\/viewer-api\/tools\/|apps\/capture\/src\/recording\/|apps\/capture\/public\/gltf\/)/.test(f);
const isDoc = (f: string) => (f.endsWith(".md") || f.startsWith("docs/")) && !codeLikeDocs(f);

const sourceFiles = tracked.filter((f) => /^(apps|packages)\//.test(f) && !isDoc(f) && !f.endsWith(".md"));
const docFiles = tracked.filter(isDoc);
const plumbing = tracked.filter((f) => !/^(apps|packages)\//.test(f));

async function main() {
  // 1. Every tracked non-doc source file selects a code area on its own.
  await pool(sourceFiles, 8, async (file) => {
    const r = await select([file]);
    expect(selected(r).length > 0, `${file}: source file selects no area`);
    expect(!r.docs_only, `${file}: source file reported docs_only`);
    expect(!r.no_suite, `${file}: source file reported no_suite`);
  });

  // 2. Paths that do not exist yet: renamed apps, new packages, new top-level dirs.
  const synthetic = [
    "apps/renamed-app/src/index.ts",
    "apps/new-app/package.json",
    "apps/viewer-web/src/brand-new/file.tsx",
    "apps/capture/src/brand-new/file.ts",
    "apps/viewer-api/src/brand-new.ts",
    "packages/new-package/src/index.ts",
    "packages/contracts/src/new.ts",
    "services/worker/index.ts",
    "newdir/thing.txt",
    "Dockerfile",
    "vite.config.ts",
    "apps/viewer-web/src/img.png"
  ];
  for (const file of synthetic) {
    const r = await select([file]);
    expect(selected(r).length > 0 && !r.docs_only && !r.no_suite, `new path ${file}: not selected as code`);
  }

  // 3. Source mixed with docs or plumbing is never docs-only or skipped.
  const someDoc = docFiles[0] ?? "docs/README.md";
  for (const source of [sourceFiles[0] ?? "apps/capture/src/main.ts", "apps/renamed-app/src/a.ts", "pnpm-lock.yaml"]) {
    const r = await select([someDoc, ".github/workflows/ci.yml", source]);
    expect(selected(r).length > 0 && !r.docs_only, `docs + plumbing + ${source}: treated as docs-only or skipped`);
  }

  // 4. Docs-only changes select docs_only and nothing else.
  await pool(docFiles, 8, async (file) => {
    const r = await select([file]);
    expect(r.docs_only === true && selected(r).length === 0, `${file}: doc file is not docs_only with no areas`);
  });
  const allDocs = await select(docFiles);
  expect(allDocs.docs_only === true && selected(allDocs).length === 0, "all doc files together are not docs_only with no areas");

  // 5. Plumbing and shared config: the lockfile selects everything; every
  // other tracked file satisfies the invariant.
  const lock = await select(["pnpm-lock.yaml"]);
  expect(areaKeys.every((key) => lock[key]), "pnpm-lock.yaml does not select every area");
  await pool(plumbing, 8, async (file) => {
    const r = await select([file]);
    expectNotSilentlySkipped(file, r);
    if (!isDoc(file)) expect(!r.docs_only, `${file}: non-doc file reported docs_only`);
  });
  for (const file of [".github/workflows/ci.yml", "scripts/ci-changed-areas.sh", "package.json"]) {
    const r = await select([file]);
    expect(!r.docs_only && r.no_suite === true && selected(r).length === 0, `${file}: expected declared no-suite plumbing`);
  }
  const shared = await select(["packages/contracts/src/x.ts"]);
  expect(
    areaKeys.filter((key) => key !== "usdz_tools").every((key) => shared[key]),
    "shared package edit does not select every suite"
  );

  // 6. An empty diff is declared no-suite; an unusable base fails closed to every area.
  const empty = await select([]);
  expect(empty.no_suite === true && !empty.docs_only, "empty change list is not a declared no-suite result");
  const out = execFileSync("bash", [selector, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  expect(areaKeys.every((key) => out.includes(`${key}=true`)) && out.includes("no_suite=false"), "unusable base does not fail closed");

  // 7. The CI gate still enforces the rule.
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  expect(
    /needs\.changes\.outputs\.no_suite/.test(ci) && /needs\.changes\.outputs\.docs_only/.test(ci),
    "ci.yml gate does not read the changes outputs no_suite and docs_only"
  );
}

main()
  .finally(() => rmSync(workDir, { recursive: true, force: true }))
  .then(() => {
    if (failures.length > 0) {
      console.error(`check-ci-areas: ${failures.length} failure(s) in ${checked} assertions`);
      for (const failure of failures.slice(0, 40)) console.error(`  - ${failure}`);
      if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
      process.exit(1);
    }
    console.log(
      `check-ci-areas: ${checked} assertions passed (${sourceFiles.length} source files, ${docFiles.length} docs, ${plumbing.length} other files)`
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
