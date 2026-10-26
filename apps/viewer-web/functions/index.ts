/**
 * Cloudflare Pages Function for "/": puts the feed's first page into the
 * HTML, with a preload for the newest hologram, so a first visit knows what
 * to fetch without waiting for the API to wake
 * (docs/features/snappy-feed-first-load.md). The API rewrites the snapshot
 * in R2 after every upload and delete; the app still asks the API and
 * replaces these items when it answers. Any failure serves the page as is.
 */

// Only what this function uses of the Workers runtime.
type R2Bucket = { get(key: string): Promise<{ text(): Promise<string> } | null> };
type Env = { MEDIA?: R2Bucket };
type PagesContext = { request: Request; env: Env; next: (input?: Request) => Promise<Response> };
declare class HTMLRewriter {
  on(selector: string, handlers: { element(element: { prepend(content: string, options: { html: boolean }): void }): void }): HTMLRewriter;
  transform(response: Response): Response;
}

const FEED_SNAPSHOT_KEY = "feed/latest.json";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function readSnapshot(env: Env): Promise<{ json: string; newestUrl: string | null } | null> {
  if (!env.MEDIA) return null;
  try {
    const object = await env.MEDIA.get(FEED_SNAPSHOT_KEY);
    if (!object) return null;
    const json = await object.text();
    const parsed = JSON.parse(json) as { items?: { url?: unknown }[] };
    if (!Array.isArray(parsed.items)) return null;
    const newestUrl = parsed.items[0]?.url;
    return { json, newestUrl: typeof newestUrl === "string" ? newestUrl : null };
  } catch {
    return null;
  }
}

export async function onRequestGet({ request, env, next }: PagesContext): Promise<Response> {
  // The page changes with every upload, so never answer from a validator the browser kept.
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  const [page, snapshot] = await Promise.all([next(new Request(request.url, { headers })), readSnapshot(env)]);
  if (!snapshot || !page.ok || !(page.headers.get("content-type") ?? "").includes("text/html")) return page;

  // GLTFLoader fetches in cors mode without credentials: the preload must match to be reused.
  const preload = snapshot.newestUrl
    ? `<link rel="preload" href="${escapeAttribute(snapshot.newestUrl)}" as="fetch" crossorigin="anonymous">`
    : "";
  const script = `<script>window.__HOLOIM_FEED__=${snapshot.json.replace(/</g, "\\u003c")};</script>`;
  const rewritten = new HTMLRewriter()
    .on("head", { element: (head) => head.prepend(preload + script, { html: true }) })
    .transform(page);
  const out = new Headers(rewritten.headers);
  out.delete("etag");
  out.set("cache-control", "no-cache");
  return new Response(rewritten.body, { status: rewritten.status, headers: out });
}
