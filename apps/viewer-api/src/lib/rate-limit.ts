import type { FastifyRequest } from "fastify";

/**
 * Fly's proxy overwrites Fly-Client-IP with the real client, so it is trusted
 * only on Fly (FLY_APP_NAME is set on every Fly machine); elsewhere a client
 * could send any value, so the socket address is the client.
 */
export function clientKey(request: FastifyRequest, behindFly: boolean): string {
  const forwarded = request.headers["fly-client-ip"];
  return behindFly && typeof forwarded === "string" && forwarded.length > 0 ? forwarded : request.ip;
}

/**
 * A fixed-window counter per key, kept in memory (one machine serves the API).
 * Returns null while the key is under its limit, else the seconds until its window ends.
 */
export function createRateLimit(perWindow: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string, now = Date.now()): number | null => {
    if (windows.size > 10_000) {
      for (const [entry, value] of windows) if (now - value.start >= windowMs) windows.delete(entry);
    }
    const current = windows.get(key);
    if (!current || now - current.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return null;
    }
    if (current.count >= perWindow) return Math.ceil((current.start + windowMs - now) / 1000);
    current.count += 1;
    return null;
  };
}
