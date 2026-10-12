import { expect, test as base, type Page } from "@playwright/test";

import { attachXrEnvironment } from "@holoim/tooling-testing/xr-env";

const viewerTitlePattern = /HoloIM Viewer/i;
const nonViewerBodyPattern = /Loading scene\.\.\./i;

export const test = base.extend({
  page: async ({ page }, consumePage) => {
    await attachXrEnvironment(page, { mode: process.env.XR_TEST_MODE });
    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`console.error: ${message.text()}`);
      }
    });
    await consumePage(page);
    // Runtime errors fail the test even when the visible flow completed.
    expect(runtimeErrors, "viewer runtime errors").toEqual([]);
  }
});

export async function assertViewerShell(page: Page): Promise<void> {
  const title = await page.title();
  if (!viewerTitlePattern.test(title)) {
    const bodyText = (await page.locator("body").innerText()).trim().replace(/\s+/g, " ");
    throw new Error(`E2E preflight failed: unexpected shell title "${title}" and body "${bodyText.slice(0, 180)}".`);
  }

  const bodyText = await page.locator("body").innerText();
  if (nonViewerBodyPattern.test(bodyText)) {
    throw new Error(`E2E preflight failed: non-viewer app detected (body matched "${nonViewerBodyPattern.source}").`);
  }
}

export { expect };
