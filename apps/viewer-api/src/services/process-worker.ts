import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { GLB_CONTENT_TYPE, servedKeyFor, textureDetailKeyFor } from "./hologram-ingest.js";
import { processHologram, type ProcessReport } from "./hologram-process.js";
import type { MediaStorage } from "./media-storage.js";
import { withHologramLock } from "./usdz-converter.js";

// The background half of the hologram-budgets Q4 processing: claims a
// hologram whose processStatus is "pending", builds the processed light GLB
// (KTX2 textures, reduced animation) and the full-size textures GLB from the
// stored `<id>.glb`, and publishes them under the hologram lock (so a delete
// never races a publish). Until then, and if processing fails, the stored
// GLB is served as uploaded. Runs in the same serial loop as the USDZ
// conversions, so the two never run at once on the 2 GB machine.

export type ProcessWorkerOptions = {
  storage: MediaStorage;
  staleClaimMs?: number;
  /** Called after a processed GLB is published (the feed snapshot's URLs changed). */
  onPublished?: () => Promise<void> | void;
  logger?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

const silentLogger = { info: () => undefined, error: () => undefined };

/** Attempts (claims) before a hologram's processing counts as failed. */
export const MAX_PROCESS_ATTEMPTS = 3;

async function claimNext(options: ProcessWorkerOptions): Promise<{ id: string; claimToken: string } | null> {
  const staleBefore = new Date(Date.now() - (options.staleClaimMs ?? env.USDZ_STALE_CLAIM_MS));
  const candidates = await prisma.hologram.findMany({
    where: {
      OR: [{ processStatus: "pending" }, { processStatus: "processing", processClaimedAt: { lt: staleBefore } }]
    },
    orderBy: [{ createdAt: "asc" }],
    take: 5,
    select: { id: true, processStatus: true, processAttempts: true }
  });
  for (const candidate of candidates) {
    if (candidate.processAttempts >= MAX_PROCESS_ATTEMPTS) {
      // A stale claim that keeps dying (out of memory, killed): stop retrying it.
      await prisma.hologram.updateMany({
        where: { id: candidate.id, processStatus: candidate.processStatus },
        data: { processStatus: "failed", processError: "Processing did not finish.", processClaimedAt: null, processClaimToken: null }
      });
      continue;
    }
    const claimToken = randomUUID();
    const result = await prisma.hologram.updateMany({
      where:
        candidate.processStatus === "pending"
          ? { id: candidate.id, processStatus: "pending" }
          : { id: candidate.id, processStatus: "processing", processClaimedAt: { lt: staleBefore } },
      data: {
        processStatus: "processing",
        processClaimedAt: new Date(),
        processClaimToken: claimToken,
        processAttempts: { increment: 1 },
        processError: null
      }
    });
    if (result.count === 1) return { id: candidate.id, claimToken };
  }
  return null;
}

/** Processes the next pending hologram. Returns false when idle, else the report (null on failure). */
export async function processNextHologram(options: ProcessWorkerOptions): Promise<false | { id: string; report: ProcessReport | null }> {
  const log = options.logger ?? silentLogger;
  const claimed = await claimNext(options);
  if (!claimed) return false;
  const { storage } = options;
  const record = await prisma.hologram.findUnique({ where: { id: claimed.id } });
  if (!record) return { id: claimed.id, report: null };

  const servedKey = servedKeyFor(record.filenameStored);
  const textureKey = textureDetailKeyFor(record.filenameStored);
  const workDir = await mkdtemp(path.join(tmpdir(), "holoim-process-"));
  const removeOutputs = async () => {
    await storage.delete(servedKey).catch(() => undefined);
    await storage.delete(textureKey).catch(() => undefined);
  };
  try {
    const sourcePath = path.join(workDir, "source.glb");
    await storage.downloadToFile(record.filenameStored, sourcePath);
    const result = await processHologram(sourcePath, workDir);
    await rm(sourcePath, { force: true });

    const published = await withHologramLock(claimed.id, async () => {
      const current = await prisma.hologram.findUnique({
        where: { id: claimed.id },
        select: { processStatus: true, processClaimToken: true }
      });
      if (current?.processStatus !== "processing" || current.processClaimToken !== claimed.claimToken) return false;
      if (result.texturesPath) await storage.putFile(textureKey, result.texturesPath, GLB_CONTENT_TYPE);
      await storage.putFile(servedKey, result.lightPath, GLB_CONTENT_TYPE);
      await prisma.hologram.update({
        where: { id: claimed.id },
        data: {
          processStatus: "ready",
          servedKey,
          textureDetailKey: result.texturesPath ? textureKey : null,
          sizeBytes: (await stat(result.lightPath)).size,
          processClaimedAt: null,
          processClaimToken: null,
          processError: null
        }
      });
      return true;
    });
    if (!published) {
      log.info({ hologramId: claimed.id }, "Processing publish skipped; record changed while processing");
      return { id: claimed.id, report: null };
    }
    log.info({ hologramId: claimed.id, report: result.report }, "Hologram processed");
    await options.onPublished?.();
    return { id: claimed.id, report: result.report };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Processing failed";
    await withHologramLock(claimed.id, async () => {
      const failed = await prisma.hologram.updateMany({
        where: { id: claimed.id, processStatus: "processing", processClaimToken: claimed.claimToken },
        data: { processStatus: "failed", processError: message.slice(0, 2000), processClaimedAt: null, processClaimToken: null }
      });
      if (failed.count === 1) await removeOutputs();
    }).catch(() => undefined);
    log.error({ error, hologramId: claimed.id }, "Hologram processing failed; serving the stored GLB as uploaded");
    return { id: claimed.id, report: null };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
