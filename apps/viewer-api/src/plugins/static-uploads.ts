import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { mkdir } from "node:fs/promises";

export async function registerStaticUploads(
  app: FastifyInstance,
  options: { uploadsRoot: string }
): Promise<void> {
  const { uploadsRoot } = options;
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
