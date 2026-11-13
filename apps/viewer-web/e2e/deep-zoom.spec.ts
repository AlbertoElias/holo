import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { assertViewerShell, captureEvidence, expect, reachFor, test } from "./bootstrap";
import { DEEP_CLIP_S, deepZoomGlb, FIXTURE_LAYERS, LAYER_SIZES, layerNodeName } from "./deep-zoom-fixture";
import { animationFrames, cardCenter, feedScrollTop, installProbe, scrollFeedToTop, settleScroll, waitForPortalReady } from "./portal-helpers";

// Deep zoom (docs/features/archive/deep-zoom.md) in the feed portal, driven by the
// real wheel and keys. A hologram declares three layers nested in it, 100,
// 40 and 40 times smaller in turn; past the portal's inside end the camera
// goes on in, and at each layer's home it stands from that layer's aim as
// it stood from the hologram at the inside end. At each home the check reads
// the camera's distance and aim, the colour drawn at the aim (each layer's
// marker has its own), the layer's blade turning, and which layer's sound is
// up and how near its distances are. A wheel gesture from outside stops at
// the inside end and the next goes on in; Return glides out through every
// layer; scrolling away resets. The same file with its layers renamed (it
// declares nothing) stops at the inside end as every hologram did before.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(testDir, "../../../output/test-results/deep-zoom-report.json");

const declared = { id: "deep-1", url: "/uploads/deep-1.glb", glb: deepZoomGlb(true) };
const plain = { id: "deep-2", url: "/uploads/deep-2.glb", glb: deepZoomGlb(false) };
const feedItem = (card: typeof declared, name: string) => ({
  id: card.id,
  url: card.url,
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-11-13T00:00:00.000Z",
  sizeBytes: card.glb.length,
  filenameOriginal: `${card.id}.glb`,
  hologramName: name,
  submittedBy: "automation"
});

const KEY_ZOOM_NEPERS = Math.log(1.25) * 2;
const LEAN_NEPERS = Math.log(16);
/** Each layer's home depth: −ln(size). */
const HOMES = LAYER_SIZES.map((size) => -Math.log(size));
/** The wheel's gesture gap in the viewer: a wheel event this long after the last starts a new gesture. */
const WHEEL_GESTURE_GAP_MS = 250;

type Vec3 = [number, number, number];
type Deep = {
  depth: number;
  depthNow: number;
  mode: string;
  zoom: number;
  maxDepth: number;
  cameraDistance: number;
  insideDistance: number;
  target: Vec3;
  aims: Vec3[];
  layers: Array<{ name: string; size: number }> | null;
  visible: Record<string, boolean>;
  spins: number[];
  placements: Array<{ node: string; layer: number; level: number; refDistance: number }>;
  modelScale: number;
  /** Whether the cloche's group is drawn; null for a card without one. */
  clocheDrawn: boolean | null;
};

