import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { devices, type Page, type Request } from "@playwright/test";
import { createXrContext } from "@holoim/tooling-testing/xr-env";

import { outlinesKey } from "../../capture/scripts/lib/photo-look-key.ts";
import type { Finish, LookCard } from "../../../packages/avatar-look/src/index.ts";
import { expect, test } from "./bootstrap";
import { captureUrl, lookPanel, openCaptureOnHouseBase, press, recordAndPost, signInToCapture } from "./look-capture";
import { readGlbJson } from "./pipeline-takes";
import { installProbe, waitForPortalReady } from "./portal-helpers";

// "From a photo" in the look step (docs/features/directed-performance.md,
// slice 5b): the creator picks a photo of their own face, the card fills
// from slice 5a's read on the device, and the posted hologram wears the card.
// The photo is not uploaded: while it is read, the page makes only GET
// requests to capture's own origin. The read must equal the authoring CLI's
// (`photo-look.ts`) on the same photo: its card for the portrait is pinned
// here, and the opt-in parity test compares a whole photo set. Screenshots and numbers land in
// output/test-results/photo-look/.

const CAPTURE_APP = path.resolve(import.meta.dirname, "../../capture");
const fixtures = path.resolve(import.meta.dirname, "fixtures/photo-look");
/** A public-domain portrait (an official US Congress photo, a work of the US government). */
const PORTRAIT = path.join(fixtures, "portrait.jpg");
/** The house base rendered close up: a face the read finds, but its traits do not read as a person's. */
const HOUSE_FACE = path.join(fixtures, "house-face.jpg");
/** `selfie_multiclass_256x256.tflite`, as `photo-look.ts` pins it. */
const SEGMENTER_SHA256 = "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0";
const captureOrigin = new URL(captureUrl).origin;
const outDir = path.resolve(import.meta.dirname, "../../../output/test-results/photo-look");

type HouseLook = { look: LookCard; finish: Finish };
type PhotoSample = { picks: number; lastReadMs: number | null; card: LookCard | null; set: Array<{ trait: string; value: string }>; kept: Array<{ trait: string; why: string }>; hairStyleConfidence: number | null; readerOpen: boolean; opened: number; closed: number; previous: boolean };
type Hooks = { __sampleHouseLook: () => { look: HouseLook | null }; __samplePhotoLook: () => PhotoSample };

const sampleLook = async (page: Page) => (await page.evaluate(() => (window as unknown as Hooks).__sampleHouseLook())).look!;
const samplePhoto = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__samplePhotoLook());

/**
 * \`photo-look.ts\`'s card for the portrait from the shipped default look,
 * made by \`photo-look-data.ts cards\` (capture's authoring tools) with the
 * outlines of OUTLINES_KEY. Make it again when that key changes.
 */
const PORTRAIT_CARD = { skin: "linen", eyes: "coolGrey", hairColour: "wheat", hairStyle: "wavyBob" };

/** Every reader that opened has closed: \`close()\` ran, not only the reference dropped. */
async function expectReaderClosed(page: Page, why: string): Promise<void> {
  await expect.poll(async () => { const s = await samplePhoto(page); return { open: s.readerOpen, unclosed: s.opened - s.closed }; }, { message: why }).toEqual({ open: false, unclosed: 0 });
}

/** A plain image with no face: the ground colour, drawn in the page. */
async function blankJpeg(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 800;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#1f3b3a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.9);
  });
  return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
}

type Pick = { name: string; mimeType: string; buffer: Buffer } | string;

/** Taps "From a photo", picks the file in the device's picker, and waits for the read to end. */
async function pickPhoto(page: Page, file: Pick): Promise<string> {
  const before = (await samplePhoto(page)).picks;
  const chooser = page.waitForEvent("filechooser");
  await press(lookPanel(page).getByTestId("look-photo"));
  await (await chooser).setFiles(file);
  await expect.poll(async () => (await samplePhoto(page)).picks, { message: "the photo's read ends", timeout: 60_000 }).toBe(before + 1);
  await expect(lookPanel(page)).toHaveAttribute("data-look-status", "ready", { timeout: 30_000 });
  return (await lookPanel(page).getByTestId("look-status").textContent()) ?? "";
}

const TRAITS = (card: LookCard) => ({ skin: card.skin, eyes: card.eyes, hairColour: card.hair.colour, hairStyle: card.hair.style });

