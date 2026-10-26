import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { test as plainTest, type Page } from "@playwright/test";
import type * as Three from "three";
import { waitForIwerSession, waitForNoIwerSession } from "@holoim/tooling-testing/xr-env";
import { tokens } from "@holoim/design-tokens";
import { arCompositorFromUserAgent, chipOpacity, CONTROL_NAMES, hitAreaApx, VIEW_TARGETS } from "@holoim/xr-ui-core";

import { assertViewerShell, expect, observeFeedCardRenderer, test, waitForFeedCardPresented, pressViewInAr } from "./bootstrap";
import { pinch } from "./ar-gestures";
import { installProbe, readPortal, scrollFeedToTop, touchPinch, waitForPortalReady } from "./portal-helpers";

// The viewer's pages in the redesigned look (docs/features/ui-redesign.md,
// slice 3), on a mocked feed at desktop size and at 390 × 844, and the WebXR
// AR route under IWER. Screenshots go to output/redesign-slice-3/ for the
// user's look; the assertions are the slice's acceptance criteria.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlb = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const shotsDir = path.resolve(testDir, "../../../output/redesign-slice-3");
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const items = ["a", "b", "c"].map((key, index) => ({
  id: `redesign-${key}`,
  url: `/uploads/redesign-${key}.glb`,
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-10-24T09:30:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: `redesign-${key}.glb`,
  hologramName: ["This is the entire kitchen", "Sunday, before the guests came", "The long way round"][index]!,
  submittedBy: "Mara"
}));
const [first] = items as [typeof items[number]];

test.describe.configure({ timeout: 90_000 });

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

async function mockFeed(page: Page, feed: typeof items = items): Promise<void> {
  await page.addInitScript(() => {
    (window as Window & { __HOLOIM_AR_SUPPORTED_OVERRIDE__?: boolean }).__HOLOIM_AR_SUPPORTED_OVERRIDE__ = true;
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: feed, nextCursor: null } }));
  for (const item of feed) await page.route(`**/api/holograms/${item.id}`, (route) => route.fulfill({ json: item }));
  await page.route("**/uploads/**", (route) => route.fulfill({ path: avatarGlb, contentType: "model/gltf-binary" }));
}

type ClocheReading = { drawn: boolean; opacity: number; core: number; glow: number; time: number; embers: number; sparks: number; radii: { x: number; y: number; z: number } };

/** The burnt globe's state in a card's scene, read from its parts and the uniforms they share. */
async function readCloche(page: Page, url: string): Promise<ClocheReading> {
  await expect.poll(() => page.evaluate((key) => {
    const probes = (window as unknown as { __portalProbes?: Record<string, { scene?: Three.Scene }> }).__portalProbes ?? {};
    return Boolean(probes[key]?.scene?.getObjectByName("cloche-shell"));
  }, url), { timeout: 20_000 }).toBe(true);
  return page.evaluate((key) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { scene: Three.Scene }> }).__portalProbes;
    const scene = probes[key]!.scene;
    const shell = scene.getObjectByName("cloche-shell") as Three.Mesh<Three.BufferGeometry, Three.ShaderMaterial>;
    const embers = scene.getObjectByName("cloche-embers") as Three.Points;
    const sparks = scene.getObjectByName("cloche-sparks") as Three.Points;
    const uniforms = shell.material.uniforms;
    let drawn = true;
    shell.traverseAncestors((node) => { if (!node.visible) drawn = false; });
    shell.geometry.computeBoundingBox();
    const size = shell.geometry.boundingBox!.max;
    return {
      drawn: drawn && shell.visible,
      opacity: uniforms.uOpacity!.value as number,
      core: uniforms.uLine!.value as number,
      glow: uniforms.uGlowLevel!.value as number,
      time: uniforms.uTime!.value as number,
      embers: embers.visible ? embers.geometry.getAttribute("position").count : 0,
      sparks: sparks.visible ? sparks.geometry.drawRange.count : 0,
      radii: { x: size.x, y: size.y, z: size.z }
    };
  }, url);
}

async function openFeed(page: Page): Promise<void> {
  await installProbe(page);
  await mockFeed(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, first.id, first.url);
  await scrollFeedToTop(page);
}

