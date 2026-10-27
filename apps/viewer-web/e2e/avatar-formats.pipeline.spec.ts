import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

// Source, not the package: the pipeline job does not build workspace packages.
import { readHumanoidDeclaration } from "../../../packages/meaning/src/index.ts";
import { launchXrBrowser, waitForIwerSession, waitForPageFunctions, waitForTextContentPrefix } from "@holoim/tooling-testing/xr-env";
import { CONTROL_NAMES } from "@holoim/xr-ui-core";

import { assertViewerShell, captureEvidence, expect, pressViewInAr, test } from "./bootstrap";

// Standard avatar formats (docs/features/avatar-formats.md): exports from
// avatars that are not Ready Player Me go through the real export → upload →
// render path, and the feed card and immersive AR find the author's bones
// and face the way the recording did.
// - unreal-cm: Unreal mannequin names at centimetre scale, so only the
//   export's HOLOIM_humanoid (or the shared name tables) can find its bones;
// - vrm0-minus-z: a VRM 0.x rig facing −Z, which capture turns by 180°; the
//   viewer must show it facing as recorded, judged by a numeric yaw.
// The same Unreal export without its HOLOIM_humanoid falls back to the name
// tables, and a pointing take on the Unreal rig proves HOLOIM_meaning's bone
// anchors (the author's fingertip) still resolve.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const captureRoot = path.resolve(import.meta.dirname, "../../capture");
const fixtureDir = path.join(captureRoot, "output/pipeline-avatars/fixtures");
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/avatar-formats-viewer");
const FIXTURES = ["unreal-cm", "vrm0-minus-z"] as const;
type FixtureName = (typeof FIXTURES)[number];
const YAW_TOLERANCE_DEG = 10;

type GltfJson = { nodes?: Array<{ name?: string }>; extensions?: Record<string, unknown>; extensionsUsed?: string[] };
type CaptureWindow = Window & {
  __sampleBody: () => { bones: Record<string, [number, number, number] | undefined> };
  advanceTime: (ms: number) => void;
};
/** What the viewer resolved on a loaded hologram, read the same way in the feed and in AR. */
type HumanoidReading = { source: string | undefined; hips: string | undefined; head: string | undefined; yawDeg: number | null; bones: number };
type FixtureFacts = { url: string; hips: string; head: string; declared: string | undefined };

function readGlbJson(bytes: Buffer): GltfJson {
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as GltfJson;
}

/** The same GLB with its JSON chunk replaced (padded with spaces, as the spec requires). */
function withGlbJson(bytes: Buffer, json: GltfJson): Buffer {
  const oldLength = bytes.readUInt32LE(12);
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4 !== 0) text += " ";
  const chunk = Buffer.from(text);
  const rest = bytes.subarray(20 + oldLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + chunk.length + rest.length, 8);
  header.writeUInt32LE(chunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk, rest]);
}

/** Yaw of the avatar's forward, from left-minus-right shoulders and hips: forward = lateral × up. */
function yawFromSides(pairs: Array<[number[] | undefined, number[] | undefined]>): number | null {
  let x = 0;
  let z = 0;
  for (const [left, right] of pairs) {
    if (!left || !right) continue;
    x += right[2]! - left[2]!;
    z += left[0]! - right[0]!;
  }
  return Math.hypot(x, z) < 1e-6 ? null : (Math.atan2(x, z) * 180) / Math.PI;
}

function yawDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

async function upload(page: Page, name: string, glb: Buffer): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `${name} ${Date.now()}`,
      submittedBy: "avatar-formats-e2e",
      file: { name: `${name}.glb`, mimeType: "model/gltf-binary", buffer: glb }
    }
  });
  expect(response.ok(), `upload ${name}: ${await response.text()}`).toBe(true);
  return (await response.json()) as { id: string; url: string };
}

/** The feed shows only this hologram, so its card is the one presented. */
async function showOnly(page: Page, id: string): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === id), nextCursor: null } });
  });
}

async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const hooks = window as unknown as {
      __feedProbes?: Record<string, unknown>;
      __arProbe?: unknown;
      __HOLOIM_FEED_TEST_OBSERVER__?: (probe: { url: string }) => void;
      __HOLOIM_AR_TEST_OBSERVER__?: (probe: unknown) => void;
    };
    hooks.__feedProbes = {};
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => { hooks.__feedProbes![probe.url] = probe; };
    hooks.__HOLOIM_AR_TEST_OBSERVER__ = (probe) => { hooks.__arProbe = probe; };
  });
}

