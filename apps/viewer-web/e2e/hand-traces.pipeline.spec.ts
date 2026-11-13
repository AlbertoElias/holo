import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { chromium, type Page } from "@playwright/test";

import { launchXrBrowser } from "@holoim/tooling-testing/xr-env";
import { validateHoloimMeaning } from "@holoim/meaning";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { assertViewerShell, expect, reachFor, test } from "./bootstrap";
import { animationFrames, installProbe, waitForPortalReady } from "./portal-helpers";
import { recordWalkTake } from "./pipeline-takes";
import type { HandTraceTake } from "../../capture/scripts/lib/hand-trace-takes";

// Author-marked hand traces (PRD-023 v1, docs/features/authored-traces.md).
// The author turns the headset Halo's Ink on and off while recording; each
// ended trace is stored as a `trace` mark per moving hand, and the feed
// portal draws it in with its original timing and keeps it until the take
// loops. Every take goes through the real path: recorded and exported by
// capture (scripted IWER hands summoning the real hands Halo, the real
// headset fixture replayed, a desktop walk), uploaded, and shown in the feed.
// The numbers land in output/authored-traces/report.json, the pictures
// beside it. Playback is sampled on every rendered frame; paused states are
// read by seeking the paused animation, as the pointing spec does.

type Side = "left" | "right";
type Vec3 = [number, number, number];
type Span = { start: number; end: number };
type Suppressed = { outsideSpan: number; travel: number; jumps: number };
type MarkProbe = {
  side: Side; bone: string; node: number; span: Span;
  drawn: boolean; drawnPoints: number; headTime: number | null; headPosition: Vec3 | null; extent: number; suppressed: Suppressed;
};
type SnapshotMark = {
  side: Side; drawn: boolean; extent: number;
  points: Array<{ time: number; position: Vec3; hipSpeed: number }>;
  segments: Array<[number, number]>;
  suppressed: Suppressed;
};
type Snapshot = { time: number; marks: SnapshotMark[] };
type TracesReading = {
  hasTraces: boolean;
  mode: "none" | "drawing";
  time: number;
  marks: MarkProbe[];
  spans: Record<Side, Span[]>;
  snapshot: Snapshot | null;
  visible: boolean[];
  chrome: boolean;
  mounted: boolean;
  timings: { frame: number[]; pause: number[]; warmSync: number[] };
};
/** One rendered frame of playback: the clip time and, per mark, what it drew and where the fingertip is. */
type PlayedFrame = {
  time: number;
  paused: boolean;
  marks: Array<{ drawn: boolean; drawnPoints: number; headTime: number | null; head: Vec3 | null; tipAtHead: Vec3 | null; node: Vec3 }>;
};

const DESKTOP = { width: 800, height: 520 };
const PHONE = { width: 390, height: 844 };
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const evidenceDir = path.join(repoRoot, "output/authored-traces");
const takeDir = path.join(evidenceDir, "takes");
const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const captureRoot = path.resolve(import.meta.dirname, "../../capture");

const TRAVEL_SPEED = 0.3;
const STILL_EXTENT = 0.05;
const FIDELITY_METERS = 0.002;
const RADIUS_MATCH_METERS = 0.01;
const PAUSE_BUDGET_MS = 5;
const FRAME_P95_BUDGET_MS = 0.5;
/** Capture's settle for the hand that summoned the Halo (SUMMONING_HAND_SETTLE_SEC in PointResolver). */
const SETTLE_SEC = 0.4;
/** Playback speed of the second, dense pass over each span. */
const SLOW_SCALE = 0.2;
/** One script step of the scripted takes, s. */
const STEP_SEC = 1 / 60;
// The cost budgets hold on a dev machine (v0: pause 1.4 ms max, tail p95 0.2 ms).
// A 4-vCPU hosted runner measured 6.3 ms and 0.5 ms, so CI only records them.
const costBudgetsEnforced = !process.env.CI;

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

/** Local iteration only: HAND_TRACES_REUSE_TAKES=1 reads the last recording instead of recording again. */
const reuse = process.env.HAND_TRACES_REUSE_TAKES === "1";

function scriptedTake(scenario: "authored" | "shapes" | "travel"): Promise<HandTraceTake> {
  return once(scenario, async () => {
    if (reuse) {
      const saved = await readFile(path.join(takeDir, `hand-traces-${scenario}-ground-truth.json`), "utf8").catch(() => null);
      if (saved) return JSON.parse(saved) as HandTraceTake;
    }
    return inXrBrowser(scenario, async (browser, consoleErrors) => {
      const { recordHandTraceTake } = await import("../../capture/scripts/lib/hand-trace-takes.ts");
      return recordHandTraceTake({ browser, baseUrl: captureUrl, artifactDir: takeDir, consoleErrors, scenario });
    });
  });
}

/** Ink around the real take's wave and its reach (fixtures/pointing-labels: wave 6.9–8.4 s, reach 8.4–9.27 s), through the automation hook. */
const REAL_INK = [6.85, 8.35, 8.45, 9.15];

function realFixtureTake(): Promise<{ glb: string; failures: string[]; toggles: Array<{ t: number; done: boolean }> }> {
  return once("real", async () => {
    const file = path.join(takeDir, "hand-traces-real.json");
    if (reuse) {
      const saved = await readFile(file, "utf8").catch(() => null);
      if (saved) return JSON.parse(saved) as { glb: string; failures: string[]; toggles: Array<{ t: number; done: boolean }> };
    }
    return inXrBrowser("real fixture", async (browser, consoleErrors) => {
      const { replayPointingTake } = await import("../../capture/scripts/lib/pointing-iwer-replay.ts");
      const toggles: Array<{ t: number; done: boolean }> = [];
      const replay = await replayPointingTake({
        browser, baseUrl: captureUrl, captureRoot, artifactDir: takeDir, consoleErrors,
        labelsDir: "fixtures/pointing-labels", labelFile: "headset-open-fist-pinch-point-wave-reach.json",
        onStep: async (page, timeSec) => {
          while (toggles.length < REAL_INK.length && timeSec >= REAL_INK[toggles.length]!) {
            toggles.push({ t: timeSec, done: await page.evaluate(() => window.__runHaloAction("ink", "hands")) });
          }
        }
      });
      const result = { glb: replay.glb, failures: replay.failures, toggles };
      await writeFile(file, JSON.stringify(result));
      return result;
    });
  });
}

// ---- GLB ----

type GltfJson = {
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  nodes?: Array<{ name?: string }>;
  animations?: Array<{ samplers: Array<{ input: number }> }>;
  accessors?: Array<{ count: number; max?: number[]; min?: number[] }>;
};

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

type MotionSpan = { kind: "motion"; bones: string[]; span: Span; provenance: { value: string } };
type RawMark = { kind?: string; anchor: { bone?: string; node?: number; from?: unknown }; span: Span; provenance: { value: string } };
type TraceMark = { side: Side; bone: string; node: number; nodeName: string | null; span: Span; provenance: string };

/** The export's `HOLOIM_meaning`, validated: recorded hand spans, trace marks, and the clip's frame interval. */
function signalOf(bytes: Buffer) {
  const json = readGlbJson(bytes);
  const raw = json.extensions?.HOLOIM_meaning as { version?: number; spans?: MotionSpan[]; marks?: RawMark[] } | undefined;
  const validation = raw === undefined ? null : validateHoloimMeaning(raw);
  const spans = raw?.spans ?? [];
  const recorded = spans.filter((span) => span.provenance.value === "recorded");
  const marks = raw?.marks ?? [];
  const traces: TraceMark[] = marks.filter((mark) => mark.kind === "trace").map((mark) => ({
    side: mark.anchor.bone!.startsWith("left") ? "left" : "right",
    bone: mark.anchor.bone!,
    node: mark.anchor.node!,
    nodeName: json.nodes?.[mark.anchor.node!]?.name ?? null,
    span: mark.span,
    provenance: mark.provenance.value
  }));
  const input = json.animations?.[0]?.samplers[0]?.input;
  const accessor = input === undefined ? undefined : json.accessors?.[input];
  const frameSec = accessor && accessor.count > 1 ? (accessor.max![0]! - accessor.min![0]!) / (accessor.count - 1) : null;
  return {
    present: raw !== undefined,
    version: raw?.version ?? null,
    valid: validation?.ok ?? null,
    errors: validation && !validation.ok ? validation.errors : [],
    listedInUsedOnly: (json.extensionsUsed ?? []).includes("HOLOIM_meaning") && !(json.extensionsRequired ?? []).includes("HOLOIM_meaning"),
    extensionsRequired: json.extensionsRequired ?? [],
    recorded: recorded.map((span) => ({ start: span.span.start, end: span.span.end, bones: span.bones })),
    inferred: spans.length - recorded.length,
    links: marks.filter((mark) => mark.kind !== "trace").length,
    traces,
    frameSec,
    duration: accessor?.max?.[0] ?? null,
    raw
  };
}
type Signal = ReturnType<typeof signalOf>;