for (const [label, viewport] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
  test(`${label}: the feed card in the new look`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openFeed(page);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(600);
    await shot(page, `${label}-feed`);
    const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);

    // The ground is pinned to the screen and painted from the token stops.
    const ground = await page.evaluate(() => {
      const style = getComputedStyle(document.body, "::before");
      return { position: style.position, image: style.backgroundImage };
    });
    expect(ground.position, "the ground does not scroll with the feed").toBe("fixed");
    expect(ground.image).toContain("linear-gradient");

    // Play (or Pause) is always there, alone in the middle of the foot; the rest come on reach.
    const controls = card.locator(".portal-controls");
    const play = controls.getByRole("button", { name: new RegExp(`^(${CONTROL_NAMES.play}|${CONTROL_NAMES.pause})$`) });
    await expect(play).toBeVisible();
    await expect(controls.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView }), "Return comes only while looking around").toHaveCount(0);
    for (const control of await controls.locator(".portal-controls-row button").all()) {
      const box = await control.boundingBox();
      expect(box!.width, "every glyph's hit area is at least the mouse minimum").toBeGreaterThanOrEqual(hitAreaApx("mouse", 0) - 0.5);
      expect(box!.height).toBeGreaterThanOrEqual(hitAreaApx("mouse", 0) - 0.5);
    }
    await expect(controls.locator(".portal-timecode")).toHaveCSS("font-family", new RegExp([tokens.type.timecode.fontFamily].flat()[0]!.split(",")[0]!.replace(/"/g, "")));

    // Free, the timecode and the toggles come only when reached for, either side of Play, which holds still.
    await expect(controls).toHaveAttribute("data-reach", "hidden");
    const restingPlay = await play.boundingBox();
    await card.locator(".feed-card-portal").hover({ force: true });
    await expect(controls).toHaveAttribute("data-reach", "shown");
    // Measure the settled row: on a loaded runner the unfold can outlast any fixed wait.
    await controls.evaluate((row) => Promise.all(row.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    await expect(controls.getByRole("button", { name: "Free" })).toBeVisible();
    const reachedPlay = await play.boundingBox();
    expect(Math.abs(reachedPlay!.x - restingPlay!.x), "Play does not move as the reach controls come").toBeLessThan(1);
    expect(Math.abs(reachedPlay!.x + reachedPlay!.width / 2 - viewport.width / 2), "Play holds the middle").toBeLessThan(2);
    const spacing = await controls.evaluate((row) => [...row.querySelectorAll("button")].map((button) => button.getBoundingClientRect()).sort((a, b) => a.x - b.x));
    for (let index = 1; index < spacing.length; index += 1) {
      expect(spacing[index]!.x - (spacing[index - 1]!.x + spacing[index - 1]!.width), "no two controls crowd").toBeGreaterThanOrEqual(tokens.glyph.gap - 0.5);
    }
    await shot(page, `${label}-feed-reached`);

    // The halo is a 3D cloche over the hologram, in its world space, and no 2D edge or shade is drawn on the page.
    await expect(page.locator(".feed-card-edge, .feed-card-shade")).toHaveCount(0);
    const cloche = await readCloche(page, first.url);
    expect(cloche.drawn, "the focused hologram has its cloche").toBe(true);
    expect(cloche.opacity, "seen from outside, the cloche is fully drawn").toBeGreaterThan(0.99);
    expect(cloche.radii.y, "the cloche has volume").toBeGreaterThan(0);
    expect(cloche.embers, "embers burn in the globe's surface").toBe(tokens.edge.cloche.emberCount);
    expect(cloche.sparks, "the hologram in focus sheds sparks").toBe(tokens.motion.sparks.countFlat);
    await expect(card).toHaveAttribute("data-card-focus", "true");

    await page.getByRole("button", { name: "Upload a hologram" }).click();
    await page.waitForTimeout(500);
    await shot(page, `${label}-upload-sheet`);
    const sheet = page.getByRole("dialog", { name: "Upload a hologram" });
    await expect(sheet).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox!.width, "the sheet is at most 26rem wide and never wider than the screen").toBeLessThanOrEqual(Math.min(viewport.width, 26 * 16) + 0.5);
    // The file picker is the styled drop zone; the native input stays for the label and for tests.
    await expect(sheet.locator("label.upload-drop[for='glb-upload']")).toBeVisible();
    await expect(sheet.getByRole("switch", { name: "iOS Quick Look" })).not.toBeChecked();
    await sheet.getByText("iOS Quick Look").click();
    await expect(sheet.getByRole("switch", { name: "iOS Quick Look" })).toBeChecked();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
  });
}

test("desktop: the globe burns in its own deeper colours, not the chrome's, and blends them unconverted", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openFeed(page);
  await readCloche(page, first.url);
  // The approved globe drew each chrome colour's linear values as sRGB; its
  // own tokens hold what that put on screen (styleguide 3.4). A part that
  // reads the chrome's token, or converts its own again, draws another colour.
  const drawn = await page.evaluate((key) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { scene: Three.Scene }> }).__portalProbes;
    const scene = probes[key]!.scene;
    const hex = (colour: Three.Color) => "#" + [colour.r, colour.g, colour.b].map((value) => Math.round(value * 255).toString(16).padStart(2, "0")).join("");
    const material = (name: string) => (scene.getObjectByName(name) as Three.Mesh<Three.BufferGeometry, Three.ShaderMaterial>).material;
    const parts = ["cloche-shell", "cloche-embers", "cloche-sparks"].map((name) => {
      const uniforms = material(name).uniforms;
      return {
        glow: hex(uniforms.uGlow!.value), core: hex(uniforms.uCore!.value), highlight: hex(uniforms.uHighlight!.value),
        char: hex(uniforms.uChar!.value), ember: hex(uniforms.uEmber!.value)
      };
    });
    const names = ["cloche-shell", "cloche-embers", "cloche-sparks", "cloche-shade"];
    return {
      parts,
      shade: hex(material("cloche-shade").uniforms.uShade!.value),
      converted: names.filter((name) => /colorspace_fragment|linearToOutputTexel|sRGBTransfer/.test(material(name).fragmentShader))
    };
  }, first.url);
  const { glow, core, highlight, char, ember, shade } = tokens.edge.cloche.colors;
  for (const part of drawn.parts) expect(part).toEqual({ glow, core, highlight, char, ember });
  expect(drawn.shade).toBe(shade);
  expect(core, "the globe's gold is not the chrome's").not.toBe(tokens.edge.core.color);
  expect(drawn.converted, "no part converts its colours on output").toEqual([]);
});

