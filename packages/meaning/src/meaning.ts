import { z } from "zod";

import { VRM_HUMANOID_BONES } from "./humanoid.js";

/** Name of the root glTF extension. List it in `extensionsUsed` only, never `extensionsRequired`. */
export const HOLOIM_MEANING_EXTENSION = "HOLOIM_meaning";
export const HOLOIM_MEANING_VERSION = 0;

const finite = z.number().finite();
const nodeIndex = z.number().int().nonnegative();
const boneName = z.enum(VRM_HUMANOID_BONES);
/** Local to the anchor's node or bone. */
const point = z.tuple([finite, finite, finite]);

export const meaningSpanSchema = z
  .object({
    /** Seconds from the first frame. */
    start: finite.nonnegative(),
    end: finite.nonnegative()
  })
  .strict()
  .refine((span) => span.end >= span.start, { message: "span.end must not precede span.start" });

const recordedProvenance = z.object({ value: z.literal("recorded") }).strict();

/** In (0, 1]. */
const confidence = finite.positive().max(1);

/** A link that was inferred must say how sure the inference was. */
export const meaningLinkProvenanceSchema = z.discriminatedUnion("value", [
  recordedProvenance,
  z.object({ value: z.literal("inferred"), confidence }).strict()
]);

/** Motion spans may be inferred without a confidence. */
export const meaningProvenanceSchema = z.discriminatedUnion("value", [
  recordedProvenance,
  z.object({ value: z.literal("inferred"), confidence: confidence.optional() }).strict()
]);

export const meaningLinkFromSchema = z
  .object({ bone: boneName, node: nodeIndex })
  .strict();

export const meaningLinkToSchema = z
  .object({
    node: nodeIndex,
    bone: boneName.optional(),
    point: point.optional(),
    /** Only for hits on large undivided geometry (floor, walls). */
    radius: finite.positive().optional()
  })
  .strict();

export const meaningLinkMarkSchema = z
  .object({
    kind: z.literal("link"),
    anchor: z.object({ from: meaningLinkFromSchema, to: meaningLinkToSchema }).strict(),
    span: meaningSpanSchema,
    provenance: meaningLinkProvenanceSchema
  })
  .strict();

export const meaningMotionSpanSchema = z
  .object({
    kind: z.literal("motion"),
    bones: z.array(boneName).min(1),
    span: meaningSpanSchema,
    provenance: meaningProvenanceSchema
  })
  .strict();

/** Version 0 is exact: a future version must bump `version`, so unknown keys and kinds are rejected. */
export const holoimMeaningSchema = z
  .object({
    version: z.literal(HOLOIM_MEANING_VERSION),
    marks: z.array(meaningLinkMarkSchema),
    spans: z.array(meaningMotionSpanSchema)
  })
  .strict();

export type MeaningSpan = z.infer<typeof meaningSpanSchema>;
export type MeaningProvenance = z.infer<typeof meaningProvenanceSchema>;
export type MeaningLinkProvenance = z.infer<typeof meaningLinkProvenanceSchema>;
export type MeaningLinkFrom = z.infer<typeof meaningLinkFromSchema>;
export type MeaningLinkTo = z.infer<typeof meaningLinkToSchema>;
export type MeaningLinkMark = z.infer<typeof meaningLinkMarkSchema>;
export type MeaningMotionSpan = z.infer<typeof meaningMotionSpanSchema>;
export type HoloimMeaning = z.infer<typeof holoimMeaningSchema>;

export type MeaningValidationResult =
  | { ok: true; value: HoloimMeaning }
  | { ok: false; errors: string[] };

/** Validates an untrusted `extensions.HOLOIM_meaning` value read from a GLB. */
export function validateHoloimMeaning(input: unknown): MeaningValidationResult {
  const result = holoimMeaningSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
  };
}

/** Throwing variant for writers asserting their own output. */
export function assertHoloimMeaning(input: unknown): HoloimMeaning {
  const result = validateHoloimMeaning(input);
  if (!result.ok) throw new Error(`Invalid ${HOLOIM_MEANING_EXTENSION}: ${result.errors.join("; ")}`);
  return result.value;
}