/**
 * The bones the viewer tagged on the hologram (humanoidAnchors.ts) at the
 * recording's first frame, and the body's yaw in the hologram's own frame,
 * so the feed's camera or the AR placement does not count.
 */
async function readHumanoid(page: Page, where: { feedUrl: string } | "ar"): Promise<HumanoidReading> {
  return page.evaluate((target) => {
    type Obj = {
      name: string;
      userData: Record<string, unknown>;
      position: { constructor: new () => { x: number; y: number; z: number } };
      traverse(callback: (object: Obj) => void): void;
      updateWorldMatrix(parents: boolean, children: boolean): void;
      getWorldPosition<T>(target: T): T;
      worldToLocal<T>(vector: T): T;
    };
    type Probe = { model: Obj; mixer?: { setTime(time: number): void } };
    const hooks = window as unknown as { __feedProbes: Record<string, Probe>; __arProbe?: Probe };
    const probe = target === "ar" ? hooks.__arProbe! : Object.entries(hooks.__feedProbes).find(([url]) => url.endsWith(target.feedUrl))![1];
    const { model, mixer } = probe;
    mixer?.setTime(0);
    model.updateWorldMatrix(true, true);
    const tagged: Record<string, Obj> = {};
    model.traverse((object) => {
      const bone = object.userData.holoimHumanoidBone;
      if (typeof bone === "string" && !tagged[bone]) tagged[bone] = object;
    });
    const Vector = model.position.constructor;
    const at = (bone: string): number[] | undefined => {
      const object = tagged[bone];
      if (!object) return undefined;
      const local = model.worldToLocal(object.getWorldPosition(new Vector()));
      return [local.x, local.y, local.z];
    };
    let x = 0;
    let z = 0;
    for (const [left, right] of [[at("leftUpperArm"), at("rightUpperArm")], [at("leftUpperLeg"), at("rightUpperLeg")]]) {
      if (!left || !right) continue;
      x += right[2]! - left[2]!;
      z += left[0]! - right[0]!;
    }
    return {
      source: model.userData.holoimHumanoidSource as string | undefined,
      hips: tagged.hips?.name,
      head: tagged.head?.name,
      yawDeg: Math.hypot(x, z) < 1e-6 ? null : (Math.atan2(x, z) * 180) / Math.PI,
      bones: Object.keys(tagged).length
    };
  }, where);
}

async function openCard(page: Page, uploaded: { id: string }): Promise<void> {
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
}

async function openAr(page: Page, uploaded: { id: string }): Promise<void> {
  await pressViewInAr(page, page.locator(`.feed-card[data-card-id="${uploaded.id}"]`));
  const xrView = page.locator(".xr-view-container");
  await expect(xrView).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await xrView.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
  await page.waitForFunction(() => Boolean((window as unknown as { __arProbe?: { model?: unknown } }).__arProbe?.model), null, { timeout: 90_000 });
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __HOLOIM_XR_VIEWER__: { snapshot(): { placement: { stage: string } } };
  }).__HOLOIM_XR_VIEWER__.snapshot().placement.stage), { timeout: 30_000 }).toMatch(/placed|anchored/);
}

const fixtures = new Map<FixtureName, FixtureFacts>();

async function writeReport(name: string, value: unknown): Promise<void> {
  await writeFile(path.join(evidenceDir, `${name}-report.json`), JSON.stringify(value, null, 2));
}

test.beforeAll(async () => {
  if (process.env.RUN_E2E_PIPELINE !== "1") return;
  // Generated from the shipped avatar at test time; nothing is committed.
  const { generateAvatarFixtures, readGlb, resolveGltf } = await import("../../capture/scripts/lib/avatar-fixtures.ts");
  for (const info of await generateAvatarFixtures(fixtureDir)) {
    const name = FIXTURES.find((wanted) => wanted === info.name);
    if (!name) continue;
    const { json } = readGlb(await readFile(info.file));
    const mapping = resolveGltf(json);
    const nodes = (json as GltfJson).nodes ?? [];
    fixtures.set(name, {
      url: `/${path.relative(captureRoot, info.file).split(path.sep).join("/")}`,
      hips: nodes[mapping.bones.hips!]!.name!,
      head: nodes[mapping.bones.head!]!.name!,
      declared: readHumanoidDeclaration(json)?.format
    });
  }
  expect([...fixtures.keys()].sort()).toEqual([...FIXTURES].sort());
  await mkdir(evidenceDir, { recursive: true });
});

