import { assertViewerShell, expect, test } from "./bootstrap";

test("feed shell renders with live API", async ({ page }) => {
  test.skip(process.env.RUN_E2E_INTEGRATION !== "1", "Live API E2E is enabled only for integration/nightly runs.");

  const feedResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "GET" && response.url().includes("/api/holograms")
  ));

  await page.goto("/");
  await assertViewerShell(page);
  await expect(page.getByText("Upload Hologram")).toBeVisible();

  const feedResponse = await feedResponsePromise;
  expect(feedResponse.ok()).toBeTruthy();
});
