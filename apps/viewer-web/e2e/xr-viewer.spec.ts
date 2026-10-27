import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";
import { waitForIwerRuntime, waitForIwerSession, waitForNoIwerSession } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, captureEvidence, expect, expectConsoleErrors, reachFor, test } from "./bootstrap";
import { TERRAIN_DROP_M, terrainGltf } from "./bubble-fixture";
import { settleScroll } from "./portal-helpers";

// The IWSDK immersive viewer (docs/features/archive/viewer-xr-interface.md, steps 2-4):
// `/vr/:id` and `/ar/:id` mount one IWSDK World with the opened
// hologram at recorded scale, and a gallery of the feed to place more from. The page's development probe (`__HOLOIM_XR_VIEWER__`)
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
    /** World height of the lowest bone: the recorded person's feet. */
    lowestBoneY: number | null;
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
  reachChipFade: number;
  near: { hover: boolean; hand: boolean; headRay: boolean };
  labelOpacity: number;
  chipOpacity: number;
  metresPerApx: number;
  sizes: { glyphIconApx: number; ringApx: number; strokeApx: number; hitApx: number };
  text: { playback: string; elapsedTotal: string; scale: string };
  buttons: Record<"play" | "restart" | "recenter" | "scale", { worldPosition: Vec3; visible: boolean }>;
  timeline: { worldStart: Vec3; worldEnd: Vec3; fraction: number; lengthApx: number };
  reachRow: { worldLeft: Vec3; worldRight: Vec3; widthApx: number };
};
type Controls = {
  target: "vr" | "ar-quest" | "ar-phone";
  foot: FootProbe;
  status: { visible: boolean; text: string; worldPosition: Vec3; interactive: boolean };
  dock: { mount: "hand" | "phone"; hand: "left" | "right" | null; visible: boolean; metresPerApx: number; hitApx: number; glyphApx: number; buttons: Record<string, { worldPosition: Vec3 }> };
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

async function mockFeed(page: Page, glb?: Buffer): Promise<void> {
  glb ??= await avatarWithAudio();
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
          mark.style.cssText = "position:fixed;z-index:99999;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #ffffff;background:rgb(255 255 255 / 40%)";
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
        // Two fingers either side of a world point, `fromPx` then `toPx` apart on the screen over `frames` frames.
        const pinch = async (centre: [number, number, number], fromPx: number, toPx: number, frames: number) => {
          const { session, camera } = viewer();
          if (!EventCtor) throw new Error("XRInputSourceEvent unavailable");
          type V = { x: number; y: number; z: number; project(c: unknown): V; unproject(c: unknown): V; toArray(): [number, number, number] };
          const Vector = camera.position.constructor as unknown as new (x: number, y: number, z: number) => V;
          const at = (spreadPx: number, side: 1 | -1): [number, number, number] => {
            const screen = new Vector(...centre).project(camera);
            screen.x += side * spreadPx / innerWidth;
            return screen.unproject(camera).toArray();
          };
          const fingers = ([1, -1] as const).map((side) => {
            const space = new Space(device.viewerSpace, aimAt(at(fromPx, side)));
            const state = Object.getOwnPropertySymbols(space).map((key) => (space as Record<symbol, { offsetMatrix?: Float32Array }>)[key]).find((value) => value?.offsetMatrix)!;
            const source = new InputSource("none", "screen", ["generic-touchscreen", "generic-button"], space);
            const mark = fingerMark();
            mark(at(fromPx, side));
            return { side, state, source, mark };
          });
          for (const finger of fingers) {
            screenSources.push(finger.source);
            await frameOf(session);
            await frameOf(session, (frame) => session.dispatchEvent(new EventCtor("selectstart", { frame, inputSource: finger.source })));
          }
          for (let i = 1; i <= frames; i++) {
            const spread = fromPx + (toPx - fromPx) * (i / frames);
            await frameOf(session, () => {
              for (const finger of fingers) {
                finger.state.offsetMatrix!.set(aimAt(at(spread, finger.side)));
                finger.mark(at(spread, finger.side));
              }
            });
          }
          for (const finger of fingers) {
            await frameOf(session, (frame) => session.dispatchEvent(new EventCtor("selectend", { frame, inputSource: finger.source })));
            screenSources.splice(screenSources.indexOf(finger.source), 1);
            finger.mark.remove();
          }
          await frameOf(session);
        };
        (window as { __phonePinch?: unknown }).__phonePinch = pinch;
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
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".xr-view-container")).toHaveCount(0);
  expect(await page.evaluate(() => "__HOLOIM_XR_VIEWER__" in window), "probe removed with the World").toBe(false);
  await expect(page.locator('[data-card-id="mock-1"]'), "back on the opened hologram's card").toBeInViewport({ timeout: 10_000 });
}

const phoneTap = (page: Page, target: Vec3) =>
  page.evaluate((t) => (window as unknown as { __phoneTap(t: Vec3): Promise<void> }).__phoneTap(t), target);
const phonePinch = (page: Page, centre: Vec3, fromPx: number, toPx: number, frames: number) =>
  page.evaluate(([c, f, t, n]) => (window as unknown as { __phonePinch(c: Vec3, f: number, t: number, n: number): Promise<void> }).__phonePinch(c, f, t, n), [centre, fromPx, toPx, frames] as const);
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

/** World points projected to the page's screen, in CSS px from its top left. */
const toScreen = (page: Page, points: Vec3[]) =>
  page.evaluate((points) => {
    type V = { x: number; y: number; project(c: unknown): V };
    const camera = (window as unknown as { __HOLOIM_XR_VIEWER__: { world: { camera: { position: { constructor: new (x: number, y: number, z: number) => V } } } } }).__HOLOIM_XR_VIEWER__.world.camera;
    const Vector = camera.position.constructor;
    return points.map((point) => {
      const p = new Vector(...point).project(camera);
      return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight };
    });
  }, points);

/**
 * The phone reach row's projected edges once its per-frame fit has caught up
 * with the last head move (up to 5 s): a fixed wait can read a frame early.
 */
type ReachRowReading = { foot: NonNullable<ViewerSnapshot["controls"]>["foot"]; left: { x: number; y: number }; right: { x: number; y: number } };
async function settledReachRow(page: Page): Promise<ReachRowReading> {
  const width = page.viewportSize()!.width;
  let reading: ReachRowReading | null = null;
  await expect.poll(async () => {
    const foot = (await snapshot(page)).controls!.foot;
    const [left, right] = await toScreen(page, [foot.reachRow.worldLeft, foot.reachRow.worldRight]);
    reading = { foot, left: left!, right: right! };
    return left!.x >= 16 - 0.01 && right!.x <= width - 16 + 0.01;
  }, { timeout: 5_000 }).toBe(true).catch(() => undefined);
  return reading!;
}

/**
 * The VR reach chip's fade-in against its glyphs' (§5.2: 0.3 s; §8.4: 240 ms).
 * Both advance on the same frame deltas, so on a frame mid-fade the chip
 * stands at 240/300 of the glyphs' progress, or at 0.8 or more once the
 * glyphs are full. The viewer logs both on every frame. IWER's frames can be
 * far apart (0.1 s to seconds), so one reveal may finish in one frame: the
 * head looks away and back until a frame is caught mid-fade.
 */
