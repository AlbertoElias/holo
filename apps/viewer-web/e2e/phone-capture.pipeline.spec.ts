import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { devices } from "@playwright/test";
import { createXrContext, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { captureEvidence, expect, test } from "./bootstrap";
import { signInForUpload } from "./sign-in";

// The phone journey (docs/features/phone-capture.md): a signed-in person on a
// phone taps Record in the feed, capture opens holding a single-use post
// grant, a selfie take records after a 3-2-1 countdown, Post uploads it as
// them, and the viewer opens the new hologram with Share. The face camera is
// left on as on a real phone (navigator.webdriver reads false), so its
// permission and model load are part of the timed path. Timings land in
// output/test-results/phone-capture-timings.json.

const TAKE_SECONDS = 3;
const captureOrigin = new URL(process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/").origin;

test("a phone records a selfie take and posts it to a shareable link", async ({ browser }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture server.");
  test.setTimeout(180_000);
  const context = await createXrContext(browser, { ...devices["Pixel 7"], baseURL: testInfo.project.use.baseURL });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    const session = await signInForUpload(page, { displayName: "Phone Journey" });
    const me = await (await page.request.get("/api/auth/me", { headers: session.headers })).json() as { id: string };

    await page.goto("/");
    const marks: Record<string, number> = {};
    const started = Date.now();
    const mark = (name: string): void => { marks[name] = (Date.now() - started) / 1000; };

    await page.getByRole("button", { name: "Record a hologram" }).tap();
    await page.waitForURL((url) => url.origin === captureOrigin, { timeout: 30_000 });
    await waitForTextContentPrefix(page, "#status", "loaded", { timeout: 60_000 });
    mark("captureLoaded");
    expect(page.url(), "the grant leaves the address bar").not.toContain("#post=");
    expect(await page.locator("#status").textContent(), "touch guidance").toContain("Touch:");

    await page.getByRole("button", { name: CONTROL_NAMES.startRecording }).tap();
    await expect(page.locator("[data-capture-countdown]")).toHaveText("3");
    await expect(page.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible({ timeout: 10_000 });
    mark("recordingStarted");
    await expect(page.locator("[data-capture-running-time]")).toContainText(`0:0${TAKE_SECONDS}`, { timeout: 15_000 });
    await captureEvidence(page, testInfo, "phone-selfie-recording");
    await page.getByRole("button", { name: CONTROL_NAMES.stopRecording }).tap();

    const panel = page.locator("[data-capture-post]");
    await expect(panel).toHaveAttribute("data-post-state", "ready", { timeout: 60_000 });
    mark("takeReady");
    await captureEvidence(page, testInfo, "phone-post-panel");
    await panel.getByRole("button", { name: "Post" }).tap();

    await page.waitForURL(/\/h\/[^/?]+\?posted=1$/, { timeout: 60_000 });
    const id = new URL(page.url()).pathname.split("/").pop() as string;
    await expect(page.getByRole("button", { name: /^(Share|Copy link)$/ })).toBeVisible({ timeout: 30_000 });
    mark("posted");
    await captureEvidence(page, testInfo, "phone-posted");

    const hologram = await (await page.request.get(`/api/holograms/${id}`)).json() as { ownerId: string | null; submittedByVerified: boolean; submittedBy: string };
    expect(hologram.ownerId, "posted as the signed-in person").toBe(me.id);
    expect(hologram.submittedByVerified).toBe(true);
    expect(hologram.submittedBy).toBe("Phone Journey");
    expect(errors, "page errors").toEqual([]);

    const report = { takeSeconds: TAKE_SECONDS, secondsFromRecordTap: marks, budgetSeconds: 120 };
    const reportPath = path.resolve(import.meta.dirname, "../../../output/test-results/phone-capture-timings.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    expect(marks.posted, "Record tap to shareable link").toBeLessThan(120);
  } finally {
    await context.close();
  }
});
