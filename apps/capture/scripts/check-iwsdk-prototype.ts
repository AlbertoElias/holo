import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page, type ConsoleMessage } from 'playwright';
import { startViteDevServer, stopProcess, waitForServer } from '@holoim/tooling-testing/dev-server';
import { attachXrEnvironment, createXrContext, enterIwerSessionFromButton, launchXrBrowser, waitForTextContentPrefix, wireXrConsoleErrors } from '@holoim/tooling-testing/xr-env';
import type {} from '../src/prototype/main';
import type { AppOrchestrator } from '../src/app/AppOrchestrator';

type Snapshot = ReturnType<AppOrchestrator['getSimulationSnapshot']>;
const port = Number(process.env.DEV_PORT ?? 5474);
const baseUrl = `https://127.0.0.1:${port}`;
const output = path.resolve('output/iwsdk-prototype');
await mkdir(output, { recursive: true });
await rm(path.join(output, 'failure.png'), { force: true });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const server = startViteDevServer({ host: '127.0.0.1', port });
let browser: Browser | undefined;
let activePage: Page | undefined;
const errors: string[] = [];
const deadline = setTimeout(() => { void browser?.close().catch(() => undefined); }, 180_000);
deadline.unref();
const evidence: Record<string, unknown> = { sdk: '1.0.1', classification: 'IWER compatibility; no headset performance measurement' };
try {
  await waitForServer(baseUrl, 60_000, server);
  browser = await launchXrBrowser(chromium);
  const context = await createXrContext(browser, { viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);
  activePage = page;
  page.on('pageerror', (error: Error) => console.error(error.message));
  page.on('console', (message: ConsoleMessage) => { if (message.type() === 'error') console.error(message.text()); });
  wireXrConsoleErrors(page, errors);
  await attachXrEnvironment(page, { mode: 'iwer' });
  await page.goto(`${baseUrl}/iwsdk-prototype.html`, { waitUntil: 'networkidle' });
  assert.deepEqual(errors, [], 'startup browser errors');
  await waitForTextContentPrefix(page, '#status', 'loaded', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__iwsdkPrototype));
  const snapshot = (): Promise<Snapshot> => page.evaluate(() => window.__iwsdkPrototype!.snapshot());
  const call = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => page.evaluate(async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
    const runtime = window.FRAMEWORK_MCP_RUNTIME;
    if (!runtime?.handles(method)) throw new Error(`Native framework method unavailable: ${method}`);
    return runtime.dispatch(method, params);
  }, { method, params }) as Promise<T>;

  // The native bridge, not a bespoke imitation, must discover HoloIM state.
  evidence.systems = await call('ecs_list_systems');
  const entities = await call<{ entities: Array<{ entityIndex: number }> }>('ecs_find_entities', { withComponents: ['CaptureState'] });
  assert.equal(entities.entities.length, 1);
  evidence.entity = await call('ecs_query_entity', { entityIndex: entities.entities[0]!.entityIndex });

  await page.getByRole('button', { name: 'Start Recording' }).click();
  await page.getByRole('button', { name: 'Stop Recording' }).waitFor();
  await page.waitForFunction(() => (window.__iwsdkPrototype?.snapshot().recordedFrames ?? 0) > 3);
  await call('ecs_pause');
  const paused = await snapshot();
  await page.waitForTimeout(200);
  assert.deepEqual(await snapshot(), paused, 'native pause must freeze simulation AND recorded frames');
  await call('ecs_snapshot', { label: 'before-step' });
  await call('ecs_step', { count: 1, delta: 1 / 60 });
  const stepped = await snapshot();
  assert.equal(stepped.steps, paused.steps + 1);
  assert.equal(stepped.recordedFrames, paused.recordedFrames + 1);
  assert.ok(Math.abs(stepped.elapsedSec - paused.elapsedSec - 1 / 60) < 1e-8);
  assert.ok(Math.abs(stepped.lastRecordedTimeSec! - paused.lastRecordedTimeSec! - 1 / 60) < 1e-8);
  await call('ecs_snapshot', { label: 'after-step' });
  evidence.diff = await call('ecs_diff', { from: 'before-step', to: 'after-step' });
  evidence.pause = { paused, stepped };

  // Movement under repeated native steps must affect the real character.
  await page.evaluate(() => {
    const hooks = window as unknown as Window & { __setMockInput: (input: { forward: boolean }) => void };
    hooks.__setMockInput({ forward: true });
  });
  await call('ecs_step', { count: 45, delta: 1 / 60 });
  const moved = await snapshot();
  assert.ok(Math.hypot(moved.x - stepped.x, moved.z - stepped.z) > 0.1, 'native steps must move the character');
  evidence.movement = { before: stepped, after: moved };
  await page.evaluate(() => {
    const hooks = window as unknown as Window & { __setMockInput: (input: { forward: boolean }) => void };
    hooks.__setMockInput({ forward: false });
  });
  await call('ecs_resume');
  await page.waitForFunction((steps: number) => window.__iwsdkPrototype!.snapshot().steps > steps, moved.steps);
  const resumed = await snapshot();
  assert.ok(resumed.elapsedSec - moved.elapsedSec < 0.2, 'resume must not accumulate paused wall-clock time');
  evidence.resumed = resumed;
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Stop Recording' }).click();
  const download = await downloaded;
  const glbPath = path.join(output, 'prototype-recording.glb');
  await download.saveAs(glbPath);
  const bytes = await readFile(glbPath);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  const gltf = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as { animations?: unknown[]; skins?: unknown[] };
  assert.ok(gltf.animations?.length);
  assert.ok(gltf.skins?.length);
  evidence.export = { bytes: bytes.length, animations: gltf.animations.length, skins: gltf.skins.length };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  await page.setViewportSize({ width: 640, height: 360 });

  // Use SDK lifecycle with capture's existing tracked-hand/rig boundary.
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => window.__iwsdkPrototype!.snapshot().mode === 'vr' });
  evidence.xrEntered = await snapshot();
  await page.screenshot({ path: path.join(output, 'xr.png') });
  await page.locator('#VRButton').evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForFunction(() => window.__iwsdkPrototype!.snapshot().mode === 'desktop-third');
  await enterIwerSessionFromButton(page, '#VRButton', { readyCheck: () => window.__iwsdkPrototype!.snapshot().mode === 'vr' });
  evidence.xrReentered = await snapshot();
  await page.locator('#VRButton').evaluate((button: HTMLButtonElement) => button.click());
  await page.waitForFunction(() => window.__iwsdkPrototype!.snapshot().mode === 'desktop-third');
  evidence.renderer = await page.evaluate(() => window.__iwsdkPrototype!.rendererStats());
  assert.equal(await page.locator('#app canvas').count(), 1, 'only one application canvas');
  assert.deepEqual(errors, [], 'browser errors');
  evidence.errors = errors;

  // Default entry must remain on its custom runtime.
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await waitForTextContentPrefix(page, '#status', 'loaded');
  assert.equal(await page.evaluate(() => Boolean(window.__iwsdkPrototype)), false);
  assert.equal(await page.evaluate(() => window.FRAMEWORK_MCP_RUNTIME!.handles('ecs_pause')), false);
  evidence.defaultEntry = 'custom runtime preserved';
  evidence.result = 'pass';
  console.log('IWSDK prototype E2E passed; artifacts in output/iwsdk-prototype');
} catch (error) {
  evidence.result = 'fail';
  evidence.errors = errors;
  evidence.pageText = await activePage?.locator('body').innerText({ timeout: 3000 }).catch(() => 'unavailable');
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => undefined);
  evidence.error = String(error);
  throw error;
} finally {
  clearTimeout(deadline);
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close();
  await stopProcess(server);
}
