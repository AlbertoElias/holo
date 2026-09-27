import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import path from "node:path";

import { API_PREFIX, MAX_GLB_BYTES, UPLOADS_DIR } from "./lib/constants.js";
import { isAllowedWebOrigin } from "./lib/cors.js";
import { env } from "./lib/env.js";
import { registerStaticUploads } from "./plugins/static-uploads.js";
import { registerHologramRoutes } from "./routes/holograms.js";

type BuildAppOptions = {
  logger?: boolean;
  uploadsRoot?: string;
};

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? true });
  const uploadsRoot = options.uploadsRoot ?? path.join(process.cwd(), UPLOADS_DIR);

  app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowedWebOrigin(origin, env.WEB_ORIGIN));
    },
    credentials: false
  });

  app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_GLB_BYTES
    }
  });

  app.register(registerStaticUploads, { uploadsRoot });

  app.register(
    async (instance) => {
      await registerHologramRoutes(instance, { uploadsRoot });
    },
    { prefix: API_PREFIX }
  );

  return app;
}
