import { assertViewerShell, expect, test } from "./bootstrap";
import type { Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const mockGlbPath = path.resolve(testDir, "../../api/test/fixtures/smoke-avatar.glb");

async function mockFeed(page: Page): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "mock-1",
            url: "/uploads/mock-avatar.glb",
            usdzUrl: null,
            createdAt: "2026-02-10T00:00:00.000Z",
            sizeBytes: 2048,
            filenameOriginal: "mock-avatar.glb",
            hologramName: "Mock Runner",
            submittedBy: "automation"
          }
        ],
        nextCursor: null
      })
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

test("feed shell renders with mocked data and AR trigger", async ({ page }) => {
  await mockFeed(page);
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

    (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__ = true;
  });
  await page.goto("/");
  await assertViewerShell(page);
  await expect(page.getByLabel("Upload Hologram")).toBeVisible();
  await expect(page.getByText("Mock Runner")).toBeVisible();
  await expect(page.locator(".ar-trigger-button")).toHaveCount(1);
});

test("AR trigger stays hidden when immersive AR is unsupported", async ({ page }) => {
  await mockFeed(page);
  await page.addInitScript(() => {
    const nav = navigator as Navigator & {
      platform?: string;
      maxTouchPoints?: number;
      userAgent?: string;
      xr?: unknown;
    };
    try {
      Object.defineProperty(nav, "platform", { configurable: true, get: () => "Linux x86_64" });
      Object.defineProperty(nav, "maxTouchPoints", { configurable: true, get: () => 0 });
      Object.defineProperty(nav, "userAgent", {
        configurable: true,
        get: () => "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      });
      Object.defineProperty(nav, "xr", {
        configurable: true,
        get: () => undefined
      });
    } catch {
      // Best effort override for deterministic non-iOS behavior.
    }
  });

  await page.goto("/");
  await assertViewerShell(page);
  await expect(page.locator(".ar-trigger-button")).toHaveCount(0);
});