test.describe("your look from a photo", () => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture server.");

  test("phone: a photo fills the card on the device, Previous look puts it back, and the posted hologram wears only the card", async ({ browser }, testInfo) => {
    test.setTimeout(300_000);
    const outlinesFile = await readFile(path.join(CAPTURE_APP, "src/avatar/photoLookOutlines.ts"), "utf8");
    const shipped = /OUTLINES_KEY = '([0-9a-f]+)'/.exec(outlinesFile)?.[1];
    expect(shipped, "the outlines are made from the current house base, wardrobes and read code: run photo-look-data.ts outlines, then cards for PORTRAIT_CARD").toBe(await outlinesKey());
    const want = PORTRAIT_CARD;

    const context = await createXrContext(browser, { ...devices["Pixel 7"], baseURL: testInfo.project.use.baseURL });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
      await openCaptureOnHouseBase(page);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
      await signInToCapture(page, "Look photo");
      await expect(lookPanel(page), "the look panel opens before the first Record").toBeVisible({ timeout: 15_000 });
      await expect(lookPanel(page).getByText("Use a photo of your own face. It stays on this device.")).toBeVisible();
      await expect(lookPanel(page).getByTestId("look-previous"), "no Previous look before a photo").toBeHidden();
      const start = await sampleLook(page);
      expect((await samplePhoto(page)).readerOpen, "the reader does not load before the creator asks for it").toBe(false);

      // From here to the post, every request is a GET to capture's own origin: the photo does not leave the device.
      const requests: Request[] = [];
      page.on("request", (request) => requests.push(request));

      // A file that is not an image, and an image with no face: each is refused in words, and the look stays.
      const notImage = await pickPhoto(page, { name: "notes.jpg", mimeType: "image/jpeg", buffer: Buffer.from("these are notes, not a photo") });
      expect(notImage).toBe("That file did not open as a photo. Use a JPEG or PNG.");
      const noFace = await pickPhoto(page, { name: "wall.jpg", mimeType: "image/jpeg", buffer: await blankJpeg(page) });
      expect(noFace).toBe("No face found in that photo. Use a close photo of your own face.");
      expect(await sampleLook(page), "a refused photo leaves the look as it was").toEqual(start);
      await expect(lookPanel(page).getByTestId("look-previous")).toBeHidden();

      // The portrait: the card fills from the read, and it equals the CLI's.
      const read = await pickPhoto(page, PORTRAIT);
      const photo = await samplePhoto(page);
      const live = await sampleLook(page);
      expect(TRAITS(live.look), "the app's read equals photo-look.ts on the same photo").toEqual(want);
      expect({ build: live.look.build, glasses: live.look.glasses, clothing: live.look.clothing, finish: live.finish }, "a photo does not set build, glasses, clothes or finish").toEqual({ build: start.look.build, glasses: start.look.glasses, clothing: start.look.clothing, finish: start.finish });
      const changed = Object.entries(TRAITS(live.look)).filter(([trait, value]) => TRAITS(start.look)[trait as keyof ReturnType<typeof TRAITS>] !== value);
      expect(changed.length, "the portrait changes at least two rows").toBeGreaterThanOrEqual(2);
      expect(read, "the status line names each trait the photo set").toMatch(/^From your photo: skin [^,]+, hair colour [^,]+, eyes [^,]+, hair [^,]+\. Check each row\.$/);
      expect(photo.opened, "one reader for each pick (the two refusals and this read), opened only when asked").toBe(photo.picks);
      await expectReaderClosed(page, "the reader closes after the read");
      await expect(lookPanel(page).getByTestId("look-previous")).toBeVisible();
      await mkdir(outDir, { recursive: true });
      await page.screenshot({ path: path.join(outDir, "phone-read.png") });

      // Previous look: the look from before the photo, in one tap.
      await press(lookPanel(page).getByTestId("look-previous"));
      await expect(lookPanel(page)).toHaveAttribute("data-look-status", "ready", { timeout: 30_000 });
      expect(await sampleLook(page), "Previous look puts back the look from before the photo").toEqual(start);
      await expect(lookPanel(page).getByTestId("look-previous")).toBeHidden();

      // The house render: a face is found, so the read runs, and what it cannot say keeps its value with the reason.
      await pickPhoto(page, HOUSE_FACE);
      const houseFace = await samplePhoto(page);
      expect(houseFace.kept.length, "the render's traits do not all read").toBeGreaterThan(0);
      await expect(lookPanel(page).getByTestId("look-kept")).toHaveText(/^Kept as it was: .+\.$/);
      for (const kept of houseFace.kept) {
        const key = kept.trait as keyof ReturnType<typeof TRAITS>;
        expect(TRAITS(await sampleLook(page).then((l) => l.look))[key], `${kept.trait} kept as it was`).toBe(TRAITS(start.look)[key]);
      }
      await page.screenshot({ path: path.join(outDir, "phone-kept.png") });

      // The portrait again, then a take.
      await pickPhoto(page, PORTRAIT);
      const dressed = await sampleLook(page);
      expect(TRAITS(dressed.look)).toEqual(want);

      const offOrigin = requests.filter((r) => !r.url().startsWith("data:") && !r.url().startsWith("blob:") && (r.method() !== "GET" || new URL(r.url()).origin !== captureOrigin));
      expect(offOrigin.map((r) => `${r.method()} ${r.url()}`), "while photos are read, only GETs to capture's own origin").toEqual([]);
      const segmenter = requests.find((r) => r.url().endsWith("/mediapipe/selfie_multiclass_256x256.tflite"));
      expect(segmenter, "the segmenter loads from capture's origin").toBeDefined();
      const model = await page.request.get(segmenter!.url());
      expect(createHash("sha256").update(await model.body()).digest("hex"), "the segmenter is the pinned model").toBe(SEGMENTER_SHA256);

      expect((await samplePhoto(page)).previous, "Previous look is there before the take").toBe(true);
      const posted = await recordAndPost(page, async () => {
        expect((await samplePhoto(page)).previous, "a take ends Previous look").toBe(false);
        await expectReaderClosed(page, "no reader stays open into the take");
      });
      const glbResponse = await page.request.get(posted.url);
      const bytes = await glbResponse.body();
      const gltf = readGlbJson(bytes) as unknown as { nodes?: Array<{ extras?: Record<string, unknown> }>; scenes?: Array<{ extras?: Record<string, unknown> }> };
      const record = [...(gltf.nodes ?? []), ...(gltf.scenes ?? [])]
        .map((entry) => entry.extras?.holoimAvatar)
        .filter((value): value is string => typeof value === "string")
        .map((value) => JSON.parse(value) as Record<string, unknown>)
        .find((entry) => entry.name === "house-base");
      expect(record?.look, "the posted card is the read card").toEqual(dressed.look);
      // Only the card: no read numbers, no outline, no picture of the photo anywhere in the file's JSON.
      const json = JSON.stringify(gltf);
      for (const word of ["hairGrid", "confidence", "white", "photo", "data:image"]) expect(json.includes(word), `the GLB JSON holds no "${word}"`).toBe(false);

      await installProbe(page);
      await page.goto("/");
      const card = page.locator(`.feed-card[data-card-id="${posted.id}"]`);
      await card.scrollIntoViewIfNeeded();
      await waitForPortalReady(page, posted.id, new URL(posted.url, page.url()).pathname);
      await card.screenshot({ path: path.join(outDir, "phone-card.png") });
      expect(errors, "page errors").toEqual([]);
      await writeFile(path.join(outDir, "phone.json"), `${JSON.stringify({ start, want, read: photo, houseFace, posted, segmenterSha: SEGMENTER_SHA256, outlinesKey: shipped }, null, 2)}\n`);
    } finally {
      await context.close();
    }
  });

  // Slice 5a's photo set (not committed: PHOTO_LOOK_PARITY_DIR names a folder of photos, and
  // PHOTO_LOOK_PARITY_CARDS the file \`photo-look-data.ts cards <that folder> --out <file>\` wrote):
  // the app's read equals photo-look.ts on each, upscaled past 2048 px and EXIF-rotated ones too.
  test("parity: the app's read equals photo-look.ts on each photo", async ({ browser }, testInfo) => {
    const dir = process.env.PHOTO_LOOK_PARITY_DIR;
    const cardsFile = process.env.PHOTO_LOOK_PARITY_CARDS;
    test.skip(!dir || !cardsFile, "PHOTO_LOOK_PARITY_DIR and PHOTO_LOOK_PARITY_CARDS name no photo set.");
    test.setTimeout(600_000);
    const made = JSON.parse(await readFile(cardsFile!, "utf8")) as { outlinesKey: string; cards: Record<string, LookCard | null> };
    expect(made.outlinesKey, "the cards were made with the current outlines").toBe(await outlinesKey());
    const photos = (await readdir(dir!)).filter((file) => /\.(jpe?g|png)$/i.test(file)).sort();
    const context = await createXrContext(browser, { ...devices["Pixel 7"], baseURL: testInfo.project.use.baseURL });
    const rows: Array<{ photo: string; app: unknown; cli: unknown; same: boolean; readMs: number | null; refused: string | null }> = [];
    try {
      const page = await context.newPage();
      await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
      await openCaptureOnHouseBase(page);
      await signInToCapture(page, "Look parity");
      await expect(lookPanel(page)).toBeVisible({ timeout: 15_000 });
      const start = await sampleLook(page);
      for (const photo of photos) {
        const file = path.join(dir!, photo);
        // Each read starts from the same look, so a trait the photo cannot say falls back alike in both.
        await page.evaluate((look) => (window as unknown as { __setHouseLook: (l: unknown) => Promise<boolean> }).__setHouseLook(look), start);
        await expect(lookPanel(page)).toHaveAttribute("data-look-status", "ready", { timeout: 30_000 });
        const message = await pickPhoto(page, file);
        const sample = await samplePhoto(page);
        expect(photo in made.cards, `${photo} is in ${cardsFile}`).toBe(true);
        const cli = made.cards[photo] ?? null;
        const refused = cli ? null : "photo-look.ts refused it";
        const app = message.startsWith("From your photo") || message.startsWith("The photo set no trait") ? TRAITS((await sampleLook(page)).look) : message;
        const want = cli ? TRAITS(cli) : refused;
        rows.push({ photo, app, cli: want, same: JSON.stringify(app) === JSON.stringify(want) || (cli === null && typeof app === "string"), readMs: sample.lastReadMs, refused });
      }
    } finally {
      await context.close();
    }
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "parity.json"), `${JSON.stringify(rows, null, 2)}\n`);
    expect(rows.filter((row) => !row.same), "photos where the app and photo-look.ts differ").toEqual([]);
  });
});
