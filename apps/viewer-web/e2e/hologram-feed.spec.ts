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
  excludedStages: ["searching"]
};

test("feed lists holograms, and AR entry and exit round-trip through IWER", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  await enterMockAr(page);
  const runtimeState = await waitForIwerRuntime(page);
  expect(runtimeState.isSecureContext).toBeTruthy();
  const sessionState = await readIwerSessionState(page);
  expect(sessionState?.environmentBlendMode).toBe("alpha-blend");

  await clickSessionButton(page, "Exit AR");
  await waitForNoIwerSession(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel("Upload Hologram")).toBeVisible();
  await expect(page.getByText("Mock Runner")).toBeVisible();
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);
});

test("AR placement anchors on IWER SEM hit-tests and recenter places again", async ({ page }) => {
  await mockFeed(page);
  await setDesktopNavigatorOverrides(page);

  await enterMockAr(page);
  const environmentState = await waitForIwerEnvironment(page, { minTrackedPlanes: 1 });
  expect(environmentState.hasSem).toBeTruthy();
  await expect(page.locator(".ar-view-container")).toHaveAttribute("data-depth-occlusion", "disabled");
  await expect(page.locator(".ar-view-container")).toHaveAttribute("data-depth-occlusion-reason", "iwer-runtime");

  const placement = await waitForPlacement(page, { minSequence: 1, ...HIT_TEST_PLACEMENT });
  expect(["anchored", "placed", "locked"]).toContain(placement.stage);

  // Recenter must reset placement and then place again. The sequence counter
  // cannot show this (the controller and model each own one), so record the
  // stage history and require a reset followed by a resolved placement.
  await page.evaluate(() => {
    const root = document.querySelector(".ar-view-container") as HTMLElement;
    const stages: string[] = [];
    (window as Window & { __placementStages?: string[] }).__placementStages = stages;
    new MutationObserver(() => stages.push(root.dataset.placementStage ?? "")).observe(root, {
      attributes: true,
      attributeFilter: ["data-placement-stage"]
    });
  });
  await clickSessionButton(page, "Recenter Model");
  await page.waitForFunction(() => {
    const stages = (window as Window & { __placementStages?: string[] }).__placementStages ?? [];
    const resetIndex = stages.findIndex((stage) => stage === "unplaced" || stage === "searching");
    return resetIndex >= 0 && ["anchored", "placed", "locked"].includes(stages.at(-1) ?? "") && stages.length - 1 > resetIndex;
  }, null, { timeout: 15000 });
  const replaced = await waitForPlacement(page, HIT_TEST_PLACEMENT);
  expect(["anchored", "placed", "locked"]).toContain(replaced.stage);
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
