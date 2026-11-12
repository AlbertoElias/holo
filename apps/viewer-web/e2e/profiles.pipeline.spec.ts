import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Locator, Page } from "@playwright/test";

import { expect, expectConsoleErrors, reachFor, test } from "./bootstrap";
import { signInForUpload } from "./sign-in";

// Creator pages, a page per hologram, and search (docs/features/profiles-and-share.md), through the real API
// and viewer: two creators upload, a visitor follows a name to the creator's page, opens and shares one
// hologram, searches, and the owner deletes. The run's token makes every name unique, so the shared test
// database's other holograms never match. The claim script for old "alberto" uploads is covered against a
// seeded database (apps/viewer-api/src/claim-uploads.ts), because uploads now need sign-in and no unowned
// hologram can be made through the API.

const glbPath = path.resolve(import.meta.dirname, "../../capture/public/gltf/models/avatar.glb");
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/profiles-and-share");
const token = `pf${Date.now().toString(36)}`;
const adaName = `Ada ${token}`;
const benName = `Ben ${token}`;

type Uploaded = { id: string; hologramName: string; ownerId: string | null };

async function upload(page: Page, headers: { authorization: string }, hologramName: string): Promise<Uploaded> {
  const response = await page.request.post("/api/holograms", {
    headers,
    multipart: {
      hologramName,
      submittedBy: "profiles-e2e",
      file: { name: "avatar.glb", mimeType: "model/gltf-binary", buffer: await readFile(glbPath) }
    }
  });
  expect(response.ok(), `upload ${hologramName}`).toBe(true);
  return (await response.json()) as Uploaded;
}

/** A second account, signed in through the API only: the page itself stays signed out. */
async function benHeaders(page: Page): Promise<{ authorization: string }> {
  const link = await page.request.post("/api/auth/magic-link", { data: { email: `ben-${token}@example.com`, displayName: benName } });
  const { devMagicLinkToken } = (await link.json()) as { devMagicLinkToken: string };
  const verify = await page.request.post("/api/auth/verify", { data: { token: devMagicLinkToken } });
  const { token: session } = (await verify.json()) as { token: string };
  return { authorization: `Bearer ${session}` };
}

/** How much of the reach group holding `control` shows: folded reach controls are drawn at opacity 0. */
const reachOpacity = (control: Locator): Promise<number> =>
  control.evaluate((element) => Number(getComputedStyle(element.closest(".portal-controls-reach") ?? element).opacity));

/**
 * Presses a reach control as a person does: the cursor travels to it over the card (which keeps the row open),
 * and the press lands once the row has stopped unfolding. A fast scripted click would aim at a button still on
 * the move.
 */
