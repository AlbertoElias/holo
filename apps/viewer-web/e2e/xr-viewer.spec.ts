import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import { waitForIwerRuntime, waitForIwerSession, waitForNoIwerSession } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, captureEvidence, expect, test } from "./bootstrap";

// The IWSDK immersive viewer (docs/features/viewer-xr-interface.md, step 2):
// `/vr/:id` and `/ar/:id?shell=iwsdk` mount one IWSDK World with one hologram
// at recorded scale. The page's development probe (`__HOLOIM_XR_VIEWER__`)
// reports placement, scale, playback and audio; each test adds its readings
// to `output/test-results/xr-viewer-report.json`.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const avatarGlbPath = path.resolve(testDir, "../../capture/public/gltf/models/avatar.glb");
const reportPath = path.resolve(testDir, "../../../output/test-results/xr-viewer-report.json");
const AUDIO_SECONDS = 30;
const CLIP_STRETCH = 8;
const AUDIO_SYNC_TOLERANCE_S = 0.05;
// Mean Rec. 709 luminance (0-255) of the hologram's pixels; a black
// silhouette reads near 0.
const HOLOGRAM_MIN_MEAN_LUMINANCE = 30;

const mockHologram = {
  id: "mock-1",
  url: "/uploads/mock-avatar.glb",
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-10-24T00:00:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: "mock-avatar.glb",
  hologramName: "Mock Runner",
  submittedBy: "automation"
} as const;

type Vec3 = [number, number, number];
type ViewerSnapshot = {
  mode: "vr" | "ar";
  session: { active: boolean; environmentBlendMode?: string | null };
  placement: { stage: string; mode: string | null; sequence: number; position: Vec3 | null };
  hologram: {
    visible: boolean;
    worldPosition: Vec3;
    worldScale: Vec3;
    yaw: number;
    tiltRad: number;
    grabbed: boolean;
    recordedSize: Vec3;
    playing: boolean;
    clipTime: number;
    duration: number;
    actionTimes: number[];
    audio: { playing: boolean; scheduledOffset: number; duration: number } | null;
  };
  controls: Controls | null;
  renderer: { geometries: number; textures: number; calls: number };
};
type FootProbe = {
  target: string;
  worldPosition: Vec3;
  worldScale: number;
  yaw: number;
  opacity: number;
  dimInMs: number;
  revealed: boolean;
  reachOpacity: number;
  near: { hover: boolean; hand: boolean; headRay: boolean };
  labelOpacity: number;
  chipOpacity: number;
  metresPerApx: number;
  sizes: { glyphIconApx: number; ringApx: number; strokeApx: number; hitApx: number };
  text: { playback: string; elapsedTotal: string; scale: string };
  buttons: Record<"play" | "restart" | "recenter" | "scale", { worldPosition: Vec3; visible: boolean }>;
  timeline: { worldStart: Vec3; worldEnd: Vec3; fraction: number };
};
type Controls = {
  target: "vr" | "ar-quest" | "ar-phone";
  foot: FootProbe;
  status: { visible: boolean; text: string; worldPosition: Vec3; interactive: boolean };
  dock: { mount: "hand" | "phone"; visible: boolean; metresPerApx: number; hitApx: number; glyphApx: number; buttons: Record<string, { worldPosition: Vec3 }> };
};

const report: Record<string, unknown> = {};
// XR_PROOF_VIDEO=1 holds key moments a little longer for the proof recording.
const PROOF_DWELL_MS = process.env.XR_PROOF_VIDEO === "1" ? 1200 : 0;

/** Milestones in ms since the test started, for the report and for cutting recordings. */
function createTimeline() {
  const startedAt = Date.now();
  const marks: Array<{ label: string; ms: number }> = [];
  const mark = (label: string) => void marks.push({ label, ms: Date.now() - startedAt });
  // The first navigation commit is when a recording stops being blank: it anchors cuts.
  const markFirstCommit = (page: Page) => page.once("framenavigated", () => mark("first-commit"));
  return { marks, mark, markFirstCommit };
}
const dwell = (page: Page, factor = 1) => (PROOF_DWELL_MS ? page.waitForTimeout(PROOF_DWELL_MS * factor) : Promise.resolve());