for (const name of FIXTURES) {
  test(`${name}: the export renders in the feed and AR with its own bones, facing as recorded`, async ({ page, context }, testInfo) => {
    test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
    test.setTimeout(240_000);
    const fixture = fixtures.get(name)!;
    // Unreal names only the name tables know; the VRM 0.x rig keeps the shipped names but maps by its own declaration.
    if (name === "unreal-cm") expect(fixture.hips, "Unreal names, not Ready Player Me's").toBe("pelvis");
    else expect(fixture.declared, "the fixture maps its bones by a VRM 0.x declaration").toBe("vrm0");

    // Record a short standing take on the fixture in the real capture app.
    const capture = await context.newPage();
    const captureErrors: string[] = [];
    capture.on("pageerror", (error) => captureErrors.push(`pageerror: ${error.message}`));
    capture.on("console", (message) => {
      if (message.type() === "error") captureErrors.push(`console.error: ${message.text()}`);
    });
    const url = new URL(captureUrl);
    url.searchParams.set("manualClock", "1");
    url.searchParams.set("avatar", fixture.url);
    await capture.goto(url.href, { waitUntil: "networkidle" });
    await waitForPageFunctions(capture, ["__sampleBody", "advanceTime"]);
    await waitForTextContentPrefix(capture, "#status", "loaded");
    await capture.evaluate(() => (window as unknown as CaptureWindow).advanceTime(2000));
    await capture.getByRole("button", { name: CONTROL_NAMES.startRecording }).click();
    await expect(capture.getByRole("button", { name: CONTROL_NAMES.stopRecording })).toBeVisible();
    const recordedBones = await capture.evaluate(() => (window as unknown as CaptureWindow).__sampleBody().bones);
    const recordedYaw = yawFromSides([[recordedBones.leftShoulder, recordedBones.rightShoulder], [recordedBones.leftHip, recordedBones.rightHip]]);
    await capture.evaluate(() => (window as unknown as CaptureWindow).advanceTime(1000));
    const download = capture.waitForEvent("download");
    await capture.getByRole("button", { name: CONTROL_NAMES.stopRecording }).click();
    const glbPath = testInfo.outputPath(`${name}-export.glb`);
    await (await download).saveAs(glbPath);
    await capture.close();
    expect(captureErrors, "capture runtime errors").toEqual([]);
    expect(recordedYaw, "capture body yaw").not.toBeNull();

    // The export keeps the fixture's names and declares them.
    const glb = await readFile(glbPath);
    const json = readGlbJson(glb);
    const declaration = readHumanoidDeclaration(json);
    expect(declaration?.format, "export carries HOLOIM_humanoid").toBe("holoim");
    expect(json.extensionsUsed ?? [], "HOLOIM_humanoid is listed as used").toContain("HOLOIM_humanoid");
    expect(json.nodes?.[declaration!.bones.hips!]?.name, "declared hips keep the fixture's name").toBe(fixture.hips);
    expect(json.nodes?.[declaration!.bones.head!]?.name, "declared head keeps the fixture's name").toBe(fixture.head);

    await installProbes(page);
    const uploaded = await upload(page, `avatar-${name}`, glb);
    await openCard(page, uploaded);
    await page.waitForFunction((target) => Object.keys((window as unknown as { __feedProbes: Record<string, unknown> }).__feedProbes).some((url) => url.endsWith(target)), uploaded.url);
    const feed = await readHumanoid(page, { feedUrl: uploaded.url });
    await captureEvidence(page, testInfo, `${name}-feed`);
    await page.locator(`.feed-card[data-card-id="${uploaded.id}"]`).screenshot({ path: path.join(evidenceDir, `${name}-feed.png`) });

    await openAr(page, uploaded);
    const ar = await readHumanoid(page, "ar");
    await captureEvidence(page, testInfo, `${name}-ar`);

    await writeReport(name, { fixture, recordedYawDeg: recordedYaw, feed, ar });
    for (const [view, reading] of [["feed", feed], ["AR", ar]] as const) {
      expect(reading.source, `${view}: hips from HOLOIM_humanoid`).toBe("holoim");
      expect(reading.hips, `${view}: hips`).toBe(fixture.hips);
      expect(reading.head, `${view}: head`).toBe(fixture.head);
      expect(reading.yawDeg, `${view}: body yaw`).not.toBeNull();
      expect(yawDifference(reading.yawDeg!, recordedYaw!), `${view}: faces as recorded (${reading.yawDeg?.toFixed(1)}° vs ${recordedYaw!.toFixed(1)}°)`).toBeLessThanOrEqual(YAW_TOLERANCE_DEG);
    }

    if (name === "unreal-cm") {
      // Without the extension (an exporter that drops it), the name tables still find the same bones.
      const { HOLOIM_humanoid: _dropped, ...extensions } = json.extensions ?? {};
      const stripped = withGlbJson(glb, { ...json, extensions, extensionsUsed: (json.extensionsUsed ?? []).filter((e) => e !== "HOLOIM_humanoid") });
      expect(readHumanoidDeclaration(readGlbJson(stripped)), "stripped export has no declaration").toBeUndefined();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const plain = await upload(page, `avatar-${name}-no-extension`, stripped);
      await openCard(page, plain);
      await page.waitForFunction((target) => Object.keys((window as unknown as { __feedProbes: Record<string, unknown> }).__feedProbes).some((url) => url.endsWith(target)), plain.url);
      const byNames = await readHumanoid(page, { feedUrl: plain.url });
      await writeReport(`${name}-no-extension`, { feed: byNames });
      expect(byNames.source, "without the extension: hips from the name tables").toBe("names");
      expect(byNames.hips).toBe(fixture.hips);
      expect(byNames.head).toBe(fixture.head);
      expect(yawDifference(byNames.yawDeg!, recordedYaw!)).toBeLessThanOrEqual(YAW_TOLERANCE_DEG);
    }
  });
}

