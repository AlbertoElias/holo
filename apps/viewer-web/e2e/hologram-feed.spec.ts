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

import { assertViewerShell, expect, test } from "./bootstrap";

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
};

type PlacementExpectation = {
  allowedModes?: string[];
  allowedReasons?: string[];
  anchored?: boolean;
  excludedStages?: string[];
  minSequence?: number;
  mode?: string;
  notMode?: string;
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

async function setDesktopNavigatorOverrides(page: Page, { forceArSupport }: { forceArSupport?: boolean } = {}): Promise<void> {
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

  if (typeof forceArSupport === "boolean") {
    await page.addInitScript((supported: boolean) => {
      (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__ = supported;
    }, forceArSupport);
  }
}

async function disableHitTestForSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let iwerDeviceValue: unknown;
    Object.defineProperty(window, "IWER_DEVICE", {
      configurable: true,
      get: () => iwerDeviceValue,
      set: (value) => {
        iwerDeviceValue = value;
        const sem = (value as { sem?: { trackedPlanes?: Set<unknown>; trackedMeshes?: Set<unknown> } } | undefined)?.sem;
        if (sem) {
          Object.defineProperty(sem, "trackedPlanes", {
            configurable: true,
            get: () => new Set()
          });
          Object.defineProperty(sem, "trackedMeshes", {
            configurable: true,
            get: () => new Set()
          });
        }
      }
    });

    const sessionPrototype = window.XRSession?.prototype;
    if (sessionPrototype) {
      const unsupported = async () => {
        throw new DOMException("Hit-test disabled for fallback coverage.", "NotSupportedError");
      };

      for (const key of ["requestHitTestSource", "requestHitTestSourceForTransientInput"] as const) {
        if (typeof sessionPrototype[key] === "function") {
          Object.defineProperty(sessionPrototype, key, {
            configurable: true,
            value: unsupported
          });
        }
      }
    }

    const framePrototype = window.XRFrame?.prototype;
    if (framePrototype && "detectedPlanes" in framePrototype) {
      Object.defineProperty(framePrototype, "detectedPlanes", {
        configurable: true,
        get: () => new Set()
      });
    }
  });
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
      stage: root.dataset.placementStage ?? ""
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

test("feed shell renders with mocked data and AR trigger", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page, { forceArSupport: true });
  await page.goto("/");
  await assertViewerShell(page);
  const runtimeState = await waitForIwerRuntime(page);
  expect(runtimeState.hasIwerDevice).toBeTruthy();
  expect(runtimeState.isSecureContext).toBeTruthy();
  await expect(page.getByLabel("Upload Hologram")).toBeVisible();
  await expect(page.getByText("Mock Runner")).toBeVisible();
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);
});

test("entering AR starts an IWER-backed AR session and exit returns to feed", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  await enterMockAr(page);

  const sessionState = await readIwerSessionState(page);
  expect(sessionState?.environmentBlendMode).toBe("alpha-blend");

  await page.evaluate(() => {
    const exitButton = Array.from(document.querySelectorAll("button")).find((button) => (
      button.textContent?.trim() === "Exit AR"
    ));

    if (!(exitButton instanceof HTMLButtonElement)) {
      throw new Error("Exit AR button not found.");
    }

    exitButton.click();
  });
  await waitForNoIwerSession(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);
});

test("AR placement uses IWER SEM hit-test placement by default", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  await enterMockAr(page);
  const environmentState = await waitForIwerEnvironment(page, { minTrackedPlanes: 1 });
  expect(environmentState.hasSem).toBeTruthy();
  expect(environmentState.trackedPlanesCount).toBeGreaterThan(0);

  const placement = await waitForPlacement(
    page,
    {
      minSequence: 1,
      allowedModes: ["hit-test", "floor"],
      allowedReasons: ["hit-test-stable", "hit-test-anchor", "plane-detected", "plane-detected-anchor"],
      excludedStages: ["searching"]
    }
  );

  expect(["hit-test", "floor"]).toContain(placement.mode);
  expect(["anchored", "placed", "locked"]).toContain(placement.stage);
  expect(["hit-test-anchor", "hit-test-stable", "plane-detected", "plane-detected-anchor"]).toContain(placement.reason);
});

test("recenter reacquires placement from hit-test flow", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  await enterMockAr(page);
  await waitForIwerEnvironment(page, { minTrackedPlanes: 1 });
  const initialPlacement = await waitForPlacement(
    page,
    {
      minSequence: 1,
      allowedModes: ["hit-test", "floor"],
      allowedReasons: ["hit-test-stable", "hit-test-anchor", "plane-detected", "plane-detected-anchor"],
      excludedStages: ["searching"]
    }
  );

  await page.getByRole("button", { name: "Recenter Model" }).click({ force: true });
  await page.waitForTimeout(500);
  const nextPlacement = await readPlacementState(page);

  expect(nextPlacement.sequence).toBeGreaterThanOrEqual(initialPlacement.sequence);
  expect(["hit-test", "floor"]).toContain(nextPlacement.mode);
  expect(["anchored", "placed", "locked"]).toContain(nextPlacement.stage);
});

test("AR placement falls back when hit-test is unavailable", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);
  await disableHitTestForSession(page);

  await enterMockAr(page);

  const placement = await waitForPlacement(
    page,
    {
      minSequence: 1,
      notMode: "hit-test",
      excludedStages: ["searching"]
    }
  );

  expect(placement.anchored).toBe(false);
  expect(["floor", "visibility-fallback"]).toContain(placement.mode);
  expect(["hit-test-unavailable", "hit-test-timeout"]).toContain(placement.reason);
});