test("phone: reduced motion holds the cloche still and keeps the controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(PHONE);
  await openFeed(page);
  const before = await readCloche(page, first.url);
  await page.waitForTimeout(500);
  const after = await readCloche(page, first.url);
  expect(before.drawn).toBe(true);
  expect(after.core, "no flicker under reduced motion").toBeCloseTo(before.core, 5);
  expect(after.sparks, "no sparks under reduced motion").toBe(0);
  expect(after.time, "no drift, flicker or breath").toBe(0);
  // Reduced motion keeps only the slow resting fade (8.3), never the flicker's swing.
  expect(Math.abs(after.glow - before.glow), "no flicker in the glow").toBeLessThan(0.02);
  await expect(page.locator(`.feed-card[data-card-id="${first.id}"] .portal-controls`).getByRole("button", { name: new RegExp(`^(${CONTROL_NAMES.play}|${CONTROL_NAMES.pause})$`) })).toBeVisible();
});

/** A tenth of a second of silence as a 16-bit mono WAV. */
function silentWav(): Buffer {
  const rate = 8000;
  const samples = rate / 10;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

/** The avatar with a KHR_audio track, as a capture with a voice exports it, so the card shows its sound control. */
async function avatarWithSound(): Promise<Buffer> {
  const glb = await readFile(avatarGlb);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as {
    buffers: { byteLength: number }[];
    bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  const binStart = 20 + jsonLength + 8;
  const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLength));
  const wav = silentWav();
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: wav.length });
  json.extensions = { ...json.extensions, KHR_audio: { audio: [{ bufferView: json.bufferViews.length - 1, mimeType: "audio/wav" }], sources: [{ audio: 0, loop: true }] } };
  json.extensionsUsed = [...(json.extensionsUsed ?? []), "KHR_audio"];
  const pad = (bytes: Buffer, fill: number) => Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4, fill)]);
  const newBin = pad(Buffer.concat([bin, wav]), 0);
  json.buffers[0]!.byteLength = newBin.length;
  const newJson = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + newJson.length + 8 + newBin.length, 8);
  const chunk = (type: number, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, newJson), chunk(0x004e4942, newBin)]);
}