async function pressReached(page: Page, card: Locator, name: string): Promise<void> {
  const control = card.getByRole("button", { name });
  let last = "";
  await expect
    .poll(async () => {
      const box = await control.boundingBox();
      const now = JSON.stringify(box);
      const still = box !== null && now === last;
      last = now;
      return still;
    }, { intervals: [150] })
    .toBe(true);
  const box = (await control.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
}

const cards = (page: Page): Locator => page.locator(".feed-card");
const cardTitles = (page: Page): Promise<string[]> => cards(page).locator(".feed-card-title").allInnerTexts();

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`) });
}

test.describe("creator pages, hologram pages and search", () => {
  // The first test pays for the page, the models and the software renderer warming up.
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  let ada: Uploaded[] = [];
  let ben: Uploaded[] = [];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: process.env.E2E_BASE_URL ?? "https://localhost:3174" });
    const page = await context.newPage();
    const adaSession = await signInForUpload(page, { displayName: adaName, persist: false });
    ada = [await upload(page, adaSession.headers, `${token} tower`), await upload(page, adaSession.headers, `${token} arch`)];
    ben = [await upload(page, await benHeaders(page), `${token} bridge`)];
    await context.close();
  });

  test("a byline name opens that creator's page with exactly their holograms", async ({ page }) => {
    await page.goto(`/?q=${token}`);
    await expect(cards(page)).toHaveCount(3);
    await shot(page, "01-search-result");

    const adaCard = page.locator(`[data-card-id="${ada[0]!.id}"]`);
    const byline = adaCard.locator(".feed-card-creator");
    await expect(byline).toHaveText(adaName);
    await expect(adaCard.getByText("Verified creator")).toHaveCount(0);
    await byline.click();

    await expect(page).toHaveURL(new RegExp(`/u/${ada[0]!.ownerId}$`));
    await expect(cards(page)).toHaveCount(2);
    await expect.poll(async () => (await cardTitles(page)).sort()).toEqual([`${token} arch`, `${token} tower`]);
    await expect(page.locator(".feed-context")).toContainText(adaName);
    await shot(page, "02-creator-page");

    // The context chip's close goes back to the whole feed.
    await page.locator(".feed-context").getByRole("button", { name: "Show all holograms" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".feed-context")).toHaveCount(0);
  });

  test("a creator page pages through its own holograms only", async ({ page }) => {
    const first = await page.request.get(`/api/holograms?ownerId=${ada[0]!.ownerId}&limit=1`);
    const firstPage = (await first.json()) as { items: Uploaded[]; nextCursor: string | null };
    expect(firstPage.items.map((item) => item.id)).toEqual([ada[1]!.id]);
    expect(firstPage.nextCursor).not.toBeNull();
    const second = await page.request.get(`/api/holograms?ownerId=${ada[0]!.ownerId}&limit=1&cursor=${firstPage.nextCursor}`);
    expect(((await second.json()) as { items: Uploaded[] }).items.map((item) => item.id)).toEqual([ada[0]!.id]);
  });

  test("a title opens its own page, which also loads cold, and an unknown id says so", async ({ page }) => {
    await page.goto(`/?q=${token}`);
    await page.locator(`[data-card-id="${ben[0]!.id}"] .feed-card-title-link`).click();
    await expect(page).toHaveURL(new RegExp(`/h/${ben[0]!.id}$`));
    await expect(cards(page)).toHaveCount(1);
    // On its own page the title is not a link to itself.
    await expect(cards(page).locator(".feed-card-title-link")).toHaveCount(0);
    await shot(page, "03-hologram-page");

    await page.goto(`/h/${ada[0]!.id}`);
    await expect.poll(() => cardTitles(page)).toEqual([`${token} tower`]);

    // The API's 404 for an unknown id is the browser's console error, and the point of this step.
    expectConsoleErrors(page, /status of 404|does-not-exist/);
    await page.goto("/h/does-not-exist");
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("not here any more");
  });

  test("search narrows by title or creator, ignores case, and says when nothing matches", async ({ page }) => {
    await page.goto(`/?q=${encodeURIComponent(`BEN ${token}`)}`);
    await expect.poll(() => cardTitles(page)).toEqual([`${token} bridge`]);

    await page.goto(`/?q=${token} arch`);
    await expect.poll(() => cardTitles(page)).toEqual([`${token} arch`]);

    await page.goto(`/?q=${token}%25`);
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Nothing matches");

    // The dock's Search opens the field; a word goes to its result page, an empty field to the whole feed.
    await page.goto("/");
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("searchbox").fill(`${token} tower`);
    await page.getByRole("searchbox").press("Enter");
    await expect(page).toHaveURL(new RegExp(`\\?q=${encodeURIComponent(`${token} tower`).replace(/%20/g, "(%20|\\+)")}`));
    await expect.poll(() => cardTitles(page)).toEqual([`${token} tower`]);
    await shot(page, "04-search-field-result");
  });

  test("copy link and delete wait out of sight until the card is reached; delete is the owner's alone", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // A visitor: copy link, no delete.
    await page.goto(`/h/${ada[0]!.id}`);
    const card = cards(page).first();
    await expect(card.locator(".portal-controls")).toHaveAttribute("data-reach", "hidden");
    await expect.poll(() => reachOpacity(card.getByRole("button", { name: "Copy link" }))).toBe(0);
    await shot(page, "05-card-at-rest");
    await reachFor(card);
    await expect.poll(() => reachOpacity(card.getByRole("button", { name: "Copy link" }))).toBe(1);
    await expect(card.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await page.waitForTimeout(800); // the reach row unfolds over a moment; the frame shows it open
    await shot(page, "06-card-reached");
    await pressReached(page, card, "Copy link");
    await expect(page.getByRole("status")).toContainText("Link copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/h/${ada[0]!.id}`, page.url()).toString());
  });

  test("the owner deletes behind a confirmation, and the page of a deleted hologram leaves for the feed", async ({ page }) => {
    // Sign in as Ada in this page (the account exists; the API keeps its first name).
    await signInForUpload(page, { displayName: adaName });
    await page.goto(`/h/${ada[1]!.id}`);
    const card = cards(page).first();
    await reachFor(card);

    // Dismissing the confirmation keeps the hologram.
    page.once("dialog", (dialog) => void dialog.dismiss());
    await pressReached(page, card, "Delete");
    await expect(cards(page)).toHaveCount(1);
    expect((await page.request.get(`/api/holograms/${ada[1]!.id}`)).status()).toBe(200);

    page.once("dialog", (dialog) => {
      expect(dialog.message()).toContain(`${token} arch`);
      void dialog.accept();
    });
    await pressReached(page, card, "Delete");
    await expect(page).toHaveURL(/\/$/);
    expect((await page.request.get(`/api/holograms/${ada[1]!.id}`)).status()).toBe(404);

    // The creator's page no longer lists it; Ben's hologram is untouched.
    await page.goto(`/u/${ada[0]!.ownerId}`);
    await expect.poll(() => cardTitles(page)).toEqual([`${token} tower`]);
    await page.goto(`/h/${ben[0]!.id}`);
    await expect.poll(() => cardTitles(page)).toEqual([`${token} bridge`]);
  });
});
