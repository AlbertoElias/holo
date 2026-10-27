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

  // Object search (PRD-060) also answers the capture app, which is not a web
  // origin: those routes carry no credentials, but Poly Pizza's terms forbid
  // offering its models to any other site, so they are not open to all.
  const objectRoutePrefix = `${API_PREFIX}/objects/`;
  const objectOrigins = [...env.WEB_ORIGIN_LIST, ...env.CAPTURE_ORIGIN_LIST];
  app.register(cors, {
    delegator(request, callback) {
      const origin = request.headers.origin;
      const allowed = request.url.startsWith(objectRoutePrefix)
        ? isAllowedWebOrigin(origin, env.WEB_ORIGIN, objectOrigins)
        : isAllowedWebOrigin(origin, env.WEB_ORIGIN, env.WEB_ORIGIN_LIST);
      callback(null, { origin: allowed, credentials: false });
    }
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