test("unreal-cm pointing take: HOLOIM_meaning's fingertip anchors resolve in the feed", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(300_000);
  const { runDesktopPointingCheck } = await import("../../capture/scripts/lib/pointing-desktop-take.ts");
  const browser = await launchXrBrowser(chromium);
  const consoleErrors: string[] = [];
  let take: Awaited<ReturnType<typeof runDesktopPointingCheck>>;
  try {
    take = await runDesktopPointingCheck({
      browser, baseUrl: captureUrl, artifactDir: path.join(evidenceDir, "pointing-take"), consoleErrors, avatarUrl: fixtures.get("unreal-cm")!.url
    });
  } finally {
    await browser.close();
  }
  expect(consoleErrors, "capture runtime errors").toEqual([]);
  const glb = await readFile(take.glb);
  const json = readGlbJson(glb) as GltfJson & {
    extensions: { HOLOIM_meaning?: { marks: Array<{ anchor: { from: { node: number }; to: { node: number } }; span: { start: number; end: number } }> } };
  };
  const marks = json.extensions.HOLOIM_meaning?.marks ?? [];
  expect(marks.length, "the take recorded pointing marks").toBeGreaterThan(0);
  const fromNames = marks.map((mark) => json.nodes?.[mark.anchor.from.node]?.name);
  expect(readHumanoidDeclaration(json)?.format, "export carries HOLOIM_humanoid").toBe("holoim");

  await installProbes(page);
  const uploaded = await upload(page, "avatar-unreal-cm-pointing", glb);
  await openCard(page, uploaded);
  await page.waitForFunction((target) => Object.keys((window as unknown as { __feedProbes: Record<string, unknown> }).__feedProbes).some((url) => url.endsWith(target)), uploaded.url);
  const resolved: Array<{ from: string | undefined; to: string | undefined }> = [];
  for (const mark of marks) {
    // Seek into the mark's span, as playback would, and read the lit links.
    const midpoint = (mark.span.start + mark.span.end) / 2;
    await page.evaluate(([target, time]) => {
      const probes = (window as unknown as { __feedProbes: Record<string, {
        actions: Record<string, { time: number } | null>;
        mixer: { update: (delta: number) => void };
      }> }).__feedProbes;
      const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
      for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
      probe.mixer.update(0);
    }, [uploaded.url, midpoint] as const);
    const referent = json.nodes?.[mark.anchor.to.node]?.name;
    await expect.poll(() => page.evaluate(([target, want]) => {
      const probes = (window as unknown as { __feedProbes: Record<string, { pointing: { links: Array<{ referent: string }> } }> }).__feedProbes;
      const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
      return probe.pointing.links.some((link) => link.referent === want);
    }, [uploaded.url, referent] as const), { message: `link to ${referent} lights`, timeout: 15_000 }).toBe(true);
    resolved.push({ from: json.nodes?.[mark.anchor.from.node]?.name, to: referent });
  }
  await page.locator(`.feed-card[data-card-id="${uploaded.id}"]`).screenshot({ path: path.join(evidenceDir, "unreal-cm-pointing-feed.png") });
  await writeReport("unreal-cm-pointing", { takeFailures: take.failures, fromNames, resolved });
  expect(take.failures, "the pointing take on the Unreal rig").toEqual([]);
  expect(fromNames.every((n) => n && !/^(Left|Right)Hand/.test(n)), "anchors are the Unreal rig's own bones").toBe(true);
});
