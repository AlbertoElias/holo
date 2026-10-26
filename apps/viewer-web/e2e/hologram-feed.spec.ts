import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import {
  readIwerSessionState,
  waitForIwerEnvironment,
  waitForIwerRuntime,
  waitForIwerSession,
  waitForNoIwerSession
} from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, captureEvidence, expect, observeFeedCardRenderer, test, waitForFeedCardPresented, pressViewInAr } from "./bootstrap";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mockGlbPath = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const mockHologram = {
  id: "mock-1",
  url: "/uploads/mock-avatar.glb",
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-02-10T00:00:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: "mock-avatar.glb",
  hologramName: "Mock Runner",
  submittedBy: "automation"
} as const;

type PlacementState = {
  anchored: boolean;
  mode: string;
  reason: string;
  sequence: number;
  stage: string;
  position: [number, number, number] | null;
};

type PlacementExpectation = {
  allowedModes?: string[];
  allowedReasons?: string[];
  anchored?: boolean;
  excludedStages?: string[];
  minSequence?: number;
  mode?: string;
  notMode?: string;
  // Only the model's own placement reports a position; controller previews
  // and recenter resets do not, so this proves the model was really placed.
  placedByModel?: boolean;
};

async function mockFeed(page: Page, metadata: { hologramName?: string; submittedBy?: string } = {}): Promise<void> {
  const hologram = { ...mockHologram, ...metadata };
  await page.route("**/api/holograms?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [hologram],
        nextCursor: null
      })
    });
  });

  await page.route("**/api/holograms/mock-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(hologram)
    });
  });

  await page.route("**/uploads/**", async (route) => {
    await route.fulfill({
      status: 200,
      path: mockGlbPath,
      contentType: "model/gltf-binary",
      headers: {
        "accept-ranges": "bytes"
      }
    });
  });
}

async function setDesktopNavigatorOverrides(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nav = navigator as Navigator & {
      platform?: string;
      maxTouchPoints?: number;
      userAgent?: string;
    };
    try {
      Object.defineProperty(nav, "platform", { configurable: true, get: () => "Linux x86_64" });
      Object.defineProperty(nav, "maxTouchPoints", { configurable: true, get: () => 0 });
      Object.defineProperty(nav, "userAgent", {
        configurable: true,
        get: () => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      });
    } catch {
      // Best effort override for deterministic non-iOS behavior.
    }
  });
}

// Makes the emulated device behave like hardware without hit-test or plane
// detection: IWER then rejects hit-test sources and reports no planes. The
// hook runs when IWER publishes its device, before any session is requested.
async function disableHitTestForSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let iwerDeviceValue: unknown;
    Object.defineProperty(window, "IWER_DEVICE", {
      configurable: true,
      get: () => iwerDeviceValue,
      set: (value) => {
        iwerDeviceValue = value;
        const device = value as {
          supportedFeatures?: string[];
          sem?: { trackedPlanes?: Set<unknown>; trackedMeshes?: Set<unknown> };
        } | undefined;
        const features = device?.supportedFeatures;
        for (const feature of ["hit-test", "plane-detection", "mesh-detection"]) {
          const index = features?.indexOf(feature) ?? -1;
          if (features && index >= 0) features.splice(index, 1);
        }
        if (device?.sem) {
          Object.defineProperty(device.sem, "trackedPlanes", { configurable: true, get: () => new Set() });
          Object.defineProperty(device.sem, "trackedMeshes", { configurable: true, get: () => new Set() });
        }
      }
    });
  });
}

async function readViewerPose(page: Page): Promise<{ position: [number, number, number]; quaternion: [number, number, number, number] }> {
  return page.evaluate(() => {
    const device = (window as Window & { IWER_DEVICE?: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } } }).IWER_DEVICE;
    if (!device) throw new Error("IWER device unavailable.");
    return {
      position: [device.position.x, device.position.y, device.position.z],
      quaternion: [device.quaternion.x, device.quaternion.y, device.quaternion.z, device.quaternion.w]
    };
  });
}

