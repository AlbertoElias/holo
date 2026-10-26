import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";
import type * as Three from "three";

import type * as DrawnPoints from "../src/features/hologram/drawnPoints";

import { launchXrBrowser, waitForIwerSession } from "@holoim/tooling-testing/xr-env";

import { CONTROL_NAMES } from "@holoim/xr-ui-core";
import { tokens } from "@holoim/design-tokens";
import { Quaternion, Vector3 } from "three";

import { identityOf } from "../src/features/presence/identityHue";
import { assertViewerShell, expect, pressViewInAr, reachFor, test } from "./bootstrap";
import { installProbe, waitForPortalReady } from "./portal-helpers";
import { buildPointingGlb } from "./pointing-fixture";

// A camera take (AR recording, slice 2b): a phone's handheld AR export has no
// skin and no RecordedAvatar. Its author is a camera node, RecordedAuthorCamera,
// animated by the take's only clip, and its floor is the set's origin. The
// take is capture's own export, recorded in beforeAll by the running capture
// app (apps/capture/scripts/lib/camera-take-recording.ts: phone AR in IWER, a
// scripted head walk), uploaded through the real API with Quick Look on and
// drawn by the real feed card and the immersive AR view. Everything is read
// as numbers: the set's bounds on screen, the playback clock across loops,
// the audio source the card starts, the USDZ status, and where the placed set
// stands against its origin. A copy with a prop named Hips and another Head
// must frame and anchor the same: no node's name is the author here.

const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";
const takeDir = path.resolve(import.meta.dirname, "../../../output/camera-take/take");
let takeFile = "";
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/camera-take");
const DESKTOP = { width: 1280, height: 720 };
const LOOP_SAMPLE_MS = 9_000;
const CLOCK_TOLERANCE_S = 0.08;
const SET_MARGIN_PX = 4;
/** The set's centre on screen, off the viewing box's centre by at most this share of its size. */
const CENTRE_TOLERANCE = 0.05;
const ONE_CM = 0.01;
/** SHELF_PREVIEW_HEIGHT_M (packages/xr-ui-iwsdk): the size a gallery tile's preview is fitted to. */
const SHELF_PREVIEW_M = 0.28;

type Vec3 = [number, number, number];
type GltfJson = {
  nodes: Array<{ name?: string; mesh?: number; extras?: { yfov?: number } }>;
  skins?: unknown[];
  animations: Array<{ samplers: Array<{ input: number; output: number }>; channels: Array<{ sampler: number; target: { node: number; path: string } }> }>;
  accessors: Array<{ max?: number[]; bufferView: number; byteOffset?: number; count: number }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number }>;
  extensions?: { KHR_audio?: unknown; HOLOIM_meaning?: unknown };
  extensionsUsed?: string[];
};

function parseGlb(buffer: Buffer): { json: GltfJson; rest: Buffer } {
  expect(buffer.readUInt32LE(0), "GLB magic").toBe(0x46546c67);
  const jsonLength = buffer.readUInt32LE(12);
  return { json: JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as GltfJson, rest: buffer.subarray(20 + jsonLength) };
}

function buildGlb(json: GltfJson, rest: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, padded, rest]);
}

function takeDurationSeconds(json: GltfJson): number {
  const ends = json.animations.flatMap((animation) => animation.samplers.map((sampler) => json.accessors[sampler.input]?.max?.[0] ?? 0));
  return Math.max(...ends);
}

/** The same take with two of its event object's parts named like a performer's bones. */
function withBoneNames(buffer: Buffer): Buffer {
  const { json, rest } = parseGlb(buffer);
  const upright = json.nodes.find((node) => node.name === "BracketUpright");
  const marker = json.nodes.find((node) => node.name === "BracketMarker");
  expect(upright && marker, "the take has the event object's parts").toBeTruthy();
  upright!.name = "Hips";
  marker!.name = "Head";
  return buildGlb(json, rest);
}

type SetReading = {
  /** The set and its objects (never the bubble's sphere) in the placed frame: the group's in AR, the model's in the feed. */
  min: Vec3;
  max: Vec3;
  /** Where the model's origin and the bubble's sphere stand in that frame. */
  modelAt: Vec3;
  sphereAt: Vec3;
  /** The frame's world scale: the hologram is at recorded scale when it is 1. */
  scale: Vec3;
  clocheBaseY: number | null;
};

type Placement = { stage: string; mode: string | null; position: Vec3 | null };

type FeedReading = SetReading & {
  /** The set's screen rectangle and the viewing box, in page pixels. */
  setRect: { left: number; top: number; right: number; bottom: number };
  box: { left: number; top: number; right: number; bottom: number };
  camera: Vec3;
};

type ArReading = SetReading & {
  groupAt: Vec3;
  groupY: number;
  placement: Placement;
  sceneGroundMin: number;
};

async function upload(page: Page, name: string, glb: Buffer, quickLook: boolean): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `${name} ${Date.now()}`,
      submittedBy: "camera-take-e2e",
      quickLookEnabled: quickLook ? "true" : "false",
      file: { name: `${name}.glb`, mimeType: "model/gltf-binary", buffer: glb }
    },
    timeout: 120_000
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as { id: string; url: string };
}

async function showOnly(page: Page, id: string): Promise<void> {
  await page.route("**/api/holograms?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { items: Array<{ id: string }> };
    await route.fulfill({ response, json: { ...body, items: body.items.filter((item) => item.id === id), nextCursor: null } });
  });
}

/** Records what the page's audio graph is asked to do, so "audio plays" is a reading and not a hope. */
async function observeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Started = { duration: number; loop: boolean; gain: { gain: { value: number } } | null; started: boolean; stopped: boolean };
    const hooks = window as unknown as { __audio: { sources: Started[]; contexts: AudioContext[] } };
    hooks.__audio = { sources: [], contexts: [] };
    const proto = AudioContext.prototype;
    const createBufferSource = proto.createBufferSource;
    proto.createBufferSource = function (this: AudioContext) {
      const source = createBufferSource.call(this);
      if (!hooks.__audio.contexts.includes(this)) hooks.__audio.contexts.push(this);
      const entry: Started = { duration: 0, loop: false, gain: null, started: false, stopped: false };
      hooks.__audio.sources.push(entry);
      const start = source.start.bind(source);
      source.start = (...args: Parameters<AudioBufferSourceNode["start"]>) => {
        entry.started = true;
        entry.duration = source.buffer?.duration ?? 0;
        entry.loop = source.loop;
        return start(...args);
      };
      const stop = source.stop.bind(source);
      source.stop = (...args: Parameters<AudioBufferSourceNode["stop"]>) => {
        entry.stopped = true;
        return stop(...args);
      };
      const connect = source.connect.bind(source);
      source.connect = ((destination: AudioNode) => {
        entry.gain = destination as unknown as Started["gain"];
        return connect(destination);
      }) as typeof source.connect;
      return source;
    };
  });
}

