import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, expectConsoleErrors, test } from "./bootstrap";

// Creator sign-in by email, against the real API and viewer, with a local
// stand-in for Cloudflare Email Service. It needs the API started with the
// mailer pointed at that stand-in and dev link exposure off, so it only runs
// when E2E_FAKE_MAIL_PORT is set:
//
//   E2E_FAKE_MAIL_PORT=3391 AUTH_DEV_EXPOSE_MAGIC_LINK=false \
//   CLOUDFLARE_EMAIL_API_ORIGIN=http://127.0.0.1:3391 CLOUDFLARE_EMAIL_ACCOUNT_ID=acct \
//   CLOUDFLARE_EMAIL_API_TOKEN=test-token AUTH_EMAIL_FROM=signin@example.test \
//   pnpm --filter @holoim/web exec playwright test sign-in-email
const fakeMailPort = Number(process.env.E2E_FAKE_MAIL_PORT ?? "0");
// Where the proof run keeps its frames (output/ is ignored); unset elsewhere.
const shotDir = process.env.E2E_SHOT_DIR;
const glbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../capture/public/gltf/models/avatar.glb");

// A sheet unfolds over a moment (the first one can start late while the page warms up); the proof frames wait
// until it has arrived.
const settle = async (page: Page) => {
  if (!shotDir) return;
  await expect.poll(async () => (await page.getByRole("dialog").boundingBox())?.x ?? 9999, { timeout: 10_000 }).toBeLessThan(60);
  await page.waitForTimeout(700);
};

type SentMail = { authorization: string | undefined; body: { to: string; from: { address: string }; subject: string; text: string } };

test.describe("creator sign-in by email", () => {
  test.skip(!fakeMailPort, "needs E2E_FAKE_MAIL_PORT and the API mailer env (see the file header)");
  test.describe.configure({ mode: "serial" });

  let server: Server;
  const sent: SentMail[] = [];
  let failNext = false;

  test.beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (failNext) {
          failNext = false;
          response.writeHead(500, { "content-type": "application/json" }).end('{"success":false,"errors":[{"message":"sender domain not verified"}]}');
          return;
        }
        sent.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as SentMail["body"] });
        response.writeHead(200, { "content-type": "application/json" }).end('{"success":true,"result":{"delivered":["x"]}}');
      });
    });
    await new Promise<void>((resolve) => server.listen(fakeMailPort, "127.0.0.1", resolve));
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("an anonymous person is asked to sign in to upload, the email arrives, and its link signs them in", async ({ page }, testInfo) => {
    await page.goto("/");

    // Upload shows sign-in, not the upload form, and the API refuses an anonymous upload.
    await page.getByRole("button", { name: "Upload a hologram" }).click();
    const sheet = page.getByRole("dialog", { name: "Upload a hologram" });
    await expect(sheet.getByRole("form", { name: "Sign in" })).toBeVisible();
    await expect(sheet.locator("#glb-upload")).toHaveCount(0);
    await settle(page);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "upload-gate.png") });
    const anonymous = await page.request.post("/api/holograms", {
      multipart: { hologramName: "x", submittedBy: "x", file: { name: "a.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("glTF") } }
    });
    expect(anonymous.status()).toBe(401);
    await sheet.getByRole("button", { name: "Close" }).click();

    // Settings has the same form; ask for the link.
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByLabel("Email", { exact: true }).fill("ada@example.test");
    await settings.getByLabel("Your name, if you are new").fill("Ada Lovelace");
    await settle(page);
    await testInfo.attach("settings-sign-in.png", { body: await page.screenshot(shotDir ? { path: path.join(shotDir, "settings-sign-in.png") } : {}), contentType: "image/png" });
    await settings.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(settings.getByRole("status")).toContainText("We emailed a sign-in link to ada@example.test");
    await expect(settings.getByText("Continue with the local sign-in link")).toHaveCount(0);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, "settings-sent.png") });

    // The email went to Cloudflare with the credentials and carried the link.
    await expect.poll(() => sent.length).toBe(1);
    const mail = sent[0]!;
    expect(mail.authorization).toBe("Bearer test-token");
    expect(mail.body.to).toBe("ada@example.test");
    expect(mail.body.from.address).toBe("signin@example.test");
    const link = /https?:\/\/\S+\/auth\/verify\?token=\S+/.exec(mail.body.text)?.[0];
    expect(link, "the email text holds the sign-in link").toBeTruthy();

    // Opening the emailed link signs in; the Upload sheet now credits the account.
    await page.goto(new URL(link!).pathname + new URL(link!).search);
    await expect(page.getByRole("button", { name: "Upload a hologram" })).toBeVisible();
    await page.getByRole("button", { name: "Upload a hologram" }).click();
    await expect(sheet.getByText("Credited to Ada Lovelace")).toBeVisible();
    await sheet.locator("#glb-upload").setInputFiles(glbPath);
    await settle(page);
    await testInfo.attach("upload-signed-in.png", { body: await page.screenshot(shotDir ? { path: path.join(shotDir, "upload-signed-in.png") } : {}), contentType: "image/png" });
    await sheet.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByText(/Uploaded “/)).toBeVisible({ timeout: 30_000 });

    // The link is single use.
    const reuse = await page.request.post("/api/auth/verify", { data: { token: new URL(link!).searchParams.get("token") } });
    expect(reuse.status()).toBe(401);
  });

  test("when the email cannot be sent, the person is told so and no link is claimed", async ({ page }) => {
    failNext = true;
    // The browser logs the API's deliberate 503.
    expectConsoleErrors(page, /503/);
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByLabel("Email", { exact: true }).fill("grace@example.test");
    await settings.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(settings.getByRole("alert")).toContainText("We couldn't send the sign-in email");
    await expect(settings.getByRole("status")).toHaveCount(0);
  });
});