async function measureChipFade(page: Page, eye: Vec3, chip: Vec3): Promise<Array<{ glyph: number; chip: number }>> {
  const takeLog = () => page.evaluate(() => (window as unknown as { __HOLOIM_XR_VIEWER__: { takeFadeLog(): Array<{ reach: number; chip: number }> } }).__HOLOIM_XR_VIEWER__.takeFadeLog());
  for (let attempt = 0; attempt < 12; attempt++) {
    await setPose(page, "head", eye, [eye[0], eye[1] + 4, eye[2] + 1]);
    await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 0 && s.controls!.foot.reachChipFade === 0, 6_000);
    await takeLog();
    await setPose(page, "head", eye, chip);
    await waitForSnapshot(page, (s) => s.controls!.foot.reachChipFade === 1, 9_000);
    const midFade = (await takeLog()).filter((frame) => frame.chip > 0 && frame.chip < 1).map((frame) => ({ glyph: frame.reach, chip: frame.chip }));
    if (midFade.length) return midFade;
  }
  return [];
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
  await expect(vrTrigger.locator("button")).toHaveAttribute("aria-label", "Step inside");
  await expect(page.locator(".ar-trigger-button button")).toHaveAttribute("aria-label", "View in your room");

  const visits: unknown[] = [];
  for (let visit = 1; visit <= 2; visit++) {
    await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
    mark(`feed-ready-${visit}`);
    // The portal takes a few seconds to show the figure.
    if (visit === 1) await dwell(page, 3);
    mark(`step-inside-${visit}`);
    await reachFor(page.locator(".feed-card").first());
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
  await reachFor(page.locator(".feed-card").first());
  await page.locator(".vr-trigger-button").click();
  await enterSession(page, "Step inside", "opaque");
  // Scripted control from here on (and no DevUI over the view).
  await setPose(page, "head", null, null);
  const placed = await waitForSnapshot(page, (s) => s.placement.stage === "placed" && s.hologram.visible && Boolean(s.controls));
  mark("vr-placed");
  const eye: Vec3 = (await readHeadPose(page)).position;
  const anchor = placed.hologram.worldPosition;
  const height = placed.hologram.recordedSize[1];
  // The recorded person's feet, not only the entity's origin, stand on the floor.
  const feetOnFloor = (s: ViewerSnapshot, scale = 1) => s.hologram.lowestBoneY! - anchor[1] > -0.01 && s.hologram.lowestBoneY! - anchor[1] < 0.15 * scale;
  expect(feetOnFloor(placed), `feet ${placed.hologram.lowestBoneY?.toFixed(3)} m above the floor`).toBe(true);

  // One control set, sized and placed as the brief and styleguide say.
  const first = placed.controls!;
  const foot = first.foot;
  expect(first.target).toBe("vr");
  // Within reach the foot controls are poked too: 72 apx, never under 20 mm at the 1.75 m reference (§6.1, §9.2).
  expect(foot.sizes, "headset glyphs are 2.5x; poke hit areas are not scaled").toEqual({ glyphIconApx: 40, ringApx: 90, strokeApx: 3.75, hitApx: 72 });
  expect(foot.sizes.hitApx * 0.000372 * 1.75 * 1000, "foot poke target in mm").toBeGreaterThanOrEqual(20);
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
  const byHead = await waitForSnapshot(page, (s) => s.controls!.foot.opacity === 1 && s.controls!.foot.reachOpacity === 1, 9_000);
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
  await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 9_000);

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
  // A grab by the dominant (right) hand alone leaves the dock on the left hand in view.
  await setButton(page, "right", "squeeze", 1);
  const oneHand = await waitForSnapshot(page, (s) => s.hologram.grabbed, 3_000);
  expect(oneHand.controls!.dock.hand).toBe("left");
  expect(oneHand.controls!.dock.visible, "the other hand's grab leaves the dock").toBe(true);
  await setButton(page, "right", "squeeze", 0);
  await waitForSnapshot(page, (s) => !s.hologram.grabbed, 3_000);
  await setButton(page, "left", "squeeze", 1);
  await setButton(page, "right", "squeeze", 1);
  const grabbed = await waitForSnapshot(page, (s) => s.hologram.grabbed, 3_000);
  expect(grabbed.controls!.dock.visible, "the dock hides while its hand grabs").toBe(false);
  const grabSteps = 15;
  // The hologram stays standing on the floor whatever the hands do: base at the
  // ground (±5 mm) and upright through the whole grab.
  const grounded: Array<{ baseY: number; tiltRad: number; feetOnFloor: boolean }> = [];
  for (let i = 1; i <= grabSteps; i++) {
    const t = i / grabSteps;
    const spread = 0.12 + 0.06 * t;
    // Spread (scale up), carry 0.3 m to the right and lift 0.15 m, and turn: the right grip comes forward and up.
    await setPose(page, "left", [anchor[0] - spread + 0.3 * t, chest + 0.15 * t, front], null);
    await setPose(page, "right", [anchor[0] + spread + 0.3 * t, chest + 0.25 * t, front + 0.12 * t], null);
    const step = await snapshot(page);
    grounded.push({ baseY: step.hologram.worldPosition[1], tiltRad: step.hologram.tiltRad, feetOnFloor: feetOnFloor(step, step.hologram.worldScale[0]) });
    await dwell(page, 0.05);
  }
  for (const [i, sample] of grounded.entries()) {
    expect(Math.abs(sample.baseY - anchor[1]), `grab step ${i + 1}: base on the floor`).toBeLessThan(0.005);
    expect(sample.tiltRad, `grab step ${i + 1}: upright`).toBeLessThan(1e-4);
    expect(sample.feetOnFloor, `grab step ${i + 1}: feet on the floor`).toBe(true);
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
  await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 9_000);
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
  await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1, 9_000);
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

// Step 4: a seeded 12-item feed for the gallery. The feed API pages by an
// index cursor, so the first page (10) leaves two past the loaded feed. One
// item's model is missing (404).
const GALLERY_FEED_SIZE = 12;
const GALLERY_MISSING_ID = "mock-5";
const galleryItem = (n: number) => ({
  ...mockHologram,
  id: `mock-${n}`,
  url: `mock-${n}` === GALLERY_MISSING_ID ? `/uploads/missing-${n}.glb` : `/uploads/mock-avatar-${n}.glb`,
  filenameOriginal: `mock-avatar-${n}.glb`,
  hologramName: `Runner ${n}`,
  createdAt: new Date(Date.UTC(2026, 9, 24) - n * 60_000).toISOString()
});

async function mockGalleryFeed(page: Page): Promise<{ feedRequests: Array<{ cursor: string | null; limit: number }> }> {
  const glb = await avatarWithAudio();
  const items = Array.from({ length: GALLERY_FEED_SIZE }, (_, i) => galleryItem(i + 1));
  const feedRequests: Array<{ cursor: string | null; limit: number }> = [];
  await page.route("**/api/holograms?*", (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? Number(cursor) : 0;
    feedRequests.push({ cursor, limit });
    const end = start + limit;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: items.slice(start, end), nextCursor: end < items.length ? String(end) : null })
    });
  });
  await page.route(/\/api\/holograms\/mock-\d+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const item = items.find((candidate) => candidate.id === id);
    return item
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(item) })
      : route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) });
  });
  await page.route("**/uploads/mock-avatar-*", (route) => route.fulfill({ status: 200, body: glb, contentType: "model/gltf-binary" }));
  await page.route("**/uploads/missing-*", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "Not found" }));
  // The browser logs the seeded 404; nothing else may error.
  expectConsoleErrors(page, /\/uploads\/missing-\d+\.glb$/);
  return { feedRequests };
}

type HologramReading = ViewerSnapshot["hologram"] & { id: string; focused: boolean; audible: boolean; footprintRadius: number; placement: ViewerSnapshot["placement"] };
type TileProbe = { index: number; title: string | null; label: string; status: string; hasPreview: boolean; worldPosition: Vec3; panelPosition: Vec3 };
type GalleryProbe = {
  page: number;
  pageSize: number;
  loadedItems: number;
  nextCursor: string | null;
  fetching: boolean;
  errors: string[];
  lastSelect: { index: number; result: string } | null;
  slots: Array<string | null>;
  shelf: { visible: boolean; tiles: TileProbe[]; paging: Record<"newer" | "older", { visible: boolean; worldPosition: Vec3 }> } | null;
};
type GallerySnapshot = ViewerSnapshot & {
  focusedId: string | null;
  holograms: HologramReading[];
  stage: { origin: Vec3; forward: Vec3; distanceM: number; floorY: number } | null;
  chipWidthM: number;
  gallery: GalleryProbe;
  cache: Record<string, number>;
  controls: (Controls & { ring: { visible: boolean; worldPosition: Vec3; radiusM: number }; boundTo: string | null }) | null;
  bubbles: { sparkFocusId: string | null };
  player: { position: Vec3; yawRad: number; vignetteAlpha: number };
};

const gallerySnapshot = (page: Page) => snapshot(page) as Promise<GallerySnapshot>;
const waitForGallery = (page: Page, accept: (s: GallerySnapshot) => boolean, timeout = 15_000) =>
  waitForSnapshot(page, (s) => accept(s as GallerySnapshot), timeout) as Promise<GallerySnapshot>;
const readingOf = (s: GallerySnapshot, id: string) => s.holograms.find((h) => h.id === id);
/** Page tiles have their previews, or their error. */
const pageSettled = (s: GallerySnapshot) => Boolean(s.gallery.shelf?.visible) && s.gallery.shelf!.tiles.every((t) => t.status === "empty" || t.status === "error" || t.status === "placed" || t.hasPreview);
/** The recorded person's feet on the ground they stand on: the lowest bone at most 15 cm above the base, never below it. */
const feetOnGround = (h: HologramReading) => h.lowestBoneY! - h.worldPosition[1] > -0.01 && h.lowestBoneY! - h.worldPosition[1] < 0.15;

/**
 * Renderer counts once they hold still for half a second (previews and text
 * upload over a few frames). `geometries` leaves out the UI's own (UIKit
 * keeps grown text buffers); `allGeometries` is the renderer's whole count.
 */
async function settledRenderer(page: Page): Promise<{ geometries: number; textures: number; allGeometries: number; uiGeometries: number }> {
  const read = async () => {
    const r = (await gallerySnapshot(page)).renderer as ViewerSnapshot["renderer"] & { uiGeometries: number };
    return { geometries: r.geometries - r.uiGeometries, textures: r.textures, allGeometries: r.geometries, uiGeometries: r.uiGeometries };
  };
  let previous = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const next = await read();
    if (next.allGeometries === previous.allGeometries && next.textures === previous.textures) {
      await page.waitForTimeout(250);
      const confirm = await read();
      if (confirm.allGeometries === next.allGeometries && confirm.textures === next.textures) return confirm;
    }
    previous = next;
  }
  throw new Error("renderer counts never settled");
}

/**
 * Shows every part of the focused hologram's controls once (the on-reach row,
 * and the status line by a pause and resume), so renderer counts compare
 * holograms and previews, not UI uploaded on first show.
 */
async function warmControls(page: Page, eye: Vec3): Promise<void> {
  const play = (await gallerySnapshot(page)).controls!.foot.buttons.play.worldPosition;
  await setPose(page, "head", eye, play);
  await waitForGallery(page, (g) => g.controls!.foot.reachOpacity === 1, 5_000);
  for (const playing of [false, true]) {
    // The paused label beside it moves the glyph on its centred row.
    const at = (await gallerySnapshot(page)).controls!.foot.buttons.play.worldPosition;
    await rayClick(page, at, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2]);
    await waitForGallery(page, (g) => g.hologram!.playing === playing && g.controls!.status.visible === !playing, 5_000);
  }
}