async function readAudio(page: Page) {
  return page.evaluate(() => {
    const audio = (window as unknown as { __audio: { sources: Array<{ duration: number; loop: boolean; gain: { gain: { value: number } } | null; started: boolean; stopped: boolean }>; contexts: AudioContext[] } }).__audio;
    const running = audio.sources.filter((source) => source.started && !source.stopped);
    return {
      started: audio.sources.filter((source) => source.started).length,
      playing: running.map((source) => ({ duration: source.duration, loop: source.loop, gain: source.gain?.gain.value ?? null })),
      contextState: audio.contexts[0]?.state ?? null,
      contextTime: audio.contexts[0]?.currentTime ?? null
    };
  });
}

/** The primary action's time, sampled on every frame for `ms`, with the wall clock beside it. */
async function sampleLoop(page: Page, modelPath: string, ms: number): Promise<{ clip: number; samples: Array<[number, number]> }> {
  return page.evaluate(([target, span]) => new Promise<{ clip: number; samples: Array<[number, number]> }>((resolve) => {
    type Action = { time: number; getClip: () => { duration: number } };
    const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, Action | null> }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    const actions = Object.values(probe.actions).filter(Boolean) as Action[];
    const action = actions[0]!;
    const samples: Array<[number, number]> = [];
    const begin = performance.now();
    const step = () => {
      const now = performance.now();
      samples.push([now - begin, action.time]);
      if (now - begin < (span as number)) requestAnimationFrame(step);
      else resolve({ clip: action.getClip().duration, samples });
    };
    requestAnimationFrame(step);
  }), [modelPath, ms] as const);
}

/** The set's bounds and where its origin stands, at the take's first frame, in the placed frame. */
async function readSet(page: Page, mode: "feed" | "ar"): Promise<SetReading & { sceneGroundMin: number }> {
  return page.evaluate(async (mode) => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { Box3, Matrix4, Vector3 } = await import(moduleUrl) as typeof Three;
    const hooks = window as unknown as {
      __portalProbes: Record<string, { model: Three.Object3D; mixer: Three.AnimationMixer; cloche: { shape: { current: { base: { y: number } } | null }; fitted: { current: Three.Vector3 | null } } }>;
      __arProbe: { model: Three.Object3D; mixer: Three.AnimationMixer; group: { current: Three.Object3D }; cloche: { current: { base: { x: number; y: number; z: number } } | null } };
    };
    const feed = Object.values(hooks.__portalProbes)[0]!;
    const { model, mixer } = mode === "feed" ? feed : hooks.__arProbe;
    mixer.setTime(0);
    model.updateWorldMatrix(true, true);
    const frame = mode === "feed" ? model : hooks.__arProbe.group.current;
    frame.updateWorldMatrix(true, true);
    const toFrame = new Matrix4().copy(frame.matrixWorld).invert();
    const bounds = new Box3();
    const ground = new Box3();
    const corner = new Vector3();
    model.traverse((node) => {
      const mesh = node as Three.Mesh;
      if (!mesh.isMesh) return;
      // The set as drawn: the author's mark is chrome, and stands wherever the author did.
      for (let n: Three.Object3D | null = node; n; n = n.parent) if (n.userData.holoimChrome === true) return;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      const inSphere = (() => { for (let n: Three.Object3D | null = node; n; n = n.parent) if (n.name === "RecordedBubbleSphere") return true; return false; })();
      for (let i = 0; i < 8; i += 1) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(mesh.matrixWorld).applyMatrix4(toFrame);
        if (inSphere) ground.expandByPoint(corner);
        else bounds.expandByPoint(corner);
      }
    });
    const sphere = model.getObjectByName("RecordedBubbleSphere")!;
    const at = (object: Three.Object3D) => object.getWorldPosition(new Vector3()).applyMatrix4(toFrame).toArray() as [number, number, number];
    let clocheBaseY: number | null = null;
    if (mode === "feed") {
      const base = feed.cloche.shape.current?.base.y;
      const shift = feed.cloche.fitted.current ? sphere.getWorldPosition(new Vector3()).y - feed.cloche.fitted.current.y : 0;
      clocheBaseY = base === undefined ? null : base + shift;
    } else {
      const base = hooks.__arProbe.cloche.current?.base;
      clocheBaseY = base ? new Vector3(base.x, base.y, base.z).applyMatrix4(hooks.__arProbe.group.current.matrixWorld).applyMatrix4(toFrame).y : null;
    }
    return {
      min: bounds.min.toArray() as [number, number, number],
      max: bounds.max.toArray() as [number, number, number],
      modelAt: at(model),
      sphereAt: at(sphere),
      scale: frame.getWorldScale(new Vector3()).toArray() as [number, number, number],
      clocheBaseY,
      sceneGroundMin: ground.min.y
    };
  }, mode);
}

/** The set as the card draws it: its screen rectangle against the viewing box. */
async function readFeed(page: Page, cardId: string): Promise<FeedReading> {
  const set = await readSet(page, "feed");
  return { ...set, ...(await projectSet(page, cardId, set)) };
}

async function projectSet(page: Page, cardId: string, set: SetReading): Promise<Pick<FeedReading, "setRect" | "box" | "camera">> {
  return page.evaluate(async ([id, min, max]) => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { Vector3 } = await import(moduleUrl) as typeof Three;
    const { camera, renderer } = Object.values((window as unknown as { __portalProbes: Record<string, { camera: Three.PerspectiveCamera; renderer: Three.WebGLRenderer }> }).__portalProbes)[0]!;
    camera.updateMatrixWorld();
    const canvas = renderer.domElement.getBoundingClientRect();
    const rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    const lo = min as Vec3;
    const hi = max as Vec3;
    for (let i = 0; i < 8; i += 1) {
      const ndc = new Vector3(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]).project(camera);
      const x = canvas.left + ((ndc.x + 1) / 2) * canvas.width;
      const y = canvas.top + ((1 - ndc.y) / 2) * canvas.height;
      rect.left = Math.min(rect.left, x);
      rect.right = Math.max(rect.right, x);
      rect.top = Math.min(rect.top, y);
      rect.bottom = Math.max(rect.bottom, y);
    }
    const box = document.querySelector(`.feed-card[data-card-id="${id as string}"] .feed-card-portal`)!.getBoundingClientRect();
    return { setRect: rect, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom }, camera: camera.position.toArray() as [number, number, number] };
  }, [cardId, set.min, set.max] as const);
}

async function enterAr(page: Page, cardId: string): Promise<void> {
  const card = page.locator(`.feed-card[data-card-id="${cardId}"]`);
  await pressViewInAr(page, card);
  const xrView = page.locator(".xr-view-container");
  await expect(xrView).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await xrView.getAttribute("data-xr-state")) === "ready") await page.getByRole("button", { name: "View in your room" }).click();
  await waitForIwerSession(page, { environmentBlendMode: "alpha-blend" });
}

