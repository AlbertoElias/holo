import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { devices, type Browser, type BrowserContextOptions, type Locator, type Page } from "@playwright/test";
import { createXrContext, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { CLOTHING, EYES, HAIR_COLOUR, SKIN, linear, type Finish, type LookCard } from "../../../packages/avatar-look/src/index.ts";
import { expect, test } from "./bootstrap";
import { readGlbJson } from "./pipeline-takes";
import { installProbe, waitForPortalReady } from "./portal-helpers";

// Your look on a phone (docs/features/your-look.md): the house avatar's look
// is set in capture before a take, changes the live avatar without a reload,
// and the posted hologram wears it. The capture link from the feed carries no
// query, so an init script on the capture origin adds `?avatar=` for the
// house base (it is not the default avatar yet). Screenshots and numbers land
// in output/test-results/your-look/.

const HOUSE_BASE = "/gltf/models/house-base.glb";
const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const captureOrigin = new URL(captureUrl).origin;
const outDir = path.resolve(import.meta.dirname, "../../../output/test-results/your-look");
const takesDir = path.join(outDir, "takes");
const TAKE_SECONDS = 2;

type HouseLook = { look: LookCard; finish: Finish };
type HouseLookSample = { look: HouseLook | null; meshes: string[]; skeletons: number; jawOpen: number[]; lastChangeMs: number | null; fitErrorMm: number | null; memory: { geometries: number; textures: number } };
type LookHooks = {
  __sampleHouseLook: () => HouseLookSample;
  __setHouseLook: (next: HouseLook) => Promise<boolean>;
  render_game_to_text: () => string;
};
type PostedGltf = {
  nodes?: Array<{ name?: string; mesh?: number; skin?: number; extras?: Record<string, unknown> }>;
  scenes?: Array<{ extras?: Record<string, unknown> }>;
  skins?: Array<{ joints: number[] }>;
  materials?: Array<{ name?: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
  animations?: Array<{ channels: Array<{ sampler: number; target: { path: string } }>; samplers: Array<{ output: number }> }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
};

/** The float values of one accessor, read from the GLB's binary chunk (tightly packed, as the exporter writes them). */
function readFloats(bytes: Buffer, gltf: PostedGltf, accessorIndex: number): Float32Array {
  const accessor = gltf.accessors![accessorIndex]!;
  expect(accessor.componentType, "morph weights are floats").toBe(5126);
  const view = gltf.bufferViews![accessor.bufferView!]!;
  expect(view.byteStride ?? 4, "packed weights").toBe(4);
  const binStart = 20 + bytes.readUInt32LE(12) + 8;
  const start = binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float32Array(accessor.count * (accessor.type === "SCALAR" ? 1 : Number(accessor.type.slice(3))));
  for (let i = 0; i < out.length; i += 1) out[i] = bytes.readFloatLE(start + i * 4);
  return out;
}

async function report(name: string, value: unknown): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

const sampleLook = (page: Page) => page.evaluate(() => (window as unknown as LookHooks).__sampleHouseLook());
// The fitted height, not a world position: the idle motion sways the head by millimetres.
const fittedHeight = (page: Page) =>
  page.evaluate(() => (JSON.parse((window as unknown as LookHooks).render_game_to_text()) as { heightAdaptation: { avatarHeight: number } }).heightAdaptation.avatarHeight);

/** Capture opened from the feed loads the house base: the link carries no query, so this adds `?avatar=` before the app reads it. */
async function openCaptureOnHouseBase(page: Page): Promise<void> {
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

async function signInToCapture(page: Page, who: string): Promise<void> {
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

const lookPanel = (page: Page) => page.getByTestId("look-panel");

/** A tap on a touch screen and a click with a mouse, as a person would use each. */
async function press(target: Locator): Promise<void> {
  const touch = await target.page().evaluate(() => navigator.maxTouchPoints > 0);
  await (touch ? target.tap() : target.click());
}

/** Taps one choice in the look panel and waits for the live avatar to wear it. */
async function choose(page: Page, row: string, option: string): Promise<void> {
  const choice = lookPanel(page).getByRole("radiogroup", { name: row }).getByRole("radio", { name: option, exact: true });
  await choice.scrollIntoViewIfNeeded();
  await press(choice);
  await expect(choice).toHaveAttribute("aria-checked", "true");
  await expect(lookPanel(page)).toHaveAttribute("data-look-status", "ready", { timeout: 30_000 });
}

/** Records a short take and posts it; returns the new hologram's id and model URL. */
async function recordAndPost(page: Page): Promise<{ id: string; url: string }> {
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

const near = (actual: number[] | undefined, expected: readonly number[], what: string): void => {
  expect(actual, what).toBeDefined();
  expected.forEach((value, i) => expect(Math.abs(actual![i]! - value), `${what} [${i}]`).toBeLessThan(2e-3));
};

/** The posted file wears the look: only its hair and glasses, one skeleton, its colours, its card in the extras, and face tracks. */
async function checkPostedGlb(page: Page, url: string, want: HouseLook): Promise<{ bytes: number; body: Buffer }> {
  const response = await page.request.get(url);
  expect(response.ok(), "posted GLB readable").toBe(true);
  const bytes = await response.body();
  const gltf = readGlbJson(bytes) as unknown as PostedGltf;
  const names = (gltf.nodes ?? []).map((node) => node.name ?? "");
  const hair = new Set(names.flatMap((name) => /^Hair_([a-zA-Z]+)/.exec(name)?.[1] ?? []));
  const glasses = new Set(names.flatMap((name) => /^Glasses_([a-zA-Z]+)/.exec(name)?.[1] ?? []));
  expect([...hair], "only the chosen hair").toEqual([want.look.hair.style]);
  expect([...glasses], "only the chosen glasses").toEqual(want.look.glasses === "none" ? [] : [want.look.glasses]);
  // The exporter writes a skin per skinned mesh; one skeleton means every skin uses the same joint nodes, and no bone is there twice.
  const skins = gltf.skins ?? [];
  expect(skins.length, "skinned meshes").toBeGreaterThan(0);
  for (const skin of skins) expect(skin.joints, "every skin uses the one skeleton's joints").toEqual(skins[0]!.joints);
  const boneNames = skins[0]!.joints.map((joint) => names[joint]);
  expect(new Set(boneNames).size, "each bone once").toBe(boneNames.length);
  expect(names.filter((name) => boneNames.includes(name)).length, "no second copy of a bone").toBe(boneNames.length);
  // No leftover meshes: a second body, or an old hair under a new name, would repeat a mesh node's name.
  const meshNames = (gltf.nodes ?? []).filter((node) => node.mesh !== undefined).map((node) => node.name ?? "");
  expect(meshNames.filter((name, i) => meshNames.indexOf(name) !== i), "each mesh node once").toEqual([]);

  const records = [...(gltf.nodes ?? []).map((node) => node.extras), ...(gltf.scenes ?? []).map((scene) => scene.extras)]
    .map((extras) => extras?.holoimAvatar)
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as { name?: string; look?: LookCard; finish?: Finish });
  const record = records.find((entry) => entry.name === "house-base");
  expect(record, "the avatar's holoimAvatar extras").toBeDefined();
  expect(record!.look, "the card in the extras").toEqual(want.look);
  expect(record!.finish ?? "clay", "the finish in the extras").toBe(want.finish);

  const material = (name: string) => gltf.materials?.find((entry) => entry.name === name);
  if (want.finish === "clay") {
    // Clay keeps the card's colours as they are; ink flattens them and light pales them.
    near(material("HouseBase_skin")?.pbrMetallicRoughness?.baseColorFactor, linear(SKIN[want.look.skin]), "skin colour");
    near(material("HouseBase_eye_iris")?.pbrMetallicRoughness?.baseColorFactor, linear(EYES[want.look.eyes]), "iris colour");
    near(material("HouseBase_hair")?.pbrMetallicRoughness?.baseColorFactor, linear(HAIR_COLOUR[want.look.hair.colour]), "hair colour");
    near(material("HouseBase_top")?.pbrMetallicRoughness?.baseColorFactor, linear(CLOTHING[want.look.clothing].top), "top colour");
    near(material("HouseBase_trousers")?.pbrMetallicRoughness?.baseColorFactor, linear(CLOTHING[want.look.clothing].trousers), "trousers colour");
  }
  if (want.finish === "ink") expect(material("HouseBase_ink"), "the ink line material").toBeDefined();
  if (want.finish === "light") expect(material("HouseBase_top")?.alphaMode, "light garments are see-through").toBe("BLEND");
  const morphTracks = (gltf.animations ?? []).flatMap((animation) => animation.channels).filter((channel) => channel.target.path === "weights");
  expect(morphTracks.length, "face morph tracks").toBeGreaterThan(0);
  // The take was recorded with the jaw open and a smile, so the tracks must move: all-zero weights would mean the recorder held removed meshes.
  const animation = (gltf.animations ?? []).find((entry) => entry.channels.some((channel) => channel.target.path === "weights"))!;
  const peak = Math.max(
    ...animation.channels.filter((channel) => channel.target.path === "weights").map((channel) => Math.max(...readFloats(bytes, gltf, animation.samplers[channel.sampler]!.output)))
  );
  expect(peak, "the face morph tracks carry the face").toBeGreaterThan(0.3);
  return { bytes: bytes.length, body: bytes };
}

/** The new hologram's feed card, rendered: the screenshot the brief asks for. */
async function shootFeedCard(page: Page, id: string, url: string, name: string): Promise<void> {
  await installProbe(page);
  await page.goto("/");
  const card = page.locator(`.feed-card[data-card-id="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await waitForPortalReady(page, id, new URL(url, page.url()).pathname);
  await mkdir(outDir, { recursive: true });
  await card.screenshot({ path: path.join(outDir, `${name}.png`) });
}

type Journey = {
  name: string;
  device: BrowserContextOptions;
  finish: Finish;
  /** The panel taps, in order: [row, choice]. */
  taps: Array<[string, string]>;
  want: (start: LookCard) => LookCard;
};

const phone = { ...devices["Pixel 7"] };
const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };

const journeys: Journey[] = [
  {
    // Clay to ink, then a build change: the live meshes all change, and the take must still carry one skeleton and the face.
    name: "phone-ink",
    device: phone,
    finish: "ink",
    taps: [["Finish", "Ink"], ["Build", "Broad"], ["Hair", "High bun"], ["Hair colour", "Copper"], ["Glasses", "Round"]],
    want: (start) => ({ ...start, build: "broad", hair: { style: "highBun", colour: "copper" }, glasses: "round" })
  },
  {
    name: "phone-light",
    device: phone,
    finish: "light",
    taps: [["Finish", "Light"], ["Skin", "Umber"], ["Clothes", "Rust and walnut"]],
    want: (start) => ({ ...start, skin: "umber", clothing: "rustWalnut" })
  },
  {
    name: "desktop-clay",
    device: desktop,
    finish: "clay",
    taps: [["Build", "Slight"], ["Hair", "Wavy bob"], ["Eyes", "Moss green"], ["Glasses", "Square"]],
    want: (start) => ({ ...start, build: "slight", hair: { ...start.hair, style: "wavyBob" }, eyes: "mossGreen", glasses: "square" })
  }
];

async function runJourney(browser: Browser, baseURL: string | undefined, journey: Journey): Promise<void> {
  const context = await createXrContext(browser, { ...journey.device, baseURL });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
    await openCaptureOnHouseBase(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await signInToCapture(page, `Look ${journey.name}`);

    if (journey.device === desktop) {
      // Desktop is not the selfie journey: the panel waits for the Look control.
      await expect(page.getByTestId("dock-look")).toHaveAttribute("aria-expanded", "false");
      await expect(lookPanel(page)).toBeHidden();
      await press(page.getByTestId("dock-look"));
    }
    // First visit in the selfie journey: the panel opens by itself, before the first Record.
    await expect(lookPanel(page), "the look panel opens before the first Record").toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("dock-look")).toHaveAttribute("aria-expanded", "true");
    const start = await sampleLook(page);
    expect(start.look, "the house base has a look").not.toBeNull();
    await mkdir(outDir, { recursive: true });
    await page.screenshot({ path: path.join(outDir, `${journey.name}-panel.png`) });

    for (const [row, option] of journey.taps) await choose(page, row, option);
    const want: HouseLook = { look: journey.want(start.look!.look), finish: journey.finish };
    const live = await sampleLook(page);
    expect(live.look, "the live avatar wears the picked look").toEqual(want);
    expect(live.skeletons, "one skeleton").toBe(1);
    expect(live.meshes, "the chosen hair on the live avatar").toContain(`Hair_${want.look.hair.style}`);
    expect(live.meshes.filter((name) => name.startsWith("Hair_")), "one hair mesh").toHaveLength(1);
    expect(live.meshes.filter((name, i) => live.meshes.indexOf(name) !== i), "no leftover meshes on the live avatar").toEqual([]);
    if (want.look.glasses !== "none") expect(live.meshes).toContain(`Glasses_${want.look.glasses}`);
    expect(live.fitErrorMm, "a new build fits the live bones").toBeLessThan(3);
    expect(page.url(), "no page reload: the grant is still in memory").not.toContain("#post=");
    await page.screenshot({ path: path.join(outDir, `${journey.name}-dressed.png`) });

    const posted = await recordAndPost(page);
    const glb = await checkPostedGlb(page, posted.url, want);
    expect(glb.bytes, "under the upload cap").toBeLessThan(100 * 1024 * 1024);
    // Phone posts have Quick Look off, so the converter runs on this file by hand: apps/viewer-api/tools/check_usdz_tools.sh.
    await mkdir(takesDir, { recursive: true });
    await writeFile(path.join(takesDir, `${journey.name}.glb`), glb.body);
    await shootFeedCard(page, posted.id, posted.url, `${journey.name}-card`);
    expect(errors, "page errors").toEqual([]);
    await report(journey.name, { want, live: { ...live, look: undefined }, glbBytes: glb.bytes, id: posted.id });
  } finally {
    await context.close();
  }
}

test.describe("your look", () => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture server.");

  for (const journey of journeys) {
    test(`${journey.name}: the look set in capture is worn by the posted hologram`, async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      await runJourney(browser, testInfo.project.use.baseURL, journey);
    });
  }

  test("twelve look changes keep GPU memory flat, and the face drives the new meshes", async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await createXrContext(browser, { ...phone });
    try {
      const page = await context.newPage();
      await page.goto(`${captureUrl}?avatar=${HOUSE_BASE}`);
      await waitForTextContentPrefix(page, "#status", "loaded", { timeout: 60_000 });
      const start = await sampleLook(page);
      const base = start.look!;
      const finishes: Finish[] = ["ink", "light", "clay"];
      const builds = ["broad", "medium", "slight"] as const;
      const hairs = ["highBun", "sweptCrop", "tightCoils"] as const;
      const rows: Array<Omit<HouseLookSample, "look"> & { finish: Finish }> = [];
      for (let i = 0; i < 12; i += 1) {
        const next: HouseLook = { finish: finishes[i % 3]!, look: { ...base.look, build: builds[i % 3]!, hair: { ...base.look.hair, style: hairs[i % 3]! } } };
        expect(await page.evaluate((look) => (window as unknown as LookHooks).__setHouseLook(look), next)).toBe(true);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const { look: _look, ...sample } = await sampleLook(page);
        rows.push({ ...sample, finish: next.finish });
      }
      // Each finish has its own fixed count (ink adds line primitives); the last lap must equal the first.
      for (let i = 9; i < 12; i += 1) expect(rows[i]!.memory, `memory after change ${i + 1} equals change ${i - 8}`).toEqual(rows[i - 9]!.memory);
      expect(rows[11]!.memory, "back in clay, memory is as it was at load").toEqual(start.memory);
      for (const row of rows) {
        expect(row.skeletons).toBe(1);
        expect(row.fitErrorMm).toBeLessThan(3);
        expect(row.meshes.filter((name, i) => row.meshes.indexOf(name) !== i), "no leftover meshes").toEqual([]);
      }

      const face = await page.evaluate(async () => {
        const hooks = window as unknown as LookHooks & { __setFaceInput: (s: unknown) => void };
        hooks.__setFaceInput({ weights: { jawOpen: 0.6 } });
        for (let i = 0; i < 10; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
        return hooks.__sampleHouseLook().jawOpen;
      });
      // Read from the meshes in the live tree, not from the face rig's own list, which could still hold removed meshes.
      expect(face.length, "the live meshes have a jaw").toBeGreaterThan(0);
      for (const value of face) expect(value, "the face drives the live jaw").toBeCloseTo(0.6, 3);
      await report("memory", { start: start.memory, rows });
    } finally {
      await context.close();
    }
  });

  test("the fitted height does not change with the hairstyle; a saved look loads in time; a bad ?look is only a warning", async ({ browser }) => {
    test.setTimeout(240_000);
    const load = async (query: string, saved?: HouseLook) => {
      const context = await createXrContext(browser, { ...phone });
      try {
        const page = await context.newPage();
        const warnings: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "warning" && message.text().startsWith("[look]")) warnings.push(message.text());
        });
        if (saved) await page.addInitScript((value) => window.localStorage.setItem("holoim.capture.look", value), JSON.stringify(saved));
        const started = Date.now();
        await page.goto(`${captureUrl}?avatar=${HOUSE_BASE}${query}`);
        await waitForTextContentPrefix(page, "#status", "loaded", { timeout: 60_000 });
        const seconds = (Date.now() - started) / 1000;
        return { seconds, look: (await sampleLook(page)).look, height: await fittedHeight(page), warnings };
      } finally {
        await context.close();
      }
    };

    const plain = await load("");
    const base = plain.look!;
    const byHair: Record<string, number> = {};
    for (const style of ["sweptCrop", "highBun", "tightCoils", "wavyBob"] as const) {
      const key = [base.look.build, base.look.skin, base.look.eyes, style, base.look.hair.colour, base.look.glasses, base.look.clothing].join("-");
      const loaded = await load(`&look=${key}`);
      expect(loaded.look?.look.hair.style, `?look=${key}`).toBe(style);
      byHair[style] = loaded.height;
    }
    // The fit scales the whole avatar from this height, so the eye (a bone) moves only if it moves.
    const tops = Object.values(byHair);
    expect(Math.max(...tops) - Math.min(...tops), "fitted height across hairstyles (m)").toBeLessThan(0.001);

    // A saved look that differs from the shipped one dresses the base at load; the best of two runs each, so one slow start does not decide.
    const saved: HouseLook = { finish: "ink", look: { ...base.look, build: "broad", hair: { style: "highBun", colour: "copper" } } };
    const withoutSaved = Math.min(plain.seconds, (await load("")).seconds);
    const savedRuns = [await load("", saved), await load("", saved)];
    expect(savedRuns[0]!.look, "the saved look loads").toEqual(saved);
    const withSaved = Math.min(...savedRuns.map((run) => run.seconds));
    expect(withSaved - withoutSaved, "a saved look adds at most 1.5 s to the load").toBeLessThan(1.5);

    const bad = await load("&look=medium-caramel-nope&finish=glitter");
    expect(bad.look, "a bad link falls back to the shipped look").toEqual(base);
    expect(bad.warnings.length, "each bad part warns").toBeGreaterThanOrEqual(2);
    await report("load-and-height", { byHair, withoutSavedSeconds: withoutSaved, withSavedSeconds: withSaved, badWarnings: bad.warnings });
  });
});