// The model must rest on something in front of the viewer: within 45° of the
// gaze direction, 0.5–5 m away, on or above the floor, and clearly below eye
// level (not floating in the face or stuck to a wall at eye height).
function expectPlacedInFrontOnSurface(
  placement: PlacementState,
  viewer: { position: [number, number, number]; quaternion: [number, number, number, number] }
): void {
  expect(placement.position, "model-reported placement position").not.toBeNull();
  const [x, y, z] = placement.position!;
  const [vx, vy, vz] = viewer.position;
  const [qx, qy, qz, qw] = viewer.quaternion;
  // Viewer forward (-Z) rotated by the device orientation, flattened to XZ.
  const forwardX = -(2 * (qx * qz + qw * qy));
  const forwardZ = -(1 - 2 * (qx * qx + qy * qy));
  const dx = x - vx;
  const dz = z - vz;
  const distance = Math.hypot(dx, dz);
  const facing = (dx * forwardX + dz * forwardZ) / (distance * Math.hypot(forwardX, forwardZ));
  expect(distance, "horizontal distance from viewer (m)").toBeGreaterThan(0.5);
  expect(distance, "horizontal distance from viewer (m)").toBeLessThan(5);
  expect(facing, "cosine between gaze and model direction").toBeGreaterThan(Math.SQRT1_2);
  expect(y, "height above floor (m)").toBeGreaterThan(-0.05);
  expect(vy - y, "drop below eye level (m)").toBeGreaterThan(0.2);
}

// Independent oracle: cast a ray straight down through IWER's synthetic room
// from above the model and return the height of the first surface it meets.
async function readSurfaceHeightBelow(page: Page, [x, y, z]: [number, number, number]): Promise<number | null> {
  return page.evaluate(({ px, py, pz }) => {
    const sem = (window as Window & { IWER_DEVICE?: { sem?: { computeHitTestResults: (matrix: number[]) => number[][] } } }).IWER_DEVICE?.sem;
    if (!sem) return null;
    // Column-major pose: rotate -90° about X so the ray's -Z points down.
    const downRay = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, px, py + 0.5, pz, 1];
    const hit = sem.computeHitTestResults(downRay)[0];
    return hit ? hit[13]! : null;
  }, { px: x, py: y, pz: z });
}

// The IWSDK shell's development probe: the focused hologram's placement.
type XrViewerSnapshot = {
  placement: { stage: string; mode: string | null; reason?: string; sequence: number; position: [number, number, number] | null };
  bubbles: { occlusion: { requested: boolean; drawing: boolean } };
  controls: {
    target: string;
    foot: { reachOpacity: number; buttons: Record<"recenter", { worldPosition: Vec3 }> };
    dock: { mount: string; hand: string | null; buttons: Record<"exit", { worldPosition: Vec3 }> };
  } | null;
};
type Vec3 = [number, number, number];
type ProbeWindow = Window & { __HOLOIM_XR_VIEWER__?: { snapshot(): XrViewerSnapshot } };

async function viewerSnapshot(page: Page): Promise<XrViewerSnapshot> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__HOLOIM_XR_VIEWER__;
    if (!probe) throw new Error("XR viewer probe not found.");
    return probe.snapshot();
  });
}

function toPlacementState(placement: XrViewerSnapshot["placement"]): PlacementState {
  return {
    anchored: placement.stage === "anchored",
    mode: placement.mode ?? "",
    reason: placement.reason ?? "",
    sequence: placement.sequence,
    stage: placement.stage,
    position: placement.position
  };
}

async function readPlacementState(page: Page): Promise<PlacementState> {
  return toPlacementState((await viewerSnapshot(page)).placement);
}

