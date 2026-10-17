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

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mockGlbPath = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const mockHologram = {
  id: "mock-1",
  url: "/uploads/mock-avatar.glb",
  usdzUrl: null,
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

async function mockFeed(page: Page): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [mockHologram],
        nextCursor: null
      })
    });
  });

  await page.route("**/api/holograms/mock-1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(mockHologram)
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

async function readPlacementState(page: Page): Promise<PlacementState> {
  return page.evaluate(() => {
    const root = document.querySelector(".ar-view-container");
    if (!(root instanceof HTMLElement)) {
      throw new Error("AR root container not found.");
    }

    return {
      anchored: root.dataset.placementAnchored === "true",
      mode: root.dataset.placementMode ?? "",
      reason: root.dataset.placementReason ?? "",
      sequence: Number(root.dataset.placementSequence ?? "0"),
      stage: root.dataset.placementStage ?? "",
      position: root.dataset.placementPosition
        ? root.dataset.placementPosition.split(",").map(Number) as [number, number, number]
        : null
    };
  });
}

async function waitForPlacement(
  page: Page,
  expectation: PlacementExpectation,
  timeout = 15000
): Promise<PlacementState> {
  try {
    await page.waitForFunction(
      (expected) => {
        const root = document.querySelector(".ar-view-container");
        if (!(root instanceof HTMLElement)) {
          return false;
        }

        const state = {
          anchored: root.dataset.placementAnchored === "true",
          mode: root.dataset.placementMode ?? "",
          reason: root.dataset.placementReason ?? "",
          sequence: Number(root.dataset.placementSequence ?? "0"),
          stage: root.dataset.placementStage ?? ""
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
        if (expected.placedByModel && !root.dataset.placementPosition) {
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
      placement: await readPlacementState(page),
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
      }))
    });
    throw error;
  }

  return readPlacementState(page);
}

async function enterMockAr(page: Page): Promise<void> {
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);

  await page.locator(".ar-trigger-button").first().click();
  await expect(page).toHaveURL(/\/ar\/mock-1$/);
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await expect(page.getByRole("button", { name: "Exit AR" })).toBeVisible();
}

// IWER's overlay intercepts pointer input during a session, so session
// controls are clicked through the DOM; a missed click then fails the wait
// that follows instead of passing silently.
async function clickSessionButton(page: Page, label: string): Promise<void> {
  await page.evaluate((text) => {
    const button = Array.from(document.querySelectorAll("button")).find((candidate) => (
      candidate.textContent?.trim() === text
    ));
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`${text} button not found.`);
    }
    button.click();
  }, label);
}

const HIT_TEST_PLACEMENT = {
  allowedModes: ["hit-test", "floor"],
  allowedReasons: ["hit-test-stable", "hit-test-anchor", "plane-detected", "plane-detected-anchor"],
  excludedStages: ["searching", "unplaced"],
  placedByModel: true
};

test("AR places the model on a surface in front of the viewer, recenter places again, and exit returns to the feed", async ({ page }, testInfo) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  await enterMockAr(page);
  const runtimeState = await waitForIwerRuntime(page);
  expect(runtimeState.isSecureContext).toBeTruthy();
  const sessionState = await readIwerSessionState(page);
  expect(sessionState?.environmentBlendMode).toBe("alpha-blend");
  const environmentState = await waitForIwerEnvironment(page, { minTrackedPlanes: 1 });
  expect(environmentState.hasSem).toBeTruthy();
  await expect(page.locator(".ar-view-container")).toHaveAttribute("data-depth-occlusion", "disabled");
  await expect(page.locator(".ar-view-container")).toHaveAttribute("data-depth-occlusion-reason", "iwer-runtime");

  const placement = await waitForPlacement(page, { minSequence: 1, ...HIT_TEST_PLACEMENT });
  expect(["anchored", "placed", "locked"]).toContain(placement.stage);
  expectPlacedInFrontOnSurface(placement, await readViewerPose(page));
  await captureEvidence(page, testInfo, "ar-placed-on-surface");

  // Only the model's own placements carry a position and advance its
  // sequence, so a higher model-reported sequence proves recenter re-placed.
  await clickSessionButton(page, "Recenter Model");
  const replaced = await waitForPlacement(page, { ...HIT_TEST_PLACEMENT, minSequence: placement.sequence + 1 });
  expect(["anchored", "placed", "locked"]).toContain(replaced.stage);

  await clickSessionButton(page, "Exit AR");
  await waitForNoIwerSession(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("Upload Hologram")).toBeVisible();
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
  expect(["floor", "visibility-fallback"]).toContain(placement.mode);
  expect(["hit-test-unavailable", "hit-test-timeout"]).toContain(placement.reason);
  await captureEvidence(page, testInfo, "ar-fallback-placement");
});
