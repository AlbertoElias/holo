import { z } from "zod";

import { VRM_HUMANOID_BONES } from "./humanoid.js";

/** Name of the root glTF extension. List it in `extensionsUsed` only, never `extensionsRequired`. */
export const HOLOIM_MEANING_EXTENSION = "HOLOIM_meaning";
/**
 * Every version a reader accepts. A file's `version` is a feature level: the
 * lowest level whose exact schema accepts it (see `encodeHoloimMeaning`).
 */
export const HOLOIM_MEANING_VERSIONS = [0, 1] as const;
export const HOLOIM_MEANING_LATEST_VERSION = 1;

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

/** A performer's bone. The only `from` form of v0. */
export const meaningLinkBoneFromSchema = z
  .object({ bone: boneName, node: nodeIndex })
  .strict();

/**
 * The author's camera (v1): `node` is the take's author camera node.
 *
 * Growth rule: each new kind of author presence is another exclusive sibling
 * form, marked by its own literal key, added under a version bump. Every form
 * keeps `node`, so a reader that knows no forms can still draw from the node.
 */
export const meaningLinkCameraFromSchema = z
  .object({ camera: z.literal(true), node: nodeIndex })
  .strict();

/** The v1 `from`: exactly one of the exclusive forms. */
export const meaningLinkFromSchema = z.union([meaningLinkBoneFromSchema, meaningLinkCameraFromSchema]);

export const meaningLinkToSchema = z
  .object({
    node: nodeIndex,
    bone: boneName.optional(),
    point: point.optional(),
    /** Only for hits on large undivided geometry (floor, walls). */
    radius: finite.positive().optional()
  })
  .strict();

const linkAnchor = <From extends z.ZodTypeAny>(from: From) => z.object({ from, to: meaningLinkToSchema }).strict();

/** v0 link: the performer's bone only. */
export const meaningLinkMarkV0Schema = z
  .object({
    kind: z.literal("link"),
    anchor: linkAnchor(meaningLinkBoneFromSchema),
    span: meaningSpanSchema,
    provenance: meaningLinkProvenanceSchema
  })
  .strict();

/** v1 link: bone or camera `from`. Nothing infers from a camera, so a camera link must be recorded. */
export const meaningLinkMarkSchema = z
  .object({
    kind: z.literal("link"),
    anchor: linkAnchor(meaningLinkFromSchema),
    span: meaningSpanSchema,
    provenance: meaningLinkProvenanceSchema
  })
  .strict()
  .refine((mark) => !("camera" in mark.anchor.from) || mark.provenance.value === "recorded", {
    message: "a link from the camera must have recorded provenance",
    path: ["provenance"]
  });

export const meaningMotionSpanSchema = z
  .object({
    kind: z.literal("motion"),
    bones: z.array(boneName).min(1),
    span: meaningSpanSchema,
    provenance: meaningProvenanceSchema
  })
  .strict();

/** Version 0 is exact: a future version must bump `version`, so unknown keys and kinds are rejected. */
export const holoimMeaningV0Schema = z
  .object({
    version: z.literal(0),
    marks: z.array(meaningLinkMarkV0Schema),
    spans: z.array(meaningMotionSpanSchema)
  })
  .strict();

/** Version 1 is exact too: v0 plus the camera form of a link's `from`. */
export const holoimMeaningV1Schema = z
  .object({
    version: z.literal(1),
    marks: z.array(meaningLinkMarkSchema),
    spans: z.array(meaningMotionSpanSchema)
  })
  .strict();

export type MeaningSpan = z.infer<typeof meaningSpanSchema>;
export type MeaningProvenance = z.infer<typeof meaningProvenanceSchema>;
export type MeaningLinkProvenance = z.infer<typeof meaningLinkProvenanceSchema>;
export type MeaningLinkBoneFrom = z.infer<typeof meaningLinkBoneFromSchema>;
export type MeaningLinkCameraFrom = z.infer<typeof meaningLinkCameraFromSchema>;
export type MeaningLinkFrom = MeaningLinkBoneFrom | MeaningLinkCameraFrom;
export type MeaningLinkTo = z.infer<typeof meaningLinkToSchema>;
export type MeaningLinkMark = z.infer<typeof meaningLinkMarkSchema>;
export type MeaningMotionSpan = z.infer<typeof meaningMotionSpanSchema>;
export type HoloimMeaningV0 = z.infer<typeof holoimMeaningV0Schema>;
export type HoloimMeaningV1 = z.infer<typeof holoimMeaningV1Schema>;
/** What readers return: any supported version. */
export type HoloimMeaning = HoloimMeaningV0 | HoloimMeaningV1;

export function isCameraFrom(from: MeaningLinkFrom): from is MeaningLinkCameraFrom {
  return "camera" in from;
}

/** What a `from` is named in reports: the bone's name, or `camera`. */
export function meaningFromLabel(from: MeaningLinkFrom): string {
  return isCameraFrom(from) ? "camera" : from.bone;
}

export type MeaningValidationResult =
  | { ok: true; value: HoloimMeaning }
  | { ok: false; errors: string[] };

const formatIssues = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);

/**
 * Validates an untrusted `extensions.HOLOIM_meaning` value read from a GLB.
 * Dispatches on `version` to that version's exact schema, so a v0 record
 * comes back unchanged and a v0 file with a v1-only key is still rejected.
 */
export function validateHoloimMeaning(input: unknown): MeaningValidationResult {
  const version =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as { version?: unknown }).version
      : undefined;
  const schema = version === 0 ? holoimMeaningV0Schema : version === 1 ? holoimMeaningV1Schema : undefined;
  if (!schema) {
    return {
      ok: false,
      errors: [
        `version: unsupported ${HOLOIM_MEANING_EXTENSION} version ${JSON.stringify(version) ?? "(missing)"}; supported versions are ${HOLOIM_MEANING_VERSIONS.join(", ")}`
      ]
    };
  }
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: formatIssues(result.error) };
}

/** Throwing variant for writers asserting their own output (any supported version). */
export function assertHoloimMeaning(input: unknown): HoloimMeaning {
  const result = validateHoloimMeaning(input);
  if (!result.ok) throw new Error(`Invalid ${HOLOIM_MEANING_EXTENSION}: ${result.errors.join("; ")}`);
  return result.value;
}

/**
 * Writer rule: the version is a feature level. Returns the record at the
 * lowest version whose exact schema accepts it (v0 when it passes, else v1),
 * so takes that need no newer feature stay readable by older viewers. Throws
 * with the newest schema's errors when no version accepts it.
 */
export function encodeHoloimMeaning(record: { marks: MeaningLinkMark[]; spans: MeaningMotionSpan[] }): HoloimMeaning {
  const v0 = holoimMeaningV0Schema.safeParse({ version: 0, marks: record.marks, spans: record.spans });
  if (v0.success) return v0.data;
  const v1 = holoimMeaningV1Schema.safeParse({ version: 1, marks: record.marks, spans: record.spans });
  if (v1.success) return v1.data;
  throw new Error(`Invalid ${HOLOIM_MEANING_EXTENSION}: ${formatIssues(v1.error).join("; ")}`);
}