async function readAr(page: Page): Promise<ArReading> {
  // The set is placed once the viewer's world has found it a place.
  await page.waitForFunction(() => Boolean((window as unknown as { __arProbe?: unknown }).__arProbe));
  await expect.poll(async () => page.evaluate(() => {
    const viewer = (window as unknown as { __HOLOIM_XR_VIEWER__?: { snapshot: () => { placement: { stage: string } } } }).__HOLOIM_XR_VIEWER__;
    return viewer?.snapshot().placement.stage ?? "none";
  }), { timeout: 30_000, message: "the set is placed in the room" }).toMatch(/^(placed|anchored)$/);
  const set = await readSet(page, "ar");
  const placed = await page.evaluate(() => {
    const viewer = (window as unknown as { __HOLOIM_XR_VIEWER__: { snapshot: () => { placement: Placement; hologram: { worldPosition: Vec3 } | null } } }).__HOLOIM_XR_VIEWER__;
    const { placement, hologram } = viewer.snapshot();
    return { placement, groupAt: hologram!.worldPosition };
  });
  return { ...set, groupAt: placed.groupAt, groupY: placed.groupAt[1], placement: placed.placement };
}

type PreviewReading = { extent: number; originY: number; positionY: number; sphereExtent: number };

/** Takes the placed set off the stage so its tile shows a preview again, and measures that preview: the set (and its floor) against the tile's size. */
async function readGalleryPreview(page: Page, id: string): Promise<PreviewReading> {
  await page.evaluate((target) => {
    (window as unknown as { __HOLOIM_XR_VIEWER__: { space: { remove: (id: string) => boolean } } }).__HOLOIM_XR_VIEWER__.space.remove(target);
  }, id);
  await expect.poll(() => page.evaluate((target) => {
    const gallery = (window as unknown as { __HOLOIM_XR_VIEWER__: { gallery: { slots: Array<{ id: string; preview: unknown } | null> } } }).__HOLOIM_XR_VIEWER__.gallery;
    return gallery.slots.some((slot) => slot?.id === target && slot.preview);
  }, id), { message: "the tile shows a preview of the take", timeout: 30_000 }).toBe(true);
  return page.evaluate(async (target) => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { Box3, Matrix4, Vector3 } = await import(moduleUrl) as typeof Three;
    const gallery = (window as unknown as { __HOLOIM_XR_VIEWER__: { gallery: { slots: Array<{ id: string; preview: Three.Object3D } | null> } } }).__HOLOIM_XR_VIEWER__.gallery;
    const preview = gallery.slots.find((slot) => slot?.id === target)!.preview;
    preview.parent!.updateWorldMatrix(true, false);
    preview.updateWorldMatrix(false, true);
    // In the tile's own frame, where the preview's origin is the set's origin standing on the board.
    const toTile = new Matrix4().copy(preview.parent!.matrixWorld).invert();
    const set = new Box3().expandByPoint(preview.getWorldPosition(new Vector3()).applyMatrix4(toTile));
    const sphere = new Box3();
    const corner = new Vector3();
    preview.traverse((node) => {
      const mesh = node as Three.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox!;
      let inSphere = false;
      for (let n: Three.Object3D | null = node; n; n = n.parent) if (n.name === "RecordedBubbleSphere") inSphere = true;
      for (let i = 0; i < 8; i += 1) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(mesh.matrixWorld).applyMatrix4(toTile);
        (inSphere ? sphere : set).expandByPoint(corner);
      }
    });
    return {
      extent: Math.max(...set.getSize(new Vector3()).toArray()),
      originY: set.min.y,
      positionY: preview.position.y,
      sphereExtent: Math.max(...sphere.getSize(new Vector3()).toArray())
    };
  }, id);
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(...a.map((value, i) => value - b[i]!));
}

const size = (set: SetReading): Vec3 => [set.max[0] - set.min[0], set.max[1] - set.min[1], set.max[2] - set.min[2]];

