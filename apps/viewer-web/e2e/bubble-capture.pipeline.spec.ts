import { mkdir, readFile, writeFile } from "node:fs/promises";

import { freezePageClock, waitForIwerSession, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";

import { resolve } from "node:path";
import type { Probe } from "./ar-bubble-types";
import { captureBubblePixels } from "./bubble-pixel-proof";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

// Whole-product check: record in capture, export the real GLB, upload it
// through the viewer UI to a real API, and render it in the feed. Nothing in
// between is mocked, so any break in export → upload → render fails here.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const RECORDED_SECONDS = 1.5;

type CaptureWindow = Window & {
  __setManualClock: (enabled: boolean) => void;
  __setMockInput: (input: { forward?: boolean }) => void;
  advanceTime: (ms: number) => void;
};

type GltfJson = {
  animations?: Array<{ samplers: Array<{ input: number }> }>;
  accessors?: Array<{ max?: number[] }>;
  nodes?: Array<{ name?: string }>;
  skins?: unknown[];
};

function readGlbJson(bytes: Buffer): GltfJson {
  expect(bytes.readUInt32LE(0), "GLB magic").toBe(0x46546c67);
  expect(bytes.readUInt32LE(4), "GLB version").toBe(2);
  expect(bytes.readUInt32LE(8), "GLB declared length").toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16), "first chunk is JSON").toBe(0x4e4f534a);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as GltfJson;
}

function animationDurationSeconds(gltf: GltfJson): number {
  let duration = 0;
  for (const animation of gltf.animations ?? []) {
    for (const sampler of animation.samplers) {
      duration = Math.max(duration, gltf.accessors?.[sampler.input]?.max?.[0] ?? 0);
    }
  }
  return duration;
}

test("real capture bubble exports, uploads and draws in feed and immersive AR", async ({ page, context }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    const hooks = window as unknown as { __feedProbe?: Probe; __bubbleProbe?: Probe; __HOLOIM_FEED_TEST_OBSERVER__?: (probe: Probe) => void; __HOLOIM_AR_TEST_OBSERVER__?: (probe: Probe) => void };
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => { hooks.__feedProbe = probe; };
    hooks.__HOLOIM_AR_TEST_OBSERVER__ = (probe) => { hooks.__bubbleProbe = probe; };
  });
  const capture = await context.newPage();
  const captureErrors: string[] = [];
  capture.on("pageerror", (error) => captureErrors.push(`pageerror: ${error.message}`));
  capture.on("console", (message) => {
    if (message.type() === "error") captureErrors.push(`console.error: ${message.text()}`);
  });

  await capture.goto(captureUrl, { waitUntil: "networkidle" });
  await waitForTextContentPrefix(capture, "#status", "loaded");
  await capture.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true));

  await capture.getByRole("button", { name: CONTROL_NAMES.startRecording }).click();
  await expect(capture.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible();
  // Walk forward so the export carries real root motion and locomotion clips.
  await capture.evaluate((seconds) => {
    const hooks = window as unknown as CaptureWindow;
    hooks.__setMockInput({ forward: true });
    hooks.advanceTime(seconds * 1000 * 0.7);
    hooks.__setMockInput({ forward: false });
    hooks.advanceTime(seconds * 1000 * 0.3);
  }, RECORDED_SECONDS);

  await captureEvidence(capture, testInfo, "capture-recording-in-progress");
  const downloadPromise = capture.waitForEvent("download");
  await capture.getByRole("button", { name: CONTROL_NAMES.stopRecording }).click();
  const download = await downloadPromise;
  const glbPath = testInfo.outputPath("capture-export.glb");
  await download.saveAs(glbPath);
  await capture.close();
  expect(captureErrors, "capture runtime errors").toEqual([]);

  const glbBytes = await readFile(glbPath);
  const gltf = readGlbJson(glbBytes);
  expect(gltf.skins?.length ?? 0, "exported skins").toBeGreaterThan(0);
  expect(gltf.nodes?.some((node) => node.name === "RecordedBubbleSphere"), "exported scene bubble").toBe(true);
  expect(animationDurationSeconds(gltf), "exported animation length").toBeGreaterThan(RECORDED_SECONDS * 0.9);

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
  expect(feedAfter.sphere, "feed sphere follows recorded motion").not.toEqual(feedBefore.sphere);
  await page.clock.resume();
  await card.locator(".ar-trigger-button").click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await page.evaluate(() => {
    const device = (window as unknown as { IWER_DEVICE: { stereoEnabled: boolean; ipd: number } }).IWER_DEVICE;
    device.stereoEnabled = true; device.ipd = 0.064;
  });
  await freezePageClock(page);
  await page.clock.runFor(1500);
  await page.waitForFunction(() => Boolean((window as unknown as { __bubbleProbe?: Probe }).__bubbleProbe?.bubble.active));
  const arBefore = await captureBubblePixels(page, "ar", artifactDir);
  await page.clock.runFor(400);
  const arAfter = await captureBubblePixels(page, "ar", artifactDir);
  expect(arAfter.time, "capture animation advances in immersive AR").not.toEqual(arBefore.time);
  expect(arAfter.sphere, "AR sphere stays pinned").toEqual(arBefore.sphere);
  await writeFile(resolve(artifactDir, "metrics.json"), JSON.stringify({ feedBefore, feedAfter, arBefore, arAfter }, null, 2));

});