const recordedFor = (signal: Signal, side: Side) => signal.recorded.filter((span) => span.bones.includes(`${side}Hand`));

/** Capture's simulation clock at script second `t` (the nearest step): it runs a little ahead of the script's steps. */
function simAt(take: HandTraceTake, t: number): number {
  const i = Math.min(take.groundTruth.length - 1, Math.max(0, Math.round(t / STEP_SEC)));
  return take.groundTruth[i]!.sim;
}

/**
 * The take's first frame on capture's clock (clip time = clock − this). Read
 * from the marks: each starts on the first recorded frame at or after its
 * trace's start (plus the settle for the summoning hand), so trace start
 * minus mark start lies within one frame below it.
 */
function takeStartSim(take: HandTraceTake, signal: Signal, kept: Array<{ startSec: number; onSide: Side | null }>): number {
  const first = take.groundTruth[0]!.sim;
  const diffs: number[] = [];
  for (const mark of signal.traces) {
    const candidates = kept.map((trace) => trace.startSec + (trace.onSide === mark.side ? SETTLE_SEC : 0) - mark.span.start).filter((d) => Math.abs(d - first) < 0.3);
    if (candidates.length > 0) diffs.push(candidates.reduce((a, b) => (Math.abs(a - first) < Math.abs(b - first) ? a : b)));
  }
  expect(diffs.length, "every trace mark starts at a kept trace's start").toBe(signal.traces.length);
  return Math.max(...diffs);
}

/** A script phase in clip seconds. */
function clipPhase(take: HandTraceTake, t0: number, name: string): Span {
  const found = take.phases.find((p) => p.name === name)!;
  return { start: simAt(take, found.start) - t0, end: simAt(take, found.end) - t0 };
}

// ---- main's meaning module, for the older-viewer check ----

/**
 * The last `packages/meaning` on main before v2 (versions 0 and 1), pinned
 * so the check still means "a viewer built before this change" once v2 is
 * on main.
 */
const PRE_V2_MEANING_COMMIT = "6e264a3e814cd3102fa759558b98c63de474a3ca";

