/**
 * A take open in viewer-web, as a viewer would see it: starts a local test
 * API and a viewer test build on ports away from the defaults, uploads the
 * take through the normal upload route, opens the feed narrowed to that one
 * card and waits until it has rendered. `viewer-check.ts` and `review.ts`
 * both read the take through this.
 *
 * Ports: VIEWER_CHECK_API_PORT (3341) and VIEWER_CHECK_WEB_PORT (3214).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, request, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { XR_CHROMIUM_ARGS, XR_CONTEXT_OPTIONS } from '@holoim/tooling-testing/xr-env';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const API_PORT = Number(process.env.VIEWER_CHECK_API_PORT ?? 3341);
export const WEB_PORT = Number(process.env.VIEWER_CHECK_WEB_PORT ?? 3214);
const WEB = `https://localhost:${WEB_PORT}`;
const API = `http://127.0.0.1:${API_PORT}`;

function start(name: string, command: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const tail: string[] = [];
  const keep = (b: Buffer) => { tail.push(b.toString()); if (tail.length > 40) tail.shift(); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  child.on('exit', (code) => { if (code) console.error(`${name} exited ${code}:\n${tail.join('').slice(-2000)}`); });
  return child;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  // The viewer serves a self-signed certificate for localhost only.
  const client = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    for (;;) {
      try { if ((await client.get(url, { timeout: 5000 })).status() < 500) return; } catch { /* not up yet */ }
      if (Date.now() > until) throw new Error(`timed out waiting for ${url}`);
      await new Promise((r) => setTimeout(r, 500)); // wall-clock: polling a server process that is starting up.
    }
  } finally {
    await client.dispose();
  }
}

const stop = (child: ChildProcess): void => { try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } };

export interface ViewerServers {
  readonly api: string;
  readonly web: string;
  close(): void;
}

/** Starts the test API and the viewer test build; `close()` stops both. */
export async function startViewer(): Promise<ViewerServers> {
  const api = start('api', 'pnpm', ['--filter', '@holoim/api', 'exec', 'tsx', '../../scripts/test-api.ts'], { TEST_API_PORT: String(API_PORT), WEB_ORIGIN: WEB, USDZ_WORKER_ENABLED: 'false' });
  const web = start('web', 'node', ['packages/tooling-testing/src/test-build.mjs', 'serve', 'web', '--', '--host', '0.0.0.0', '--port', String(WEB_PORT), '--strictPort'], { VITE_API_PROXY_TARGET: API, VITE_HMR_CLIENT_PORT: String(WEB_PORT) });
  const close = () => { stop(api); stop(web); };
  try {
    await waitFor(`${API}/api/holograms?limit=1`, 120_000);
    await waitFor(WEB, 240_000);
  } catch (e) { close(); throw e; }
  return { api: API, web: WEB, close };
}

export interface OpenOptions {
  readonly viewport?: { width: number; height: number };
  readonly deviceScaleFactor?: number;
  readonly isMobile?: boolean;
  /** Directory for Playwright's real-time recording (webm), if any. */
  readonly recordVideoDir?: string;
  /** Name shown on the card. */
  readonly title?: string;
}

export interface OpenTake {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly card: Locator;
  readonly id: string;
  /** The uploaded file's URL, the key of the card's test probe. */
  readonly url: string;
  close(): Promise<void>;
}

/** Uploads a take and opens the feed narrowed to its card, rendered and probed. */
export async function openTake(servers: ViewerServers, file: string, options: OpenOptions = {}): Promise<OpenTake> {
  const glb = await readFile(file);
  const viewport = options.viewport ?? { width: 900, height: 900 };
  const browser = await chromium.launch({ headless: true, args: [...XR_CHROMIUM_ARGS] });
  const context = await browser.newContext({
    ...XR_CONTEXT_OPTIONS, baseURL: servers.web, viewport,
    ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
    ...(options.isMobile ? { isMobile: true, hasTouch: true } : {}),
    ...(options.recordVideoDir ? { recordVideo: { dir: options.recordVideoDir, size: viewport } } : {})
  });
  const page = await context.newPage();
  // tsx keeps function names with an `__name` helper, which page functions then call.
  await page.addInitScript('globalThis.__name = (f) => f;');
  await page.addInitScript(() => {
    const hooks = window as unknown as { __feedProbes?: Record<string, unknown>; __HOLOIM_FEED_TEST_OBSERVER__?: (p: { url: string }) => void };
    hooks.__feedProbes = {};
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (p) => { hooks.__feedProbes![p.url] = p; };
  });
  const response = await page.request.post('/api/holograms', {
    multipart: { hologramName: options.title ?? basename(file, '.glb'), submittedBy: 'directed-performance', file: { name: basename(file), mimeType: 'model/gltf-binary', buffer: glb } }
  });
  if (!response.ok()) throw new Error(`upload: ${response.status()} ${await response.text()}`);
  const uploaded = (await response.json()) as { id: string; url: string };
  await page.route('**/api/holograms?*', async (route) => {
    const r = await route.fetch();
    const body = (await r.json()) as { items: { id: string }[] };
    await route.fulfill({ response: r, json: { ...body, items: body.items.filter((i) => i.id === uploaded.id), nextCursor: null } });
  });
  await page.goto('/');
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await card.waitFor({ timeout: 60_000 });
  await page.waitForFunction((id) => document.querySelector(`.feed-card[data-card-id="${id}"]`)?.getAttribute('data-model-state') === 'rendered', uploaded.id, { timeout: 60_000 });
  await page.waitForFunction((u) => Object.keys((window as unknown as { __feedProbes: Record<string, unknown> }).__feedProbes).some((k) => k.endsWith(u)), uploaded.url, { timeout: 30_000 });
  return {
    browser, context, page, card, id: uploaded.id, url: uploaded.url,
    close: async () => { await context.close(); await browser.close(); }
  };
}

/** Runs `fn` with the servers up, and always stops them. */
export async function withViewer<T>(fn: (servers: ViewerServers) => Promise<T>): Promise<T> {
  const servers = await startViewer();
  try { return await fn(servers); } finally { servers.close(); }
}

export async function tempDir(prefix: string): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}
