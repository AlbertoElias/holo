import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";

import { API_PREFIX, MAX_GLB_BYTES } from "./lib/constants.js";
import { isAllowedWebOrigin } from "./lib/cors.js";
import { env } from "./lib/env.js";
import { registerStaticUploads } from "./plugins/static-uploads.js";
import { registerHologramRoutes } from "./routes/holograms.js";

export function buildApp() {
  const app = Fastify({ logger: true });

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

  app.register(registerStaticUploads);

  app.register(
    async (instance) => {
      await registerHologramRoutes(instance);
    },
    { prefix: API_PREFIX }
  );

  return app;
}