/** That `packages/meaning`, copied under output/ and imported; null when the clone lacks the commit (a shallow checkout). */
async function mainMeaning(): Promise<null | { validateHoloimMeaning: typeof validateHoloimMeaning; encodeHoloimMeaning: (record: { marks: unknown[]; spans: unknown[] }) => unknown; versions: readonly number[] }> {
  const dir = path.join(evidenceDir, "main-meaning");
  await mkdir(dir, { recursive: true });
  for (const name of ["meaning.ts", "humanoid.ts"]) {
    let source: string;
    try {
      source = execFileSync("git", ["show", `${PRE_V2_MEANING_COMMIT}:packages/meaning/src/${name}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
    await writeFile(path.join(dir, name), source.replace(/from "\.\/humanoid\.js"/g, 'from "./humanoid.ts"'));
  }
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ type: "module", private: true }));
  // zod resolves from packages/meaning's own dependencies.
  await symlink(path.join(repoRoot, "packages/meaning/node_modules"), path.join(dir, "node_modules")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const module = (await import(path.join(dir, "meaning.ts"))) as { validateHoloimMeaning: typeof validateHoloimMeaning; encodeHoloimMeaning: (record: { marks: unknown[]; spans: unknown[] }) => unknown; HOLOIM_MEANING_VERSIONS: readonly number[] };
  return { validateHoloimMeaning: module.validateHoloimMeaning, encodeHoloimMeaning: module.encodeHoloimMeaning, versions: module.HOLOIM_MEANING_VERSIONS };
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

/** Moves the animation to `seconds`, as playback would have. */
async function seek(page: Page, modelPath: string, seconds: number): Promise<void> {
  await page.evaluate(([target, time]) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { time: number } | null>; mixer: { update: (d: number) => void } }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
  }, [modelPath, seconds] as const);
}

async function clipDuration(page: Page, modelPath: string): Promise<number> {
  return page.evaluate((target) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { getClip: () => { duration: number } } | null> }> }).__portalProbes;
    return Object.values(Object.entries(probes).find(([u]) => u.endsWith(target))![1].actions).find(Boolean)!.getClip().duration;
  }, modelPath);
}

async function readTraces(page: Page, modelPath: string): Promise<TracesReading> {
  return page.evaluate((target) => {
    type Node = { visible: boolean; children: Node[]; userData: Record<string, unknown> };
    const probes = (window as unknown as { __portalProbes: Record<string, { traces: {
      hasTraces: boolean; mode: TracesReading["mode"]; time: number; marks: MarkProbe[]; spans: TracesReading["spans"];
      snapshot: () => Snapshot | null; group: Node | null; timings: TracesReading["timings"];
    } }> }).__portalProbes;
    const traces = Object.entries(probes).find(([url]) => url.endsWith(target))![1].traces;
    const group = traces.group;
    const ribbons = group?.children ?? [];
    return JSON.parse(JSON.stringify({
      hasTraces: traces.hasTraces,
      mode: traces.mode,
      time: traces.time,
      marks: traces.marks,
      spans: traces.spans,
      snapshot: traces.snapshot(),
      visible: ribbons.map((ribbon) => ribbon.visible),
      chrome: Boolean(group) && [group!, ...ribbons].every((node) => node.userData.holoimChrome === true),
      mounted: group !== null,
      timings: traces.timings
    })) as TracesReading;
  }, modelPath);
}

/** Seeks the paused animation, then waits for the traces to be drawn for that moment. */
async function pausedAt(page: Page, modelPath: string, seconds: number): Promise<TracesReading> {
  await seek(page, modelPath, seconds);
  await expect.poll(async () => Math.abs((await readTraces(page, modelPath)).time - seconds) < 1e-5, { timeout: 15_000 }).toBe(true);
  await animationFrames(page, 2);
  return readTraces(page, modelPath);
}

/** The mark's fingertip node's world position as the mixer poses it (the card's own playback, not the trace's sampler), at each clip time. */
async function mixerTips(page: Page, modelPath: string, mark: number, times: number[]): Promise<Vec3[]> {
  return page.evaluate(([target, index, at]) => {
    type Node = { updateWorldMatrix: (parents: boolean, children: boolean) => void; matrixWorld: { elements: number[] } };
    const probes = (window as unknown as { __portalProbes: Record<string, {
      actions: Record<string, { time: number } | null>;
      mixer: { update: (d: number) => void };
      model: { updateMatrixWorld: (force: boolean) => void };
      traces: { tipNode: Array<Node | null> };
    }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    const node = probe.traces.tipNode[index as number]!;
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
  }, [modelPath, mark, times] as const);
}

/**
 * Records every rendered frame of the card's own playback: the clip time
 * and, per mark, the probe's drawn state, the sampler's fingertip at the
 * drawn end, and the mixer-posed fingertip node as last rendered. Starts
 * at clip second `from` and stops at `until` (in the next loop when `loop`),
 * playing at `timeScale` (a busy host renders few frames a second, so a
 * span is also played slowed to be sampled densely).
 */
async function recordPlayback(page: Page, modelPath: string, options: { from: number; until: number; loop: boolean; timeScale: number }, timeoutMs: number): Promise<PlayedFrame[]> {
  await page.evaluate(([target, opts]) => {
    const { from, until, loop, timeScale } = opts as { from: number; until: number; loop: boolean; timeScale: number };
    type Node = { matrixWorld: { elements: number[] } };
    const probes = (window as unknown as { __portalProbes: Record<string, {
      actions: Record<string, { time: number; timeScale: number } | null>;
      portal: { getState: () => { paused: boolean } };
      traces: { marks: MarkProbe[]; time: number; tipNode: Array<Node | null>; tipAt: ((mark: number, time: number) => Vec3) | null };
    }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) {
      if (!action) continue;
      action.time = from;
      action.timeScale = timeScale;
    }
    const frames: PlayedFrame[] = [];
    const state = { frames, done: false, wrapped: false, last: -1 };
    (window as unknown as { __playRecord: typeof state }).__playRecord = state;
    const tick = () => {
      const traces = probe.traces;
      const time = traces.time;
      if (state.last >= 0 && time < state.last - 0.5) state.wrapped = true;
      state.last = time;
      frames.push({
        time,
        paused: probe.portal.getState().paused,
        marks: traces.marks.map((mark, i) => {
          const e = traces.tipNode[i]!.matrixWorld.elements;
          return {
            drawn: mark.drawn,
            drawnPoints: mark.drawnPoints,
            headTime: mark.headTime,
            head: mark.headPosition ? [...mark.headPosition] as Vec3 : null,
            tipAtHead: mark.headTime !== null && traces.tipAt ? traces.tipAt(i, mark.headTime) : null,
            node: [e[12]!, e[13]!, e[14]!]
          };
        })
      });
      if ((loop ? state.wrapped : true) && time > until) {
        state.done = true;
        for (const action of Object.values(probe.actions)) if (action) action.timeScale = 1;
      } else requestAnimationFrame(tick);
    };
    // Two frames in, so the seek has been played.
    requestAnimationFrame(() => requestAnimationFrame(tick));
  }, [modelPath, options] as const);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __playRecord: { done: boolean } }).__playRecord.done), { timeout: timeoutMs, intervals: [1000] }).toBe(true);
  return page.evaluate(() => (window as unknown as { __playRecord: { frames: PlayedFrame[] } }).__playRecord.frames);
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
  return `${name}.png`;
}

/** No card offers v0's Traces control, and the portal store carries no traces state. */
async function noTracesControl(page: Page, modelPath: string, id: string): Promise<{ control: number; storeKeys: string[] }> {
  const card = page.locator(`.feed-card[data-card-id="${id}"]`);
  await reachFor(card);
  const control = await card.getByRole("button", { name: /trace/i }).filter({ hasNotText: /^Delete/ }).count();
  const storeKeys = await page.evaluate((target) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { portal: { getState: () => Record<string, unknown> } }> }).__portalProbes;
    const state = Object.entries(probes).find(([u]) => u.endsWith(target))![1].portal.getState();
    return Object.keys(state).filter((key) => /trace/i.test(key));
  }, modelPath);
  return { control, storeKeys };
}

// ---- geometry ----

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const round = (value: number, digits = 4) => Number(value.toFixed(digits));
const percentile = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};
const maxOf = (values: number[]) => values.reduce((a, b) => Math.max(a, b), 0);

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
function fitCircle(points: Vec3[]): { radius: number; rms: number } {
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
  return { radius, rms };
}

function solve3(m: number[][], b: number[]): [number, number, number] {
  const det = (x: number[][]) => x[0]![0]! * (x[1]![1]! * x[2]![2]! - x[1]![2]! * x[2]![1]!) - x[0]![1]! * (x[1]![0]! * x[2]![2]! - x[1]![2]! * x[2]![0]!) + x[0]![2]! * (x[1]![0]! * x[2]![1]! - x[1]![1]! * x[2]![0]!);
  const d = det(m);
  const col = (k: number) => det(m.map((row, i) => row.map((v, j) => (j === k ? b[i]! : v))));
  return [col(0) / d, col(1) / d, col(2) / d];
}

/** Largest distance of any point from the last (PRD-023's spatial extent). */
function extentOf(points: Vec3[]): number {
  const last = points.at(-1);
  return last ? maxOf(points.map((p) => dist(p, last))) : 0;
}

/** Drawn points of a mark (ends of drawn segments), in order. */
function drawnPoints(mark: SnapshotMark): Array<{ time: number; position: Vec3 }> {
  const indices = new Set<number>();
  for (const [a, b] of mark.segments) { indices.add(a); indices.add(b); }
  return [...indices].sort((a, b) => a - b).map((i) => mark.points[i]!);
}

/** Every drawn segment's two ends lie inside the mark's span and inside one recorded span of its side. */
function segmentsInSpans(mark: SnapshotMark, span: Span, recorded: Span[]): boolean {
  return mark.segments.every(([a, b]) => {
    const ta = mark.points[a]!.time;
    const tb = mark.points[b]!.time;
    return ta >= span.start - 1e-4 && tb <= span.end + 1e-4 && recorded.some((s) => ta >= s.start - 1e-4 && tb <= s.end + 1e-4);
  });
}

function drawnHipSpeeds(mark: SnapshotMark): number[] {
  return mark.segments.flatMap(([a, b]) => [mark.points[a]!.hipSpeed, mark.points[b]!.hipSpeed]);
}

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

/** The ground truth fingertip of `side` between two readings of capture's clock. */
function truthPath(take: HandTraceTake, side: Side, fromSim: number, toSim: number): Vec3[] {
  return take.groundTruth.filter((g) => g.sim >= fromSim - 1e-9 && g.sim <= toSim + 1e-9 && g[side]).map((g) => g[side]!);
}
const pathLength = (points: Vec3[]) => points.slice(1).reduce((sum, p, i) => sum + dist(p, points[i]!), 0);

// ---- the authored take, as scripted ----

type Expected = { side: Side; on: number; off: number; trimStart: boolean; trimEnd: boolean; name: string };

/** The traces the authored script should leave, in start order, with the toggles on capture's clock. */
function expectedAuthored(take: HandTraceTake): { kept: Array<{ on: number; off: number }>; marks: Expected[] } {
  const by = (name: string) => take.summons.find((s) => s.name === name)!;
  const kept = [
    { on: by("ink-on-1").releaseSim, off: by("ink-off-1").pressSim },
    { on: by("ink-on-2").releaseSim, off: by("ink-off-2").pressSim },
    { on: by("ink-on-3").releaseSim, off: by("ink-off-3").pressSim },
    { on: by("ink-on-5").releaseSim, off: by("stop").pressSim }
  ];
  return {
    kept,
    marks: [
      { name: "right circle", side: "right", ...kept[0]!, trimStart: true, trimEnd: true },
      { name: "left circle", side: "left", ...kept[1]!, trimStart: false, trimEnd: false },
      { name: "redone right line", side: "right", ...kept[2]!, trimStart: true, trimEnd: true },
      { name: "stop-ended left line", side: "left", ...kept[3]!, trimStart: false, trimEnd: false }
    ]
  };
}

const phaseOf = (take: HandTraceTake, name: string) => take.phases.find((p) => p.name === name)!;

// ---- tests ----

test.describe("author-marked hand traces", () => {
  test.skip(() => process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API and capture.");

  test("authored headset take: Ink by the hands Halo, status line, live trace, stored marks", async () => {
    test.setTimeout(360_000);
    const take = await scriptedTake("authored");
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    const expected = expectedAuthored(take);
    const report: Record<string, unknown> = { glb: take.glb, pinchGaps: take.pinchGaps };

    // The Halo did what each summon asked, in order.
    const actions = take.final.actions.map((a) => `${a.input}:${a.action}:${a.done}`);
    const wanted = take.summons.map((s) => `hands:${s.action}:true`);
    report.actions = { actual: actions, expected: wanted };
    expect(actions, "every summon committed its action through the hands Halo").toEqual(wanted);

    // Capture's trace store: four kept, one undone, each on at the commit and off at the press.
    const store = take.final.kept!;
    const kept = store.kept;
    expect(kept.length, "kept traces: the circle, the left circle, the redone line, the stop-ended one").toBe(4);
    // Undo while tracing removed the open trace (it could be redone until the next Ink on cleared that).
    const afterUndoing = take.chrome.find((c) => Math.abs(c.t - (take.summons.find((x) => x.name === "undo-while-tracing")!.release + STEP_SEC)) < 1e-6)!.traces;
    expect({ open: afterUndoing.open, kept: afterUndoing.kept.length, undone: afterUndoing.undone }, "undo while tracing ends and removes the open trace").toEqual({ open: null, kept: 3, undone: 1 });
    expect(store.undone, "the next Ink on cleared what could be redone").toBe(0);
    const toggleTiming = kept.map((trace, i) => {
      const want = expected.kept[i]!;
      return {
        startSec: round(trace.startSec, 4), endSec: round(trace.endSec, 4),
        startMinusCommitSteps: round((trace.startSec - want.on) / STEP_SEC, 2),
        endMinusPressSteps: round((trace.endSec - want.off) / STEP_SEC, 2),
        onSide: trace.onSide, offSide: trace.offSide
      };
    });
    report.store = { kept: toggleTiming, undone: store.undone,  openAfterStop: take.final.afterStop?.open ?? null };
    for (const [i, timing] of toggleTiming.entries()) {
      expect(Math.abs(timing.startMinusCommitSteps), `trace ${i} starts at its Ink-on commit`).toBeLessThanOrEqual(1);
      expect(Math.abs(timing.endMinusPressSteps), `trace ${i} ends at the press of the Halo that ended it`).toBeLessThanOrEqual(1);
      expect([timing.onSide, timing.offSide], `trace ${i}: the right hand summoned both Halos`).toEqual(["right", "right"]);
    }
    expect(take.final.afterStop?.open ?? null, "stopping ended it").toBeNull();
    expect(take.final.nextTake?.open ?? null, "the next take starts with tracing off").toBeNull();
    expect(take.final.nextTake?.tracingElapsedMs ?? null, "the next take's status has no trace time").toBeNull();
    expect(take.final.inkWhileStopped?.done, "Ink while not recording changes nothing").toBe(false);
    expect(take.final.inkWhileStopped?.notice, "and says so").toBe("Ink traces while recording");

    // Status line: "Recording m:ss · Tracing m:ss" while a trace is open, the trace time counting from the commit.
    const statusRows = take.chrome.filter((c) => c.status !== null);
    const statusFailures: string[] = [];
    const tracingPattern = /^Recording (\d+):(\d\d) · Tracing (\d+):(\d\d)/;
    let tracingRows = 0;
    let plainRows = 0;
    // The status line is laid out before the step's Halo action runs, so it catches up a step after each commit; after S the take is over.
    const stopAt = take.summons.find((x) => x.name === "stop")!.release;
    const justCommitted = (t: number) => take.summons.some((x) => t >= x.release - 1e-9 && t < x.release + 2 * STEP_SEC);
    for (const row of statusRows) {
      const open = row.traces.open;
      if (row.t >= stopAt - 1e-9 || justCommitted(row.t)) continue;
      const match = tracingPattern.exec(row.status!);
      if (open) {
        const elapsed = row.sim - open.startSec;
        if (elapsed < 2 * STEP_SEC) continue;
        tracingRows += 1;
        if (!match) { statusFailures.push(`t=${row.t.toFixed(3)} open trace, status ${JSON.stringify(row.status)}`); continue; }
        const shown = Number(match[3]) * 60 + Number(match[4]);
        if (Math.abs(shown - Math.floor(elapsed)) > 1 || row.tracingElapsedMs === null || Math.abs(row.tracingElapsedMs - elapsed * 1000) > 1100) statusFailures.push(`t=${row.t.toFixed(3)} tracing ${elapsed.toFixed(2)} s shown as ${match[3]}:${match[4]} (${row.tracingElapsedMs} ms)`);
      } else {
        plainRows += 1;
        if (!/^Recording \d+:\d\d/.test(row.status!) || / · Tracing \d/.test(row.status!) || row.tracingElapsedMs !== null) statusFailures.push(`t=${row.t.toFixed(3)} no trace, status ${JSON.stringify(row.status)}`);
      }
    }
    // What each toggle said, read the step after its release.
    const said = take.summons.map((s) => ({ action: s.action, direction: s.direction, notice: take.chrome.find((c) => Math.abs(c.t - (s.release + STEP_SEC)) < 1e-6)?.notice ?? null }));
    const nearest = (at: number) => statusRows.reduce((best, c) => (Math.abs(c.t - at) < Math.abs(best.t - at) ? c : best), statusRows[0]!);
    // Late in each, so the action's notice has gone.
    const midCircle = nearest(phaseOf(take, "right-circle").start + 1.6);
    const afterOff = nearest(phaseOf(take, "figure-eight").start + 1.8);
    report.statusLine = { tracingRows, plainRows, failures: statusFailures.slice(0, 10), said, midCircle: { t: midCircle.t, text: midCircle.status }, afterOff: { t: afterOff.t, text: afterOff.status } };
    expect(statusFailures, "status line while tracing and after").toEqual([]);
    expect(tracingRows).toBeGreaterThan(50);
    expect(said.map((s) => s.notice), "what each Halo action said").toEqual(["Tracing", "Trace kept", "Tracing", "Trace kept", "Tracing", "Trace kept", "Trace undone", "Trace restored", "Tracing", "Trace undone", "Tracing", null]);
    expect(midCircle.status).toMatch(/^Recording \d:\d\d · Tracing \d:\d\d$/);
    expect(afterOff.status).toMatch(/^Recording \d:\d\d$/);

    // Live trace: drawn behind the hand that moved, cleared when the trace ends, is undone, or the take stops.
    const liveIn = (from: number, to: number) => take.chrome.filter((c) => c.t >= from && c.t <= to);
    const drawnShare = (rows: typeof take.chrome, side: Side) => rows.length === 0 ? 0 : rows.filter((r) => r.live.hands[side].drawn).length / rows.length;
    const circle = phaseOf(take, "right-circle");
    const leftCircle = phaseOf(take, "left-circle");
    const eight = phaseOf(take, "figure-eight");
    const line1 = phaseOf(take, "right-line-1");
    const late = (p: { start: number; end: number }) => liveIn(p.start + 0.5 * (p.end - p.start), p.end);
    const live = {
      rightCircle: { right: drawnShare(late(circle), "right"), left: drawnShare(late(circle), "left") },
      figureEight: { tracing: liveIn(eight.start, eight.end).some((r) => r.live.tracing), right: drawnShare(liveIn(eight.start, eight.end), "right"), left: drawnShare(liveIn(eight.start, eight.end), "left") },
      leftCircle: { left: drawnShare(late(leftCircle), "left"), right: drawnShare(late(leftCircle), "right"), rightExtent: round(maxOf(late(leftCircle).map((r) => r.live.hands.right.extent))) },
      rightLine: { right: drawnShare(liveIn(line1.end - 0.05, line1.end + 0.15), "right"), left: drawnShare(liveIn(line1.end - 0.05, line1.end + 0.15), "left") },
      clearedAfter: take.summons.filter((s) => ["ink-off-1", "ink-off-2", "ink-off-3", "undo-while-tracing"].includes(s.name)).map((s) => {
        const row = take.chrome.find((c) => Math.abs(c.t - (s.release + STEP_SEC)) < 1e-6);
        return { name: s.name, tracing: row?.live.tracing ?? null, points: row ? row.live.hands.left.points + row.live.hands.right.points : null };
      }),
      afterStop: take.final.liveAfterStop
    };
    report.liveTrace = live;
    expect(live.rightCircle, "while the right index circles, its trace shows and the resting left's does not").toEqual({ right: 1, left: 0 });
    expect(live.figureEight, "the untraced figure-eight shows nothing").toEqual({ tracing: false, right: 0, left: 0 });
    expect(live.leftCircle.left, "the left circle's trace shows").toBe(1);
    expect(live.rightLine.right, "the short right line's trace shows").toBe(1);
    expect(live.rightLine.left).toBe(0);
    expect(live.clearedAfter, "the live trace clears when the trace ends or is undone").toEqual(live.clearedAfter.map((row) => ({ name: row.name, tracing: false, points: 0 })));
    expect({ tracing: live.afterStop?.tracing, points: (live.afterStop?.hands.left.points ?? -1) + (live.afterStop?.hands.right.points ?? -1) }, "and when the take stops").toEqual({ tracing: false, points: 0 });

    // The export: v2, valid, in extensionsUsed only.
    report.signal = { present: signal.present, version: signal.version, valid: signal.valid, errors: signal.errors, listedInUsedOnly: signal.listedInUsedOnly, extensionsRequired: signal.extensionsRequired, links: signal.links, recorded: signal.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0], bones: s.bones.length })), frameSec: signal.frameSec, duration: signal.duration };
    expect(signal.present).toBe(true);
    expect(signal.version, "a take with a trace writes version 2").toBe(2);
    expect(signal.valid, signal.errors.join("; ")).toBe(true);
    expect(signal.listedInUsedOnly).toBe(true);
    expect(signal.extensionsRequired).toEqual([]);
    for (const side of ["left", "right"] as const) expect(recordedFor(signal, side).length, `${side} recorded hand spans`).toBeGreaterThan(0);

    // Marks: one per moving hand per kept trace, nothing for the still hands, the figure-eight or the undone line.
    const t0 = takeStartSim(take, signal, kept);
    const frame = signal.frameSec!;
    const clip = (sim: number) => sim - t0;
    const marks = signal.traces.map((mark, i) => {
      const want = expected.marks[i];
      const start = want ? clip(want.on) + (want.trimStart ? SETTLE_SEC : 0) : NaN;
      const end = want ? clip(want.off) - (want.trimEnd ? SETTLE_SEC : 0) : NaN;
      return {
        name: want?.name ?? null, side: mark.side, bone: mark.bone, node: mark.node, nodeName: mark.nodeName, provenance: mark.provenance,
        span: mark.span, expected: { start: round(start), end: round(end) },
        startLateFrames: round((mark.span.start - start) / frame, 2), endEarlyFrames: round((end - mark.span.end) / frame, 2)
      };
    });
    // The summoning hand: what the 0.4 s settle trims at each end of a right-hand Halo's trace, and what it keeps.
    const summoningHand = expected.kept.map((trace, i) => {
      const inside = truthPath(take, "right", trace.on + SETTLE_SEC, trace.off - SETTLE_SEC);
      const leadIn = truthPath(take, "right", trace.on, trace.on + SETTLE_SEC);
      const tail = truthPath(take, "right", trace.off - SETTLE_SEC, trace.off);
      return {
        trace: i, trimmedLeadInSec: SETTLE_SEC, trimmedTailSec: SETTLE_SEC,
        leadIn: { samples: leadIn.length, extent: round(extentOf(leadIn)), length: round(pathLength(leadIn)) },
        tail: { samples: tail.length, extent: round(extentOf(tail)), length: round(pathLength(tail)) },
        kept: { samples: inside.length, extent: round(extentOf(inside)), length: round(pathLength(inside)) },
        rightMark: marks.some((m) => m.side === "right" && m.name !== null && expected.marks.find((e) => e.name === m.name)!.on === trace.on)
      };
    });
    const untraced = { figureEight: clipPhase(take, t0, "figure-eight"), undoneLine: clipPhase(take, t0, "right-line-2") };
    const scriptDrift = { simAtStart: round(take.groundTruth[0]!.sim, 4), simAtEnd: round(take.groundTruth.at(-1)!.sim, 4), scriptSec: round(take.groundTruth.at(-1)!.t, 4) };
    report.marks = { takeStartSim: round(t0, 5), takeStartMinusFirstStepSteps: round((t0 - take.groundTruth[0]!.sim) / STEP_SEC, 2), clockVsScript: scriptDrift, frameSec: round(frame, 5), marks, summoningHand, untraced };
    await saveReport("authoredCapture", report);

    expect(marks.map((m) => m.side), "marks: right circle, left circle, the redone right line, the stop-ended left line").toEqual(["right", "left", "right", "left"]);
    for (const mark of marks) {
      expect(mark.bone, `${mark.name}: anchored on the index distal`).toBe(`${mark.side}IndexDistal`);
      expect(mark.nodeName, `${mark.name}: an exported node`).not.toBeNull();
      expect(mark.provenance).toBe("recorded");
      expect(mark.startLateFrames, `${mark.name}: starts within one frame of its toggle`).toBeGreaterThanOrEqual(-0.05);
      expect(mark.startLateFrames).toBeLessThanOrEqual(1.05);
      expect(mark.endEarlyFrames, `${mark.name}: ends within one frame of its toggle`).toBeGreaterThanOrEqual(-0.05);
      expect(mark.endEarlyFrames).toBeLessThanOrEqual(1.05);
    }
    for (const mark of signal.traces) {
      const overlap = (s: { start: number; end: number }) => Math.min(mark.span.end, s.end) - Math.max(mark.span.start, s.start);
      expect(overlap(untraced.figureEight), "no mark over the untraced figure-eight").toBeLessThanOrEqual(0);
      expect(overlap(untraced.undoneLine), "no mark over the line undone while tracing").toBeLessThanOrEqual(0);
    }
    expect(summoningHand[1]!.kept.extent, "the left circle's trace: the summoning right hand is still inside the kept span").toBeLessThan(STILL_EXTENT);
  });

  test("authored take in the feed: draws in with its timing, stays, pauses and scrubs alike, loops clear, fidelity, cost", async ({ page }) => {
    test.setTimeout(360_000);
    const take = await scriptedTake("authored");
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    const kept = take.final.kept!.kept;
    const t0 = takeStartSim(take, signal, kept);
    const phase = (name: string) => clipPhase(take, t0, name);

    const [card] = await openFeed(page, [{ name: "authored-traces", glb: bytes }]);
    const { id, url } = card!;
    const controls = await noTracesControl(page, url, id);
    expect(controls, "no Traces control, no traces state in the portal store").toEqual({ control: 0, storeKeys: [] });
    await expect.poll(async () => (await readTraces(page, url)).hasTraces, { timeout: 15_000 }).toBe(true);
    const initial = await readTraces(page, url);
    expect(initial.marks.map((m) => ({ side: m.side, bone: m.bone, node: m.node, span: m.span })), "one ribbon per stored mark").toEqual(signal.traces.map((m) => ({ side: m.side, bone: m.bone, node: m.node, span: m.span })));
    expect(initial.chrome, "the traces are flagged as chrome").toBe(true);
    const duration = await clipDuration(page, url);
    const marks = initial.marks;

    // Playing: every rendered frame over a whole loop and into the next.
    const played = await recordPlayback(page, url, { from: 0, until: Math.max(0.6, marks[0]!.span.start + 0.4), loop: true, timeScale: 1 }, (duration + 30) * 1000 * 3);
    const wrapAt = played.findIndex((f, i) => i > 0 && f.time < played[i - 1]!.time - 0.5);
    const firstLoop = played.slice(0, wrapAt);
    const nextLoop = played.slice(wrapAt);
    // Each span again, played at a fifth of its speed from just before it to just after.
    const slowed: PlayedFrame[] = [];
    for (const mark of marks) slowed.push(...(await recordPlayback(page, url, { from: Math.max(0, mark.span.start - 0.25), until: mark.span.end + 0.25, loop: false, timeScale: SLOW_SCALE }, ((mark.span.end - mark.span.start + 0.5) / SLOW_SCALE + 60) * 1000)));
    const sampled = [...firstLoop, ...slowed];
    const playing = marks.map((mark, m) => {
      const before = sampled.filter((f) => f.time < mark.span.start - 1e-6);
      const during = sampled.filter((f) => f.time >= mark.span.start && f.time <= mark.span.end).sort((a, b) => a.time - b.time);
      const after = sampled.filter((f) => f.time > mark.span.end + 1e-6);
      const drawnDuring = during.filter((f) => f.marks[m]!.drawn);
      const headTimeError = drawnDuring.map((f) => Math.abs(f.marks[m]!.headTime! - f.time));
      const headVsSampler = drawnDuring.map((f) => dist(f.marks[m]!.head!, f.marks[m]!.tipAtHead!));
      const headVsMixer = drawnDuring.filter((f) => Math.abs(f.marks[m]!.headTime! - f.time) < 1e-5).map((f) => dist(f.marks[m]!.head!, f.marks[m]!.node));
      const afterPoints = [...new Set(after.map((f) => f.marks[m]!.drawnPoints))];
      return {
        side: mark.side, span: mark.span,
        before: { frames: before.length, drawn: before.filter((f) => f.marks[m]!.drawn || f.marks[m]!.drawnPoints > 0).length },
        during: { frames: during.length, drawn: drawnDuring.length, headTimeErrorMax: round(maxOf(headTimeError), 6), headVsOwnSamplerMaxM: round(maxOf(headVsSampler), 6), headVsMixerMaxM: round(maxOf(headVsMixer), 6), headVsMixerFrames: headVsMixer.length, drawnPointsGrow: drawnDuring.every((f, i) => i === 0 || f.marks[m]!.drawnPoints >= drawnDuring[i - 1]!.marks[m]!.drawnPoints) },
        after: { frames: after.length, notDrawn: after.filter((f) => !f.marks[m]!.drawn).length, drawnPoints: afterPoints, headAtEnd: after.every((f) => f.marks[m]!.headTime !== null && Math.abs(f.marks[m]!.headTime! - mark.span.end) < 1e-4) },
        nextLoopBeforeSpan: { frames: nextLoop.filter((f) => f.time < mark.span.start).length, drawn: nextLoop.filter((f) => f.time < mark.span.start && f.marks[m]!.drawn).length }
      };
    });
    const frameTimes = firstLoop.map((f) => f.time);
    const frameSteps = frameTimes.slice(1).map((t, i) => t - frameTimes[i]!);
    const playingSummary = { frames: played.length, slowedFrames: slowed.length, slowScale: SLOW_SCALE, firstLoopFrames: firstLoop.length, nextLoopFrames: nextLoop.length, medianFrameSec: round(percentile(frameSteps, 0.5), 4), maxFrameSec: round(maxOf(frameSteps), 4), duration: round(duration, 4) };
    await saveReport("authoredViewer", { playing: { summary: playingSummary, marks: playing } });
    for (const [m, entry] of playing.entries()) {
      const label = `mark ${m} (${entry.side})`;
      expect(entry.before.drawn, `${label}: nothing drawn before its span`).toBe(0);
      expect(entry.during.frames, `${label}: frames sampled inside its span`).toBeGreaterThan(10);
      expect(entry.during.drawn / entry.during.frames, `${label}: drawing during its span`).toBeGreaterThan(0.8);
      expect(entry.during.headTimeErrorMax, `${label}: the drawn end is at the clip time`).toBeLessThan(1e-4);
      expect(entry.during.headVsOwnSamplerMaxM, `${label}: the ribbon agrees with its own sampler (consistency only; fidelity is the mixer check below)`).toBeLessThanOrEqual(FIDELITY_METERS);
      expect(entry.during.headVsMixerMaxM, `${label}: the drawn end is at the mixer-posed fingertip`).toBeLessThanOrEqual(FIDELITY_METERS);
      expect(entry.during.drawnPointsGrow, `${label}: draws in`).toBe(true);
      expect(entry.after.notDrawn, `${label}: whole after its span`).toBe(0);
      expect(entry.after.drawnPoints.length, `${label}: unchanged after its span`).toBe(1);
      expect(entry.nextLoopBeforeSpan.frames, `${label}: frames sampled after the loop restart`).toBeGreaterThan(0);
      expect(entry.nextLoopBeforeSpan.drawn, `${label}: cleared at the loop restart`).toBe(0);
    }
    // Untraced: whatever is drawn at any frame has its drawn end inside its own mark's span.
    const outside = [...played, ...slowed].flatMap((f) => f.marks.map((state, m) => ({ f, state, m }))).filter(({ state, m }) => state.headTime !== null && (state.headTime < marks[m]!.span.start - 1e-6 || state.headTime > marks[m]!.span.end + 1e-6));
    expect(outside.length, "nothing drawn outside a mark's span").toBe(0);

    // Paused or scrubbed: exactly what playing to that moment drew.
    await pause(page, id);
    await closeUp(page, url);
    const pick = (at: number) => sampled.reduce((best, f) => (Math.abs(f.time - at) < Math.abs(best.time - at) ? f : best), firstLoop[0]!);
    const pausedChecks: Array<Record<string, unknown>> = [];
    const comparePaused = async (name: string, at: number) => {
      const frameAt = pick(at);
      const reading = await pausedAt(page, url, frameAt.time);
      const diffs = reading.marks.map((mark, m) => {
        const playedMark = frameAt.marks[m]!;
        return {
          drawn: mark.drawn === playedMark.drawn,
          drawnPoints: mark.drawnPoints === playedMark.drawnPoints,
          headTime: (mark.headTime ?? -1) === (playedMark.headTime ?? -1) || Math.abs((mark.headTime ?? -1) - (playedMark.headTime ?? -1)) < 1e-6,
          head: mark.headPosition === null ? playedMark.head === null : playedMark.head !== null && dist(mark.headPosition, playedMark.head) < 1e-6
        };
      });
      const same = diffs.every((d) => d.drawn && d.drawnPoints && d.headTime && d.head);
      pausedChecks.push({ name, time: round(frameAt.time, 5), same, drawn: reading.marks.map((m) => m.drawnPoints) });
      return { reading, same };
    };
    const midCircle = await comparePaused("mid right circle", phase("right-circle").start + 1.0);
    const shots: string[] = [await shot(page, id, "authored-1-mid-circle")];
    const duringEight = await comparePaused("during the untraced figure-eight", phase("figure-eight").start + 1.6);
    shots.push(await shot(page, id, "authored-2-figure-eight-untraced"));
    await comparePaused("mid left circle", phase("left-circle").start + 1.0);
    const afterAll = await comparePaused("after every span", marks.at(-1)!.span.end + 0.2);
    shots.push(await shot(page, id, "authored-3-after-all"));
    // Scrub back and forth: the same moment draws the same.
    const scrubbedAway = await pausedAt(page, url, phase("left-circle").start + 0.5);
    const scrubbedBack = await pausedAt(page, url, pick(phase("right-circle").start + 1.0).time);
    const scrubSame = JSON.stringify(scrubbedBack.snapshot) === JSON.stringify(midCircle.reading.snapshot);
    expect(pausedChecks.every((c) => c.same), `paused equals playing: ${JSON.stringify(pausedChecks)}`).toBe(true);
    expect(scrubSame, "scrubbing back draws the same").toBe(true);
    expect(scrubbedAway.time).not.toBe(scrubbedBack.time);
    // During the figure-eight only the right circle shows (whole), and none of its points is in the figure-eight.
    const eightSnap = duringEight.reading.snapshot!;
    const eightWindow = phase("figure-eight");
    expect(eightSnap.marks.map((m) => m.drawn), "during the figure-eight, only the finished right circle shows").toEqual([true, false, false, false]);
    expect(eightSnap.marks[0]!.points.every((p) => p.time <= marks[0]!.span.end + 1e-6 && (p.time < eightWindow.start || p.time > eightWindow.end))).toBe(true);

    // Fidelity: every drawn point against the mixer-posed fingertip at the same recording time; recorded only.
    const final = afterAll.reading.snapshot!;
    const fidelity = [];
    for (const [m, mark] of final.marks.entries()) {
      const points = drawnPoints(mark);
      const tips = await mixerTips(page, url, m, points.map((p) => p.time));
      const errors = points.map((p, i) => dist(p.position, tips[i]!));
      const recorded = afterAll.reading.spans[mark.side];
      fidelity.push({ mark: m, side: mark.side, points: points.length, maxError: round(maxOf(errors), 6), meanError: round(errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length), 6), inSpans: segmentsInSpans(mark, marks[m]!.span, recorded), allPointsInSpan: mark.points.every((p) => p.time >= marks[m]!.span.start - 1e-6 && p.time <= marks[m]!.span.end + 1e-6), extent: round(mark.extent) });
    }
    for (const entry of fidelity) {
      expect(entry.points, `mark ${entry.mark}: drawn`).toBeGreaterThan(10);
      expect(entry.maxError, `mark ${entry.mark}: every drawn point within 2 mm`).toBeLessThanOrEqual(FIDELITY_METERS);
      expect(entry.inSpans, `mark ${entry.mark}: drawn segments inside its span and a recorded hand span`).toBe(true);
      expect(entry.allPointsInSpan, `mark ${entry.mark}: nothing outside its span`).toBe(true);
    }

    // Shape: the right circle's fitted radius against the avatar fingertip's own circle and IWER's.
    const circleWindow = phase("right-circle");
    const drawnCircle = drawnPoints(final.marks[0]!).filter((p) => p.time >= circleWindow.start && p.time <= circleWindow.end).map((p) => p.position);
    const avatarTimes = Array.from({ length: Math.floor((circleWindow.end - circleWindow.start) * 60) + 1 }, (_, i) => circleWindow.start + i / 60);
    const avatarCircle = await mixerTips(page, url, 0, avatarTimes);
    const truthCircle = truthPath(take, "right", circleWindow.start + t0, circleWindow.end + t0);
    const leftWindow = phase("left-circle");
    const drawnLeft = drawnPoints(final.marks[1]!).filter((p) => p.time >= leftWindow.start && p.time <= leftWindow.end).map((p) => p.position);
    const fits = { drawn: fitCircle(drawnCircle), avatar: fitCircle(avatarCircle), groundTruth: fitCircle(truthCircle), leftDrawn: fitCircle(drawnLeft), leftGroundTruth: fitCircle(truthPath(take, "left", leftWindow.start + t0, leftWindow.end + t0)) };
    expect(Math.abs(fits.drawn.radius - fits.avatar.radius), "drawn circle matches the avatar fingertip's circle within 1 cm").toBeLessThanOrEqual(RADIUS_MATCH_METERS);

    // Orbit the paused traces, all drawn, from two angles, and on a phone-size card.
    await pausedAt(page, url, afterAll.reading.time);
    await closeUp(page, url, 2.5, 0.1);
    const orbitA = await readTraces(page, url);
    shots.push(await shot(page, id, "authored-4-orbit-a"));
    await closeUp(page, url, 3.9, 0.45);
    const orbitB = await readTraces(page, url);
    shots.push(await shot(page, id, "authored-5-orbit-b"));
    await page.setViewportSize(PHONE);
    await closeUp(page, url);
    shots.push(await shot(page, id, "authored-6-phone"));
    await page.setViewportSize(DESKTOP);
    expect(JSON.stringify(orbitB.snapshot), "orbiting changes nothing drawn").toBe(JSON.stringify(orbitA.snapshot));
    expect({ visible: orbitB.visible, drawn: orbitB.marks.map((m) => m.drawn), time: orbitB.time }, "every finished trace shows from the orbit").toEqual({ visible: orbitB.marks.map(() => true), drawn: orbitB.marks.map(() => true), time: afterAll.reading.time });
    // Mid-circle again, seen close: the trace drawn in to the fingertip.
    await pausedAt(page, url, pick(phase("right-circle").start + 1.0).time);
    shots.push(await shot(page, id, "authored-7-mid-circle-close"));

    // Cost: the card probe's own performance.now() timings.
    const timings = (await readTraces(page, url)).timings;
    const costs = {
      frameMs: { count: timings.frame.length, p95: round(percentile(timings.frame, 0.95), 3), max: round(maxOf(timings.frame), 3) },
      pauseMs: { count: timings.pause.length, max: round(maxOf(timings.pause), 3), p50: round(percentile(timings.pause, 0.5), 3) },
      warmSyncMs: { count: timings.warmSync.length, max: round(maxOf(timings.warmSync), 3) },
      enforced: costBudgetsEnforced
    };
    await saveReport("authoredViewer", {
      takeStartSim: round(t0, 5),
      playing: { summary: playingSummary, marks: playing, outsideSpanFrames: outside.length },
      paused: pausedChecks, scrubBackSame: scrubSame,
      untraced: { figureEightWindow: eightWindow, drawnDuringEight: eightSnap.marks.map((m) => m.drawn) },
      fidelity: { marks: fidelity, limit: FIDELITY_METERS },
      shape: {
        rightCircleRadius: { drawn: round(fits.drawn.radius), avatar: round(fits.avatar.radius), groundTruth: round(fits.groundTruth.radius), scripted: 0.15, drawnMinusAvatar: round(fits.drawn.radius - fits.avatar.radius), drawnMinusGroundTruth: round(fits.drawn.radius - fits.groundTruth.radius) },
        rightCircleFitRms: { drawn: round(fits.drawn.rms), avatar: round(fits.avatar.rms), groundTruth: round(fits.groundTruth.rms) },
        leftCircleRadius: { drawn: round(fits.leftDrawn.radius), groundTruth: round(fits.leftGroundTruth.radius) }
      },
      cost: costs,
      screenshots: shots
    });
    expect(costs.frameMs.count).toBeGreaterThan(100);
    if (costBudgetsEnforced) {
      expect(costs.pauseMs.max, "under 5 ms per pause or scrub").toBeLessThan(PAUSE_BUDGET_MS);
      expect(costs.frameMs.p95, "p95 under 0.5 ms per playing frame").toBeLessThan(FRAME_P95_BUDGET_MS);
    }
  });

  test("travel take: walking, a teleport and a snap turn draw nothing; controllers leave a gap", async ({ page }) => {
    test.setTimeout(360_000);
    const take = await scriptedTake("travel");
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    expect(signal.valid, signal.errors.join("; ")).toBe(true);
    expect(signal.version).toBe(2);
    expect(take.toggles.every((t) => t.done), "every hook toggle ran").toBe(true);
    const kept = take.final.kept!.kept;
    expect(kept.length, "four traces kept").toBe(4);
    const t0 = takeStartSim(take, signal, kept);
    const phase = (name: string) => clipPhase(take, t0, name);
    // The controller second is cut out of both hands' recorded spans.
    const controllers = phase("controllers");
    for (const side of ["left", "right"] as const) {
      const spans = recordedFor(signal, side);
      expect(spans.length, `${side}: a span before and after the controllers`).toBe(2);
      expect(spans[0]!.end).toBeLessThan(controllers.start + 0.6);
      expect(spans[1]!.start).toBeGreaterThan(controllers.end - 0.1);
    }

    const [card] = await openFeed(page, [{ name: "authored-traces-travel", glb: bytes }]);
    const { id, url } = card!;
    await expect.poll(async () => (await readTraces(page, url)).hasTraces, { timeout: 15_000 }).toBe(true);
    await pause(page, id);
    await closeUp(page, url, 2.2, 0.3, 0.3);
    const marks = (await readTraces(page, url)).marks;
    const right = (window: Span) => marks.findIndex((m) => m.side === "right" && m.span.start <= window.end && m.span.end >= window.start);
    const results: Record<string, unknown> = { takeStartSim: round(t0, 5), marks: marks.map((m) => ({ side: m.side, span: m.span })), toggles: take.toggles };
    const check = async (name: string, at: number, window: Span, shotName: string) => {
      const reading = await pausedAt(page, url, at);
      const m = right(window);
      expect(m, `${name}: a right-hand mark over the event`).toBeGreaterThanOrEqual(0);
      const mark = reading.snapshot!.marks[m]!;
      const speeds = drawnHipSpeeds(mark);
      const steps = mark.segments.map(([a, b]) => dist(mark.points[a]!.position, mark.points[b]!.position));
      const inWindow = mark.points.filter((p) => p.time >= window.start && p.time <= window.end).length;
      const drawnInWindow = drawnPoints(mark).filter((p) => p.time >= window.start && p.time <= window.end).length;
      const allSpeeds = reading.snapshot!.marks.flatMap((x) => x.points.map((p) => p.hipSpeed));
      results[name] = {
        mark: m, time: at, span: marks[m]!.span,
        hipSpeed: { max: round(maxOf(allSpeeds)), p50: round(percentile(allSpeeds, 0.5)), p95: round(percentile(allSpeeds, 0.95)), histogram: histogram(allSpeeds) },
        samplesInEvent: inWindow, drawnInEvent: drawnInWindow, suppressed: mark.suppressed, drawnSegments: mark.segments.length,
        maxDrawnStep: round(maxOf(steps)), drawnHipSpeedMax: round(maxOf(speeds)),
        otherMarksDrawnHipSpeedMax: round(maxOf(reading.snapshot!.marks.flatMap(drawnHipSpeeds)))
      };
      await saveReport("travel", results);
      await shot(page, id, shotName);
      expect(maxOf(reading.snapshot!.marks.flatMap(drawnHipSpeeds)), `${name}: no segment drawn while travelling`).toBeLessThanOrEqual(TRAVEL_SPEED);
      expect(maxOf(steps), `${name}: no segment across a jump`).toBeLessThan(0.05);
      return { mark, drawnInWindow, inWindow };
    };
    const walk = await check("walk", phase("still-after-walk").start + 0.3, phase("walk-circle"), "travel-0-walk");
    expect(walk.mark.suppressed.travel, "walking samples are suppressed by hip speed").toBeGreaterThan(30);
    expect(walk.drawnInWindow / Math.max(1, walk.inWindow), "almost nothing drawn while walking").toBeLessThan(0.15);
    const teleportAt = simAt(take, take.events.find((e) => e.name === "teleport")!.t) - t0;
    const teleport = await check("teleport", phase("still-after-teleport").start + 0.3, { start: teleportAt - 0.05, end: teleportAt + 0.05 }, "travel-1-teleport");
    expect(teleport.mark.suppressed.jumps, "the teleport's root step breaks the trace").toBeGreaterThan(0);
    expect(take.locomotion?.snapCount, "capture took the snap turn").toBe(1);
    const snapAt = simAt(take, take.events.find((e) => e.name === "snap-turn")!.t) - t0;
    const snap = await check("snapTurn", phase("still-after-snap").start + 0.1, { start: snapAt - 0.05, end: snapAt + 0.05 }, "travel-2-snap-turn");
    expect(snap.mark.suppressed.jumps, "the snap turn breaks the trace").toBeGreaterThan(0);
    expect(teleport.mark.drawn && snap.mark.drawn, "the circles either side of a teleport or snap turn still draw").toBe(true);
    // Controllers: one mark over hands, controllers, hands; drawn either side, nothing from the controller frames.
    const gap = await check("controllerGap", phase("still-end").start + 0.1, controllers, "travel-3-controller-gap");
    const gapMark = marks[right(controllers)]!;
    const gapTimes = drawnPoints(gap.mark).map((p) => p.time);
    results.controllerGap = { ...(results.controllerGap as object), window: controllers, markSpan: gapMark.span, drawnBefore: gapTimes.filter((t) => t < controllers.start).length, drawnAfter: gapTimes.filter((t) => t > controllers.end).length, drawnInside: gapTimes.filter((t) => t > controllers.start + 0.25 && t < controllers.end - 0.05).length };
    await saveReport("travel", { glb: take.glb, locomotion: take.locomotion, signal: { version: signal.version, recorded: signal.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0] })), traces: signal.traces.map((t) => ({ side: t.side, span: t.span })) }, events: take.events, ...results });
    expect(gapMark.span.start < controllers.start && gapMark.span.end > controllers.end, "the mark spans the controller second").toBe(true);
    expect((results.controllerGap as { drawnInside: number }).drawnInside, "no trace from controller frames").toBe(0);
    expect((results.controllerGap as { drawnBefore: number }).drawnBefore, "drawn before the controllers").toBeGreaterThan(0);
    expect((results.controllerGap as { drawnAfter: number }).drawnAfter, "and after").toBeGreaterThan(0);
  });

  test("real headset fixture: Ink around the wave and the reach marks only those", async ({ page }) => {
    test.setTimeout(360_000);
    const take = await realFixtureTake();
    const bytes = await readFile(take.glb);
    const signal = signalOf(bytes);
    expect(signal.valid, signal.errors.join("; ")).toBe(true);
    expect(take.toggles.map((t) => t.done), "the four Ink toggles ran").toEqual([true, true, true, true]);
    expect(signal.recorded.length, "the replayed real hands give recorded spans").toBeGreaterThan(0);
    // Capture's recording starts within two 30 Hz steps of the first input frame.
    const windows = [{ start: take.toggles[0]!.t, end: take.toggles[1]!.t }, { start: take.toggles[2]!.t, end: take.toggles[3]!.t }];
    const inWindow = (span: Span) => windows.some((w) => span.start >= w.start - 0.1 && span.end <= w.end + 0.1);
    expect(signal.traces.length, "marks for the hands that moved").toBeGreaterThan(0);
    expect(signal.traces.every((t) => inWindow(t.span)), `marks only inside the Ink windows: ${JSON.stringify(signal.traces.map((t) => t.span))}`).toBe(true);

    const [card] = await openFeed(page, [{ name: "authored-traces-real", glb: bytes }]);
    await expect.poll(async () => (await readTraces(page, card!.url)).hasTraces, { timeout: 15_000 }).toBe(true);
    await pause(page, card!.id);
    await closeUp(page, card!.url);
    const readings = [];
    const allSpeeds: number[] = [];
    for (const [name, at] of [["fist", 3.7], ["point", 5.0], ["pinch", 6.6], ["wave", 8.3], ["reach", 9.2]] as const) {
      const reading = await pausedAt(page, card!.url, at);
      const snap = reading.snapshot!;
      allSpeeds.push(...snap.marks.flatMap((m) => m.points.map((p) => p.hipSpeed)));
      expect(maxOf(snap.marks.flatMap(drawnHipSpeeds))).toBeLessThanOrEqual(TRAVEL_SPEED);
      snap.marks.forEach((m, i) => expect(segmentsInSpans(m, reading.marks[i]!.span, reading.spans[m.side])).toBe(true));
      await shot(page, card!.id, `real-${name}`);
      readings.push({ name, time: at, drawn: snap.marks.map((m) => ({ side: m.side, drawn: m.drawn, points: m.points.length, extent: round(m.extent), suppressed: m.suppressed })) });
    }
    expect(readings.slice(0, 3).every((r) => r.drawn.every((m) => !m.drawn)), "nothing drawn before the Ink windows").toBe(true);
    expect(readings.slice(3).some((r) => r.drawn.some((m) => m.drawn)), "the wave or the reach shows a trace").toBe(true);
    await saveReport("realFixture", {
      glb: take.glb, replayScoreFailures: take.failures, toggles: take.toggles,
      recordedSpans: signal.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0] })),
      traces: signal.traces.map((t) => ({ side: t.side, span: t.span })),
      readings,
      hipSpeed: { max: round(maxOf(allSpeeds)), p50: round(percentile(allSpeeds, 0.5)), p95: round(percentile(allSpeeds, 0.95)), histogram: histogram(allSpeeds) }
    });
  });

  test("older and other takes: a no-Ink headset take stays v0, a pre-v2 reader ignores v2, desktop and stripped files draw nothing", async ({ page, browser }, testInfo) => {
    test.setTimeout(360_000);
    const shapes = await scriptedTake("shapes");
    const shapesBytes = await readFile(shapes.glb);
    const authored = await scriptedTake("authored");
    const authoredBytes = await readFile(authored.glb);
    const plain = signalOf(shapesBytes);
    const v2 = signalOf(authoredBytes);

    // A headset take without Ink writes exactly v0: recorded hand spans, no trace marks, nothing required.
    expect(plain.version, "no trace, still v0").toBe(0);
    expect(plain.valid, plain.errors.join("; ")).toBe(true);
    expect(plain.traces).toEqual([]);
    expect(plain.extensionsRequired).toEqual([]);
    expect(plain.listedInUsedOnly).toBe(true);
    for (const side of ["left", "right"] as const) {
      const spans = recordedFor(plain, side);
      expect(spans.length, `${side} recorded spans`).toBeGreaterThan(0);
      expect(spans[0]!.bones).toContain(`${side}IndexDistal`);
    }
    // main's packages/meaning (versions 0 and 1): the v0 record is what its writer writes, byte for byte; v2 is unsupported.
    const main = await mainMeaning();
    let mainReport: Record<string, unknown> = { skipped: `commit ${PRE_V2_MEANING_COMMIT} not in this clone` };
    if (main) {
      const raw = plain.raw as { marks: unknown[]; spans: unknown[] };
      const reencoded = JSON.stringify(main.encodeHoloimMeaning({ marks: raw.marks, spans: raw.spans }));
      const mainOnV0 = main.validateHoloimMeaning(plain.raw);
      const mainOnV2 = main.validateHoloimMeaning(v2.raw);
      const mainErrors = mainOnV2.ok ? [] : mainOnV2.errors;
      mainReport = { commit: PRE_V2_MEANING_COMMIT, versions: main.versions, v0EncoderSameJson: reencoded === JSON.stringify(plain.raw), readsV0: mainOnV0.ok, readsV2: mainOnV2.ok, v2Errors: mainErrors };
      expect(main.versions, "the pre-v2 reader knows versions 0 and 1").toEqual([0, 1]);
      expect(reencoded === JSON.stringify(plain.raw), "the no-Ink take's meaning JSON is what the pre-v2 encoder writes").toBe(true);
      expect(mainOnV0.ok, "the pre-v2 reader reads the no-Ink take").toBe(true);
      expect(mainOnV2.ok, "the pre-v2 reader rejects the v2 record").toBe(false);
      expect(mainErrors.join("; ")).toMatch(/unsupported HOLOIM_meaning version 2/);
    }

    const desktop = await once("desktop", () => recordWalkTake(browser, testInfo));
    const desktopSignal = signalOf(desktop.bytes);
    const noMeaning = rewriteGlbJson(authoredBytes, (json) => {
      delete json.extensions!.HOLOIM_meaning;
      json.extensionsUsed = (json.extensionsUsed ?? []).filter((name) => name !== "HOLOIM_meaning");
    });
    const negatives = [
      { name: "v0-headset", glb: shapesBytes },
      { name: "desktop", glb: desktop.bytes },
      { name: "no-meaning", glb: noMeaning }
    ];
    const results: Record<string, unknown> = {};
    for (const negative of negatives) {
      const [card] = await openFeed(page, [{ name: `authored-traces-${negative.name}`, glb: negative.glb }]);
      const controls = await noTracesControl(page, card!.url, card!.id);
      const reading = () => page.evaluate((target) => {
        const probes = (window as unknown as { __portalProbes: Record<string, { traces: { hasTraces: boolean; group: unknown; marks: unknown[] }; actions: Record<string, { time: number } | null> }> }).__portalProbes;
        const entry = Object.entries(probes).find(([u]) => u.endsWith(target))![1];
        return { hasTraces: entry.traces.hasTraces, mounted: entry.traces.group !== null, marks: entry.traces.marks.length, time: Object.values(entry.actions).find(Boolean)?.time ?? 0 };
      }, card!.url);
      const first = await reading();
      await animationFrames(page, 20);
      const later = await reading();
      await pause(page, card!.id);
      const name = await shot(page, card!.id, `older-${negative.name}`);
      results[negative.name] = { ...controls, hasTraces: first.hasTraces, mounted: first.mounted, marks: first.marks, plays: later.time !== first.time, screenshot: name };
      expect(controls, `${negative.name}: no Traces control or state`).toEqual({ control: 0, storeKeys: [] });
      expect(first.hasTraces, `${negative.name}: no traces`).toBe(false);
      expect(first.mounted, `${negative.name}: nothing mounted`).toBe(false);
      expect(later.time, `${negative.name}: plays`).not.toBe(first.time);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    await saveReport("olderAndOther", {
      v0Headset: { glb: shapes.glb, version: plain.version, valid: plain.valid, traces: plain.traces.length, extensionsRequired: plain.extensionsRequired, recorded: plain.recorded.map((s) => ({ start: s.start, end: s.end, hand: s.bones[0] })) },
      preV2Reader: mainReport,
      desktopSignal: { present: desktopSignal.present, version: desktopSignal.version, recorded: desktopSignal.recorded.length, traces: desktopSignal.traces.length },
      ...results
    });
  });
});
