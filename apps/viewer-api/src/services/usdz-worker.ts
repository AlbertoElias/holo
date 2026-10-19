import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import type { MediaStorage } from "./media-storage.js";
import { convertGlbToUsdz, usdzFilenameFor } from "./usdz-converter.js";

export type GlbToUsdzConverter = (glbAbsolutePath: string, usdzAbsolutePath: string) => Promise<void>;

export type UsdzWorkerOptions = {
  storage: MediaStorage;
  convert?: GlbToUsdzConverter;
  staleClaimMs?: number;
  logger?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

const silentLogger = { info: () => undefined, error: () => undefined };

async function claimNext(options: UsdzWorkerOptions): Promise<{ id: string; claimToken: string } | null> {
  const staleBefore = new Date(Date.now() - (options.staleClaimMs ?? env.USDZ_STALE_CLAIM_MS));
  const candidates = await prisma.hologram.findMany({
    where: {
      OR: [
        { usdzStatus: "pending" },
        { usdzStatus: "processing", usdzClaimedAt: { lt: staleBefore } }
      ]
    },
    orderBy: [{ createdAt: "asc" }],
    take: 5,
    select: { id: true, usdzStatus: true }
  });

  for (const candidate of candidates) {
    const claimToken = randomUUID();
    const result = await prisma.hologram.updateMany({
      where:
        candidate.usdzStatus === "pending"
          ? { id: candidate.id, usdzStatus: "pending" }
          : { id: candidate.id, usdzStatus: "processing", usdzClaimedAt: { lt: staleBefore } },
      data: {
        usdzStatus: "processing",
        usdzClaimedAt: new Date(),
        usdzClaimToken: claimToken,
        usdzAttempts: { increment: 1 },
        usdzError: null
      }
    });
    if (result.count === 1) {
      return { id: candidate.id, claimToken };
    }
  }
  return null;
}

/** Process one claimed (or next claimable) hologram. Returns false when idle. */
export async function processNextUsdzConversion(options: UsdzWorkerOptions): Promise<boolean> {
  const log = options.logger ?? silentLogger;
  const claimed = await claimNext(options);
  if (!claimed) return false;

  const { storage } = options;
  const convert = options.convert ?? convertGlbToUsdz;
  const record = await prisma.hologram.findUnique({ where: { id: claimed.id } });
  if (!record) return true;

  const glbKey = record.filenameStored;
  const usdzKey = usdzFilenameFor(record.filenameStored);
  const usdzPath = `uploads/${usdzKey}`;
  const workDir = await mkdtemp(path.join(tmpdir(), "holoim-usdz-"));

  try {
    const existing = await storage.head(usdzKey);
    if (!existing) {
      const glbPath = path.join(workDir, glbKey);
      const usdzTempPath = path.join(workDir, usdzKey);
      await storage.downloadToFile(glbKey, glbPath);
      await convert(glbPath, usdzTempPath);
      await storage.putFile(usdzKey, usdzTempPath, "model/vnd.usdz+zip", undefined, "inline");
    }

    const published = await prisma.hologram.updateMany({
      where: { id: claimed.id, usdzStatus: "processing", usdzClaimToken: claimed.claimToken },
      data: { usdzStatus: "ready", usdzPath, usdzClaimedAt: null, usdzClaimToken: null, usdzError: null }
    });
    if (published.count === 0) {
      // Deleted or reclaimed while converting: remove our output.
      await storage.delete(usdzKey).catch(() => undefined);
      log.info({ hologramId: claimed.id }, "USDZ publish skipped; record changed during conversion");
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "USDZ conversion failed";
    await prisma.hologram
      .updateMany({
        where: { id: claimed.id, usdzStatus: "processing", usdzClaimToken: claimed.claimToken },
        data: { usdzStatus: "failed", usdzError: message, usdzClaimedAt: null, usdzClaimToken: null }
      })
      .catch(() => undefined);
    log.error({ error, hologramId: claimed.id }, "USDZ conversion failed");
    return true;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function startUsdzWorker(options: UsdzWorkerOptions & { pollIntervalMs?: number }): { stop: () => void } {
  const log = options.logger ?? silentLogger;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Drain available work one conversion at a time.
      while (!stopped && (await processNextUsdzConversion(options))) {
        // continue until idle
      }
    } catch (error) {
      log.error({ error }, "USDZ worker poll failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.pollIntervalMs ?? env.USDZ_POLL_INTERVAL_MS);
  timer.unref();
  void tick();
  log.info({}, "USDZ worker started");

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
