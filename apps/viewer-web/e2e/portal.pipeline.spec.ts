import { readFile } from "node:fs/promises";

import type { Browser, BrowserContext, CDPSession, Page, TestInfo } from "@playwright/test";
import { attachXrEnvironment, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";

// Portal view (PRD-002) on a real capture export: the bubble, the avatar's
// head and its recorded motion come from capture, not a fixture. Covers the
// failure cases in docs/features/portal-view.md.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const RECORDED_SECONDS = 1.5;
const PHONE = { width: 390, height: 844 };
const PITCH_MIN = (-8 * Math.PI) / 180;
const PITCH_MAX = (78 * Math.PI) / 180;

type CaptureWindow = Window & {
  __setManualClock: (enabled: boolean) => void;
  __setMockInput: (input: { forward?: boolean }) => void;
  advanceTime: (ms: number) => void;
};

type PortalReading = {
  mode: "follow" | "free";
  paused: boolean;
  yaw: number;
  pitch: number;
  zoom: number;
  tiltYaw: number;
  followYaw: number;
  followPitch: number;
  cameraDistance: number;
  insideDistance: number;
  outsideDistance: number;
  target: [number, number, number];
  cameraToBubbleCenter: number;
  bubbleRadius: number;
  modelScale: number;
  actionTimes: number[];
};

type Uploaded = { id: string; url: string };

async function recordCaptureGlb(context: BrowserContext, testInfo: TestInfo): Promise<Buffer> {
  const capture = await context.newPage();
  const errors: string[] = [];
  capture.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await capture.goto(captureUrl, { waitUntil: "networkidle" });
  await waitForTextContentPrefix(capture, "#status", "loaded");
  await capture.evaluate(() => (window as unknown as CaptureWindow).__setManualClock(true));
  await capture.getByRole("button", { name: "Start Recording" }).click();
  await expect(capture.getByRole("button", { name: "Stop Recording" })).toBeVisible();
  await capture.evaluate((seconds) => {
    const hooks = window as unknown as CaptureWindow;
    hooks.__setMockInput({ forward: true });
    hooks.advanceTime(seconds * 1000 * 0.7);
    hooks.__setMockInput({ forward: false });
    hooks.advanceTime(seconds * 1000 * 0.3);
  }, RECORDED_SECONDS);
  const downloadPromise = capture.waitForEvent("download");
  await capture.getByRole("button", { name: "Stop Recording" }).click();
  const glbPath = testInfo.outputPath("portal-capture.glb");
  await (await downloadPromise).saveAs(glbPath);
  await capture.close();
  expect(errors, "capture runtime errors").toEqual([]);
  return readFile(glbPath);
}

async function upload(page: Page, glb: Buffer, name: string): Promise<Uploaded> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: name,
      submittedBy: "portal-e2e",
      file: { name: "portal-capture.glb", mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  expect(response.ok(), "upload accepted").toBe(true);
  return (await response.json()) as Uploaded;
}

async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hooks = window as unknown as {
      __portalProbes?: Record<string, unknown>;
      __HOLOIM_FEED_TEST_OBSERVER__?: (probe: { url: string }) => void;
    };
    hooks.__portalProbes = {};
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => {
      hooks.__portalProbes![probe.url] = probe;
    };
  });
}

async function readPortal(page: Page, uploaded: Uploaded): Promise<PortalReading> {
  return page.evaluate((modelPath) => {
    type ProbeShape = {
      camera: { position: { x: number; y: number; z: number; distanceTo: (v: unknown) => number } };
      model: { getWorldScale: (v: { x: number }) => { x: number }; position: { clone: () => { x: number } } };
      bubble: { active: boolean; radius: number; center: unknown };
      actions: Record<string, { time: number } | null>;
      portal: {
        getState: () => { mode: "follow" | "free"; paused: boolean; yaw: number; pitch: number; zoom: number; tiltYaw: number };
        runtime: {
          followYaw: number;
          followPitch: number;
          measured: { cameraDistance: number; insideDistance: number; outsideDistance: number; target: [number, number, number] };
        };
      };
    };
    const probes = (window as unknown as { __portalProbes: Record<string, ProbeShape> }).__portalProbes;
    const entry = Object.entries(probes).find(([url]) => url.endsWith(modelPath));
    if (!entry) throw new Error(`No portal probe for ${modelPath}`);
    const probe = entry[1];
    const state = probe.portal.getState();
    const { measured, followYaw, followPitch } = probe.portal.runtime;
    const scale = probe.model.getWorldScale(probe.model.position.clone());
    return {
      ...state,
      followYaw,
      followPitch,
      ...measured,
      target: [...measured.target] as [number, number, number],
      cameraToBubbleCenter: probe.bubble.active ? probe.camera.position.distanceTo(probe.bubble.center) : Number.NaN,
      bubbleRadius: probe.bubble.radius,
      modelScale: scale.x,
      actionTimes: Object.values(probe.actions).filter(Boolean).map((action) => action!.time)
    };
  }, uploaded.url);
}