test.afterAll(async () => {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`);
});

/** Tone in a 16-bit mono WAV, long enough that the clip loops before it ends. */
function toneWav(seconds: number, sampleRate = 8000): Buffer {
  const samples = seconds * sampleRate;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 220) * 3000), 44 + i * 2);
  return wav;
}

/** The avatar fixture with a KHR_audio clip appended, as recordings embed it. */
async function avatarWithAudio(): Promise<Buffer> {
  const glb = await readFile(avatarGlbPath);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as {
    buffers: Array<{ byteLength: number }>;
    bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
    accessors: Array<{ bufferView: number; byteOffset?: number; count: number; min?: number[]; max?: number[] }>;
    animations?: Array<{ samplers: Array<{ input: number }> }>;
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  const binStart = 20 + jsonLength;
  const bin = Buffer.from(glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart)));
  // Slow the avatar's 1 s loops to CLIP_STRETCH seconds, so scrubbing and
  // restart have a clip long enough to tell positions apart.
  const inputs = new Set((json.animations ?? []).flatMap((animation) => animation.samplers.map((sampler) => sampler.input)));
  for (const index of inputs) {
    const accessor = json.accessors[index]!;
    const start = (json.bufferViews[accessor.bufferView]!.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let i = 0; i < accessor.count; i++) bin.writeFloatLE(bin.readFloatLE(start + i * 4) * CLIP_STRETCH, start + i * 4);
    accessor.min = accessor.min?.map((v) => v * CLIP_STRETCH);
    accessor.max = accessor.max?.map((v) => v * CLIP_STRETCH);
  }
  const wav = toneWav(AUDIO_SECONDS);
  const audioOffset = Math.ceil(bin.length / 4) * 4;
  const newBin = Buffer.alloc(Math.ceil((audioOffset + wav.length) / 4) * 4);
  bin.copy(newBin);
  wav.copy(newBin, audioOffset);
  json.bufferViews.push({ buffer: 0, byteOffset: audioOffset, byteLength: wav.length });
  json.buffers[0]!.byteLength = newBin.length;
  json.extensions = {
    ...json.extensions,
    KHR_audio: {
      audio: [{ bufferView: json.bufferViews.length - 1, mimeType: "audio/wav" }],
      sources: [{ audio: 0, autoPlay: true, loop: true }],
      emitters: [{ type: "global", sources: [0], gain: 1 }]
    }
  };
  json.extensionsUsed = [...(json.extensionsUsed ?? []), "KHR_audio"];
  let jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + newBin.length, 8);
  const chunk = (type: number, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, data]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonBytes), chunk(0x004e4942, newBin)]);
}

async function mockFeed(page: Page): Promise<void> {
  const glb = await avatarWithAudio();
  await page.route("**/api/holograms?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [mockHologram], nextCursor: null })
  }));
  await page.route("**/api/holograms/mock-1", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(mockHologram)
  }));
  await page.route("**/uploads/**", (route) => route.fulfill({ status: 200, body: glb, contentType: "model/gltf-binary" }));
}

/**
 * IWER has no phone profile; emulate one as the step 1 spike did: mono view,
 * no controllers or hands, and screen taps delivered as transient
 * `screen` input sources (`window.__phoneTap`).
 */
async function emulatePhone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Device = {
      stereoEnabled: boolean;
      fovy: number;
      viewerSpace: unknown;
      controllers: Record<"left" | "right", { connected: boolean; inputSource: { targetRaySpace: object } & object }>;
      hands?: Record<"left" | "right", { connected: boolean }>;
      inputSources: unknown[];
    };
    let deviceValue: Device | undefined;
    Object.defineProperty(window, "IWER_DEVICE", {
      configurable: true,
      get: () => deviceValue,
      set: (device: Device) => {
        deviceValue = device;
        device.stereoEnabled = false;
        // A phone reports screen-space interaction (WebXR DOM Overlays); IWER keeps it in its private device state.
        for (const key of Object.getOwnPropertySymbols(device)) {
          const state = (device as unknown as Record<symbol, { interactionMode?: string }>)[key];
          if (state && typeof state === "object" && "interactionMode" in state) state.interactionMode = "screen-space";
        }
        const InputSource = device.controllers.right.inputSource.constructor as new (...args: unknown[]) => object;
        const Space = device.controllers.right.inputSource.targetRaySpace.constructor as new (...args: unknown[]) => object;
        for (const side of ["left", "right"] as const) {
          device.controllers[side].connected = false;
          if (device.hands?.[side]) device.hands[side].connected = false;
        }
        const screenSources: object[] = [];
        const baseGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(device), "inputSources")!.get!;
        Object.defineProperty(device, "inputSources", { get: () => [...(baseGetter.call(device) as unknown[]), ...screenSources] });

        const frameOf = (session: XRSession, inFrame?: (frame: XRFrame) => void) =>
          new Promise<void>((resolve) => session.requestAnimationFrame((_t, frame) => {
            inFrame?.(frame);
            resolve();
          }));
        const viewer = () => {
          const probe = (window as { __HOLOIM_XR_VIEWER__?: { world: { camera: { worldToLocal(v: unknown): { x: number; y: number; z: number }; position: { constructor: new (x: number, y: number, z: number) => object } }; renderer: { xr: { getSession(): XRSession | null } } } } }).__HOLOIM_XR_VIEWER__;
          const session = probe?.world.renderer.xr.getSession();
          if (!probe || !session) throw new Error("no XR session");
          return { camera: probe.world.camera, session };
        };
        // The ray from the viewer through a world point, as a column-major viewer-space matrix.
        const aimAt = (target: [number, number, number]): Float32Array => {
          const { camera } = viewer();
          const Vector = camera.position.constructor;
          const local = camera.worldToLocal(new Vector(...target));
          const length = Math.hypot(local.x, local.y, local.z);
          const [x, y, z] = [local.x / length, local.y / length, local.z / length];
          // Rotation taking -Z onto (x, y, z).
          const axis = [y, -x, 0];
          const axisLength = Math.hypot(axis[0]!, axis[1]!);
          const angle = Math.acos(Math.min(1, Math.max(-1, -z)));
          const [ax, ay] = axisLength > 1e-6 ? [axis[0]! / axisLength, axis[1]! / axisLength] : [1, 0];
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const t = 1 - c;
          return new Float32Array([
            t * ax * ax + c, t * ax * ay, -s * ay, 0,
            t * ax * ay, t * ay * ay + c, s * ax, 0,
            s * ay, -s * ax, c, 0,
            0, 0, 0, 1
          ]);
        };
        // A finger mark where the finger is, for recordings.
        const fingerMark = (): ((target: [number, number, number]) => void) & { remove(): void } => {
          const mark = document.createElement("div");
          mark.dataset.phoneTap = "";
          mark.style.cssText = "position:fixed;z-index:99999;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #fff3cf;background:rgb(255 200 114 / 45%)";
          document.body.append(mark);
          const move = (target: [number, number, number]) => {
            const { camera } = viewer();
            const Vector = camera.position.constructor;
            const screen = (new Vector(...target) as unknown as { project(c: unknown): { x: number; y: number } }).project(camera);
            mark.style.left = `${(screen.x + 1) / 2 * innerWidth}px`;
            mark.style.top = `${(1 - screen.y) / 2 * innerHeight}px`;
          };
          return Object.assign(move, { remove: () => setTimeout(() => mark.remove(), 600) });
        };
        const EventCtor = (globalThis as { XRInputSourceEvent?: new (type: string, init: object) => Event }).XRInputSourceEvent;
        /** A finger down toward `path[0]`, held while it moves along `path` (one point per frame), then lifted. */
        const press = async (path: Array<[number, number, number]>, holdMs: number) => {
          const { session } = viewer();
          if (!EventCtor) throw new Error("XRInputSourceEvent unavailable");
          const mark = fingerMark();
          mark(path[0]!);
          const space = new Space(device.viewerSpace, aimAt(path[0]!));
          const state = Object.getOwnPropertySymbols(space).map((key) => (space as Record<symbol, { offsetMatrix?: Float32Array }>)[key]).find((value) => value?.offsetMatrix)!;
          const source = new InputSource("none", "screen", ["generic-touchscreen", "generic-button"], space);
          screenSources.push(source);
          await frameOf(session);
          await frameOf(session, (frame) => session.dispatchEvent(new EventCtor("selectstart", { frame, inputSource: source })));
          for (const point of path.slice(1)) {
            // The finger moves: the source's target ray follows it, frame by frame.
            await frameOf(session, () => {
              state.offsetMatrix!.set(aimAt(point));
              mark(point);
            });
          }
          if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
          await frameOf(session, (frame) => {
            session.dispatchEvent(new EventCtor("select", { frame, inputSource: source }));
            session.dispatchEvent(new EventCtor("selectend", { frame, inputSource: source }));
          });
          screenSources.splice(screenSources.indexOf(source), 1);
          mark.remove();
          await frameOf(session);
        };
        // A tap toward a world point, released on the next frame: emulated frames take ~150 ms, and
        // pointer-events counts a press longer than 300 ms as no click.
        (window as { __phoneTap?: unknown }).__phoneTap = (target: [number, number, number]) => press([target], 0);
        // A held drag from one world point to another over `frames` frames.
        (window as { __phoneDrag?: unknown }).__phoneDrag = (from: [number, number, number], to: [number, number, number], frames: number) =>
          press(Array.from({ length: frames + 1 }, (_, i) => from.map((v, k) => v + (to[k]! - v) * (i / frames)) as [number, number, number]), 100);
      }
    });
  });
}

async function snapshot(page: Page): Promise<ViewerSnapshot> {
  return page.evaluate(() => {
    const probe = (window as { __HOLOIM_XR_VIEWER__?: { snapshot(): unknown } }).__HOLOIM_XR_VIEWER__;
    if (!probe) throw new Error("XR viewer probe missing");
    return probe.snapshot();
  }) as Promise<ViewerSnapshot>;
}

async function waitForSnapshot(page: Page, accept: (s: ViewerSnapshot) => boolean, timeout = 15_000): Promise<ViewerSnapshot> {
  let last: ViewerSnapshot | null = null;
  try {
    await expect.poll(async () => {
      last = await snapshot(page).catch(() => null);
      return last ? accept(last) : false;
    }, { timeout }).toBe(true);
  } catch (error) {
    // The last reading says why the wait failed.
    throw new Error(`${(error as Error).message}\nlast snapshot: ${JSON.stringify(last, (key, value) => (key === "actionTimes" ? undefined : value))}`);
  }
  return last!;
}

async function readHeadPose(page: Page): Promise<{ position: Vec3; forward: Vec3 }> {
  return page.evaluate(() => {
    const camera = (window as { __HOLOIM_XR_VIEWER__?: { world: { camera: { matrixWorld: { elements: number[] } } } } }).__HOLOIM_XR_VIEWER__!.world.camera;
    const e = camera.matrixWorld.elements;
    return { position: [e[12]!, e[13]!, e[14]!] as Vec3, forward: [-e[8]!, -e[9]!, -e[10]!] as Vec3 };
  });
}

type HologramLuminance = { pixels: number; mean: number; coverage: number };

/**
 * Mean luminance (0-255, Rec. 709) of the hologram's own pixels: those that
 * change when it is hidden for a frame. An unlit hologram renders as a black
 * silhouette and fails this; a hologram out of view has no pixels.
 */
async function measureHologramLuminance(page: Page): Promise<HologramLuminance> {
  const setVisible = (visible: boolean) => page.evaluate((v) => {
    (window as unknown as { __HOLOIM_XR_VIEWER__: { hologram: { object3D: { visible: boolean } } } }).__HOLOIM_XR_VIEWER__.hologram.object3D.visible = v;
  }, visible);
  const lit = (await page.screenshot()).toString("base64");
  await setVisible(false);
  await page.waitForTimeout(150);
  const hidden = (await page.screenshot()).toString("base64");
  await setVisible(true);
  return page.evaluate(async ({ lit, hidden }) => {
    const pixelsOf = async (png: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const [a, b] = [await pixelsOf(lit), await pixelsOf(hidden)];
    let pixels = 0;
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      const changed = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 24;
      if (!changed) continue;
      pixels++;
      sum += 0.2126 * a[i]! + 0.7152 * a[i + 1]! + 0.0722 * a[i + 2]!;
    }
    return { pixels, mean: pixels ? sum / pixels : 0, coverage: pixels / (a.length / 4) };
  }, { lit, hidden });
}

function expectHologramLit(luminance: HologramLuminance): void {
  expect(luminance.coverage, `hologram covers ${(luminance.coverage * 100).toFixed(1)}% of the view`).toBeGreaterThan(0.01);
  expect(luminance.mean, `hologram mean luminance ${luminance.mean.toFixed(1)}`).toBeGreaterThan(HOLOGRAM_MIN_MEAN_LUMINANCE);
}

/** Clip time and audio offset sampled in one evaluate, so their gap is drift. */
async function readAudioSync(page: Page): Promise<{ clipTime: number; scheduledOffset: number } | null> {
  const s = await snapshot(page);
  if (!s.hologram.audio?.playing) return null;
  return { clipTime: s.hologram.clipTime, scheduledOffset: s.hologram.audio.scheduledOffset };
}

/** Opens the route's immersive session: auto-entry on the feed tap, or the entry button. */
async function enterSession(page: Page, label: string, environmentBlendMode: "opaque" | "alpha-blend"): Promise<void> {
  const container = page.locator(".xr-view-container");
  await expect(container).toHaveAttribute("data-xr-state", /ready|immersive/, { timeout: 20_000 });
  if ((await container.getAttribute("data-xr-state")) === "ready") {
    await page.getByRole("button", { name: label }).click();
  }
  await waitForIwerSession(page, { environmentBlendMode });
  await expect(container).toHaveAttribute("data-xr-state", "immersive");
}

async function endSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as { __HOLOIM_XR_VIEWER__?: { world: { renderer: { xr: { getSession(): XRSession | null } } } } }).__HOLOIM_XR_VIEWER__;
    void probe?.world.renderer.xr.getSession()?.end();
  });
  await waitForNoIwerSession(page);
}

async function expectTornDown(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/(\?shell=iwsdk)?$/);
  await expect(page.locator(".xr-view-container")).toHaveCount(0);
  expect(await page.evaluate(() => "__HOLOIM_XR_VIEWER__" in window), "probe removed with the World").toBe(false);
  await expect(page.locator('[data-card-id="mock-1"]'), "back on the opened hologram's card").toBeInViewport({ timeout: 10_000 });
}

const phoneTap = (page: Page, target: Vec3) =>
  page.evaluate((t) => (window as unknown as { __phoneTap(t: Vec3): Promise<void> }).__phoneTap(t), target);
const phoneDrag = (page: Page, from: Vec3, to: Vec3, frames: number) =>
  page.evaluate(([f, t, n]) => (window as unknown as { __phoneDrag(f: Vec3, t: Vec3, n: number): Promise<void> }).__phoneDrag(f, t, n), [from, to, frames] as const);

type Tracked = "head" | "left" | "right";

/**
 * Moves the IWER headset or a controller and turns it to face `lookAt`
 * (yaw then pitch, no roll). Positions are in the local-floor space, which is
 * the World's space here (the player rig stays at the origin).
 */
async function setPose(page: Page, who: Tracked, position: Vec3 | null, lookAt: Vec3 | null): Promise<void> {
  await page.evaluate(({ who, position, lookAt }) => {
    type V = { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
    type Q = { set(x: number, y: number, z: number, w: number): void };
    const device = (window as unknown as { IWER_DEVICE: { controlMode: string; position: V; quaternion: Q; controllers: Record<"left" | "right", { position: V; quaternion: Q }> } }).IWER_DEVICE;
    // IWER's DevUI rewrites device and controller transforms every frame unless control is programmatic.
    device.controlMode = "programmatic";
    // Its panels and badge would cover the view in recordings.
    const devui = (device as unknown as { devui?: { devUIContainer?: HTMLElement; devUICanvas?: HTMLElement } }).devui;
    for (const element of [devui?.devUIContainer, devui?.devUICanvas]) if (element) element.style.display = "none";
    const tracked = who === "head" ? device : device.controllers[who];
    if (position) tracked.position.set(...position);
    if (lookAt) {
      const p = tracked.position;
      const [dx, dy, dz] = [lookAt[0] - p.x, lookAt[1] - p.y, lookAt[2] - p.z];
      const length = Math.hypot(dx, dy, dz);
      const yaw = Math.atan2(-dx, -dz);
      const pitch = Math.asin(dy / length);
      const [sy, cy, sp, cp] = [Math.sin(yaw / 2), Math.cos(yaw / 2), Math.sin(pitch / 2), Math.cos(pitch / 2)];
      tracked.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    }
  }, { who, position, lookAt });
  await page.waitForTimeout(60);
}

async function setButton(page: Page, side: "left" | "right", button: "trigger" | "squeeze", value: 0 | 1): Promise<void> {
  await page.evaluate(({ side, button, value }) => {
    (window as unknown as { IWER_DEVICE: { controllers: Record<string, { updateButtonValue(id: string, v: number): void }> } }).IWER_DEVICE.controllers[side]!.updateButtonValue(button, value);
  }, { side, button, value });
  await page.waitForTimeout(80);
}

/** Aims the right controller's ray at a world point and pulls the trigger. */
async function rayClick(page: Page, target: Vec3, from: Vec3 = [0.25, 1.25, -0.2]): Promise<void> {
  await setPose(page, "right", from, target);
  await page.waitForTimeout(80);
  await setButton(page, "right", "trigger", 1);
  await setButton(page, "right", "trigger", 0);
}

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const controls = async (page: Page) => (await snapshot(page)).controls!;
const footButton = async (page: Page, id: keyof FootProbe["buttons"]) => (await controls(page)).foot.buttons[id].worldPosition;

test("VR: Step inside shows the hologram at recorded scale on the floor ahead, plays it with its audio, and exit returns to its card", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  await mockFeed(page);
  await page.goto("/");
  mark("feed-loaded");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  const vrTrigger = page.locator(".vr-trigger-button");
  await expect(vrTrigger).toHaveCount(1, { timeout: 15_000 });
  await expect(vrTrigger).toHaveAttribute("aria-label", "Step inside");
  await expect(page.locator(".ar-trigger-button")).toHaveAttribute("aria-label", "View in your room");

  const visits: unknown[] = [];
  for (let visit = 1; visit <= 2; visit++) {
    await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
    mark(`feed-ready-${visit}`);
    // The portal takes a few seconds to show the figure.
    if (visit === 1) await dwell(page, 3);
    mark(`step-inside-${visit}`);
    await page.locator(".vr-trigger-button").click();
    await expect(page).toHaveURL(/\/vr\/mock-1$/);
    await enterSession(page, "Step inside", "opaque");

    const placed = await waitForSnapshot(page, (s) => s.placement.stage === "placed" && s.hologram.visible);
    mark(`vr-placed-${visit}`);
    if (visit === 1) await dwell(page);
    const head = await readHeadPose(page);
    const [px, py, pz] = placed.hologram.worldPosition;
    const ahead = Math.hypot(px - head.position[0], pz - head.position[2]);
    expect(placed.placement.mode).toBe("vr-default");
    expect(placed.hologram.worldScale.every((v) => Math.abs(v - 1) < 1e-6), `world scale ${JSON.stringify(placed.hologram.worldScale)}`).toBe(true);
    expect(Math.abs(py), "stands on the floor").toBeLessThan(0.01);
    expect(Math.abs(ahead - 1.5), `horizontal distance ${ahead.toFixed(3)} m`).toBeLessThan(0.05);

    // Sampled every 100 ms so loops of a short clip still add up.
    const first = await snapshot(page);
    let previous = first;
    let advanced = 0;
    const startedAt = Date.now();
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      const next = await snapshot(page);
      advanced += (next.hologram.clipTime - previous.hologram.clipTime + next.hologram.duration) % next.hologram.duration;
      previous = next;
    }
    const wallS = (Date.now() - startedAt) / 1000;
    const second = previous;
    expect(second.hologram.playing).toBe(true);
    expect(advanced / wallS, `clip time ${advanced.toFixed(3)} s over ${wallS.toFixed(3)} s wall`).toBeGreaterThan(0.7);
    expect(second.hologram.actionTimes.some((time, i) => time !== first.hologram.actionTimes[i]), "animation actions follow the clock").toBe(true);

    const audio = await readAudioSync(page);
    expect(audio, "embedded audio plays").not.toBeNull();
    const drift = Math.abs(audio!.scheduledOffset - audio!.clipTime);
    expect(drift, `audio offset ${audio!.scheduledOffset.toFixed(3)} vs clip ${audio!.clipTime.toFixed(3)}`).toBeLessThan(AUDIO_SYNC_TOLERANCE_S);
    // Measured on the second visit: hiding the hologram for a frame would blink in the first.
    const luminance = visit === 2 ? await measureHologramLuminance(page) : null;
    if (luminance) expectHologramLit(luminance);
    if (visit === 1) await captureEvidence(page, testInfo, "vr-life-size");

    mark(`vr-exit-${visit}`);
    await endSession(page);
    await expectTornDown(page);
    mark(`card-back-${visit}`);
    if (visit === 1) await dwell(page, 4);
    visits.push({
      visit,
      placement: placed.placement,
      head,
      horizontalDistanceM: ahead,
      worldScale: placed.hologram.worldScale,
      recordedSize: placed.hologram.recordedSize,
      duration: second.hologram.duration,
      clipAdvance: { clipS: advanced, wallS },
      audio: { ...audio, driftS: drift },
      renderer: second.renderer,
      ...(luminance ? { luminance } : {})
    });
  }
  report.vr = { visits, timeline: marks };
});

test("VR foot controls: dim and reach, play/pause, scrub, restart, two-hand grab with the scale chip, life-size reset, recenter, and exit from the hand dock", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  await mockFeed(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  mark("feed-ready");
  await dwell(page);
  mark("step-inside");
  await page.locator(".vr-trigger-button").click();
  await enterSession(page, "Step inside", "opaque");
  // Scripted control from here on (and no DevUI over the view).
  await setPose(page, "head", null, null);
  const placed = await waitForSnapshot(page, (s) => s.placement.stage === "placed" && s.hologram.visible && Boolean(s.controls));
  mark("vr-placed");
  const eye: Vec3 = (await readHeadPose(page)).position;
  const anchor = placed.hologram.worldPosition;
  const height = placed.hologram.recordedSize[1];

  // One control set, sized and placed as the brief and styleguide say.
  const first = placed.controls!;
  const foot = first.foot;
  expect(first.target).toBe("vr");
  expect(foot.sizes, "headset glyphs are 2.5x; ray hit areas are not scaled").toEqual({ glyphIconApx: 40, ringApx: 90, strokeApx: 3.75, hitApx: 56 });
  expect(foot.chipOpacity, "VR chip").toBe(0.72);
  expect(foot.metresPerApx, "sized for 1.75 m").toBeCloseTo(0.000372 * 1.75, 8);
  expect(foot.worldPosition[1] - anchor[1], "2 cm above the anchor").toBeCloseTo(0.02, 3);
  const chipFront = horizontal(foot.worldPosition, anchor);
  expect(chipFront, "in front of the feet, outside the pointer box").toBeGreaterThan(Math.max(placed.hologram.recordedSize[0], 0.3) / 2);
  expect(horizontal(foot.worldPosition, eye), "between the hologram and the viewer").toBeLessThan(horizontal(anchor, eye));
  expect(foot.text.playback).toMatch(/^\d+:\d\d$/);
  expect(first.status.visible, "the status line has nothing to report while playing").toBe(false);
  expect(first.dock).toMatchObject({ mount: "hand", visible: true });
  expect(first.dock.hitApx, "poke target: 20 mm at arm's reach").toBeGreaterThanOrEqual(72);
  expect(first.dock.hitApx * first.dock.metresPerApx * 1000, "poke target in mm").toBeGreaterThanOrEqual(19.99);

  // Step back so the whole figure and its foot share the view, as a viewer would.
  const stand: Vec3 = [eye[0], eye[1], eye[2] + 0.8];
  // Unused for 4 s, with nothing near: the always-there glyph dims to 40%.
  await setPose(page, "head", stand, [anchor[0], eye[1] - 0.05, anchor[2]]);
  const dimmed = await waitForSnapshot(page, (s) => s.controls!.foot.opacity === 0.4, 9_000);
  mark("dimmed");
  expect(dimmed.controls!.foot.dimInMs).toBe(0);
  expect(dimmed.controls!.foot.revealed).toBe(false);
  // The head's forward ray within 15° brings it back with the on-reach set.
  await setPose(page, "head", null, foot.worldPosition);
  const byHead = await waitForSnapshot(page, (s) => s.controls!.foot.opacity === 1 && s.controls!.foot.reachOpacity === 1, 3_000);
  mark("reach-head");
  expect(byHead.controls!.foot.near.headRay).toBe(true);
  expect(byHead.controls!.foot.dimInMs).toBeGreaterThan(3_000);
  await dwell(page);
  await captureEvidence(page, testInfo, "vr-foot-controls");
  // A hand within 0.3 m counts as near too; so does a ray hovering the chip.
  await setPose(page, "head", null, [anchor[0], eye[1], anchor[2]]);
  await setPose(page, "left", [foot.worldPosition[0] - 0.2, foot.worldPosition[1] + 0.1, foot.worldPosition[2]], null);
  const byHand = await waitForSnapshot(page, (s) => s.controls!.foot.near.hand && !s.controls!.foot.near.headRay, 3_000);
  await setPose(page, "left", [-0.25, 1.2, -0.3], null);
  await setPose(page, "right", [0.25, 1.25, -0.2], await footButton(page, "play"));
  const byRay = await waitForSnapshot(page, (s) => s.controls!.foot.near.hover, 3_000);
  // Look at the foot again so the on-reach set stays out for the rest.
  await setPose(page, "head", null, foot.worldPosition);
  await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 3_000);

  // Play/Pause by controller ray: motion and audio stop at the same clip time.
  mark("pause");
  await rayClick(page, await footButton(page, "play"));
  const paused = await waitForSnapshot(page, (s) => !s.hologram.playing, 3_000);
  await page.waitForTimeout(400);
  const stillPaused = await snapshot(page);
  expect(stillPaused.hologram.clipTime, "paused clock holds").toBeCloseTo(paused.hologram.clipTime, 5);
  expect(stillPaused.hologram.audio?.playing ?? false, "paused audio stops").toBe(false);
  expect(stillPaused.controls!.foot.text.playback).toMatch(/^Paused · \d+:\d\d$/);
  // The status line reports it, in the upper periphery, and holds no control.
  expect(stillPaused.controls!.status).toMatchObject({ visible: true, interactive: false });
  expect(stillPaused.controls!.status.text).toBe(stillPaused.controls!.foot.text.playback);
  await dwell(page);

  // Scrub: hold the trigger on the timeline and drag along it.
  const duration = stillPaused.hologram.duration;
  const { worldStart, worldEnd } = stillPaused.controls!.foot.timeline;
  mark("scrub");
  await setPose(page, "right", [0.25, 1.25, -0.2], lerp3(worldStart, worldEnd, 0.2));
  await setButton(page, "right", "trigger", 1);
  const scrubSamples: Array<{ aim: number; clipTime: number }> = [];
  for (let i = 1; i <= 10; i++) {
    const aim = 0.2 + 0.55 * (i / 10);
    await setPose(page, "right", null, lerp3(worldStart, worldEnd, aim));
    scrubSamples.push({ aim, clipTime: (await snapshot(page)).hologram.clipTime });
    await dwell(page, 0.1);
  }
  await setButton(page, "right", "trigger", 0);
  const scrubbed = await snapshot(page);
  expect(scrubbed.hologram.playing, "scrubbing a paused hologram keeps it paused").toBe(false);
  expect(Math.abs(scrubbed.hologram.clipTime - 0.75 * duration), `scrubbed to ${scrubbed.hologram.clipTime.toFixed(2)} of ${duration.toFixed(2)} s`).toBeLessThan(0.05 * duration);
  expect(scrubbed.controls!.foot.timeline.fraction).toBeCloseTo(scrubbed.hologram.clipTime / duration, 3);
  expect(scrubbed.hologram.actionTimes[0], "the pose is the scrubbed time").toBeCloseTo(scrubbed.hologram.clipTime % duration, 3);
  expect(scrubSamples.at(-1)!.clipTime, "the clock follows the drag").toBeGreaterThan(scrubSamples[0]!.clipTime);
  await dwell(page);
  // Play resumes there, with audio scheduled at the clip time.
  await rayClick(page, await footButton(page, "play"));
  await waitForSnapshot(page, (s) => s.hologram.playing && Boolean(s.hologram.audio?.playing), 3_000);
  const resumed = await readAudioSync(page);
  const resumeDrift = Math.abs(resumed!.scheduledOffset - resumed!.clipTime);
  expect(resumeDrift, "audio scheduled at the scrubbed clip time").toBeLessThan(AUDIO_SYNC_TOLERANCE_S);
  expect((await snapshot(page)).controls!.status.visible, "nothing to report once playing").toBe(false);

  // Restart from a pause (so a natural loop cannot pass for it): back to 0 and
  // still paused, as a video's back-to-start; play then runs motion and audio from 0.
  await rayClick(page, await footButton(page, "play"));
  await waitForSnapshot(page, (s) => !s.hologram.playing, 3_000);
  mark("restart");
  await rayClick(page, await footButton(page, "restart"));
  await waitForSnapshot(page, (s) => s.hologram.clipTime === 0 && !s.hologram.playing, 3_000);
  await dwell(page);
  const playedAt = Date.now();
  await rayClick(page, await footButton(page, "play"));
  const restarted = await waitForSnapshot(page, (s) => s.hologram.playing && Boolean(s.hologram.audio?.playing), 3_000);
  expect(restarted.hologram.clipTime, "plays from 0").toBeLessThanOrEqual((Date.now() - playedAt) / 1000 + 0.1);
  const restartAudio = await readAudioSync(page);
  expect(Math.abs(restartAudio!.scheduledOffset - restartAudio!.clipTime), "audio restarted with the motion").toBeLessThan(AUDIO_SYNC_TOLERANCE_S);
  await dwell(page);

  // Two-hand grab with controller grips: both grips on the hologram's front,
  // then spread, turn and carry it.
  mark("grab");
  const front = anchor[2] + 0.15 + 0.01;
  const chest = anchor[1] + height * 0.55;
  // Within arm's reach of the hologram for the grab.
  const head2: Vec3 = [anchor[0], eye[1], anchor[2] + 0.75];
  await setPose(page, "head", head2, [anchor[0], chest, anchor[2]]);
  await setPose(page, "left", [anchor[0] - 0.12, chest, front], [anchor[0] - 0.12, chest, anchor[2] - 1]);
  await setPose(page, "right", [anchor[0] + 0.12, chest, front], [anchor[0] + 0.12, chest, anchor[2] - 1]);
  // Grab pointers pick up what they touch on the next frames.
  await page.waitForTimeout(250);
  await setButton(page, "left", "squeeze", 1);
  await setButton(page, "right", "squeeze", 1);
  const grabbed = await waitForSnapshot(page, (s) => s.hologram.grabbed, 3_000);
  expect(grabbed.controls!.dock.visible, "the dock hides while its hand grabs").toBe(false);
  const grabSteps = 15;
  // The hologram stays standing on the floor whatever the hands do: base at the
  // ground (±5 mm) and upright through the whole grab.
  const grounded: Array<{ baseY: number; tiltRad: number }> = [];
  for (let i = 1; i <= grabSteps; i++) {
    const t = i / grabSteps;
    const spread = 0.12 + 0.06 * t;
    // Spread (scale up), carry 0.3 m to the right and lift 0.15 m, and turn: the right grip comes forward and up.
    await setPose(page, "left", [anchor[0] - spread + 0.3 * t, chest + 0.15 * t, front], null);
    await setPose(page, "right", [anchor[0] + spread + 0.3 * t, chest + 0.25 * t, front + 0.12 * t], null);
    const step = await snapshot(page);
    grounded.push({ baseY: step.hologram.worldPosition[1], tiltRad: step.hologram.tiltRad });
    await dwell(page, 0.05);
  }
  for (const [i, sample] of grounded.entries()) {
    expect(Math.abs(sample.baseY - anchor[1]), `grab step ${i + 1}: base on the floor`).toBeLessThan(0.005);
    expect(sample.tiltRad, `grab step ${i + 1}: upright`).toBeLessThan(1e-4);
  }
  const grown = await snapshot(page);
  await setButton(page, "left", "squeeze", 0);
  await setButton(page, "right", "squeeze", 0);
  const released = await waitForSnapshot(page, (s) => !s.hologram.grabbed, 3_000);
  mark("grab-released");
  const grownScale = released.hologram.worldScale[0];
  expect(grownScale, "spread hands scale it up").toBeGreaterThan(1.2);
  expect(grownScale).toBeLessThanOrEqual(2 + 1e-6);
  expect(released.hologram.worldScale.every((v) => Math.abs(v - grownScale) < 1e-4), "uniform scale").toBe(true);
  expect(Math.abs(released.hologram.yaw - placed.hologram.yaw), "turned").toBeGreaterThan(0.1);
  expect(released.hologram.worldPosition[0] - anchor[0], "carried to the right").toBeGreaterThan(0.15);
  expect(released.controls!.foot.text.scale, "the scale chip shows the change").toBe(`${Math.round(grownScale * 100)}%`);
  expect(released.controls!.foot.worldScale, "the chip keeps its size").toBeCloseTo(1, 6);
  expect(released.controls!.foot.yaw, "the chip does not turn with the hologram").toBeCloseTo(foot.yaw, 6);
  expect(released.controls!.dock.visible).toBe(true);
  await dwell(page);

  // A wider spread clamps at 2x.
  const g = released.hologram.worldPosition;
  const chest2 = g[1] + height * grownScale * 0.55;
  const front2 = g[2] + 0.15 * grownScale + 0.01;
  await setPose(page, "head", [g[0], eye[1], g[2] + 1.1], [g[0], chest2, g[2]]);
  await setPose(page, "left", [g[0] - 0.1, chest2, front2], [g[0] - 0.1, chest2, g[2] - 1]);
  await setPose(page, "right", [g[0] + 0.1, chest2, front2], [g[0] + 0.1, chest2, g[2] - 1]);
  await page.waitForTimeout(250);
  await setButton(page, "left", "squeeze", 1);
  await setButton(page, "right", "squeeze", 1);
  await waitForSnapshot(page, (s) => s.hologram.grabbed, 3_000);
  for (let i = 1; i <= 8; i++) {
    await setPose(page, "left", [g[0] - 0.1 - 0.12 * i, chest2, front2], null);
    await setPose(page, "right", [g[0] + 0.1 + 0.12 * i, chest2, front2], null);
  }
  const clamped = await snapshot(page);
  expect(Math.abs(clamped.hologram.worldPosition[1] - anchor[1]), "scaled about its base: still on the floor").toBeLessThan(0.005);
  await setButton(page, "left", "squeeze", 0);
  await setButton(page, "right", "squeeze", 0);
  await waitForSnapshot(page, (s) => !s.hologram.grabbed, 3_000);
  expect(clamped.hologram.worldScale[0], "clamped at 2x recorded scale").toBeCloseTo(2, 3);
  expect(clamped.controls!.foot.text.scale).toBe("200%");
  await setPose(page, "left", [-0.25, 1.2, -0.3], null);
  await captureEvidence(page, testInfo, "vr-scaled");
  mark("scaled");
  await dwell(page);

  // The scale chip's "life size" reset.
  let current = await controls(page);
  await setPose(page, "head", [current.foot.worldPosition[0], eye[1], current.foot.worldPosition[2] + 1.6], current.foot.worldPosition);
  await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 3_000);
  current = await controls(page);
  mark("life-size");
  await rayClick(page, await footButton(page, "scale"));
  const lifeSize = await waitForSnapshot(page, (s) => Math.abs(s.hologram.worldScale[0] - 1) < 1e-6, 3_000);
  expect(lifeSize.controls!.foot.text.scale).toBe("life size");
  expect(Math.abs(lifeSize.hologram.worldPosition[1] - anchor[1]), "life size: still on the floor").toBeLessThan(0.005);
  expect(horizontal(lifeSize.hologram.worldPosition, anchor), "life size keeps where it stands").toBeGreaterThan(0.15);
  await dwell(page);

  // Recenter: default placement (1.5 m ahead, facing the viewer) and recorded scale.
  await setPose(page, "head", stand, [anchor[0], eye[1] - 0.05, anchor[2] - 1]);
  current = await controls(page);
  await setPose(page, "head", null, current.foot.worldPosition);
  await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 3_000);
  current = await controls(page);
  mark("recenter");
  await rayClick(page, await footButton(page, "recenter"));
  const recentered = await waitForSnapshot(page, (s) => s.placement.sequence > placed.placement.sequence, 3_000);
  const headNow = await readHeadPose(page);
  const recenterDistance = horizontal(recentered.hologram.worldPosition, headNow.position);
  expect(Math.abs(recenterDistance - 1.5), `recentered ${recenterDistance.toFixed(3)} m ahead`).toBeLessThan(0.05);
  expect(recentered.hologram.worldScale[0]).toBeCloseTo(1, 6);
  expect(Math.abs(recentered.hologram.worldPosition[1] - anchor[1]), "on the floor").toBeLessThan(0.005);
  await dwell(page);

  // Nothing interactive follows the head: turn it and read the controls again.
  await setPose(page, "head", null, foot.worldPosition);
  await rayClick(page, await footButton(page, "play"));
  await waitForSnapshot(page, (s) => s.controls!.status.visible, 3_000);
  const beforeTurn = await controls(page);
  await setPose(page, "head", null, [eye[0] + 2, eye[1] + 0.3, eye[2] - 1]);
  await page.waitForTimeout(1_500);
  const afterTurn = await controls(page);
  const footMoved = Math.hypot(...([0, 1, 2] as const).map((k) => afterTurn.foot.worldPosition[k] - beforeTurn.foot.worldPosition[k]) as [number, number, number]);
  const statusMoved = Math.hypot(...([0, 1, 2] as const).map((k) => afterTurn.status.worldPosition[k] - beforeTurn.status.worldPosition[k]) as [number, number, number]);
  expect(footMoved, "foot controls stay with their hologram").toBeLessThan(1e-6);
  expect(statusMoved, "the status line follows the head").toBeGreaterThan(0.3);
  await setPose(page, "head", null, beforeTurn.foot.worldPosition);
  await rayClick(page, await footButton(page, "play"));

  // Exit from the hand dock on the left controller, by the right controller's ray.
  // The left controller held forward at chest height; the dock above it faces the eyes.
  await setPose(page, "head", [eye[0], eye[1], eye[2]], [-0.15, 1.2, -0.4]);
  await setPose(page, "left", [-0.15, 1.15, -0.35], [-0.15, 1.15, -1.35]);
  await page.waitForTimeout(250);
  const dock = (await controls(page)).dock;
  await dwell(page);
  mark("exit");
  await rayClick(page, dock.buttons.exit!.worldPosition, [0.15, 1.2, -0.15]);
  await waitForNoIwerSession(page);
  await expectTornDown(page);
  mark("card-back");
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  mark("card-rendered");
  await dwell(page, 2);

  report.vrControls = {
    timeline: marks,
    sizes: foot.sizes,
    chipOpacity: foot.chipOpacity,
    metresPerApx: foot.metresPerApx,
    chip: { liftM: foot.worldPosition[1] - anchor[1], frontOfAnchorM: chipFront },
    attention: {
      dimmed: { opacity: dimmed.controls!.foot.opacity, dimInMs: dimmed.controls!.foot.dimInMs },
      headRay: { opacity: byHead.controls!.foot.opacity, dimInMs: byHead.controls!.foot.dimInMs, near: byHead.controls!.foot.near },
      hand: byHand.controls!.foot.near,
      rayHover: byRay.controls!.foot.near
    },
    pause: { clipTime: paused.hologram.clipTime, heldClipTime: stillPaused.hologram.clipTime, audioPlaying: stillPaused.hologram.audio?.playing ?? false, status: stillPaused.controls!.status },
    scrub: { duration, target: 0.75 * duration, clipTime: scrubbed.hologram.clipTime, actionTime: scrubbed.hologram.actionTimes[0], samples: scrubSamples, resumeAudioDriftS: resumeDrift },
    restart: { clipTime: restarted.hologram.clipTime, audio: restartAudio },
    grab: {
      during: { scale: grown.hologram.worldScale, position: grown.hologram.worldPosition, yaw: grown.hologram.yaw },
      released: { scale: grownScale, position: released.hologram.worldPosition, yaw: released.hologram.yaw, chip: released.controls!.foot.text.scale, chipWorldScale: released.controls!.foot.worldScale },
      clamped: { scale: clamped.hologram.worldScale[0], chip: clamped.controls!.foot.text.scale, baseY: clamped.hologram.worldPosition[1] },
      grounded: {
        maxBaseOffsetM: Math.max(...grounded.map((sample) => Math.abs(sample.baseY - anchor[1]))),
        maxTiltRad: Math.max(...grounded.map((sample) => sample.tiltRad))
      }
    },
    lifeSize: { scale: lifeSize.hologram.worldScale[0], chip: lifeSize.controls!.foot.text.scale },
    recenter: { distanceM: recenterDistance, position: recentered.hologram.worldPosition, scale: recentered.hologram.worldScale[0] },
    headTurn: { footMovedM: footMoved, statusMovedM: statusMoved },
    dock: first.dock
  };
});

test("AR (IWSDK shell, phone): places on the floor ahead, a tap on the hologram pauses and resumes it, a tap on the floor moves it, and exit returns to the feed", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockFeed(page);
  await emulatePhone(page);
  // The feed opted into the IWSDK AR shell; its "View in your room" trigger opens it.
  await page.goto("/?shell=iwsdk");
  mark("feed-loaded");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  const arTrigger = page.locator(".ar-trigger-button");
  await expect(arTrigger).toHaveAttribute("aria-label", "View in your room", { timeout: 15_000 });
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  mark("feed-ready");
  await dwell(page, 3);
  mark("view-in-room");
  await arTrigger.click();
  await expect(page).toHaveURL(/\/ar\/mock-1\?shell=iwsdk$/);
  await enterSession(page, "View in your room", "alpha-blend");
  mark("ar-immersive");

  const placed = await waitForSnapshot(page, (s) => s.placement.stage !== "searching" && s.hologram.visible);
  mark("ar-placed");
  await dwell(page);
  expect(["hit-test", "floor"]).toContain(placed.placement.mode);
  const anchored = await waitForSnapshot(page, (s) => s.placement.stage === "anchored", 5_000).catch(() => null);
  const head = await readHeadPose(page);
  const position = placed.hologram.worldPosition;
  const toModel: Vec3 = [position[0] - head.position[0], 0, position[2] - head.position[2]];
  const forwardDot = (toModel[0] * head.forward[0] + toModel[2] * head.forward[2]) / Math.hypot(toModel[0], toModel[2]) / Math.hypot(head.forward[0], head.forward[2]);
  // Same criteria as the R3F view's spec (hologram-feed.spec.ts).
  const horizontalDistance = Math.hypot(toModel[0], toModel[2]);
  expect(horizontalDistance).toBeGreaterThan(0.5);
  expect(horizontalDistance).toBeLessThan(5);
  expect(forwardDot, "placed in front of the viewer").toBeGreaterThan(Math.SQRT1_2);
  expect(position[1], "height above floor (m)").toBeGreaterThan(-0.05);
  expect(head.position[1] - position[1], "drop below eye level (m)").toBeGreaterThan(0.2);
  expect(placed.hologram.worldScale.every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
  mark("luminance-start");
  const luminance = await measureHologramLuminance(page);
  mark("luminance-end");
  expectHologramLit(luminance);
  await captureEvidence(page, testInfo, "ar-placed");

  // Tap the hologram's chest: pause, then resume.
  const chest: Vec3 = [position[0], position[1] + placed.hologram.recordedSize[1] * 0.6, position[2]];
  mark("tap-pause");
  await phoneTap(page, chest);
  const paused = await waitForSnapshot(page, (s) => !s.hologram.playing, 3_000);
  const pausedAt = paused.hologram.clipTime;
  await page.waitForTimeout(500);
  expect((await snapshot(page)).hologram.clipTime, "paused clock holds").toBeCloseTo(pausedAt, 5);
  expect((await snapshot(page)).hologram.audio?.playing ?? false, "paused audio stops").toBe(false);
  await phoneTap(page, chest);
  await waitForSnapshot(page, (s) => s.hologram.playing, 3_000);

  // Tap the floor beside it: the hologram moves there.
  const floorTarget: Vec3 = [position[0] + 0.3, position[1], position[2] + 0.3];
  await dwell(page);
  mark("tap-move");
  await phoneTap(page, floorTarget);
  const moved = await waitForSnapshot(page, (s) => s.placement.mode === "tap" && s.placement.sequence > placed.placement.sequence, 3_000);
  const miss = Math.hypot(moved.hologram.worldPosition[0] - floorTarget[0], moved.hologram.worldPosition[2] - floorTarget[2]);
  expect(miss, "moved to the tapped floor point").toBeLessThan(0.05);
  const reanchored = await waitForSnapshot(page, (s) => s.placement.stage === "anchored", 3_000).catch(() => null);
  await captureEvidence(page, testInfo, "ar-tap-moved");

  // Foot controls on a phone: flat sizes, 44 apx touch targets, the Android chip.
  const phone = (await snapshot(page)).controls!;
  expect(phone.target).toBe("ar-phone");
  expect(phone.foot.sizes, "flat sizes and touch targets").toEqual({ glyphIconApx: 16, ringApx: 36, strokeApx: 1.5, hitApx: 44 });
  expect(phone.foot.chipOpacity).toBe(0.88);
  expect(phone.dock.mount).toBe("phone");
  // Flat sizes are CSS pixels of the phone's image: the Exit glyph spans 16 px, bottom centre above the home bar.
  const dockOnScreen = await page.evaluate(({ at, glyphM }) => {
    type V = { x: number; y: number; z: number; project(c: unknown): V; clone(): V };
    const camera = (window as unknown as { __HOLOIM_XR_VIEWER__: { world: { camera: { worldToLocal(v: V): V; localToWorld(v: V): V; position: { constructor: new (x: number, y: number, z: number) => V } } } } }).__HOLOIM_XR_VIEWER__.world.camera;
    const Vector = camera.position.constructor;
    const centre = new Vector(...at);
    const local = camera.worldToLocal(centre.clone());
    const edge = camera.localToWorld(new Vector(local.x + glyphM, local.y, local.z));
    const a = centre.clone().project(camera);
    const b = edge.project(camera);
    return { widthPx: Math.abs(b.x - a.x) / 2 * innerWidth, x: (a.x + 1) / 2 * innerWidth, y: (1 - a.y) / 2 * innerHeight, innerWidth, innerHeight };
  }, { at: phone.dock.buttons.exit!.worldPosition, glyphM: phone.dock.glyphApx * phone.dock.metresPerApx });
  expect(dockOnScreen.widthPx, "Exit glyph in CSS px").toBeCloseTo(phone.dock.glyphApx, 0);
  expect(dockOnScreen.x, "dock centred").toBeCloseTo(dockOnScreen.innerWidth / 2, 0);
  expect(dockOnScreen.y, "dock in the thumb zone").toBeGreaterThan(dockOnScreen.innerHeight * 0.85);
  // Tilt the phone toward the hologram's feet: the controls come near.
  await setPose(page, "head", null, phone.foot.worldPosition);
  const near = await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 3_000);
  const foot = near.controls!.foot;
  // Where the reach row's ends land on the phone screen (CSS px), for the report: at flat sizes
  // the row is close to a phone's width (design question in the brief's step 3 results).
  const rowOnScreen = await page.evaluate((points) => {
    type V = { x: number; y: number; project(c: unknown): V };
    const camera = (window as unknown as { __HOLOIM_XR_VIEWER__: { world: { camera: { position: { constructor: new (x: number, y: number, z: number) => V } } } } }).__HOLOIM_XR_VIEWER__.world.camera;
    const Vector = camera.position.constructor;
    return points.map((point) => (new Vector(...point).project(camera).x + 1) / 2 * innerWidth);
  }, [foot.buttons.restart.worldPosition, foot.buttons.scale.worldPosition]);
  await dwell(page);
  mark("tap-play-glyph");
  await phoneTap(page, foot.buttons.play.worldPosition);
  const glyphPaused = await waitForSnapshot(page, (s) => !s.hologram.playing, 3_000);
  expect(glyphPaused.placement.sequence, "a tap on the controls never moves the hologram").toBe(moved.placement.sequence);
  expect(glyphPaused.controls!.foot.text.playback).toMatch(/^Paused · /);
  await dwell(page);

  // A held finger dragged along the timeline scrubs it (the bridge moves the pointer every frame).
  const { worldStart, worldEnd } = foot.timeline;
  const duration = glyphPaused.hologram.duration;
  mark("drag-timeline");
  await phoneDrag(page, lerp3(worldStart, worldEnd, 0.15), lerp3(worldStart, worldEnd, 0.8), 30);
  const dragged = await snapshot(page);
  expect(Math.abs(dragged.hologram.clipTime - 0.8 * duration), `dragged to ${dragged.hologram.clipTime.toFixed(2)} of ${duration.toFixed(2)} s`).toBeLessThan(0.05 * duration);
  expect(dragged.placement.sequence, "dragging the timeline never moves the hologram").toBe(moved.placement.sequence);
  await dwell(page);
  mark("tap-play-again");
  // "Paused" widens the row, so the glyph has moved since the first tap.
  await phoneTap(page, await footButton(page, "play"));
  await waitForSnapshot(page, (s) => s.hologram.playing, 3_000);
  const dragAudio = await waitForSnapshot(page, (s) => Boolean(s.hologram.audio?.playing), 3_000);
  const dragDrift = Math.abs(dragAudio.hologram.audio!.scheduledOffset - dragAudio.hologram.clipTime);
  expect(dragDrift, "audio resumes at the dragged time").toBeLessThan(AUDIO_SYNC_TOLERANCE_S);
  await captureEvidence(page, testInfo, "ar-phone-controls");

  // Exit from the bottom dock.
  await dwell(page);
  mark("ar-exit");
  // The dock rides the camera: read where it is now.
  // Exit leaves the page mid-tap, which ends the tap's evaluate.
  await phoneTap(page, (await controls(page)).dock.buttons.exit!.worldPosition).catch((error: Error) => {
    if (!/Execution context was destroyed/.test(error.message)) throw error;
  });
  await waitForNoIwerSession(page);
  await expectTornDown(page);
  mark("card-back");
  await dwell(page, 3);
  report.ar = {
    timeline: marks,
    placement: placed.placement,
    anchoredAfterPlacement: Boolean(anchored),
    head,
    forwardDot,
    luminance,
    horizontalDistance,
    surfaceHeightM: position[1],
    pausedAtClipTime: pausedAt,
    tapMove: { target: floorTarget, position: moved.hologram.worldPosition, missM: miss, reanchored: Boolean(reanchored) },
    phoneControls: {
      sizes: phone.foot.sizes,
      reachRowEndsPx: { restart: rowOnScreen[0], scale: rowOnScreen[1], screenWidth: page.viewportSize()!.width },
      dockOnScreen,
      chipOpacity: phone.foot.chipOpacity,
      metresPerApx: phone.foot.metresPerApx,
      dock: phone.dock,
      glyphPause: { clipTime: glyphPaused.hologram.clipTime, playback: glyphPaused.controls!.foot.text.playback },
      drag: { duration, target: 0.8 * duration, clipTime: dragged.hologram.clipTime, resumeAudioDriftS: dragDrift }
    }
  };
});
