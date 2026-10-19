import "dotenv/config";

import path from "node:path";

import { UPLOADS_DIR } from "./lib/constants.js";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { createMediaStorage } from "./services/media-storage.js";
import { startUsdzWorker } from "./services/usdz-worker.js";

// Standalone USDZ worker entrypoint (`pnpm --filter @holoim/api worker:usdz`).
// The production beta embeds the same loop in server.ts; this entry runs it
// without the HTTP API for local/operator use.
async function main(): Promise<void> {
  if (env.DATABASE_URL.startsWith("file:")) {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
  }

  const uploadsRoot = env.UPLOADS_ROOT ?? path.join(process.cwd(), UPLOADS_DIR);
  const worker = startUsdzWorker({
    storage: createMediaStorage(uploadsRoot),
    logger: {
      info: (obj, msg) => console.info(msg ?? "", obj),
      error: (obj, msg) => console.error(msg ?? "", obj)
    }
  });

  const shutdown = () => {
    worker.stop();
    void prisma.$disconnect().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error("Failed to start USDZ worker", error);
  process.exit(1);
});