const report: Record<string, unknown> = {};
test.afterAll(async () => {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`);
});

async function openFeed(page: Page): Promise<void> {
  await installProbe(page);
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [feedItem(declared, "Nested layers"), feedItem(plain, "Nothing declared")], nextCursor: null } }));
  await page.route("**/uploads/**", (route) => route.fulfill({ body: route.request().url().endsWith(plain.url) ? plain.glb : declared.glb, contentType: "model/gltf-binary" }));
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, declared.id, declared.url);
  await scrollFeedToTop(page);
}

async function read(page: Page, url: string, declaredNames: boolean): Promise<Deep> {
  const names = {
    layers: FIXTURE_LAYERS.map((layer) => layerNodeName(layer, declaredNames)),
    spins: FIXTURE_LAYERS.map((layer) => `Spin_${layer.name}`),
    visible: ["Body", "Floor", ...FIXTURE_LAYERS.map((layer) => `Marker_${layer.name}`)]
  };
  return page.evaluate(([modelUrl, nodeNames]) => {
    type Node = { name: string; visible: boolean; getWorldPosition(v: unknown): { x: number; y: number; z: number }; quaternion: { y: number; w: number } };
    type Probe = {
      model: { getObjectByName(name: string): Node | undefined; getWorldScale(v: unknown): { x: number }; position: { clone(): unknown } };
      camera: { position: { clone(): unknown } };
      portal: { getState(): { depth: number; mode: string; zoom: number }; runtime: { maxDepth: number; measured: { cameraDistance: number; insideDistance: number; target: Vec3 } } };
      deep: { layers: Array<{ name: string; size: number }> } | null;
      depthNow: { current: number };
      sound: { current: { readPlacements(): Array<{ node: string; layer: number; level: number; refDistance: number }> } | null };
      cloche: { group: { current: { visible: boolean } | null } };
    };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe> };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(modelUrl as string))![1];
    const scratch = probe.model.position.clone();
    const node = (name: string) => {
      const found = probe.model.getObjectByName(name);
      if (!found) throw new Error(`no node ${name}`);
      return found;
    };
    const state = probe.portal.getState();
    const { measured } = probe.portal.runtime;
    const list = nodeNames as { layers: string[]; spins: string[]; visible: string[] };
    return {
      depth: state.depth,
      depthNow: probe.depthNow.current,
      mode: state.mode,
      zoom: state.zoom,
      maxDepth: probe.portal.runtime.maxDepth,
      cameraDistance: measured.cameraDistance,
      insideDistance: measured.insideDistance,
      target: [...measured.target] as Vec3,
      aims: list.layers.map((name) => {
        const p = node(name).getWorldPosition(scratch);
        return [p.x, p.y, p.z] as Vec3;
      }),
      layers: probe.deep ? probe.deep.layers.map((layer) => ({ name: layer.name, size: layer.size })) : null,
      // A node is drawn when it and every parent are visible.
      visible: Object.fromEntries(list.visible.map((name) => {
        let shown = true;
        for (let at: (Node & { parent?: Node }) | undefined = node(name); at; at = at.parent) shown &&= at.visible;
        return [name, shown];
      })),
      spins: list.spins.map((name) => 2 * Math.atan2(node(name).quaternion.y, node(name).quaternion.w)),
      placements: (probe.sound.current?.readPlacements() ?? []).map((p) => ({ node: p.node, layer: p.layer, level: p.level, refDistance: p.refDistance })),
      modelScale: probe.model.getWorldScale(scratch).x,
      clocheDrawn: probe.cloche.group.current?.visible ?? null
    };
  }, [url, names] as const);
}

/** Where a world point is drawn on the page, through the card's camera (view offset included). */
async function screenPoint(page: Page, url: string, world: Vec3): Promise<{ x: number; y: number }> {
  return page.evaluate(([modelUrl, point]) => {
    type Probe = { camera: { position: { clone(): { set(x: number, y: number, z: number): { project(camera: unknown): { x: number; y: number } } } } }; renderer: { domElement: HTMLCanvasElement } };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe> };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(modelUrl as string))![1];
    const [x, y, z] = point as Vec3;
    const ndc = probe.camera.position.clone().set(x, y, z).project(probe.camera);
    const rect = probe.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
  }, [url, world] as const);
}

/** The colour drawn on the page around a point, 3×3 px averaged, read from a real screenshot. */
async function colourAt(page: Page, at: { x: number; y: number }): Promise<Vec3> {
  const png = await page.screenshot({ clip: { x: Math.round(at.x) - 1, y: Math.round(at.y) - 1, width: 3, height: 3 } });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
    const count = data.length / 4;
    return sum.map((value) => value / count / 255) as Vec3;
  }, png.toString("base64"));
}

/** A point over the hologram's own meshes near the viewing box's middle, where the wheel zooms. */
async function overHologram(page: Page, url: string, around: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const found = await page.evaluate(([modelUrl, centre]) => {
    type Probe = { portal: { runtime: { hitTest: ((x: number, y: number) => boolean) | null } } };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe> };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(modelUrl as string))![1];
    const { x, y } = centre as { x: number; y: number };
    for (let ring = 0; ring <= 12; ring++) {
      for (let k = 0; k < Math.max(1, ring * 6); k++) {
        const angle = (2 * Math.PI * k) / Math.max(1, ring * 6);
        const at = { x: x + ring * 12 * Math.cos(angle), y: y + ring * 12 * Math.sin(angle) };
        if (probe.portal.runtime.hitTest?.(at.x, at.y)) return at;
      }
    }
    return null;
  }, [url, around] as const);
  if (!found) throw new Error("no point over the hologram near the viewing box's middle");
  return found;
}

/** Ends the wheel gesture under way: waits, on the page's own clock, past the viewer's gesture gap. */
async function endWheelGesture(page: Page): Promise<void> {
  const since = await page.evaluate(() => performance.now());
  await page.waitForFunction((at) => performance.now() > at, since + WHEEL_GESTURE_GAP_MS + 50);
}

const dominant = (colour: Vec3) => colour.indexOf(Math.max(...colour));
const LAYER_CHANNEL = FIXTURE_LAYERS.map((layer) => dominant(layer.color));
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

test.use({ viewport: { width: 900, height: 700 } });
test.describe.configure({ timeout: 120_000 });

test("deep zoom: the wheel stops at the inside end, then the camera goes into each nested layer at its real size with its motion and sound, Return glides out through them, scrolling away resets, and an undeclared hologram is unchanged", async ({ page }, testInfo) => {
  await openFeed(page);
  const card = page.locator(`.feed-card[data-card-id="${declared.id}"]`);
  await reachFor(card);
  await card.getByRole("button", { name: "Unmute audio" }).click();
  await expect(card.getByRole("button", { name: "Mute audio" })).toHaveCount(1);
  await expect.poll(async () => (await read(page, declared.url, true)).placements.length, { message: "the card's placed sounds play", timeout: 15_000 }).toBe(4);

  const start = await read(page, declared.url, true);
  expect(start.layers, "the card reads the three declared layers, outermost first").toEqual(FIXTURE_LAYERS.map((layer, index) => ({ name: layerNodeName(layer, true), size: expect.closeTo(LAYER_SIZES[index]!, 9) })));
  expect(start.maxDepth, "it may go in until 16× past the deepest home").toBeCloseTo(HOMES.at(-1)! + LEAN_NEPERS, 6);
  expect(start.mode).toBe("follow");
  expect(start.clocheDrawn, "the cloche is drawn outside the layers").toBe(true);
  // A mesh of the hologram itself hidden by another feature (as the recorded bubble's old glass is): deep zoom must leave it hidden.
  await page.evaluate((modelUrl) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { model: { getObjectByName(name: string): { visible: boolean } | undefined } }> }).__portalProbes;
    Object.entries(probes).find(([key]) => key.endsWith(modelUrl))![1].model.getObjectByName("Floor")!.visible = false;
  }, declared.url);

  // One wheel gesture from Follow, enough to go far in: it stops at the inside end.
  const scrollBefore = await feedScrollTop(page);
  const over = await overHologram(page, declared.url, await cardCenter(page, declared.id));
  await page.mouse.move(over.x, over.y);
  await page.evaluate(() => {
    const hooks = window as unknown as { __wheelTimes: number[] };
    hooks.__wheelTimes = [];
    window.addEventListener("wheel", (event) => hooks.__wheelTimes.push(event.timeStamp), { capture: true });
  });
  await endWheelGesture(page);
  // A trackpad's notches, 16 ms apart as the hardware stamps them: sent untimed, each would be stamped when the
  // page took it, and a software-rendered frame (150-350 ms headless) would split the gesture in two.
  const cdp = await page.context().newCDPSession(page);
  const sentAt = Date.now() / 1000;
  for (let i = 0; i < 20; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: over.x, y: over.y, deltaX: 0, deltaY: -400, timestamp: sentAt + i * 0.016 });
  await animationFrames(page, 2);
  const wheelTimes = await page.evaluate(() => (window as unknown as { __wheelTimes: number[] }).__wheelTimes);
  const gaps = wheelTimes.slice(1).map((t, i) => t - wheelTimes[i]!);
  expect(Math.max(...gaps), `the notches came as one gesture (gaps ${gaps.map(Math.round).join(", ")} ms)`).toBeLessThan(WHEEL_GESTURE_GAP_MS);
  const stopped = await read(page, declared.url, true);
  expect(stopped.mode).toBe("free");
  expect(stopped.zoom, "the gesture reached the inside end").toBe(0);
  expect(stopped.depth, "and stopped there").toBe(0);
  expect(await feedScrollTop(page), "the feed did not scroll").toBe(scrollBefore);

  // The next gesture goes on in.
  await endWheelGesture(page);
  await page.mouse.wheel(0, -400);
  await animationFrames(page, 2);
  const inside = await read(page, declared.url, true);
  expect(inside.depth, "the next gesture goes past the inside end").toBeGreaterThan(0.5);
  expect(await feedScrollTop(page), "the feed did not scroll").toBe(scrollBefore);

  // Keys from here, a known step each, to each layer's home.
  await card.locator(".feed-card-bubble-shell").focus();
  const homes: Array<Record<string, unknown>> = [];
  for (let index = 0; index < FIXTURE_LAYERS.length; index++) {
    const home = HOMES[index]!;
    while ((await read(page, declared.url, true)).depth < home - KEY_ZOOM_NEPERS / 2) {
      await page.keyboard.press("+");
      await animationFrames(page, 1);
    }
    // The last step a pinch to exactly the home (1:1 under the fingers), so the framing is measured there.
    await page.evaluate(([modelUrl, to]) => {
      type Probe = { portal: { getState(): { depth: number }; zoomByScale(scale: number): void } };
      const probe = Object.entries((window as unknown as { __portalProbes: Record<string, Probe> }).__portalProbes).find(([key]) => key.endsWith(modelUrl as string))![1];
      probe.portal.zoomByScale(Math.exp((to as number) - probe.portal.getState().depth));
    }, [declared.url, home] as const);
    await animationFrames(page, 2);
    const layer = index + 1;
    // The sound fades between layers over the frames that follow.
    await expect.poll(async () => {
      const levels = (await read(page, declared.url, true)).placements;
      return levels.every((p) => (p.layer === layer ? p.level > 0.98 : p.level < 0.02));
    }, { message: `only layer ${layer}'s sound is up at its home`, timeout: 10_000 }).toBe(true);
    const at = await read(page, declared.url, true);
    const label = FIXTURE_LAYERS[index]!.name;
    expect(at.depth, `${label}: at its home`).toBeCloseTo(home, 6);
    expect(at.depthNow, `${label}: the frame drew the depth the store holds`).toBeCloseTo(at.depth, 6);
    // At home the layer is seen as the hologram is at the inside end: from the inside distance × its size.
    expect(Math.abs(at.cameraDistance / (at.insideDistance * Math.exp(-at.depth)) - 1), `${label}: the camera stands inside × e^−depth from its aim`).toBeLessThan(0.02);
    expect(distance(at.target, at.aims[index]!) / at.cameraDistance, `${label}: it looks at the layer's aim`).toBeLessThan(0.02);
    expect(at.clocheDrawn, `${label}: the cloche is not drawn from inside its glass`).toBe(false);
    // Drawn: the layer's marker fills the aim in its own colour.
    const colour = await colourAt(page, await screenPoint(page, declared.url, at.aims[index]!));
    expect(dominant(colour), `${label}: the layer's own colour is drawn at the aim (${colour.map((c) => c.toFixed(2)).join(", ")})`).toBe(LAYER_CHANNEL[index]);
    // The viewer's tone mapping softens a saturated colour (pure green reads about 0.56, 0.86, 0.43), so clear means ahead by 0.2.
    expect(Math.max(...colour) - [...colour].sort((a, b) => b - a)[1]!, `${label}: clearly that colour`).toBeGreaterThan(0.2);
    expect(at.visible[`Marker_${label}`], `${label}: drawn`).toBe(true);
    // A layer's own meshes are left undrawn once the camera is past the home two layers in: the body, past the liquid's.
    expect(at.visible.Body, `${label}: the body is drawn only until the camera is past the liquid's home (depth ${at.depth.toFixed(2)})`).toBe(at.depth <= HOMES[1]!);
    // Playing: the layer's blade turns as the take plays.
    const before = at.spins[index]!;
    await animationFrames(page, 12);
    const after = (await read(page, declared.url, true)).spins[index]!;
    expect(Math.abs(wrapAngle(after - before)), `${label}: its motion plays`).toBeGreaterThan(0.02);
    // Heard: its sound's distances shrink with the layer.
    for (const placement of at.placements) {
      const size = placement.layer === 0 ? 1 : LAYER_SIZES[placement.layer - 1]!;
      expect(placement.refDistance / (size * at.modelScale), `${placement.node}: its distances are its layer's size`).toBeCloseTo(1, 4);
    }
    homes.push({ layer: label, depth: at.depth, home, cameraDistance: at.cameraDistance, colour, levels: at.placements.map((p) => [p.node, p.level]) });
    await captureEvidence(page, testInfo, `deep-zoom-${label}`);
  }
  report.homes = homes;
  report.clipSeconds = DEEP_CLIP_S;

  // Leaning in ends 16× past the deepest home.
  for (let i = 0; i < 12; i++) await page.keyboard.press("+");
  await animationFrames(page, 2);
  const deepest = await read(page, declared.url, true);
  expect(deepest.depth, "the camera stops 16× past the deepest home").toBeCloseTo(deepest.maxDepth, 6);

  // After a pause, a new wheel gesture over the frame's edge, off where the hologram stood, still zooms: in here it is all hologram.
  await endWheelGesture(page);
  const edge = await page.locator(`.feed-card[data-card-id="${declared.id}"] .feed-card-portal`).boundingBox();
  if (!edge) throw new Error("viewing box not laid out");
  await page.mouse.move(edge.x + edge.width * 0.08, edge.y + edge.height * 0.12);
  await page.mouse.wheel(0, 200);
  await animationFrames(page, 2);
  const edged = await read(page, declared.url, true);
  expect(edged.depth, "a wheel at the frame's edge deep in zooms out").toBeLessThan(deepest.depth - 0.1);
  expect(await feedScrollTop(page), "and does not scroll the feed").toBe(scrollBefore);

  // Return glides out the way in, past each layer, to Follow.
  const glide = page.evaluate((modelUrl) => new Promise<Array<{ depth: number; mode: string }>>((resolve) => {
    type Probe = { portal: { getState(): { mode: string }; runtime: { returnBlend: number } }; depthNow: { current: number } };
    const probe = Object.entries((window as unknown as { __portalProbes: Record<string, Probe> }).__portalProbes).find(([key]) => key.endsWith(modelUrl))![1];
    const samples: Array<{ depth: number; mode: string }> = [];
    const step = () => {
      samples.push({ depth: probe.depthNow.current, mode: probe.portal.getState().mode });
      if (samples.length > 2 && probe.portal.runtime.returnBlend === 0 && probe.depthNow.current === 0) resolve(samples);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), declared.url);
  await page.keyboard.press("Escape");
  const samples = (await glide).filter((sample) => sample.mode === "follow");
  const depths = samples.map((sample) => sample.depth);
  report.returnDepths = depths;
  expect(depths[0], "the glide starts where the camera was").toBeGreaterThan(HOMES.at(-1)!);
  for (let i = 1; i < depths.length; i++) expect(depths[i]!, "it only comes out").toBeLessThanOrEqual(depths[i - 1]! + 1e-9);
  for (let index = 0; index < HOMES.length; index++) {
    const from = index === 0 ? 0 : HOMES[index - 1]!;
    expect(depths.some((depth) => depth > from && depth < HOMES[index]!), `the glide passes between home ${index} and home ${index + 1}`).toBe(true);
  }
  const back = await read(page, declared.url, true);
  expect(back.mode).toBe("follow");
  expect(back.depth).toBe(0);
  expect(back.visible.Body, "the body is drawn again").toBe(true);
  expect(back.visible.Floor, "a mesh hidden before the zoom stays hidden").toBe(false);
  expect(back.clocheDrawn, "the cloche is drawn again").toBe(true);
  await expect.poll(async () => (await read(page, declared.url, true)).placements.every((p) => (p.layer === 0 ? p.level > 0.98 : p.level < 0.02)), { message: "only the hologram's own sound is up again" }).toBe(true);

  // Scrolling away from a card deep inside resets it.
  for (let i = 0; i < 12; i++) await page.keyboard.press("+");
  await animationFrames(page, 2);
  expect((await read(page, declared.url, true)).depth).toBeGreaterThan(0);
  const plainCard = page.locator(`.feed-card[data-card-id="${plain.id}"]`);
  await plainCard.evaluate((element) => element.scrollIntoView({ behavior: "instant" }));
  await settleScroll(page);
  await animationFrames(page, 2);
  const left = await read(page, declared.url, true);
  expect(left.mode, "the card left behind is back in Follow").toBe("follow");
  expect(left.depth, "and out of its layers").toBe(0);

  // The same file declaring nothing: the inside end is as far as it goes, and its sounds are as before.
  await waitForPortalReady(page, plain.id, plain.url);
  await reachFor(plainCard);
  const flat = await read(page, plain.url, false);
  expect(flat.layers, "nothing declared").toBeNull();
  expect(flat.maxDepth).toBe(0);
  await plainCard.locator(".feed-card-bubble-shell").focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("+");
  await animationFrames(page, 2);
  const flatInside = await read(page, plain.url, false);
  expect(flatInside.zoom, "it zooms to the inside end").toBe(0);
  expect(flatInside.depth, "and no further").toBe(0);
  expect(Math.abs(flatInside.cameraDistance / flatInside.insideDistance - 1), "the camera stands at the inside distance").toBeLessThan(0.02);
  const plainScroll = await feedScrollTop(page);
  const plainOver = await overHologram(page, plain.url, await cardCenter(page, plain.id));
  await page.mouse.move(plainOver.x, plainOver.y);
  await endWheelGesture(page);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -400);
  await animationFrames(page, 2);
  expect((await read(page, plain.url, false)).depth, "a wheel at the inside end does not go in").toBe(0);
  expect(await feedScrollTop(page), "nor scroll the feed").toBe(plainScroll);
  report.undeclared = { maxDepth: flat.maxDepth, cameraDistance: flatInside.cameraDistance, insideDistance: flatInside.insideDistance };
  await captureEvidence(page, testInfo, "deep-zoom-undeclared");
});