/** Turns the head toward a tile and selects it with the right controller's ray. */
async function selectTile(page: Page, index: number, eye: Vec3): Promise<void> {
  const tile = (await gallerySnapshot(page)).gallery.shelf!.tiles[index]!;
  await setPose(page, "head", eye, tile.worldPosition);
  await rayClick(page, tile.worldPosition, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2]);
}

async function selectPaging(page: Page, key: "newer" | "older", eye: Vec3): Promise<void> {
  const label = (await gallerySnapshot(page)).gallery.shelf!.paging[key];
  expect(label.visible, `${key} shows`).toBe(true);
  const target = label.worldPosition;
  await setPose(page, "head", eye, target);
  await rayClick(page, target, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2]);
}

/** Selects a placed hologram by aiming the ray at its body (it takes audio focus). */
async function selectBody(page: Page, id: string, eye: Vec3): Promise<void> {
  const h = readingOf(await gallerySnapshot(page), id)!;
  const body: Vec3 = [h.worldPosition[0], h.worldPosition[1] + h.recordedSize[1] * 0.55, h.worldPosition[2]];
  await setPose(page, "head", eye, body);
  await rayClick(page, body, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2]);
}

/** Only the focused hologram is heard, from its own clock. */
function expectAudioFocus(s: GallerySnapshot, id: string): number {
  expect(s.focusedId).toBe(id);
  for (const h of s.holograms) {
    expect(h.audible, `${h.id} audible`).toBe(h.id === id);
    if (h.id !== id) expect(h.audio?.playing ?? false, `${h.id} is silent`).toBe(false);
  }
  const focused = readingOf(s, id)!;
  if (!focused.playing) return 0;
  expect(focused.audio?.playing, `${id} is heard`).toBe(true);
  const drift = Math.abs(focused.audio!.scheduledOffset - focused.clipTime);
  expect(drift, `${id} audio ${focused.audio!.scheduledOffset.toFixed(3)} vs clip ${focused.clipTime.toFixed(3)}`).toBeLessThan(AUDIO_SYNC_TOLERANCE_S);
  return drift;
}

interface Bounds { name: string; min: Vec3; max: Vec3 }

