import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import type { Probe } from "./ar-bubble-types";
import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";
import { diagnosticGltf, flatGroundGltf, HILL_GROUND, HILL_SECONDS, hillGltf } from "./bubble-fixture";
import { measureGlass, measureRim, mergeGlass, snapshotNeighbourExcess, pauseTake, readRimState, sampleRimMotion, seekTake, type GlassReport, type RimSnapshot } from "./floor-proof";

// The rim follows the ground (styleguide 3.4, feature brief
// cloche-rim-follows-ground): in the feed, a take recorded on a hill stands
// on its own ground. Rim against ground per direction, measured by the
// test's own raycast; nothing of the scene outside the glass, on the GPU;
// the rim smooth through the take; flat takes, camera takes and old exports
// as before; and what it costs. The capture pipeline's take is checked in
// bubble-capture.pipeline.spec.ts.

const artifactDir = resolve(import.meta.dirname, "../../../output/cloche-rim");
// The cost budgets are a desktop's (lead decision, 2026-10-28): on a shared CI runner timing is noise, so
// there the reports keep the timings and only a catastrophe is asserted.
const onCI = Boolean(process.env.CI);
const budget = onCI ? { buildMs: 150, updateP99Ms: 2 } : { buildMs: 15, updateP99Ms: 0.25 };

const hologram = {
  id: "rim-1",
  url: "/uploads/rim.glb",
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-10-27T00:00:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: "rim.glb",
  hologramName: "On the hill",
  submittedBy: "automation"
} as const;

async function openTake(page: Page, glb: Buffer): Promise<void> {
  await page.addInitScript(() => {
    const hooks = window as unknown as { __feedProbe?: Probe; __HOLOIM_FEED_TEST_OBSERVER__?: (probe: Probe) => void };
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => { hooks.__feedProbe = probe; };
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [hologram], nextCursor: null }) }));
  await page.route(`**/api/holograms/${hologram.id}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hologram) }));
  await page.route("**/uploads/**", (route) => route.fulfill({ status: 200, body: glb, contentType: "model/gltf-binary" }));
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${hologram.id}"]`);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __feedProbe?: { cloche: { shape: { current: unknown } } } }).__feedProbe;
    return Boolean(probe?.cloche.shape.current);
  });
  // The focused card draws every frame once it is active; before that only on demand.
  const frame = () => page.evaluate(() => (window as unknown as { __feedProbe: { renderer: { info: { render: { frame: number } } } } }).__feedProbe.renderer.info.render.frame);
  const from = await frame();
  await expect.poll(frame, { message: "the focused card draws every frame", timeout: 15_000 }).toBeGreaterThan(from + 20);
}

function expectRimOnGround(snapshot: RimSnapshot) {
  const worst = snapshot.worst ? JSON.stringify(snapshot.worst) : "none";
  expect(snapshot.failures, `${snapshot.label}: bins off the ground (worst ${worst})`).toBe(0);
}

