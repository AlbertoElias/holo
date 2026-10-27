import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  OBJECT_SEARCH_MAX_RESULTS,
  OBJECT_TRANSCRIBE_MAX_BYTES,
  objectSearchQuerySchema,
  objectSearchResponseSchema,
  objectTranscribeResponseSchema,
  type ObjectSearchResult
} from "@holoim/contracts";

import { env } from "../lib/env.js";
import {
  POLYHAVEN_ID_PATTERN,
  createPolyhaven,
  sourceUrl as polyhavenSourceUrl,
  thumbnailUrl as polyhavenThumbnailUrl,
  type Polyhaven
} from "../services/polyhaven.js";
import {
  POLYPIZZA_ID_PATTERN,
  createPolypizza,
  sourceUrl as polypizzaSourceUrl,
  type Polypizza
} from "../services/polypizza.js";
import { ObjectTooLargeError, UnknownObjectError, UpstreamError } from "../services/registry-fetch.js";
import { TranscriptionUnavailableError, createTranscriber, type Transcriber } from "../services/transcribe.js";

const GLB_FILE_PATTERN = /^(.+)\.glb$/;
// A model's files change rarely and the server caches the packed GLB; a day is safe.
const GLB_CACHE_CONTROL = "public, max-age=86400";
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/wave", "audio/mp4"]);
// Push to talk is a few seconds a query; this keeps one client from spending
// the whole daily Workers AI allowance.
const TRANSCRIBE_WINDOW_MS = 60_000;
const TRANSCRIBE_PER_WINDOW = 10;
// All clients together, so rotating addresses cannot drain the allowance in minutes.
const TRANSCRIBE_ALL_PER_WINDOW = 60;
// A search may download and vet several Poly Pizza GLBs; a person types a few a minute.
const SEARCH_WINDOW_MS = 60_000;
const SEARCH_PER_WINDOW = 30;
// Capture prefetches one GLB per search and fetches each pick, so twice the
// search allowance; each new Poly Pizza id costs a request on our API key.
const GLB_PER_WINDOW = 60;

export type ObjectRouteOptions = {
  polyhaven?: Polyhaven;
  /** null turns Poly Pizza off; undefined builds it from env when a key is set. */
  polypizza?: Polypizza | null;
  /** null turns transcription off; undefined builds it from env when configured. */
  transcriber?: Transcriber | null;
  /** Transcriptions per client per minute. */
  transcribeLimit?: number;
  /** Searches per client per minute. */
  searchLimit?: number;
  /** GLB downloads per client per minute, both registries together. */
  glbLimit?: number;
};

/** Takes the registries' results in turn, best first, so each source's top picks are shown. */
function interleave<T>(lists: T[][], max: number): T[] {
  const merged: T[] = [];
  for (let rank = 0; merged.length < max && lists.some((list) => rank < list.length); rank += 1) {
    for (const list of lists) {
      if (rank < list.length && merged.length < max) merged.push(list[rank]!);
    }
  }
  return merged;
}

/**
 * Fly's proxy overwrites Fly-Client-IP with the real client, so it is trusted
 * only on Fly (FLY_APP_NAME is set on every Fly machine); elsewhere a client
 * could send any value, so the socket address is the client.
 */
function clientKey(request: FastifyRequest, behindFly: boolean): string {
  const forwarded = request.headers["fly-client-ip"];
  return behindFly && typeof forwarded === "string" && forwarded.length > 0 ? forwarded : request.ip;
}

function createRateLimit(perWindow: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string, now = Date.now()): number | null => {
    if (windows.size > 10_000) {
      for (const [entry, value] of windows) if (now - value.start >= windowMs) windows.delete(entry);
    }
    const current = windows.get(key);
    if (!current || now - current.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return null;
    }
    if (current.count >= perWindow) return Math.ceil((current.start + windowMs - now) / 1000);
    current.count += 1;
    return null;
  };
}