/** World-axis bounds of the shelf's boards and tile panels and of each placed hologram's hit box, from their vertices. */
async function sceneBounds(page: Page): Promise<{ shelf: Bounds[]; holograms: Record<string, Bounds> }> {
  return page.evaluate(() => {
    type Node = { name: string; parent: Node | null; children: Node[]; matrixWorld: { elements: number[] }; geometry?: { attributes: { position?: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } }; isInstancedMesh?: boolean };
    const world = (window as unknown as { __HOLOIM_XR_VIEWER__: { world: { scene: Node & { updateMatrixWorld(force: boolean): void } } } }).__HOLOIM_XR_VIEWER__.world;
    world.scene.updateMatrixWorld(true);
    const boundsOf = (root: Node, name: string) => {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const visit = (node: Node) => {
        const position = node.geometry?.attributes.position;
        if (position && !node.isInstancedMesh) {
          const e = node.matrixWorld.elements;
          for (let i = 0; i < position.count; i++) {
            const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
            const p = [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
            for (let a = 0; a < 3; a++) {
              min[a] = Math.min(min[a]!, p[a]!);
              max[a] = Math.max(max[a]!, p[a]!);
            }
          }
        }
        node.children.forEach(visit);
      };
      visit(root);
      return { name, min, max };
    };
    const shelf: Array<{ name: string; min: number[]; max: number[] }> = [];
    const holograms: Record<string, { name: string; min: number[]; max: number[] }> = {};
    const walk = (node: Node) => {
      if (/^(GalleryBoard|GalleryTilePanel\d+)$/.test(node.name)) shelf.push(boundsOf(node, `${node.name}#${shelf.length}`));
      else if (node.name === "HologramHitBox" && node.parent?.name.startsWith("Hologram-")) holograms[node.parent.name.slice("Hologram-".length)] = boundsOf(node, node.parent.name);
      node.children.forEach(walk);
    };
    walk(world.scene);
    return { shelf: shelf.filter((part) => Number.isFinite(part.min[0])), holograms };
  }) as Promise<{ shelf: Bounds[]; holograms: Record<string, Bounds> }>;
}

const boxesMeet = (a: Bounds, b: Bounds) => [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! && b.min[i]! <= a.max[i]!);

/** Whether the segment from `from` to `to` passes through the box (slab test). */
function segmentMeetsBox(from: Vec3, to: Vec3, box: Bounds): boolean {
  let [t0, t1] = [0, 1];
  for (let i = 0; i < 3; i++) {
    const d = to[i]! - from[i]!;
    if (Math.abs(d) < 1e-9) {
      if (from[i]! < box.min[i]! || from[i]! > box.max[i]!) return false;
      continue;
    }
    const [a, b] = [(box.min[i]! - from[i]!) / d, (box.max[i]! - from[i]!) / d];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return false;
  }
  return true;
}

test("VR gallery: pages the feed past its cursor, places four, each keeps its state, focus moves the audio, a double select and a 404 change nothing, removing and paging return renderer counts, and exit returns to the focused one", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  const { feedRequests } = await mockGalleryFeed(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 20_000 });
  mark("feed-ready");
  // As the other entries: the portal settles before its reach controls are used.
  await page.locator('[data-card-id="mock-1"]').scrollIntoViewIfNeeded();
  // The feed glides onto the card late on a loaded runner; a cursor
  // that reaches before it rests is left behind and the controls fold.
  await settleScroll(page);
  await dwell(page, 3);
  await reachFor(page.locator('[data-card-id="mock-1"]'));
  // The feed's own first-page loads (it reloads for the signed-in viewer) end here.
  const feedRequestsBeforeVr = feedRequests.length;
  await page.locator('[data-card-id="mock-1"] .vr-trigger-button').click();
  await expect(page).toHaveURL(/\/vr\/mock-1$/);
  await enterSession(page, "Step inside", "opaque");
  await setPose(page, "head", null, null);

  // The opened hologram stands in front; the shelf shows the feed carried from the card.
  const entered = await waitForGallery(page, (s) => s.placement.stage === "placed" && Boolean(s.controls) && pageSettled(s), 25_000);
  mark("gallery-shown");
  const eye: Vec3 = (await readHeadPose(page)).position;
  const shelf = entered.gallery.shelf!;
  expect(entered.gallery.loadedItems, "the card's loaded feed, not a refetch").toBe(10);
  expect(entered.gallery.nextCursor).toBe("10");
  expect(feedRequests.filter((r) => r.cursor === null).length, "the feed fetched its first page").toBeGreaterThan(0);
  expect(feedRequests.slice(feedRequestsBeforeVr), "VR fetches nothing on entry").toEqual([]);
  expect(shelf.tiles.map((t) => t.title)).toEqual(["Runner 1", "Runner 2", "Runner 3", "Runner 4", "Runner 5", "Runner 6"]);
  expect(shelf.tiles[0]!.status, "the opened hologram's tile is empty while it is placed").toBe("placed");
  expect(shelf.tiles[0]!.hasPreview).toBe(false);
  expect(shelf.tiles.filter((t) => t.status === "ready").every((t) => t.hasPreview), "paused previews").toBe(true);
  expect(shelf.paging.newer.visible).toBe(false);
  expect(shelf.paging.older.visible).toBe(true);
  // The 404 shows on its tile and nothing else changes.
  const missing = shelf.tiles[4]!;
  expect(missing).toMatchObject({ title: "Runner 5", status: "error", label: "Couldn't load", hasPreview: false });
  // Wings at the sides: the shelf never stands between the eyes and the stage.
  for (const tile of shelf.tiles) {
    const toTile = Math.atan2(tile.worldPosition[0] - eye[0], -(tile.worldPosition[2] - eye[2])) * (180 / Math.PI);
    expect(Math.abs(toTile), `tile ${tile.index} at ${toTile.toFixed(0)}°`).toBeGreaterThan(75);
  }
  await warmControls(page, eye);
  const baseline = await settledRenderer(page);
  mark("baseline");
  await dwell(page);

  // Place three more: each at recorded scale on the floor beside the others, focused on arrival.
  const placedOrder = ["mock-2", "mock-3", "mock-4"];
  // Each one's foot chip, read while it has focus (one set of controls follows focus).
  const chipAt = (g: GallerySnapshot, id: string) => g.controls?.boundTo === id && horizontal(g.controls.foot.worldPosition, readingOf(g, id)!.worldPosition) < readingOf(g, id)!.footprintRadius + 0.1;
  const chips: Record<string, Vec3> = { "mock-1": entered.controls!.foot.worldPosition };
  for (const [i, id] of placedOrder.entries()) {
    await selectTile(page, i + 1, eye);
    const s = await waitForGallery(page, (g) => readingOf(g, id)?.placement.stage === "placed" && g.focusedId === id && chipAt(g, id));
    chips[id] = s.controls!.foot.worldPosition;
    expect(s.gallery.lastSelect).toMatchObject({ index: i + 1, result: "placed" });
    expect(s.gallery.shelf!.tiles[i + 1]!.status).toBe("placed");
    mark(`placed-${id}`);
  }
  const four = await gallerySnapshot(page);
  expect(four.holograms.map((h) => h.id)).toEqual(["mock-1", "mock-2", "mock-3", "mock-4"]);
  const groundDetails = four.holograms.map((h) => ({ id: h.id, baseY: h.worldPosition[1], feetAboveBaseM: h.lowestBoneY! - h.worldPosition[1], tiltRad: h.tiltRad, scale: h.worldScale[0] }));
  for (const h of four.holograms) {
    expect(h.worldScale.every((v) => Math.abs(v - 1) < 1e-6), `${h.id} at recorded scale`).toBe(true);
    expect(Math.abs(h.worldPosition[1]), `${h.id} base on the floor`).toBeLessThan(0.005);
    expect(feetOnGround(h), `${h.id} feet ${(h.lowestBoneY! - h.worldPosition[1]).toFixed(3)} m above its base`).toBe(true);
    expect(h.tiltRad, `${h.id} upright`).toBeLessThan(1e-3);
  }
  // Neighbours keep at least the chip's width plus a 30 apx gap.
  const minGap = four.chipWidthM + 30 * 0.000372 * 1.75;
  let closest = Infinity;
  for (const [i, a] of four.holograms.entries()) {
    for (const b of four.holograms.slice(i + 1)) closest = Math.min(closest, horizontal(a.worldPosition, b.worldPosition));
  }
  expect(closest, `closest pair ${closest.toFixed(3)} m vs chip ${four.chipWidthM.toFixed(3)} m + gap`).toBeGreaterThanOrEqual(minGap - 1e-3);
  // Placed where the viewer sees them whole: no hologram's bounds meet the
  // shelf, and none stands between the eyes and another's foot chip.
  const bounds = await sceneBounds(page);
  const shelfHits = Object.entries(bounds.holograms).flatMap(([id, box]) => bounds.shelf.filter((part) => boxesMeet(box, part)).map((part) => `${id} meets ${part.name}`));
  expect(shelfHits, "holograms clear of the shelf").toEqual([]);
  const blockedChips = Object.entries(chips).flatMap(([id, chip]) =>
    Object.entries(bounds.holograms)
      .filter(([other, box]) => other !== id && segmentMeetsBox(eye, chip, box))
      .map(([other]) => `${other} hides ${id}'s chip`)
  );
  expect(blockedChips, "every foot chip in sight").toEqual([]);
  const visibility = { shelfParts: bounds.shelf.length, chips, places: four.holograms.map((h) => ({ id: h.id, position: h.worldPosition })) };
  await captureEvidence(page, testInfo, "vr-gallery-four");

  // A fifth is refused: the cap is four.
  const fifth = await page.evaluate(() => (window as unknown as { __HOLOIM_XR_VIEWER__: { gallery: { select(i: number): Promise<string> } } }).__HOLOIM_XR_VIEWER__.gallery.select(5));
  expect(fifth).toBe("full");
  expect((await gallerySnapshot(page)).holograms).toHaveLength(4);
  // The 404 tile: selecting it changes nothing.
  await selectTile(page, 4, eye);
  const afterMissing = await waitForGallery(page, (g) => g.gallery.lastSelect?.index === 4);
  expect(afterMissing.gallery.lastSelect!.result).toBe("error");
  expect(afterMissing.holograms.map((h) => h.id)).toEqual(["mock-1", "mock-2", "mock-3", "mock-4"]);
  expect(afterMissing.focusedId).toBe("mock-4");

  // Each keeps its own state: pause the focused one at its foot.
  const playButton = (await gallerySnapshot(page)).controls!.foot.buttons.play.worldPosition;
  await setPose(page, "head", eye, playButton);
  await rayClick(page, playButton, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2]);
  const paused4 = await waitForGallery(page, (g) => readingOf(g, "mock-4")?.playing === false);
  expect(paused4.controls!.boundTo).toBe("mock-4");
  expect(paused4.controls!.foot.text.playback).toMatch(/^Paused · /);
  expect(readingOf(paused4, "mock-4")!.audio?.playing ?? false, "pausing stops its audio").toBe(false);
  for (const id of ["mock-1", "mock-2", "mock-3"]) expect(readingOf(paused4, id)!.playing, `${id} still plays`).toBe(true);
  mark("paused-mock-4");
  await dwell(page);

  // Focus moves to another by selecting its body: the ring and the controls follow, and so does the audio.
  const focusMoves: unknown[] = [];
  for (const id of ["mock-2", "mock-1"]) {
    await selectBody(page, id, eye);
    const s = await waitForGallery(page, (g) => g.focusedId === id && g.controls?.boundTo === id);
    const h = readingOf(s, id)!;
    expect(horizontal(s.controls!.ring.worldPosition, h.worldPosition), "ring around its base").toBeLessThan(0.01);
    expect(s.controls!.ring.visible).toBe(true);
    expect(horizontal(s.controls!.foot.worldPosition, h.worldPosition), "controls at its foot").toBeLessThan(h.footprintRadius + 0.1);
    const drift = expectAudioFocus(s, id);
    focusMoves.push({ id, driftS: drift, ring: s.controls!.ring, foot: s.controls!.foot.worldPosition });
    mark(`focus-${id}`);
    await dwell(page);
  }
  // Two play at once; only the focused one is heard. The paused one held its clock the whole time.
  const both = await gallerySnapshot(page);
  expect(readingOf(both, "mock-1")!.playing && readingOf(both, "mock-2")!.playing).toBe(true);
  expect(Math.abs(readingOf(both, "mock-4")!.clipTime - readingOf(paused4, "mock-4")!.clipTime), "paused clock held").toBeLessThan(1e-6);
  expectAudioFocus(both, "mock-1");
  // Spark focus follows the head's forward ray (§8.2), not the selection: a
  // look at mock-2 carries the sparks there, and the audio and the foot
  // controls stay with mock-1 until it is selected.
  const sparkMoves: unknown[] = [];
  for (const id of ["mock-2", "mock-1"]) {
    const at = readingOf(both, id)!.worldPosition;
    await setPose(page, "head", eye, [at[0], at[1] + 0.9, at[2]]);
    const s = await waitForGallery(page, (g) => g.bubbles.sparkFocusId === id, 5_000);
    expect(s.controls!.boundTo, "foot controls stay on the selected one").toBe("mock-1");
    expectAudioFocus(s, "mock-1");
    sparkMoves.push({ lookAt: id, sparkFocusId: s.bubbles.sparkFocusId, focusedId: s.focusedId });
    mark(`sparks-${id}`);
  }
  // Seeking the focused one on its timeline moves only its clock.
  const timeline = both.controls!.foot.timeline;
  await setPose(page, "head", eye, timeline.worldStart);
  await page.waitForTimeout(300);
  const scrubTo = lerp3(timeline.worldStart, timeline.worldEnd, 0.25);
  await rayClick(page, scrubTo, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2]);
  const sought = await waitForGallery(page, (g) => {
    const h = readingOf(g, "mock-1")!;
    return Math.abs(h.clipTime / h.duration - 0.25) < 0.08;
  });
  expect(Math.abs(readingOf(sought, "mock-4")!.clipTime - readingOf(paused4, "mock-4")!.clipTime), "others' clocks untouched").toBeLessThan(1e-6);
  expectAudioFocus(sought, "mock-1");
  mark("seek-mock-1");

  // A double select while one loads: placing is keyed by id, the second is ignored.
  const double = await page.evaluate(async () => {
    const probe = (window as unknown as { __HOLOIM_XR_VIEWER__: { space: { remove(id: string): boolean; place(item: { id: string; url: string }): Promise<string> }; gallery: { select(i: number): Promise<string> } } }).__HOLOIM_XR_VIEWER__;
    probe.space.remove("mock-3");
    // The same URL the gallery resolves, so the load is keyed as its tile's.
    const url = "/uploads/mock-avatar-3.glb";
    const first = probe.space.place({ id: "mock-3", url });
    const second = probe.space.place({ id: "mock-3", url });
    const repeat = [await probe.gallery.select(1), await probe.gallery.select(1)];
    return { first: await first, second: await second, repeat };
  });
  expect(double.first).toBe("placed");
  expect(double.second, "second select while loading").toBe("loading");
  // A repeated press of a tile (here, mock-2's: send back, then the same press again) is one select.
  expect(double.repeat).toEqual(["removed", "ignored-repeat"]);
  const afterDouble = await waitForGallery(page, (g) => readingOf(g, "mock-3")?.placement.stage === "placed");
  expect(afterDouble.holograms.filter((h) => h.id === "mock-3"), "one mock-3").toHaveLength(1);
  expect(afterDouble.holograms.map((h) => h.id).sort()).toEqual(["mock-1", "mock-3", "mock-4"]);

  // Back to the gallery from the shelf: removing the rest returns their tiles.
  for (const [index, id] of [[2, "mock-3"], [3, "mock-4"]] as const) {
    await selectTile(page, index, eye);
    const s = await waitForGallery(page, (g) => !readingOf(g, id) && g.gallery.shelf!.tiles[index]!.status === "ready");
    expect(s.gallery.lastSelect).toMatchObject({ index, result: "removed" });
    mark(`removed-${id}`);
  }
  // Page past the loaded feed: the next page is fetched with the feed cursor.
  await selectPaging(page, "older", eye);
  const older = await waitForGallery(page, (g) => g.gallery.page === 1 && pageSettled(g));
  mark("page-older");
  expect(feedRequests.some((r) => r.cursor === "10"), "fetched past the loaded feed with its cursor").toBe(true);
  expect(older.gallery.loadedItems).toBe(GALLERY_FEED_SIZE);
  expect(older.gallery.nextCursor).toBeNull();
  expect(older.gallery.shelf!.tiles.map((t) => t.title)).toEqual(["Runner 7", "Runner 8", "Runner 9", "Runner 10", "Runner 11", "Runner 12"]);
  expect(older.gallery.shelf!.paging).toMatchObject({ newer: { visible: true }, older: { visible: false } });
  await dwell(page);
  const olderRenderer = await settledRenderer(page);
  await selectPaging(page, "newer", eye);
  const back = await waitForGallery(page, (g) => g.gallery.page === 0 && pageSettled(g));
  mark("page-newer");
  expect(back.holograms.map((h) => h.id)).toEqual(["mock-1"]);
  await warmControls(page, eye);
  const afterRenderer = await settledRenderer(page);
  // Removed holograms and paged-out previews leave nothing behind.
  expect({ geometries: afterRenderer.geometries, textures: afterRenderer.textures }, `renderer counts back to the baseline ${JSON.stringify(baseline)}`).toEqual({ geometries: baseline.geometries, textures: baseline.textures });
  expect(Object.keys(back.cache).sort(), "cache holds only what is in the space and on the shelf").toEqual(
    ["mock-avatar-1", "mock-avatar-2", "mock-avatar-3", "mock-avatar-4", "mock-avatar-6"].map((name) => `/uploads/${name}.glb`)
  );

  // Exit returns to the feed at the last focused hologram.
  await selectTile(page, 2, eye);
  await waitForGallery(page, (g) => g.focusedId === "mock-3" && readingOf(g, "mock-3")?.placement.stage === "placed");
  const beforeExit = await gallerySnapshot(page);
  mark("vr-exit");
  await endSession(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".xr-view-container")).toHaveCount(0);
  await expect(page.locator('[data-card-id="mock-3"]'), "back on the focused hologram's card").toBeInViewport({ timeout: 10_000 });

  report.gallery = {
    timeline: marks,
    feedRequests,
    entered: { loadedItems: entered.gallery.loadedItems, nextCursor: entered.gallery.nextCursor, tiles: shelf.tiles.map(({ index, title, status, label }) => ({ index, title, status, label })) },
    placed: four.holograms.map((h) => ({ id: h.id, position: h.worldPosition, scale: h.worldScale[0], focused: h.focused })),
    ground: groundDetails,
    spacing: { closestM: closest, chipWidthM: four.chipWidthM, minimumM: minGap }, visibility,
    fifthSelect: fifth,
    missingTile: { tile: missing, select: afterMissing.gallery.lastSelect },
    paused: { id: "mock-4", clipTime: readingOf(paused4, "mock-4")!.clipTime, playback: paused4.controls!.foot.text.playback },
    focusMoves,
    sparkMoves,
    doubleSelect: double,
    paging: { older: older.gallery.shelf!.tiles.map((t) => t.title), loadedItems: older.gallery.loadedItems },
    renderer: { baseline, olderPage: olderRenderer, afterRemoveAndPage: afterRenderer },
    cacheAfter: back.cache,
    exit: { focusedId: beforeExit.focusedId }
  };
});

