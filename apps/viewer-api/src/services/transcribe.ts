import { OBJECT_SEARCH_MAX_QUERY_LENGTH } from "@holoim/contracts";

import { UpstreamError } from "./registry-fetch.js";

/**
 * Voice search (PRD-060 slice 2): one short spoken query, transcribed by
 * Cloudflare Workers AI Whisper. Quest Browser has no Web Speech API, so
 * capture records the mic and the server turns it into a search.
 */

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Workers AI's error code for a used-up daily free allocation. */
const DAILY_ALLOCATION_EXHAUSTED = 3036;

export type TranscriberConfig = {
  apiOrigin: string;
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
};

/** Transcription is not available right now (allowance used up, rate limited); routes answer 503. */
export class TranscriptionUnavailableError extends Error {}

/** Trimmed, one line, at most the search length, without the sentence's closing punctuation. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OBJECT_SEARCH_MAX_QUERY_LENGTH)
    .replace(/[\s.,!?;:…。！？、]+$/u, "")
    .trim();
}

function errorCodes(body: unknown): number[] {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors)
    ? errors.map((entry) => (entry as { code?: unknown })?.code).filter((code): code is number => typeof code === "number")
    : [];
}

export function createTranscriber(config: TranscriberConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.apiOrigin.replace(/\/+$/, "")}/accounts/${encodeURIComponent(config.accountId)}/ai/run/${WHISPER_MODEL}`;

  async function transcribe(audio: Uint8Array): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ audio: Buffer.from(audio).toString("base64"), task: "transcribe", vad_filter: true }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch {
      throw new UpstreamError("Transcription could not be reached.");
    }
    const raw = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = raw.length <= MAX_RESPONSE_BYTES ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (response.status === 429 || errorCodes(body).includes(DAILY_ALLOCATION_EXHAUSTED)) {
      throw new TranscriptionUnavailableError("Voice search has reached today's limit.");
    }
    if (!response.ok) throw new UpstreamError(`Transcription answered ${response.status}.`, response.status);
    const text = (body as { result?: { text?: unknown } } | null)?.result?.text;
    if (typeof text !== "string") throw new UpstreamError("Transcription returned unreadable data.");
    return cleanTranscript(text);
  }

  return { transcribe };
}

export type Transcriber = ReturnType<typeof createTranscriber>;
