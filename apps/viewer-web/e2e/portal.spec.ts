import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { assertViewerShell, captureEvidence, expect, test, reachFor } from "./bootstrap";
import {
  PITCH_MAX,
  PITCH_MIN,
  cardCenter,
  dispatchOrientation,
  feedScrollTop,
  installProbe,
  readPortal,
  scrollFeedToTop,
  settleScroll,
  touchPinch,
  touchSwipe,
  waitForFrozenTimes,
  waitForPortalReady
} from "./portal-helpers";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

// Portal view (PRD-002) trigger logic on a mocked two-card feed: phone touch,
// the three variants, keyboard, clamps, and reset on scroll. The real capture
// export (bubble, recorded motion) is covered by portal.pipeline.spec.ts.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlb = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const PHONE = { width: 390, height: 844 };
const items = ["a", "b"].map((key) => ({
  id: `portal-${key}`,
  url: `/uploads/portal-${key}.glb`,
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-10-19T00:00:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: `portal-${key}.glb`,
  hologramName: `Portal ${key}`,
  submittedBy: "automation"
}));
const [first, second] = items as [typeof items[number], typeof items[number]];

// Each touch event waits for a software-rendered frame; a 2-CPU runner needs
// about 30 s for the longest of these.
test.describe.configure({ timeout: 60_000 });

async function openFeed(page: Page, variant: string | null): Promise<void> {
  await installProbe(page);
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items, nextCursor: null } }));
  await page.route("**/uploads/**", (route) => route.fulfill({ path: avatarGlb, contentType: "model/gltf-binary" }));
  await page.goto(variant ? `/?portal=${variant}` : "/");
  await assertViewerShell(page);
  await waitForPortalReady(page, first.id, first.url);
  await scrollFeedToTop(page);
}

test.describe("phone", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });

  test("freeze: swipes browse while playing; paused, the card keeps swipes and pinches for looking around", async ({ page }, testInfo) => {
    await openFeed(page, "freeze");
    const cdp = await page.context().newCDPSession(page);
    const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);
    await expect(card).toHaveAttribute("data-portal-variant", "freeze");
    const center = await cardCenter(page, first.id);

    await touchSwipe(page, cdp, { x: center.x, y: center.y + 150 }, 0, -480);
    expect(await settleScroll(page), "a swipe while playing browses to the next card").toBeGreaterThan(300);
    await scrollFeedToTop(page);

    await page.touchscreen.tap(center.x, center.y);
    await expect(card).toHaveAttribute("data-portal-paused", "true");
    await expect(card).toHaveClass(/portal-captured/);
    const frozen = await waitForFrozenTimes(page, first.url);
    const before = await readPortal(page, first.url);
    await touchSwipe(page, cdp, center, 0, 260);
    expect(await settleScroll(page), "a paused card does not scroll the feed").toBe(0);
    const orbit = await readPortal(page, first.url);
    expect(orbit.mode).toBe("free");
    expect(orbit.pitch, "a downward drag raises the view").toBeGreaterThan(before.followPitch + 0.1);
    expect(orbit.actionTimes, "time stays frozen while looking around").toEqual(frozen);

    await touchPinch(page, cdp, center, 60, 260);
    await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "pinching out moves in" }).toBeLessThan(0.7);
    await captureEvidence(page, testInfo, "phone-freeze-looking-around");
  });

  test("drag (default): a sideways swipe orbits and a pinch zooms while playing; vertical swipes still browse", async ({ page }, testInfo) => {
    await openFeed(page, null);
    const cdp = await page.context().newCDPSession(page);
    await expect(page.locator(`.feed-card[data-card-id="${first.id}"]`)).toHaveAttribute("data-portal-variant", "drag");
    const start = await readPortal(page, first.url);
    const center = await cardCenter(page, first.id);
    await touchSwipe(page, cdp, { x: center.x + 110, y: center.y }, -220, 0);
    await expect.poll(async () => (await readPortal(page, first.url)).mode).toBe("free");
    const dragged = await readPortal(page, first.url);
    expect(dragged.paused, "still playing").toBe(false);
    expect(dragged.yaw - start.followYaw, "sideways swipe orbits").toBeGreaterThan(0.3);
    expect(await settleScroll(page), "a sideways swipe does not browse").toBe(0);
    await touchPinch(page, cdp, center, 60, 260);
    await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "pinching out moves in while playing" }).toBeLessThan(0.7);
    expect((await readPortal(page, first.url)).paused).toBe(false);
    await captureEvidence(page, testInfo, "phone-drag-variant");
    await touchSwipe(page, cdp, { x: center.x, y: center.y + 150 }, 0, -480);
    expect(await settleScroll(page), "a vertical swipe still browses").toBeGreaterThan(300);
  });

  test("tilt: turning the phone turns the camera, past a small deadzone", async ({ page }, testInfo) => {
    await openFeed(page, "tilt");
    const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);
    await reachFor(card);
    await card.getByRole("button", { name: "Look around by tilting the phone" }).click();
    await expect(card.getByRole("button", { name: "Stop looking around by tilting" })).toHaveAttribute("aria-pressed", "true");
    await dispatchOrientation(page, 10, 60);
    await dispatchOrientation(page, 12, 61);
    expect((await readPortal(page, first.url)).mode, "a small wobble stays in Follow").toBe("follow");
    await dispatchOrientation(page, 40, 60);
    await expect(card).toHaveAttribute("data-portal-mode", "free");
    expect((await readPortal(page, first.url)).tiltYaw, "yaw follows the turn, amplified").toBeCloseTo((-30 * Math.PI / 180) * 1.5, 3);

    // Return re-centres tilt on how the phone is held now.
    await card.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView }).click();
    await expect(card).toHaveAttribute("data-portal-mode", "follow");
    await dispatchOrientation(page, 41, 60);
    expect((await readPortal(page, first.url)).mode, "holding still after Return stays in Follow").toBe("follow");
    await captureEvidence(page, testInfo, "phone-tilt-variant");
  });
});