test("the rim follows a hill's ground in the feed, with nothing outside the glass", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await openTake(page, hillGltf());
  const state = await readRimState(page);
  expect(state.gated, "a performer's take with its recorded scene").toBe(true);
  expect(state.rimReady, "the ground field is read").toBe(true);
  expect(state.lifts, "the hill lifts the rim").toBe(true);
  expect(state.shadeDrawn, "no shade: the ground stands in for it (5.1)").toBe(false);

  await pauseTake(page, true);
  const snapshots: RimSnapshot[] = [];
  const glasses: GlassReport[] = [];
  for (const [label, seconds] of [["start", 0], ["middle", HILL_SECONDS / 2], ["end", HILL_SECONDS - 0.5]] as const) {
    await seekTake(page, seconds);
    snapshots.push(await measureRim(page, label, HILL_GROUND));
    glasses.push(await measureGlass(page, { debugImages: true }));
  }
  await seekTake(page, 0);
  const glass = mergeGlass(glasses);
  await mkdir(artifactDir, { recursive: true });
  for (const [index, image] of glass.images.entries()) await writeFile(resolve(artifactDir, `glass-outside-${index}.png`), Buffer.from(image, "base64"));
  glass.images = [];
  const control = await measureGlass(page, { control: true });
  const motion = await sampleRimMotion(page, HILL_SECONDS + 0.5);
  // The cost's 99th percentile is read over a full 600 frames of the looping take.
  await expect.poll(() => readRimState(page).then((state) => state.timing?.frames ?? 0), { timeout: 60_000 }).toBeGreaterThanOrEqual(600);
  const after = await readRimState(page);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "hill-report.json"), JSON.stringify({ state: after, snapshots, glass, control, motion }, null, 2));
  await captureEvidence(page, testInfo, "rim-on-the-hill");

  for (const snapshot of snapshots) {
    expectRimOnGround(snapshot);
    const step = snapshotNeighbourExcess(snapshot);
    expect(step.excess, `${snapshot.label}: neighbours apart by more than the raycast ground allows, at bin ${step.bin}`).toBeLessThanOrEqual(0);
  }
  expect(Math.max(...snapshots.map((s) => Math.max(...s.bins.map((bin) => bin.rim - s.footY)))), "the rim lifts somewhere").toBeGreaterThan(0.3);
  expect(Math.max(...glass.outside), `scene pixels outside the bent glass, per view ${glass.outside.join(",")}`).toBe(0);
  expect(Math.min(...glass.drawn), "every view sees the scene").toBeGreaterThan(0);
  expect(Math.max(...control.outside), "with the sphere's clip instead, the scene shows outside the glass (the check can fail)").toBeGreaterThan(0);
  expect(motion.maxFrameChange, "the rim's largest change in a frame at 60 fps, a loop's snap aside").toBeLessThanOrEqual(0.02);
  expect(motion.maxNeighbourExcess, `neighbouring bins apart by more than max(5% of the dome's height, the ground's step + 5 cm), settled bins, worst at bin ${motion.maxNeighbourExcessBin}`).toBeLessThanOrEqual(0);
  expect(motion.maxTargetNeighbourExcess, "the same for the rim's target, every frame").toBeLessThanOrEqual(0);
  expect(motion.settledPairs, "some bin pairs settled to judge the rim itself").toBeGreaterThanOrEqual(0.05 * motion.pairs);
  expect(after.buildMs, `ground field build${onCI ? " (CI's catastrophe bound)" : ""}`).toBeLessThanOrEqual(budget.buildMs);
  expect(after.timing?.p99Ms ?? Infinity, `rim update per frame, 99th percentile of the last 600 (mean ${after.timing?.meanMs}, max ${after.timing?.maxMs} ms)${onCI ? ", CI's catastrophe bound" : ""}`).toBeLessThanOrEqual(budget.updateP99Ms);
});

test("a flat take keeps its flat foot, its shade and the sphere's clip", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openTake(page, flatGroundGltf());
  // A fixed time: paused at 1 s, so the screenshot compares with main's.
  await pauseTake(page, true);
  await seekTake(page, 1);
  await page.waitForTimeout(500);
  const state = await readRimState(page);
  expect(state.gated).toBe(true);
  expect(state.rimReady).toBe(true);
  expect(state.lifts, `no lift (largest on the path ${state.maxLift} m)`).toBe(false);
  expect(state.maxLift, "lift on the path").toBeLessThanOrEqual(0.001);
  expect(state.liftNow, "lift drawn").toBeLessThanOrEqual(0.001);
  expect(state.shadeDrawn, "the shade").toBe(true);
  await mkdir(artifactDir, { recursive: true });
  await page.locator(`.feed-card[data-card-id="${hologram.id}"] canvas`).screenshot({ path: resolve(artifactDir, "flat-fixed-time.png") });
  await writeFile(resolve(artifactDir, "flat-report.json"), JSON.stringify(state, null, 2));
  await captureEvidence(page, testInfo, "flat-take");
});

test("a camera take and an old export keep today's dome", async ({ page }) => {
  await openTake(page, hillGltf({ cameraTake: true }));
  await page.waitForTimeout(300);
  const camera = await readRimState(page);
  expect(camera.gated, "a camera take has no rim").toBe(false);
  expect(camera.liftNow).toBe(0);
  expect(camera.shadeDrawn).toBe(true);

  const old = await page.context().newPage();
  await openTake(old, diagnosticGltf());
  await old.waitForTimeout(300);
  const oldState = await readRimState(old);
  expect(oldState.gated, "an export without its recorded scene has no rim").toBe(false);
  expect(oldState.liftNow).toBe(0);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "unchanged-report.json"), JSON.stringify({ camera, old: oldState }, null, 2));
});

// The feed's rim costs (brief: field ≤ 15 ms on desktop, ≤ 60 ms at 4× CPU
// throttle; update ≤ 0.25 ms a frame), asserted off CI. No other feed perf check exists.
test("feed perf: the rim's ground field and per-frame update at 4× CPU throttle", async ({ page }) => {
  test.setTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await openTake(page, hillGltf());
  await expect.poll(() => readRimState(page).then((state) => state.rimReady), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(2000);
  const state = await readRimState(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "perf-throttled-report.json"), JSON.stringify(state, null, 2));
  if (!onCI) expect(state.buildMs, "ground field build at 4× throttle").toBeLessThanOrEqual(60);
  expect(state.timing?.frames ?? 0, "the rim updated through playback").toBeGreaterThan(10);
});