async function waitForPlacement(
  page: Page,
  expectation: PlacementExpectation,
  timeout = 15000
): Promise<PlacementState> {
  try {
    await page.waitForFunction(
      (expected) => {
        const placement = (window as ProbeWindow).__HOLOIM_XR_VIEWER__?.snapshot().placement;
        if (!placement) return false;
        const state = {
          anchored: placement.stage === "anchored",
          mode: placement.mode ?? "",
          reason: placement.reason ?? "",
          sequence: placement.sequence,
          stage: placement.stage
        };

        if (typeof expected.minSequence === "number" && state.sequence < expected.minSequence) {
          return false;
        }
        if (typeof expected.mode === "string" && state.mode !== expected.mode) {
          return false;
        }
        if (typeof expected.notMode === "string" && state.mode === expected.notMode) {
          return false;
        }
        if (Array.isArray(expected.allowedModes) && !expected.allowedModes.includes(state.mode)) {
          return false;
        }
        if (Array.isArray(expected.allowedReasons) && !expected.allowedReasons.includes(state.reason)) {
          return false;
        }
        if (typeof expected.anchored === "boolean" && state.anchored !== expected.anchored) {
          return false;
        }
        if (Array.isArray(expected.excludedStages) && expected.excludedStages.includes(state.stage)) {
          return false;
        }
        if (expected.placedByModel && !placement.position) {
          return false;
        }

        return true;
      },
      expectation,
      { timeout }
    );
  } catch (error) {
    console.error("placement-wait-timeout", {
      expectation,
      placement: await readPlacementState(page).catch((reason: Error) => reason.message),
      session: await readIwerSessionState(page),
      environment: await page.evaluate(() => ({
        hasSem: Boolean(window.IWER_DEVICE?.sem),
        hasDevicePose: Boolean(window.IWER_DEVICE?.position && window.IWER_DEVICE?.quaternion),
        devicePosition: window.IWER_DEVICE?.position
          ? {
            x: window.IWER_DEVICE.position.x,
            y: window.IWER_DEVICE.position.y,
            z: window.IWER_DEVICE.position.z
          }
          : null,
        trackedPlanesCount: window.IWER_DEVICE?.sem?.trackedPlanes?.size ?? 0,
        trackedMeshesCount: window.IWER_DEVICE?.sem?.trackedMeshes?.size ?? 0
      })),
      timeline: await page.evaluate(() => (window as Window & { __placementTimeline?: string[] }).__placementTimeline ?? []),
      viewerConsole: viewerConsoleLines.get(page) ?? []
    });
    throw error;
  }

  return readPlacementState(page);
}

// A placement timeout only shows the final state; record every placement
// change and viewer log line so the dump says which side stalled.
const viewerConsoleLines = new WeakMap<Page, string[]>();

async function recordPlacementTimeline(page: Page): Promise<void> {
  const lines: string[] = [];
  viewerConsoleLines.set(page, lines);
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[xr-viewer")) {
      lines.push(text);
    }
  });
  await page.addInitScript(() => {
    const timeline: string[] = [];
    (window as Window & { __placementTimeline?: string[] }).__placementTimeline = timeline;
    setInterval(() => {
      const placement = (window as ProbeWindow).__HOLOIM_XR_VIEWER__?.snapshot().placement;
      if (!placement) return;
      const entry = [placement.stage, placement.mode, placement.reason, placement.sequence, placement.position?.join(",")].join("|");
      if (timeline.at(-1)?.endsWith(entry)) return;
      timeline.push(`${Math.round(performance.now())}ms ${entry}`);
    }, 50);
  });
}

async function enterMockAr(page: Page): Promise<void> {
  await recordPlacementTimeline(page);
  await observeFeedCardRenderer(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);
  await waitForFeedCardPresented(page);

  await pressViewInAr(page);
  await expect(page).toHaveURL(/\/ar\/mock-1$/);
  const container = page.locator(".xr-view-container");
  await expect(container).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await container.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await expect(container).toHaveAttribute("data-xr-state", "immersive");
}

/**
 * Moves the IWER headset or a controller to `position` facing `lookAt`
 * (yaw then pitch); IWER's DevUI stops rewriting poses once control is
 * programmatic.
 */
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
  await page.waitForTimeout(60);
}

