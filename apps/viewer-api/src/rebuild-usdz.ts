import "dotenv/config";

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { UPLOADS_DIR } from "./lib/constants.js";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { createMediaStorage, type MediaStorage } from "./services/media-storage.js";
import { USDZ_CONVERTER_VERSION, convertGlbToUsdz, resolveToolPath, usdzFilenameFor } from "./services/usdz-converter.js";

// One-off rebuild of stored Quick Look previews onto the current converter
// (ql3: the baked cloche, ui-redesign slice 6). For each hologram whose stored
// preview is an older version, it converts the GLB again beside the old file,
// validates the new package with the independent inspector, stores it under
// its new name, and only then switches the record to it; a failure leaves the
// old preview served. It resumes after an interruption: switched records are
// skipped, and the journal keeps what failed and why.
//
//   pnpm --filter @holoim/api rebuild:usdz -- --dry-run
//   pnpm --filter @holoim/api rebuild:usdz -- --recent 3
//   node apps/viewer-api/dist/apps/viewer-api/src/rebuild-usdz.js   (production image)
//
// Options: --dry-run lists the work; --recent N takes only the N most recent;
// --journal FILE (default beside the uploads root); --retry-failed tries
// again what the journal records as failed; --delete-old removes each old
// preview once its record is switched (left in place by default).

const execFileAsync = promisify(execFile);
// Generous: a long take inspects in about a minute on a laptop and several
// on production's shared CPU, where 180 s killed the first run's inspector.
const INSPECTION_TIMEOUT_MS = 900_000;

type Outcome = { status: "switched" | "failed" | "changed"; at: string; from: string; to: string; reason?: string; newFailures?: string[] };
type Journal = { version: string; holograms: Record<string, Outcome> };
type Report = { passed: boolean; failures: string[]; cloche?: { seed?: string; seams?: number } };

const { values: options } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    recent: { type: "string" },
    journal: { type: "string" },
    "retry-failed": { type: "boolean", default: false },
    "delete-old": { type: "boolean", default: false }
  }
});

async function readJournal(file: string): Promise<Journal> {
  try {
    const journal = JSON.parse(await readFile(file, "utf8")) as Journal;
    if (journal.version === USDZ_CONVERTER_VERSION) return journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: USDZ_CONVERTER_VERSION, holograms: {} };
}

async function inspect(glbPath: string, usdzPath: string, reportPath: string): Promise<Report> {
  // The inspector exits 1 when a check fails; the report says which.
  await execFileAsync(process.env.USDZ_PYTHON ?? "python3", [resolveToolPath("inspect_usdz.py"), glbPath, usdzPath, reportPath], {
    timeout: INSPECTION_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code !== 1) throw error;
  });
  return JSON.parse(await readFile(reportPath, "utf8")) as Report;
}

/**
 * The new package must carry a cloche that passes every cloche check, and
 * may fail no check the old preview passed: an older recording that already
 * missed a tolerance is still moved on, but never made worse.
 */
function validate(next: Report, previous: Report | null, seed: string): { ok: true } | { ok: false; reason: string; newFailures: string[] } {
  const known = new Set(previous?.failures ?? []);
  const newFailures = next.failures.filter((failure) => !known.has(failure) || failure.startsWith("Cloche"));
  if (next.cloche?.seed !== seed) return { ok: false, reason: "the new preview has no cloche seeded by this hologram", newFailures };
  if (newFailures.length > 0) return { ok: false, reason: "the new preview fails checks the old one passed", newFailures };
  return { ok: true };
}