/** The locomotion rig stands on the flat floor (the viewer snaps IWSDK's float spring to it). */
const RIG_FLOOR_TOLERANCE_M = 1e-6;

/** Holds an IWER controller's thumbstick at (x, y); forward is y = −1 (WebXR standard mapping). */
async function setStick(page: Page, side: "left" | "right", x: number, y: number): Promise<void> {
  await page.evaluate(({ side, x, y }) => {
    (window as unknown as { IWER_DEVICE: { controllers: Record<string, { updateAxes(id: string, x: number, y: number): void }> } }).IWER_DEVICE.controllers[side]!.updateAxes("thumbstick", x, y);
  }, { side, x, y });
}

/**
 * Ray-clicks until `done` reads true. A click is a press and release within
 * 300 ms of frame time (pmndrs pointer events), and on a loaded machine IWER
 * frames can be further apart than that, so one click can be lost in emulation.
 */
async function rayClickUntil(page: Page, target: Vec3 | (() => Promise<Vec3>), from: Vec3, done: (g: GallerySnapshot) => boolean): Promise<GallerySnapshot> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await rayClick(page, typeof target === "function" ? await target() : target, from);
    try {
      return await waitForGallery(page, done, 3_000);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  throw new Error("unreachable");
}

/** World points in the player rig's space, where IWER poses the headset and controllers once locomotion has moved it. */
const toRig = (page: Page, points: Vec3[]) =>
  page.evaluate((points) => {
    type M = { clone(): M; invert(): M };
    type V = { x: number; y: number; z: number; applyMatrix4(m: M): V };
    const world = (window as unknown as { __HOLOIM_XR_VIEWER__: { world: { player: { matrixWorld: M }; camera: { position: { constructor: new (x: number, y: number, z: number) => V } } } } }).__HOLOIM_XR_VIEWER__.world;
    const inverse = world.player.matrixWorld.clone().invert();
    const Vector = world.camera.position.constructor;
    return points.map((point) => {
      const p = new Vector(...point).applyMatrix4(inverse);
      return [p.x, p.y, p.z] as Vec3;
    });
  }, points);