/** The set fills the viewing box without leaving it, and sits at its centre. */
function expectFramed(feed: FeedReading): { offsetX: number; offsetY: number } {
  const { box, setRect: rect } = feed;
  expect(rect.left, "the set's left edge is in the viewing box").toBeGreaterThanOrEqual(box.left + SET_MARGIN_PX);
  expect(rect.right, "right").toBeLessThanOrEqual(box.right - SET_MARGIN_PX);
  expect(rect.top, "top").toBeGreaterThanOrEqual(box.top + SET_MARGIN_PX);
  expect(rect.bottom, "bottom").toBeLessThanOrEqual(box.bottom - SET_MARGIN_PX);
  const offsetX = ((rect.left + rect.right) / 2 - (box.left + box.right) / 2) / (box.right - box.left);
  const offsetY = ((rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2) / (box.bottom - box.top);
  expect(Math.abs(offsetX), "the set is centred across").toBeLessThanOrEqual(CENTRE_TOLERANCE);
  expect(Math.abs(offsetY), "and down").toBeLessThanOrEqual(CENTRE_TOLERANCE);
  return { offsetX, offsetY };
}

async function playTake(page: Page, name: string, glb: Buffer, quickLook: boolean) {
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  const uploaded = await upload(page, name, glb, quickLook);
  await showOnly(page, uploaded.id);
  await page.addInitScript(() => {
    (window as unknown as { __HOLOIM_AR_TEST_OBSERVER__: (probe: unknown) => void }).__HOLOIM_AR_TEST_OBSERVER__ = (probe) => {
      (window as unknown as { __arProbe: unknown }).__arProbe = probe;
    };
  });
  await page.goto("/");
  await assertViewerShell(page);
  const collapse = page.getByRole("button", { name: "Collapse upload panel" });
  if (await collapse.isVisible()) await collapse.click();
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
  return { uploaded, card };
}

let real: { feed: FeedReading; ar: ArReading } | undefined;

// The take is recorded here, in the running capture app, as a phone in AR
// walks round its set. Nothing is committed, so a break in capture's export
// shows up as a failure in this spec.
test.beforeAll(async () => {
  if (process.env.RUN_E2E_PIPELINE !== "1") return;
  test.setTimeout(300_000);
  const { FAKE_MIC_ARGS, recordCameraTake } = await import("../../capture/scripts/lib/camera-take-recording.ts");
  const browser = await launchXrBrowser(chromium, { args: FAKE_MIC_ARGS });
  const consoleErrors: string[] = [];
  try {
    const recording = await recordCameraTake({ browser, baseUrl: captureUrl, artifactDir: takeDir, consoleErrors });
    expect(recording.failures, "capture's camera take").toEqual([]);
    expect(consoleErrors, "capture runtime errors").toEqual([]);
    takeFile = recording.glb;
    const [link] = recording.take.meaningLinks;
    expect(link, "the hold on the bracket made one camera link").toBeDefined();
    SPAN = { ...link!.span };
    REFERENT = link!.to.nodeName;
    REFERENT_POINT = link!.to.point!;
    const inside = (share: number) => Math.round((SPAN.start + (SPAN.end - SPAN.start) * share) * 100) / 100;
    IN_SPAN_TIMES = [inside(0.2), inside(0.5), inside(0.8)];
    OUTSIDE_SPAN_TIMES = [Math.round(SPAN.start * 30) / 100, Math.min(SPAN.end + 0.6, recording.take.duration - 0.2)];
  } finally {
    await browser.close();
  }
});

test("a camera take uploads, frames its set in the feed, loops, sounds, converts for Quick Look and stands on its origin in AR", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture export and a live API.");
  test.setTimeout(300_000);
  const glb = await readFile(takeFile);
  const { json } = parseGlb(glb);
  const duration = takeDurationSeconds(json);
  expect(json.skins?.length ?? 0, "a camera take has no skin").toBe(0);
  expect(json.nodes.some((node) => node.name === "RecordedAvatar"), "no avatar").toBe(false);
  expect(json.nodes.some((node) => node.name === "RecordedAuthorCamera"), "the author is a camera node").toBe(true);
  expect(json.extensions?.KHR_audio, "the voice is in the take").toBeDefined();
  expect(duration, "the take's clip is its camera's path").toBeGreaterThan(1);

  await observeAudio(page);
  const { uploaded, card } = await playTake(page, "Camera take", glb, true);
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await mkdir(evidenceDir, { recursive: true });

  // The sound control exists once the voice decodes; the feed starts muted, so unmute it.
  await reachFor(card);
  const sound = card.getByRole("button", { name: /^(Mute|Unmute) audio$/ });
  await expect(sound, "the take's voice has its sound control").toHaveCount(1);
  await card.getByRole("button", { name: "Unmute audio" }).click();
  await expect(card.getByRole("button", { name: "Mute audio" }), "the voice is unmuted").toHaveCount(1);
  await expect.poll(async () => (await readAudio(page)).playing.filter((source) => source.gain === 1).length, { message: "an unmuted voice source is playing", timeout: 15_000 }).toBe(1);
  const audio = await readAudio(page);
  expect(audio.contextState, "the audio context runs").toBe("running");
  expect(audio.playing, "one voice plays, once").toHaveLength(1);
  expect(audio.playing[0]!.duration, "the voice has length").toBeGreaterThan(0.5);

  // Playback: the clip's time advances as the wall clock does and wraps at the take's duration.
  const { clip, samples } = await sampleLoop(page, uploaded.url, LOOP_SAMPLE_MS);
  expect(Math.abs(clip - duration), "the playing clip is the take's").toBeLessThan(0.01);
  let wraps = 0;
  let worstClockError = 0;
  let highest = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const [wall, time] = samples[i]!;
    const [previousWall, previousTime] = samples[i - 1]!;
    const wrapped = time < previousTime;
    if (wrapped) wraps += 1;
    const advanced = time - previousTime + (wrapped ? duration : 0);
    worstClockError = Math.max(worstClockError, Math.abs(advanced - (wall - previousWall) / 1000));
    highest = Math.max(highest, time);
  }
  expect(wraps, `the take loops in ${LOOP_SAMPLE_MS / 1000} s`).toBeGreaterThanOrEqual(2);
  expect(worstClockError, "time passes as the wall clock does across each wrap, so the loop is the take's duration").toBeLessThan(CLOCK_TOLERANCE_S);
  expect(highest, "playback reaches the end of the take").toBeGreaterThan(duration - 0.5);
  expect(highest, "and never passes it").toBeLessThanOrEqual(duration + 1e-3);

  // Framing: the set (not the camera, the bubble's sphere or any prop's name) fills the viewing box.
  const feed = await readFeed(page, uploaded.id);
  const { box, setRect: rect } = feed;
  const { offsetX, offsetY } = expectFramed(feed);
  expect(feed.modelAt, "the feed leaves the set where it was exported").toEqual([0, 0, 0]);
  expect(feed.clocheBaseY, "the dome stands on the set's origin, the recorded floor").not.toBeNull();
  expect(Math.abs(feed.clocheBaseY!), "the dome's foot is on the set's origin").toBeLessThanOrEqual(ONE_CM);
  await card.screenshot({ path: path.join(evidenceDir, "feed-card.png") });

  // Quick Look: the API converts the take and says so.
  await expect.poll(async () => ((await (await page.request.get(`/api/holograms/${uploaded.id}`)).json()) as { usdzStatus: string }).usdzStatus, { timeout: 120_000, intervals: [2_000], message: "USDZ conversion" }).toBe("ready");
  const usdz = await page.request.get(`/api/holograms/${uploaded.id}/usdz`, { timeout: 120_000 });
  expect(usdz.ok(), "the converted USDZ downloads").toBe(true);
  expect(usdz.headers()["content-type"]).toContain("model/vnd.usdz+zip");
  const usdzBytes = await usdz.body();
  expect(usdzBytes.subarray(0, 2).toString("latin1"), "a USDZ is a zip").toBe("PK");
  await writeFile(path.join(evidenceDir, "camera-take.usdz"), usdzBytes);

  // AR: the set at recorded scale, standing on its own origin, which is the group's.
  await enterAr(page, uploaded.id);
  const ar = await readAr(page);
  expect(ar.scale.every((s) => Math.abs(s - 1) < 1e-6), `recorded scale, not rescaled (${ar.scale.join(", ")})`).toBe(true);
  expect(distance(ar.modelAt, [0, 0, 0]), "the model's origin is the hologram's: no lift by bounds, no bone anchor").toBeLessThanOrEqual(ONE_CM);
  expect(distance(ar.sphereAt, [0, 0, 0]), "the set's origin, where the bubble stands, is the hologram's").toBeLessThanOrEqual(ONE_CM);
  expect(ar.sceneGroundMin, "the bubble's sphere reaches far below, as it always does").toBeLessThan(-1);
  expect(distance(size(ar), size(feed)), "the set has the same size in AR as in the feed").toBeLessThanOrEqual(ONE_CM);
  expect(distance(ar.min, feed.min), "and stands in the same place around its origin").toBeLessThanOrEqual(ONE_CM);
  expect(["hit-test", "floor"], "placed on a surface or the floor").toContain(ar.placement.mode);
  expect(Math.abs(ar.groupY - ar.placement.position![1]), "the origin is on the surface it was placed on").toBeLessThanOrEqual(ONE_CM);
  expect(ar.clocheBaseY, "AR draws the dome").not.toBeNull();
  expect(Math.abs(ar.clocheBaseY!), "its foot is on the set's origin").toBeLessThanOrEqual(ONE_CM);
  await page.screenshot({ path: path.join(evidenceDir, "ar-placed.png") });

  // The gallery tile: the set (floor to top, bubble's sphere left out) fills the tile's size, on its origin.
  const tile = await readGalleryPreview(page, uploaded.id);
  expect(Math.abs(tile.extent - SHELF_PREVIEW_M), "the set's largest extent is the tile's size").toBeLessThanOrEqual(ONE_CM);
  expect(Math.abs(tile.positionY), "the set stands on the tile by its origin, not lifted by the sphere").toBeLessThanOrEqual(1e-6);
  expect(Math.abs(tile.originY), "and nothing of the set is below its origin").toBeLessThanOrEqual(ONE_CM);
  expect(tile.sphereExtent, "the bubble's sphere would have been far larger than the tile").toBeGreaterThan(SHELF_PREVIEW_M * 2);

  real = { feed, ar };
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify({
    take: takeFile,
    durationS: duration,
    loop: { clipS: clip, wraps, worstClockErrorS: worstClockError, highestS: highest, samples: samples.length },
    audio,
    feed: { setRect: rect, box, offset: [offsetX, offsetY], clocheBaseY: feed.clocheBaseY, set: { min: feed.min, max: feed.max } },
    usdz: { status: "ready", bytes: usdzBytes.length },
    tile,
    ar: { scale: ar.scale, modelAt: ar.modelAt, sphereAt: ar.sphereAt, groupAt: ar.groupAt, placement: ar.placement, clocheBaseY: ar.clocheBaseY, set: { min: ar.min, max: ar.max } }
  }, null, 2));
});

