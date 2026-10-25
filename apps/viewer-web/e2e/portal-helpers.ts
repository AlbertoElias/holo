import type { CDPSession, Page } from "@playwright/test";

import { expect } from "./bootstrap";

// Shared by the portal specs (PRD-002). Readings come from the dev-only feed
// observer, keyed by model URL so several cards can be told apart.

export const PITCH_MIN = (-8 * Math.PI) / 180;
export const PITCH_MAX = (78 * Math.PI) / 180;

export type PortalReading = {
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

export async function installProbe(page: Page): Promise<void> {
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

export async function readPortal(page: Page, modelPath: string): Promise<PortalReading> {
  return page.evaluate((path) => {
    type ProbeShape = {
      camera: { position: { distanceTo: (v: unknown) => number } };
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
    const entry = Object.entries(probes).find(([url]) => url.endsWith(path));
    if (!entry) throw new Error(`No portal probe for ${path}`);
    const probe = entry[1];
    const { measured, followYaw, followPitch } = probe.portal.runtime;
    return {
      ...probe.portal.getState(),
      followYaw,
      followPitch,
      ...measured,
      target: [...measured.target] as [number, number, number],
      cameraToBubbleCenter: probe.bubble.active ? probe.camera.position.distanceTo(probe.bubble.center) : Number.NaN,
      bubbleRadius: probe.bubble.radius,
      modelScale: probe.model.getWorldScale(probe.model.position.clone()).x,
      actionTimes: Object.values(probe.actions).filter(Boolean).map((action) => action!.time)
    };
  }, modelPath);
}

/** The card drew its model and the canvas has framed it at least once. */
export async function waitForPortalReady(page: Page, cardId: string, modelPath: string): Promise<void> {
  const card = page.locator(`.feed-card[data-card-id="${cardId}"]`);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await page.waitForFunction((path) => {
    const probes = (window as unknown as { __portalProbes?: Record<string, { portal?: { runtime: { measured: { outsideDistance: number } } } }> }).__portalProbes ?? {};
    const entry = Object.entries(probes).find(([url]) => url.endsWith(path));
    return (entry?.[1].portal?.runtime.measured.outsideDistance ?? 0) > 0;
  }, modelPath);
}

/**
 * Animation times once pausing has taken effect. The canvas applies pause in
 * its own render pass, a frame after the card's attribute changes.
 */
export async function waitForFrozenTimes(page: Page, modelPath: string): Promise<number[]> {
  let previous = (await readPortal(page, modelPath)).actionTimes.join(",");
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(150);
    const current = (await readPortal(page, modelPath)).actionTimes;
    if (current.join(",") === previous) return current;
    previous = current.join(",");
  }
  throw new Error("animation time did not stop");
}

export async function cardCenter(page: Page, cardId: string): Promise<{ x: number; y: number }> {
  // The viewing box: the cloche is framed in it, over the canvas that fills the card.
  const box = await page.locator(`.feed-card[data-card-id="${cardId}"] .feed-card-portal`).boundingBox();
  if (!box) throw new Error("viewing box not laid out");
  return { x: box.x + box.width / 2, y: box.y + box.height * 0.4 };
}

export async function feedScrollTop(page: Page): Promise<number> {
  return page.locator(".feed-scroll").evaluate((element) => element.scrollTop);
}

// Waits out momentum and snap animations: a reset during a fling is undone.
// Settled means unchanged across three reads and resting on a card boundary.
export async function settleScroll(page: Page): Promise<number> {
  const readings: number[] = [];
  for (let i = 0; i < 60; i += 1) {
    const { top, cardHeight } = await page.locator(".feed-scroll").evaluate((element) => ({
      top: element.scrollTop,
      cardHeight: element.querySelector<HTMLElement>(".feed-card")?.offsetHeight ?? 1
    }));
    readings.push(top);
    const lastThree = readings.slice(-3);
    if (lastThree.length === 3 && lastThree.every((value) => value === top) && Math.abs(top / cardHeight - Math.round(top / cardHeight)) < 0.01) {
      return top;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`feed scroll did not settle: ${readings.slice(-5).join(", ")}`);
}

export async function scrollFeedToTop(page: Page): Promise<void> {
  await settleScroll(page);
  await page.locator(".feed-scroll").evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
  expect(await settleScroll(page)).toBe(0);
}

// Raw touch events: Linux headless Chrome ignores synthesized scroll and
// pinch gestures, but scrolls and fires pointer events for these everywhere.
// Each event waits for a frame, so few steps keep CI runners fast.
const TOUCH_STEPS = 5;

export async function touchSwipe(page: Page, cdp: CDPSession, from: { x: number; y: number }, xDistance: number, yDistance: number): Promise<void> {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= TOUCH_STEPS; i += 1) {
    const t = i / TOUCH_STEPS;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + xDistance * t, y: from.y + yDistance * t }]
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export async function touchPinch(page: Page, cdp: CDPSession, center: { x: number; y: number }, startGap: number, endGap: number): Promise<void> {
  const points = (gap: number) => [
    { x: center.x - gap / 2, y: center.y, id: 0 },
    { x: center.x + gap / 2, y: center.y, id: 1 }
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(startGap) });
  for (let i = 1; i <= TOUCH_STEPS; i += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: points(startGap + ((endGap - startGap) * i) / TOUCH_STEPS)
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export async function dispatchOrientation(page: Page, alpha: number, beta: number): Promise<void> {
  await page.evaluate(([a, b]) => {
    window.dispatchEvent(new DeviceOrientationEvent("deviceorientation", { alpha: a, beta: b, gamma: 0 }));
  }, [alpha, beta]);
}
