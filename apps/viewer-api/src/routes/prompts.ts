import type { FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createPromptRequestSchema,
  hologramDtoSchema,
  promptCapabilitiesSchema,
  promptJobDtoSchema,
  publishPromptRequestSchema,
  revisePromptRequestSchema,
  type PromptFinish,
  type PromptJobDTO,
  type PromptJobStatus
} from "@holoim/contracts";

import { API_PREFIX } from "../lib/constants.js";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveAuth } from "../services/auth.js";
import { createHologram, getHologramById } from "../services/hologram-repo.js";
import { GLB_CONTENT_TYPE, placeDetailKeyFor, servedKeyFor, storeUpload, textureDetailKeyFor } from "../services/hologram-ingest.js";
import type { MediaStorage } from "../services/media-storage.js";
import { createPromptRunner, type PromptRunner } from "../services/prompt-runner.js";
import { getPromptCapabilities, resolveLlmConfig } from "../services/prompt-llm.js";
import type { PromptBuildFn } from "../services/prompt-builder.js";
import { createHologramFeedSnapshotWriter } from "./holograms.js";

const SIGN_IN_REQUIRED = "Sign in to create a hologram.";

type PromptJobRow = {
  id: string;
  ownerId: string;
  parentJobId: string | null;
  prompt: string;
  finish: string;
  status: string;
  title: string | null;
  intent: string | null;
  durationSec: number | null;
  beatCount: number | null;
  hasVoice: boolean;
  previewKey: string | null;
  sizeBytes: number | null;
  error: string | null;
  publishedHologramId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toPromptJobDto(row: PromptJobRow): PromptJobDTO {
  return promptJobDtoSchema.parse({
    id: row.id,
    status: row.status as PromptJobStatus,
    prompt: row.prompt,
    finish: (row.finish === "ink" || row.finish === "light" ? row.finish : "clay") as PromptFinish,
    title: row.title,
    intent: row.intent,
    durationSec: row.durationSec,
    beatCount: row.beatCount,
    hasVoice: row.hasVoice,
    previewUrl: row.status === "ready" && row.previewKey ? `${API_PREFIX}/prompts/${row.id}/preview.glb` : null,
    sizeBytes: row.sizeBytes,
    error: row.error,
    parentJobId: row.parentJobId,
    publishedHologramId: row.publishedHologramId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  });
}

function toPublishedHologramDto(
  record: NonNullable<Awaited<ReturnType<typeof getHologramById>>>,
  storage: MediaStorage,
  viewerId: string
) {
  const usdzStatus =
    record.usdzStatus === "pending" ||
    record.usdzStatus === "processing" ||
    record.usdzStatus === "ready" ||
    record.usdzStatus === "failed"
      ? record.usdzStatus
      : "none";
  const servedKey = record.servedKey ?? servedKeyFor(record.filenameStored);
  return hologramDtoSchema.parse({
    id: record.id,
    url: storage.publicUrl(record.processStatus === "ready" ? servedKey : record.filenameStored),
    usdzUrl: record.usdzPath ? storage.publicUrl(path.basename(record.usdzPath)) : null,
    usdzStatus,
    quickLookEnabled: record.quickLookEnabled,
    createdAt: record.createdAt.toISOString(),
    sizeBytes: record.sizeBytes,
    filenameOriginal: record.filenameOriginal,
    hologramName: record.hologramName,
    submittedBy: record.submittedBy,
    submittedByVerified: record.ownerId !== null,
    ownedByViewer: record.ownerId !== null && record.ownerId === viewerId,
    placeDetailUrl: record.placeDetailKey ? storage.publicUrl(record.placeDetailKey || placeDetailKeyFor(record.filenameStored)) : null,
    textureDetailUrl: record.textureDetailKey
      ? storage.publicUrl(record.textureDetailKey || textureDetailKeyFor(record.filenameStored))
      : null,
    ownerId: record.ownerId
  });
}

export type PromptRouteOptions = {
  storage: MediaStorage;
  runner?: PromptRunner | undefined;
  buildTake?: PromptBuildFn | undefined;
  fetchImpl?: typeof fetch | undefined;
};

export async function registerPromptRoutes(app: FastifyInstance, options: PromptRouteOptions): Promise<void> {
  const { storage } = options;
  const runner =
    options.runner ??
    createPromptRunner({
      storage,
      buildTake: options.buildTake,
      fetchImpl: options.fetchImpl,
      logger: {
        info: (obj, msg) => app.log.info(obj as object, msg),
        error: (obj, msg) => app.log.error(obj as object, msg)
      }
    });
  const refreshFeedSnapshot = createHologramFeedSnapshotWriter(storage, app.log);

  app.get("/prompts/capabilities", async () => {
    return promptCapabilitiesSchema.parse(getPromptCapabilities());
  });

  app.get("/prompts", async (request, reply) => {
    const auth = await resolveAuth(request.headers);
    if (!auth) return reply.status(401).send({ error: SIGN_IN_REQUIRED });

    const rows = await prisma.promptJob.findMany({
      where: { ownerId: auth.user.id },
      orderBy: { createdAt: "desc" },
      take: 20
    });
    return { items: rows.map(toPromptJobDto) };
  });

  app.post("/prompts", async (request, reply) => {
    const auth = await resolveAuth(request.headers);
    if (!auth) return reply.status(401).send({ error: SIGN_IN_REQUIRED });

    const parsed = createPromptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid prompt request." });
    }

    let llm;
    try {
      llm = resolveLlmConfig(request.headers);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid LLM provider header." });
    }
    if (!llm) {
      return reply.status(400).send({
        error: "No AI key configured on the server. Open 'Use my API key' and enter an Anthropic, OpenAI, or OpenRouter key."
      });
    }

    const includeVoice = parsed.data.includeVoice && env.PROMPT_ENABLE_VOICE;
    const job = await prisma.promptJob.create({
      data: {
        ownerId: auth.user.id,
        prompt: parsed.data.prompt,
        finish: parsed.data.finish,
        includeVoice,
        status: "queued"
      }
    });

    runner.enqueue(job.id, llm);
    return reply.status(202).send(toPromptJobDto(job));
  });

  app.get<{ Params: { id: string } }>("/prompts/:id", async (request, reply) => {
    const auth = await resolveAuth(request.headers);
    if (!auth) return reply.status(401).send({ error: SIGN_IN_REQUIRED });

    const job = await prisma.promptJob.findUnique({ where: { id: request.params.id } });
    if (!job || job.ownerId !== auth.user.id) {
      return reply.status(404).send({ error: "Prompt job not found." });
    }

    return toPromptJobDto(job);
  });

  app.get<{ Params: { id: string } }>("/prompts/:id/preview.glb", async (request, reply) => {
    const auth = await resolveAuth(request.headers);
    if (!auth) return reply.status(401).send({ error: SIGN_IN_REQUIRED });

    const job = await prisma.promptJob.findUnique({ where: { id: request.params.id } });
    if (!job || job.ownerId !== auth.user.id || !job.previewKey || job.status !== "ready") {
      return reply.status(404).send({ error: "Preview not ready." });
    }

    const workDir = await mkdtemp(path.join(tmpdir(), "holoim-preview-"));
    const localFile = path.join(workDir, "preview.glb");
    try {
      await storage.downloadToFile(job.previewKey, localFile);
      const buffer = await readFile(localFile);
      return reply
        .header("content-type", GLB_CONTENT_TYPE)
        .header("cache-control", "private, max-age=3600")
        .send(buffer);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  app.post<{ Params: { id: string } }>("/prompts/:id/revise", async (request, reply) => {
    const auth = await resolveAuth(request.headers);
    if (!auth) return reply.status(401).send({ error: SIGN_IN_REQUIRED });

    const parent = await prisma.promptJob.findUnique({ where: { id: request.params.id } });
    if (!parent || parent.ownerId !== auth.user.id) {
      return reply.status(404).send({ error: "Prompt job not found." });
    }

    const parsed = revisePromptRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid revision note." });
    }

    let llm;
    try {
      llm = resolveLlmConfig(request.headers);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : "Invalid LLM provider header." });
    }
    if (!llm) {
      return reply.status(400).send({
        error: "No AI key configured on the server. Open 'Use my API key' and enter an Anthropic, OpenAI, or OpenRouter key."
      });
    }

    const includeVoice = (parsed.data.includeVoice ?? parent.includeVoice) && env.PROMPT_ENABLE_VOICE;
    const child = await prisma.promptJob.create({
      data: {
        ownerId: auth.user.id,
        parentJobId: parent.id,
        prompt: parent.prompt,
        revisionNote: parsed.data.note,
        finish: parsed.data.finish ?? parent.finish,
        includeVoice,
        status: "queued"
      }
    });

    runner.enqueue(child.id, llm);
    return reply.status(202).send(toPromptJobDto(child));
  });

  app.post<{ Params: { id: string } }>("/prompts/:id/publish", async (request, reply) => {
    const auth = await resolveAuth(request.headers);
    if (!auth) return reply.status(401).send({ error: SIGN_IN_REQUIRED });

    const job = await prisma.promptJob.findUnique({ where: { id: request.params.id } });
    if (!job || job.ownerId !== auth.user.id) {
      return reply.status(404).send({ error: "Prompt job not found." });
    }

    // Idempotent publish: double-taps return the already-created hologram.
    if (job.publishedHologramId) {
      const existing = await getHologramById(job.publishedHologramId);
      if (existing) {
        return reply.status(200).send(toPublishedHologramDto(existing, storage, auth.user.id));
      }
    }

    if (job.status !== "ready" || !job.previewKey || !job.sizeBytes) {
      return reply.status(409).send({ error: "Hologram is not ready to publish yet." });
    }

    const parsed = publishPromptRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid publish options." });
    }

    const hologramName = parsed.data.hologramName ?? job.title ?? "AI Hologram";
    const workDir = await mkdtemp(path.join(tmpdir(), "holoim-publish-"));
    const stagingRoot = path.join(workDir, "staging");
    const previewFile = path.join(workDir, "preview.glb");
    try {
      await storage.downloadToFile(job.previewKey, previewFile);
      const stored = await storeUpload(storage, previewFile, job.sizeBytes, stagingRoot);
      const created = await createHologram({
        filenameOriginal: `${hologramName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "hologram"}.glb`,
        hologramName,
        submittedBy: auth.user.displayName,
        filenameStored: stored.filenameStored,
        mimeType: GLB_CONTENT_TYPE,
        sizeBytes: stored.sizeBytes,
        storagePath: `uploads/${stored.filenameStored}`,
        quickLookEnabled: parsed.data.quickLookEnabled,
        placeDetailKey: stored.placeDetailKey,
        processStatus: stored.processStatus,
        ownerId: auth.user.id
      });

      await prisma.promptJob.update({
        where: { id: job.id },
        data: { publishedHologramId: created.id }
      });

      await refreshFeedSnapshot();
      return reply.status(201).send(toPublishedHologramDto(created, storage, auth.user.id));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
}
