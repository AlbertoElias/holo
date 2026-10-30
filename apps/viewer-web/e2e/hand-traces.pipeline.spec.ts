import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

import { launchXrBrowser } from "@holoim/tooling-testing/xr-env";
import { validateHoloimMeaning } from "@holoim/meaning";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { assertViewerShell, expect, reachFor, test } from "./bootstrap";
import { animationFrames, installProbe, waitForPortalReady } from "./portal-helpers";
import { recordWalkTake } from "./pipeline-takes";
import { VIEWER_CONTROL_NAMES } from "../src/features/chrome/controlNames";
import type { HandTraceTake } from "../../capture/scripts/lib/hand-trace-takes";

// Hand traces (PRD-023, docs/features/archive/hand-traces.md): paused on a headset
// take, each moving hand's last 3 s at true scale; playing with Traces on, a
// 1 s fading tail. Every take goes through the real path: recorded and
// exported by capture (scripted IWER hands, the real headset fixture replayed,
// a desktop walk), uploaded, and shown in the feed. The numbers land in
// output/hand-traces/report.json, the pictures beside it.
// Time is driven by the primary action, so each state is read by seeking the
// paused animation, as the pointing spec does.

type Side = "left" | "right";
type Vec3 = [number, number, number];
type Snapshot = {
  time: number;
  windowStart: number;
  hipSpeeds: number[];
  hands: Record<Side, {
    drawn: boolean;
    extent: number;
    points: Array<{ t: number; p: Vec3; age: number }>;
    segments: Array<[number, number]>;
    suppressed: { outsideSpan: number; travel: number; jumps: number };
  }>;
};
type TracesReading = {
  hasTraces: boolean;
  mode: "none" | "paused" | "tail";
  time: number;
  tip: Record<Side, string | null>;
  spans: Record<Side, Array<{ start: number; end: number }>>;
  snapshot: Snapshot | null;
  visible: Record<Side, boolean>;
  chrome: boolean;
  timings: { pause: number[]; frame: number[] };
};

const DESKTOP = { width: 800, height: 520 };
const PHONE = { width: 390, height: 844 };
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/hand-traces");
const takeDir = path.join(evidenceDir, "takes");
const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const captureRoot = path.resolve(import.meta.dirname, "../../capture");

const TRAVEL_SPEED = 0.3;
const STILL_EXTENT = 0.05;
const FIDELITY_METERS = 0.002;
const RADIUS_MATCH_METERS = 0.01;
const PAUSE_BUDGET_MS = 5;
const FRAME_P95_BUDGET_MS = 0.5;

/** Each test replaces its own section, so a filtered run keeps the other tests' last results. */
async function saveReport(section: string, value: unknown): Promise<void> {
  const file = path.join(evidenceDir, "report.json");
  await mkdir(evidenceDir, { recursive: true });
  const report = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, unknown>;
  report[section] = value;
  await writeFile(file, JSON.stringify(report, null, 2));
}

// ---- takes, recorded once per worker on first use ----

const takes = new Map<string, Promise<unknown>>();
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  let entry = takes.get(key) as Promise<T> | undefined;
  if (!entry) {
    entry = make();
    takes.set(key, entry);
  }
  return entry;
}

async function inXrBrowser<T>(label: string, run: (browser: Awaited<ReturnType<typeof launchXrBrowser>>, errors: string[]) => Promise<T>): Promise<T> {
  await mkdir(takeDir, { recursive: true });
  const browser = await launchXrBrowser(chromium);
  const errors: string[] = [];
  try {
    const result = await run(browser, errors);
    expect(errors, `${label}: capture runtime errors`).toEqual([]);
    return result;
  } finally {
    await browser.close();
  }
}

function scriptedTake(scenario: "shapes" | "travel"): Promise<HandTraceTake> {
  return once(scenario, async () => {
    // Local iteration only: HAND_TRACES_REUSE_TAKES=1 reads the last recording instead of recording again.
    if (process.env.HAND_TRACES_REUSE_TAKES === "1") {
      const saved = await readFile(path.join(takeDir, `hand-traces-${scenario}-ground-truth.json`), "utf8").catch(() => null);
      if (saved) return JSON.parse(saved) as HandTraceTake;
    }
    return recordScriptedTake(scenario);
  });
}

function recordScriptedTake(scenario: "shapes" | "travel"): Promise<HandTraceTake> {
  return inXrBrowser(scenario, async (browser, consoleErrors) => {
    const { recordHandTraceTake } = await import("../../capture/scripts/lib/hand-trace-takes.ts");
    return recordHandTraceTake({ browser, baseUrl: captureUrl, artifactDir: takeDir, consoleErrors, scenario });
  });
}

function realFixtureTake(): Promise<{ glb: string; failures: string[] }> {
  return once("real", () => inXrBrowser("real fixture", async (browser, consoleErrors) => {
    const { replayPointingTake } = await import("../../capture/scripts/lib/pointing-iwer-replay.ts");
    const replay = await replayPointingTake({
      browser, baseUrl: captureUrl, captureRoot, artifactDir: takeDir, consoleErrors,
      labelsDir: "fixtures/pointing-labels", labelFile: "headset-open-fist-pinch-point-wave-reach.json"
    });
    return { glb: replay.glb, failures: replay.failures };
  }));
}

function menuTake(): Promise<{ glb: string; failures: string[] }> {
  return once("menu", () => inXrBrowser("hands summon", async (browser, consoleErrors) => {
    const { runIwerHandsSummonTake } = await import("../../capture/scripts/lib/summon-take.mjs");
    const result = await runIwerHandsSummonTake({ browser, baseUrl: captureUrl, artifactDir: takeDir, consoleErrors }) as { failures: string[] };
    return { glb: path.join(takeDir, "iwer-hands-summon.glb"), failures: result.failures };
  }));
}

// ---- GLB ----

type GltfJson = { extensions?: Record<string, unknown>; extensionsUsed?: string[]; animations?: unknown[] };