/** Aims the right controller's ray at a world point and pulls the trigger. */
async function rayClick(page: Page, target: Vec3, from: Vec3): Promise<void> {
  await setPose(page, "right", from, target);
  await page.waitForTimeout(80);
  for (const value of [1, 0]) {
    await page.evaluate((v) => {
      (window as unknown as { IWER_DEVICE: { controllers: Record<string, { updateButtonValue(id: string, v: number): void }> } }).IWER_DEVICE.controllers.right!.updateButtonValue("trigger", v);
    }, value);
    await page.waitForTimeout(80);
  }
}

/**
 * Recenter from the hologram's foot: looking at the chip reveals its reach
 * row, the right controller's ray then holds it (hover) while the head looks
 * back where it was, and the trigger selects Recenter, which places again
 * along that gaze.
 */
async function recenterFromFoot(page: Page): Promise<void> {
  const head = await readViewerPose(page);
  await setPose(page, "head", null, (await viewerSnapshot(page)).controls!.foot.buttons.recenter.worldPosition);
  await expect.poll(async () => (await viewerSnapshot(page)).controls!.foot.reachOpacity, { timeout: 3_000 }).toBe(1);
  const recenter = (await viewerSnapshot(page)).controls!.foot.buttons.recenter.worldPosition;
  await setPose(page, "right", [head.position[0] + 0.25, head.position[1] - 0.35, head.position[2] - 0.2], recenter);
  await page.evaluate((q) => {
    (window as unknown as { IWER_DEVICE: { quaternion: { set(x: number, y: number, z: number, w: number): void } } }).IWER_DEVICE.quaternion.set(...q);
  }, head.quaternion);
  await page.waitForTimeout(150);
  await rayClick(page, recenter, [head.position[0] + 0.25, head.position[1] - 0.35, head.position[2] - 0.2]);
}

/** Exit from the hand dock on the non-dominant (left) controller, by the right controller's ray. */
async function exitFromDock(page: Page): Promise<void> {
  const [x, y, z] = (await readViewerPose(page)).position;
  await setPose(page, "head", null, [x - 0.15, y - 0.4, z - 0.4]);
  await setPose(page, "left", [x - 0.15, y - 0.45, z - 0.35], [x - 0.15, y - 0.45, z - 1.35]);
  await page.waitForTimeout(250);
  const exit = (await viewerSnapshot(page)).controls!.dock.buttons.exit.worldPosition;
  await rayClick(page, exit, [x + 0.15, y - 0.4, z - 0.15]);
}

// The IWSDK shell places ahead by hit test, skipping surfaces over 0.5 m (a
// recorded person stands on the floor); the floor estimate is its fallback.
const HIT_TEST_PLACEMENT = {
  allowedModes: ["hit-test"],
  allowedReasons: ["hit-test"],
  excludedStages: ["searching", "unplaced"],
  placedByModel: true
};

