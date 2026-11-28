import type { PromptFinish } from "@holoim/contracts";

import { prisma } from "../lib/prisma.js";
import type { MediaStorage } from "./media-storage.js";
import { buildPromptTakeWithDirect, type PromptBuildFn } from "./prompt-builder.js";
import { generateBeatSheet, redactSecret, type LlmConfig } from "./prompt-llm.js";

export type PromptRunnerOptions = {
  storage: MediaStorage;
  buildTake?: PromptBuildFn | undefined;
  fetchImpl?: typeof fetch | undefined;
  logger?: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void } | undefined;
};

export type PromptRunner = {
  enqueue: (jobId: string, llm: LlmConfig) => void;
  waitForIdle: () => Promise<void>;
};

const silentLogger = { info: () => undefined, error: () => undefined };

export function previewKeyForJob(jobId: string): string {
  return `prompts/${jobId}.glb`;
}

/**
 * Serialized in-process runner for prompt-to-hologram jobs.
 * Keeps BYOK keys strictly in memory (deleted as soon as directing finishes)
 * and runs one build at a time so the 2 GB Fly machine stays within memory limits.
 */
export function createPromptRunner(options: PromptRunnerOptions): PromptRunner {
  const buildTake = options.buildTake ?? buildPromptTakeWithDirect;
  const log = options.logger ?? silentLogger;
  const queue: string[] = [];
  const llmByJob = new Map<string, LlmConfig>();
  let active: Promise<void> | null = null;

  async function runOne(jobId: string): Promise<void> {
    const llm = llmByJob.get(jobId);
    // Always wipe the in-memory key once we've pulled it for this run.
    llmByJob.delete(jobId);

    const job = await prisma.promptJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    if (!llm) {
      await prisma.promptJob.update({
        where: { id: jobId },
        data: { status: "failed", error: "API key expired before generation started. Please retry." }
      });
      return;
    }

    try {
      await prisma.promptJob.update({
        where: { id: jobId },
        data: { status: "directing", error: null }
      });

      const parentSheetJson = job.parentJobId
        ? (await prisma.promptJob.findUnique({ where: { id: job.parentJobId }, select: { sheetJson: true } }))?.sheetJson ?? null
        : null;

      let sheet = await generateBeatSheet({
        prompt: job.prompt,
        finish: job.finish as PromptFinish,
        includeVoice: job.includeVoice,
        previousSheetJson: parentSheetJson,
        revisionNote: job.revisionNote,
        llm,
        fetchImpl: options.fetchImpl
      });

      await prisma.promptJob.update({
        where: { id: jobId },
        data: {
          status: "building",
          sheetJson: JSON.stringify(sheet),
          title: typeof sheet.title === "string" ? sheet.title : null,
          intent: typeof sheet.intent === "string" ? sheet.intent : null
        }
      });

      let built;
      try {
        built = await buildTake(sheet);
      } catch (firstBuildError) {
        const firstErrText = redactSecret(
          firstBuildError instanceof Error ? firstBuildError.message : String(firstBuildError),
          llm.apiKey
        );
        // One automatic LLM repair pass when the beat sheet had validation/solver issues.
        await prisma.promptJob.update({ where: { id: jobId }, data: { status: "directing" } });
        sheet = await generateBeatSheet({
          prompt: job.prompt,
          finish: job.finish as PromptFinish,
          includeVoice: job.includeVoice,
          previousSheetJson: JSON.stringify(sheet),
          revisionNote: job.revisionNote ?? "Fix validation errors while keeping the prompt intent.",
          repairErrors: firstErrText,
          llm,
          fetchImpl: options.fetchImpl
        });
        await prisma.promptJob.update({
          where: { id: jobId },
          data: { status: "building", sheetJson: JSON.stringify(sheet) }
        });
        built = await buildTake(sheet);
      }

      const previewKey = previewKeyForJob(jobId);
      await options.storage.putBuffer(previewKey, built.glbBuffer, "model/gltf-binary", "private, max-age=3600");

      await prisma.promptJob.update({
        where: { id: jobId },
        data: {
          status: "ready",
          title: built.title,
          intent: built.intent,
          durationSec: built.durationSec,
          beatCount: built.beatCount,
          hasVoice: built.hasVoice,
          previewKey,
          sizeBytes: built.sizeBytes,
          error: null
        }
      });

      log.info({ jobId, sizeBytes: built.sizeBytes, hasVoice: built.hasVoice }, "Prompt hologram ready");
    } catch (error) {
      const safeError = redactSecret(error instanceof Error ? error.message : String(error), llm.apiKey).slice(0, 500);
      await prisma.promptJob.update({
        where: { id: jobId },
        data: { status: "failed", error: safeError }
      });
      log.error({ jobId, error: safeError }, "Prompt hologram build failed");
    }
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const nextId = queue.shift()!;
      await runOne(nextId);
    }
    active = null;
  }

  return {
    enqueue(jobId: string, llm: LlmConfig) {
      llmByJob.set(jobId, llm);
      queue.push(jobId);
      if (!active) {
        active = drain();
      }
    },
    async waitForIdle() {
      while (active) {
        await active;
      }
    }
  };
}
