import { mkdir, writeFile } from "node:fs/promises";

import { freezePageClock, waitForIwerSession } from "@holoim/tooling-testing/xr-env";

import { resolve } from "node:path";
import type { Probe } from "./ar-bubble-types";
import { captureBubblePixels } from "./bubble-pixel-proof";
import { measureFloor, measureGlass, measureRim, mergeGlass, snapshotNeighbourExcess, pauseTake, readRimState, sampleRimMotion, seekTake, type FloorReport, type GlassReport } from "./floor-proof";

import { assertViewerShell, captureEvidence, expect, test, pressViewInAr } from "./bootstrap";
import { RECORDED_SECONDS, recordWalkTake } from "./pipeline-takes";

// Whole-product check: record in capture, export the real GLB, upload it
// through the viewer UI to a real API, and render it in the feed. Nothing in
// between is mocked, so any break in export → upload → render fails here.
// The walking take is recorded once per worker and shared with
// capture-to-viewer (pipeline-takes.ts).

/** Floors agree to within this; the foot bone is the ankle, this far above its floor at most. */
const FLOOR_TOLERANCE_METERS = 0.05;
const ANKLE_HEIGHT_METERS = 0.2;

// B-022: the recorded floor is the floor AR stands on the room floor. B-033:
// in the feed the cloche wraps all the bubble draws, its foot on the lowest
// drawn ground, never above the author's floor. A take whose rim follows its
// ground (3.4) is clipped by the bent glass, counted on the GPU.
function expectOnRecordedFloor(report: FloorReport, glass: GlassReport | null = null) {
  const { mode, recordedFloorY, footBoneY, clocheBaseY, placementY, lowestDrawnY, outsideGlass } = report;
  if (mode === "ar") {
    expect(Math.abs(clocheBaseY - recordedFloorY), `${mode}: cloche foot on the recorded floor`).toBeLessThanOrEqual(FLOOR_TOLERANCE_METERS);
  } else {
    expect(clocheBaseY - recordedFloorY, `${mode}: cloche foot not above the recorded floor`).toBeLessThanOrEqual(FLOOR_TOLERANCE_METERS);
    expect(Math.abs(clocheBaseY - lowestDrawnY!), `${mode}: cloche foot on the lowest drawn ground`).toBeLessThanOrEqual(FLOOR_TOLERANCE_METERS);
    if (report.rimLifts) expect(Math.max(...glass!.outside), `${mode}: no scene pixel outside the bent glass`).toBe(0);
    else expect(outsideGlass, `${mode}: every drawn point of the recorded scene under the glass`).toBe(0);
  }
  expect(footBoneY - recordedFloorY, `${mode}: feet not under the recorded floor`).toBeGreaterThanOrEqual(-FLOOR_TOLERANCE_METERS);
  expect(footBoneY - recordedFloorY, `${mode}: feet on the recorded floor`).toBeLessThanOrEqual(ANKLE_HEIGHT_METERS);
  if (placementY !== null) {
    expect(Math.abs(placementY - recordedFloorY), `${mode}: recorded floor on the room floor`).toBeLessThanOrEqual(FLOOR_TOLERANCE_METERS);
  }
}