function readGlbJson(bytes: Buffer): GltfJson {
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as GltfJson;
}

/** The same GLB with its JSON chunk rewritten (padded to 4 bytes with spaces), binary chunk untouched. */
function rewriteGlbJson(bytes: Buffer, mutate: (json: GltfJson) => void): Buffer {
  const jsonLength = bytes.readUInt32LE(12);
  const json = readGlbJson(bytes);
  mutate(json);
  let text = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Math.ceil(text.length / 4) * 4;
  text = Buffer.concat([text, Buffer.alloc(padded - text.length, 0x20)]);
  const rest = bytes.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + rest.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text, rest]);
}

type MotionSpan = { kind: "motion"; bones: string[]; span: { start: number; end: number }; provenance: { value: string } };

/** The export's `HOLOIM_meaning`, validated, and its recorded hand spans. */
function signalOf(bytes: Buffer) {
  const json = readGlbJson(bytes);
  const raw = json.extensions?.HOLOIM_meaning;
  const validation = raw === undefined ? null : validateHoloimMeaning(raw);
  const spans = ((raw as { spans?: MotionSpan[] } | undefined)?.spans ?? []);
  const recorded = spans.filter((span) => span.provenance.value === "recorded");
  return {
    present: raw !== undefined,
    version: (raw as { version?: number } | undefined)?.version ?? null,
    valid: validation?.ok ?? null,
    errors: validation && !validation.ok ? validation.errors : [],
    listedInUsedOnly: (json.extensionsUsed ?? []).includes("HOLOIM_meaning") && !((json as { extensionsRequired?: string[] }).extensionsRequired ?? []).includes("HOLOIM_meaning"),
    recorded: recorded.map((span) => ({ start: span.span.start, end: span.span.end, bones: span.bones })),
    inferred: spans.length - recorded.length,
    marks: ((raw as { marks?: unknown[] } | undefined)?.marks ?? []).length
  };
}

// ---- the feed ----

async function upload(page: Page, name: string, glb: Buffer): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `${name} ${Date.now()}`,
      submittedBy: "hand-traces-e2e",
      file: { name: `${name}.glb`, mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  expect(response.ok(), "upload accepted").toBe(true);
  return (await response.json()) as { id: string; url: string };
}

async function showOnly(page: Page, ids: string[]): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: ids.map((id) => body.items.find((item) => item.id === id)).filter(Boolean), nextCursor: null } });
  });
}

/** Uploads, opens the feed with only these takes, waits for the first card. */
async function openFeed(page: Page, entries: Array<{ name: string; glb: Buffer }>): Promise<Array<{ id: string; url: string }>> {
  const uploaded = [];
  for (const entry of entries) uploaded.push(await upload(page, entry.name, entry.glb));
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  await showOnly(page, uploaded.map((u) => u.id));
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, uploaded[0]!.id, uploaded[0]!.url);
  return uploaded;
}

async function pause(page: Page, id: string): Promise<void> {
  const card = page.locator(`.feed-card[data-card-id="${id}"]`);
  await reachFor(card);
  await card.getByRole("button", { name: CONTROL_NAMES.pause }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "true");
}

/** Move the paused animation to `seconds`, as playback would have. */
async function seek(page: Page, modelPath: string, seconds: number): Promise<void> {
  await page.evaluate(([target, time]) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { time: number } | null>; mixer: { update: (d: number) => void } }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
  }, [modelPath, seconds] as const);
}

async function readTraces(page: Page, modelPath: string): Promise<TracesReading> {
  return page.evaluate((target) => {
    type Node = { visible: boolean; children: Node[]; userData: Record<string, unknown> };
    const probes = (window as unknown as { __portalProbes: Record<string, { traces: {
      hasTraces: boolean; mode: TracesReading["mode"]; time: number; tip: TracesReading["tip"]; spans: TracesReading["spans"];
      snapshot: () => Snapshot | null; group: Node | null; timings: TracesReading["timings"];
    } }> }).__portalProbes;
    const traces = Object.entries(probes).find(([url]) => url.endsWith(target))![1].traces;
    const group = traces.group;
    const ribbons = group?.children ?? [];
    return JSON.parse(JSON.stringify({
      hasTraces: traces.hasTraces,
      mode: traces.mode,
      time: traces.time,
      tip: traces.tip,
      spans: traces.spans,
      snapshot: traces.snapshot(),
      visible: { left: ribbons[0]?.visible ?? false, right: ribbons[1]?.visible ?? false },
      chrome: Boolean(group) && [group!, ...ribbons].every((node) => node.userData.holoimChrome === true),
      timings: traces.timings
    })) as TracesReading;
  }, modelPath);
}

/** Seeks, then waits for the trace to be recomputed for that moment. */
async function pausedAt(page: Page, modelPath: string, seconds: number): Promise<TracesReading> {
  await seek(page, modelPath, seconds);
  await expect.poll(async () => {
    const reading = await readTraces(page, modelPath);
    return reading.mode === "paused" && Math.abs(reading.time - seconds) < 1e-4;
  }, { timeout: 15_000 }).toBe(true);
  await animationFrames(page, 2);
  return readTraces(page, modelPath);
}

/**
 * The fingertip's world position as the mixer poses it (the card's own
 * playback, not the trace's sampler), at each clip time.
 */
