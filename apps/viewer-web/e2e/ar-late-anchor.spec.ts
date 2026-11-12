import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import type * as Three from "three";
import { freezePageClock, stepXr, waitForIwerSession, waitForXrRenderLoop } from "@holoim/tooling-testing/xr-env";

import { expect, observeFeedCardRenderer, pressViewInAr, test, waitForFeedCardPresented } from "./bootstrap";

// Bugs replayed from a TLA+ model of the R3F AR view's placement stage (B-048):
// `createAnchor` resolves some frames after it was asked, and by then the
// model may have been placed again. A device resolves it within a few frames;
// the shim here holds it until the check says so, so each ordering is exact.
// The view under test is `ARHologramModel` (`/?shell=r3f`, the fallback shell).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlb = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const evidenceDir = path.resolve(testDir, "../../../output/ar-late-anchor");

const item = {
  id: "late-anchor",
  url: "/uploads/late-anchor.glb",
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-11-11T09:30:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: "late-anchor.glb",
  hologramName: "Late anchor",
  submittedBy: "automation"
};

type Vec3 = [number, number, number];
type ArProbe = { model: Three.Object3D };
type AnchorShim = { hold: boolean; requested: number; resolved: number; release(newestFirst?: boolean): void };
type Hooks = Window & {
  __HOLOIM_AR_TEST_OBSERVER__?: (value: ArProbe) => void;
  __arProbe?: ArProbe;
  __anchorShim?: AnchorShim;
  IWER_DEVICE: { controlMode: string; position: { set(...v: number[]): void }; quaternion: { set(...v: number[]): void } };
};

interface Reading {
  stage: string;
  mode: string;
  reason: string;
  anchored: boolean;
  sequence: number;
  /** The model group's own position, not the status's copy of it. */
  position: Vec3;
}

async function mockFeed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__ = true;
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [item], nextCursor: null } }));
  await page.route(`**/api/holograms/${item.id}`, (route) => route.fulfill({ json: item }));
  await page.route("**/uploads/**", (route) => route.fulfill({ path: avatarGlb, contentType: "model/gltf-binary" }));
}

/**
 * Holds every `XRFrame.createAnchor` promise until `release()`. IWER makes the
 * anchor when asked; only the answer reaches the app late.
 */
async function installAnchorShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hooks = window as Hooks;
    const waiting: Array<() => void> = [];
    const shim: AnchorShim = { hold: true, requested: 0, resolved: 0, release: (newestFirst = false) => (newestFirst ? waiting.splice(0).reverse() : waiting.splice(0)).forEach((resolve) => resolve()) };
    hooks.__anchorShim = shim;
    // IWER can publish its globals again when a session starts, so every class
    // the page sees is patched once, for as long as the page lives.
    const patched = new WeakSet<object>();
    window.setInterval(() => {
      const prototype = (window as unknown as { XRFrame?: { prototype: { createAnchor?: (...args: unknown[]) => Promise<unknown> } } }).XRFrame?.prototype;
      if (!prototype?.createAnchor || patched.has(prototype)) return;
      patched.add(prototype);
      const original = prototype.createAnchor;
      prototype.createAnchor = function (this: unknown, ...args: unknown[]) {
        shim.requested += 1;
        const made = original.apply(this, args);
        if (!shim.hold) return made.then((anchor) => { shim.resolved += 1; return anchor; });
        return new Promise((resolve, reject) => {
          waiting.push(() => made.then((anchor) => { shim.resolved += 1; resolve(anchor); }, reject));
        });
      };
    }, 5);
  });
}

async function enterR3fAr(page: Page): Promise<void> {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.addInitScript(() => {
    (window as Hooks).__HOLOIM_AR_TEST_OBSERVER__ = (value) => { (window as Hooks).__arProbe = value; };
  });
  await installAnchorShim(page);
  await mockFeed(page);
  await observeFeedCardRenderer(page);
  await page.goto("/?shell=r3f");
  await waitForFeedCardPresented(page);
  await pressViewInAr(page);
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await page.waitForFunction(() => Boolean((window as Hooks).__arProbe));
  // From here every frame is stepped, so the frame counts below are exact.
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
}

async function read(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const view = document.querySelector(".ar-view-container")!;
    const probe = (window as Hooks).__arProbe!;
    const group = probe.model.parent!;
    return {
      stage: view.getAttribute("data-placement-stage") ?? "",
      mode: view.getAttribute("data-placement-mode") ?? "",
      reason: view.getAttribute("data-placement-reason") ?? "",
      anchored: view.getAttribute("data-placement-anchored") === "true",
      sequence: Number(view.getAttribute("data-placement-sequence")),
      position: [group.position.x, group.position.y, group.position.z] as Vec3
    };
  });
}

/** Steps single frames until the model is placed with the given mode; returns that frame's reading. */
async function stepUntilPlaced(page: Page, minSequence = 1, maxFrames = 200): Promise<Reading> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await stepXr(page, 1);
    const reading = await read(page);
    if (reading.stage === "placed" && reading.sequence >= minSequence) return reading;
  }
  throw new Error(`not placed after ${maxFrames} frames: ${JSON.stringify(await read(page))} anchors ${JSON.stringify(await anchorCounts(page))}`);
}

