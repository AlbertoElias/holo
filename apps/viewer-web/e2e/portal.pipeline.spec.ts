import { readFile } from "node:fs/promises";

import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";
import { cardCenter, installProbe, readPortal, waitForFrozenTimes, waitForPortalReady } from "./portal-helpers";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

// Portal view (PRD-002) on a real capture export: only the checks that need
// the recorded bubble, head, and motion. Gesture logic across variants and
// phone touch run in portal.spec.ts on the mocked feed, where frames are
// cheap; here every input waits for a software-rendered frame.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const RECORDED_SECONDS = 1.5;
// Desktop layout (wider than 768 px) with a small bubble, to keep frames cheap.
const DESKTOP = { width: 800, height: 440 };

type CaptureWindow = Window & {
  __setManualClock: (enabled: boolean) => void;
  __setMockInput: (input: { forward?: boolean }) => void;
  advanceTime: (ms: number) => void;
};

async function recordCaptureGlb(context: BrowserContext, testInfo: TestInfo): Promise<Buffer> {
  const capture = await context.newPage();
  const errors: string[] = [];
  capture.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await capture.goto(captureUrl, { waitUntil: "networkidle" });
  await waitForTextContentPrefix(capture, "#status", "loaded");
  await capture.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true));
  await capture.getByRole("button", { name: CONTROL_NAMES.startRecording }).click();
  await expect(capture.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible();
  await capture.evaluate((seconds) => {
    const hooks = window as unknown as CaptureWindow;
    hooks.__setMockInput({ forward: true });
    hooks.advanceTime(seconds * 1000 * 0.7);
    hooks.__setMockInput({ forward: false });
    hooks.advanceTime(seconds * 1000 * 0.3);
  }, RECORDED_SECONDS);
  const downloadPromise = capture.waitForEvent("download");
  await capture.getByRole("button", { name: CONTROL_NAMES.stopRecording }).click();
  const glbPath = testInfo.outputPath("portal-capture.glb");
  await (await downloadPromise).saveAs(glbPath);
  await capture.close();
  expect(errors, "capture runtime errors").toEqual([]);
  return readFile(glbPath);
}

async function showOnly(page: Page, id: string): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === id), nextCursor: null } });
  });
}

test("portal view on a real capture: freeze, orbit, zoom inside the bubble, Return, and Play", async ({ page, context }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(120_000);

  const glb = await recordCaptureGlb(context, testInfo);
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `Portal ${testInfo.testId.slice(0, 6)}-${Date.now()}`,
      submittedBy: "portal-e2e",
      file: { name: "portal-capture.glb", mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  expect(response.ok(), "upload accepted").toBe(true);
  const uploaded = (await response.json()) as { id: string; url: string };

  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  // Earlier pipeline specs leave uploads in the shared API; each card is a canvas.
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await captureEvidence(page, testInfo, "real-1-follow");

  const start = await readPortal(page, uploaded.url);
  expect(start.mode).toBe("follow");
  expect(start.cameraDistance, "Follow sits at the outside end").toBeCloseTo(start.outsideDistance, 3);
  const center = await cardCenter(page, uploaded.id);

  // Tap pauses the recorded motion.
  await page.mouse.click(center.x, center.y);
  await expect(card).toHaveAttribute("data-portal-paused", "true");
  const frozenTimes = await waitForFrozenTimes(page, uploaded.url);
  await page.waitForTimeout(800);
  const pausedB = await readPortal(page, uploaded.url);
  expect(pausedB.actionTimes, "animation time stays frozen while paused").toEqual(frozenTimes);

  // Orbit around the author's frozen pose: distance and focus hold.
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 180, center.y, { steps: 3 });
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-portal-mode", "free");
  const orbited = await readPortal(page, uploaded.url);
  expect(orbited.yaw - start.followYaw, "dragging left orbits").toBeGreaterThan(0.3);
  expect(orbited.cameraDistance, "orbit keeps the distance").toBeCloseTo(pausedB.cameraDistance, 2);
  orbited.target.forEach((value, index) => {
    expect(value, "focus stays put while paused").toBeCloseTo(pausedB.target[index]!, 3);
  });
  await captureEvidence(page, testInfo, "real-2-orbit");

  // Zoom to the inside end: within the recorded bubble, true scale kept.
  // The orbit drag ended over the upload panel; wheel over the card.
  await page.mouse.move(center.x, center.y);
  await page.mouse.wheel(0, -2000);
  await page.mouse.wheel(0, -2000);
  await expect.poll(async () => (await readPortal(page, uploaded.url)).cameraDistance, { timeout: 10_000 })
    .toBeCloseTo(orbited.insideDistance, 2);
  const inside = await readPortal(page, uploaded.url);
  expect(inside.zoom).toBe(0);
  expect(inside.cameraToBubbleCenter, "camera is inside the recorded bubble").toBeLessThan(inside.bubbleRadius);
  expect(inside.modelScale, "true scale is unchanged").toBeCloseTo(start.modelScale, 6);
  await expect(card).toHaveAttribute("style", /--portal-open:\s*1/);
  await captureEvidence(page, testInfo, "real-3-inside");

  // Return glides back to the Follow pose.
  await card.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView }).click();
  await expect(card).toHaveAttribute("data-portal-mode", "follow");
  await expect.poll(async () => (await readPortal(page, uploaded.url)).cameraDistance, { timeout: 10_000 })
    .toBeCloseTo(start.outsideDistance, 2);

  // Play resumes the recorded motion from where it stopped.
  await card.getByRole("button", { name: CONTROL_NAMES.play }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "false");
  await expect.poll(
    async () => (await readPortal(page, uploaded.url)).actionTimes.join(","),
    { message: "time moves again after Play", timeout: 10_000 }
  ).not.toBe(pausedB.actionTimes.join(","));
});