test.describe("phone by touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE });

  test("every reach control fits the screen at the touch minimum, clear of the gesture edges", async ({ page }) => {
    const sounding = await avatarWithSound();
    await installProbe(page);
    await mockFeed(page);
    await page.route(`**${first.url}`, (route) => route.fulfill({ body: sounding, contentType: "model/gltf-binary" }));
    await page.goto("/");
    await assertViewerShell(page);
    await waitForPortalReady(page, first.id, first.url);
    await scrollFeedToTop(page);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch phone has a coarse pointer").toBe(true);
    const card = page.locator(`.feed-card[data-card-id="${first.id}"]`);
    const controls = card.locator(".portal-controls");
    const play = controls.getByRole("button", { name: new RegExp(`^(${CONTROL_NAMES.play}|${CONTROL_NAMES.pause})$`) });
    const restingPlay = (await play.boundingBox())!;
    await card.locator(".feed-card-portal").tap({ force: true });
    await expect(controls).toHaveAttribute("data-reach", "shown");
    await expect(controls.getByRole("button", { name: /^(Mute|Unmute) audio$/ }), "a take with a voice has its sound control").toHaveCount(1);
    await page.waitForTimeout(400);
    await shot(page, "phone-touch-feed-reached");
    const boxes = await controls.evaluate((row) =>
      [...row.querySelectorAll("button")].map((button) => ({ name: button.getAttribute("aria-label"), ...button.getBoundingClientRect().toJSON() as DOMRect }))
    );
    expect(boxes.length, "the reach row shows more than Play").toBeGreaterThan(2);
    const { side, bottom } = { side: tokens.hit.phoneSideEdge, bottom: tokens.hit.phoneHomeBar };
    for (const box of boxes) {
      expect(box.width, `${box.name}: the touch minimum`).toBeGreaterThanOrEqual(hitAreaApx("touch", 0) - 0.5);
      expect(box.height, `${box.name}: the touch minimum`).toBeGreaterThanOrEqual(hitAreaApx("touch", 0) - 0.5);
      expect(box.x, `${box.name}: clear of the left back-swipe edge`).toBeGreaterThanOrEqual(side - 0.5);
      expect(box.x + box.width, `${box.name}: clear of the right back-swipe edge`).toBeLessThanOrEqual(PHONE.width - side + 0.5);
      expect(box.y + box.height, `${box.name}: clear of the home bar`).toBeLessThanOrEqual(PHONE.height - bottom + 0.5);
    }
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const apart = a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;
        expect(apart, `${a.name} and ${b.name} do not overlap`).toBe(true);
      }
    }
    // Too many for one row beside Play, so they unfold above it, on the chip, and Play holds still.
    await expect(card.locator(".feed-card-foot")).toHaveAttribute("data-reach-row", "stacked");
    const reachedPlay = (await play.boundingBox())!;
    expect(Math.abs(reachedPlay.x - restingPlay.x) + Math.abs(reachedPlay.y - restingPlay.y), "Play does not move").toBeLessThan(1);
    expect(Math.abs(reachedPlay.x + reachedPlay.width / 2 - PHONE.width / 2), "Play holds the middle").toBeLessThan(2);
    const line = await controls.locator(".portal-controls-after").evaluate((node) => ({ box: node.getBoundingClientRect().toJSON() as DOMRect, background: getComputedStyle(node).backgroundColor }));
    expect(line.box.y + line.box.height, "the reach line is above Play").toBeLessThanOrEqual(reachedPlay.y);
    // Over the picture the row is on a chip and the reach line takes the same one; over the ground both are bare.
    const chip = card.locator(".feed-card-foot-chip");
    const chipBackground = (await chip.count()) > 0 ? await chip.evaluate((node) => getComputedStyle(node).backgroundColor) : "rgba(0, 0, 0, 0)";
    expect(line.background, "the reach line is on the row's own surface").toBe(chipBackground);
    expect(line.box.y + line.box.height, "the row ends above 75% down").toBeLessThanOrEqual(PHONE.height * 0.75);

    // Looking around, moved in: the row is over the hologram's own picture, so it and the reach line take the chip, and Return joins Play.
    await controls.getByRole("button", { name: "Free" }).tap();
    const portalBox = (await card.locator(".feed-card-portal").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await touchPinch(page, cdp, { x: portalBox.x + portalBox.width / 2, y: portalBox.y + portalBox.height / 2 }, 60, 260);
    await expect.poll(async () => (await readPortal(page, first.url)).zoom).toBeLessThan(0.9);
    await expect(chip).toHaveCount(1);
    await card.locator(".feed-card-portal").tap({ force: true });
    await expect(controls).toHaveAttribute("data-reach", "shown");
    await expect(controls.getByRole("button", { name: CONTROL_NAMES.returnToAuthorView })).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "phone-touch-free-reached");
    const overPicture = await controls.locator(".portal-controls-after").evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(overPicture, "over the picture the reach line takes the same chip").toBe(await chip.evaluate((node) => getComputedStyle(node).backgroundColor));
    expect(overPicture).not.toBe("rgba(0, 0, 0, 0)");
    const freePlay = (await play.boundingBox())!;
    expect(Math.abs(freePlay.x + freePlay.width / 2 - PHONE.width / 2), "Play still holds the middle beside Return").toBeLessThan(2);
    for (const button of await controls.locator("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.x + box.width, "clear of the right back-swipe edge").toBeLessThanOrEqual(PHONE.width - side + 0.5);
      expect(box.x).toBeGreaterThanOrEqual(side - 0.5);
    }
  });
});

