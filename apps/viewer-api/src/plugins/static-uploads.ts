import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { UPLOADS_DIR } from "../lib/constants.js";

export async function registerStaticUploads(app: FastifyInstance): Promise<void> {
  const uploadsRoot = path.join(process.cwd(), UPLOADS_DIR);
  await mkdir(uploadsRoot, { recursive: true });

  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: "/uploads/",
    decorateReply: false,
    serveDotFiles: false,
    list: false,
    maxAge: "1h",
    setHeaders(res, filePath) {
      if (typeof filePath === "string" && filePath.endsWith(".usdz")) {
        res.setHeader("Content-Type", "model/vnd.usdz+zip");
        res.setHeader("Content-Disposition", "inline");
      }
    }
  });
}
