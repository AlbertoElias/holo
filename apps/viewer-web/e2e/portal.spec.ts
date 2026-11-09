import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { assertViewerShell, captureEvidence, expect, test, reachFor } from "./bootstrap";
import {
  PITCH_MAX,
  PITCH_MIN,
  cardCenter,
  dispatchOrientation,
  animationFrames,
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

  test("drag (default): a sideways swipe on the hologram orbits and a pinch zooms while playing", async ({ page }, testInfo) => {
    await openFeed(page, null);
    const cdp = await page.context().newCDPSession(page);
    await expect(page.locator(`.feed-card[data-card-id="${first.id}"]`)).toHaveAttribute("data-portal-variant", "drag");
    const start = await readPortal(page, first.url);
    const center = await cardCenter(page, first.id);
    const { on } = await hologramPoints(page, first.id, first.url, true);
    await touchSwipe(page, cdp, on, -220, 0);
    await expect.poll(async () => (await readPortal(page, first.url)).mode).toBe("free");
    const dragged = await readPortal(page, first.url);
    expect(dragged.paused, "still playing").toBe(false);
    expect(dragged.yaw - start.followYaw, "sideways swipe orbits").toBeGreaterThan(0.3);
    expect(await settleScroll(page), "a sideways swipe does not browse").toBe(0);
    await touchPinch(page, cdp, center, 60, 260);
    await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "pinching out moves in while playing" }).toBeLessThan(0.7);
    expect((await readPortal(page, first.url)).paused).toBe(false);
    await captureEvidence(page, testInfo, "phone-drag-variant");
  });

  test("drag (default): a swipe off the hologram scrolls, even one that begins sideways, and never turns it; one on the hologram looks around", async ({ page }, testInfo) => {
    await openFeed(page, null);
    const cdp = await page.context().newCDPSession(page);
    const { on, off } = await hologramPoints(page, first.id, first.url, true);
    const box = await page.locator(`.feed-card[data-card-id="${first.id}"] .feed-card-portal`).boundingBox();
    if (!box) throw new Error("viewing box not laid out");
    // Low in the viewing box, clear of the hologram and its glass.
    const below = { x: off.x, y: box.y + box.height * 0.92 };
    expect(await page.evaluate(({ x, y, path }) => {
      const probes = (window as unknown as { __portalProbes: Record<string, { portal: { runtime: { hitTest: (x: number, y: number, o?: { glass?: boolean }) => boolean } } }> }).__portalProbes;
      return Object.entries(probes).find(([url]) => url.endsWith(path))![1].portal.runtime.hitTest(x, y, { glass: true });
    }, { ...below, path: first.url }), "the swipe starts off the hologram").toBe(false);

    // A thumb often drifts sideways before it goes up; the browser will not
    // scroll a swipe that begins sideways, so the card scrolls it.
    const path = [[4, -1], [9, -3], [14, -5], [17, -20], [19, -80], [20, -200], [21, -340], [21, -480]] as const;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [below] });
    for (const [dx, dy] of path) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: below.x + dx, y: below.y + dy }] });
      await animationFrames(page);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await settleScroll(page), "the drifting swipe browses to the next card").toBe(PHONE.height);
    expect((await readPortal(page, first.url)).mode, "and the hologram it began beside did not turn").toBe("follow");
    expect((await readPortal(page, second.url)).mode, "nor the one that came under the finger").toBe("follow");

    // A swipe that crosses the hologram from below it still scrolls.
    await scrollFeedToTop(page);
    await touchSwipe(page, cdp, below, 0, -480);
    expect(await settleScroll(page), "a vertical swipe across the hologram browses").toBe(PHONE.height);
    expect((await readPortal(page, first.url)).mode).toBe("follow");

    const touchPath = async (from: { x: number; y: number }, steps: readonly (readonly [number, number])[]) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
      for (const [dx, dy] of steps) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + dx, y: from.y + dy }] });
        await animationFrames(page);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };

    // A short sideways nudge off the hologram that ends drifting a pixel or
    // two up is no flick: it neither browses nor turns the hologram.
    await scrollFeedToTop(page);
    await touchPath(below, [[-6, 0], [-9, 0], [-14, -2]]);
    expect(await settleScroll(page), "a couple of pixels of drift is no flick").toBe(0);
    expect((await readPortal(page, first.url)).mode, "a sideways swipe off the hologram does not turn it").toBe("follow");

    // A swipe carried past the middle, where focus moves to the next card,
    // and brought back, stays with the finger and settles on the first card.
    await touchPath(below, [[4, -1], [9, -3], [14, -5], [16, -120], [17, -300], [17, -500], [17, -400], [17, -250], [17, -100]]);
    expect(await settleScroll(page), "the swipe brought back settles where it began").toBe(0);

    // A pinch off the hologram zooms and keeps the feed still, even as the
    // fingers move up while they spread.
    const zoomBefore = (await readPortal(page, first.url)).zoom;
    const pinchAt = (gap: number, rise: number) => [{ x: below.x, y: below.y - 40 - rise - gap / 2, id: 0 }, { x: below.x, y: below.y - 40 - rise + gap / 2, id: 1 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pinchAt(40, 0) });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pinchAt(40 + 30 * i, 20 * i) });
      await animationFrames(page);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(await settleScroll(page), "a pinch does not scroll").toBe(0);
    await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "a pinch off the hologram zooms" }).toBeLessThan(zoomBefore);
    const firstCard = page.locator(`.feed-card[data-card-id="${first.id}"]`);
    await firstCard.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView }).click({ force: true });
    await expect(firstCard).toHaveAttribute("data-portal-mode", "follow");

    // A touch that stops the feed's glide is not a tap: nothing pauses. The
    // glide stays short of the middle, so the card keeps focus.
    const feed = page.locator(".feed-scroll");
    await feed.evaluate((element) => {
      element.style.scrollSnapType = "none";
      // Snapping comes back only once this glide has ended: put back while
      // it still runs, the feed is left where the glide stops, off a card.
      (window as unknown as { glideEnded?: Promise<void> }).glideEnded = new Promise((resolve) => {
        element.addEventListener("scrollend", () => resolve(), { once: true });
      });
      element.scrollTo({ top: 300, behavior: "smooth" });
    });
    await expect.poll(() => feedScrollTop(page), { timeout: 2000, intervals: [10] }).toBeGreaterThan(20);
    await page.touchscreen.tap(below.x, below.y);
    // A negative (no pause follows) over the app's tap window: a real-time hold.
    await page.waitForTimeout(400);
    await expect(firstCard).toHaveAttribute("data-card-focus", "true");
    expect((await readPortal(page, first.url)).paused, "the card it stopped on did not pause").toBe(false);
    await page.evaluate(() => (window as unknown as { glideEnded: Promise<void> }).glideEnded);
    await feed.evaluate((element) => { element.style.scrollSnapType = ""; });
    await scrollFeedToTop(page);

    // On the hologram, even a vertical swipe looks around and keeps the feed still.
    const start = await readPortal(page, first.url);
    await touchSwipe(page, cdp, on, 0, 160);
    expect(await settleScroll(page), "a swipe on the hologram does not browse").toBe(0);
    const looked = await readPortal(page, first.url);
    expect(looked.mode).toBe("free");
    expect(looked.pitch, "a downward drag on the hologram raises the view").toBeGreaterThan(start.followPitch + 0.1);
    await captureEvidence(page, testInfo, "phone-touch-scroll-or-look");
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
  // A loaded main thread can start the scroll after three still readings,
  // which settleScroll would take for settled at the top.
  await expect.poll(() => feedScrollTop(page), { message: "fully out, the wheel scrolls to the next card" }).toBeGreaterThan(0);
  expect(await settleScroll(page)).toBeGreaterThan(0);
});

