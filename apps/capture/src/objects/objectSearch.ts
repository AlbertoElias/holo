import { OBJECT_TRANSCRIBE_MAX_BYTES, type ObjectSearchResult, objectSearchResponseSchema, objectTranscribeResponseSchema } from '@holoim/contracts';

/** The API origin; empty means same-origin, which the dev and preview servers proxy to `viewer-api`. */
export const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN ?? '';
const apiBase = `${API_ORIGIN}/api`;

async function failure(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return new Error(typeof body?.message === 'string' ? body.message : `${fallback} (${response.status}).`);
}

/** Registry search through `viewer-api` (PRD-060): at most six models a take may redistribute. */
export async function searchObjects(q: string, signal?: AbortSignal | null): Promise<ObjectSearchResult[]> {
  const response = await fetch(`${apiBase}/objects/search?q=${encodeURIComponent(q)}`, { signal: signal ?? null });
  if (!response.ok) throw await failure(response, 'Search failed');
  return objectSearchResponseSchema.parse(await response.json()).results;
}

/** A transcription the server cannot make (not configured, upstream down): the caller falls back to typing. */
export class TranscribeUnavailableError extends Error {}

/** One spoken query, recorded push to talk, transcribed by `viewer-api` (PRD-060 slice 2). */
export async function transcribeQuery(audio: Blob, signal?: AbortSignal | null): Promise<string> {
  if (audio.size > OBJECT_TRANSCRIBE_MAX_BYTES) throw new Error('That was too long to hear; try a shorter phrase.');
  const response = await fetch(`${apiBase}/objects/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'application/octet-stream' },
    body: audio,
    signal: signal ?? null
  });
  if (response.status === 503 || response.status >= 500) throw new TranscribeUnavailableError((await failure(response, 'Voice search is unavailable')).message);
  if (!response.ok) throw await failure(response, 'Could not hear that');
  return objectTranscribeResponseSchema.parse(await response.json()).text;
}

/** Where capture fetches a result's packed, credited GLB. */
export function objectGlbUrl(result: ObjectSearchResult): string {
  return `${API_ORIGIN}${result.glbPath}`;
}

// Toward instant summoning: the top result's GLB is fetched as soon as
// results arrive, so a pick loads from memory. A few are kept; a failed
// prefetch is forgotten and the pick fetches again, with its own message.
const PREFETCH_KEEP = 4;
const prefetched = new Map<string, Promise<ArrayBuffer>>();
/** Prefetches started and picks served from them, for the summon check's report. */
export const prefetchStats = { started: 0, hits: 0 };

export function prefetchObjectGlb(url: string): void {
  if (prefetched.has(url)) return;
  prefetchStats.started += 1;
  const bytes = fetch(url).then((response) => {
    if (!response.ok) throw new Error(`prefetch ${response.status}`);
    return response.arrayBuffer();
  });
  bytes.catch(() => prefetched.delete(url));
  prefetched.set(url, bytes);
  while (prefetched.size > PREFETCH_KEEP) prefetched.delete(prefetched.keys().next().value!);
}

/** A prefetched GLB's bytes, taken (a tray item owns its buffer), or null. */
export async function takePrefetchedGlb(url: string): Promise<ArrayBuffer | null> {
  const bytes = prefetched.get(url);
  if (!bytes) return null;
  prefetched.delete(url);
  const taken = await bytes.catch(() => null);
  if (taken) prefetchStats.hits += 1;
  return taken;
}

/** Whether a URL's GLB is waiting in the prefetch cache (for checks). */
export function isPrefetched(url: string): boolean {
  return prefetched.has(url);
}
