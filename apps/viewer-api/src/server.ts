import "dotenv/config";

import { buildApp } from "./app.js";
import { env } from "./lib/env.js";
import { prisma } from "./lib/prisma.js";
import { createMediaStorage } from "./services/media-storage.js";
import { startUsdzWorker } from "./services/usdz-worker.js";
import path from "node:path";
import { UPLOADS_DIR } from "./lib/constants.js";

const app = buildApp();

async function main(): Promise<void> {
  if (env.DATABASE_URL.startsWith("file:")) {
    await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
    await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
  }

  if (env.USDZ_WORKER_ENABLED) {
    const uploadsRoot = env.UPLOADS_ROOT ?? path.join(process.cwd(), UPLOADS_DIR);
    const worker = startUsdzWorker({
      storage: createMediaStorage(uploadsRoot),
      logger: {
        info: (obj, msg) => app.log.info(obj as object, msg),
        error: (obj, msg) => app.log.error(obj as object, msg)
      }
    });
    app.addHook("onClose", async () => worker.stop());
  }

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((error: unknown) => {
  app.log.error({ error }, "Failed to start server");
  process.exit(1);
});
