import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page, Route } from "@playwright/test";

import { expect, expectConsoleErrors, test } from "./bootstrap";
import { stubSignedInCreator } from "./sign-in";

// Bugs replayed from a model of the upload panel (B-058): idle, file chosen,
// uploading, then success or error, with the panel in a side sheet that unmounts
// when it closes. The upload request is held by the check and released on cue,
// so each ordering of picks, presses, closes and answers is exact. The API is
// mocked: the direct-upload initiate is refused (the viewer then falls back to
// one multipart POST, the request held here) and the feed starts empty.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlb = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");

function dto(id: string, name: string, filename: string) {
  return {
    id,
    url: `/uploads/${id}.glb`,
    usdzUrl: null,
    usdzStatus: "none",
    quickLookEnabled: false,
    createdAt: "2026-11-12T09:00:00.000Z",
    sizeBytes: 2048,
    filenameOriginal: filename,
    hologramName: name,
    submittedBy: "E2E Creator",
    submittedByVerified: false,
    ownerId: "e2e-creator",
    ownedByViewer: true
  };
}

type Held = { filename: string; fields: string; release: (status?: number) => void };

/** Answers the multipart upload only when the check releases it; every request is kept in order. */
async function holdUploads(page: Page): Promise<Held[]> {
  const held: Held[] = [];
  // The browser logs the refused direct-upload initiate (404) and, in one check, the refused upload (500) on purpose.
  expectConsoleErrors(page, /status of (404|500)/);
  await page.route("**/api/holograms/uploads/initiate", (route) => route.fulfill({ status: 404, json: { error: "direct upload off" } }));
  await page.route("**/api/holograms", (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    const body = request.postData() ?? "";
    const filename = /filename="([^"]+)"/.exec(body)?.[1] ?? "";
    const name = /name="hologramName"\r\n\r\n([^\r]*)/.exec(body)?.[1] ?? "";
    return new Promise<void>((resolve) => {
      held.push({
        filename,
        fields: name,
        release: (status = 201) => {
          const id = `held-${held.length}`;
          void route
            .fulfill(status === 201 ? { status, json: dto(id, name, filename) } : { status, json: { error: "The server refused this upload." } })
            .then(() => resolve());
        }
      });
    });
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/uploads/*.glb", (route) => route.fulfill({ status: 200, path: avatarGlb, contentType: "model/gltf-binary" }));
  return held;
}

async function openUpload(page: Page) {
  await page.getByRole("button", { name: "Upload a hologram" }).click();
  const sheet = page.getByRole("dialog", { name: "Upload a hologram" });
  await expect(sheet).toBeVisible();
  return sheet;
}

const press = (page: Page) => page.getByRole("dialog", { name: "Upload a hologram" }).getByRole("button", { name: /^(Upload|Uploading…)$/ });

test.describe("B-058: the upload panel while a request is in flight", () => {
  test("in the open panel nothing can change the upload: the picker, the name and a drop are shut, a second press sends nothing", async ({ page }) => {
    const held = await holdUploads(page);
    await stubSignedInCreator(page);
    await page.goto("/");
    const sheet = await openUpload(page);
    await sheet.locator("#glb-upload").setInputFiles({ name: "first.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("glTF-first") });
    await expect(sheet.getByLabel("Hologram name")).toHaveValue("first");
    await press(page).click();
    await expect.poll(() => held.length).toBe(1);

    // Every control that could change the upload is shut.
    await expect(sheet.locator("#glb-upload")).toBeDisabled();
    await expect(sheet.getByLabel("Hologram name")).toBeDisabled();
    await expect(sheet.getByRole("switch", { name: "iOS Quick Look" })).toBeDisabled();
    // A file dropped on the zone mid-upload is ignored: the chosen file stays the one being sent.
    await sheet.locator("label.upload-drop").evaluate((zone) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["glTF-second"], "second.glb", { type: "model/gltf-binary" }));
      zone.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await expect(sheet.locator(".upload-drop-name")).toHaveText("first.glb");
    // A second press while uploading sends nothing.
    await press(page).click();
    await press(page).click();
    await expect(page.getByText("Uploading “first”…")).toBeVisible();
    expect(held, "one request for one press").toHaveLength(1);
    expect(held[0]!.filename).toBe("first.glb");

    held[0]!.release();
    await expect(page.getByText("Uploaded “first”")).toBeVisible();
    await expect(sheet).toHaveCount(0);
  });

  test("a failure after the user is back in the panel is shown for the upload that failed, and the form is not reset", async ({ page }) => {
    const held = await holdUploads(page);
    await stubSignedInCreator(page);
    await page.goto("/");
    const sheet = await openUpload(page);
    await sheet.locator("#glb-upload").setInputFiles({ name: "first.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("glTF-first") });
    await press(page).click();
    await expect.poll(() => held.length).toBe(1);
    held[0]!.release(500);
    await expect(page.getByText("The server refused this upload.")).toBeVisible();
    // The choice survives the failure, and a retry sends the same file.
    await expect(sheet.locator(".upload-drop-name")).toHaveText("first.glb");
    await expect(press(page)).toHaveText("Upload");
    await press(page).click();
    await expect.poll(() => held.length).toBe(2);
    expect(held[1]!.filename).toBe("first.glb");
    held[1]!.release();
    await expect(page.getByText("Uploaded “first”")).toBeVisible();
  });

  test("closing the sheet mid-upload and opening it again does not let a second upload start beside the first", async ({ page }) => {
    const held = await holdUploads(page);
    await stubSignedInCreator(page);
    await page.goto("/");
    let sheet = await openUpload(page);
    await sheet.locator("#glb-upload").setInputFiles({ name: "first.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("glTF-first") });
    await press(page).click();
    await expect.poll(() => held.length).toBe(1);

    // The upload runs on while the sheet is closed, and the sheet reopens onto a new panel.
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByText("Uploading “first”…")).toBeVisible();
    sheet = await openUpload(page);

    // The new panel knows an upload is in flight: its fields are shut and it says so.
    await expect(sheet.locator("#glb-upload")).toBeDisabled();
    await expect(sheet.getByLabel("Hologram name")).toBeDisabled();
    await expect(press(page)).toHaveText("Uploading…");
    await press(page).click();
    expect(held, "still the one request").toHaveLength(1);

    // The answer closes the sheet, as it does when the upload was watched from the start.
    held[0]!.release();
    await expect(page.getByText("Uploaded “first”")).toBeVisible();
    await expect(sheet).toHaveCount(0);
  });
});
