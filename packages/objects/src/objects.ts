import { z } from "zod";

/** Name of the root glTF extension. List it in `extensionsUsed` only, never `extensionsRequired`. */
export const HOLOIM_OBJECTS_EXTENSION = "HOLOIM_objects";
export const HOLOIM_OBJECTS_VERSION = 0;

/** Name of every exported object's wrapper node; the extension maps them by index. */
export const RECORDED_OBJECT_NODE_NAME = "RecordedObject";

const finite = z.number().finite();
const nodeIndex = z.number().int().nonnegative();

export const objectSpanSchema = z
  .object({
    /** Seconds from the first frame. */
    start: finite.nonnegative(),
    end: finite.nonnegative()
  })
  .strict()
  .refine((span) => span.end >= span.start, { message: "span.end must not precede span.start" });

export const objectHoldSchema = z
  .object({
    hand: z.enum(["left", "right"]),
    start: finite.nonnegative(),
    end: finite.nonnegative()
  })
  .strict()
  .refine((hold) => hold.end >= hold.start, { message: "hold.end must not precede hold.start" });

/**
 * Where the model came from, as a display name and content hash only: a URL
 * can be signed or local, and the GLB is shared.
 */
export const objectSourceSchema = z
  .object({
    name: z.string().min(1).max(200),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional()
  })
  .strict();

/**
 * One object in the event. `origin` says how it entered: `prepared` objects
 * are in the scene before the take; `summoned` ones are placed during it.
 * The object exists only during its `presence` spans; its wrapper node's
 * STEP scale track is 0 outside them.
 */
export const recordedObjectSchema = z
  .object({
    node: nodeIndex,
    name: z.string().min(1).max(200),
    origin: z.enum(["prepared", "summoned"]),
    source: objectSourceSchema,
    presence: z.array(objectSpanSchema).min(1),
    holds: z.array(objectHoldSchema)
  })
  .strict();

/** Version 0 is exact: a future version must bump `version`, so unknown keys are rejected. */
export const holoimObjectsSchema = z
  .object({
    version: z.literal(HOLOIM_OBJECTS_VERSION),
    objects: z.array(recordedObjectSchema).min(1)
  })
  .strict();

export type ObjectSpan = z.infer<typeof objectSpanSchema>;
export type ObjectHold = z.infer<typeof objectHoldSchema>;
export type ObjectSource = z.infer<typeof objectSourceSchema>;
export type RecordedObjectEntry = z.infer<typeof recordedObjectSchema>;
export type HoloimObjects = z.infer<typeof holoimObjectsSchema>;

export type ObjectsValidationResult =
  | { ok: true; value: HoloimObjects }
  | { ok: false; errors: string[] };

/** Validates an untrusted `extensions.HOLOIM_objects` value read from a GLB. */
export function validateHoloimObjects(input: unknown): ObjectsValidationResult {
  const result = holoimObjectsSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
  };
}

/** Throwing variant for writers asserting their own output. */
export function assertHoloimObjects(input: unknown): HoloimObjects {
  const result = validateHoloimObjects(input);
  if (!result.ok) throw new Error(`Invalid ${HOLOIM_OBJECTS_EXTENSION}: ${result.errors.join("; ")}`);
  return result.value;
}