async function mixerTips(page: Page, modelPath: string, side: Side, times: number[]): Promise<Vec3[]> {
  return page.evaluate(([target, hand, at]) => {
    type Node = { updateWorldMatrix: (parents: boolean, children: boolean) => void; matrixWorld: { elements: number[] } };
    const probes = (window as unknown as { __portalProbes: Record<string, {
      actions: Record<string, { time: number } | null>;
      mixer: { update: (d: number) => void };
      model: { updateMatrixWorld: (force: boolean) => void };
      traces: { tipNode: Record<string, Node | null> };
    }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    const node = probe.traces.tipNode[hand as string]!;
    const actions = Object.values(probe.actions).filter(Boolean) as Array<{ time: number }>;
    const before = actions.map((action) => action.time);
    const out: Vec3[] = [];
    for (const time of at as number[]) {
      for (const action of actions) action.time = time;
      probe.mixer.update(0);
      probe.model.updateMatrixWorld(true);
      node.updateWorldMatrix(true, false);
      const e = node.matrixWorld.elements;
      out.push([e[12]!, e[13]!, e[14]!]);
    }
    actions.forEach((action, i) => { action.time = before[i]!; });
    probe.mixer.update(0);
    return out;
  }, [modelPath, side, times] as const);
}

/** Free camera close to the author (the test scene's cloche is wide), from `yaw` around them (π faces them in these takes). */
async function closeUp(page: Page, modelPath: string, yaw = 2.7, pitch = 0.15, zoom = 0): Promise<void> {
  await page.evaluate(([target, y, p, z]) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { portal: { enterFree: () => void; orbitBy: (y: number, p: number) => void; zoomByScale: (s: number) => void; getState: () => { yaw: number; pitch: number; zoom: number }; runtime: { zoomSpan: number } } }> }).__portalProbes;
    const portal = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1].portal;
    portal.enterFree();
    const state = portal.getState();
    portal.orbitBy((y as number) - state.yaw, (p as number) - state.pitch);
    portal.zoomByScale(Math.exp((portal.getState().zoom - (z as number)) * Math.max(portal.runtime.zoomSpan, 0.4)));
  }, [modelPath, yaw, pitch, zoom] as const);
  await animationFrames(page, 30);
}

