// Shared helpers for the UI inventory capture scripts. They start the app's
// own Vite dev server on a private port, drive it with Playwright (IWER for
// XR), and write JPEG screenshots plus a manifest of what each one shows.
/* global console, process, setTimeout */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startViteDevServer, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const inventoryDir = path.join(workspaceRoot, 'docs/product/design/inventory');

// Playwright is a dependency of the apps, not of the workspace root.
export async function loadPlaywright() {
  const require = createRequire(path.join(workspaceRoot, 'apps/capture/package.json'));
  const playwright = await import(require.resolve('playwright'));
  return playwright.default ?? playwright;
}

export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
const MAX_BYTES = 230_000;

export async function startApp({ app, port, env = {} }) {
  const cwd = path.join(workspaceRoot, 'apps', app);
  const server = startViteDevServer({ host: '0.0.0.0', port, cwd, env: { ...process.env, ...env } });
  process.once('exit', () => server.kill());
  const baseUrl = `https://localhost:${port}/`;
  // The readiness probe hits the local dev server's self-signed certificate,
  // as in apps/capture/scripts/run-xr-checks.mjs.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  await waitForServer(baseUrl, 120_000, server);
  return { baseUrl, stop: () => stopProcess(server) };
}

/**
 * Records screenshots for one app. `shot` writes `<dir>/<name>.jpg` and keeps
 * the metadata the README table is built from.
 */
export function createRecorder(app) {
  const dir = path.join(inventoryDir, app);
  const entries = [];
  return {
    entries,
    async shot(page, name, meta, { fullPage = false, clip } = {}) {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${name}.jpg`);
      for (const quality of [72, 60, 48, 38]) {
        await page.screenshot({ path: file, type: 'jpeg', quality, fullPage, clip, animations: 'allow' });
        if ((await stat(file)).size <= MAX_BYTES) break;
      }
      const size = (await stat(file)).size;
      entries.push({ app, file: `${app}/${name}.jpg`, bytes: size, ...meta });
      console.log(`  ${app}/${name}.jpg ${(size / 1024).toFixed(0)} KB`);
      await this.save();
    },
    // Merges into the existing manifest, so a partial run (INVENTORY_ONLY)
    // replaces only the screenshots it took.
    async save() {
      const manifestPath = path.join(dir, 'manifest.json');
      const previous = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '[]'));
      const taken = new Set(entries.map((entry) => entry.file));
      const merged = [...previous.filter((entry) => !taken.has(entry.file)), ...entries];
      await writeFile(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
    }
  };
}

/** Whether a section runs: all by default, or those named in INVENTORY_ONLY. */
export function runs(section) {
  const only = process.env.INVENTORY_ONLY;
  return !only || only.split(',').includes(section);
}

/** A locator's box grown by `pad` pixels, for clipped screenshots. */
export async function paddedBox(locator, pad = 16) {
  const box = await locator.boundingBox();
  const viewport = locator.page().viewportSize();
  const x = Math.max(0, box.x - pad); const y = Math.max(0, box.y - pad);
  return { x, y, width: Math.min(viewport.width - x, box.width + pad * 2), height: Math.min(viewport.height - y, box.height + pad * 2) };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
