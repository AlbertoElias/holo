import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { Matrix4, Quaternion, Vector3 } from "three";

import { PLACE_EXTENSION, PLACE_NODE_NAME, checkSpzBytes, readGlbChunks, readStoredPlace } from "@holoim/contracts";
import { placeClipFade, type DomeShape } from "@holoim/place";
import { createXrContext, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";
import { makeFixture, type Fixture } from "./place-fixture";
import { shotStats } from "./place-pixels";
import { waitForUsdzReady } from "./pipeline-takes";
import { cardCenter, installProbe, readPortal, waitForFrozenTimes, waitForPortalReady } from "./portal-helpers";

// Slice 2a of docs/features/splat-capture.md: a take recorded inside a scanned
// place on the desktop capture page, through the real export → upload →
// render path. Capture loads a scan written at runtime (a floor off the
// origin, boxes, floaters under the floor, a faint sheet in front of one box
// and an opaque one in front of another) from `?place=`, the author walks on
// it, points through the faint sheet and at the opaque one, and records; the
// GLB's place is checked against the contract, uploaded through the real API,
// and played in the feed card and portal. The scan's own splats are the
// ground truth for what the stored crop must hold. The downloaded test scans
// (fireplace.spz, snow-street.spz, never committed) run the same path when
// they are on disk; failure paths and the lying-header GLB close the spec.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/place-capture");
const localPlaces = path.resolve(import.meta.dirname, "../public/local-places");
const PLACE_ROUTE = "/e2e-place/";
const CAPTURE_VIEWPORT = { width: 640, height: 360 };
const VIEWER_VIEWPORT = { width: 800, height: 440 };
const STEP_MS = 1000 / 60;
/** The brief's tolerances, metres. */
const FEET_TOLERANCE = 0.02;
const LINK_TOLERANCE = 0.02;
const DOME_TOLERANCE = 0.01;
const MAX_GLB_BYTES = 25 * 1024 * 1024;

type Vec3 = [number, number, number];

type PlaceReport = {
  status: "none" | "loading" | "ready" | "error";
  name: string | null;
  message: string | null;
  splatsLoaded: number;
  flipped: boolean;
  upright: string;
  floorFound: boolean;
  floorFoundY: number;
  floorBandY: number;
  floorMiddle: { x: number; z: number } | null;
  scanRadius: number;
  decodeMs: number;
  loads: number;
  worldModel: string | null;
  groundVisible: boolean;
  previousSetAttached: boolean;
  lastExport: { kept: number; inBox: number; thinned: number; spzBytes: number; cropMs: number; writeMs: number; box: { min: number[]; max: number[] }; disc: { center: { x: number; z: number }; radius: number } } | null;
};

type CaptureWindow = Window & {
  __setManualClock: (enabled: boolean, draw?: boolean) => void;
  __setMockInput: (input: { forward?: boolean; point?: boolean; lookYaw?: number; aimPitch?: number }) => void;
  advanceTime: (ms: number) => void;
  render_game_to_text: () => string;
  __samplePlace: () => PlaceReport | null;
  __probePlaceCasts: (points: ReadonlyArray<[number, number]>) => Array<{ set: string | null; setY: number | null; world: string[] }>;
  __loadPlaceUrl: (url: string) => Promise<boolean>;
  __pointLanding: () => { origin: Vec3; point: Vec3; landed: boolean };
  __projectToScreen: (point: readonly number[]) => { x: number; y: number } | null;
};

type TextState = {
  character: { position: { x: number; y: number; z: number }; grounded: boolean };
  heightAdaptation: { baseWorldY: number; eyeWorld: { x: number; y: number; z: number } };
  pose: { ankles: Array<{ y: number } | null>; toes: Array<{ y: number } | null> };
  point: { held: boolean; landing: Vec3; landed: boolean };
};

type StoredPlaceReport = {
  status: "loading" | "ready" | "failed";
  error: string | null;
  splatCount: number;
  nodeWorld: number[];
  discVisible: boolean;
  discY: number;
  floorBandY: number;
  feetY: number;
  outside: number;
  shown: number;
  dome: DomeShape | null;
  sorted: boolean;
  decodeMs: number;
};

type GltfNode = { name?: string; children?: number[]; translation?: Vec3; rotation?: [number, number, number, number]; scale?: Vec3; extensions?: Record<string, unknown> };
type GltfJson = {
  nodes: GltfNode[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: { HOLOIM_meaning?: { marks: Array<{ kind: string; anchor: { to: { node: number; point?: Vec3 } }; span: { start: number; end: number } }> } };
};

// ---------------------------------------------------------------- the scan

/** Where the two sheets and the boxes behind them stand, from the floor's middle, in the y-up room. */
const RED_BOX = { x: 0.9, z: 0 };
const GREEN_BOX = { x: -0.9, z: 0 };
const FAINT_SHEET_X = 0.5;
const OPAQUE_SHEET_X = -0.5;
const FAINT_OPACITY = 0.3;
/** A magenta cluster past the scan's floor and its fade, in view from the spawn: the place's ground must not paint over it. */
const BEACON = { x: 2.5, z: -8, height: 1.4 };

function sheet(x: number, opacity: number): NonNullable<Parameters<typeof makeFixture>[0]["blobs"]> {
  const blobs: NonNullable<Parameters<typeof makeFixture>[0]["blobs"]> = [];
  for (let iz = -15; iz <= 15; iz += 1) {
    for (let iy = 0; iy <= 30; iy += 1) blobs.push({ x, z: iz * 0.04, height: 0.2 + iy * 0.04, scale: 0.03, color: [0.95, 0.95, 0.98], opacity });
  }
  return blobs;
}

function beacon(): NonNullable<Parameters<typeof makeFixture>[0]["blobs"]> {
  const blobs: NonNullable<Parameters<typeof makeFixture>[0]["blobs"]> = [];
  for (let ix = -3; ix <= 3; ix += 1) for (let iy = -3; iy <= 3; iy += 1) for (let iz = -1; iz <= 1; iz += 1) {
    blobs.push({ x: BEACON.x + ix * 0.07, z: BEACON.z + iz * 0.07, height: BEACON.height + iy * 0.07, scale: 0.05, color: [1, 0, 1], opacity: 0.99 });
  }
  return blobs;
}

function roomFixture(): Fixture {
  return makeFixture({
    half: 6,
    ring: { x: 0, z: 0, radius: 0 },
    clutter: 0,
    blobs: [...sheet(FAINT_SHEET_X, FAINT_OPACITY), ...sheet(OPAQUE_SHEET_X, 0.95), ...beacon()]
  });
}

// ---------------------------------------------------------------- GLB and SPZ

function readJson(glb: Buffer): GltfJson {
  return JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as GltfJson;
}

function nodeMatrix(node: GltfNode): Matrix4 {
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return new Matrix4().compose(new Vector3(...t), new Quaternion(...r), new Vector3(...s));
}

/** The stored splats' centres, in the file's own frame: SPZ positions are 24-bit fixed point after the 16-byte header. */
function spzCenters(spz: Uint8Array): { centers: Float32Array; fractionalBits: number; version: number; shDegree: number } {
  const raw = gunzipSync(spz);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const shDegree = raw[12]!;
  const fractionalBits = raw[13]!;
  const centers = new Float32Array(count * 3);
  const unit = 1 / (1 << fractionalBits);
  for (let i = 0; i < count * 3; i += 1) {
    const at = 16 + i * 3;
    let value = raw[at]! | (raw[at + 1]! << 8) | (raw[at + 2]! << 16);
    if (value & 0x800000) value |= ~0xffffff;
    centers[i] = value * unit;
  }
  return { centers, fractionalBits, version, shDegree };
}

/** A lookup of the stored centres to the nearest few millimetres. */
function centreIndex(centers: Float32Array, cell: number): (point: Vec3) => boolean {
  const key = (x: number, y: number, z: number) => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
  const keys = new Set<string>();
  for (let i = 0; i < centers.length; i += 3) keys.add(key(centers[i]!, centers[i + 1]!, centers[i + 2]!));
  return ([x, y, z]) => {
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      if (keys.has(key(x + dx * cell, y + dy * cell, z + dz * cell))) return true;
    }
    return false;
  };
}

/** The GLB with its stored SPZ's header claiming `numPoints` splats: the buffer view is rewritten in place, so the chunk stays the same length when the gzip does. */
function withLyingHeader(glb: Buffer, numPoints: number): Buffer {
  const chunks = readGlbChunks(new Uint8Array(glb));
  const json = readJson(glb) as GltfJson & { bufferViews: Array<{ byteOffset?: number; byteLength: number }>; buffers: Array<{ byteLength: number }> };
  const holder = json.nodes.find((node) => node.extensions?.[PLACE_EXTENSION])!;
  const extension = holder.extensions![PLACE_EXTENSION] as { bufferView: number };
  const view = json.bufferViews[extension.bufferView]!;
  const bin = Buffer.from(chunks.bin!);
  const spz = gunzipSync(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
  spz.writeUInt32LE(numPoints, 8);
  const lying = gzipSync(spz);
  // Append the lying SPZ at the end of BIN and point the view at it: the original bytes stay, unreferenced.
  const offset = Math.ceil(bin.byteLength / 4) * 4;
  const padded = Buffer.alloc(Math.ceil((offset + lying.byteLength) / 4) * 4);
  bin.copy(padded);
  lying.copy(padded, offset);
  view.byteOffset = offset;
  view.byteLength = lying.byteLength;
  json.buffers[0]!.byteLength = padded.byteLength;
  let text = Buffer.from(JSON.stringify(json), "utf8");
  text = Buffer.concat([text, Buffer.alloc((4 - (text.byteLength % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.byteLength + 8 + padded.byteLength, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(text.byteLength, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(padded.byteLength, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHead, text, binHead, padded]);
}

// ---------------------------------------------------------------- capture

async function openCapture(browser: Browser, files: Record<string, Buffer>, query: string, base = captureUrl): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await createXrContext(browser);
  const page = await context.newPage();
  await page.setViewportSize(CAPTURE_VIEWPORT);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(`console.error: ${message.text()}`);
  });
  // By path: the page's own URL carries the route in its query.
  await page.route((url) => url.pathname.startsWith(PLACE_ROUTE), async (route) => {
    const name = new URL(route.request().url()).pathname.slice(PLACE_ROUTE.length);
    const body = files[name];
    if (body) await route.fulfill({ status: 200, body, contentType: "application/octet-stream" });
    else await route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto(new URL(`?${query}`, base).href, { waitUntil: "networkidle" });
  await waitForTextContentPrefix(page, "#status", "loaded");
  // Logic only, no drawing: software WebGL draws a scan far slower than the checks step it.
  await page.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true, false));
  return { context, page, errors };
}

const placeReport = (page: Page) => page.evaluate(() => (window as unknown as CaptureWindow).__samplePlace());
const textState = async (page: Page): Promise<TextState> => JSON.parse(await page.evaluate(() => (window as unknown as CaptureWindow).render_game_to_text())) as TextState;
const mock = (page: Page, input: Parameters<CaptureWindow["__setMockInput"]>[0]) => page.evaluate((value) => (window as unknown as CaptureWindow).__setMockInput(value), input);

async function advance(page: Page, seconds: number): Promise<void> {
  const steps = Math.max(1, Math.round((seconds * 1000) / STEP_MS));
  await page.evaluate((ms) => (window as unknown as CaptureWindow).advanceTime(ms), steps * STEP_MS);
}

async function waitForPlace(page: Page, status: PlaceReport["status"], loads?: number): Promise<PlaceReport> {
  await expect.poll(async () => {
    const report = await placeReport(page);
    return report && report.status === status && (loads === undefined || report.loads === loads) ? "ok" : `${report?.status}: ${report?.message}`;
  }, { timeout: 60_000, message: `place ${status}` }).toBe("ok");
  return (await placeReport(page))!;
}

/** The lowest foot bone above the floor now: the viewer's `feetY` reads the same bones. */
function footBoneY(state: TextState): number {
  return Math.min(...[...state.pose.ankles, ...state.pose.toes].filter((v): v is { y: number } => v !== null).map((v) => v.y));
}

/** Walks `metres` along the body's facing, `lookYaw`, checking the sole against the floor at every step. */
async function walk(page: Page, lookYaw: number, metres: number, floorY: number, soles: number[]): Promise<number> {
  await mock(page, { lookYaw, forward: true });
  let walked = 0;
  let last = (await textState(page)).character.position;
  for (let i = 0; i < 400 && walked < metres; i += 1) {
    await advance(page, 0.1);
    const state = await textState(page);
    const now = state.character.position;
    walked += Math.hypot(now.x - last.x, now.z - last.z);
    last = now;
    soles.push(state.heightAdaptation.baseWorldY - floorY);
  }
  await mock(page, { forward: false });
  return walked;
}

/** The set-frame point of a room point: the scan stands with its floor's middle on the set's origin. */
function toSet(report: PlaceReport, room: { x: number; y: number; z: number }): Vec3 {
  return [room.x - report.floorMiddle!.x, room.y - report.floorFoundY, room.z - report.floorMiddle!.z];
}

/** Holds the point action on `target` (set frame) for a second, steering onto it from the eye as the pointing check does. */
async function holdOn(page: Page, target: Vec3): Promise<{ landing: Vec3; landed: boolean; origin: Vec3 }> {
  const aimAt = async () => {
    const eye = (await textState(page)).heightAdaptation.eyeWorld;
    const d = [target[0] - eye.x, target[1] - eye.y, target[2] - eye.z];
    return { lookYaw: Math.atan2(-d[0]!, -d[2]!), aimPitch: Math.asin(d[1]! / Math.hypot(...d)) };
  };
  await mock(page, await aimAt());
  await advance(page, 0.3);
  await mock(page, await aimAt());
  await advance(page, 0.1);
  await mock(page, { point: true });
  await advance(page, 0.1);
  await mock(page, await aimAt());
  await advance(page, 0.6);
  const landing = await page.evaluate(() => (window as unknown as CaptureWindow).__pointLanding());
  await advance(page, 0.4);
  await mock(page, { point: false });
  await advance(page, 0.6);
  return { landing: landing.point, landed: landing.landed, origin: landing.origin };
}

/** Draws a few frames and counts the beacon's magenta pixels where it projects; drawing is off again after. */
async function drawnBeacon(page: Page, at: Vec3): Promise<number> {
  await page.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true, true));
  let best = 0;
  try {
    // Spark sorts in a worker: a few frames until the splats are in order.
    for (let frame = 0; frame < 8 && best < 60; frame += 1) {
      await page.evaluate((ms) => (window as unknown as CaptureWindow).advanceTime(ms), STEP_MS);
      await page.waitForTimeout(250);
      const screen = await page.evaluate((point) => (window as unknown as CaptureWindow).__projectToScreen(point), at);
      if (!screen) throw new Error("the beacon is not in view from the spawn");
      const clip = { x: Math.max(0, screen.x - 20), y: Math.max(0, screen.y - 20), width: 40, height: 40 };
      const png = await page.screenshot({ clip });
      best = Math.max(best, (await shotStats(page, png)).magenta);
      if (frame === 0) {
        await mkdir(evidenceDir, { recursive: true });
        await page.screenshot({ path: path.join(evidenceDir, "room-capture-spawn.png") });
      }
    }
  } finally {
    await page.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true, false));
  }
  return best;
}