test("real capture bubble exports, uploads and draws in feed and immersive AR", async ({ page, browser }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  // A hosted runner takes about 4× as long as a workstation (about 90 s here with the rim's checks).
  test.setTimeout(360_000);

  await page.addInitScript(() => {
    const hooks = window as unknown as { __feedProbe?: Probe; __bubbleProbe?: Probe; __HOLOIM_FEED_TEST_OBSERVER__?: (probe: Probe) => void; __HOLOIM_AR_TEST_OBSERVER__?: (probe: Probe) => void };
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => { hooks.__feedProbe = probe; };
    hooks.__HOLOIM_AR_TEST_OBSERVER__ = (probe) => { hooks.__bubbleProbe = probe; };
  });
  const take = await recordWalkTake(browser, testInfo);
  const glbPath = take.glbPath;
  const glbBytes = take.bytes;

  const hologramName = `Pipeline ${testInfo.testId.slice(0, 8)}-${Date.now()}`;
  await page.goto("/");
  await assertViewerShell(page);
  // Upload lives in the dock and opens the side sheet (Q11).
  await page.getByRole("button", { name: "Upload a hologram" }).click();
  await page.getByLabel("Hologram name").fill(hologramName);
  await page.getByLabel("Submitted by").fill("pipeline-e2e");
  await page.locator("#glb-upload").setInputFiles(glbPath);
  const uploadResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/holograms"
  ));
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const uploaded = (await (await uploadResponse).json()) as { id: string; sizeBytes: number };
  expect(uploaded.sizeBytes, "stored size matches the export").toBe(glbBytes.length);

  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await expect(card).toContainText(hologramName);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await card.scrollIntoViewIfNeeded();
  await captureEvidence(page, testInfo, "uploaded-capture-rendered-in-feed");
  expect(Number(await card.getAttribute("data-model-animations"))).toBeGreaterThan(0);
  const artifactDir = resolve("../../output/bubble-rendering/capture");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "capture-export.glb"), glbBytes);
  await page.waitForFunction(() => Boolean((window as unknown as { __feedProbe?: Probe }).__feedProbe));
  await freezePageClock(page);
  await page.clock.runFor(100);
  const feedBefore = await captureBubblePixels(page, "feed", artifactDir);
  await page.clock.runFor(400);
  const feedAfter = await captureBubblePixels(page, "feed", artifactDir);
  const feedFloor = await measureFloor(page, "feed");
  expect(feedAfter.sphere, "feed sphere follows recorded motion").not.toEqual(feedBefore.sphere);
  // scene.glb's ground is its grass and its mountain; its boxes are props (a ledge within a step counts, as the brief's rule does).
  const SCENE_GROUND = ["pCylinder1_Grama", "Montanha"];
  // The rim on scene.glb's ground (3.4): against the test's own raycast at the start, middle and end of the walk.
  // Real time, paused for each measurement: the rim eases by the frame's own delta.
  await page.clock.resume();
  await pauseTake(page, true);
  const rimState = await readRimState(page);
  const rims = [];
  const glasses: GlassReport[] = [];
  for (const [label, seconds] of [["start", 0], ["middle", RECORDED_SECONDS / 2], ["end", RECORDED_SECONDS - 0.5]] as const) {
    await seekTake(page, seconds);
    rims.push(await measureRim(page, label, SCENE_GROUND));
    if (rimState.lifts) glasses.push(await measureGlass(page));
  }
  await seekTake(page, 0);
  const feedGlass = rimState.lifts ? mergeGlass(glasses) : null;
  const rimMotion = rimState.lifts ? await sampleRimMotion(page, RECORDED_SECONDS + 0.2) : null;
  await writeFile(resolve(artifactDir, "rim-report.json"), JSON.stringify({ state: await readRimState(page), rims, glass: feedGlass, motion: rimMotion }, null, 2));
  expect(rimState.gated, "a performer's take with its recorded scene runs the rim").toBe(true);
  expect(rimState.rimReady, "the ground field is read").toBe(true);
  expect(rimState.shadeDrawn, "the shade is drawn only on a take whose rim stays flat (5.1)").toBe(!rimState.lifts);
  if (rimState.lifts) {
    for (const rim of rims) {
      expect(rim.failures, `${rim.label}: bins off the ground (worst ${JSON.stringify(rim.worst)})`).toBe(0);
      const step = snapshotNeighbourExcess(rim);
      expect(step.excess, `${rim.label}: neighbours apart by more than the raycast ground allows, at bin ${step.bin}`).toBeLessThanOrEqual(0);
    }
    expect(rimMotion!.maxFrameChange, "the rim's largest change in a frame").toBeLessThanOrEqual(0.02);
    expect(rimMotion!.maxNeighbourExcess, `neighbouring bins apart by more than max(5% of the height, the ground's step + 5 cm), settled bins, worst at bin ${rimMotion!.maxNeighbourExcessBin}`).toBeLessThanOrEqual(0);
    expect(rimMotion!.maxTargetNeighbourExcess, "the same for the rim's target, every frame").toBeLessThanOrEqual(0);
    expect(rimMotion!.settledPairs, "some bin pairs settled to judge the rim itself").toBeGreaterThanOrEqual(0.05 * rimMotion!.pairs);
  } else {
    expect(rimState.maxLift, "a flat take does not lift").toBeLessThanOrEqual(0.05);
  }
  await pauseTake(page, false);
  await pressViewInAr(page, card);
  // The IWSDK shell, the default: it enters at once, or offers its entry button.
  const xrView = page.locator(".xr-view-container");
  await expect(xrView).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await xrView.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await page.evaluate(() => {
    const device = (window as unknown as { IWER_DEVICE: { stereoEnabled: boolean; ipd: number } }).IWER_DEVICE;
    device.stereoEnabled = true; device.ipd = 0.064;
  });
  // The hologram loads and finds its place in real time: wait for its bubble and its placement (as ar-bubble.spec does)
  // before freezing the clock, which stops the frames and the search timer that would finish them.
  await page.waitForFunction(() => Boolean((window as unknown as { __bubbleProbe?: Probe }).__bubbleProbe?.bubble.active), null, { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __HOLOIM_XR_VIEWER__: { snapshot(): { placement: { stage: string } } } }).__HOLOIM_XR_VIEWER__.snapshot().placement.stage), { timeout: 30_000 }).toMatch(/placed|anchored/);
  await freezePageClock(page);
  await page.clock.runFor(1500);
  const arBefore = await captureBubblePixels(page, "ar", artifactDir);
  await page.clock.runFor(400);
  const arAfter = await captureBubblePixels(page, "ar", artifactDir);
  const arFloor = await measureFloor(page, "ar");
  expect(arAfter.time, "capture animation advances in immersive AR").not.toEqual(arBefore.time);
  expect(arAfter.sphere, "AR sphere stays pinned").toEqual(arBefore.sphere);
  await writeFile(resolve(artifactDir, "metrics.json"), JSON.stringify({ feedBefore, feedAfter, arBefore, arAfter }, null, 2));
  await writeFile(resolve(artifactDir, "floor-report.json"), JSON.stringify({ feed: feedFloor, ar: arFloor }, null, 2));
  expectOnRecordedFloor(feedFloor, feedGlass);
  expectOnRecordedFloor(arFloor);

});