test("props named Hips and Head do not take over: the same take frames and anchors identically", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture export and a live API.");
  test.setTimeout(240_000);
  expect(real, "the take's own test ran first").toBeDefined();
  const renamed = withBoneNames(await readFile(takeFile));
  expect(parseGlb(renamed).json.nodes.filter((node) => node.name === "Hips" || node.name === "Head").length, "the props are named like bones").toBe(2);

  const { uploaded, card } = await playTake(page, "Camera take bone names", renamed, false);
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  // The take's own test read it with the cursor over the card (its controls out) after seconds of playing: the same here.
  await reachFor(card);
  let feed = await readFeed(page, uploaded.id);
  await expect.poll(async () => {
    const before = feed.camera;
    feed = await readFeed(page, uploaded.id);
    return distance(before, feed.camera);
  }, { message: "the card's camera settles", timeout: 15_000, intervals: [500] }).toBeLessThan(1e-3);
  expectFramed(feed);
  expect(distance(feed.camera, real!.feed.camera), "the card's camera is where it was").toBeLessThanOrEqual(ONE_CM);
  expect(distance(feed.min, real!.feed.min) + distance(feed.max, real!.feed.max), "the set is where it was").toBeLessThanOrEqual(ONE_CM);
  expect(feed.modelAt).toEqual([0, 0, 0]);

  await enterAr(page, uploaded.id);
  const ar = await readAr(page);
  expect(distance(ar.modelAt, [0, 0, 0]), "AR anchors on the set's origin, not on a node called Hips").toBeLessThanOrEqual(ONE_CM);
  expect(distance(ar.sphereAt, [0, 0, 0])).toBeLessThanOrEqual(ONE_CM);
  expect(distance(ar.min, real!.ar.min), "the set stands where it did").toBeLessThanOrEqual(ONE_CM);
  expect(distance(ar.max, real!.ar.max)).toBeLessThanOrEqual(ONE_CM);
  expect(Math.abs((ar.clocheBaseY ?? Number.NaN) - (real!.ar.clocheBaseY ?? Number.NaN)), "the dome stands where it did").toBeLessThanOrEqual(ONE_CM);
  await page.screenshot({ path: path.join(evidenceDir, "ar-placed-bone-names.png") });
});

// The author's camera in the viewer (AR recording, slice 4, Q1 A): a mark in
// the author's identity hue and initial at RecordedAuthorCamera, turned the way
// it looked, with the clip; a camera link's ink runs from it to its referent
// during the link's span.

// The link is the take's own: the hold capture recorded on the bracket (set in beforeAll from the take's HOLOIM_meaning).
let SPAN = { start: 1.0, end: 2.2 };
let IN_SPAN_TIMES = [1.2, 1.6, 2.0];
let OUTSIDE_SPAN_TIMES = [0.3, 2.8];
const PRESENCE_TIMES = [0, 0.8, 1.6, 2.4, 3.1];
const MARK_FACING_TOLERANCE_DEG = 3;
/** The mark is sized a frame behind the card's camera, which moves when the card is orbited or zoomed. */
const MARK_SIZE_TOLERANCE_PX = 0.75;
let REFERENT = "RecordedObject";
let REFERENT_POINT: Vec3 = [0, 0, 0];

/** The camera node's pose at `time` from the file's own keyframes: the oracle for what the viewer plays. */
function cameraPoseAt(json: GltfJson, bin: Buffer, time: number): { position: Vec3; forward: Vec3 } {
  const index = json.nodes.findIndex((node) => node.name === "RecordedAuthorCamera");
  const animation = json.animations[0]!;
  const read = (accessorIndex: number, width: number): number[][] => {
    const accessor = json.accessors[accessorIndex]!;
    const view = json.bufferViews[accessor.bufferView]!;
    const base = 8 + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return Array.from({ length: accessor.count }, (_, row) => Array.from({ length: width }, (_, col) => bin.readFloatLE(base + (row * width + col) * 4)));
  };
  const sample = (path: string, width: number): { a: number[]; b: number[]; t: number } => {
    const channel = animation.channels.find((candidate) => candidate.target.node === index && candidate.target.path === path)!;
    const sampler = animation.samplers[channel.sampler]!;
    const times = read(sampler.input, 1).map(([t]) => t!);
    const values = read(sampler.output, width);
    if (time <= times[0]!) return { a: values[0]!, b: values[0]!, t: 0 };
    if (time >= times.at(-1)!) return { a: values.at(-1)!, b: values.at(-1)!, t: 0 };
    const upper = times.findIndex((t) => t >= time);
    return { a: values[upper - 1]!, b: values[upper]!, t: (time - times[upper - 1]!) / (times[upper]! - times[upper - 1]!) };
  };
  const moved = sample("translation", 3);
  const turned = sample("rotation", 4);
  const position = moved.a.map((value, i) => value + (moved.b[i]! - value) * moved.t) as Vec3;
  const rotation = new Quaternion(...(turned.a as [number, number, number, number])).slerp(new Quaternion(...(turned.b as [number, number, number, number])), turned.t);
  const forward = new Vector3(0, 0, -1).applyQuaternion(rotation);
  return { position, forward: forward.toArray() as Vec3 };
}

