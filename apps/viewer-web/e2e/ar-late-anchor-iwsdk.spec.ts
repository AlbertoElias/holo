import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import {
  installPageClock,
  freezePageClock,
  stepXr,
  stepXrCall,
  waitForIwerRuntime,
  waitForIwerSession,
  waitForXrRenderLoop
} from "@holoim/tooling-testing/xr-env";
import { emulatePhone } from "@holoim/tooling-testing/iwer-phone";

import { assertViewerShell, expect, reachFor, test } from "./bootstrap";
import { settleScroll } from "./portal-helpers";

// B-048's sibling in the default IWSDK AR shell (`/ar/:id`, ArPlacementSystem):
// `createAnchor` resolves some frames after it was asked, and by then the
// hologram may have been placed again, by a floor tap or a two-hand move. A
// device resolves it within a few frames; the shim here holds every answer
// until the check says so, so each ordering is exact. Emulation (IWER) only.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlbPath = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const evidenceDir = path.resolve(testDir, "../../../output/ar-late-anchor-iwsdk");

const item = {
  id: "late-anchor-iwsdk",
  url: "/uploads/late-anchor-iwsdk.glb",
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-11-12T09:30:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: "late-anchor-iwsdk.glb",
  hologramName: "Late anchor",
  submittedBy: "automation"
};

type Vec3 = [number, number, number];
type Snapshot = {
  placement: { stage: string; mode: string | null; sequence: number; position: Vec3 | null };
  hologram: { visible: boolean; worldPosition: Vec3; recordedSize: Vec3; grabbed: boolean };
};
type AnchorShim = { hold: boolean; requested: number; resolved: number; waiting: number; release(which: "all" | "oldest" | "newest" | "all-newest-first"): void };
type Hooks = Window & { __anchorShim?: AnchorShim; __HOLOIM_XR_VIEWER__?: { snapshot(): unknown } };

test.beforeEach(async ({ page }) => {
  await installPageClock(page);
});

test.describe.configure({ timeout: 150_000 });

/**
 * Holds every `createAnchor` answer (the frame's and a hit-test result's)
 * until `release()`. IWER makes the anchor when asked; only the answer reaches
 * the app late.
 */
async function installAnchorShim(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hooks = window as Hooks;
    const waiting: Array<() => void> = [];
    const run = (list: Array<() => void>) => list.forEach((resolve) => resolve());
    const shim: AnchorShim = {
      hold: true,
      requested: 0,
      resolved: 0,
      get waiting() { return waiting.length; },
      release(which) {
        if (which === "all") run(waiting.splice(0));
        else if (which === "all-newest-first") run(waiting.splice(0).reverse());
        else if (which === "oldest") run(waiting.splice(0, 1));
        else run(waiting.splice(-1));
      }
    } as AnchorShim;
    hooks.__anchorShim = shim;
    const patched = new WeakSet<object>();
    const patch = (prototype: { createAnchor?: (...args: unknown[]) => Promise<unknown> } | undefined) => {
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
    };
    window.setInterval(() => {
      const w = window as unknown as { XRFrame?: { prototype: never }; XRHitTestResult?: { prototype: never } };
      patch(w.XRFrame?.prototype);
      patch(w.XRHitTestResult?.prototype);
    }, 5);
  });
}

async function mockFeed(page: Page): Promise<void> {
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [item], nextCursor: null } }));
  await page.route(`**/api/holograms/${item.id}`, (route) => route.fulfill({ json: item }));
  await page.route("**/uploads/**", (route) => route.fulfill({ path: avatarGlbPath, contentType: "model/gltf-binary" }));
}

