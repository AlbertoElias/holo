import type { Locator, Page } from "@playwright/test";
import { waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { expect } from "./bootstrap";

// Capture's look step, as the look specs drive it (phone-look and
// phone-photo-look): sign in from the feed onto the house base, tap as a
// person would, and record and post a short take.

export const HOUSE_BASE = "/gltf/models/house-base.glb";
export const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const captureOrigin = new URL(captureUrl).origin;
const TAKE_SECONDS = 2;

/** Capture opened from the feed loads the house base: the link carries no query, so this adds `?avatar=` before the app reads it. */
export async function openCaptureOnHouseBase(page: Page): Promise<void> {
  await page.addInitScript(
    ({ origin, avatar }) => {
      if (window.location.origin !== origin) return;
      const url = new URL(window.location.href);
      if (url.searchParams.has("avatar")) return;
      url.searchParams.set("avatar", avatar);
      window.history.replaceState(window.history.state, "", url);
    },
    { origin: captureOrigin, avatar: HOUSE_BASE }
  );
}

export async function signInToCapture(page: Page, who: string): Promise<void> {
  await page.goto("/");
  await press(page.getByRole("button", { name: "Record a hologram" }));
  const signIn = page.getByRole("form", { name: "Sign in" });
  await signIn.getByRole("textbox", { name: "Email" }).fill(`${who.toLowerCase().replace(/\W+/g, "-")}@example.com`);
  await signIn.getByRole("textbox", { name: "Your name, if you are new" }).fill(who);
  await press(signIn.getByRole("button", { name: "Email me a sign-in link" }));
  await press(signIn.getByRole("link", { name: "Continue with the local sign-in link" }));
  await page.waitForURL((url) => url.origin === captureOrigin, { timeout: 30_000 });
  await waitForTextContentPrefix(page, "#status", "loaded", { timeout: 60_000 });
}

export const lookPanel = (page: Page) => page.getByTestId("look-panel");

/** A tap on a touch screen and a click with a mouse, as a person would use each. */
export async function press(target: Locator): Promise<void> {
  const touch = await target.page().evaluate(() => navigator.maxTouchPoints > 0);
  await (touch ? target.tap() : target.click());
}

/** Taps one choice in the look panel and waits for the live avatar to wear it. */
export async function choose(page: Page, row: string, option: string): Promise<void> {
  const choice = lookPanel(page).getByRole("radiogroup", { name: row }).getByRole("radio", { name: option, exact: true });
  await choice.scrollIntoViewIfNeeded();
  await expect.poll(() => choice.locator("img").evaluate((img) => (img as HTMLImageElement).naturalWidth), { message: `${row}: ${option} shows its picture` }).toBeGreaterThan(0);
  await press(choice);
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await expect(lookPanel(page)).toHaveAttribute("data-look-status", "ready", { timeout: 30_000 });
}

/** Records a short take and posts it; returns the new hologram's id and model URL. */
export async function recordAndPost(page: Page): Promise<{ id: string; url: string }> {
  await press(page.getByRole("button", { name: CONTROL_NAMES.startRecording }));
  await expect(lookPanel(page), "the panel closes for the take").toBeHidden();
  await expect(page.getByTestId("dock-look"), "no Look control while a take runs").toBeHidden();
  await expect(page.locator("[data-capture-countdown]")).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible({ timeout: 30_000 });
  // A face during the take, so the posted file must carry morph tracks.
  await page.evaluate(() => (window as unknown as { __setFaceInput: (s: unknown) => void }).__setFaceInput({ weights: { jawOpen: 0.5, mouthSmileLeft: 0.6, mouthSmileRight: 0.6 } }));
  const runningSeconds = async () => {
    const match = /(\d+):(\d{2})/.exec((await page.locator("[data-capture-running-time]").textContent()) ?? "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
  };
  await expect.poll(runningSeconds, { timeout: 30_000 }).toBeGreaterThanOrEqual(TAKE_SECONDS);
  await press(page.getByRole("button", { name: CONTROL_NAMES.stopRecording }));
  const post = page.locator("[data-capture-post]");
  await expect(post).toHaveAttribute("data-post-state", "ready", { timeout: 60_000 });
  await expect(lookPanel(page), "after Stop, the Post panel has the slot above the dock").toBeHidden();
  await press(post.getByRole("button", { name: "Post" }));
  await page.waitForURL(/\/h\/[^/?]+\?posted=1$/, { timeout: 60_000 });
  const id = new URL(page.url()).pathname.split("/").pop() as string;
  const record = (await (await page.request.get(`/api/holograms/${id}`)).json()) as { url: string };
  return { id, url: record.url };
}