test("VR locomotion: the left stick slides, the right stick snap-turns 30° and teleports, and placed holograms, their foot controls and the shelf stay where they stand", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  await mockGalleryFeed(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 20_000 });
  await page.locator('[data-card-id="mock-1"]').scrollIntoViewIfNeeded();
  // The feed glides onto the card late on a loaded runner; a cursor
  // that reaches before it rests is left behind and the controls fold.
  await settleScroll(page);
  await dwell(page, 3);
  await reachFor(page.locator('[data-card-id="mock-1"]'));
  await page.locator('[data-card-id="mock-1"] .vr-trigger-button').click();
  await expect(page).toHaveURL(/\/vr\/mock-1$/);
  await enterSession(page, "Step inside", "opaque");
  await setPose(page, "head", null, null);
  const entered = await waitForGallery(page, (s) => s.placement.stage === "placed" && Boolean(s.controls) && pageSettled(s), 25_000);
  // The rig is still at the floor origin: IWER poses are world poses until the viewer moves.
  const eye: Vec3 = (await readHeadPose(page)).position;
  expect(Math.hypot(entered.player.position[0], entered.player.position[2]), `rig at the origin ${JSON.stringify(entered.player.position)}`).toBeLessThan(1e-6);
  expect(Math.abs(entered.player.position[1]), "rig on the floor").toBeLessThan(RIG_FLOOR_TOLERANCE_M);
  await selectTile(page, 1, eye);
  await waitForGallery(page, (g) => readingOf(g, "mock-2")?.placement.stage === "placed" && g.focusedId === "mock-2" && g.controls?.boundTo === "mock-2");
  mark("two-placed");
  // Ahead and level, the controllers lowered out of every pointer's way.
  await setPose(page, "head", eye, [eye[0], eye[1], eye[2] - 2]);
  await setPose(page, "left", [eye[0] - 0.25, eye[1] - 0.5, eye[2] - 0.2], [eye[0] - 0.25, 0, eye[2] - 0.6]);
  await setPose(page, "right", [eye[0] + 0.25, eye[1] - 0.5, eye[2] - 0.2], [eye[0] + 0.25, 0, eye[2] - 0.6]);
  // The bare VR row's chip fades in over its own 0.3 s, after its glyphs' 240 ms.
  const fade = await measureChipFade(page, eye, (await gallerySnapshot(page)).controls!.foot.worldPosition);
  expect(fade.length, "a frame with the chip mid-fade").toBeGreaterThan(0);
  for (const { glyph, chip } of fade) {
    if (glyph < 1) expect(chip / glyph, `chip ${chip.toFixed(3)} vs glyphs ${glyph.toFixed(3)}: 0.3 s vs 240 ms`).toBeCloseTo(240 / 300, 2);
    else expect(chip, `chip ${chip.toFixed(3)} with the glyphs full`).toBeGreaterThanOrEqual(240 / 300 - 1e-3);
  }
  mark("chip-fade");
  await setPose(page, "head", eye, [eye[0], eye[1], eye[2] - 2]);
  await dwell(page);
  const before = await gallerySnapshot(page);
  const tilesOf = (g: GallerySnapshot) => g.gallery.shelf!.tiles.map((t) => t.worldPosition);

  /** Placed holograms, their foot chip and the shelf have not moved; every base is still on the floor. */
  // IWSDK eases the slide's black comfort vignette by 10 × the frame delta; on
  // a long frame that overshoots and the view goes black. It stays within the
  // comfort strength (IWSDK's 0.5).
  const expectVignetteInRange = (g: GallerySnapshot, step: string) => {
    expect(g.player.vignetteAlpha, `${step}: comfort vignette not negative`).toBeGreaterThanOrEqual(0);
    expect(g.player.vignetteAlpha, `${step}: comfort vignette within its strength`).toBeLessThanOrEqual(0.5 + 1e-6);
  };
  const expectSpaceHeld = (g: GallerySnapshot, step: string) => {
    for (const h of g.holograms) {
      const was = readingOf(before, h.id)!;
      expect(Math.hypot(h.worldPosition[0] - was.worldPosition[0], h.worldPosition[1] - was.worldPosition[1], h.worldPosition[2] - was.worldPosition[2]), `${step}: ${h.id} stays where it stands`).toBeLessThan(1e-6);
      expect(Math.abs(h.worldPosition[1]), `${step}: ${h.id} base on the floor`).toBeLessThan(0.005);
      expect(feetOnGround(h), `${step}: ${h.id} feet on the floor`).toBe(true);
      expect(h.tiltRad, `${step}: ${h.id} upright`).toBeLessThan(1e-3);
    }
    expect(g.controls!.boundTo, `${step}: one foot-control set, on the focused hologram`).toBe("mock-2");
    expect(horizontal(g.controls!.foot.worldPosition, before.controls!.foot.worldPosition), `${step}: foot chip held`).toBeLessThan(1e-6);
    expect(g.controls!.foot.yaw, `${step}: the chip does not turn with the viewer`).toBeCloseTo(before.controls!.foot.yaw, 6);
    tilesOf(g).forEach((tile, i) => expect(horizontal(tile, tilesOf(before)[i]!), `${step}: shelf tile ${i} held`).toBeLessThan(1e-6));
    expectVignetteInRange(g, step);
  };

  // Slide: the left stick pushed forward carries the rig the way the head faces, on the floor.
  mark("slide");
  await setStick(page, "left", 0, -1);
  await page.waitForTimeout(700);
  const sliding = await gallerySnapshot(page);
  expectVignetteInRange(sliding, "sliding");
  expect(sliding.player.vignetteAlpha, "the comfort vignette closes in while sliding").toBeGreaterThan(0);
  await setStick(page, "left", 0, 0);
  await page.waitForTimeout(300);
  const slid = await gallerySnapshot(page);
  const slide = [0, 1, 2].map((i) => slid.player.position[i]! - before.player.position[i]!) as Vec3;
  expect(-slide[2], `slid ${slide[2].toFixed(3)} m along the head's forward (−z)`).toBeGreaterThan(0.3);
  expect(Math.abs(slide[0]), "straight ahead").toBeLessThan(Math.abs(slide[2]) * 0.1);
  expect(Math.abs(slid.player.position[1]), "the rig stays on the local floor while it slides").toBeLessThan(RIG_FLOOR_TOLERANCE_M);
  expect(Math.abs(slid.player.yawRad - before.player.yawRad), "a slide does not turn").toBeLessThan(1e-6);
  // Released: the rig holds still on the floor.
  const settled = await waitForGallery(page, (g) => Math.abs(g.player.position[1]) < RIG_FLOOR_TOLERANCE_M, 5_000);
  expect(horizontal(settled.player.position, slid.player.position), "stops when the stick is released").toBeLessThan(0.01);
  expect(Math.abs(settled.player.position[1]), "at rest on the local floor").toBeLessThan(RIG_FLOOR_TOLERANCE_M);
  expectSpaceHeld(settled, "slide");
  await dwell(page, 0.6);

  // Snap turn: a right-stick flick held for a while turns 30° once, about the head.
  mark("snap-turn");
  const headBeforeTurn = (await readHeadPose(page)).position;
  await setStick(page, "right", 1, 0);
  await page.waitForTimeout(500);
  await setStick(page, "right", 0, 0);
  await page.waitForTimeout(200);
  const turned = await gallerySnapshot(page);
  const turnDeg = ((turned.player.yawRad - settled.player.yawRad) * 180) / Math.PI;
  expect(turnDeg, `one snap to the right, ${turnDeg.toFixed(2)}°`).toBeCloseTo(-30, 1);
  const headAfterTurn = (await readHeadPose(page)).position;
  expect(horizontal(headAfterTurn, headBeforeTurn), "the turn pivots on the head").toBeLessThan(0.01);
  expectSpaceHeld(turned, "snap turn");
  await dwell(page, 0.6);

  // Teleport: pull the right stick back, aim at open floor behind (the holograms
  // and the shelf stand ahead and at the sides, and a ray on them holds the aim), release to land.
  mark("teleport");
  const turnedForward = (await readHeadPose(page)).forward;
  const aimWorld: Vec3 = [headAfterTurn[0] - turnedForward[0] * 2.5, 0, headAfterTurn[2] - turnedForward[2] * 2.5];
  const [aimRig] = await toRig(page, [aimWorld]);
  await setPose(page, "right", [eye[0] + 0.2, eye[1] - 0.3, eye[2] - 0.2], aimRig!);
  await setStick(page, "right", 0, 1);
  // IWSDK eases its landing marker a fifth of the way to the arc's hit each frame.
  await page.waitForTimeout(2_500);
  const aiming = await gallerySnapshot(page);
  expect(horizontal(aiming.player.position, turned.player.position), "aiming alone does not move").toBeLessThan(1e-3);
  await setStick(page, "right", 0, 0);
  // Landed once the rig has moved, standing on the floor.
  const landed = await waitForGallery(page, (g) => horizontal(g.player.position, turned.player.position) > 0.5 && Math.abs(g.player.position[1]) < RIG_FLOOR_TOLERANCE_M, 5_000);
  const jump = horizontal(landed.player.position, turned.player.position);
  expect(jump, `teleported ${jump.toFixed(2)} m`).toBeGreaterThan(0.75);
  // Toward the aim: behind, along the turned facing.
  const toLanding = [landed.player.position[0] - turned.player.position[0], landed.player.position[2] - turned.player.position[2]];
  const along = -(toLanding[0]! * turnedForward[0] + toLanding[1]! * turnedForward[2]) / (jump * Math.hypot(turnedForward[0], turnedForward[2]));
  expect(along, `landed ${(Math.acos(Math.min(1, along)) * 180 / Math.PI).toFixed(0)}° off the aim`).toBeGreaterThan(Math.cos((20 * Math.PI) / 180));
  expect(Math.abs(landed.player.position[1]), "lands on the local floor").toBeLessThan(RIG_FLOOR_TOLERANCE_M);
  expect(Math.abs(landed.player.yawRad - turned.player.yawRad), "a teleport keeps the facing").toBeLessThan(1e-6);
  expectSpaceHeld(landed, "teleport");
  await dwell(page);

  // From the new spot, recenter brings the focused hologram 1.5 m ahead of the viewer, standing on the floor.
  mark("recenter-after-moving");
  const head = await readHeadPose(page);
  // Look at the chip so its reach row opens, then aim at the recenter glyph where the row laid it out.
  const [chipRig] = await toRig(page, [landed.controls!.foot.worldPosition]);
  await setPose(page, "head", eye, chipRig!);
  await waitForGallery(page, (g) => g.controls!.foot.reachOpacity === 1, 5_000);
  // The row lays its buttons out over the frames after it opens: aim where the glyph has settled, read again each try.
  const recenterRig = async (): Promise<Vec3> => {
    let at = (await gallerySnapshot(page)).controls!.foot.buttons.recenter.worldPosition;
    for (let read = 0; read < 10; read++) {
      await page.waitForTimeout(250);
      const next = (await gallerySnapshot(page)).controls!.foot.buttons.recenter.worldPosition;
      const moved = Math.hypot(next[0] - at[0], next[1] - at[1], next[2] - at[2]);
      at = next;
      if (moved < 1e-4) break;
    }
    const [rig] = await toRig(page, [at]);
    return rig!;
  };
  await setPose(page, "head", eye, await recenterRig());
  const recentered = await rayClickUntil(page, recenterRig, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2], (g) => readingOf(g, "mock-2")!.placement.sequence > readingOf(landed, "mock-2")!.placement.sequence);
  const moved = readingOf(recentered, "mock-2")!;
  const viewer = (await readHeadPose(page)).position;
  expect(Math.abs(horizontal(moved.worldPosition, viewer) - 1.5), `recentered ${horizontal(moved.worldPosition, viewer).toFixed(3)} m from the moved viewer`).toBeLessThan(0.05);
  expect(Math.abs(moved.worldPosition[1]), "recentered on the floor").toBeLessThan(0.005);
  expect(feetOnGround(moved)).toBe(true);
  expect(horizontal(recentered.controls!.foot.worldPosition, moved.worldPosition), "its foot controls came with it").toBeLessThan(moved.footprintRadius + 0.1);
  expect(horizontal(readingOf(recentered, "mock-1")!.worldPosition, readingOf(before, "mock-1")!.worldPosition), "the other stays where it stood").toBeLessThan(1e-6);
  mark("recentered");
  await dwell(page);

  // The shelf still answers from here: a tile places its hologram on the stage's floor.
  mark("shelf-after-moving");
  const tileWorld = recentered.gallery.shelf!.tiles[2]!.worldPosition;
  const [tileRig] = await toRig(page, [tileWorld]);
  await setPose(page, "head", eye, tileRig!);
  await rayClickUntil(page, tileRig!, [eye[0] + 0.2, eye[1] - 0.35, eye[2] - 0.2], (g) => g.gallery.lastSelect?.index === 2);
  const third = await waitForGallery(page, (g) => readingOf(g, "mock-3")?.placement.stage === "placed" && g.focusedId === "mock-3");
  const mock3 = readingOf(third, "mock-3")!;
  expect(Math.abs(mock3.worldPosition[1]), "placed on the floor after moving").toBeLessThan(0.005);
  expect(feetOnGround(mock3)).toBe(true);
  expect(third.controls!.boundTo).toBe("mock-3");
  mark("placed-mock-3");
  await captureEvidence(page, testInfo, "vr-locomotion");
  await endSession(page);
  await expect(page).toHaveURL(/\/$/);

  report.locomotion = {
    timeline: marks,
    player: { before: before.player, slid: slid.player, turned: turned.player, landed: landed.player },
    slideM: slide,
    turnDeg,
    chipFade: fade,
    teleportM: jump,
    headPivotM: horizontal(headAfterTurn, headBeforeTurn),
    recenter: { distanceM: horizontal(moved.worldPosition, viewer), headBefore: head.position, position: moved.worldPosition },
    shelfPlace: mock3.worldPosition
  };
});

