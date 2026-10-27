import { z } from "zod";

/**
 * Credit for a model someone else made, carried with it from the tray into
 * every take that redistributes it (PRD-060). It lives outside
 * `HOLOIM_objects`: on the object node's `extras`, under
 * `HOLOIM_CREDIT_EXTRAS_KEY`, and in the GLB's `asset.copyright`, so v0
 * files and readers are unchanged.
 */
export const HOLOIM_CREDIT_EXTRAS_KEY = "holoimCredit";

/** Licences a take may redistribute; everything else is filtered at search time. */
export const objectLicenceSchema = z.enum(["CC0-1.0", "CC-BY-4.0"]);

export const objectCreditSchema = z
  .object({
    /** Registry the model came from, e.g. "Poly Haven". */
    source: z.string().min(1).max(100),
    /** The model's public page on that registry. */
    sourceUrl: z.string().url().max(500),
    title: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    licence: objectLicenceSchema
  })
  .strict();

export type ObjectLicence = z.infer<typeof objectLicenceSchema>;
export type ObjectCredit = z.infer<typeof objectCreditSchema>;

const LICENCE_LABELS: Record<ObjectLicence, string> = {
  "CC0-1.0": "CC0",
  "CC-BY-4.0": "CC BY 4.0"
};

export function licenceLabel(licence: ObjectLicence): string {
  return LICENCE_LABELS[licence];
}

/** One line for `asset.copyright` and captions: “Title” by Author, Source, Licence. */
export function formatCredit(credit: ObjectCredit): string {
  return `“${credit.title}” by ${credit.author}, ${credit.source}, ${licenceLabel(credit.licence)}`;
}

/** Reads a credit from glTF extras (or three.js `userData`); invalid data reads as none. */
export function readCredit(extras: unknown): ObjectCredit | undefined {
  if (!extras || typeof extras !== "object") return undefined;
  const parsed = objectCreditSchema.safeParse((extras as Record<string, unknown>)[HOLOIM_CREDIT_EXTRAS_KEY]);
  return parsed.success ? parsed.data : undefined;
}