// The server error is the case under test, so the browser's own line for the
// 500 is expected; any other runtime error still fails, as in ./bootstrap.
plainTest("phone: feed-wide notices sit on the chip", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" || /status of 500/.test(message.text())) return;
    runtimeErrors.push(`console.error: ${message.text()}`);
  });
  await page.setViewportSize(PHONE);
  const chipBackground = (selector: string) => page.locator(`${selector} .feed-notice-chip`).evaluate((chip) => getComputedStyle(chip).backgroundColor);
  const expected = `${Math.round(chipOpacity(VIEW_TARGETS.phone)! * 100) / 100}`;

  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto("/");
  await expect(page.locator('[data-notice="empty"]')).toBeVisible();
  expect(await chipBackground('[data-notice="empty"]'), "the empty feed's notice is on the phone chip").toContain(expected);
  await shot(page, "phone-notice-empty");

  await page.unroute("**/api/holograms?*");
  await page.route("**/api/holograms?*", (route) => route.fulfill({ status: 500, json: { error: "The server is having a moment." } }));
  await page.reload();
  const error = page.locator('[data-notice="error"]');
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error.getByRole("button", { name: "Try again" })).toBeVisible();
  await shot(page, "phone-notice-error");

  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator('[data-notice="offline"]')).toBeVisible();
  await shot(page, "phone-notice-offline");
  await page.context().setOffline(false);
  // The reload and going offline cut IWER's room off its CDN mid-load: the
  // test's own doing, not the viewer's.
  const cutOff = /^console\.error: Error loading environment \S+ from CDN TypeError: Failed to fetch/;
  expect(runtimeErrors.filter((entry) => !cutOff.test(entry)), "viewer runtime errors").toEqual([]);
});

// ── The WebXR AR route under IWER (a Quest 3 in emulation) ──

type ArProbe = { renderer: Three.WebGLRenderer; scene: Three.Scene; model: Three.Object3D };
type ArWindow = Window & { __HOLOIM_AR_TEST_OBSERVER__?: (value: ArProbe) => void; __arProbe?: ArProbe };
type IwerVector = { set: (...values: number[]) => void; x: number; y: number; z: number };
type IwerPosed = { position: IwerVector; quaternion: IwerVector & { w: number } };
type IwerController = IwerPosed & { updateButtonValue: (id: string, value: number) => void };
type IwerDevice = IwerPosed & { controlMode: string; controllers: Record<"left" | "right", IwerController> };