async function rebuild(
  record: { id: string; filenameStored: string; usdzPath: string },
  storage: MediaStorage
): Promise<Omit<Outcome, "at">> {
  const from = record.usdzPath;
  const oldKey = path.posix.basename(from);
  const newKey = usdzFilenameFor(record.filenameStored);
  const to = `uploads/${newKey}`;
  const workDir = await mkdtemp(path.join(tmpdir(), "holoim-usdz-rebuild-"));
  try {
    const glbPath = path.join(workDir, record.filenameStored);
    const newPath = path.join(workDir, newKey);
    await storage.downloadToFile(record.filenameStored, glbPath);
    // Always convert afresh: a package left by an interrupted run is never trusted.
    await convertGlbToUsdz(glbPath, newPath, { seed: record.id });
    let previous: Report | null = null;
    if (await storage.head(oldKey)) {
      const oldPath = path.join(workDir, oldKey);
      await storage.downloadToFile(oldKey, oldPath);
      previous = await inspect(glbPath, oldPath, path.join(workDir, "old-report.json"));
    }
    const next = await inspect(glbPath, newPath, path.join(workDir, "new-report.json"));
    const verdict = validate(next, previous, record.id);
    if (!verdict.ok) return { status: "failed", from, to, reason: verdict.reason, newFailures: verdict.newFailures };

    // Beside the old file; the record still points at the old one.
    await storage.putFile(newKey, newPath, "model/vnd.usdz+zip", undefined, "inline");
    const switched = await prisma.hologram.updateMany({
      where: { id: record.id, usdzStatus: "ready", usdzPath: from },
      data: { usdzPath: to }
    });
    if (switched.count === 0) {
      // Deleted, or re-queued by a Quick Look request (the worker then
      // publishes the same new name itself): only a deleted record's file goes.
      if (!(await prisma.hologram.findUnique({ where: { id: record.id }, select: { id: true } }))) await storage.delete(newKey);
      return { status: "changed", from, to, reason: "the record changed during the rebuild; left to the API" };
    }
    if (options["delete-old"] && oldKey !== newKey) await storage.delete(oldKey);
    return { status: "switched", from, to };
  } catch (error) {
    return { status: "failed", from, to, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (env.DATABASE_URL.startsWith("file:")) {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
  }
  const uploadsRoot = env.UPLOADS_ROOT ?? path.join(process.cwd(), UPLOADS_DIR);
  const storage = createMediaStorage(uploadsRoot);
  const journalPath = options.journal ?? path.join(path.dirname(path.resolve(uploadsRoot)), `usdz-rebuild-${USDZ_CONVERTER_VERSION}.json`);
  const journal = await readJournal(journalPath);
  const recent = options.recent ? Number.parseInt(options.recent, 10) : undefined;
  if (recent !== undefined && !(recent > 0)) throw new Error("--recent takes a positive count");

  const stored = await prisma.hologram.findMany({
    where: { usdzStatus: "ready", usdzPath: { not: null } },
    orderBy: [{ createdAt: "desc" }],
    select: { id: true, filenameStored: true, usdzPath: true },
    ...(recent ? { take: recent } : {})
  });
  const candidates = stored.filter(
    (record): record is typeof record & { usdzPath: string } =>
      record.usdzPath !== null && record.usdzPath !== `uploads/${usdzFilenameFor(record.filenameStored)}`
  );
  const todo = candidates.filter((record) => options["retry-failed"] || journal.holograms[record.id]?.status !== "failed");
  console.info(
    `USDZ rebuild to ${USDZ_CONVERTER_VERSION}: ${stored.length} stored preview(s) considered, ${stored.length - candidates.length} already current, ` +
      `${candidates.length - todo.length} failed before (skipped without --retry-failed), ${todo.length} to rebuild. Journal: ${journalPath}`
  );
  if (options["dry-run"]) {
    for (const record of todo) console.info(`  would rebuild ${record.id}: ${record.usdzPath} -> uploads/${usdzFilenameFor(record.filenameStored)}`);
    return;
  }

  // A first signal finishes the hologram in hand (and cleans up after it); a second stops at once.
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.info("Stopping after the hologram in hand; run again to resume.");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let failed = 0;
  let done = 0;
  for (const [index, record] of todo.entries()) {
    if (stopping) break;
    const started = Date.now();
    const outcome = await rebuild(record, storage);
    journal.holograms[record.id] = { ...outcome, at: new Date().toISOString() };
    // Written after every hologram, so an interruption loses at most the one in hand.
    await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n");
    if (outcome.status === "failed") failed += 1;
    else done += 1;
    const detail = outcome.reason ? ` (${outcome.reason}${outcome.newFailures?.length ? `: ${outcome.newFailures.join("; ")}` : ""})` : "";
    console.info(`[${index + 1}/${todo.length}] ${record.id} ${outcome.status} in ${((Date.now() - started) / 1000).toFixed(1)} s${detail}`);
  }
  const left = todo.length - done - failed;
  console.info(`USDZ rebuild ${left ? "stopped" : "finished"}: ${done} done, ${failed} failed, ${left} left; failed previews keep their old file.`);
  if (failed > 0 || left > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error("USDZ rebuild failed", error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