/** Opens the default shell's AR session from the feed, on a phone or on a Quest. */
async function enterAr(page: Page, device: "phone" | "quest"): Promise<void> {
  proofT0 = Date.now();
  proofFirstCaption = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await installAnchorShim(page);
  await mockFeed(page);
  if (device === "phone") await emulatePhone(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  const trigger = page.locator(".ar-trigger-button");
  await expect(trigger.locator("button")).toHaveAttribute("aria-label", "View in your room", { timeout: 15_000 });
  await expect(page.locator(`[data-card-id="${item.id}"]`)).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  await settleScroll(page);
  await reachFor(page.locator(".feed-card").first());
  await trigger.click();
  await expect(page).toHaveURL(new RegExp(`/ar/${item.id}$`));
  const container = page.locator(".xr-view-container");
  await expect(container).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await container.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await expect(container).toHaveAttribute("data-xr-state", "immersive");
  await freezePageClock(page);
  await waitForXrRenderLoop(page);
}

const snapshot = (page: Page) => page.evaluate(() => (window as Hooks).__HOLOIM_XR_VIEWER__!.snapshot()) as Promise<Snapshot>;
const counts = (page: Page) => page.evaluate(() => {
  const { requested, resolved, waiting } = (window as Hooks).__anchorShim!;
  return { requested, resolved, waiting };
});
const release = (page: Page, which: Parameters<AnchorShim["release"]>[0]) => page.evaluate((w) => (window as Hooks).__anchorShim!.release(w), which);
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Steps single frames until `accept` takes the snapshot. */
async function stepUntil(page: Page, accept: (s: Snapshot, c: { requested: number; resolved: number; waiting: number }) => boolean, what: string, maxFrames = 400): Promise<Snapshot> {
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await stepXr(page, 1);
    const s = await snapshot(page);
    if (accept(s, await counts(page))) return s;
  }
  throw new Error(`${what}: not reached in ${maxFrames} frames: ${JSON.stringify(await snapshot(page))} anchors ${JSON.stringify(await counts(page))}`);
}

async function record(name: string, steps: Record<string, unknown>): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, `${name}.json`), `${JSON.stringify(steps, null, 2)}\n`);
}

// XR_PROOF_VIDEO=1 frames both spots, hides IWER's panels, and captions each
// step, for the proof recording (ignored output/, never committed).
const PROOF = process.env.XR_PROOF_VIDEO === "1";
let proofT0 = 0;
let proofFirstCaption = true;