async function recordAndDownload(page: Page, during: () => Promise<void>, file: string): Promise<Buffer> {
  await page.getByRole("button", { name: CONTROL_NAMES.startRecording }).evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible();
  await during();
  const download = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: CONTROL_NAMES.stopRecording }).evaluate((el) => (el as HTMLElement).click());
  await mkdir(path.dirname(file), { recursive: true });
  await (await download).saveAs(file);
  return readFile(file);
}

// ---------------------------------------------------------------- viewer

async function upload(page: Page, name: string, glb: Buffer, quickLook = false): Promise<{ id: string; url: string; status: number; body: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `${name} ${Date.now()}`,
      submittedBy: "place-capture-e2e",
      ...(quickLook ? { quickLookEnabled: "true" } : {}),
      file: { name: `${name}.glb`, mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  const body = await response.text();
  if (!response.ok()) return { id: "", url: "", status: response.status(), body };
  const parsed = JSON.parse(body) as { id: string; url: string };
  return { ...parsed, status: response.status(), body };
}

async function showOnly(page: Page, id: string): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === id), nextCursor: null } });
  });
}

/** The take's length: its longest clip. */
const clipLength = (page: Page, modelPath: string) => page.evaluate((target) => {
  const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { getClip: () => { duration: number } } | null> }> }).__portalProbes;
  const probe = Object.entries(probes).find(([url]) => url.endsWith(target))![1];
  return Math.max(...Object.values(probe.actions).filter(Boolean).map((action) => action!.getClip().duration));
}, modelPath);