/** One point in the viewing box, within the window, on the hologram itself and one off it, as the canvas's hit test sees them. */
/** A point on the hologram and one off it in the viewing box; `glass` counts its cloche, as a touch does. */
async function hologramPoints(page: Page, cardId: string, modelPath: string, glass = false): Promise<{ on: { x: number; y: number }; off: { x: number; y: number } }> {
  const box = await page.locator(`.feed-card[data-card-id="${cardId}"] .feed-card-portal`).boundingBox();
  if (!box) throw new Error("viewing box not laid out");
  return page.evaluate(({ box, path, glass }) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { portal: { runtime: { hitTest: ((x: number, y: number, options?: { glass?: boolean }) => boolean) | null } } }> }).__portalProbes;
    const hitTest = Object.entries(probes).find(([url]) => url.endsWith(path))?.[1].portal.runtime.hitTest;
    if (!hitTest) throw new Error(`no hit test for ${path}`);
    let on: { x: number; y: number } | null = null;
    let off: { x: number; y: number } | null = null;
    for (let row = 1; row < 12; row += 1) {
      for (let column = 1; column < 12; column += 1) {
        const point = { x: box.x + (box.width * column) / 12, y: box.y + (box.height * row) / 12 };
        if (point.y < 4 || point.y > window.innerHeight - 4) continue;
        if (hitTest(point.x, point.y, { glass })) on ??= point;
        else off ??= point;
      }
    }
    if (!on || !off) throw new Error(`the viewing box is all ${on ? "hologram" : "empty space"}`);
    return { on, off };
  }, { box, path: modelPath, glass });
}