export async function registerObjectRoutes(app: FastifyInstance, options: ObjectRouteOptions = {}): Promise<void> {
  const polyhaven =
    options.polyhaven ??
    createPolyhaven({ apiOrigin: env.POLYHAVEN_API_ORIGIN, allowedHosts: env.POLYHAVEN_ALLOWED_HOST_LIST });
  const polypizza =
    options.polypizza !== undefined
      ? options.polypizza
      : env.POLYPIZZA_API_KEY
        ? createPolypizza({
            apiOrigin: env.POLYPIZZA_API_ORIGIN,
            apiKey: env.POLYPIZZA_API_KEY,
            allowedHosts: env.POLYPIZZA_ALLOWED_HOST_LIST
          })
        : null;
  const transcriber =
    options.transcriber !== undefined
      ? options.transcriber
      : env.WORKERS_AI_ACCOUNT_ID && env.WORKERS_AI_API_TOKEN
        ? createTranscriber({
            apiOrigin: env.WORKERS_AI_API_ORIGIN,
            accountId: env.WORKERS_AI_ACCOUNT_ID,
            apiToken: env.WORKERS_AI_API_TOKEN
          })
        : null;
  const behindFly = Boolean(process.env.FLY_APP_NAME);
  const transcribeLimit = createRateLimit(options.transcribeLimit ?? TRANSCRIBE_PER_WINDOW, TRANSCRIBE_WINDOW_MS);
  const transcribeAllLimit = createRateLimit(TRANSCRIBE_ALL_PER_WINDOW, TRANSCRIBE_WINDOW_MS);
  const searchLimit = createRateLimit(options.searchLimit ?? SEARCH_PER_WINDOW, SEARCH_WINDOW_MS);
  const glbLimit = createRateLimit(options.glbLimit ?? GLB_PER_WINDOW, SEARCH_WINDOW_MS);

  function limitGlb(request: FastifyRequest, reply: FastifyReply) {
    const retryAfter = glbLimit(clientKey(request, behindFly));
    if (retryAfter === null) return null;
    return reply.status(429).header("retry-after", String(retryAfter)).send({ error: "Too many downloads; try again in a minute." });
  }

  function fail(reply: FastifyReply, error: unknown) {
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
    const retryAfter = searchLimit(clientKey(request, behindFly));
    if (retryAfter !== null) {
      return reply.status(429).header("retry-after", String(retryAfter)).send({ error: "Too many searches; try again in a minute." });
    }
    const query = parsed.data.q;
    const [haven, pizza] = await Promise.allSettled([
      polyhaven.search(query, OBJECT_SEARCH_MAX_RESULTS),
      polypizza ? polypizza.search(query, OBJECT_SEARCH_MAX_RESULTS) : Promise.resolve([])
    ]);
    if (pizza.status === "rejected") request.log.warn({ err: pizza.reason }, "Poly Pizza search failed; showing Poly Haven alone");
    if (haven.status === "rejected" && (pizza.status === "rejected" || !polypizza)) return fail(reply, haven.reason);
    if (haven.status === "rejected") request.log.warn({ err: haven.reason }, "Poly Haven search failed; showing Poly Pizza alone");

    const havenResults: ObjectSearchResult[] = (haven.status === "fulfilled" ? haven.value : []).map((model) => ({
      id: model.id,
      source: "Poly Haven",
      title: model.title,
      author: model.author,
      licence: "CC0-1.0" as const,
      sourceUrl: polyhavenSourceUrl(model.id),
      thumbnailUrl: polyhavenThumbnailUrl(model.id),
      glbPath: `/api/objects/polyhaven/${model.id}.glb`,
      dimensionsM: model.dimensionsM,
      bytes: model.bytes
    }));
    const pizzaResults: ObjectSearchResult[] = (pizza.status === "fulfilled" ? pizza.value : []).map((model) => ({
      id: model.id,
      source: "Poly Pizza",
      title: model.title,
      author: model.author,
      licence: model.licence,
      sourceUrl: polypizzaSourceUrl(model.id),
      thumbnailUrl: model.thumbnailUrl,
      glbPath: `/api/objects/polypizza/${model.id}.glb`,
      // Poly Pizza states no real-world size.
      dimensionsM: null,
      bytes: model.bytes
    }));
    return objectSearchResponseSchema.parse({ results: interleave([havenResults, pizzaResults], OBJECT_SEARCH_MAX_RESULTS) });
  });

  async function sendGlb(reply: FastifyReply, pack: () => Promise<Uint8Array>) {
    try {
      const glb = await pack();
      return reply
        .header("cache-control", GLB_CACHE_CONTROL)
        .type("model/gltf-binary")
        .send(Buffer.from(glb.buffer, glb.byteOffset, glb.byteLength));
    } catch (error) {
      return fail(reply, error);
    }
  }

  app.get<{ Params: { file: string } }>("/objects/polyhaven/:file", async (request, reply) => {
    const id = GLB_FILE_PATTERN.exec(request.params.file)?.[1];
    if (!id || !POLYHAVEN_ID_PATTERN.test(id)) return reply.status(404).send({ error: "No such object." });
    return limitGlb(request, reply) ?? sendGlb(reply, () => polyhaven.packGlb(id));
  });

  app.get<{ Params: { file: string } }>("/objects/polypizza/:file", async (request, reply) => {
    const id = GLB_FILE_PATTERN.exec(request.params.file)?.[1];
    if (!polypizza || !id || !POLYPIZZA_ID_PATTERN.test(id)) return reply.status(404).send({ error: "No such object." });
    return limitGlb(request, reply) ?? sendGlb(reply, () => polypizza.packGlb(id));
  });

  // Its own scope, so the raw audio parser and error mapping touch no other route.
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: OBJECT_TRANSCRIBE_MAX_BYTES }, (_request, body, done) => {
      done(null, body);
    });
    scoped.setErrorHandler((error: { code?: string; statusCode?: number }, _request, reply) => {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.status(413).send({ error: "That recording is too long." });
      }
      if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
        return reply.status(415).send({ error: "Send the recording as audio/webm, audio/ogg, audio/wav or audio/mp4." });
      }
      if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
        return reply.status(error.statusCode).send({ error: "The recording could not be read." });
      }
      throw error;
    });

    scoped.post("/objects/transcribe", async (request, reply) => {
      const type = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (!AUDIO_TYPES.has(type) || !Buffer.isBuffer(request.body)) {
        return reply.status(415).send({ error: "Send the recording as audio/webm, audio/ogg, audio/wav or audio/mp4." });
      }
      if (request.body.byteLength === 0) return reply.status(400).send({ error: "The recording is empty." });
      if (!transcriber) return reply.status(503).send({ error: "Voice search is not set up; type the search instead." });
      const retryAfter = transcribeLimit(clientKey(request, behindFly)) ?? transcribeAllLimit("all");
      if (retryAfter !== null) {
        return reply
          .status(429)
          .header("retry-after", String(retryAfter))
          .send({ error: "Too many voice searches; try again in a minute." });
      }
      try {
        const text = await transcriber.transcribe(request.body);
        return objectTranscribeResponseSchema.parse({ text });
      } catch (error) {
        if (error instanceof TranscriptionUnavailableError) {
          return reply.status(503).send({ error: `${error.message} Type the search instead.` });
        }
        if (error instanceof UpstreamError) {
          request.log.warn({ err: error }, "transcription failed");
          return reply.status(502).send({ error: `Voice search is unavailable: ${error.message}` });
        }
        throw error;
      }
    });
  });
}