/** Aims the right controller from the head at a chrome glyph (by its accessible name) and pulls the trigger. */
async function selectInRoom(page: Page, label: string): Promise<void> {
  await page.evaluate(async (name) => {
    const { Vector3, Quaternion, Matrix4 } = await import("/node_modules/.vite/deps/three.js") as typeof Three;
    const probe = (window as ArWindow).__arProbe!;
    let hit: Three.Object3D | undefined;
    probe.scene.traverse((object) => {
      if (object.userData.label === name && object.layers.mask !== 0) hit = object;
    });
    if (!hit) throw new Error(`${name} is not in the room.`);
    const at = hit.getWorldPosition(new Vector3());
    const device = (window as unknown as { IWER_DEVICE: IwerDevice }).IWER_DEVICE;
    // The ray starts at the head: aimed in the scene's space, placed in IWER's.
    const from = probe.renderer.xr.getCamera().getWorldPosition(new Vector3());
    const look = new Matrix4().lookAt(from, at, new Vector3(0, 1, 0));
    const turn = new Quaternion().setFromRotationMatrix(look);
    device.controlMode = "programmatic";
    const controller = device.controllers.right;
    controller.position.set(device.position.x, device.position.y, device.position.z);
    controller.quaternion.set(turn.x, turn.y, turn.z, turn.w);
  }, label);
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as unknown as { IWER_DEVICE: IwerDevice }).IWER_DEVICE.controllers.right.updateButtonValue("trigger", 1));
  await page.waitForTimeout(150);
  await page.evaluate(() => (window as unknown as { IWER_DEVICE: IwerDevice }).IWER_DEVICE.controllers.right.updateButtonValue("trigger", 0));
  await page.waitForTimeout(150);
}

test("left-handed, set in the feed's settings: kept on this device, and AR puts Exit on the right wrist", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.addInitScript(() => {
    (window as ArWindow).__HOLOIM_AR_TEST_OBSERVER__ = (value) => { (window as ArWindow).__arProbe = value; };
  });
  await mockFeed(page, [first]);
  await observeFeedCardRenderer(page);
  await page.goto("/");
  await waitForFeedCardPresented(page);

  await page.getByRole("button", { name: "Settings" }).click();
  const sheet = page.getByRole("dialog", { name: "Settings" });
  await expect(sheet.getByRole("radio", { name: "Right-handed" }), "right-handed by default").toHaveAttribute("aria-checked", "true");
  await sheet.getByRole("radio", { name: "Left-handed" }).click();
  await expect(sheet.getByText("Left-handed: in a headset, Exit AR sits on your right wrist.")).toBeVisible();
  await shot(page, "settings-left-handed");
  await page.reload();
  await waitForFeedCardPresented(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: "Left-handed" }), "kept across a reload").toHaveAttribute("aria-checked", "true");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);

  await pressViewInAr(page);
  const container = page.locator(".xr-view-container");
  await expect(container).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await container.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await expect.poll(() => page.evaluate(() => {
    const dock = (window as { __HOLOIM_XR_VIEWER__?: { snapshot(): { controls: { dock: { mount: string; hand: string | null } } | null } } }).__HOLOIM_XR_VIEWER__?.snapshot().controls?.dock;
    return dock ? { mount: dock.mount, hand: dock.hand } : null;
  }), { message: "Exit on the non-dominant (right) hand", timeout: 15_000 }).toEqual({ mount: "hand", hand: "right" });
});

