import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

import { attachXrEnvironment } from "@holoim/tooling-testing/xr-env";

const viewerTitlePattern = /HoloIM Viewer/i;
const nonViewerBodyPattern = /Loading scene\.\.\./i;
// Chromium reports rejected WebGL calls as console warnings; a rejected draw
// renders nothing, so it fails tests like an error. Other GPU warnings, such
// as software-rendering or performance notes, stay non-fatal.
const webglInvalidOperationPattern = /GL_INVALID_OPERATION/;

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
      } else if (message.type() === "warning" && webglInvalidOperationPattern.test(message.text())) {
        runtimeErrors.push(`console.warning: ${message.text()}`);
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

// Evidence screenshots for reviewers; off by default to keep CI light.
export async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.E2E_SCREENSHOTS !== "1") return;
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

export { expect };
