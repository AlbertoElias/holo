/**
 * What every object registry (PRD-060) shares: the errors routes map to
 * status codes, the checks that keep a model the tray would refuse out of the
 * results, and a fetch that only reaches allowed hosts and caps every body.
 */

/** Same ceiling as capture's MAX_SUPPLIED_OBJECT_BYTES: a result the tray would refuse is never offered. */
export const MAX_PACKED_OBJECT_BYTES = 8 * 1024 * 1024;
/** Source files may be a little larger than the packed GLB (jpg stays jpg, but JSON/padding differ). */
export const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
export const USER_AGENT = "HoloIM object search (+https://github.com/holoim; contact via repository issues)";
const COMPRESSION_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_mesh_quantization",
  "KHR_texture_basisu"
]);

/** The registry or the network misbehaved; routes answer 502. `status` is the registry's HTTP status, when it answered. */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}
/** The id is not a model in the registry; routes answer 404. */
export class UnknownObjectError extends Error {}
/** The packed GLB is larger than the tray accepts; routes answer 422. */
export class ObjectTooLargeError extends Error {}

/** Why capture would refuse this glTF as an object, or null; mirrors checkSuppliedGlb. */
export function unsupportedReason(json: Record<string, unknown>): string | null {
  const used = Array.isArray(json.extensionsUsed) ? (json.extensionsUsed as string[]) : [];
  const required = Array.isArray(json.extensionsRequired) ? (json.extensionsRequired as string[]) : [];
  if (required.length > 0 || used.some((name) => COMPRESSION_EXTENSIONS.has(name))) {
    return "This model uses compression the tray cannot read.";
  }
  if (Array.isArray(json.skins) && json.skins.length > 0) return "Skinned (rigged) models are not supported as objects.";
  return null;
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function singleFlight<T>(inflight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = run().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type RegistryFetchConfig = {
  /** Display name used in error messages, e.g. "Poly Haven". */
  name: string;
  allowedHosts: Iterable<string>;
  fetchImpl?: typeof fetch | undefined;
  /** Extra request headers, sent only to the allowed hosts. */
  headers?: Record<string, string>;
};

export function createRegistryFetch(config: RegistryFetchConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const name = config.name;
  const allowedHosts = new Set([...config.allowedHosts].map((host) => host.toLowerCase()));

  /** SSRF guard: only the allowed hosts, over https (http only for loopback). */
  function checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new UpstreamError(`${name} returned an invalid file URL.`);
    }
    const hostname = url.hostname.toLowerCase();
    const secure = url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(hostname));
    if (!secure || !allowedHosts.has(hostname)) {
      throw new UpstreamError(`${name} pointed at a file host that is not allowed.`);
    }
    return url;
  }

  function isAllowedUrl(raw: string): boolean {
    try {
      checkUrl(raw);
      return true;
    } catch {
      return false;
    }
  }

  async function request(raw: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    let url = checkUrl(raw);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { "user-agent": USER_AGENT, ...config.headers },
          redirect: "manual",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
      } catch {
        throw new UpstreamError(`${name} could not be reached.`);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new UpstreamError(`${name} sent a bad redirect.`);
        url = checkUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamError(`${name} answered ${response.status}.`, response.status);
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new UpstreamError(`A ${name} file is larger than allowed.`);
      try {
        return await readCapped(response, maxBytes, name);
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError(`${name} could not be reached.`);
      }
    }
    throw new UpstreamError(`${name} redirected too many times.`);
  }

  async function requestJson(raw: string): Promise<unknown> {
    const body = await request(raw, MAX_DOWNLOAD_BYTES);
    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new UpstreamError(`${name} returned unreadable data.`);
    }
  }

  return { checkUrl, isAllowedUrl, request, requestJson };
}

/** Reads a body, cancelling it as soon as it passes `maxBytes` (a missing or false Content-Length cannot run it past the cap). */
async function readCapped(response: Response, maxBytes: number, name: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError(`A ${name} file is larger than allowed.`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