/** Moves the paused animation to `seconds`, as playback would have. */
async function seek(page: Page, modelPath: string, seconds: number): Promise<void> {
  await page.evaluate(([target, time]) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { actions: Record<string, { time: number } | null>; mixer: { update: (delta: number) => void } }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
  }, [modelPath, seconds] as const);
}

type InkReading = {
  index: number;
  style: string;
  strength: number;
  referent: string;
  line: boolean;
  fromKind: "bone" | "camera";
  ink: { from: Vec3; to: Vec3 } | null;
  inkHex: string | null;
};

type MarkReading = {
  present: boolean;
  chrome: boolean;
  /** Every mesh and sprite in the mark is chrome too. */
  allChrome: boolean;
  nodeAt: Vec3;
  markAt: Vec3;
  /** Where the nose's tip stands against the mark, as a unit vector. */
  noseDirection: Vec3;
  /** The node's -Z axis in the world. */
  nodeBack: Vec3;
  /** Its diameter on screen, in CSS px, and where it stands on the page. */
  screenDiameter: number;
  screenAt: [number, number];
  identity: { index: number; hex: string; initial: string } | null;
  markCount: number;
  /** Where the link's referent point stands in the world. */
  referentAt: Vec3;
};

async function readMark(page: Page, modelPath: string): Promise<MarkReading> {
  return page.evaluate(async ([target, referentName, referentPoint]) => {
    const moduleUrl = "/node_modules/.vite/deps/three.js";
    const { Vector3 } = await import(moduleUrl) as typeof Three;
    const probes = (window as unknown as { __portalProbes: Record<string, {
      model: Three.Object3D;
      camera: Three.PerspectiveCamera;
      renderer: Three.WebGLRenderer;
      presence: { node: Three.Object3D | null; mark: Three.Object3D | null; nose: Three.Mesh | null; identity: { index: number; hex: string; initial: string } | null; diameter: number };
    }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    const { node, mark, nose, identity } = probe.presence;
    const referent = probe.model.getObjectByName(referentName as string)!;
    referent.updateWorldMatrix(true, false);
    const referentAt = new Vector3(...(referentPoint as [number, number, number])).applyMatrix4(referent.matrixWorld);
    let markCount = 0;
    probe.model.traverse((child) => { if (child.name === "RecordedAuthorCameraMark") markCount += 1; });
    if (!node || !mark || !nose) {
      return { present: false, chrome: false, allChrome: false, nodeAt: [0, 0, 0], markAt: [0, 0, 0], noseDirection: [0, 0, 0], nodeBack: [0, 0, 0], screenDiameter: 0, screenAt: [0, 0], identity: null, markCount, referentAt: referentAt.toArray() as [number, number, number] };
    }
    node.updateWorldMatrix(true, false);
    mark.updateWorldMatrix(true, true);
    const nodeAt = node.getWorldPosition(new Vector3());
    const markAt = mark.getWorldPosition(new Vector3());
    nose.geometry.computeBoundingBox();
    const tip = nose.localToWorld(new Vector3(0, 0, nose.geometry.boundingBox!.min.z));
    const noseDirection = tip.sub(markAt).normalize();
    const nodeBack = new Vector3(0, 0, -1).transformDirection(node.matrixWorld);
    let allChrome = true;
    mark.traverse((child) => { if (child.userData.holoimChrome !== true) allChrome = false; });
    const { camera, renderer } = probe;
    camera.updateMatrixWorld();
    const canvas = renderer.domElement.getBoundingClientRect();
    const toPage = (point: Three.Vector3): [number, number] => {
      const ndc = point.clone().project(camera);
      return [canvas.left + ((ndc.x + 1) / 2) * canvas.width, canvas.top + ((1 - ndc.y) / 2) * canvas.height];
    };
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const diameter = probe.presence.diameter;
    const [x1, y1] = toPage(markAt.clone().addScaledVector(right, diameter / 2));
    const [x2, y2] = toPage(markAt.clone().addScaledVector(right, -diameter / 2));
    return {
      present: true,
      chrome: mark.userData.holoimChrome === true,
      allChrome,
      nodeAt: nodeAt.toArray() as [number, number, number],
      markAt: markAt.toArray() as [number, number, number],
      noseDirection: noseDirection.toArray() as [number, number, number],
      nodeBack: nodeBack.toArray() as [number, number, number],
      screenDiameter: Math.hypot(x1 - x2, y1 - y2),
      screenAt: toPage(markAt),
      identity,
      markCount,
      referentAt: referentAt.toArray() as [number, number, number]
    };
  }, [modelPath, REFERENT, REFERENT_POINT] as const);
}

async function readInk(page: Page, modelPath: string): Promise<InkReading[]> {
  return page.evaluate((target) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { pointing: { links: InkReading[] } }> }).__portalProbes;
    return JSON.parse(JSON.stringify(Object.entries(probes).find(([url]) => url.endsWith(target))![1].pointing.links)) as InkReading[];
  }, modelPath);
}

/** Seeks, waits for the ink to reach `expected` links, and one more frame so a screenshot shows what was read. */
async function settleInk(page: Page, modelPath: string, seconds: number, expected: number): Promise<InkReading[]> {
  await seek(page, modelPath, seconds);
  await expect.poll(async () => (await readInk(page, modelPath)).length, { timeout: 15_000 }).toBe(expected);
  await page.waitForTimeout(400);
  return readInk(page, modelPath);
}

/**
 * What the dome is fitted to, with and without the mark on the camera node:
 * the same drawn bounds, drawn points and motion points, exactly.
 */
async function readFitWithAndWithoutMark(page: Page, modelPath: string): Promise<{ with: FitReading; without: FitReading }> {
  return page.evaluate(async (target) => {
    const sourceUrl = "/src/features/hologram/drawnPoints.ts";
    const points = await import(/* @vite-ignore */ sourceUrl) as typeof DrawnPoints;
    const probes = (window as unknown as { __portalProbes: Record<string, {
      model: Three.Object3D;
      actions: Record<string, { getClip: () => Three.AnimationClip } | null>;
      bubble: { active: boolean; radius: number; center: Three.Vector3 };
      presence: { node: Three.Object3D | null; mark: Three.Object3D | null };
    }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target))![1];
    const { node, mark } = probe.presence;
    const clips = Object.values(probe.actions).filter(Boolean).map((action) => action!.getClip());
    const bubble = probe.bubble.active && probe.bubble.radius > 0 ? { center: probe.bubble.center.clone(), radius: probe.bubble.radius } : null;
    const read = (): FitReading => {
      const bounds = points.drawnBounds(probe.model);
      const drawn = points.drawnPoints(probe.model, bubble);
      const motion = points.motionPoints(probe.model, clips, { bubble });
      const flat = (list: Three.Vector3[]) => list.flatMap((point) => point.toArray());
      return { bounds: [...bounds.min.toArray(), ...bounds.max.toArray()], drawn: flat(drawn), motion: flat(motion) };
    };
    const withMark = read();
    node!.remove(mark!);
    const withoutMark = read();
    node!.add(mark!);
    return { with: withMark, without: withoutMark };
  }, modelPath);
}