// The R3F view, kept behind `?shell=r3f` while the IWSDK shell becomes the
// default; xr-viewer.spec.ts covers the same controls there.
test("AR (R3F fallback): controls at the hologram's foot on the chip, Exit always reachable, true scale and a labelled rescale", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.addInitScript(() => {
    (window as ArWindow).__HOLOIM_AR_TEST_OBSERVER__ = (value) => { (window as ArWindow).__arProbe = value; };
  });
  await mockFeed(page, [first]);
  await observeFeedCardRenderer(page);
  await page.goto("/?shell=r3f");
  await waitForFeedCardPresented(page);
  await pressViewInAr(page);
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  const view = page.locator(".ar-view-container");

  // Exit is there from the first frame, before anything is placed.
  await expect(page.getByRole("button", { name: "Exit AR" })).toBeAttached();
  await page.waitForFunction(() => Boolean((window as ArWindow).__arProbe));
  await expect.poll(() => view.getAttribute("data-placement-stage")).toMatch(/placed|anchored|locked/);
  await page.waitForTimeout(500);

  const room = await page.evaluate(() => {
    const probe = (window as ArWindow).__arProbe!;
    const xrCamera = probe.renderer.xr.getCamera();
    const chrome: Array<{ name: string; headLocked: boolean }> = [];
    const chips: number[] = [];
    probe.scene.traverse((object) => {
      if (object.userData.holoimChrome !== true) return;
      let ancestor: Three.Object3D | null = object;
      let headLocked = false;
      while (ancestor) {
        if ((ancestor as Three.Camera).isCamera || ancestor === xrCamera) headLocked = true;
        ancestor = ancestor.parent;
      }
      if (typeof object.userData.label === "string") chrome.push({ name: object.userData.label, headLocked });
      if (object.name === "chip" && (object as Three.Mesh).isMesh) chips.push(((object as Three.Mesh).material as Three.Material).opacity);
    });
    const light = probe.scene.getObjectByName("ar-stage-light") as Three.PointLight | undefined;
    return {
      modelScale: probe.model.parent!.scale.x,
      chrome,
      chips,
      wristVisible: probe.scene.getObjectByName("wrist-glyphs-left")?.visible ?? false,
      stageLight: light?.intensity ?? null,
      cameraChildren: xrCamera.children.length
    };
  });
  expect(room.modelScale, "the hologram opens at true scale").toBe(1);
  expect(room.chrome.map((entry) => entry.name)).toEqual(expect.arrayContaining([CONTROL_NAMES.pause, "Exit AR"]));
  expect(room.chrome.filter((entry) => entry.headLocked), "no control follows the head").toEqual([]);
  const target = await view.getAttribute("data-ar-target");
  expect(target, "IWER's Quest 3 is a headset").toBe("headset");
  const compositor = arCompositorFromUserAgent(await page.evaluate(() => navigator.userAgent));
  const expectedChip = chipOpacity({ kind: "ar", compositor, headset: true })!;
  expect(room.chips.length, "the foot row sits on the chip").toBeGreaterThan(0);
  for (const opacity of room.chips) expect(opacity, "every row is on the chip at the target's opacity").toBeCloseTo(expectedChip, 2);
  expect(room.wristVisible, "Exit is on the non-dominant wrist").toBe(true);
  expect(room.stageLight, "the stage light rests steady in a room").toBeCloseTo(tokens.motion.flicker.stageLightRest, 5);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => ((window as ArWindow).__arProbe!.scene.getObjectByName("ar-stage-light") as Three.PointLight).intensity)).toBe(room.stageLight);
  await shot(page, "ar-headset-foot");

  // Play and Pause work from the room: a controller ray at the foot row.
  await selectInRoom(page, CONTROL_NAMES.pause);
  await expect(view).toHaveAttribute("data-ar-paused", "true");
  await selectInRoom(page, CONTROL_NAMES.play);
  await expect(view).toHaveAttribute("data-ar-paused", "false");

  // A pinch rescales, the label says by how much, and the glyph beside it goes back.
  await pinch(page, 200, 100);
  await expect(view).not.toHaveAttribute("data-ar-scale", "1");
  await expect(view).toHaveAttribute("data-ar-scale-label", /^1:/);
  expect(await page.evaluate(() => (window as ArWindow).__arProbe!.model.parent!.scale.x)).toBeLessThan(1);
  await page.waitForTimeout(300);
  await shot(page, "ar-headset-rescaled");
  await selectInRoom(page, "Return to true size");
  await expect(view).toHaveAttribute("data-ar-scale", "1");
  await expect(view).toHaveAttribute("data-ar-scale-label", "");

  // Looking away: the wrist and the dock still hold Exit.
  await page.evaluate(() => {
    const device = (window as unknown as { IWER_DEVICE: IwerDevice }).IWER_DEVICE;
    device.controlMode = "programmatic";
    device.quaternion.set(0, 1, 0, 0);
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as ArWindow).__arProbe!.scene.getObjectByName("wrist-glyphs-left")?.visible)).toBe(true);
  await page.evaluate(() => (document.querySelector('button[aria-label="Exit AR"]') as HTMLButtonElement).click());
  await waitForNoIwerSession(page);
  await expect(page).toHaveURL(/\/$/);
});
