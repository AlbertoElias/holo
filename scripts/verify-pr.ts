// Local pre-merge gate: run only the suites the change can affect.
//
// The areas come from scripts/ci-changed-areas.sh, the same mapping hosted CI
// uses, applied to everything that differs from the merge-base with the latest
// origin/main (commits, uncommitted edits and untracked files). The mapping
// fails closed: an unusable base, a lockfile change or an unclassified file
// selects every suite.
//
// Usage: pnpm run verify:pr [-- --full | --dry-run | --no-fetch]
//   --full      run every suite regardless of the diff (verify:full)
//   --dry-run   print the plan and exit
//   --no-fetch  skip `git fetch origin main` (offline)
//
// Progress goes to stdout with NUL bytes made visible (Vite prints module ids
// prefixed with \0, which makes grep treat a log as binary). The final status
// is written to output/verify-pr.exit, so a watcher can wait for that file
// instead of grepping a log: `until [ -s output/verify-pr.exit ]; do sleep 20; done`.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Area =
  | "quality"
  | "capture_xr"
  | "e2e"
  | "pipeline"
  | "portal"
  | "web";

interface Step {
  area: Area | "always";
  command: string;
  label: string;
}

// Mirrors the old verify:pr order. `e2e` is the knowledge app; the viewer's
// mocked XR checks follow `web` because knowledge-only changes cannot affect
// them.
export const STEPS: Step[] = [
  { area: "always", label: "doctor", command: "pnpm run doctor" },
  { area: "always", label: "ci-areas", command: "pnpm run check:ci-areas" },
  { area: "quality", label: "lint+typecheck", command: "pnpm run check:all" },
  { area: "quality", label: "unit", command: "pnpm run test:unit:all" },
  { area: "quality", label: "build", command: "pnpm run build:all" },
  { area: "quality", label: "e2e-shards", command: "pnpm run check:e2e-shards" },
  { area: "e2e", label: "knowledge", command: "pnpm run test:knowledge" },
  { area: "pipeline", label: "pipeline", command: "pnpm run test:smoke:pipeline" },
  { area: "portal", label: "portal", command: "pnpm run test:portal" },
  { area: "capture_xr", label: "xr-capture", command: "pnpm run test:xr:capture" },
  { area: "web", label: "xr-viewer", command: "pnpm run test:xr:viewer" }
];

export function parseAreas(output: string): Record<string, boolean> {
  const areas: Record<string, boolean> = {};
  for (const line of output.split("\n")) {
    const match = /^([a-z0-9_]+)=(true|false)$/.exec(line.trim());
    if (match) areas[match[1]!] = match[2] === "true";
  }
  return areas;
}

export function selectSteps(areas: Record<string, boolean>, full: boolean): Step[] {
  return STEPS.filter((step) => full || step.area === "always" || areas[step.area] === true);
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function changedFiles(base: string): string[] {
  const committed = git(["diff", "--name-only", `${base}...HEAD`]);
  const working = git(["diff", "--name-only", "HEAD"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set(`${committed}${working}${untracked}`.split("\n").filter(Boolean))];
}

function resolveAreas(full: boolean, fetch: boolean): { areas: Record<string, boolean>; note: string } {
  if (full) return { areas: {}, note: "full run requested" };
  if (fetch) spawnSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
  const base = spawnSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" });
  if (base.status !== 0) return { areas: {}, note: "no merge-base with origin/main; running everything" };
  const files = changedFiles(base.stdout.trim());
  const dir = mkdtempSync(path.join(tmpdir(), "verify-pr-"));
  const list = path.join(dir, "files.txt");
  try {
    writeFileSync(list, `${files.join("\n")}\n`, "utf8");
    const result = spawnSync("bash", ["scripts/ci-changed-areas.sh"], {
      encoding: "utf8",
      env: { ...process.env, CI_AREAS_FILES_FROM: list }
    });
    if (result.status !== 0) return { areas: {}, note: "area script failed; running everything" };
    return { areas: parseAreas(result.stdout), note: `${files.length} changed file(s) vs origin/main` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runStep(step: Step): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(step.command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const forward = (stream: NodeJS.WriteStream) => (chunk: Buffer) =>
      stream.write(chunk.toString("utf8").replaceAll("\0", "\\0"));
    child.stdout.on("data", forward(process.stdout));
    child.stderr.on("data", forward(process.stderr));
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
  const full = args.has("--full");
  const exitFile = path.resolve("output", "verify-pr.exit");
  mkdirSync(path.dirname(exitFile), { recursive: true });
  rmSync(exitFile, { force: true });

  const { areas, note } = resolveAreas(full, !args.has("--no-fetch"));
  const noAreaInfo = Object.keys(areas).length === 0;
  const steps = selectSteps(noAreaInfo ? { quality: true, capture_xr: true, e2e: true, pipeline: true, portal: true, web: true } : areas, full || noAreaInfo);
  const skipped = STEPS.filter((step) => !steps.includes(step)).map((step) => step.label);
  console.log(`[verify-pr] ${note}`);
  console.log(`[verify-pr] running: ${steps.map((step) => step.label).join(", ")}`);
  if (skipped.length > 0) console.log(`[verify-pr] skipped (unaffected): ${skipped.join(", ")}`);
  if (args.has("--dry-run")) return;

  let status = 0;
  const started = Date.now();
  for (const step of steps) {
    const stepStarted = Date.now();
    console.log(`[verify-pr] > ${step.label}: ${step.command}`);
    const code = await runStep(step);
    const seconds = ((Date.now() - stepStarted) / 1000).toFixed(0);
    console.log(`[verify-pr] < ${step.label}: ${code === 0 ? "passed" : `FAILED (exit ${code})`} in ${seconds}s`);
    if (code !== 0) {
      status = code;
      break;
    }
  }
  console.log(`[verify-pr] ${status === 0 ? "PASSED" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  writeFileSync(exitFile, `${status}\n`, "utf8");
  process.exitCode = status;
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
