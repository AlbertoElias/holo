import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { devices } from "@playwright/test";
import { createXrContext, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { captureEvidence, expect, test } from "./bootstrap";

// The phone journey (docs/features/phone-capture.md): a signed-out person on
// a phone taps Record in the feed, signs in by email (the test API exposes the
// link the email would carry), lands in capture holding a single-use post
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
    await page.goto("/");
    const marks: Record<string, number> = {};
    const started = Date.now();
    const mark = (name: string): void => { marks[name] = (Date.now() - started) / 1000; };

    // Signed out, Record asks for sign-in first, so the round trip happens before a take exists.
    await page.getByRole("button", { name: "Record a hologram" }).tap();
    const signIn = page.getByRole("form", { name: "Sign in" });
    await signIn.getByRole("textbox", { name: "Email" }).fill("phone-journey@example.com");
    await signIn.getByRole("textbox", { name: "Your name, if you are new" }).fill("Phone Journey");
    await signIn.getByRole("button", { name: "Email me a sign-in link" }).tap();
    // Stands in for opening the emailed link; it carries next=record, so no second tap on Record.
    await signIn.getByRole("link", { name: "Continue with the local sign-in link" }).tap();
    mark("signInLinkOpened");
    await page.waitForURL((url) => url.origin === captureOrigin, { timeout: 30_000 });
    await waitForTextContentPrefix(page, "#status", "loaded", { timeout: 60_000 });
    mark("captureLoaded");
    expect(page.url(), "the grant leaves the address bar").not.toContain("#post=");
    expect(await page.locator("#status").textContent(), "touch guidance").toContain("Prop your phone up, face it, tap Record.");

    await page.getByRole("button", { name: CONTROL_NAMES.startRecording }).tap();
    // "Starting camera" holds the count until the face camera runs (on a starved
    // runner the page stalls for seconds while the camera and model start), then
    // 3-2-1 on the page's clock. Wait for the count itself to end; the deadline
    // only bounds a hang (the page gives the camera at most 15 s).
    const countdown = page.locator("[data-capture-countdown]");
    await expect(countdown).toBeVisible();
    await expect(countdown).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible({ timeout: 30_000 });
    mark("recordingStarted");
    await expect(page.locator("[data-capture-running-time]")).toContainText(`0:0${TAKE_SECONDS}`, { timeout: 30_000 });
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

    const token = await page.evaluate(() => window.localStorage.getItem("holoim.session"));
    const me = await (await page.request.get("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })).json() as { id: string };
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