async function shot(page: Page, id: string, name: string): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.png`);
  await page.locator(`.feed-card[data-card-id="${id}"]`).screenshot({ path: file });
  return file;
}

// ---- geometry ----

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

/** Symmetric 3×3 eigenvectors by Jacobi rotation; returns the eigenvector of the smallest eigenvalue. */
function smallestEigenvector(m: number[][]): Vec3 {
  const a = m.map((row) => [...row]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p]![q]!) < 1e-15) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k += 1) {
        const akp = a[k]![p]!; const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq; a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k += 1) {
        const apk = a[p]![k]!; const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk; a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k += 1) {
        const vkp = v[k]![p]!; const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq; v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const index = [0, 1, 2].sort((i, j) => a[i]![i]! - a[j]![j]!)[0]!;
  return [v[0]![index]!, v[1]![index]!, v[2]![index]!];
}

/** Best-fit circle: plane by PCA, then an algebraic (Kåsa) fit in it. */
function fitCircle(points: Vec3[]): { radius: number; rms: number; center: Vec3 } {
  const n = points.length;
  const c = [0, 1, 2].map((k) => points.reduce((sum, p) => sum + p[k]!, 0) / n);
  const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => points.reduce((sum, p) => sum + (p[i]! - c[i]!) * (p[j]! - c[j]!), 0) / n));
  const normal = smallestEigenvector(cov);
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const u = norm(cross(normal, helper));
  const w = cross(normal, u);
  const flat = points.map((p) => {
    const d = [p[0] - c[0]!, p[1] - c[1]!, p[2] - c[2]!];
    return [d[0]! * u[0] + d[1]! * u[1] + d[2]! * u[2], d[0]! * w[0] + d[1]! * w[1] + d[2]! * w[2]] as const;
  });
  // Least squares for x² + y² = a x + b y + k.
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atb = [0, 0, 0];
  for (const [x, y] of flat) {
    const row = [x, y, 1];
    const rhs = x * x + y * y;
    for (let i = 0; i < 3; i += 1) {
      atb[i]! += row[i]! * rhs;
      for (let j = 0; j < 3; j += 1) ata[i]![j]! += row[i]! * row[j]!;
    }
  }
  const [a, b, k] = solve3(ata, atb);
  const cx = a / 2;
  const cy = b / 2;
  const radius = Math.sqrt(k + cx * cx + cy * cy);
  const rms = Math.sqrt(flat.reduce((sum, [x, y]) => sum + (Math.hypot(x - cx, y - cy) - radius) ** 2, 0) / n);
  const center: Vec3 = [c[0]! + cx * u[0] + cy * w[0], c[1]! + cx * u[1] + cy * w[1], c[2]! + cx * u[2] + cy * w[2]];
  return { radius, rms, center };
}

function solve3(m: number[][], b: number[]): [number, number, number] {
  const det = (x: number[][]) => x[0]![0]! * (x[1]![1]! * x[2]![2]! - x[1]![2]! * x[2]![1]!) - x[0]![1]! * (x[1]![0]! * x[2]![2]! - x[1]![2]! * x[2]![0]!) + x[0]![2]! * (x[1]![0]! * x[2]![1]! - x[1]![1]! * x[2]![0]!);
  const d = det(m);
  const col = (k: number) => det(m.map((row, i) => row.map((v, j) => (j === k ? b[i]! : v))));
  return [col(0) / d, col(1) / d, col(2) / d];
}

/** Drawn points of a hand (ends of drawn segments), in order. */
function drawnPoints(hand: Snapshot["hands"][Side]): Array<{ t: number; p: Vec3 }> {
  const indices = new Set<number>();
  for (const [a, b] of hand.segments) { indices.add(a); indices.add(b); }
  return [...indices].sort((a, b) => a - b).map((i) => ({ t: hand.points[i]!.t, p: hand.points[i]!.p }));
}

/** Every drawn segment's two ends lie inside one span (recorded only). */
function segmentsInSpans(hand: Snapshot["hands"][Side], spans: Array<{ start: number; end: number }>): boolean {
  return hand.segments.every(([a, b]) => spans.some((s) => hand.points[a]!.t >= s.start - 1e-4 && hand.points[b]!.t <= s.end + 1e-4));
}

/** The hip speeds at the ends of every drawn segment. */
function drawnHipSpeeds(snapshot: Snapshot): number[] {
  const speeds: number[] = [];
  for (const side of ["left", "right"] as const) {
    for (const [a, b] of snapshot.hands[side].segments) speeds.push(snapshot.hipSpeeds[a]!, snapshot.hipSpeeds[b]!);
  }
  return speeds;
}

/**
 * Capture's first frame lands a step or two after the script's t = 0. The
 * offset (and any constant frame shift) that best maps the IWER ground truth
 * onto the avatar fingertip, searched over 0–0.6 s.
 */
function align(groundTruth: HandTraceTake["groundTruth"], side: Side, tipAt: (t: number) => Vec3, duration: number) {
  let best = { offset: 0, shift: [0, 0, 0] as Vec3, rms: Infinity };
  const truth = groundTruth.filter((g) => g[side] && !g.phase.startsWith("still"));
  for (let offset = 0; offset <= 0.6; offset += 1 / 120) {
    const pairs = truth.filter((g) => g.t + offset <= duration).map((g) => ({ gt: g[side]!, tip: tipAt(g.t + offset) }));
    const shift = [0, 1, 2].map((k) => pairs.reduce((sum, pair) => sum + pair.tip[k]! - pair.gt[k]!, 0) / pairs.length) as Vec3;
    const rms = Math.sqrt(pairs.reduce((sum, pair) => sum + dist(pair.tip, [pair.gt[0] + shift[0], pair.gt[1] + shift[1], pair.gt[2] + shift[2]]) ** 2, 0) / pairs.length);
    if (rms < best.rms) best = { offset, shift, rms };
  }
  return best;
}

// ---- tests ----

test.describe("hand traces", () => {
  test.skip(() => process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API and capture.");

  test("scripted headset take: signal, presence, fidelity, shape, orbit, time, playing, control, cost", async ({ page }) => {
    test.setTimeout(360_000);
    const take = await scriptedTake("shapes");
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    expect(signal.present, "a pointing-free headset take writes HOLOIM_meaning").toBe(true);
    expect(signal.version, "still v0").toBe(0);
    expect(signal.valid, signal.errors.join("; ")).toBe(true);
    expect(signal.listedInUsedOnly).toBe(true);
    for (const side of ["left", "right"] as const) {
      const spans = signal.recorded.filter((span) => span.bones.includes(`${side}Hand`));
      expect(spans.length, `${side} recorded spans`).toBeGreaterThan(0);
      expect(spans[0]!.bones).toContain(`${side}IndexDistal`);
      for (const span of spans) expect(span.end - span.start).toBeGreaterThanOrEqual(0.25);
    }

    const [card] = await openFeed(page, [{ name: "hand-traces-shapes", glb: bytes }]);
    const { id, url } = card!;
    const cardLocator = page.locator(`.feed-card[data-card-id="${id}"]`);
    await reachFor(cardLocator);
    const toggle = cardLocator.getByRole("button", { name: VIEWER_CONTROL_NAMES.traces });
    await expect(toggle, "Traces shows on a take with recorded hand spans").toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    // Playing with Traces off: nothing drawn.
    await animationFrames(page, 10);
    const playingOff = await readTraces(page, url);
    expect(playingOff.hasTraces).toBe(true);
    expect(playingOff.mode).toBe("none");
    expect(playingOff.visible).toEqual({ left: false, right: false });

    await pause(page, id);
    const initial = await readTraces(page, url);
    await closeUp(page, url);
    expect(initial.tip, "the index end site is found on capture's rig").toEqual({ left: "tip", right: "tip" });
    const duration = await page.evaluate((target) => {
      const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { getClip: () => { duration: number } } | null> }> }).__portalProbes;
      const actions = Object.values(Object.entries(probes).find(([u]) => u.endsWith(target))![1].actions).filter(Boolean);
      return actions[0]!.getClip().duration;
    }, url);

    // Ground truth alignment: the avatar's fingertip over the whole take, posed by the mixer.
    const allTimes = Array.from({ length: Math.floor(duration * 60) + 1 }, (_, i) => i / 60);
    const tipPaths = {
      left: await mixerTips(page, url, "left", allTimes),
      right: await mixerTips(page, url, "right", allTimes)
    };
    const tipAt = (side: Side) => (t: number) => tipPaths[side][Math.min(allTimes.length - 1, Math.round(t * 60))]!;
    const alignment = { left: align(take.groundTruth, "left", tipAt("left"), duration), right: align(take.groundTruth, "right", tipAt("right"), duration) };
    const offset = alignment.right.offset;
    const phase = (name: string) => {
      const found = take.phases.find((p) => p.name === name)!;
      return { start: found.start + offset, end: found.end + offset };
    };

    const states: Record<string, unknown> = {};
    // Still: nothing drawn, however the tracked hands jittered.
    const still = await pausedAt(page, url, phase("still").end - 0.05);
    states.still = { time: still.time, left: still.snapshot!.hands.left.extent, right: still.snapshot!.hands.right.extent };
    expect(still.snapshot!.hands.left.drawn || still.snapshot!.hands.right.drawn, "nothing drawn while the hands are still").toBe(false);
    expect(still.visible).toEqual({ left: false, right: false });
    await shot(page, id, "shapes-0-still");

    // The circle: right drawn, left (still) not.
    const circleAt = phase("still-after-circle").start + 0.3;
    const circle = await pausedAt(page, url, circleAt);
    expect(circle.snapshot!.hands.right.drawn, "the circling hand shows a trace").toBe(true);
    expect(circle.snapshot!.hands.left.drawn, "the still hand shows none").toBe(false);
    expect(circle.visible).toEqual({ left: false, right: true });
    expect(circle.chrome, "the trace is flagged as chrome").toBe(true);
    expect(segmentsInSpans(circle.snapshot!.hands.right, circle.spans.right)).toBe(true);
    const rightCircle = circle.snapshot!.hands.right;
    const newestDrawn = drawnPoints(rightCircle).at(-1)!;
    expect(dist(newestDrawn.p, tipAt("right")(circleAt)), "the trace ends at the fingertip").toBeLessThan(0.002);
    expect(Math.min(...rightCircle.points.map((p) => p.t)), "window is 3 s").toBeGreaterThanOrEqual(circleAt - 3 - 1e-4);
    await shot(page, id, "shapes-1-circle");
    // Fidelity: every drawn point against the mixer-posed fingertip at the same recording time.
    const fidelity = async (reading: TracesReading, side: Side) => {
      const points = drawnPoints(reading.snapshot!.hands[side]);
      const tips = await mixerTips(page, url, side, points.map((p) => p.t));
      const errors = points.map((p, i) => dist(p.p, tips[i]!));
      return { points: points.length, maxError: round(Math.max(...errors), 6), meanError: round(errors.reduce((a, b) => a + b, 0) / errors.length, 6) };
    };
    const circleFidelity = await fidelity(circle, "right");
    expect(circleFidelity.maxError, "every drawn point within 2 mm").toBeLessThanOrEqual(FIDELITY_METERS);

    // Shape: fitted radii, drawn against the avatar fingertip's own circle and IWER's.
    const circleWindow = phase("circle");
    const drawnCircle = drawnPoints(rightCircle).filter((p) => p.t >= circleWindow.start && p.t <= circleWindow.end).map((p) => p.p);
    const avatarCircle = allTimes.filter((t) => t >= circleWindow.start && t <= circleWindow.end).map((t) => tipAt("right")(t));
    const truthCircle = take.groundTruth.filter((g) => g.phase === "circle" && g.right).map((g) => g.right!);
    const fits = { drawn: fitCircle(drawnCircle), avatar: fitCircle(avatarCircle), groundTruth: fitCircle(truthCircle) };
    expect(Math.abs(fits.drawn.radius - fits.avatar.radius), "drawn circle matches the avatar fingertip's circle within 1 cm").toBeLessThanOrEqual(RADIUS_MATCH_METERS);

    // The figure-eight: left drawn, right (still since the circle) not.
    const eightAt = phase("still-after-eight").start + 0.3;
    const eight = await pausedAt(page, url, eightAt);
    expect(eight.snapshot!.hands.left.drawn, "the figure-eight shows a trace").toBe(true);
    expect(eight.snapshot!.hands.right.drawn, "the right hand, still, shows none").toBe(false);
    const eightFidelity = await fidelity(eight, "left");
    expect(eightFidelity.maxError).toBeLessThanOrEqual(FIDELITY_METERS);
    await shot(page, id, "shapes-2-figure-eight");

    // Orbit: the same trace from two angles, close to the author.
    await closeUp(page, url, 2.5, 0.1);
    const orbitA = await readTraces(page, url);
    await shot(page, id, "shapes-3-orbit-a");
    await closeUp(page, url, 3.9, 0.45);
    const orbitB = await readTraces(page, url);
    await shot(page, id, "shapes-4-orbit-b");
    // Style: the same trace on a phone-width card keeps its minimum on-screen width.
    await page.setViewportSize(PHONE);
    await closeUp(page, url);
    await shot(page, id, "shapes-4-orbit-phone");
    await page.setViewportSize(DESKTOP);
    expect(orbitA.snapshot!.time).toBe(eightAt);
    expect(orbitB.snapshot!.hands.left.points).toEqual(orbitA.snapshot!.hands.left.points);
    expect(orbitB.visible.left).toBe(true);

    // Leaning and crouching while drawing do not suppress.
    const leanAt = phase("still-crouched").start + 0.2;
    const lean = await pausedAt(page, url, leanAt);
    const leanWindow = phase("lean-crouch-circle");
    const leanRight = lean.snapshot!.hands.right;
    expect(leanRight.drawn, "the circle drawn while leaning and crouching shows").toBe(true);
    const leanDrawnTimes = drawnPoints(leanRight).map((p) => p.t).filter((t) => t >= leanWindow.start && t <= leanWindow.end);
    expect(leanDrawnTimes.length, "drawn through the lean").toBeGreaterThan(0.8 * (leanWindow.end - leanWindow.start) * 60);
    const leanHipSpeeds = lean.snapshot!.hipSpeeds;
    await shot(page, id, "shapes-5-lean-crouch");

    // Time: scrubbing recomputes; the window clamps at the clip start and never wraps.
    const early = await pausedAt(page, url, 1.0);
    expect(early.snapshot!.windowStart).toBe(0);
    expect(Math.min(...early.snapshot!.hands.right.points.map((p) => p.t))).toBeGreaterThanOrEqual(0);
    const end = await pausedAt(page, url, duration - 0.001);
    expect(Math.max(...end.snapshot!.hands.right.points.map((p) => p.t))).toBeLessThanOrEqual(duration);
    expect(Math.min(...end.snapshot!.hands.right.points.map((p) => p.t))).toBeGreaterThanOrEqual(duration - 3.001);
    const scrubbed = await pausedAt(page, url, circleAt);
    expect(scrubbed.snapshot!.hands.right.points).toEqual(circle.snapshot!.hands.right.points);

    // Playing: Traces off shows nothing and resuming clears the paused trace; on, a ≤ 1 s fading tail.
    await seek(page, url, phase("circle").start + 0.2);
    await reachFor(cardLocator);
    await cardLocator.getByRole("button", { name: CONTROL_NAMES.play }).click();
    await expect(cardLocator).toHaveAttribute("data-portal-paused", "false");
    await animationFrames(page, 6);
    const resumed = await readTraces(page, url);
    expect(resumed.mode).toBe("none");
    expect(resumed.visible).toEqual({ left: false, right: false });
    await reachFor(cardLocator);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // Collect tail frames over a second of playback, and catch one mid-circle.
    let tailSample: TracesReading | null = null;
    for (let i = 0; i < 40; i += 1) {
      await animationFrames(page, 3);
      const reading = await readTraces(page, url);
      if (reading.mode === "tail" && reading.snapshot?.hands.right.drawn && !tailSample) {
        tailSample = reading;
        await shot(page, id, "shapes-6-tail");
      }
    }
    const tail = await readTraces(page, url);
    expect(tail.mode).toBe("tail");
    expect(tailSample, "a tail drew behind the circling hand").not.toBeNull();
    const tailPoints = tailSample!.snapshot!.hands.right.points;
    expect(Math.min(...tailPoints.map((p) => p.t)), "tail at most 1 s").toBeGreaterThanOrEqual(tailSample!.snapshot!.time - 1 - 1e-4);
    await reachFor(cardLocator);
    await toggle.click();
    await animationFrames(page, 4);
    expect((await readTraces(page, url)).visible).toEqual({ left: false, right: false });

    // Cost: the card probe's own performance.now() timings.
    const costs = {
      pauseMs: { count: tail.timings.pause.length, max: round(Math.max(...tail.timings.pause), 3), p50: round(percentile(tail.timings.pause, 0.5), 3) },
      tailFrameMs: { count: tail.timings.frame.length, p95: round(percentile(tail.timings.frame, 0.95), 3), max: round(Math.max(...tail.timings.frame), 3) }
    };
    expect(costs.pauseMs.max, "under 5 ms per pause or scrub").toBeLessThan(PAUSE_BUDGET_MS);
    expect(costs.tailFrameMs.count).toBeGreaterThan(20);
    expect(costs.tailFrameMs.p95, "p95 under 0.5 ms per frame with the tail on").toBeLessThan(FRAME_P95_BUDGET_MS);

    const avatarVsTruth = (side: Side, phaseName: string) => {
      const a = alignment[side];
      const errors = take.groundTruth.filter((g) => g.phase === phaseName && g[side]).map((g) => {
        const gt = g[side]!;
        return dist(tipAt(side)(g.t + a.offset), [gt[0] + a.shift[0], gt[1] + a.shift[1], gt[2] + a.shift[2]]);
      });
      return { samples: errors.length, mean: round(errors.reduce((x, y) => x + y, 0) / errors.length), max: round(Math.max(...errors)) };
    };
    await saveReport("shapes", {
      glb: take.glb,
      signal: { ...signal, recorded: signal.recorded.map((s) => ({ start: s.start, end: s.end, bones: s.bones.length, hand: s.bones[0] })) },
      tip: initial.tip,
      duration,
      alignment: { left: { ...alignment.left, rms: round(alignment.left.rms) }, right: { ...alignment.right, rms: round(alignment.right.rms) } },
      presence: {
        still: states.still,
        circle: { time: circleAt, right: rightCircle.extent, left: circle.snapshot!.hands.left.extent },
        figureEight: { time: eightAt, left: eight.snapshot!.hands.left.extent, right: eight.snapshot!.hands.right.extent },
        stillThreshold: STILL_EXTENT
      },
      fidelity: { circle: circleFidelity, figureEight: eightFidelity, limit: FIDELITY_METERS },
      shape: {
        circleRadius: { drawn: round(fits.drawn.radius), avatar: round(fits.avatar.radius), groundTruth: round(fits.groundTruth.radius), scripted: 0.15, drawnMinusAvatar: round(fits.drawn.radius - fits.avatar.radius) },
        circleFitRms: { drawn: round(fits.drawn.rms), avatar: round(fits.avatar.rms), groundTruth: round(fits.groundTruth.rms) },
        avatarFingertipVsIwer: { circle: avatarVsTruth("right", "circle"), figureEight: avatarVsTruth("left", "figure-eight"), leanCrouch: avatarVsTruth("right", "lean-crouch-circle") }
      },
      leanCrouch: { time: leanAt, drawnSamplesInLean: leanDrawnTimes.length, travelSuppressed: leanRight.suppressed.travel, hipSpeed: { max: round(Math.max(...leanHipSpeeds)), p95: round(percentile(leanHipSpeeds, 0.95)) } },
      time: { clampAt1s: early.snapshot!.windowStart, endOfClip: { time: end.time, windowStart: end.snapshot!.windowStart }, scrubBackMatches: true },
      playing: { offMode: resumed.mode, tail: { time: tailSample!.snapshot!.time, oldest: Math.min(...tailPoints.map((p) => p.t)), points: tailPoints.length } },
      cost: costs,
      screenshots: ["shapes-0-still", "shapes-1-circle", "shapes-2-figure-eight", "shapes-3-orbit-a", "shapes-4-orbit-b", "shapes-5-lean-crouch", "shapes-6-tail"].map((n) => `${n}.png`)
    });
  });

  test("scripted headset travel: walking, a teleport and a snap turn draw nothing; controllers are not hands; per-card control", async ({ page }) => {
    test.setTimeout(360_000);
    const take = await scriptedTake("travel");
    const shapes = await scriptedTake("shapes");
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    expect(signal.valid).toBe(true);
    // The second of controllers is cut out of both hands' spans.
    const controllers = take.phases.find((p) => p.name === "controllers")!;
    for (const side of ["left", "right"] as const) {
      const spans = signal.recorded.filter((span) => span.bones.includes(`${side}Hand`));
      expect(spans.length, `${side}: a span before and after the controllers`).toBe(2);
      expect(spans[0]!.end).toBeLessThan(controllers.start + 0.6);
      expect(spans[1]!.start).toBeGreaterThan(controllers.end - 0.1);
    }

    const [travelCard, shapesCard] = await openFeed(page, [{ name: "hand-traces-travel", glb: bytes }, { name: "hand-traces-shapes-2", glb: await readFile(shapes.glb) }]);
    const { id, url } = travelCard!;
    await pause(page, id);
    await closeUp(page, url, 2.2, 0.3, 0.3);
    const duration = await page.evaluate((target) => {
      const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { getClip: () => { duration: number } } | null> }> }).__portalProbes;
      return Object.values(Object.entries(probes).find(([u]) => u.endsWith(target))![1].actions).find(Boolean)!.getClip().duration;
    }, url);
    const times = Array.from({ length: Math.floor(duration * 60) + 1 }, (_, i) => i / 60);
    const rightPath = await mixerTips(page, url, "right", times);
    // Alignment over the circles drawn standing still (walking and jumps move the frame).
    const standing = take.groundTruth.filter((g) => g.phase !== "walk-circle" && g.phase !== "controllers" && g.t < 4.9);
    const { offset } = align(standing, "right", (t) => rightPath[Math.min(times.length - 1, Math.round(t * 60))]!, duration);
    const phase = (name: string) => {
      const found = take.phases.find((p) => p.name === name)!;
      return { start: found.start + offset, end: found.end + offset };
    };
    const results: Record<string, unknown> = {};
    const check = async (name: string, at: number, window: { start: number; end: number }, shotName: string) => {
      const reading = await pausedAt(page, url, at);
      const snap = reading.snapshot!;
      const right = snap.hands.right;
      // No drawn segment where the hips travel faster than 0.3 m/s.
      const speeds = drawnHipSpeeds(snap);
      expect(Math.max(0, ...speeds), `${name}: no segment drawn while travelling`).toBeLessThanOrEqual(TRAVEL_SPEED);
      // No drawn segment spans a jump: neighbouring drawn points are a frame's motion apart.
      const steps = right.segments.map(([a, b]) => dist(right.points[a]!.p, right.points[b]!.p));
      expect(Math.max(0, ...steps), `${name}: no segment across a jump`).toBeLessThan(0.05);
      const inWindow = right.points.filter((p) => p.t >= window.start && p.t <= window.end).length;
      const drawnInWindow = drawnPoints(right).filter((p) => p.t >= window.start && p.t <= window.end).length;
      await shot(page, id, shotName);
      results[name] = {
        events: { jumps: right.suppressed.jumps, travel: right.suppressed.travel },
        time: at,
        hipSpeed: { max: round(Math.max(...snap.hipSpeeds)), p50: round(percentile(snap.hipSpeeds, 0.5)), p95: round(percentile(snap.hipSpeeds, 0.95)), histogram: histogram(snap.hipSpeeds) },
        samplesInEvent: inWindow,
        drawnInEvent: drawnInWindow,
        suppressed: right.suppressed,
        drawnSegments: right.segments.length,
        maxDrawnStep: round(Math.max(0, ...steps)),
        drawnHipSpeedMax: round(Math.max(0, ...speeds))
      };
      // Written before this event's expectations, so a failure still leaves its numbers.
      await saveReport("travel", { offset, ...results });
      return { reading, drawnInWindow, inWindow, right };
    };
    const walk = await check("walk", phase("still-after-walk").start + 0.3, phase("walk-circle"), "travel-0-walk");
    expect(walk.right.suppressed.travel, "walking samples are suppressed by hip speed").toBeGreaterThan(30);
    expect(walk.drawnInWindow / walk.inWindow, "almost nothing drawn while walking").toBeLessThan(0.15);
    // Teleport: capture's respawn steps the recorded root in one frame; the trace breaks there.
    const teleport = await check("teleport", phase("still-after-teleport").start + 0.3, { start: 5 + offset - 0.05, end: 5 + offset + 0.05 }, "travel-1-teleport");
    expect(teleport.right.suppressed.jumps, "the teleport's root step breaks the trace").toBeGreaterThan(0);
    // Snap turn: capture turns its rig and records the take in the rig's frame, so the
    // export's body stays still while the arms snap to the turned hands in one frame.
    expect(take.locomotion?.snapCount, "capture took the snap turn").toBe(1);
    const snap = await check("snapTurn", phase("still-after-snap").start + 0.3, { start: 8 + offset - 0.05, end: 8 + offset + 0.05 }, "travel-2-snap-turn");
    expect(snap.right.suppressed.jumps, "the snap turn breaks the trace").toBeGreaterThan(0);
    // The circles either side of each event still draw.
    expect(teleport.right.drawn && snap.right.drawn, "drawing before and after a teleport or snap turn still shows").toBe(true);
    // Controllers: nothing drawn from their second.
    const ctrl = await pausedAt(page, url, phase("controllers").end - 0.05);
    const ctrlTimes = drawnPoints(ctrl.snapshot!.hands.right).map((p) => p.t);
    expect(ctrlTimes.every((t) => !(t > phase("controllers").start + 0.25 && t < phase("controllers").end - 0.05)), "no trace from controller frames").toBe(true);

    // The Traces control is per card: switching it on one leaves the other off.
    const cardLocator = page.locator(`.feed-card[data-card-id="${id}"]`);
    await reachFor(cardLocator);
    await cardLocator.getByRole("button", { name: VIEWER_CONTROL_NAMES.traces }).click();
    const perCard = await page.evaluate(([a, b]) => {
      const probes = (window as unknown as { __portalProbes: Record<string, { portal: { getState: () => { traces: boolean; hasTraces: boolean } } }> }).__portalProbes;
      const state = (target: string) => Object.entries(probes).find(([u]) => u.endsWith(target))?.[1].portal.getState() ?? null;
      return { travel: state(a!), shapes: state(b!) };
    }, [url, shapesCard!.url]);
    expect(perCard.travel?.traces).toBe(true);
    expect(perCard.shapes?.traces ?? false).toBe(false);

    await saveReport("travel", { glb: take.glb, locomotion: take.locomotion, signal: { recorded: signal.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0] })) }, offset, events: take.events, ...results, controllers: { window: phase("controllers"), drawnInside: 0 }, perCard });
  });

  test("real headset fixture: traces from replayed real hand tracking", async ({ page }) => {
    test.setTimeout(360_000);
    const take = await realFixtureTake();
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    expect(signal.valid).toBe(true);
    expect(signal.recorded.length, "the replayed real hands give recorded spans").toBeGreaterThan(0);
    const [card] = await openFeed(page, [{ name: "hand-traces-real", glb: bytes }]);
    await pause(page, card!.id);
    await closeUp(page, card!.url);
    const readings = [];
    const allSpeeds: number[] = [];
    for (const [name, at] of [["fist", 3.7], ["point", 5.0], ["pinch", 6.8], ["wave", 8.4], ["reach", 9.2]] as const) {
      const reading = await pausedAt(page, card!.url, at);
      const snap = reading.snapshot!;
      allSpeeds.push(...snap.hipSpeeds);
      expect(Math.max(0, ...drawnHipSpeeds(snap))).toBeLessThanOrEqual(TRAVEL_SPEED);
      for (const side of ["left", "right"] as const) expect(segmentsInSpans(snap.hands[side], reading.spans[side])).toBe(true);
      await shot(page, card!.id, `real-${name}`);
      readings.push({ name, time: at, left: { drawn: snap.hands.left.drawn, extent: round(snap.hands.left.extent), suppressed: snap.hands.left.suppressed }, right: { drawn: snap.hands.right.drawn, extent: round(snap.hands.right.extent), suppressed: snap.hands.right.suppressed } });
    }
    expect(readings.some((r) => r.left.drawn || r.right.drawn), "a real gesture shows a trace").toBe(true);
    await saveReport("realFixture", {
      glb: take.glb,
      replayScoreFailures: take.failures,
      recordedSpans: signal.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0] })),
      readings,
      hipSpeed: { max: round(Math.max(...allSpeeds)), p50: round(percentile(allSpeeds, 0.5)), p95: round(percentile(allSpeeds, 0.95)), histogram: histogram(allSpeeds) }
    });
  });

  test("desktop, inferred-only and older takes show no traces and play unchanged; menus are not hands", async ({ page, browser }, testInfo) => {
    test.setTimeout(360_000);
    const shapes = await scriptedTake("shapes");
    const shapesBytes = await readFile(shapes.glb);
    const desktop = await once("desktop", () => recordWalkTake(browser, testInfo));
    const desktopSignal = signalOf(desktop.bytes);
    expect(desktopSignal.recorded, "a desktop take writes no recorded hand spans").toEqual([]);
    const inferredOnly = rewriteGlbJson(shapesBytes, (json) => {
      const meaning = json.extensions!.HOLOIM_meaning as { spans: MotionSpan[] };
      meaning.spans = meaning.spans.map((span) => ({ ...span, provenance: { value: "inferred" } }));
    });
    const noMeaning = rewriteGlbJson(shapesBytes, (json) => {
      delete json.extensions!.HOLOIM_meaning;
      json.extensionsUsed = (json.extensionsUsed ?? []).filter((name) => name !== "HOLOIM_meaning");
    });
    expect(signalOf(inferredOnly).valid).toBe(true);

    // Hands in the tray menu are cut out of recorded spans.
    const menu = await menuTake();
    const menuBytes = await readFile(menu.glb);
    const menuSignal = signalOf(menuBytes);
    const authoring = ((readGlbJson(menuBytes).extensions?.HOLOIM_objects as { authoring?: Array<{ hand: Side; start: number; end: number }> } | undefined)?.authoring ?? []);
    expect(authoring.length, "the hands summon take has hands-in-menu spans").toBeGreaterThan(0);
    const overlaps = authoring.flatMap((menuSpan) => menuSignal.recorded
      .filter((span) => span.bones.includes(`${menuSpan.hand}Hand`))
      .map((span) => Math.min(span.end, menuSpan.end) - Math.max(span.start, menuSpan.start))
      .filter((overlap) => overlap > 1 / 30));
    expect(overlaps, "no recorded hand span overlaps that hand's menu span").toEqual([]);

    const negatives = [
      { name: "desktop", glb: desktop.bytes },
      { name: "inferred-only", glb: inferredOnly },
      { name: "no-meaning", glb: noMeaning }
    ];
    const results: Record<string, unknown> = {};
    for (const negative of negatives) {
      const [card] = await openFeed(page, [{ name: `hand-traces-${negative.name}`, glb: negative.glb }]);
      const cardLocator = page.locator(`.feed-card[data-card-id="${card!.id}"]`);
      await reachFor(cardLocator);
      await expect(cardLocator.getByRole("button", { name: VIEWER_CONTROL_NAMES.traces }), `${negative.name}: no Traces control`).toHaveCount(0);
      const playing = await page.evaluate((target) => {
        const probes = (window as unknown as { __portalProbes: Record<string, { traces: { hasTraces: boolean; group: unknown }; actions: Record<string, { time: number } | null> }> }).__portalProbes;
        const entry = Object.entries(probes).find(([u]) => u.endsWith(target))![1];
        return { hasTraces: entry.traces.hasTraces, group: entry.traces.group !== null, time: Object.values(entry.actions).find(Boolean)?.time ?? 0 };
      }, card!.url);
      await animationFrames(page, 20);
      const later = await page.evaluate((target) => {
        const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { time: number } | null> }> }).__portalProbes;
        return Object.values(Object.entries(probes).find(([u]) => u.endsWith(target))![1].actions).find(Boolean)?.time ?? 0;
      }, card!.url);
      expect(playing.hasTraces, `${negative.name}: no traces`).toBe(false);
      expect(playing.group, `${negative.name}: nothing mounted`).toBe(false);
      expect(later, `${negative.name}: plays`).not.toBe(playing.time);
      await pause(page, card!.id);
      await shot(page, card!.id, `negative-${negative.name}`);
      results[negative.name] = { hasTraces: playing.hasTraces, mounted: playing.group, plays: later !== playing.time, control: false };
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    await saveReport("olderAndOther", {
      desktopSignal: { present: desktopSignal.present, recorded: desktopSignal.recorded.length },
      menu: { glb: menu.glb, takeFailures: menu.failures, authoring, recorded: menuSignal.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0] })), overlaps },
      ...results
    });
  });
});

function histogram(values: number[]): Record<string, number> {
  const bins = [0.05, 0.1, 0.2, 0.3, 0.5, 1, Infinity];
  const out: Record<string, number> = {};
  for (const value of values) {
    const bin = bins.find((edge) => value <= edge)!;
    const key = bin === Infinity ? ">1" : `<=${bin}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