type FitReading = { bounds: number[]; drawn: number[]; motion: number[] };

/** The page's pixels at CSS rectangle `clip`, as RGBA rows: a PNG decoded in the page. */
async function pixelsAt(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<{ width: number; height: number; scale: number; data: number[] }> {
  const png = await page.screenshot({ clip });
  return page.evaluate(async ([base64, width]) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64 as string}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, scale: image.width / (width as number), data: Array.from(context.getImageData(0, 0, image.width, image.height).data) };
  }, [png.toString("base64"), clip.width] as const);
}

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const angleDegrees = (a: readonly number[], b: readonly number[]): number => {
  const dot = a.reduce((sum, value, i) => sum + value * b[i]!, 0) / (Math.hypot(...a) * Math.hypot(...b));
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
};

test("a camera take shows the author's camera as a mark that follows the clip, and a camera link's ink runs from it to its referent", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture export and a live API.");
  test.setTimeout(300_000);
  expect(real, "the take's own test ran first").toBeDefined();
  await mkdir(evidenceDir, { recursive: true });
  const original = await readFile(takeFile);
  const { json: fileJson, rest: bin } = parseGlb(original);
  const duration = takeDurationSeconds(fileJson);
  expect(fileJson.nodes.findIndex((node) => node.name === "RecordedAuthorCamera"), "the camera node has no parent: its pose in the file is its pose in the set's frame").toBeGreaterThanOrEqual(0);

  const { uploaded, card } = await playTake(page, "Camera take link", original, false);
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await card.getByRole("button", { name: CONTROL_NAMES.pause }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "true");
  const identity = identityOf("camera-take-e2e");
  // The card's camera eases in over its first seconds; the mark's size follows it a frame behind, so read once it rests.
  let previousCamera = (await readFeed(page, uploaded.id)).camera;
  await expect.poll(async () => {
    const camera = (await readFeed(page, uploaded.id)).camera;
    const moved = distance(previousCamera, camera);
    previousCamera = camera;
    return moved;
  }, { message: "the card's camera settles", timeout: 15_000, intervals: [500] }).toBeLessThan(1e-3);

  // The mark follows the clip: where the file's keyframes put the camera and where it looked, at several times.
  const reads: Array<{ time: number; mark: MarkReading; expected: ReturnType<typeof cameraPoseAt> }> = [];
  for (const time of PRESENCE_TIMES) {
    await seek(page, uploaded.url, time);
    await page.waitForTimeout(200);
    const mark = await readMark(page, uploaded.url);
    const expected = cameraPoseAt(fileJson, bin, time);
    reads.push({ time, mark, expected });
    expect(mark.present, `the camera take shows the author's camera at ${time}s`).toBe(true);
    expect(mark.markCount, "one mark").toBe(1);
    expect(distance(mark.markAt, expected.position), `at ${time}s the mark stands where the file's keyframes put the camera`).toBeLessThanOrEqual(ONE_CM);
    expect(distance(mark.markAt, mark.nodeAt), "and on the camera node").toBeLessThanOrEqual(ONE_CM);
    expect(angleDegrees(mark.noseDirection, expected.forward), `at ${time}s the mark faces the way the camera looked`).toBeLessThanOrEqual(MARK_FACING_TOLERANCE_DEG);
    expect(angleDegrees(mark.noseDirection, mark.nodeBack), "and along the node's -Z").toBeLessThanOrEqual(MARK_FACING_TOLERANCE_DEG);
    expect(mark.chrome && mark.allChrome, "the mark is chrome: framing, the dome and hit tests never see it").toBe(true);
    expect(mark.identity, "the author's identity").toEqual(identity);
    expect(Math.abs(mark.screenDiameter - tokens.mark.size), `the mark is ${tokens.mark.size} apx across (1 apx is 1 CSS px on a flat screen)`).toBeLessThanOrEqual(MARK_SIZE_TOLERANCE_PX);
  }
  const travelled = Math.max(...reads.map((r) => distance(r.mark.markAt, reads[0]!.mark.markAt)));
  const turned = Math.max(...reads.map((r) => angleDegrees(r.mark.noseDirection, reads[0]!.mark.noseDirection)));
  expect(travelled, "the camera really moves in the take, so the follow is not a still pose").toBeGreaterThan(0.3);
  expect(turned, "and turns").toBeGreaterThan(5);

  // The dome and framing ignore the mark: the same fit with and without it, and the same card as before the mark.
  const fit = await readFitWithAndWithoutMark(page, uploaded.url);
  expect(fit.with.bounds, "drawn bounds").toEqual(fit.without.bounds);
  expect(fit.with.drawn.length, "drawn points").toBe(fit.without.drawn.length);
  expect(fit.with.drawn).toEqual(fit.without.drawn);
  expect(fit.with.motion).toEqual(fit.without.motion);
  expect(fit.with.drawn.length, "the set has drawn points").toBeGreaterThan(0);
  const feed = await readFeed(page, uploaded.id);
  expectFramed(feed);
  expect(distance(feed.camera, real!.feed.camera), "the card's camera is where the take's own test read it").toBeLessThanOrEqual(ONE_CM);
  expect(distance(feed.min, real!.feed.min) + distance(feed.max, real!.feed.max), "the set is where it was").toBeLessThanOrEqual(ONE_CM);
  expect(Math.abs((feed.clocheBaseY ?? Number.NaN)), "the dome stands on the set's origin").toBeLessThanOrEqual(ONE_CM);

  // The ink: absent outside the span, from the mark to the referent inside it, in the author's hue.
  for (const time of OUTSIDE_SPAN_TIMES) {
    expect(await settleInk(page, uploaded.url, time, 0), `no ink at ${time}s, outside ${SPAN.start} to ${SPAN.end} s`).toEqual([]);
  }
  const inks: Array<{ time: number; ink: InkReading; mark: MarkReading }> = [];
  for (const time of IN_SPAN_TIMES) {
    const [ink, ...others] = await settleInk(page, uploaded.url, time, 1);
    expect(others).toEqual([]);
    expect(ink, `ink at ${time}s`).toMatchObject({ fromKind: "camera", style: "recorded", referent: REFERENT, line: true, strength: 1 });
    const mark = await readMark(page, uploaded.url);
    expect(distance(ink!.ink!.from, mark.markAt), `at ${time}s the ink starts at the mark`).toBeLessThanOrEqual(ONE_CM);
    expect(distance(ink!.ink!.from, cameraPoseAt(fileJson, bin, time).position), "which is where the camera was").toBeLessThanOrEqual(ONE_CM);
    expect(distance(ink!.ink!.to, mark.referentAt), `and ends at the referent's point`).toBeLessThanOrEqual(ONE_CM);
    expect(ink!.inkHex, "in the author's identity hue").toBe(identity.hex);
    inks.push({ time, ink: ink!, mark });
  }
  expect(distance(inks[0]!.ink.ink!.from, inks.at(-1)!.ink.ink!.from), "the ink's start travels with the camera across the span").toBeGreaterThan(0.1);
  await settleInk(page, uploaded.url, 2.6, 0);

  // The mark on screen: its hue is the author's, its initial in deep sea.
  const middle = IN_SPAN_TIMES[1]!;
  await settleInk(page, uploaded.url, middle, 1);
  const shown = await readMark(page, uploaded.url);
  const half = 14;
  const clip = { x: Math.round(shown.screenAt[0] - half), y: Math.round(shown.screenAt[1] - half), width: half * 2, height: half * 2 };
  await card.screenshot({ path: path.join(evidenceDir, "feed-card-camera-mark-ink.png") });
  await page.screenshot({ path: path.join(evidenceDir, "feed-card-camera-mark-zoom.png"), clip: { x: clip.x - 60, y: clip.y - 60, width: 150, height: 150 } });
  const pixels = await pixelsAt(page, clip);
  const at = (dx: number, dy: number): [number, number, number] => {
    const x = Math.round((half + dx) * pixels.scale);
    const y = Math.round((half + dy) * pixels.scale);
    const i = (y * pixels.width + x) * 4;
    return [pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!];
  };
  const hue = hexToRgb(identity.hex);
  const ring = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4).map((angle) => at(7 * Math.cos(angle) + (shown.screenAt[0] - Math.round(shown.screenAt[0])), 7 * Math.sin(angle)));
  const faceMatches = ring.filter((rgb) => rgb.every((value, i) => Math.abs(value - hue[i]!) <= 24)).length;
  expect(faceMatches, `the mark's face is the author's hue ${identity.hex} (${ring.map((rgb) => rgb.join(",")).join(" | ")})`).toBeGreaterThanOrEqual(6);
  // The initial is thin type on a small face: count the pixels that read as deep sea ink rather than the hue, by how dark they are.
  const lightness = (rgb: readonly number[]) => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
  let initialPixels = 0;
  for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
    if (lightness(at(dx, dy)) < lightness(hue) * 0.6) initialPixels += 1;
  }
  expect(initialPixels, `the initial "${identity.initial}" is drawn in deep sea on the face`).toBeGreaterThanOrEqual(6);

  // Outside the span the mark still stands where the camera is, with no ink.
  await settleInk(page, uploaded.url, OUTSIDE_SPAN_TIMES[1]!, 0);
  const outside = await readMark(page, uploaded.url);
  expect(outside.present).toBe(true);
  expect(distance(outside.markAt, cameraPoseAt(fileJson, bin, OUTSIDE_SPAN_TIMES[1]!).position)).toBeLessThanOrEqual(ONE_CM);
  await card.screenshot({ path: path.join(evidenceDir, "feed-card-camera-mark-outside-span.png") });

  // Orbiting the card keeps the mark on the camera, the same size on screen, and the ink on its referent.
  await settleInk(page, uploaded.url, middle, 1);
  const box = await page.locator(`.feed-card[data-card-id="${uploaded.id}"] .feed-card-portal`).boundingBox();
  const centre = { x: box!.x + box!.width / 2, y: box!.y + box!.height * 0.4 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x - 20, centre.y - 5, { steps: 2 });
  await page.mouse.move(centre.x - 220, centre.y - 30, { steps: 6 });
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-portal-mode", "free");
  const [orbited] = await settleInk(page, uploaded.url, middle, 1);
  const orbitedMark = await readMark(page, uploaded.url);
  expect(distance(orbitedMark.markAt, cameraPoseAt(fileJson, bin, middle).position), "after orbiting, the mark is still on the camera").toBeLessThanOrEqual(ONE_CM);
  expect(distance(orbited!.ink!.from, orbitedMark.markAt), "and the ink still starts at it").toBeLessThanOrEqual(ONE_CM);
  expect(distance(orbited!.ink!.to, orbitedMark.referentAt), "and ends on the referent").toBeLessThanOrEqual(ONE_CM);
  expect(Math.abs(orbitedMark.screenDiameter - tokens.mark.size), "the mark keeps its size on screen").toBeLessThanOrEqual(MARK_SIZE_TOLERANCE_PX);
  await card.screenshot({ path: path.join(evidenceDir, "feed-card-camera-mark-orbited.png") });

  await writeFile(path.join(evidenceDir, "camera-mark-report.json"), JSON.stringify({
    link: "recorded by capture's hold on the bracket during the walk (apps/capture/scripts/lib/camera-take-recording.ts)",
    referent: REFERENT,
    referentPoint: REFERENT_POINT,
    span: SPAN,
    identity,
    markSizeApx: tokens.mark.size,
    presence: reads.map((r) => ({
      time: r.time,
      markAt: r.mark.markAt,
      keyframeAt: r.expected.position,
      positionErrorM: distance(r.mark.markAt, r.expected.position),
      facingErrorDeg: angleDegrees(r.mark.noseDirection, r.expected.forward),
      screenDiameterPx: r.mark.screenDiameter
    })),
    cameraTravelM: travelled,
    cameraTurnDeg: turned,
    ink: inks.map((i) => ({ time: i.time, from: i.ink.ink!.from, to: i.ink.ink!.to, markAt: i.mark.markAt, referentAt: i.mark.referentAt, startErrorM: distance(i.ink.ink!.from, i.mark.markAt), endErrorM: distance(i.ink.ink!.to, i.mark.referentAt), hex: i.ink.inkHex })),
    fit: { boundsEqual: true, drawnPoints: fit.with.drawn.length / 3, motionPoints: fit.with.motion.length / 3, bounds: fit.with.bounds },
    feed: { camera: feed.camera, setRect: feed.setRect, box: feed.box, clocheBaseY: feed.clocheBaseY, cameraAgainstTakesOwnTestM: distance(feed.camera, real!.feed.camera) },
    face: { ring, initialPixels },
    durationS: duration
  }, null, 2));
});

test("a performer's take has no camera mark", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(180_000);
  const { uploaded, card } = await playTake(page, "Performer take", buildPointingGlb(), false);
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  const reading = await page.evaluate((target) => {
    const probes = (window as unknown as { __portalProbes: Record<string, { model: Three.Object3D; presence: { mark: unknown; node: unknown } }> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target))![1];
    let marks = 0;
    probe.model.traverse((child) => { if (child.name === "RecordedAuthorCameraMark" || child.userData.holoimChrome === true) marks += 1; });
    return { marks, mark: probe.presence.mark, node: probe.presence.node };
  }, uploaded.url);
  expect(reading, "no presence mark in a take with a performer").toEqual({ marks: 0, mark: null, node: null });
});