async function waitForRendered(page: Page, uploaded: Uploaded): Promise<void> {
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await page.waitForFunction((modelPath) => {
    const probes = (window as unknown as { __portalProbes?: Record<string, { portal?: { runtime: { measured: { outsideDistance: number } } } }> }).__portalProbes ?? {};
    const entry = Object.entries(probes).find(([url]) => url.endsWith(modelPath));
    return (entry?.[1].portal?.runtime.measured.outsideDistance ?? 0) > 0;
  }, uploaded.url);
}

async function cardCenter(page: Page, uploaded: Uploaded): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.feed-card[data-card-id="${uploaded.id}"] .feed-card-bubble-shell`).boundingBox();
  if (!box) throw new Error("bubble not laid out");
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.4 };
}

async function feedScrollTop(page: Page): Promise<number> {
  return page.locator(".feed-scroll").evaluate((element) => element.scrollTop);
}

async function scrollFeedToTop(page: Page): Promise<void> {
  await page.locator(".feed-scroll").evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => feedScrollTop(page)).toBe(0);
}

async function touchSwipe(cdp: CDPSession, from: { x: number; y: number }, xDistance: number, yDistance: number): Promise<void> {
  await cdp.send("Input.synthesizeScrollGesture", {
    x: from.x,
    y: from.y,
    xDistance,
    yDistance,
    speed: 900,
    gestureSourceType: "touch",
    preventFling: true
  });
}

async function openPhonePage(browser: Browser, variant: string | null): Promise<{ page: Page; cdp: CDPSession; errors: string[]; context: BrowserContext }> {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    baseURL: test.info().project.use.baseURL
  });
  const page = await context.newPage();
  await attachXrEnvironment(page, { mode: process.env.XR_TEST_MODE });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  await installProbe(page);
  await page.goto(variant ? `/?portal=${variant}` : "/");
  await assertViewerShell(page);
  return { page, cdp: await context.newCDPSession(page), errors, context };
}

test("portal view: freeze, orbit, zoom continuum, Return, and feed browsing on desktop and phone", async ({ page, context, browser }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(240_000);

  const glb = await recordCaptureGlb(context, testInfo);
  const stamp = `${testInfo.testId.slice(0, 6)}-${Date.now()}`;
  // Uploaded second so it sits first in the feed; the other card proves reset on scroll.
  const below = await upload(page, glb, `Portal below ${stamp}`);
  const top = await upload(page, glb, `Portal top ${stamp}`);

  // ---------------- Desktop, freeze variant (default) ----------------
  await page.setViewportSize({ width: 1280, height: 860 });
  await installProbe(page);
  await page.goto("/");
  await assertViewerShell(page);
  const topCard = page.locator(`.feed-card[data-card-id="${top.id}"]`);
  await expect(topCard).toHaveAttribute("data-portal-variant", "freeze");
  await waitForRendered(page, top);
  await scrollFeedToTop(page);
  await captureEvidence(page, testInfo, "desktop-1-follow");

  const start = await readPortal(page, top);
  expect(start.mode).toBe("follow");
  expect(start.paused).toBe(false);
  expect(start.cameraDistance, "Follow sits at the outside end").toBeCloseTo(start.outsideDistance, 3);

  const center = await cardCenter(page, top);
  // Playing in freeze: a drag is not a look-around.
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 200, center.y, { steps: 8 });
  await page.mouse.up();
  expect((await readPortal(page, top)).mode, "drag while playing stays in Follow").toBe("follow");

  // Tap pauses and time stops.
  await page.mouse.click(center.x, center.y);
  await expect(topCard).toHaveAttribute("data-portal-paused", "true");
  const pausedA = await readPortal(page, top);
  await page.waitForTimeout(600);
  const pausedB = await readPortal(page, top);
  expect(pausedB.actionTimes, "animation time is frozen while paused").toEqual(pausedA.actionTimes);

  // Orbit: starts from the Follow pose, keeps distance and focus.
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 240, center.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const orbited = await readPortal(page, top);
  expect(orbited.mode).toBe("free");
  expect(orbited.paused, "a drag is not a tap").toBe(true);
  expect(orbited.yaw - start.followYaw, "dragging left orbits").toBeGreaterThan(0.3);
  expect(orbited.cameraDistance, "orbit keeps the distance").toBeCloseTo(pausedB.cameraDistance, 2);
  orbited.target.forEach((value, index) => {
    expect(value, "focus stays put while paused").toBeCloseTo(pausedB.target[index]!, 3);
  });
  await expect(topCard.getByRole("button", { name: "Return to the author's view" })).toBeVisible();
  await captureEvidence(page, testInfo, "desktop-2-orbit");

  // Pitch is clamped both ways.
  // Several on-screen drags; the pointer never leaves the viewport.
  const dragVertically = async (distance: number, times: number) => {
    for (let i = 0; i < times; i += 1) {
      await page.mouse.move(center.x, center.y - distance / 2);
      await page.mouse.down();
      await page.mouse.move(center.x, center.y + distance / 2, { steps: 10 });
      await page.mouse.up();
    }
  };
  await dragVertically(500, 4);
  expect((await readPortal(page, top)).pitch).toBeCloseTo(PITCH_MAX, 5);
  await dragVertically(-500, 8);
  expect((await readPortal(page, top)).pitch).toBeCloseTo(PITCH_MIN, 5);

  // Zoom in to the inside end: within the bubble, model unscaled, bubble open.
  await page.mouse.move(center.x, center.y);
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(250);
  const inside = await readPortal(page, top);
  expect(inside.zoom, "zoom clamps at the inside end").toBe(0);
  expect(inside.cameraDistance).toBeCloseTo(inside.insideDistance, 2);
  expect(inside.cameraToBubbleCenter, "camera is inside the recorded bubble").toBeLessThan(inside.bubbleRadius);
  expect(inside.modelScale, "true scale is unchanged").toBeCloseTo(start.modelScale, 6);
  await expect(topCard).toHaveAttribute("style", /--portal-open:\s*1/);
  await captureEvidence(page, testInfo, "desktop-3-inside");

  // And back out to the outside end.
  for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 400);
  await page.waitForTimeout(250);
  const outside = await readPortal(page, top);
  expect(outside.zoom).toBe(1);
  expect(outside.cameraDistance).toBeCloseTo(outside.outsideDistance, 2);

  // Return glides back to the Follow pose.
  await topCard.getByRole("button", { name: "Return to the author's view" }).click();
  await expect(topCard).toHaveAttribute("data-portal-mode", "follow");
  await page.waitForTimeout(900);
  const returned = await readPortal(page, top);
  expect(returned.cameraDistance).toBeCloseTo(returned.outsideDistance, 2);

  // Play resumes time from the same moment.
  await topCard.getByRole("button", { name: "Play" }).click();
  await expect(topCard).toHaveAttribute("data-portal-paused", "false");
  await page.waitForTimeout(500);
  const resumed = await readPortal(page, top);
  expect(Math.max(...resumed.actionTimes), "time moves again after Play").not.toEqual(Math.max(...returned.actionTimes));

  // Keyboard: Space pauses, arrows look around, Escape returns.
  await topCard.locator(".feed-card-bubble-shell").focus();
  await page.keyboard.press("Space");
  await expect(topCard).toHaveAttribute("data-portal-paused", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(topCard).toHaveAttribute("data-portal-mode", "free");
  await page.keyboard.press("Escape");
  await expect(topCard).toHaveAttribute("data-portal-mode", "follow");

  // Scrolling away resets the card to Follow and playing.
  const belowCard = page.locator(`.feed-card[data-card-id="${below.id}"]`);
  await belowCard.evaluate((element) => element.scrollIntoView({ behavior: "instant" }));
  await expect(topCard).toHaveAttribute("data-portal-mode", "follow");
  await expect(topCard).toHaveAttribute("data-portal-paused", "false");

  // Each feed card owns a WebGL context; release the desktop page's before
  // the phone pages open so the browser stays under its context limit.
  await page.goto("about:blank");

  // ---------------- Phone, freeze variant ----------------
  const phone = await openPhonePage(browser, null);
  await waitForRendered(phone.page, top);
  await scrollFeedToTop(phone.page);
  const phoneCard = phone.page.locator(`.feed-card[data-card-id="${top.id}"]`);
  const phoneCenter = await cardCenter(phone.page, top);
  await captureEvidence(phone.page, testInfo, "phone-1-follow");

  // Playing: a vertical swipe browses to the next card.
  await touchSwipe(phone.cdp, phoneCenter, 0, -500);
  await expect.poll(() => feedScrollTop(phone.page), { message: "swipe scrolls the feed while playing" }).toBeGreaterThan(300);
  await scrollFeedToTop(phone.page);

  // Tap pauses; the card now keeps gestures for looking around.
  await phone.page.touchscreen.tap(phoneCenter.x, phoneCenter.y);
  await expect(phoneCard).toHaveAttribute("data-portal-paused", "true");
  await expect(phoneCard).toHaveClass(/portal-captured/);
  await touchSwipe(phone.cdp, phoneCenter, 0, 260);
  await phone.page.waitForTimeout(200);
  expect(await feedScrollTop(phone.page), "paused card does not scroll the feed").toBe(0);
  const phoneOrbit = await readPortal(phone.page, top);
  expect(phoneOrbit.mode).toBe("free");
  expect(phoneOrbit.pitch, "a downward drag raises the view").toBeGreaterThan(phoneOrbit.followPitch + 0.1);

  await phone.cdp.send("Input.synthesizePinchGesture", {
    x: phoneCenter.x,
    y: phoneCenter.y,
    scaleFactor: 3,
    relativeSpeed: 600,
    gestureSourceType: "touch"
  });
  await phone.page.waitForTimeout(250);
  expect((await readPortal(phone.page, top)).zoom, "pinching out moves in").toBeLessThan(0.7);
  await captureEvidence(phone.page, testInfo, "phone-2-pinched-in");
  expect(phone.errors, "phone runtime errors").toEqual([]);
  await phone.context.close();

  // ---------------- Phone, drag variant ----------------
  const drag = await openPhonePage(browser, "drag");
  await waitForRendered(drag.page, top);
  await scrollFeedToTop(drag.page);
  const dragCenter = await cardCenter(drag.page, top);
  const dragStart = await readPortal(drag.page, top);
  await touchSwipe(drag.cdp, dragCenter, -220, 0);
  await drag.page.waitForTimeout(200);
  const dragged = await readPortal(drag.page, top);
  expect(dragged.paused, "drag variant orbits while playing").toBe(false);
  expect(dragged.mode).toBe("free");
  expect(dragged.yaw - dragStart.followYaw, "sideways swipe orbits").toBeGreaterThan(0.3);
  expect(await feedScrollTop(drag.page)).toBe(0);
  await touchSwipe(drag.cdp, dragCenter, 0, -500);
  await expect.poll(() => feedScrollTop(drag.page), { message: "vertical swipe still browses" }).toBeGreaterThan(300);
  await captureEvidence(drag.page, testInfo, "phone-3-drag-variant");
  expect(drag.errors, "drag variant runtime errors").toEqual([]);
  await drag.context.close();

  // ---------------- Phone, tilt variant ----------------
  const tilt = await openPhonePage(browser, "tilt");
  await waitForRendered(tilt.page, top);
  await scrollFeedToTop(tilt.page);
  const tiltCard = tilt.page.locator(`.feed-card[data-card-id="${top.id}"]`);
  await tiltCard.getByRole("button", { name: "Look around by tilting the phone" }).click();
  await expect(tiltCard.getByRole("button", { name: "Stop looking around by tilting" })).toHaveAttribute("aria-pressed", "true");
  const turn = async (alpha: number, beta: number) => {
    await tilt.page.evaluate(([a, b]) => {
      window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { alpha: a, beta: b, gamma: 0 }));
    }, [alpha, beta]);
  };
  await turn(10, 60);
  await turn(12, 61);
  expect((await readPortal(tilt.page, top)).mode, "a small wobble stays in Follow").toBe("follow");
  await turn(40, 60);
  await expect(tiltCard).toHaveAttribute("data-portal-mode", "free");
  const tilted = await readPortal(tilt.page, top);
  expect(tilted.tiltYaw, "turning the phone turns the camera").toBeCloseTo((-30 * Math.PI / 180) * 1.5, 3);
  await captureEvidence(tilt.page, testInfo, "phone-4-tilt-variant");
  expect(tilt.errors, "tilt variant runtime errors").toEqual([]);
  await tilt.context.close();
});