/** The dome the card fitted, from the feed probe both this viewer and `main`'s expose. */
const fittedDome = (page: Page, modelPath: string) => page.evaluate((target) => {
  type Vec = { x: number; y: number; z: number };
  const probes = (window as unknown as { __portalProbes: Record<string, { cloche: { shape: { current: { base: Vec; radii: Vec; exponent: number } | null } } }> }).__portalProbes;
  const shape = Object.entries(probes).find(([url]) => url.endsWith(target))![1].cloche.shape.current;
  return shape ? { base: { ...shape.base }, radii: { ...shape.radii }, exponent: shape.exponent } : null;
}, modelPath);

/** What a take without a place carries, to compare across builds: names, counts and the plugins' JSON shapes (values like times vary). */
function exportSummary(glb: Buffer): unknown {
  const json = readJson(glb) as GltfJson & Record<string, unknown>;
  const shape = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]));
    return typeof value;
  };
  const count = (key: string) => ((json[key] as unknown[] | undefined) ?? []).length;
  return {
    extensionsUsed: [...(json.extensionsUsed ?? [])].sort(),
    extensionsRequired: [...(json.extensionsRequired ?? [])].sort(),
    nodes: json.nodes.map((node) => node.name ?? "").sort(),
    counts: Object.fromEntries(["meshes", "skins", "animations", "materials", "textures", "images", "cameras"].map((key) => [key, count(key)])),
    animationChannels: ((json.animations as Array<{ channels: unknown[] }> | undefined) ?? []).map((animation) => animation.channels.length),
    rootExtensions: shape(json.extensions ?? {}),
    nodeExtensions: json.nodes.filter((node) => node.extensions).map((node) => ({ name: node.name, extensions: shape(node.extensions) }))
  };
}

const storedPlace = (page: Page) => page.evaluate(() => (window as unknown as { __HOLOIM_STORED_PLACE__?: StoredPlaceReport }).__HOLOIM_STORED_PLACE__ ?? null);
const outsideNow = (page: Page) => page.evaluate(() => (window as unknown as { __HOLOIM_STORED_PLACE_OUTSIDE__: () => { outside: number; shown: number } }).__HOLOIM_STORED_PLACE_OUTSIDE__());

