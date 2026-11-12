import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync, gunzipSync } from "node:zlib";

import type { Browser, BrowserContext, Page } from "@playwright/test";

import { MAX_HOLOGRAM_BYTES, PLACE_DETAIL_SPLAT_CAP, PLACE_STORED_SPLAT_CAP, readGlbChunks, readStoredPlace } from "@holoim/contracts";
import { createXrContext, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { assertViewerShell, expect, test } from "./bootstrap";
import { makeFixture } from "./place-fixture";
import { installProbe, waitForPortalReady } from "./portal-helpers";

// docs/features/hologram-budgets.md, through the real capture → upload →
// render path. A take recorded in a 3 M-splat SH1 scan stores two levels of
// the place: the light one (at most 200 k, SH0) in the GLB every viewer
// paints, and the detail (at most 3 M, SH from the scan) as its own object the
// API serves at `placeDetailUrl`. The focused card paints the light place,
// swaps in the detail thinned to the device's draw budget without moving the
// floor, and frees it when scrolled away; deleting the hologram removes the
// detail object. An SH0 scan stores SH0 in both levels; a small scan stores no
// detail and plays as holograms from before this change do. The 100 MB cap is
// met through the upload routes, at the cap and one byte over.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/hologram-budgets");
const CAPTURE_VIEWPORT = { width: 640, height: 360 };
const VIEWER_VIEWPORT = { width: 800, height: 440 };
const STEP_MS = 1000 / 60;
/** No change in floor height between the levels (acceptance criterion): 0.5 mm. */
const SWAP_TOLERANCE = 0.0005;
/** A small draw budget, so the swap thins the detail as a Quest would. */
const TEST_DRAW_BUDGET = 500_000;

type CaptureWindow = Window & {
  __setManualClock: (enabled: boolean, draw?: boolean) => void;
  __setPlaceGlbBudget: (bytes: number | null) => void;
  __setMockInput: (input: { forward?: boolean; lookYaw?: number }) => void;
  advanceTime: (ms: number) => void;
  __samplePlace: () => { status: string; lastExport: Record<string, unknown> | null } | null;
};

type DetailReport = { status: string; error: string | null; storedCount: number; shDegree: number; drawnCount: number; budget: number; floorBandY: number; nodeWorld: number[]; loadMs: number };
type StoredPlaceReport = { status: string; error: string | null; splatCount: number; nodeWorld: number[]; floorBandY: number; discY: number; detail: DetailReport | null };
type TextureReport = { status: string; error: string | null; swapped: number; lightMaxWidth: number; fullMaxWidth: number; loadMs: number };
type TextureWindow = Window & { __HOLOIM_TEXTURE_DETAIL__?: TextureReport };
type HologramDto = { id: string; url: string; placeDetailUrl?: string | null; textureDetailUrl?: string | null; sizeBytes?: number };

// ---------------------------------------------------------------- capture

/** Capture at `?place=` a scan served from a local server: Playwright's route cannot carry a 300 MB PLY. */
async function openCapture(browser: Browser, bytes: Buffer): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await createXrContext(browser);
  const page = await context.newPage();
  await page.setViewportSize(CAPTURE_VIEWPORT);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(`console.error: ${message.text()}`);
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.byteLength, "access-control-allow-origin": "*", "access-control-allow-private-network": "true" });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  context.on("close", () => server.close());
  await page.goto(new URL(`?placeCapture=1&place=${encodeURIComponent(`http://127.0.0.1:${port}/scan.ply`)}`, captureUrl).href, { waitUntil: "load" });
  await waitForTextContentPrefix(page, "#status", "loaded", { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true, false));
  return { context, page, errors };
}

const placeReport = (page: Page) => page.evaluate(() => (window as unknown as CaptureWindow).__samplePlace());
const advance = (page: Page, seconds: number) => page.evaluate((ms) => (window as unknown as CaptureWindow).advanceTime(ms), Math.round((seconds * 1000) / STEP_MS) * STEP_MS);
const mock = (page: Page, input: Parameters<CaptureWindow["__setMockInput"]>[0]) => page.evaluate((value) => (window as unknown as CaptureWindow).__setMockInput(value), input);

type Take = { glb: Buffer; stopMs: number; lastExport: Record<string, unknown>; errors: string[] };

/** A short walk on the scan, recorded; the GLB the capture page downloads at Stop. */
async function recordTake(browser: Browser, scan: Buffer, name: string): Promise<Take> {
  const { context, page, errors } = await openCapture(browser, scan);
  try {
    await expect.poll(async () => (await placeReport(page))?.status, { timeout: 240_000 }).toBe("ready");
    await advance(page, 1);
    await page.getByRole("button", { name: CONTROL_NAMES.startRecording }).evaluate((el) => (el as HTMLElement).click());
    await expect(page.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible();
    await advance(page, 0.5);
    await mock(page, { lookYaw: 0.4, forward: true });
    for (let i = 0; i < 10; i += 1) await advance(page, 0.1);
    await mock(page, { forward: false });
    await advance(page, 0.5);
    const download = page.waitForEvent("download", { timeout: 300_000 });
    const started = Date.now();
    await page.getByRole("button", { name: CONTROL_NAMES.stopRecording }).evaluate((el) => (el as HTMLElement).click());
    const done = await download;
    const stopMs = Date.now() - started;
    const file = path.join(evidenceDir, `${name}.glb`);
    await mkdir(evidenceDir, { recursive: true });
    await done.saveAs(file);
    const lastExport = (await placeReport(page))!.lastExport!;
    return { glb: await readFile(file), stopMs, lastExport, errors };
  } finally {
    await context.close();
  }
}

/** SPZ positions (24-bit fixed point after the 16-byte header), one key per splat. */
function positions(spz: Uint8Array): Set<string> {
  const raw = gunzipSync(spz);
  const count = raw.readUInt32LE(8);
  const keys = new Set<string>();
  for (let i = 0; i < count; i += 1) keys.add(raw.subarray(16 + i * 9, 25 + i * 9).toString("hex"));
  return keys;
}

async function levels(glb: Buffer) {
  const bytes = new Uint8Array(glb);
  const stored = await readStoredPlace(bytes, readGlbChunks(bytes));
  if (!stored) throw new Error("the take carries no place");
  const detailKeys = stored.detail ? positions(stored.detail.spz) : null;
  const lightInsideDetail = detailKeys ? [...positions(stored.spz)].every((key) => detailKeys.has(key)) : null;
  return {
    stored,
    summary: {
      glbBytes: glb.byteLength,
      light: { splats: stored.header.numPoints, sh: stored.header.shDegree, bytes: stored.spz.byteLength },
      detail: stored.detail ? { splats: stored.detail.header.numPoints, sh: stored.detail.header.shDegree, bytes: stored.detail.spz.byteLength } : null,
      lightInsideDetail
    }
  };
}

const BASE = { half: 6, ring: { x: 0, z: 0, radius: 0 }, clutter: 3000 } as const;
const baseCount = makeFixture(BASE).count;

let sh1Take: Promise<Take> | undefined;
/** The 3 M-splat SH1 scan's take, recorded once for the tests that share it. */
const recordSh1Take = (browser: Browser) => (sh1Take ??= recordTake(browser, makeFixture({ ...BASE, sh1: true, fill: { count: 3_000_000 - baseCount, half: 2.5 } }).bytes, "sh1-3m"));

// ---------------------------------------------------------------- viewer

async function upload(page: Page, name: string, glb: Buffer): Promise<{ status: number; body: string; dto: HologramDto | null }> {
  const response = await page.request.post("/api/holograms", {
    timeout: 300_000,
    multipart: { hologramName: `${name} ${Date.now()}`, submittedBy: "hologram-budgets-e2e", file: { name: `${name}.glb`, mimeType: "model/gltf-binary", buffer: glb } }
  });
  const body = await response.text();
  return { status: response.status(), body, dto: response.ok() ? (JSON.parse(body) as HologramDto) : null };
}

async function showOnly(page: Page, ids: string[]): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    const items = ids.map((id) => body.items.find((item) => item.id === id)).filter(Boolean);
    await route.fulfill({ response, json: { ...body, items, nextCursor: null } });
  });
}