test("desktop (default): drag rotates, and the wheel or trackpad pinch over the bubble zooms, while playing", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 440 });
  await openFeed(page, null);
  const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);
  const center = await cardCenter(page, first.id);
  const start = await readPortal(page, first.url);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 150, center.y - 60, { steps: 3 });
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-portal-mode", "free");
  const rotated = await readPortal(page, first.url);
  expect(rotated.paused, "still playing").toBe(false);
  expect(rotated.yaw - start.followYaw, "dragging left orbits").toBeGreaterThan(0.3);
  expect(rotated.pitch, "dragging up lowers the view").toBeLessThan(start.followPitch);

  await page.mouse.move(center.x, center.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "a trackpad pinch zooms while playing" }).toBeLessThan(1);
  expect(await feedScrollTop(page)).toBe(0);

  await page.mouse.wheel(0, -300);
  const wheeled = await readPortal(page, first.url);
  expect(wheeled.zoom, "a plain wheel over the bubble zooms in while playing").toBeLessThan(1);
  expect(wheeled.paused).toBe(false);
  expect(await feedScrollTop(page)).toBe(0);

  // Wheeling out zooms back to the outside end, then scrolls the feed.
  await page.mouse.wheel(0, 3000);
  expect((await readPortal(page, first.url)).zoom).toBe(1);
  expect(await settleScroll(page), "zooming out does not scroll the feed").toBe(0);
  await page.mouse.wheel(0, 500);
  expect(await settleScroll(page), "fully out, the wheel scrolls to the next card").toBeGreaterThan(0);
});

test("desktop freeze: drags only explore while paused, pitch is clamped, keyboard works, and scrolling away resets", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 440 });
  await openFeed(page, "freeze");
  const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);
  const center = await cardCenter(page, first.id);
  const drag = async (dx: number, dy: number) => {
    await page.mouse.move(center.x, center.y - dy / 2);
    await page.mouse.down();
    await page.mouse.move(center.x + dx, center.y + dy / 2, { steps: 3 });
    await page.mouse.up();
  };

  await drag(-200, 0);
  expect((await readPortal(page, first.url)).mode, "a drag while playing stays in Follow").toBe("follow");

  // A drag that ends over the upload panel must not leave a stuck gesture.
  await page.mouse.click(center.x, center.y);
  await expect(card).toHaveAttribute("data-portal-paused", "true");

  // Short drags that stay inside the 440 px window.
  for (let i = 0; i < 3; i += 1) await drag(0, 170);
  expect((await readPortal(page, first.url)).pitch).toBeCloseTo(PITCH_MAX, 5);
  for (let i = 0; i < 3; i += 1) await drag(0, -170);
  expect((await readPortal(page, first.url)).pitch).toBeCloseTo(PITCH_MIN, 5);

  await card.locator(".feed-card-bubble-shell").focus();
  await page.keyboard.press("Escape");
  await expect(card).toHaveAttribute("data-portal-mode", "follow");
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("data-portal-paused", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(card).toHaveAttribute("data-portal-mode", "free");
  await page.keyboard.press("+");
  expect((await readPortal(page, first.url)).zoom).toBeLessThan(1);
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("data-portal-paused", "true");

  await page.locator(`.feed-card[data-card-id="${second.id}"]`).evaluate((element) => element.scrollIntoView({ behavior: "instant" }));
  await expect(card).toHaveAttribute("data-portal-mode", "follow");
  await expect(card).toHaveAttribute("data-portal-paused", "false");
  expect(await feedScrollTop(page)).toBeGreaterThan(0);
});