const anchorCounts = (page: Page) => page.evaluate(() => {
  const { requested, resolved } = (window as Hooks).__anchorShim!;
  return { requested, resolved };
});

const lookAway = (page: Page) => page.evaluate(() => {
  const device = (window as Hooks).IWER_DEVICE;
  device.controlMode = "programmatic";
  device.quaternion.set(0, 1, 0, 0);
});

const moveHead = (page: Page, position: Vec3) => page.evaluate((to) => {
  const device = (window as Hooks).IWER_DEVICE;
  device.controlMode = "programmatic";
  device.position.set(...to);
}, position);

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

async function record(name: string, steps: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `${name}.json`), `${JSON.stringify(steps, null, 2)}\n`);
}

test.describe.configure({ timeout: 120_000 });

test("R3F AR: an anchor that resolves after the visibility fallback moved the model does not pull it back", async ({ page }) => {
  await enterR3fAr(page);

  // The first placement is on a surface, and its anchor is still pending.
  const placed = await stepUntilPlaced(page);
  expect(placed.mode, "a surface placement").toMatch(/hit-test|plane/);
  expect((await anchorCounts(page)).requested, "an anchor was asked for at that spot").toBe(1);

  // The viewer turns away; the model is out of view, so the fallback puts it in front of the camera.
  await lookAway(page);
  let fallback = await read(page);
  for (let frame = 0; frame < 40 && fallback.mode !== "visibility-fallback"; frame += 1) {
    await stepXr(page, 1);
    fallback = await read(page);
  }
  expect(fallback.mode, "the model was out of view, so it moved in front of the viewer").toBe("visibility-fallback");
  expect(distance(fallback.position, placed.position), "the fallback moved the model").toBeGreaterThan(0.5);

  // The anchor for the old spot now resolves.
  await page.evaluate(() => (window as Hooks).__anchorShim!.release());
  await stepXr(page, 10);
  const after = await read(page);
  expect((await anchorCounts(page)).resolved, "the late anchor did resolve").toBe(1);
  await record("late-anchor-after-visibility-fallback", { placed, fallback, after, anchorCounts: await anchorCounts(page) });

  expect(after.mode, "still placed in front of the viewer").toBe("visibility-fallback");
  expect(after.anchored, "a stale anchor is not adopted").toBe(false);
  expect(distance(after.position, fallback.position), `the model stays where the fallback put it (was ${JSON.stringify(fallback.position)}, now ${JSON.stringify(after.position)})`).toBeLessThan(0.02);
});

test("R3F AR: Recenter while an anchor is pending; the old anchor, arriving last, does not pull the new placement back", async ({ page }) => {
  await enterR3fAr(page);
  const first = await stepUntilPlaced(page);
  expect((await anchorCounts(page)).requested).toBe(1);

  // The viewer walks a metre to the side and presses Recenter; the model is placed again there.
  await moveHead(page, [1, 1.6, 0]);
  await stepXr(page, 3);
  await page.evaluate(() => (document.querySelector('button[aria-label="Recenter Model"]') as HTMLButtonElement).click());
  const second = await stepUntilPlaced(page, first.sequence + 1);
  expect(distance(second.position, first.position), "the second placement is somewhere else").toBeGreaterThan(0.5);

  // IWER makes the second anchor a frame after it is asked.
  await stepXr(page, 3);
  // WebXR does not order the answers of two createAnchor calls: the newer
  // spot's anchor arrives first, then the old spot's.
  await page.evaluate(() => (window as Hooks).__anchorShim!.release(true));
  await stepXr(page, 10);
  const after = await read(page);
  await record("late-anchor-after-recenter", { first, second, after, anchorCounts: await anchorCounts(page) });

  expect(distance(after.position, second.position), `the model stays at the new placement (was ${JSON.stringify(second.position)}, now ${JSON.stringify(after.position)})`).toBeLessThan(0.02);
});

test("R3F AR: an anchor that resolves after the model locked keeps it in place, and an anchored model is not moved by looking away", async ({ page }) => {
  await enterR3fAr(page);
  const placed = await stepUntilPlaced(page);

  // In view for the whole monitor window (45 frames): locked, still unanchored.
  await stepXr(page, 60);
  const locked = await read(page);
  expect(locked.stage, "locked after the monitor window").toBe("locked");
  expect(locked.mode).toBe(placed.mode);

  await page.evaluate(() => (window as Hooks).__anchorShim!.release());
  await stepXr(page, 10);
  const anchored = await read(page);
  expect(distance(anchored.position, locked.position), "the late anchor holds the model at the same spot").toBeLessThan(0.02);
  expect(anchored.mode, "the placement mode is unchanged").toBe(placed.mode);
  expect(anchored.sequence, "no new placement").toBe(placed.sequence);

  // An anchored model stays where the room holds it when the viewer looks away.
  await lookAway(page);
  await stepXr(page, 60);
  const away = await read(page);
  await record("late-anchor-after-lock", { placed, locked, anchored, away });
  expect(distance(away.position, anchored.position), "looking away does not move an anchored model").toBeLessThan(0.02);
  expect(away.mode).toBe(placed.mode);
});