test("AR places the model on a surface in front of the viewer, recenter places again, and exit returns to the feed", async ({ page }, testInfo) => {
  // Takes 25-28 s on a 2-CPU Linux runner, too close to the 30 s default.
  test.setTimeout(60_000);
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  // Looking down at the room's open floor under a metre away, as a phone or
  // headset user does to place: the placement ray (19° below the gaze) from
  // a level head meets the walls first, and straight ahead of IWER's default
  // pose is a 1.3 m desk, which the shell skips (a person stands on the floor).
  await page.addInitScript(() => {
    const timer = setInterval(() => {
      const device = (window as unknown as { IWER_DEVICE?: { controlMode: string; quaternion: { set(x: number, y: number, z: number, w: number): void } } }).IWER_DEVICE;
      if (!device) return;
      clearInterval(timer);
      // IWER's DevUI rewrites the pose every frame unless control is programmatic.
      device.controlMode = "programmatic";
      // Yaw toward the clear floor at (0.7, 0, 0.3), then pitch 45° down.
      const [yaw, pitch] = [Math.atan2(-0.7, -0.3), -45 * Math.PI / 180];
      const [sy, cy, sp, cp] = [Math.sin(yaw / 2), Math.cos(yaw / 2), Math.sin(pitch / 2), Math.cos(pitch / 2)];
      device.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    }, 20);
  });
  await enterMockAr(page);
  const runtimeState = await waitForIwerRuntime(page);
  expect(runtimeState.isSecureContext).toBeTruthy();
  const sessionState = await readIwerSessionState(page);
  expect(sessionState?.environmentBlendMode).toBe("alpha-blend");
  const environmentState = await waitForIwerEnvironment(page, { minTrackedPlanes: 1 });
  expect(environmentState.hasSem).toBeTruthy();
  // IWER has no depth data to occlude with: the shell does not ask for it there.
  expect((await viewerSnapshot(page)).bubbles.occlusion, "depth occlusion under IWER").toEqual({ requested: false, drawing: false });

  const placement = await waitForPlacement(page, { minSequence: 1, ...HIT_TEST_PLACEMENT });
  expect(["anchored", "placed", "locked"]).toContain(placement.stage);
  expectPlacedInFrontOnSurface(placement, await readViewerPose(page));
  const surfaceY = await readSurfaceHeightBelow(page, placement.position!);
  const surfaceDetail = `placement ${JSON.stringify(placement)}, surface y ${String(surfaceY)}`;
  expect(surfaceY, `emulated room surface under the model (${surfaceDetail})`).not.toBeNull();
  expect(Math.abs(placement.position![1] - surfaceY!), `model base to surface in m (${surfaceDetail})`).toBeLessThan(0.1);
  expect(placement.position![1], `on the floor, not the desk (${surfaceDetail})`).toBeLessThan(0.5);
  await captureEvidence(page, testInfo, "ar-placed-on-surface");

  // Only the model's own placements carry a position and advance its
  // sequence, so a higher model-reported sequence proves recenter re-placed.
  await recenterFromFoot(page);
  const replaced = await waitForPlacement(page, { ...HIT_TEST_PLACEMENT, minSequence: placement.sequence + 1 });
  expect(["anchored", "placed", "locked"]).toContain(replaced.stage);
  expectPlacedInFrontOnSurface(replaced, await readViewerPose(page));

  expect((await viewerSnapshot(page)).controls!.dock, "Exit on the non-dominant (left) hand").toMatchObject({ mount: "hand", hand: "left" });
  await exitFromDock(page);
  await waitForNoIwerSession(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Upload a hologram" })).toBeVisible();
  await expect(page.getByText("Mock Runner")).toBeVisible();
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);
});

test("AR placement falls back when hit-test is unavailable", async ({ page }, testInfo) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);
  await disableHitTestForSession(page);

  await enterMockAr(page);

  const placement = await waitForPlacement(
    page,
    {
      minSequence: 1,
      notMode: "hit-test",
      excludedStages: ["searching", "unplaced"],
      placedByModel: true
    }
  );

  expect(placement.anchored).toBe(false);
  expect(placement.mode).toBe("floor");
  expect(["hit-test-unavailable", "hit-test-timeout"]).toContain(placement.reason);
  await captureEvidence(page, testInfo, "ar-fallback-placement");
});