test("AR (IWSDK shell, phone): two holograms from the gallery stand on the floor side by side, each focused by a tap", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await emulatePhone(page);
  await mockGalleryFeed(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 20_000 });
  await page.locator('[data-card-id="mock-1"]').scrollIntoViewIfNeeded();
  // The feed glides onto the card late on a loaded runner; a cursor
  // that reaches before it rests is left behind and the controls fold.
  await settleScroll(page);
  await dwell(page, 3);
  await reachFor(page.locator('[data-card-id="mock-1"]'));
  await page.locator('[data-card-id="mock-1"] .ar-trigger-button').click();
  await expect(page).toHaveURL(/\/ar\/mock-1$/);
  await enterSession(page, "View in your room", "alpha-blend");
  await setPose(page, "head", null, null);
  const first = await waitForGallery(page, (s) => s.placement.stage !== "searching" && Boolean(s.controls) && pageSettled(s), 25_000);
  mark("ar-first");
  expect(first.controls!.target).toBe("ar-phone");
  const eye: Vec3 = (await readHeadPose(page)).position;
  const tile = first.gallery.shelf!.tiles[1]!;
  // Turn to the shelf and tap Runner 2.
  await setPose(page, "head", eye, tile.worldPosition);
  await dwell(page);
  await phoneTap(page, tile.worldPosition);
  const second = await waitForGallery(page, (s) => readingOf(s, "mock-2")?.placement.stage === "anchored" && s.focusedId === "mock-2", 15_000);
  mark("ar-second");
  const [a, b] = [readingOf(second, "mock-1")!, readingOf(second, "mock-2")!];
  expect(["hit-test", "floor"], "on the floor point a hit test found, or the floor estimate").toContain(b.placement.mode);
  for (const h of [a, b]) {
    expect(h.worldScale[0], `${h.id} at recorded scale`).toBeCloseTo(1, 6);
    expect(feetOnGround(h), `${h.id} feet on its ground`).toBe(true);
    expect(Math.abs(h.worldPosition[1] - a.worldPosition[1]), `${h.id} on the same floor`).toBeLessThan(0.05);
  }
  const apart = horizontal(a.worldPosition, b.worldPosition);
  expect(apart, "side by side, chips apart").toBeGreaterThanOrEqual(second.chipWidthM);
  expectAudioFocus(second, "mock-2");
  // Turn back to the stage: both stand there; a tap on the first focuses it.
  const middle = lerp3(a.worldPosition, b.worldPosition, 0.5);
  await setPose(page, "head", [eye[0], eye[1], eye[2] + 0.6], [middle[0], 0.7, middle[2]]);
  await dwell(page);
  await phoneTap(page, [a.worldPosition[0], a.worldPosition[1] + a.recordedSize[1] * 0.55, a.worldPosition[2]]);
  const refocused = await waitForGallery(page, (s) => s.focusedId === "mock-1" && s.controls?.boundTo === "mock-1");
  mark("ar-refocus");
  expect(readingOf(refocused, "mock-1")!.playing, "a tap on an unfocused hologram focuses it, without pausing it").toBe(true);
  expectAudioFocus(refocused, "mock-1");
  await captureEvidence(page, testInfo, "ar-phone-two");
  // Off the screen's centre, the focused one's reach row still keeps the 16 px gutters
  // (a row centred on its foot would cross the screen's edge).
  const phoneWidth = page.viewportSize()!.width;
  const offCentre: Array<{ side: string; footPx: number; leftPx: number; rightPx: number }> = [];
  const viewer: Vec3 = [eye[0], eye[1], eye[2] + 0.6];
  for (const side of [1, -1]) {
    const toward = [a.worldPosition[0] - viewer[0], a.worldPosition[2] - viewer[2]];
    const length = Math.hypot(toward[0]!, toward[1]!);
    // Look beside it, so it stands toward the right (side 1) or left (side -1) of the screen.
    const look: Vec3 = [a.worldPosition[0] + side * (toward[1]! / length) * 0.35, a.worldPosition[1] + a.recordedSize[1] * 0.45, a.worldPosition[2] - side * (toward[0]! / length) * 0.35];
    await setPose(page, "head", viewer, look);
    await waitForGallery(page, (s) => s.controls!.foot.reachOpacity === 1 && s.controls!.boundTo === "mock-1", 5_000);
    // The row settles at its new place on screen.
    const { foot, left: rowLeft, right: rowRight } = await settledReachRow(page);
    const [chip] = await toScreen(page, [foot.worldPosition]);
    const half = (rowRight!.x - rowLeft!.x) / 2;
    const reading = { side: side > 0 ? "right" : "left", footPx: chip!.x, leftPx: rowLeft!.x, rightPx: rowRight!.x };
    offCentre.push(reading);
    if (side > 0) expect(chip!.x + half, "centred on its foot, the row would cross the right edge").toBeGreaterThan(phoneWidth - 16);
    else expect(chip!.x - half, "centred on its foot, the row would cross the left edge").toBeLessThan(16);
    expect(rowLeft!.x, `${reading.side} of centre: row left edge inside the gutter`).toBeGreaterThanOrEqual(16 - 0.01);
    expect(rowRight!.x, `${reading.side} of centre: row right edge inside the gutter`).toBeLessThanOrEqual(phoneWidth - 16 + 0.01);
    mark(`ar-off-centre-${reading.side}`);
    if (side > 0) await captureEvidence(page, testInfo, "ar-phone-off-centre");
    await dwell(page);
  }
  await dwell(page);
  await endSession(page);
  await expect(page).toHaveURL(/\/$/);
  report.arGallery = {
    timeline: marks,
    holograms: [a, b].map((h) => ({ id: h.id, position: h.worldPosition, mode: h.placement.mode, stage: h.placement.stage })),
    apartM: apart,
    chipWidthM: second.chipWidthM,
    focusAfterTap: refocused.focusedId,
    offCentre
  };
});

test("AR (IWSDK shell, phone): places on the floor ahead, a tap on the hologram pauses and resumes it, a tap on the floor moves it, two fingers rescale it, and exit returns to the feed", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const { marks, mark, markFirstCommit } = createTimeline();
  markFirstCommit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockFeed(page);
  await emulatePhone(page);
  // The feed's "View in your room" trigger opens the IWSDK AR shell, the default.
  await page.goto("/");
  mark("feed-loaded");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  const arTrigger = page.locator(".ar-trigger-button");
  await expect(arTrigger.locator("button")).toHaveAttribute("aria-label", "View in your room", { timeout: 15_000 });
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  mark("feed-ready");
  await dwell(page, 3);
  mark("view-in-room");
  await reachFor(page.locator(".feed-card").first());
  await arTrigger.click();
  await expect(page).toHaveURL(/\/ar\/mock-1$/);
  await enterSession(page, "View in your room", "alpha-blend");
  mark("ar-immersive");

  const placed = await waitForSnapshot(page, (s) => s.placement.stage !== "searching" && s.hologram.visible);
  mark("ar-placed");
  expect(placed.hologram.lowestBoneY! - placed.hologram.worldPosition[1], "feet on the surface").toBeGreaterThan(-0.01);
  expect(placed.hologram.lowestBoneY! - placed.hologram.worldPosition[1], "feet on the surface").toBeLessThan(0.15);
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
  // Frame the whole hologram, its foot in the lower half of the screen: the controls come
  // (on a phone the screen is the hand), and the reach row fits the screen's 16 px gutters.
  const standing = moved.hologram.worldPosition;
  const tall = moved.hologram.recordedSize[1];
  // In office_small the clear floor in front of the desk is under a metre
  // away: step back to 1.5 m, as a viewer would, to see all of it.
  const eyeNow = (await readHeadPose(page)).position;
  const away = [eyeNow[0] - standing[0], eyeNow[2] - standing[2]];
  const awayLength = Math.hypot(away[0]!, away[1]!) || 1;
  const stepBack: Vec3 = [standing[0] + (away[0]! / awayLength) * 1.5, eyeNow[1], standing[2] + (away[1]! / awayLength) * 1.5];
  await setPose(page, "head", stepBack, [standing[0], standing[1] + tall * 0.45, standing[2]]);
  const rowBudget = page.viewportSize()!.width - 32;
  const near = await waitForSnapshot(page, (s) => s.controls!.foot.reachOpacity === 1 && s.controls!.foot.reachRow.widthApx > 0 && s.controls!.foot.reachRow.widthApx <= rowBudget + 0.5, 3_000);
  expect(near.controls!.foot.reachRow.widthApx).toBeGreaterThan(0);
  let { foot, left: rowLeft, right: rowRight } = await settledReachRow(page);
  const [crown, feet] = await toScreen(page, [[standing[0], standing[1] + tall, standing[2]], standing]);
  const phoneSize = page.viewportSize()!;
  await captureEvidence(page, testInfo, "ar-phone-framed");
  expect(crown!.y, "the hologram's head is in view").toBeGreaterThan(0);
  expect(feet!.y, "its feet are in view").toBeLessThan(phoneSize.height);
  // The row is fitted to the gutters exactly; allow float error.
  expect(rowLeft!.x, "reach row left edge inside the 16 px gutter").toBeGreaterThanOrEqual(16 - 0.01);
  expect(rowRight!.x, "reach row right edge inside the 16 px gutter").toBeLessThanOrEqual(phoneSize.width - 16 + 0.01);
  await dwell(page);

  // Walking 2 m round it, the phone's row stays where it was placed but turns
  // to face the phone every frame: level on screen and inside the gutters.
  mark("walk-round");
  const lookAt: Vec3 = [standing[0], standing[1] + tall * 0.45, standing[2]];
  const startAngle = Math.atan2(away[0]!, away[1]!);
  const walkAngle = 2 / 1.5;
  for (let i = 1; i <= 20; i++) {
    const angle = startAngle + walkAngle * (i / 20);
    await setPose(page, "head", [standing[0] + Math.sin(angle) * 1.5, eyeNow[1], standing[2] + Math.cos(angle) * 1.5], lookAt);
    await page.waitForTimeout(40);
  }
  const walked = await settledReachRow(page);
  const walkedRow = { leftPx: walked.left.x, rightPx: walked.right.x, tiltPx: walked.right.y - walked.left.y };
  expect(Math.abs(walkedRow.tiltPx), `after walking round, the row's ends are level on screen (${walkedRow.tiltPx.toFixed(1)} px apart)`).toBeLessThanOrEqual(10);
  expect(walked.left.x, "after walking round, row left edge inside the gutter").toBeGreaterThanOrEqual(16 - 0.01);
  expect(walked.right.x, "after walking round, row right edge inside the gutter").toBeLessThanOrEqual(phoneSize.width - 16 + 0.01);
  expect(horizontal(walked.foot.worldPosition, foot.worldPosition), "the row turns in place; it never follows the viewer").toBeLessThan(0.001);
  await captureEvidence(page, testInfo, "ar-phone-walked-round");
  await setPose(page, "head", stepBack, lookAt);
  // The row turns back and its slide settles over a few frames.
  await page.waitForTimeout(600);
  ({ foot, left: rowLeft, right: rowRight } = await settledReachRow(page));
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

  // Two fingers rescale it about its feet (Q13): closing them halves it, and
  // neither finger taps (it keeps playing where it stands).
  const beforePinch = await snapshot(page);
  const [px, py, pz] = beforePinch.hologram.worldPosition;
  const pinchAt: Vec3 = [px, py + beforePinch.hologram.recordedSize[1] * 0.5, pz];
  mark("ar-pinch-in");
  await phonePinch(page, pinchAt, 240, 120, 12);
  const shrunk = await waitForSnapshot(page, (s) => s.hologram.worldScale[0] < 0.75, 3_000);
  expect(shrunk.hologram.worldScale[0], "half the spread, about half the size").toBeGreaterThan(0.4);
  expect(shrunk.hologram.worldScale[0], "half the spread, about half the size").toBeLessThan(0.6);
  expect(shrunk.controls!.foot.text.scale, "the chip says how big").toBe(`${Math.round(shrunk.hologram.worldScale[0] * 100)}%`);
  expect(horizontal(shrunk.hologram.worldPosition, beforePinch.hologram.worldPosition), "a pinch never moves it").toBeLessThan(0.001);
  expect(Math.abs(shrunk.hologram.worldPosition[1] - py), "its feet stay on the floor").toBeLessThan(0.001);
  expect(shrunk.placement.sequence, "neither finger tapped the floor").toBe(beforePinch.placement.sequence);
  expect(shrunk.hologram.playing, "neither finger tapped the hologram").toBe(true);
  await captureEvidence(page, testInfo, "ar-phone-pinched");
  await dwell(page);
  mark("ar-pinch-out");
  await phonePinch(page, pinchAt, 120, 240, 12);
  const restored = await waitForSnapshot(page, (s) => s.hologram.worldScale[0] > 0.9, 3_000);
  expect(restored.hologram.worldScale[0], "back near the recorded scale, it snaps to life size").toBeCloseTo(1, 6);
  expect(restored.controls!.foot.text.scale).toBe("life size");
  await dwell(page);

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
      reachRowPx: { left: rowLeft!.x, right: rowRight!.x, screenWidth: phoneSize.width, timelineApx: foot.timeline.lengthApx, walkedRound: walkedRow },
      bodyInViewPx: { crown: crown!.y, feet: feet!.y, screenHeight: phoneSize.height },
      dockOnScreen,
      chipOpacity: phone.foot.chipOpacity,
      metresPerApx: phone.foot.metresPerApx,
      dock: phone.dock,
      glyphPause: { clipTime: glyphPaused.hologram.clipTime, playback: glyphPaused.controls!.foot.text.playback },
      drag: { duration, target: 0.8 * duration, clipTime: dragged.hologram.clipTime, resumeAudioDriftS: dragDrift }
    }
  };
});