/** A caption over the view and a pause of `hold` frames; nothing unless recording. */
async function say(page: Page, text: string, hold = 10): Promise<void> {
  if (!PROOF) return;
  if (proofFirstCaption) {
    proofFirstCaption = false;
    // Milliseconds from the test's start (the video's start) to its first caption.
    await mkdir(path.join(evidenceDir, "proof"), { recursive: true });
    await writeFile(path.join(evidenceDir, "proof", `${test.info().testId}.start`), `${Date.now() - proofT0}\n`);
  }
  await page.evaluate((caption) => {
    let el = document.getElementById("proof-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "proof-caption";
      el.style.cssText = "position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.78);color:#fff;font:600 14px/1.3 system-ui,sans-serif;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = caption;
    const device = (window as unknown as { IWER_DEVICE?: { controlMode: string; devui?: { devUIContainer?: HTMLElement; devUICanvas?: HTMLElement } } }).IWER_DEVICE;
    if (device) {
      device.controlMode = "programmatic";
      for (const element of [device.devui?.devUIContainer, device.devui?.devUICanvas]) if (element) element.style.display = "none";
    }
  }, text);
  await stepXr(page, hold);
}

/** Steps the head back so the first spot and a tap's spot are both in view. */
async function frameBothSpots(page: Page): Promise<void> {
  if (!PROOF) return;
  await page.evaluate(() => {
    const device = (window as unknown as { IWER_DEVICE: { controlMode: string; position: { set(...v: number[]): void }; quaternion: { set(...v: number[]): void } } }).IWER_DEVICE;
    device.controlMode = "programmatic";
    device.position.set(0.3, 1.6, 2.4);
    // Pitched down a little, looking toward -z.
    device.quaternion.set(-0.1, 0, 0, 0.995);
  });
  await stepXr(page, 3);
}

/** The first placement, with its anchor asked for and unanswered. */
async function placedWithPendingAnchor(page: Page): Promise<Snapshot> {
  const placed = await stepUntil(page, (s, c) => s.placement.stage !== "searching" && s.hologram.visible && c.requested >= 1, "first placement and its anchor request");
  expect((await counts(page)).waiting, "the first anchor is unanswered").toBe(1);
  expect(placed.placement.stage, "placed, not yet anchored").toBe("placed");
  return placed;
}

async function tapFloorBeside(page: Page, at: Vec3): Promise<Snapshot> {
  const before = await snapshot(page);
  const target: Vec3 = [at[0] + 0.6, at[1], at[2] + 0.4];
  await stepXrCall(page, "__phoneTap", [target]);
  const moved = await stepUntil(page, (s) => s.placement.mode === "tap" && s.placement.sequence > before.placement.sequence, "floor tap placement");
  expect(Math.hypot(moved.hologram.worldPosition[0] - target[0], moved.hologram.worldPosition[2] - target[2]), "moved to the tapped floor point").toBeLessThan(0.05);
  expect(distance(moved.hologram.worldPosition, at), "somewhere else").toBeGreaterThan(0.5);
  return moved;
}

test("IWSDK AR: a floor tap while the first anchor is pending; the old anchor, arriving first, does not pull the hologram back", async ({ page }) => {
  await enterAr(page, "phone");
  const placed = await placedWithPendingAnchor(page);
  await say(page, "1. Placed on the floor. Its anchor request is still pending.");
  const moved = await tapFloorBeside(page, placed.hologram.worldPosition);
  // After the tap (a phone tap projects through the head pose), step back so both spots are in view.
  await frameBothSpots(page);
  // The tap's own anchor is asked for on the next frame.
  await stepXr(page, 3);
  expect((await counts(page)).requested, "the tap asked for its own anchor").toBe(2);
  await say(page, "2. Floor tap: the hologram moved to the tapped spot. Two anchor requests pending.");

  // The first spot's anchor answers; the tap's has not yet.
  await release(page, "oldest");
  await stepXr(page, 10);
  const afterOld = await snapshot(page);
  await say(page, "3. The old spot's anchor answers first: the hologram stays at the tapped spot.", 14);
  // Then the tap's answers.
  await release(page, "all");
  await stepXr(page, 10);
  const afterBoth = await snapshot(page);
  await say(page, "4. The tap's anchor answers: adopted, hologram anchored where it was tapped.", 14);
  await record("tap-old-anchor-first", { placed, moved, afterOld, afterBoth, counts: await counts(page) });

  expect(distance(afterOld.hologram.worldPosition, moved.hologram.worldPosition), `the hologram stays where the tap put it (was ${JSON.stringify(moved.hologram.worldPosition)}, now ${JSON.stringify(afterOld.hologram.worldPosition)})`).toBeLessThan(0.02);
  expect(distance(afterBoth.hologram.worldPosition, moved.hologram.worldPosition), "and once the tap's anchor answers").toBeLessThan(0.02);
  expect(afterBoth.placement.stage, "the tap's anchor is the one adopted").toBe("anchored");
});

test("IWSDK AR: a floor tap while the first anchor is pending; the old anchor, arriving last, does not replace the tap's", async ({ page }) => {
  await enterAr(page, "phone");
  const placed = await placedWithPendingAnchor(page);
  await say(page, "1. Placed on the floor. Its anchor request is still pending.");
  const moved = await tapFloorBeside(page, placed.hologram.worldPosition);
  // After the tap (a phone tap projects through the head pose), step back so both spots are in view.
  await frameBothSpots(page);
  await stepXr(page, 3);
  expect((await counts(page)).requested).toBe(2);
  await say(page, "2. Floor tap: the hologram moved to the tapped spot. Two anchor requests pending.");

  // WebXR does not order the answers of two createAnchor calls: the tap's
  // anchor arrives first, then the first spot's.
  await release(page, "all-newest-first");
  await stepXr(page, 10);
  const after = await snapshot(page);
  await say(page, "3. The tap's anchor answers first, then the old spot's: the old one is dropped, the hologram stays.", 16);
  await record("tap-old-anchor-last", { placed, moved, after, counts: await counts(page) });

  expect(distance(after.hologram.worldPosition, moved.hologram.worldPosition), `the hologram stays where the tap put it (was ${JSON.stringify(moved.hologram.worldPosition)}, now ${JSON.stringify(after.hologram.worldPosition)})`).toBeLessThan(0.02);
  expect(after.placement.stage).toBe("anchored");
});

/** Poses the headset or a controller (IWER's DevUI rewrites them unless control is programmatic). */
async function setPose(page: Page, who: "head" | "left" | "right", position: Vec3 | null, lookAt: Vec3 | null): Promise<void> {
  await page.evaluate(({ who, position, lookAt }) => {
    type V = { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
    type Q = { set(x: number, y: number, z: number, w: number): void };
    const device = (window as unknown as { IWER_DEVICE: { controlMode: string; position: V; quaternion: Q; controllers: Record<"left" | "right", { position: V; quaternion: Q }> } }).IWER_DEVICE;
    device.controlMode = "programmatic";
    const tracked = who === "head" ? device : device.controllers[who];
    if (position) tracked.position.set(...position);
    if (lookAt) {
      const p = tracked.position;
      const [dx, dy, dz] = [lookAt[0] - p.x, lookAt[1] - p.y, lookAt[2] - p.z];
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
      const [sy, cy, sp, cp] = [Math.sin(yaw / 2), Math.cos(yaw / 2), Math.sin(pitch / 2), Math.cos(pitch / 2)];
      tracked.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    }
  }, { who, position, lookAt });
}

async function squeeze(page: Page, side: "left" | "right", value: 0 | 1): Promise<void> {
  await page.evaluate(({ side, value }) => {
    (window as unknown as { IWER_DEVICE: { controllers: Record<string, { updateButtonValue(id: string, v: number): void }> } }).IWER_DEVICE.controllers[side]!.updateButtonValue("squeeze", value);
  }, { side, value });
  await stepXr(page, 1);
}

test("IWSDK AR: a two-hand move while the first anchor is pending; the old anchor, arriving during the move, does not pull the hologram back", async ({ page }) => {
  await enterAr(page, "quest");
  const placed = await placedWithPendingAnchor(page);
  await say(page, "1. Placed on the floor. Its anchor request is still pending.");
  const [px, py, pz] = placed.hologram.worldPosition;
  const height = placed.hologram.recordedSize[1];

  // Both grips on the hologram's front, within arm's reach, then squeeze.
  const front = pz + 0.15 + 0.01;
  const chest = py + height * 0.55;
  await setPose(page, "head", [px, 1.6, pz + 0.75], [px, chest, pz]);
  await setPose(page, "left", [px - 0.12, chest, front], [px - 0.12, chest, pz - 1]);
  await setPose(page, "right", [px + 0.12, chest, front], [px + 0.12, chest, pz - 1]);
  await stepXr(page, 3);
  await squeeze(page, "left", 1);
  await squeeze(page, "right", 1);
  const grabbed = await stepUntil(page, (s) => s.hologram.grabbed, "two-hand grab", 30);
  await say(page, "2. Both hands grab the hologram. The first anchor request is still pending.");

  // Carry it 0.5 m to the right.
  for (let i = 1; i <= 10; i += 1) {
    await setPose(page, "left", [px - 0.12 + 0.05 * i, chest, front], null);
    await setPose(page, "right", [px + 0.12 + 0.05 * i, chest, front], null);
    await stepXr(page, 1);
  }
  const carried = await snapshot(page);
  await say(page, "3. The hands carry it 0.5 m to the right.");
  expect(distance(carried.hologram.worldPosition, placed.hologram.worldPosition), "the hands moved it").toBeGreaterThan(0.3);

  // The first spot's anchor answers while the hands hold it.
  await release(page, "oldest");
  await stepXr(page, 3);
  await say(page, "4. The first spot's anchor answers while the hands hold it.");
  await squeeze(page, "left", 0);
  await squeeze(page, "right", 0);
  const letGo = await stepUntil(page, (s) => !s.hologram.grabbed, "let go", 30);
  // Re-grounding gives up after 1 s and asks for the anchor at the new spot.
  await stepUntil(page, (_s, c) => c.requested >= 2, "the move's own anchor request", 80);
  await stepXr(page, 10);
  const afterOld = await snapshot(page);
  await say(page, "5. Hands let go, re-grounding done: the hologram stays where it was carried.", 14);
  await release(page, "all");
  await stepXr(page, 10);
  const afterBoth = await snapshot(page);
  await say(page, "6. The move's own anchor answers: adopted, hologram anchored there.", 14);
  await record("grab-old-anchor-during-move", { placed, grabbed, carried, letGo, afterOld, afterBoth, counts: await counts(page) });

  expect(distance(afterOld.hologram.worldPosition, letGo.hologram.worldPosition), `the hologram stays where the hands left it (was ${JSON.stringify(letGo.hologram.worldPosition)}, now ${JSON.stringify(afterOld.hologram.worldPosition)})`).toBeLessThan(0.05);
  expect(distance(afterBoth.hologram.worldPosition, letGo.hologram.worldPosition), "and once the move's anchor answers").toBeLessThan(0.05);
  expect(afterBoth.placement.stage).toBe("anchored");
});
