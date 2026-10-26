import type { MediaStorage } from "./media-storage.js";

/**
 * The feed's first page as an anonymous viewer sees it, kept next to the
 * media so the viewer's edge can serve it while this API sleeps
 * (docs/features/snappy-feed-first-load.md). The live list stays the
 * authority: the viewer replaces the snapshot once the API answers.
 */
export const FEED_SNAPSHOT_KEY = "feed/latest.json";

type Logger = { error: (obj: unknown, msg: string) => void };

/**
 * Returns a function that rewrites the snapshot from `readPage`. Calls that
 * arrive while a write runs collapse into one more write after it, so the
 * last write always reflects the latest change.
 */
export function createFeedSnapshotWriter(storage: MediaStorage, readPage: () => Promise<unknown>, logger: Logger): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;

  const write = async (): Promise<void> => {
    try {
      const body = Buffer.from(JSON.stringify(await readPage()));
      await storage.putBuffer(FEED_SNAPSHOT_KEY, body, "application/json", "no-cache");
    } catch (error) {
      logger.error({ error }, "Could not write the feed snapshot");
    }
  };

  const refresh = (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await write();
      } while (again);
      running = null;
    })();
    return running;
  };
  return refresh;
}
