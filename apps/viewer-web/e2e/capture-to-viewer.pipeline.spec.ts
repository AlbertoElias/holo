import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";

const execFileAsync = promisify(execFile);

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
  extensions?: Record<string, unknown>;
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

test("a recording exported from capture uploads and renders in the viewer", async ({ page, context }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(300_000);

  const capture = await context.newPage();
  // Exercise the real microphone → MediaRecorder → embedded WebM path using
  // Chromium's synthetic microphone. A timeslice lets us await captured bytes
  // instead of assuming an arbitrary wall-clock delay produced audio.
  await capture.addInitScript(() => {
    const originalStart = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function () {
      this.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          (window as Window & { __pipelineAudioBytes?: number }).__pipelineAudioBytes = event.data.size;
        }
      });
      originalStart.call(this, 100);
    };
  });
  const captureErrors: string[] = [];
  capture.on("pageerror", (error) => captureErrors.push(`pageerror: ${error.message}`));
  capture.on("console", (message) => {
    if (message.type() === "error") captureErrors.push(`console.error: ${message.text()}`);
  });

  await capture.goto(captureUrl, { waitUntil: "networkidle" });
  await waitForTextContentPrefix(capture, "#status", "loaded");
  await capture.evaluate(() => {
    const hooks = window as CaptureWindow;
    hooks.__setManualClock(true);
    // Let spawn gravity/contact settle before recording a walking phone demo.
    hooks.advanceTime(5000);
  });

  await capture.getByRole("button", { name: "Start Recording" }).click();
  await expect(capture.getByRole("button", { name: "Stop Recording" })).toBeVisible();
  // Walk forward so the export carries real root motion and locomotion clips.
  const steps = 30;
  for (let step = 0; step < steps; step += 1) {
    await delay(RECORDED_SECONDS * 1000 / steps);
    await capture.evaluate(({ moving, milliseconds }) => {
      const hooks = window as CaptureWindow;
      hooks.__setMockInput({ forward: moving });
      hooks.advanceTime(milliseconds);
    }, { moving: step < steps * 0.7, milliseconds: RECORDED_SECONDS * 1000 / steps });
  }


  await expect.poll(() => capture.evaluate(() => (
    (window as Window & { __pipelineAudioBytes?: number }).__pipelineAudioBytes ?? 0
  )), { message: "real MediaRecorder produced microphone audio" }).toBeGreaterThan(0);
  await captureEvidence(capture, testInfo, "capture-recording-in-progress");
  const downloadPromise = capture.waitForEvent("download");
  await capture.getByRole("button", { name: "Stop Recording" }).click();
  const download = await downloadPromise;
  const glbPath = testInfo.outputPath("capture-export.glb");
  await download.saveAs(glbPath);
  await capture.close();
  expect(captureErrors, "capture runtime errors").toEqual([]);

  const glbBytes = await readFile(glbPath);
  const gltf = readGlbJson(glbBytes);
  expect(gltf.extensions?.KHR_audio, "real recording embeds audio").toBeDefined();
  expect(gltf.skins?.length ?? 0, "exported skins").toBeGreaterThan(0);
  expect(gltf.nodes?.some((node) => node.name === "RecordedBubbleSphere"), "exported scene bubble").toBe(true);
  expect(animationDurationSeconds(gltf), "exported animation length").toBeGreaterThan(RECORDED_SECONDS * 0.9);

  const hologramName = `Pipeline ${testInfo.testId.slice(0, 8)}-${Date.now()}`;
  await page.goto("/");
  await assertViewerShell(page);
  const expandUpload = page.getByRole("button", { name: "Expand upload panel" });
  if (await expandUpload.isVisible()) await expandUpload.click();
  await page.getByLabel("Hologram name").fill(hologramName);
  await page.getByLabel("Submitted by").fill("pipeline-e2e");
  await page.locator("#glb-upload").setInputFiles(glbPath);
  const uploadResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/holograms"
  ));
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const uploadResult = await uploadResponse;
  expect(uploadResult.status(), await uploadResult.text()).toBe(201);
  const uploaded = (await uploadResult.json()) as { id: string; sizeBytes: number };
  expect(uploaded.sizeBytes, "stored size matches the export").toBe(glbBytes.length);

  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await expect(card).toContainText(hologramName);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await card.scrollIntoViewIfNeeded();
  await captureEvidence(page, testInfo, "uploaded-capture-rendered-in-feed");
  expect(Number(await card.getAttribute("data-model-animations"))).toBeGreaterThan(0);

  // Both clients race the initial on-demand conversion. They must receive the
  // same complete package, never a half-written archive or a failed redirect.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  const responses = await Promise.all([
    page.request.get(quickLookUrl, { timeout: 120_000 }),
    page.request.get(quickLookUrl, { timeout: 120_000 })
  ]);
  for (const response of responses) {
    expect(response.ok(), response.statusText()).toBe(true);
    expect(response.headers()["content-type"]).toContain("model/vnd.usdz+zip");
    expect(response.headers()["content-disposition"]).toBe("inline");
    expect(response.url()).toMatch(/-ql2\.usdz$/);
  }
  const usdzBytes = await responses[0]!.body();
  expect(await responses[1]!.body()).toEqual(usdzBytes);
  const usdzPath = testInfo.outputPath("capture-quicklook.usdz");
  await writeFile(usdzPath, usdzBytes);
  const reportPath = testInfo.outputPath("quicklook-validation.json");
  const inspector = path.resolve("../viewer-api/tools/inspect_usdz.py");
  await execFileAsync(process.env.USDZ_PYTHON ?? "python3", [inspector, glbPath, usdzPath, reportPath], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024
  });
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    passed: boolean;
    geometry: Array<{ skinned?: boolean; maximumVertexMotionMeters?: number; morphTargetCount?: number }>;
  };
  expect(report.geometry.some((mesh) => mesh.skinned && (mesh.maximumVertexMotionMeters ?? 0) > 0.01),
    "actual captured avatar changes evaluated geometry").toBe(true);
  expect(report.geometry.filter((mesh) => (mesh.morphTargetCount ?? 0) > 0).length,
    "all captured facial meshes survive").toBe(4);
  expect(report.passed, "independent USD animation/material/audio validation").toBe(true);
  await testInfo.attach("quicklook-validation", { path: reportPath, contentType: "application/json" });
  await testInfo.attach("quicklook-demo", { path: usdzPath, contentType: "model/vnd.usdz+zip" });
  const cached = await page.request.get(quickLookUrl);
  expect(cached.ok()).toBe(true);
  expect(await cached.body(), "cached preview stays byte-identical").toEqual(usdzBytes);

  // A walking recording has zero facial input. Derived complete GLBs challenge
  // changing facial weights, ancestor/bind transforms, alpha/UV/PBR, silent and
  // non-loop audio, and explicit unsupported/corrupt-input failures.
  const challenges = testInfo.outputPath("source-derived-challenges");
  await execFileAsync(process.env.USDZ_PYTHON ?? "python3", [
    path.resolve("../viewer-api/tools/exercise_usdz.py"), glbPath, challenges
  ], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  const summaryPath = path.join(challenges, "exercise-summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { passed: boolean };
  expect(summary.passed, "source-derived conversion challenges").toBe(true);
  await testInfo.attach("quicklook-challenges", { path: summaryPath, contentType: "application/json" });
  // The next Playwright suite clears test-results. Keep this complete run for
  // inspection after verify:pr, including every source-derived fixture/report.
  const evidencePath = path.resolve("../../output/quicklook", `pipeline-${Date.now()}`);
  await cp(testInfo.outputDir, evidencePath, { recursive: true });
  console.log(`Quick Look fidelity evidence: ${evidencePath}`);

});
