import { z } from "zod";

export const hologramDtoSchema = z.object({
  id: z.string(),
  url: z.string(),
  usdzUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  sizeBytes: z.number().int().nonnegative(),
  filenameOriginal: z.string(),
  hologramName: z.string(),
  submittedBy: z.string()
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

export type HologramDTO = z.infer<typeof hologramDtoSchema>;
export type PaginatedHolograms = z.infer<typeof paginatedHologramsSchema>;
export type DeleteHologramResponse = z.infer<typeof deleteHologramResponseSchema>;