// B-008: visibility alone does not detect a fixed control painting over text.
for (const viewport of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
  { width: 768, height: 1024 }
]) {
  test(`mobile feed metadata clears Upload at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockFeed(page, { hologramName: "A recorded hologram", submittedBy: "Alberto Elias" });
    await page.goto("/");
    await assertViewerShell(page);
    const card = page.locator(".feed-card").first();
    await expect(card).toHaveAttribute("data-model-state", "rendered");
    const toggle = page.getByRole("button", { name: "Upload a hologram" });
    await expect(toggle).toBeVisible();
    await expect(card.getByRole("heading", { name: "A recorded hologram" })).toBeVisible();
    await expect(card.locator(".feed-card-meta p")).toContainText("By Alberto Elias");

    expect(await card.locator(".feed-card-meta h2").evaluate((heading) => (
      heading.scrollWidth <= heading.clientWidth
    )), "the title fits without truncation").toBe(true);
    const metadata = await card.locator(".feed-card-meta").boundingBox();
    const upload = await toggle.boundingBox();
    expect(metadata).not.toBeNull();
    expect(upload).not.toBeNull();
    expect(metadata!.y).toBeGreaterThanOrEqual(0);
    expect(metadata!.x).toBeGreaterThanOrEqual(0);
    expect(metadata!.x + metadata!.width).toBeLessThanOrEqual(viewport.width);
    expect(metadata!.y + metadata!.height, "title and author must sit above the dock's Upload").toBeLessThan(upload!.y);
    const portal = await card.locator(".portal-controls").boundingBox();
    expect(portal).not.toBeNull();
    const overlaps = metadata!.x < portal!.x + portal!.width && portal!.x < metadata!.x + metadata!.width
      && metadata!.y < portal!.y + portal!.height && portal!.y < metadata!.y + metadata!.height;
    expect(overlaps, "metadata and the portal controls do not overlap").toBe(false);
    await testInfo.attach("mobile-layout.json", {
      body: JSON.stringify({ viewport, metadata, upload, portal }, null, 2),
      contentType: "application/json"
    });
    await captureEvidence(page, testInfo, "mobile-feed-metadata");

    if (viewport.width === 390) {
      await toggle.click();
      const sheet = page.getByRole("dialog", { name: "Upload a hologram" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByLabel("Hologram name")).toBeVisible();
      await sheet.getByRole("button", { name: "Close" }).click();
      await expect(toggle).toBeVisible();
      await expect(sheet).toHaveCount(0);
    }
  });
}

// A GLB is a megabyte or more: downloading every card's at once slows the one
// on screen. The focused card loads first and alone, the next ones follow one
// at a time in feed order, and a card far down waits for the feed to near it.
test("feed downloads holograms in feed order, one at a time", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const holograms = Array.from({ length: 5 }, (_, index) => ({
    ...mockHologram,
    id: `mock-${index + 1}`,
    url: `/uploads/mock-${index + 1}.glb`,
    hologramName: `Hologram ${index + 1}`
  }));
  await page.route("**/api/holograms?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: holograms, nextCursor: null })
  }));
  const downloads: { url: string; start: number; end: number }[] = [];
  const startedAt = Date.now();
  await page.route("**/uploads/**", async (route) => {
    const request = route.request();
    const full = request.method() === "GET" && !request.headers().range;
    const download = full ? { url: new URL(request.url()).pathname, start: Date.now() - startedAt, end: Number.NaN } : null;
    if (download) {
      downloads.push(download);
      // Long enough that downloads running at once would overlap.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await route.fulfill({ status: 200, path: mockGlbPath, contentType: "model/gltf-binary", headers: { "accept-ranges": "bytes" } });
    if (download) download.end = Date.now() - startedAt;
  });

  await page.goto("/");
  await assertViewerShell(page);
  const cards = page.locator(".feed-card");
  await expect(cards.nth(2)).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  // Nothing else is near the top of the feed: the fourth and fifth wait.
  await page.waitForTimeout(1_500);
  await expect(cards.nth(3)).toHaveAttribute("data-model-state", "queued");
  expect(downloads.map((download) => download.url)).toEqual(["/uploads/mock-1.glb", "/uploads/mock-2.glb", "/uploads/mock-3.glb"]);
  for (let index = 1; index < downloads.length; index += 1) {
    expect(downloads[index]!.start, `${downloads[index]!.url} starts after ${downloads[index - 1]!.url} finished`).toBeGreaterThanOrEqual(downloads[index - 1]!.end);
  }

  // Scrolling to the third card brings the fourth and fifth into reach.
  await cards.nth(2).scrollIntoViewIfNeeded();
  await expect(cards.nth(4)).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  expect(downloads.map((download) => download.url).slice(3)).toEqual(["/uploads/mock-4.glb", "/uploads/mock-5.glb"]);
  await testInfo.attach("glb-downloads.json", { body: JSON.stringify(downloads, null, 2), contentType: "application/json" });
});
