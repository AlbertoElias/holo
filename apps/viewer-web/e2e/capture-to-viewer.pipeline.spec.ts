import { execFile } from "node:child_process";
import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";
import { recordWalkTake, waitForUsdzReady } from "./pipeline-takes";

const execFileAsync = promisify(execFile);

// Whole-product check: record in capture, export the real GLB, upload it
// through the viewer UI to a real API, and render it in the feed. Nothing in
// between is mocked, so any break in export → upload → render fails here.
// The take (with real microphone audio) is shared with bubble-capture through
// pipeline-takes.ts. The source-derived conversion challenges
// (exercise_usdz.py) run as the API's tool check, test:usdz-tools, on this
// same take; here one real server conversion is inspected end to end.

test("a recording exported from capture uploads and renders in the viewer", async ({ page, browser }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(180_000);

  const take = await recordWalkTake(browser, testInfo);
  const glbPath = testInfo.outputPath("capture-export.glb");
  await copyFile(take.glbPath, glbPath);
  const glbBytes = take.bytes;

  const hologramName = `Pipeline ${testInfo.testId.slice(0, 8)}-${Date.now()}`;
  await page.goto("/");
  await assertViewerShell(page);
  // Upload lives in the dock and opens the side sheet (Q11).
  await page.getByRole("button", { name: "Upload a hologram" }).click();
  await page.getByLabel("Hologram name").fill(hologramName);
  await page.getByLabel("Submitted by").fill("pipeline-e2e");
  // This pipeline is the Quick Look demo path, so it opts in to USDZ generation.
  await page.locator("#quicklook-enabled").check();
  await page.locator("#glb-upload").setInputFiles(glbPath);
  // The upload now includes the USDZ conversion, so allow converter time.
  const uploadResponse = page.waitForResponse(
    (response) => (
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/holograms"
    ),
    { timeout: 120_000 }
  );
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const uploadResult = await uploadResponse;
  expect(uploadResult.status(), await uploadResult.text()).toBe(201);
  const uploaded = (await uploadResult.json()) as {
    id: string;
    sizeBytes: number;
    usdzUrl: string | null;
    usdzStatus: string;
    quickLookEnabled: boolean;
  };
  expect(uploaded.sizeBytes, "stored size matches the export").toBe(glbBytes.length);
  // Opted in, but conversion is async: no USDZ at upload-response time.
  expect(uploaded.quickLookEnabled).toBe(true);
  expect(uploaded.usdzStatus).toBe("pending");
  expect(uploaded.usdzUrl).toBeNull();

  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await expect(card).toContainText(hologramName);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await card.scrollIntoViewIfNeeded();
  await captureEvidence(page, testInfo, "uploaded-capture-rendered-in-feed");
  expect(Number(await card.getAttribute("data-model-animations"))).toBeGreaterThan(0);

  // Conversion runs asynchronously in the API's embedded worker after the
  // opt-in upload. Wait on the record's conversion state, then both clients
  // must receive the same bytes from the preview endpoint.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await waitForUsdzReady(page.request, uploaded.id);
  const responses = await Promise.all([
    page.request.get(quickLookUrl, { timeout: 120_000 }),
    page.request.get(quickLookUrl, { timeout: 120_000 })
  ]);
  for (const response of responses) {
    expect(response.ok(), response.statusText()).toBe(true);
    expect(response.headers()["content-type"]).toContain("model/vnd.usdz+zip");
    expect(response.headers()["content-disposition"]).toBe("inline");
    expect(response.url()).toMatch(/-ql3\.usdz$/);
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
    cloche?: { seed: string; seams: number; parts: Record<string, { vertices: number }> };
  };
  expect(report.geometry.some((mesh) => mesh.skinned && (mesh.maximumVertexMotionMeters ?? 0) > 0.01),
    "actual captured avatar changes evaluated geometry").toBe(true);
  expect(report.geometry.filter((mesh) => (mesh.morphTargetCount ?? 0) > 0).length,
    "all captured facial meshes survive").toBe(4);
  expect(report.passed, "independent USD animation/material/audio validation").toBe(true);
  // The baked cloche (styleguide 9.5), refitted by the inspector, burns by this hologram's id as the web does.
  expect(report.cloche?.seed, "the preview's cloche is seeded by the hologram's id").toBe(uploaded.id);
  expect(report.cloche?.parts.Fronts?.vertices ?? 0, "the cloche has its burning fronts").toBeGreaterThan(0);
  await testInfo.attach("quicklook-validation", { path: reportPath, contentType: "application/json" });
  await testInfo.attach("quicklook-demo", { path: usdzPath, contentType: "model/vnd.usdz+zip" });
  const cached = await page.request.get(quickLookUrl);
  expect(cached.ok()).toBe(true);
  expect(await cached.body(), "stored preview stays byte-identical").toEqual(usdzBytes);

  // The next Playwright suite clears test-results. Keep this complete run for
  // inspection after verify:pr: the GLB, the served USDZ and its report.
  const evidencePath = path.resolve("../../output/quicklook", `pipeline-${Date.now()}`);
  await cp(testInfo.outputDir, evidencePath, { recursive: true });
  console.log(`Quick Look fidelity evidence: ${evidencePath}`);
});