type FloorReading = {
  placementY: number;
  authorY: number;
  clocheBaseY: number | null;
  terrainLowestY: number;
  terrainVisible: boolean;
  /** The terrain's farthest corner from the clip sphere's centre, over its radius: under 1 is all inside, unclipped. */
  terrainReach: number;
};

/** B-022 in the IWSDK shells: where the author's recorded floor and the terrain below it end up. */
async function readFloor(page: Page): Promise<FloorReading> {
  return page.evaluate(() => {
    type V = { x: number; y: number; z: number; clone(): V; set(x: number, y: number, z: number): V; distanceTo(v: V): number };
    type O = { name: string; visible: boolean; parent: O | null; getObjectByName(name: string): O | undefined; getWorldPosition(v: V): V; localToWorld(v: V): V; updateWorldMatrix(p: boolean, c: boolean): void; traverse(f: (o: O) => void): void; isMesh?: boolean; geometry?: { boundingBox: { min: V; max: V } | null; computeBoundingBox(): void }; matrixWorld: unknown };
    const probe = (window as unknown as { __floorProbe: { model: O; group: { current: O }; cloche: { current: { base: { x: number; y: number; z: number } } | null }; bubble: { radius: number; center: V } } }).__floorProbe;
    const group = probe.group.current;
    group.updateWorldMatrix(true, true);
    const at = probe.bubble.center.clone();
    const placementY = group.getWorldPosition(at.clone()).y;
    const authorY = probe.model.getObjectByName("RecordedAvatar")!.getWorldPosition(at.clone()).y;
    const shape = probe.cloche.current;
    const clocheBaseY = shape ? group.localToWorld(at.clone().set(shape.base.x, shape.base.y, shape.base.z)).y : null;
    const terrain = probe.model.getObjectByName("RecordedSceneBubble")!;
    let terrainLowestY = Infinity;
    let reach = 0;
    let terrainVisible = true;
    for (let node: O | null = terrain; node; node = node.parent) terrainVisible &&= node.visible;
    terrain.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      node.geometry.computeBoundingBox();
      const { min, max } = node.geometry.boundingBox!;
      for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
        const corner = node.localToWorld(at.clone().set(x, y, z));
        terrainLowestY = Math.min(terrainLowestY, corner.y);
        reach = Math.max(reach, corner.distanceTo(probe.bubble.center) / probe.bubble.radius);
      }
    });
    return { placementY, authorY, clocheBaseY, terrainLowestY, terrainVisible, terrainReach: reach };
  });
}

function expectOnRecordedFloor(label: string, floor: FloorReading): void {
  expect(Math.abs(floor.authorY - floor.placementY), `${label}: the author's recorded floor on the floor (${JSON.stringify(floor)})`).toBeLessThan(0.01);
  expect(floor.clocheBaseY, `${label}: cloche fitted`).not.toBeNull();
  expect(Math.abs(floor.clocheBaseY! - floor.placementY), `${label}: cloche foot on the floor`).toBeLessThan(0.05);
  expect(floor.placementY - floor.terrainLowestY, `${label}: the terrain below the author's floor still hangs below it`).toBeCloseTo(TERRAIN_DROP_M, 2);
  expect(floor.terrainVisible, `${label}: terrain drawn`).toBe(true);
  expect(floor.terrainReach, `${label}: terrain inside the bubble, so not clipped`).toBeLessThan(1);
}

async function observeFloor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __HOLOIM_AR_TEST_OBSERVER__: (value: unknown) => void }).__HOLOIM_AR_TEST_OBSERVER__ = (value) => {
      (window as unknown as { __floorProbe: unknown }).__floorProbe = value;
    };
  });
}

test("B-022: VR stands an author recorded on a ledge on its recorded floor, with the drop below it still in view", async ({ page }, testInfo) => {
  await observeFloor(page);
  await mockFeed(page, terrainGltf());
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  await reachFor(page.locator(".feed-card").first());
  await page.locator(".vr-trigger-button").click();
  await enterSession(page, "Step inside", "opaque");
  const placed = await waitForSnapshot(page, (s) => s.placement.stage === "placed" && s.hologram.visible);
  expect(placed.hologram.worldPosition[1], "VR places on the floor").toBeCloseTo(0, 3);
  await page.waitForFunction(() => Boolean((window as unknown as { __floorProbe?: { bubble: { active: boolean } } }).__floorProbe?.bubble.active));
  const floor = await readFloor(page);
  expectOnRecordedFloor("VR", floor);
  await captureEvidence(page, testInfo, "vr-recorded-floor");
  await endSession(page);
});

test("B-022: phone AR stands an author recorded on a ledge on the room's floor, with the drop below it still in view", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await observeFloor(page);
  await mockFeed(page, terrainGltf());
  await emulatePhone(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  await expect(page.locator('[data-card-id="mock-1"]')).toHaveAttribute("data-model-state", "rendered", { timeout: 15_000 });
  await reachFor(page.locator(".feed-card").first());
  await page.locator(".ar-trigger-button").click();
  await expect(page).toHaveURL(/\/ar\/mock-1$/);
  await enterSession(page, "View in your room", "alpha-blend");
  const placed = await waitForSnapshot(page, (s) => s.placement.stage !== "searching" && s.hologram.visible);
  expect(placed.hologram.worldPosition[1], "AR stands it on a floor, not furniture").toBeLessThan(0.5);
  await page.waitForFunction(() => Boolean((window as unknown as { __floorProbe?: { bubble: { active: boolean } } }).__floorProbe?.bubble.active));
  const floor = await readFloor(page);
  expectOnRecordedFloor("AR", floor);
  await captureEvidence(page, testInfo, "ar-recorded-floor");
  await endSession(page);
});