async function seek(page: Page, modelPath: string, seconds: number): Promise<void> {
  await page.evaluate(([target, time]) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { time: number } | null>; mixer: { update: (delta: number) => void } }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
  }, [modelPath, seconds] as const);
  await page.waitForTimeout(300);
}

type Ink = { referent: string; ink: { from: Vec3; to: Vec3 } | null };
const inks = (page: Page, modelPath: string) => page.evaluate((target) => {
  const probes = (window as unknown as { __portalProbes: Record<string, { pointing: { links: Ink[] } }> }).__portalProbes;
  return JSON.parse(JSON.stringify(Object.entries(probes).find(([url]) => url.endsWith(target))![1].pointing.links)) as Ink[];
}, modelPath);

async function openCard(page: Page, uploaded: { id: string; url: string }): Promise<void> {
  await page.setViewportSize(VIEWER_VIEWPORT);
  await installProbe(page);
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
}

async function shot(page: Page, id: string, name: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await page.locator(`.feed-card[data-card-id="${id}"]`).screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

// ---------------------------------------------------------------- the take

type RoomTake = {
  glb: Buffer;
  fixture: Fixture;
  report: PlaceReport;
  /** The sole above the scan's floor at every step of the 10 m walk, and how far it went. */
  soles: number[];
  walked: number;
  /** The lowest foot bone above the floor, standing at the end of the take. */
  standingFootY: number;
  holds: { faint: { landing: Vec3; landed: boolean }; opaque: { landing: Vec3; landed: boolean } };
  casts: Array<{ set: string | null; setY: number | null; world: string[] }>;
  /** Magenta pixels around the beacon past the scan's edge, drawn from the spawn. */
  beaconMagenta: number;
  errors: string[];
};

let roomTake: Promise<RoomTake> | undefined;

function recordRoomTake(browser: Browser): Promise<RoomTake> {
  roomTake ??= (async () => {
    const fixture = roomFixture();
    const { context, page, errors } = await openCapture(browser, { "room.ply": fixture.bytes }, `placeCapture=1&place=${PLACE_ROUTE}room.ply`);
    try {
      const report = await waitForPlace(page, "ready");
      await advance(page, 3);
      const beaconMagenta = await drawnBeacon(page, toSet(report, { x: fixture.middle.x + BEACON.x, y: fixture.floorY + BEACON.height, z: fixture.middle.z + BEACON.z }));
      // The 10 m walk: out and back across the scan, the sole read at every step.
      const soles: number[] = [];
      let walked = await walk(page, 0, 5, report.floorBandY, soles);
      walked += await walk(page, Math.PI, 5.5, report.floorBandY, soles);
      await advance(page, 1);
      // Casts on a grid over and past the scan: the set is the disc, the old set is gone.
      const grid: Array<[number, number]> = [];
      for (let x = -8; x <= 8; x += 2) for (let z = -8; z <= 8; z += 2) grid.push([x, z]);
      const casts = await page.evaluate((points) => (window as unknown as CaptureWindow).__probePlaceCasts(points), grid);
      // Stand back at the middle of the scan, facing as at spawn.
      const back = (await textState(page)).character.position;
      const yawHome = Math.atan2(back.x, back.z);
      await walk(page, yawHome, Math.hypot(back.x, back.z) - 0.1, report.floorBandY, soles);
      await mock(page, { lookYaw: 0 });
      await advance(page, 1);

      const red = toSet(report, { x: fixture.middle.x + RED_BOX.x, y: fixture.floorY + 0.18, z: fixture.middle.z + RED_BOX.z });
      const green = toSet(report, { x: fixture.middle.x + GREEN_BOX.x, y: fixture.floorY + 0.18, z: fixture.middle.z + GREEN_BOX.z });
      let holds!: RoomTake["holds"];
      let standingFootY = Number.NaN;
      const glb = await recordAndDownload(page, async () => {
        await advance(page, 0.5);
        const faint = await holdOn(page, red);
        const opaque = await holdOn(page, green);
        holds = { faint, opaque };
        // Walk on through the take, so the dome moves over the scan.
        await walk(page, 0.4, 2, report.floorBandY, soles);
        await advance(page, 1);
        standingFootY = footBoneY(await textState(page)) - report.floorBandY;
      }, path.join(evidenceDir, "room-take.glb"));
      return { glb, fixture, report: (await placeReport(page))!, soles, walked, standingFootY, holds, casts, beaconMagenta, errors };
    } finally {
      await context.close();
    }
  })();
  return roomTake;
}

// ---------------------------------------------------------------- the tests

test.describe("slice 2a: a take recorded inside a scanned place on the desktop", () => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture server and a live API.");

  test("capture: the scan replaces the set at true scale, upright, and the avatar walks on its floor", async ({ browser }) => {
    test.setTimeout(240_000);
    const take = await recordRoomTake(browser);
    const { report, fixture } = take;
    expect(report.status).toBe("ready");
    expect(report.splatsLoaded, "every splat of the scan").toBe(fixture.count);
    expect(report.flipped, "a .ply is read in the trainers' y-down convention").toBe(true);
    expect(report.upright).toBe("read");
    expect(report.floorFound).toBe(true);
    expect(Math.abs(report.floorFoundY - fixture.floorY), "the scan's own floor is found, not the floaters under it").toBeLessThan(FEET_TOLERANCE);
    expect(Math.abs(report.floorBandY), "the floor band stands on the set's floor").toBeLessThan(FEET_TOLERANCE);
    expect(Math.abs(report.floorMiddle!.x - fixture.middle.x) + Math.abs(report.floorMiddle!.z - fixture.middle.z), "the floor's middle is the scan's").toBeLessThan(0.1);
    expect(report.worldModel, "the set every consumer reads is the scan's floor").toBe("PlaceFloor");
    expect(report.groundVisible, "the stage's ground no longer draws").toBe(false);
    expect(report.previousSetAttached, "the old set is gone from the scene").toBe(false);
    // Past the scan's edge the place's ground shows, and nothing of the scan is painted over by it.
    expect(take.beaconMagenta, "the beacon past the scan's floor draws, not covered by the place's ground").toBeGreaterThan(60);

    expect(take.walked, "the walk covers 10 m").toBeGreaterThanOrEqual(10);
    const worst = Math.max(...take.soles.map(Math.abs));
    expect(worst, `the sole stays within ${FEET_TOLERANCE} m of the scan's floor over the walk`).toBeLessThanOrEqual(FEET_TOLERANCE);

    // No cast lands on the old set: down every point of a grid over and past the scan, the set is the floor at y = 0 and nothing else is hit but it and the hidden ground.
    for (const cast of take.casts) {
      expect(cast.set, "the set's cast lands on the scan's floor").toBe("PlaceFloor");
      expect(Math.abs(cast.setY!), "at the floor's height").toBeLessThan(0.001);
      expect(cast.world.filter((name) => name !== "PlaceFloor" && name !== "StageGround"), "nothing of the old set is left to hit").toEqual([]);
    }

    // True scale and upright: the faint sheet lets the ray through to the red box, where the fixture put it; the opaque sheet catches it.
    const red = toSet(report, { x: fixture.middle.x + RED_BOX.x, y: fixture.floorY + 0.18, z: fixture.middle.z + RED_BOX.z });
    const faintSheet = toSet(report, { x: fixture.middle.x + FAINT_SHEET_X, y: 0, z: 0 })[0];
    const opaqueSheet = toSet(report, { x: fixture.middle.x + OPAQUE_SHEET_X, y: 0, z: 0 })[0];
    expect(take.holds.faint.landed, "the hold behind the faint sheet lands").toBe(true);
    expect(take.holds.faint.landing[0], "past the faint sheet, on the box behind it").toBeGreaterThan(faintSheet + 0.1);
    expect(Math.hypot(...take.holds.faint.landing.map((v, i) => v - red[i]!)), "on the red box, at true scale").toBeLessThan(0.3);
    expect(take.holds.opaque.landed).toBe(true);
    expect(Math.abs(take.holds.opaque.landing[0] - opaqueSheet), "the opaque sheet catches the ray").toBeLessThan(0.08);
    expect(take.errors, "capture runtime errors").toEqual([]);
  });

  test("export: RecordedPlace and HOLOIM_place v1, optional, the disc in the bubble, every splat the dome shows stored", async ({ browser, page }, testInfo) => {
    test.setTimeout(300_000);
    const take = await recordRoomTake(browser);
    const { glb, fixture, report } = take;
    expect(glb.byteLength, "the GLB is under 25 MB").toBeLessThan(MAX_GLB_BYTES);
    const json = readJson(glb);
    expect(json.extensionsUsed, "listed as used").toContain(PLACE_EXTENSION);
    expect(json.extensionsRequired ?? [], "never required").not.toContain(PLACE_EXTENSION);
    const placeIndex = json.nodes.findIndex((node) => node.name === PLACE_NODE_NAME);
    expect(placeIndex, "a RecordedPlace node").toBeGreaterThanOrEqual(0);
    const stored = await readStoredPlace(new Uint8Array(glb), readGlbChunks(new Uint8Array(glb)));
    expect(stored, "the contract's own reader takes it").not.toBeNull();
    const extension = stored!.extension;
    expect(extension.version).toBe(1);
    expect(extension.provenance).toEqual({ kind: "reconstruction", relation: "set" });
    const header = await checkSpzBytes(stored!.spz, 200_000);
    expect(header.numPoints, "the SPZ header and the extension agree").toBe(extension.splatCount);
    const bubble = json.nodes.find((node) => node.name === "RecordedSceneBubble")!;
    expect(bubble.children?.map((child) => json.nodes[child]!.name), "the floor disc is the bubble's set").toContain("RecordedPlaceFloor");
    expect(report.lastExport, "capture reports the crop").not.toBeNull();
    expect(report.lastExport!.kept).toBe(extension.splatCount);
    expect(report.lastExport!.thinned, "the room fits under the cap: nothing thinned").toBe(0);

    // The stored splats, in the file's frame, against the scan's own.
    const { centers, fractionalBits } = spzCenters(stored!.spz);
    const has = centreIndex(centers, Math.max(2 / (1 << fractionalBits), 0.002));
    const placeTrs = nodeMatrix(json.nodes[placeIndex]!);

    // Upload through the real API, with the Quick Look converter, and play it.
    const uploaded = await upload(page, "Place room", glb, true);
    expect(uploaded.status, uploaded.body).toBe(201);
    await openCard(page, uploaded);
    await expect.poll(async () => (await storedPlace(page))?.status, { timeout: 90_000, message: "the stored place draws" }).toBe("ready");
    const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
    await expect(card).toHaveAttribute("data-portal-paused", "false");
    const first = (await storedPlace(page))!;
    expect(first.splatCount, "Spark decodes every stored splat").toBe(extension.splatCount);
    const nodeWorld = new Matrix4().fromArray(first.nodeWorld);
    const modelWorld = nodeWorld.clone().multiply(placeTrs.clone().invert());

    // Pause, then seek through the take: at each time the dome the card fitted shows only stored splats, and every scan splat it shows is stored.
    const center = await cardCenter(page, uploaded.id);
    await page.mouse.click(center.x, center.y);
    await expect(card).toHaveAttribute("data-portal-paused", "true");
    await waitForFrozenTimes(page, uploaded.url);
    const length = await clipLength(page, uploaded.url);
    const world = new Vector3();
    const missing: string[] = [];
    let shownByScan = 0;
    const domeBases: Vec3[] = [];
    for (let i = 0; i <= 8; i += 1) {
      const t = (length * i) / 8;
      await seek(page, uploaded.url, Math.min(t, length - 0.01));
      const now = (await storedPlace(page))!;
      const dome = now.dome!;
      domeBases.push([dome.base.x, dome.base.y, dome.base.z]);
      const { outside, shown } = await outsideNow(page);
      expect(outside, `no stored splat shown at ${t.toFixed(2)} s leaves the dome`).toBe(0);
      expect(shown, `the place shows at ${t.toFixed(2)} s`).toBeGreaterThan(0);
      for (const splat of fixture.splats) {
        world.set(...splat.file).applyMatrix4(nodeWorld);
        if (placeClipFade(dome, world, splat.scale) <= 0.001) continue;
        shownByScan += 1;
        if (!has(splat.file)) missing.push(`${t.toFixed(2)} s: ${splat.file.map((v) => v.toFixed(3)).join(", ")}`);
      }
    }
    expect(shownByScan, "the dome shows scan splats").toBeGreaterThan(1000);
    expect(missing.slice(0, 10), `every scan splat inside the fitted dome is stored (${missing.length} missing)`).toEqual([]);
    const sweep = Math.max(...domeBases.map((b) => Math.hypot(b[0] - domeBases[0]![0], b[2] - domeBases[0]![2])));
    expect(sweep, "the dome moves with the take").toBeGreaterThan(0.5);

    // Floor and feet: the disc is hidden, the scan's floor is the disc's, the author stands on it.
    await seek(page, uploaded.url, length - 0.05);
    const end = (await storedPlace(page))!;
    expect(end.discVisible, "the disc is hidden once the splats draw").toBe(false);
    expect(Math.abs(end.floorBandY - end.discY), "the stored scan's floor lies on the disc").toBeLessThan(FEET_TOLERANCE);
    expect(Math.abs(end.feetY - end.floorBandY - take.standingFootY), "the author's feet stand on the scan's floor as they did in capture").toBeLessThan(FEET_TOLERANCE);
    await shot(page, uploaded.id, "room-end");

    // The pointing links play back where the rays landed.
    const marks = json.extensions?.HOLOIM_meaning?.marks.filter((mark) => mark.kind === "link" && mark.anchor.to.node === placeIndex) ?? [];
    expect(marks.length, "a link to the place for each hold").toBe(2);
    const landings = [take.holds.faint.landing, take.holds.opaque.landing];
    for (const [index, mark] of marks.entries()) {
      const stored = new Vector3(...mark.anchor.to.point!).applyMatrix4(placeTrs);
      const hit = new Vector3(...landings[index]!);
      expect(stored.distanceTo(hit), `link ${index}: the stored end is the hit`).toBeLessThan(LINK_TOLERANCE);
      await seek(page, uploaded.url, (mark.span.start + mark.span.end) / 2);
      await expect.poll(async () => (await inks(page, uploaded.url)).filter((link) => link.ink).length, { timeout: 15_000 }).toBeGreaterThan(0);
      const drawn = (await inks(page, uploaded.url)).find((link) => link.ink)!;
      const played = new Vector3(...drawn.ink!.to);
      const expected = hit.clone().applyMatrix4(modelWorld);
      expect(played.distanceTo(expected), `link ${index}: the end plays back within ${LINK_TOLERANCE} m of the hit`).toBeLessThan(LINK_TOLERANCE);
      await shot(page, uploaded.id, `room-link-${index}`);
    }

    // Follow, Free, zoom and Play with the place drawn.
    const follow = await readPortal(page, uploaded.url);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 180, center.y, { steps: 3 });
    await page.mouse.up();
    await expect(card).toHaveAttribute("data-portal-mode", "free");
    expect((await readPortal(page, uploaded.url)).yaw - follow.followYaw, "dragging orbits").toBeGreaterThan(0.3);
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -2000);
    await page.mouse.wheel(0, -2000);
    await expect.poll(async () => (await readPortal(page, uploaded.url)).zoom, { timeout: 10_000 }).toBe(0);
    expect((await outsideNow(page)).outside, "zoomed in, the cut holds").toBe(0);
    await shot(page, uploaded.id, "room-inside");
    await card.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView }).click();
    await expect(card).toHaveAttribute("data-portal-mode", "follow");
    await card.getByRole("button", { name: CONTROL_NAMES.play }).click();
    await expect(card).toHaveAttribute("data-portal-paused", "false");
    expect((await storedPlace(page))!.status).toBe("ready");
    await captureEvidence(page, testInfo, "place-room-feed");

    // The Quick Look converter converts a take with a place.
    await waitForUsdzReady(page.request, uploaded.id);
    await writeFile(path.join(evidenceDir, "room-report.json"), JSON.stringify({ capture: report, walked: take.walked, worstSole: Math.max(...take.soles.map(Math.abs)), holds: take.holds, viewer: end, shownByScan, sweep, glbBytes: glb.byteLength }, null, 2));
  });

  test("a GLB whose stored SPZ header lies is rejected by the API and refused by the viewer without a crash", async ({ browser, page }) => {
    test.setTimeout(240_000);
    const take = await recordRoomTake(browser);
    for (const numPoints of [take.report.lastExport!.kept + 1, 50_000_000]) {
      const rejected = await upload(page, "Place lying", withLyingHeader(take.glb, numPoints));
      expect(rejected.status, `a header claiming ${numPoints} splats is refused: ${rejected.body}`).toBe(422);
    }
    // The viewer meets one anyway (a GLB stored before the check): an honest upload served with lying bytes.
    const honest = await upload(page, "Place honest", take.glb);
    expect(honest.status).toBe(201);
    const lying = withLyingHeader(take.glb, 50_000_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route(`**${new URL(honest.url, "https://x").pathname}`, (route) => route.fulfill({ status: 200, body: lying, contentType: "model/gltf-binary" }));
    await openCard(page, honest);
    await expect.poll(async () => (await storedPlace(page))?.status, { timeout: 30_000 }).toBe("failed");
    const report = (await storedPlace(page))!;
    expect(report.error, "the header check refuses it").toMatch(/splat|header|points|cap/i);
    await expect(page.locator(`.feed-card[data-card-id="${honest.id}"]`)).toHaveAttribute("data-model-state", "rendered");
    expect(errors, "no crash").toEqual([]);
  });

  test("a broken, oversized or unreadable scan leaves today's set with one message, and Record still works", async ({ browser }) => {
    test.setTimeout(240_000);
    const room = roomFixture();
    const tiny = (count: string, comment = "") => Buffer.from(`ply\nformat binary_little_endian 1.0\n${comment}element vertex ${count}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`, "ascii");
    const noFloor = makeFixture({ half: 2, ring: { x: 0, z: 0, radius: 0 }, clutter: 0, noFloor: true });
    const files: Record<string, Buffer> = {
      "room.ply": room.bytes,
      "huge.ply": tiny("3000001"),
      "comment.ply": tiny("4000000", "comment element vertex 1\n"),
      "nofloor.ply": noFloor.bytes,
      "garbage.spz": Buffer.from(gzipSync(Buffer.from("not a scan at all, just words"))),
      "bomb.spz": (() => {
        // Ten splats' header over 8 MB of zeros: past the header's size and its 1 MiB slack, about 8 KB gzipped.
        const spz = Buffer.alloc(16 + 8_000_000);
        spz.writeUInt32LE(0x5053474e, 0);
        spz.writeUInt32LE(3, 4);
        spz.writeUInt32LE(10, 8);
        return gzipSync(spz);
      })(),
      "scan.obj": Buffer.from("v 0 0 0\n")
    };
    const { context, page, errors } = await openCapture(browser, files, "placeCapture=1");
    try {
      const before = await placeReport(page);
      expect(before?.status, "no place until one is chosen").toBe("none");
      const setBefore = before!.worldModel;
      expect(setBefore, "today's set").not.toBe("PlaceFloor");
      const cases: Array<{ name: string; pattern: RegExp }> = [
        { name: "missing.spz", pattern: /could not be fetched \(404\)/ },
        { name: "huge.ply", pattern: /over the 3,000,000/ },
        { name: "comment.ply", pattern: /over the 3,000,000/ },
        { name: "nofloor.ply", pattern: /no floor/i },
        { name: "garbage.spz", pattern: /not an SPZ stream/ },
        { name: "bomb.spz", pattern: /decompresses past what its header allows/ },
        { name: "scan.obj", pattern: /a place is a \.spz or \.ply/ }
      ];
      for (const entry of cases) {
        const loaded = await page.evaluate((url) => (window as unknown as CaptureWindow).__loadPlaceUrl(url), `${PLACE_ROUTE}${entry.name}`);
        expect(loaded, `${entry.name} is not placed`).toBe(false);
        const report = (await placeReport(page))!;
        expect(report.status, entry.name).toBe("error");
        expect(report.message, `${entry.name}: one message`).toMatch(entry.pattern);
        expect(report.worldModel, `${entry.name}: today's set stays`).toBe(setBefore);
        expect(report.groundVisible, `${entry.name}: the stage's ground still draws`).toBe(true);
        await expect(page.getByText(report.message!, { exact: false }).first(), `${entry.name}: the message is shown`).toBeVisible();
      }
      // Record still works, on today's set, and exports no place.
      const plain = await recordAndDownload(page, async () => {
        await mock(page, { forward: true });
        await advance(page, 1);
        await mock(page, { forward: false });
        await advance(page, 0.5);
      }, path.join(evidenceDir, "after-failures.glb"));
      const plainJson = readJson(plain);
      expect(plainJson.extensionsUsed ?? [], "no place after failed loads").not.toContain(PLACE_EXTENSION);
      expect(plainJson.nodes.some((node) => node.name === PLACE_NODE_NAME)).toBe(false);

      // The picker: the same room, chosen as a file.
      // The picker lives in the settings sheet, which also shows the last message.
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.getByText(/scan\.obj was not used as the place: a place is a \.spz or \.ply scan/).first(), "the place section keeps the last message").toBeVisible();
      await page.getByLabel("Choose a scanned place (.spz, .ply)").setInputFiles({ name: "room.ply", mimeType: "application/octet-stream", buffer: room.bytes });
      const picked = await waitForPlace(page, "ready");
      expect(picked.name).toBe("room.ply");
      expect(picked.splatsLoaded).toBe(room.count);
      expect(picked.worldModel).toBe("PlaceFloor");
      expect(errors, "capture runtime errors").toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("backward compatibility: main's viewer plays the place take on its disc, with the same dome", async ({ browser, page }) => {
    const mainViewer = process.env.E2E_MAIN_VIEWER_URL;
    test.skip(!mainViewer, "Serve main's viewer test build against this run's test API and set E2E_MAIN_VIEWER_URL (docs/features/splat-capture.md).");
    test.setTimeout(240_000);
    const take = await recordRoomTake(browser);
    const uploaded = await upload(page, "Place compat", take.glb);
    expect(uploaded.status, uploaded.body).toBe(201);
    await openCard(page, uploaded);
    await expect.poll(async () => (await storedPlace(page))?.status, { timeout: 90_000 }).toBe("ready");
    const here = (await fittedDome(page, uploaded.url))!;
    await shot(page, uploaded.id, "compat-this-viewer");

    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const old = await context.newPage();
      const errors: string[] = [];
      old.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      old.on("console", (message) => {
        if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
      });
      await old.setViewportSize(VIEWER_VIEWPORT);
      await installProbe(old);
      await showOnly(old, uploaded.id);
      await old.goto(mainViewer!);
      await waitForPortalReady(old, uploaded.id, uploaded.url);
      await expect.poll(async () => (await fittedDome(old, uploaded.url)) !== null, { timeout: 30_000 }).toBe(true);
      const there = (await fittedDome(old, uploaded.url))!;
      for (const key of ["x", "y", "z"] as const) {
        expect(Math.abs(here.base[key] - there.base[key]), `dome base ${key} within 1 cm of main's`).toBeLessThan(DOME_TOLERANCE);
        expect(Math.abs(here.radii[key] - there.radii[key]), `dome radius ${key} within 1 cm of main's`).toBeLessThan(DOME_TOLERANCE);
      }
      expect(there.exponent).toBe(here.exponent);
      // main knows nothing of the place: it draws the disc the take carries for it.
      const disc = await old.evaluate((target) => {
        const probes = (window as unknown as { __portalProbes: Record<string, { model: { getObjectByName: (name: string) => { visible: boolean; getObjectByName: (name: string) => { visible: boolean } | undefined } | undefined } }> }).__portalProbes;
        const model = Object.entries(probes).find(([url]) => url.endsWith(target))![1].model;
        const bubble = model.getObjectByName("RecordedSceneBubble");
        return { bubble: bubble?.visible ?? false, floor: bubble?.getObjectByName("RecordedPlaceFloor")?.visible ?? false };
      }, uploaded.url);
      expect(disc, "main plays it on the disc").toEqual({ bubble: true, floor: true });
      await old.waitForTimeout(1500);
      expect(errors, "main's viewer meets the place without an error").toEqual([]);
      await mkdir(evidenceDir, { recursive: true });
      await old.locator(`.feed-card[data-card-id="${uploaded.id}"]`).screenshot({ path: path.join(evidenceDir, "compat-main-viewer.png") });
      await writeFile(path.join(evidenceDir, "compat-report.json"), JSON.stringify({ here, there }, null, 2));
    } finally {
      await context.close();
    }
  });

  test("backward compatibility: a take without a place exports as the capture this branch starts from does", async ({ browser }) => {
    // The base, not main: main may carry export changes of its own made since (positional audio did).
    const baseCapture = process.env.E2E_BASE_CAPTURE_URL;
    test.skip(!baseCapture, "Serve the base commit's capture test build and set E2E_BASE_CAPTURE_URL (docs/features/splat-capture.md).");
    test.setTimeout(240_000);
    const scripted = async (base: string, query: string, file: string): Promise<Buffer> => {
      const { context, page, errors } = await openCapture(browser, {}, query, base);
      try {
        await advance(page, 3);
        const glb = await recordAndDownload(page, async () => {
          await mock(page, { lookYaw: 0, forward: true });
          await advance(page, 1);
          await mock(page, { forward: false, lookYaw: 0.6 });
          await advance(page, 0.6);
        }, path.join(evidenceDir, file));
        expect(errors, `${file}: capture runtime errors`).toEqual([]);
        return glb;
      } finally {
        await context.close();
      }
    };
    const today = exportSummary(await scripted(baseCapture!, "", "base-no-place.glb"));
    const plain = exportSummary(await scripted(captureUrl, "", "branch-no-place.glb"));
    const flagged = exportSummary(await scripted(captureUrl, "placeCapture=1", "branch-flag-no-place.glb"));
    await writeFile(path.join(evidenceDir, "no-place-summary.json"), JSON.stringify({ today, plain, flagged }, null, 2));
    expect(plain, "this capture exports a take as the base does").toEqual(today);
    expect(flagged, "and so with ?placeCapture=1 but no place chosen").toEqual(today);
  });

  for (const scan of ["fireplace.spz", "snow-street.spz"]) {
    test(`the downloaded scan ${scan}: recorded in, uploaded and played with its place`, async ({ browser, page }, testInfo) => {
      const file = path.join(localPlaces, scan);
      test.skip(!existsSync(file), `${scan} is not on disk (never committed): see docs/features/splat-capture.md`);
      test.setTimeout(420_000);
      const bytes = await readFile(file);
      const { context, page: capture, errors } = await openCapture(browser, { [scan]: bytes }, `placeCapture=1&place=${PLACE_ROUTE}${scan}`);
      let glb: Buffer;
      let report: PlaceReport;
      const soles: number[] = [];
      let standingFootY = Number.NaN;
      try {
        report = await waitForPlace(capture, "ready");
        expect(report.upright).not.toBe("unknown");
        expect(report.floorFound).toBe(true);
        expect(report.worldModel).toBe("PlaceFloor");
        await advance(capture, 3);
        glb = await recordAndDownload(capture, async () => {
          await walk(capture, 0, 2, report.floorBandY, soles);
          await advance(capture, 1);
          standingFootY = footBoneY(await textState(capture)) - report.floorBandY;
        }, path.join(evidenceDir, `${scan}.glb`));
        report = (await placeReport(capture))!;
        expect(errors, "capture runtime errors").toEqual([]);
      } finally {
        await context.close();
      }
      expect(Math.max(...soles.map(Math.abs)), "the sole stays on the scan's floor").toBeLessThanOrEqual(FEET_TOLERANCE);
      expect(glb.byteLength, "under 25 MB").toBeLessThan(MAX_GLB_BYTES);
      const stored = (await readStoredPlace(new Uint8Array(glb), readGlbChunks(new Uint8Array(glb))))!;
      expect(stored.extension.splatCount).toBe(report.lastExport!.kept);
      testInfo.annotations.push({ type: "crop", description: `${scan}: kept ${report.lastExport!.kept}, in box ${report.lastExport!.inBox}, thinned ${report.lastExport!.thinned}, ${(glb.byteLength / 1e6).toFixed(2)} MB` });

      const uploaded = await upload(page, `Place ${scan}`, glb);
      expect(uploaded.status, uploaded.body).toBe(201);
      await openCard(page, uploaded);
      await expect.poll(async () => (await storedPlace(page))?.status, { timeout: 180_000, message: "the stored place draws" }).toBe("ready");
      const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
      const center = await cardCenter(page, uploaded.id);
      await page.mouse.click(center.x, center.y);
      await expect(card).toHaveAttribute("data-portal-paused", "true");
      await waitForFrozenTimes(page, uploaded.url);
      // The crop's box holds the dome the card fits, wherever the take carries it.
      const json = readJson(glb);
      const placeTrs = nodeMatrix(json.nodes.find((node) => node.name === PLACE_NODE_NAME)!);
      const first = (await storedPlace(page))!;
      const modelInverse = new Matrix4().fromArray(first.nodeWorld).multiply(placeTrs.clone().invert()).invert();
      const box = report.lastExport!.box;
      const length = await clipLength(page, uploaded.url);
      for (let i = 0; i <= 6; i += 1) {
        const t = Math.min((length * i) / 6, length - 0.05);
        await seek(page, uploaded.url, t);
        const now = (await storedPlace(page))!;
        expect((await outsideNow(page)).outside, `${t.toFixed(2)} s: nothing shown leaves the dome`).toBe(0);
        const dome = now.dome!;
        const base = new Vector3(dome.base.x, dome.base.y, dome.base.z).applyMatrix4(modelInverse);
        expect(base.x - dome.radii.x, `${t.toFixed(2)} s: the dome's west edge is inside the crop`).toBeGreaterThanOrEqual(box.min[0]! - DOME_TOLERANCE);
        expect(base.x + dome.radii.x, `${t} s: east`).toBeLessThanOrEqual(box.max[0]! + DOME_TOLERANCE);
        expect(base.z - dome.radii.z, `${t} s: north`).toBeGreaterThanOrEqual(box.min[2]! - DOME_TOLERANCE);
        expect(base.z + dome.radii.z, `${t} s: south`).toBeLessThanOrEqual(box.max[2]! + DOME_TOLERANCE);
        expect(base.y + dome.radii.y, `${t} s: the top`).toBeLessThanOrEqual(box.max[1]! + DOME_TOLERANCE);
      }
      const end = (await storedPlace(page))!;
      expect(end.discVisible).toBe(false);
      expect(Math.abs(end.floorBandY - end.discY), "the stored floor lies on the disc").toBeLessThan(FEET_TOLERANCE);
      expect(Math.abs(end.feetY - end.floorBandY - standingFootY), "the author's feet on the scan's floor").toBeLessThan(FEET_TOLERANCE);
      await shot(page, uploaded.id, `${scan}-paused`);
    });
  }
});