async function openFeed(page: Page, ids: string[], first: HologramDto): Promise<void> {
  await page.setViewportSize(VIEWER_VIEWPORT);
  await page.addInitScript((budget) => { (window as unknown as { __HOLOIM_PLACE_DRAW_BUDGET__: number }).__HOLOIM_PLACE_DRAW_BUDGET__ = budget; }, TEST_DRAW_BUDGET);
  await installProbe(page);
  await showOnly(page, ids);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, first.id, first.url);
}

const storedPlace = (page: Page) => page.evaluate(() => {
  const report = (window as unknown as { __HOLOIM_STORED_PLACE__?: StoredPlaceReport }).__HOLOIM_STORED_PLACE__;
  return report ? (JSON.parse(JSON.stringify(report)) as StoredPlaceReport) : null;
});

async function usedHeap(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
    return usedSize;
  } finally {
    await cdp.detach();
  }
}

async function evidence(name: string, value: unknown): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `${name}.json`), JSON.stringify(value, null, 2));
}

/** A valid GLB of exactly `size` bytes: `glb` with its BIN chunk grown by an unreferenced buffer view. */
function paddedGlb(glb: Buffer, size: number): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").trimEnd()) as { buffers: Array<{ byteLength: number }>; bufferViews: Array<Record<string, number>> };
  const binStart = 20 + jsonLength;
  const binLength = glb.readUInt32LE(binStart);
  const bin = glb.subarray(binStart + 8, binStart + 8 + binLength);
  const rebuild = (extra: number) => {
    const next = structuredClone(json);
    next.bufferViews.push({ buffer: 0, byteOffset: bin.byteLength, byteLength: extra });
    next.buffers[0]!.byteLength = bin.byteLength + extra;
    let text = JSON.stringify(next);
    text += " ".repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
    return Buffer.from(text, "utf8");
  };
  // The JSON's length depends on the padding's digits; settle it in two passes.
  let extra = size - glb.byteLength;
  for (let pass = 0; pass < 3; pass += 1) {
    const jsonBytes = rebuild(extra);
    const binBytes = bin.byteLength + extra;
    const total = 12 + 8 + jsonBytes.byteLength + 8 + binBytes;
    if (total === size && binBytes % 4 === 0) {
      const out = Buffer.alloc(total);
      out.writeUInt32LE(0x46546c67, 0);
      out.writeUInt32LE(2, 4);
      out.writeUInt32LE(total, 8);
      out.writeUInt32LE(jsonBytes.byteLength, 12);
      out.writeUInt32LE(0x4e4f534a, 16);
      jsonBytes.copy(out, 20);
      const at = 20 + jsonBytes.byteLength;
      out.writeUInt32LE(binBytes, at);
      out.writeUInt32LE(0x004e4942, at + 4);
      bin.copy(out, at + 8);
      return out;
    }
    extra += size - total;
    extra -= ((bin.byteLength + extra) % 4 + 4) % 4;
  }
  throw new Error(`could not pad the GLB to ${size} bytes`);
}

