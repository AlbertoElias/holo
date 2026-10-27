import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import path from "node:path";

import { API_PREFIX, MAX_GLB_BYTES, UPLOADS_DIR } from "./lib/constants.js";
import { isAllowedWebOrigin } from "./lib/cors.js";
import { env } from "./lib/env.js";
import { registerStaticUploads } from "./plugins/static-uploads.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHologramRoutes } from "./routes/holograms.js";
import { registerObjectRoutes } from "./routes/objects.js";
import { createMediaStorage, type MediaStorage } from "./services/media-storage.js";

type BuildAppOptions = {
  logger?: boolean;
  uploadsRoot?: string;
  storage?: MediaStorage;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const uploadsRoot = options.uploadsRoot ?? env.UPLOADS_ROOT ?? path.join(process.cwd(), UPLOADS_DIR);
  const storage = options.storage ?? createMediaStorage(uploadsRoot);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowedWebOrigin(origin, env.WEB_ORIGIN, env.WEB_ORIGIN_LIST));
    },
    credentials: false
  });

  app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_GLB_BYTES
    }
  });

  if (storage.kind === "local") {
    app.register(registerStaticUploads, { uploadsRoot });
  }

  app.register(
    async (instance) => {
      await registerAuthRoutes(instance);
      await registerHologramRoutes(instance, { uploadsRoot, storage });
      await registerObjectRoutes(instance);
    },
    { prefix: API_PREFIX }
  );

  return app;
}
