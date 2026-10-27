import type { FastifyInstance } from "fastify";

import {
  OBJECT_SEARCH_MAX_RESULTS,
  objectSearchQuerySchema,
  objectSearchResponseSchema
} from "@holoim/contracts";

import { env } from "../lib/env.js";
import {
  ObjectTooLargeError,
  POLYHAVEN_ID_PATTERN,
  UnknownObjectError,
  UpstreamError,
  createPolyhaven,
  sourceUrl,
  thumbnailUrl,
  type Polyhaven
} from "../services/polyhaven.js";

const GLB_FILE_PATTERN = /^(.+)\.glb$/;
// A model's files change rarely and the server caches the packed GLB; a day is safe.
const GLB_CACHE_CONTROL = "public, max-age=86400";

export async function registerObjectRoutes(
  app: FastifyInstance,
  options: { polyhaven?: Polyhaven } = {}
): Promise<void> {
  const polyhaven =
    options.polyhaven ??
    createPolyhaven({ apiOrigin: env.POLYHAVEN_API_ORIGIN, allowedHosts: env.POLYHAVEN_ALLOWED_HOST_LIST });

  function fail(reply: { status: (code: number) => { send: (body: unknown) => unknown } }, error: unknown) {
    if (error instanceof UnknownObjectError) return reply.status(404).send({ error: "No such object." });
    if (error instanceof ObjectTooLargeError) return reply.status(422).send({ error: error.message });
    if (error instanceof UpstreamError) {
      return reply.status(502).send({ error: `Object search is unavailable: ${error.message}` });
    }
    throw error;
  }

  app.get("/objects/search", async (request, reply) => {
    const parsed = objectSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "A search of 1 to 100 characters is required." });
    }
    try {
      const found = await polyhaven.search(parsed.data.q, OBJECT_SEARCH_MAX_RESULTS);
      return objectSearchResponseSchema.parse({
        results: found.map((model) => ({
          id: model.id,
          source: "Poly Haven",
          title: model.title,
          author: model.author,
          licence: "CC0-1.0" as const,
          sourceUrl: sourceUrl(model.id),
          thumbnailUrl: thumbnailUrl(model.id),
          glbPath: `/api/objects/polyhaven/${model.id}.glb`,
          dimensionsM: model.dimensionsM,
          bytes: model.bytes
        }))
      });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { file: string } }>("/objects/polyhaven/:file", async (request, reply) => {
    const id = GLB_FILE_PATTERN.exec(request.params.file)?.[1];
    if (!id || !POLYHAVEN_ID_PATTERN.test(id)) return reply.status(404).send({ error: "No such object." });
    try {
      const glb = await polyhaven.packGlb(id);
      return reply
        .header("cache-control", GLB_CACHE_CONTROL)
        .type("model/gltf-binary")
        .send(Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength));
    } catch (error) {
      return fail(reply, error);
    }
  });
}