/** An RGB PNG of `size`², a gradient (so it is not trivially compressible), unfiltered rows. */
function gradientPng(size: number): Buffer {
  const row = 1 + size * 3;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = y * row + 1 + x * 3;
      raw[at] = (x * 255) / size;
      raw[at + 1] = (y * 255) / size;
      raw[at + 2] = ((x ^ y) & 0xff);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.byteLength, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

/** `glb` with the image behind texture `index` replaced by `png`, appended as a buffer view of its own. */
function withTexture(glb: Buffer, index: number, png: Buffer): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").trimEnd()) as { buffers: Array<{ byteLength: number }>; bufferViews: Array<Record<string, number>>; textures: Array<{ source: number }>; images: Array<Record<string, unknown>> };
  const binStart = 20 + jsonLength;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
  const padded = Buffer.concat([png, Buffer.alloc((4 - (png.byteLength % 4)) % 4)]);
  json.bufferViews.push({ buffer: 0, byteOffset: bin.byteLength, byteLength: png.byteLength });
  json.buffers[0]!.byteLength = bin.byteLength + padded.byteLength;
  json.images.push({ bufferView: json.bufferViews.length - 1, mimeType: "image/png" });
  json.textures[index]!.source = json.images.length - 1;
  let text = JSON.stringify(json);
  text += " ".repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
  const jsonBytes = Buffer.from(text, "utf8");
  const binBytes = Buffer.concat([bin, padded]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonBytes.byteLength + 8 + binBytes.byteLength, 8);
  header.writeUInt32LE(jsonBytes.byteLength, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binBytes.byteLength, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonBytes, binHeader, binBytes]);
}

