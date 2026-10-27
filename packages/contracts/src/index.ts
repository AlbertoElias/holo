import { z } from "zod";

export const usdzStatusSchema = z.enum(["none", "pending", "processing", "ready", "failed"]);
export type UsdzStatus = z.infer<typeof usdzStatusSchema>;

export const hologramDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  usdzUrl: z.string().nullable(),
  // Default keeps older fixtures/mocks parseable; the API always sends it.
  usdzStatus: usdzStatusSchema.default("none"),
  quickLookEnabled: z.boolean(),
  createdAt: z.string().datetime(),
  sizeBytes: z.number().int().nonnegative(),
  filenameOriginal: z.string(),
  hologramName: z.string(),
  submittedBy: z.string(),
  // Defaults keep older fixtures/mocks parseable; the API always sends them.
  submittedByVerified: z.boolean().default(false),
  ownedByViewer: z.boolean().default(false)
});

export const userDtoSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.string().datetime()
});

export const requestMagicLinkSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(1).max(80).optional()
});

export const requestMagicLinkResponseSchema = z.object({
  sent: z.literal(true),
  // Present only when the API runs with AUTH_DEV_EXPOSE_MAGIC_LINK=true.
  devMagicLinkToken: z.string().optional()
});

export const verifyMagicLinkSchema = z.object({
  token: z.string().trim().min(1).max(512)
});

export const sessionResponseSchema = z.object({
  token: z.string(),
  user: userDtoSchema
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(80)
});

export const paginatedHologramsSchema = z.object({
  items: z.array(hologramDtoSchema),
  nextCursor: z.string().nullable()
});

export const deleteHologramResponseSchema = z.object({
  id: z.string(),
  deletedFile: z.boolean(),
  deletedUsdz: z.boolean()
});

export const usdzStatusResponseSchema = z.object({
  id: z.string(),
  usdzStatus: usdzStatusSchema,
  usdzUrl: z.string().nullable()
});

export const initiateUploadRequestSchema = z.object({
  filenameOriginal: z.string().trim().min(1).max(255),
  hologramName: z.string().trim().min(1).max(120),
  submittedBy: z.string().trim().min(1).max(80),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().trim().min(1).max(120),
  quickLookEnabled: z.boolean().default(false)
});

export const initiateUploadResponseSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("multipart") }),
  z.object({
    mode: z.literal("direct"),
    intentId: z.string().min(1),
    uploadUrl: z.string().url(),
    formFields: z.record(z.string(), z.string()),
    storageKey: z.string().min(1),
    expiresAt: z.string().datetime()
  })
]);

export const completeUploadRequestSchema = z.object({
  intentId: z.string().min(1)
});

export type UserDTO = z.infer<typeof userDtoSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type HologramDTO = z.infer<typeof hologramDtoSchema>;
export type PaginatedHolograms = z.infer<typeof paginatedHologramsSchema>;
export type DeleteHologramResponse = z.infer<typeof deleteHologramResponseSchema>;
export type UsdzStatusResponse = z.infer<typeof usdzStatusResponseSchema>;
export type InitiateUploadRequest = z.infer<typeof initiateUploadRequestSchema>;
export type InitiateUploadResponse = z.infer<typeof initiateUploadResponseSchema>;
export type CompleteUploadRequest = z.infer<typeof completeUploadRequestSchema>;
