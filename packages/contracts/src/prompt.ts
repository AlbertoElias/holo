import { z } from "zod";

export const PROMPT_MAX_LENGTH = 500;
export const PROMPT_REVISION_MAX_LENGTH = 300;

export const promptFinishSchema = z.enum(["clay", "ink", "light"]);
export type PromptFinish = z.infer<typeof promptFinishSchema>;

export const promptLlmProviderSchema = z.enum(["anthropic", "openai", "openrouter", "workers-ai", "mock"]);
export type PromptLlmProvider = z.infer<typeof promptLlmProviderSchema>;

export const promptJobStatusSchema = z.enum(["queued", "directing", "building", "ready", "failed"]);
export type PromptJobStatus = z.infer<typeof promptJobStatusSchema>;

export const createPromptRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(PROMPT_MAX_LENGTH),
  finish: promptFinishSchema.default("clay"),
  includeVoice: z.boolean().default(true)
});
export type CreatePromptRequest = z.infer<typeof createPromptRequestSchema>;

export const revisePromptRequestSchema = z.object({
  note: z.string().trim().min(2).max(PROMPT_REVISION_MAX_LENGTH),
  finish: promptFinishSchema.optional(),
  includeVoice: z.boolean().optional()
});
export type RevisePromptRequest = z.infer<typeof revisePromptRequestSchema>;

export const publishPromptRequestSchema = z.object({
  hologramName: z.string().trim().min(1).max(120).optional(),
  quickLookEnabled: z.boolean().default(true)
});
export type PublishPromptRequest = z.infer<typeof publishPromptRequestSchema>;

export const promptCapabilitiesSchema = z.object({
  serverLlmAvailable: z.boolean(),
  serverProvider: promptLlmProviderSchema.nullable(),
  voiceAvailable: z.boolean(),
  supportedByokProviders: z.array(promptLlmProviderSchema)
});
export type PromptCapabilitiesDTO = z.infer<typeof promptCapabilitiesSchema>;

export const promptJobDtoSchema = z.object({
  id: z.string(),
  status: promptJobStatusSchema,
  prompt: z.string(),
  finish: promptFinishSchema,
  title: z.string().nullable(),
  intent: z.string().nullable(),
  durationSec: z.number().nullable(),
  beatCount: z.number().int().nonnegative().nullable(),
  hasVoice: z.boolean(),
  previewUrl: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  parentJobId: z.string().nullable(),
  publishedHologramId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type PromptJobDTO = z.infer<typeof promptJobDtoSchema>;