const gltfJson = (glb: Buffer) => JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8").trimEnd()) as { extensionsUsed?: string[]; animations?: unknown[] };

// ---------------------------------------------------------------- the tests

test.describe("hologram budgets: two levels of the place, the 100 MB cap", () => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture server and a live API.");
  // A test's own setTimeout only starts once its fixtures are up; without this the context fixture of a test after
  // the heavy ones runs under the 30 s default, and times out on a loaded runner (hosted CI, shard 9).
  test.describe.configure({ mode: "serial", timeout: 600_000 });

  test("capture: a 3 M-splat SH1 scan stores a detail at SH1 and a light place of at most 200 k at SH0, under 100 MB", async ({ browser }) => {
    test.setTimeout(900_000);
    const take = await recordSh1Take(browser);
    const { stored, summary } = await levels(take.glb);
    await evidence("sh1-3m-capture", { ...summary, stopMs: take.stopMs, lastExport: { ...take.lastExport, box: undefined, disc: undefined, dome: undefined } });
    expect(take.glb.byteLength, "the take is at most 100 MB").toBeLessThanOrEqual(MAX_HOLOGRAM_BYTES);
    expect(stored.header.numPoints, "light place: at most 200 k").toBeLessThanOrEqual(PLACE_STORED_SPLAT_CAP);
    expect(stored.header.shDegree, "light place: SH0").toBe(0);
    expect(stored.detail, "a detail level").not.toBeNull();
    expect(stored.detail!.header.numPoints, "detail: more than the light place").toBeGreaterThan(stored.header.numPoints);
    expect(stored.detail!.header.numPoints, "detail: at most 3 M").toBeLessThanOrEqual(PLACE_DETAIL_SPLAT_CAP);
    expect(stored.detail!.header.shDegree, "detail: the scan's SH1").toBe(1);
    expect(summary.lightInsideDetail, "the light place is a subset of the detail").toBe(true);
    expect(take.errors).toEqual([]);
  });

  test("capture: an SH0 scan stores SH0 in both levels; a small scan stores no detail", async ({ browser }) => {
    test.setTimeout(600_000);
    const big = await recordTake(browser, makeFixture({ ...BASE, fill: { count: 600_000, half: 2.5 } }).bytes, "sh0-600k");
    const bigLevels = await levels(big.glb);
    const small = await recordTake(browser, makeFixture(BASE).bytes, "sh0-small");
    const smallLevels = await levels(small.glb);
    await evidence("sh0-capture", { big: bigLevels.summary, small: smallLevels.summary });
    expect(bigLevels.stored.header.shDegree).toBe(0);
    expect(bigLevels.stored.detail).not.toBeNull();
    expect(bigLevels.stored.detail!.header.shDegree, "never padded to SH1").toBe(0);
    expect(bigLevels.summary.lightInsideDetail).toBe(true);
    expect(smallLevels.stored.detail, "a detail would add nothing").toBeNull();
    expect([...big.errors, ...small.errors]).toEqual([]);
  });

  test("the API stores the light GLB and serves the detail; the feed swaps it in without moving the floor, draws its budget, frees it, and delete removes it", async ({ browser, page }) => {
    test.setTimeout(900_000);
    const take = await recordSh1Take(browser);
    const recorded = await levels(take.glb);
    const uploaded = await upload(page, "Budgets SH1", take.glb);
    expect(uploaded.status, uploaded.body).toBe(201);
    const dto = uploaded.dto!;
    expect(dto.placeDetailUrl, "the DTO names the detail").toBeTruthy();

    // The stored GLB is the light one: its place has no detail bytes and no detail field.
    const served = Buffer.from(await (await page.request.get(dto.url)).body());
    const servedLevels = await levels(served);
    expect(servedLevels.stored.detail, "the served GLB carries no detail").toBeNull();
    expect(servedLevels.stored.header.numPoints).toBe(recorded.stored.header.numPoints);
    expect(served.byteLength, "the served GLB is smaller by at least the detail").toBeLessThanOrEqual(take.glb.byteLength - recorded.stored.detail!.spz.byteLength);
    const detailBytes = Buffer.from(await (await page.request.get(dto.placeDetailUrl!)).body());
    expect(detailBytes.equals(Buffer.from(recorded.stored.detail!.spz)), "the detail object is the recorded detail, unchanged").toBe(true);

    // A second card to scroll to.
    const small = await recordTake(browser, makeFixture(BASE).bytes, "sh0-small-neighbour");
    const neighbour = await upload(page, "Budgets neighbour", small.glb);
    expect(neighbour.status, neighbour.body).toBe(201);
    expect(neighbour.dto!.placeDetailUrl ?? null, "a take without a detail has none").toBeNull();

    const baseline = await (async () => {
      await openFeed(page, [dto.id, neighbour.dto!.id], dto);
      return usedHeap(page);
    })();
    await expect.poll(async () => (await storedPlace(page))?.detail?.status, { timeout: 120_000 }).toBe("ready");
    const report = (await storedPlace(page))!;
    const detail = report.detail!;
    const withDetail = await usedHeap(page);
    expect(detail.storedCount).toBe(recorded.stored.detail!.header.numPoints);
    expect(detail.shDegree).toBe(1);
    expect(detail.budget).toBe(TEST_DRAW_BUDGET);
    expect(detail.drawnCount, "draws at most the device's budget").toBeLessThanOrEqual(TEST_DRAW_BUDGET);
    expect(detail.drawnCount).toBeGreaterThan(report.splatCount);
    for (let i = 0; i < 16; i += 1) expect(Math.abs(detail.nodeWorld[i]! - report.nodeWorld[i]!), `node matrix [${i}] unchanged`).toBeLessThan(1e-9);
    expect(Math.abs(detail.floorBandY - report.floorBandY), "the floor stays within 0.5 mm").toBeLessThan(SWAP_TOLERANCE);
    await page.locator(`.feed-card[data-card-id="${dto.id}"]`).screenshot({ path: path.join(evidenceDir, "detail-swapped.png") });

    // Scrolled away, the detail is freed.
    await page.locator(`.feed-card[data-card-id="${neighbour.dto!.id}"]`).scrollIntoViewIfNeeded();
    await expect(page.locator(`.feed-card[data-card-id="${dto.id}"]`)).toHaveAttribute("data-card-focus", "false", { timeout: 20_000 });
    await expect.poll(async () => (await storedPlace(page))?.detail?.status ?? "freed", { timeout: 20_000 }).toBe("freed");
    const afterScroll = await usedHeap(page);
    await evidence("detail-swap", { dto, servedBytes: served.byteLength, recordedBytes: take.glb.byteLength, detail, light: { splatCount: report.splatCount, floorBandY: report.floorBandY }, heap: { baseline, withDetail, afterScroll } });
    expect(afterScroll - baseline, "the heap returns near its baseline").toBeLessThan(Math.max(32 * 1024 * 1024, (withDetail - baseline) / 4));

    // Delete removes the detail object.
    const deleted = await page.request.delete(`/api/holograms/${dto.id}`);
    expect(deleted.status(), await deleted.text()).toBe(200);
    expect(((await deleted.json()) as { deletedDetail?: boolean }).deletedDetail).toBe(true);
    expect((await page.request.get(dto.placeDetailUrl!)).status(), "the detail object is gone").toBe(404);
  });

  test("a 4096 px texture is served as KTX2 at 1024 px with reduced animation, and the focused card swaps in the full size", async ({ browser, page }) => {
    test.setTimeout(600_000);
    const small = await recordTake(browser, makeFixture(BASE).bytes, "sh0-small-texture");
    // The avatar's skin (texture 1) at 4096 px, as a heavy prop would bring.
    const heavy = withTexture(small.glb, 1, gradientPng(4096));
    const uploaded = await upload(page, "Budgets texture", heavy);
    expect(uploaded.status, uploaded.body).toBe(201);
    const id = uploaded.dto!.id;
    // Processing is queued: the DTO names the light GLB and the full textures once it finishes.
    let dto = uploaded.dto!;
    await expect.poll(async () => {
      dto = (await (await page.request.get(`/api/holograms/${id}`)).json()) as HologramDto;
      return Boolean(dto.textureDetailUrl);
    }, { timeout: 240_000, intervals: [2000] }).toBe(true);
    const served = Buffer.from(await (await page.request.get(dto.url)).body());
    const servedJson = gltfJson(served);
    expect(servedJson.extensionsUsed ?? [], "the served textures are KTX2").toContain("KHR_texture_basisu");
    expect(served.byteLength, "the light GLB is smaller than the upload").toBeLessThan(heavy.byteLength);
    expect((servedJson.animations ?? []).length, "the animation is still there").toBe((gltfJson(heavy).animations ?? []).length);

    await openFeed(page, [id], dto);
    // Poll the whole report so a failure shows the loader's error.
    await expect
      .poll(() => page.evaluate(() => { const r = (window as unknown as TextureWindow).__HOLOIM_TEXTURE_DETAIL__; return r ? { status: r.status, error: r.error } : null; }), { timeout: 120_000 })
      .toEqual({ status: "ready", error: null });
    const report = (await page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as TextureWindow).__HOLOIM_TEXTURE_DETAIL__)) as TextureReport))!;
    await page.locator(`.feed-card[data-card-id="${id}"]`).screenshot({ path: path.join(evidenceDir, "texture-swapped.png") });
    await evidence("texture-detail", { uploadBytes: heavy.byteLength, servedBytes: served.byteLength, dto, report, extensionsUsed: servedJson.extensionsUsed });
    expect(report.swapped, "slots swapped to the full texture").toBeGreaterThan(0);
    expect(report.lightMaxWidth, "the light texture is 1024 px").toBe(1024);
    expect(report.fullMaxWidth, "the full texture is 4096 px").toBe(4096);
    expect(await page.locator(`.feed-card[data-card-id="${id}"]`).getAttribute("data-model-state")).toBe("rendered");
  });

  test("caps: a 100 MB take uploads and plays; one byte over is refused with the cap in the message", async ({ browser, page }) => {
    test.setTimeout(600_000);
    const small = await recordTake(browser, makeFixture(BASE).bytes, "sh0-small-cap");
    const atCap = paddedGlb(small.glb, MAX_HOLOGRAM_BYTES);
    expect(atCap.byteLength).toBe(MAX_HOLOGRAM_BYTES);
    // One byte past the cap: the route refuses by streamed size, before the GLB is read.
    const over = Buffer.concat([atCap, Buffer.alloc(1)]);
    // The intent route refuses by declared size, before any bytes move.
    const intent = (sizeBytes: number) => page.request.post("/api/holograms/uploads/initiate", { data: { filenameOriginal: "cap.glb", hologramName: "cap", mimeType: "model/gltf-binary", sizeBytes, submittedBy: "hologram-budgets-e2e" } });
    expect((await intent(MAX_HOLOGRAM_BYTES)).status()).toBe(200);
    const refusedIntent = await intent(MAX_HOLOGRAM_BYTES + 1);
    expect(refusedIntent.status()).toBe(413);
    expect(await refusedIntent.text()).toContain("100MB");
    // The multipart route takes the bytes themselves.
    const refused = await upload(page, "Budgets over cap", over);
    expect(refused.status).toBe(413);
    expect(refused.body).toContain("100MB");
    const accepted = await upload(page, "Budgets at cap", atCap);
    expect(accepted.status, accepted.body).toBe(201);
    await openFeed(page, [accepted.dto!.id], accepted.dto!);
    await expect.poll(async () => (await storedPlace(page))?.status, { timeout: 120_000 }).toBe("ready");
    await evidence("caps", { atCap: atCap.byteLength, over: over.byteLength, intentRefusal: await refusedIntent.text(), multipartRefusal: refused.body, accepted: accepted.dto });
  });
});
