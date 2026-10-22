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

type FeedCardProbeWindow = Window & {
  __feedCardGl?: WebGL2RenderingContext;
  __HOLOIM_FEED_TEST_OBSERVER__?: (probe: { renderer: { getContext(): WebGL2RenderingContext } }) => void;
};

// Call before page.goto so the feed card's renderer is observed.
export async function observeFeedCardRenderer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hooks = window as FeedCardProbeWindow;
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => {
      hooks.__feedCardGl = probe.renderer.getContext();
    };
  });
}

// Under software GL a feed card's first frames take seconds of GPU time
// (12-16 s on one CPU). Entering AR before they finish makes the AR page's
// synchronous GL calls (the card's context loss on unmount, the AR canvas's
// context creation) wait behind them on the shared GPU thread, and the
// session misses its start deadline (B-018). A person taps AR on a card they
// can see, so wait until the card's frames have finished on the GPU. The
// fence is polled, never waited on, so the page stays responsive.
export async function waitForFeedCardPresented(page: Page): Promise<void> {
  await expect(page.locator(".feed-card").first()).toHaveAttribute("data-model-state", "rendered");
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const gl = (window as FeedCardProbeWindow).__feedCardGl;
    if (!gl) {
      reject(new Error("Feed card renderer was not observed; call observeFeedCardRenderer before page.goto."));
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) {
        reject(new Error("Feed card fence could not be created."));
        return;
      }
      gl.flush();
      const poll = () => {
        if (gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED) {
          gl.deleteSync(sync);
          resolve();
        } else {
          setTimeout(poll, 50);
        }
      };
      poll();
    }));
  }));
}

// Evidence screenshots for reviewers; off by default to keep CI light.
export async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.E2E_SCREENSHOTS !== "1") return;
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

export { expect };
