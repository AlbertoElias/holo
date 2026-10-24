import { env } from "../lib/env.js";
import {
  deleteCompletedUploadIntent,
  deleteUncompletedUploadIntent,
  listExpiredUploadIntents,
  listOldCompletedUploadIntents
} from "./hologram-repo.js";
import type { MediaStorage } from "./media-storage.js";

export type UploadIntentCleanupResult = {
  expiredRemoved: number;
  completedPruned: number;
  storageFailures: number;
};

export type UploadIntentCleanupOptions = {
  storage: MediaStorage;
  now?: Date;
  /** Extra time after expiry before an intent is swept; protects an in-flight complete. */
  graceMs?: number;
  /** Completed intent rows older than this are pruned (rows only, no objects). */
  completedRetentionMs?: number;
  batchSize?: number;
  logger?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void };
};

const silentLogger = { info: () => undefined, error: () => undefined };

/**
 * One cleanup sweep. Expired uncompleted intents lose their `incoming/*`
 * object first and their row second; a failed object delete keeps the row
 * so the next sweep retries. Completed rows are pruned after retention —
 * their object was already copied to the published key and removed at
 * complete time, so no storage call is made for them.
 */
export async function cleanupExpiredUploadIntents(
  options: UploadIntentCleanupOptions
): Promise<UploadIntentCleanupResult> {
  const log = options.logger ?? silentLogger;
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 100;
  const expiredBefore = new Date(now.getTime() - (options.graceMs ?? env.UPLOAD_INTENT_GRACE_MS));
  const completedBefore = new Date(
    now.getTime() - (options.completedRetentionMs ?? env.UPLOAD_INTENT_COMPLETED_RETENTION_MS)
  );

  let expiredRemoved = 0;
  let completedPruned = 0;
  let storageFailures = 0;

  for (const intent of await listExpiredUploadIntents(expiredBefore, batchSize)) {
    try {
      await options.storage.delete(intent.storageKey);
    } catch (error) {
      storageFailures += 1;
      log.error({ error, intentId: intent.id }, "Could not delete expired upload object; keeping intent for retry");
      continue;
    }
    if (await deleteUncompletedUploadIntent(intent.id)) {
      expiredRemoved += 1;
    }
  }

  for (const intent of await listOldCompletedUploadIntents(completedBefore, batchSize)) {
    if (await deleteCompletedUploadIntent(intent.id, completedBefore)) {
      completedPruned += 1;
    }
  }

  if (expiredRemoved > 0 || completedPruned > 0 || storageFailures > 0) {
    log.info({ expiredRemoved, completedPruned, storageFailures }, "Upload-intent cleanup sweep finished");
  }
  return { expiredRemoved, completedPruned, storageFailures };
}

export function startUploadIntentCleanup(
  options: UploadIntentCleanupOptions & { intervalMs?: number }
): { stop: () => void } {
  const log = options.logger ?? silentLogger;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await cleanupExpiredUploadIntents(options);
    } catch (error) {
      log.error({ error }, "Upload-intent cleanup sweep failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs ?? env.UPLOAD_INTENT_CLEANUP_INTERVAL_MS);
  timer.unref();
  void tick();
  log.info({}, "Upload-intent cleanup started");

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}