test("desktop: the wheel scrolls the feed unless it begins on the hologram itself", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 440 });
  await openFeed(page, null);
  const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);
  // Paused, a plain wheel zooms; before, it did so anywhere on the card.
  await card.getByRole("button", { name: CONTROL_NAMES.pause }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "true");
  const { on, off } = await hologramPoints(page, first.id, first.url);
  const start = await readPortal(page, first.url);

  // Over empty space in the card, the gesture scrolls the feed (past half a
  // card, so the snap carries it on), and stays a scroll as the next
  // hologram passes under the pointer.
  await page.mouse.move(off.x, off.y);
  for (const delta of [300, 40, 40, 40]) await page.mouse.wheel(0, delta);
  expect(await settleScroll(page), "the wheel scrolls past the hologram").toBeGreaterThan(0);
  expect((await readPortal(page, first.url)).zoom, "the hologram it passed did not zoom").toBe(start.zoom);
  expect((await readPortal(page, second.url)).zoom, "nor the one that came under the pointer").toBe(1);
  await captureEvidence(page, testInfo, "wheel-scrolls-past-hologram");

  // On the hologram itself, the same wheel zooms and the feed stays put.
  await scrollFeedToTop(page);
  if ((await card.getAttribute("data-portal-paused")) !== "true") {
    await card.getByRole("button", { name: CONTROL_NAMES.pause }).click();
    await expect(card).toHaveAttribute("data-portal-paused", "true");
  }
  await page.mouse.move(on.x, on.y);
  // A new gesture: the app groups wheel events by a real-time gap.
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "the wheel on the hologram zooms" }).toBeLessThan(1);
  expect(await feedScrollTop(page)).toBe(0);

  // A trackpad pinch still zooms wherever it lands on the card.
  const pinched = (await readPortal(page, first.url)).zoom;
  await page.mouse.move(off.x, off.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await readPortal(page, first.url)).zoom, { message: "a pinch off the hologram zooms" }).toBeLessThan(pinched);
  expect(await feedScrollTop(page)).toBe(0);
});

test("desktop: a scroll back up stays a scroll as the card above, and its hologram, come under the pointer", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 440 });
  await openFeed(page, null);
  const feed = page.locator(".feed-scroll");
  const above = page.locator(`.feed-card[data-card-id="${first.id}"]`);
  const below = page.locator(`.feed-card[data-card-id="${second.id}"]`);
  const cardHeight = await above.evaluate((element) => (element as HTMLElement).offsetHeight);
  const scrollTo = (top: number) => feed.evaluate((element, to) => element.scrollTo({ top: to, behavior: "instant" }), top);
  // Without snapping, a part-way scroll stays where the wheel leaves it.
  await feed.evaluate((element) => { element.style.scrollSnapType = "none"; });
  // Where the card above shows its hologram, most of the way back up.
  const partWay = Math.round(cardHeight * 0.35);
  await scrollTo(partWay);
  const { on: onAbove } = await hologramPoints(page, first.id, first.url);
  await scrollTo(cardHeight);
  await expect(below).toHaveAttribute("data-card-focus", "true");
  await waitForPortalReady(page, second.id, second.url);
  const { off: offBelow } = await hologramPoints(page, second.id, second.url);
  const zoomAbove = (await readPortal(page, first.url)).zoom;

  // The gesture begins over empty space on the card below and carries the
  // feed back up until the card above takes focus, its hologram now under
  // the pointer; the gesture goes on (as trackpad momentum does) and still
  // scrolls. The wheel events carry their own times, 50 ms apart as a
  // trackpad's are: on a slow runner the round trips between them would
  // otherwise pass the gesture gap and split the gesture.
  const cdp = await page.context().newCDPSession(page);
  let clock = Date.now() / 1000;
  const wheel = async (at: { x: number; y: number }, deltaX: number, deltaY: number) => {
    clock += 0.05;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX, deltaY, timestamp: clock });
  };
  await page.mouse.move(offBelow.x, offBelow.y);
  await wheel(offBelow, 0, partWay - cardHeight);
  await page.mouse.move(onAbove.x, onAbove.y);
  for (let i = 0; i < 40 && (await above.getAttribute("data-card-focus")) !== "true"; i += 1) await wheel(onAbove, 1, 0);
  await expect(above).toHaveAttribute("data-card-focus", "true");
  for (const delta of [-40, -40]) await wheel(onAbove, 0, delta);
  await expect.poll(() => feedScrollTop(page), { message: "the wheel kept scrolling over the hologram above" }).toBeLessThan(partWay - 40);
  expect((await readPortal(page, first.url)).zoom, "the hologram above did not zoom").toBe(zoomAbove);
  await captureEvidence(page, testInfo, "wheel-scrolls-back-up-past-hologram");
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

test("desktop freeze: scrolling away just after a drag on a playing card stays scrolled", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 440 });
  await openFeed(page, "freeze");
  // While playing, a freeze drag belongs to the feed; this one leaves it on the card.
  const center = await cardCenter(page, first.id);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 200, center.y, { steps: 3 });
  await page.mouse.up();
  await page.locator(`.feed-card[data-card-id="${second.id}"]`).evaluate((element) => element.scrollIntoView({ behavior: "instant" }));
  const away = await feedScrollTop(page);
  expect(away).toBeGreaterThan(0);
  // Past the 800 ms a settle waits for its glide: nothing pulls the feed back.
  await page.waitForTimeout(1200);
  expect(await feedScrollTop(page), "the feed stays on the card it scrolled to").toBe(away);
});
