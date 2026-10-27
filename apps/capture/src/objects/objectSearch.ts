import { type ObjectSearchResult, objectSearchResponseSchema } from '@holoim/contracts';

/** The API origin; empty means same-origin, which the dev and preview servers proxy to `viewer-api`. */
export const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN ?? '';
const apiBase = `${API_ORIGIN}/api`;

/** Registry search through `viewer-api` (PRD-060): at most six models a take may redistribute. */
export async function searchObjects(q: string, signal?: AbortSignal | null): Promise<ObjectSearchResult[]> {
  const response = await fetch(`${apiBase}/objects/search?q=${encodeURIComponent(q)}`, { signal: signal ?? null });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    throw new Error(typeof body?.message === 'string' ? body.message : `Search failed (${response.status}).`);
  }
  return objectSearchResponseSchema.parse(await response.json()).results;
}

/** Where capture fetches a result's packed, credited GLB. */
export function objectGlbUrl(result: ObjectSearchResult): string {
  return `${API_ORIGIN}${result.glbPath}`;
}
