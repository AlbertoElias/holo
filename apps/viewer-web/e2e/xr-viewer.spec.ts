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
const AUDIO_SYNC_TOLERANCE_S = 0.05;

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
    recordedSize: Vec3;
    playing: boolean;
    clipTime: number;
    duration: number;
    actionTimes: number[];
    audio: { playing: boolean; scheduledOffset: number; duration: number } | null;
  };
  renderer: { geometries: number; textures: number; calls: number };
};

const report: Record<string, unknown> = {};

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
    extensions?: Record<string, unknown>;
    extensionsUsed?: string[];
  };
  const binStart = 20 + jsonLength;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
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
        // Taps toward a world point: the ray from the viewer through it.
        (window as { __phoneTap?: unknown }).__phoneTap = async (target: [number, number, number]) => {
          const probe = (window as { __HOLOIM_XR_VIEWER__?: { world: { camera: { worldToLocal(v: unknown): { x: number; y: number; z: number }; position: { constructor: new (x: number, y: number, z: number) => object } }; renderer: { xr: { getSession(): XRSession | null } } } } }).__HOLOIM_XR_VIEWER__;
          const session = probe?.world.renderer.xr.getSession();
          if (!probe || !session) throw new Error("no XR session");
          const camera = probe.world.camera;
          const Vector = camera.position.constructor;
          const local = camera.worldToLocal(new Vector(...target));
          const length = Math.hypot(local.x, local.y, local.z);
          const [x, y, z] = [local.x / length, local.y / length, local.z / length];
          // Rotation taking -Z onto (x, y, z), as a column-major matrix.
          const axis = [y, -x, 0];
          const axisLength = Math.hypot(axis[0]!, axis[1]!);
          const angle = Math.acos(Math.min(1, Math.max(-1, -z)));
          const [ax, ay] = axisLength > 1e-6 ? [axis[0]! / axisLength, axis[1]! / axisLength] : [1, 0];
          const c = Math.cos(angle);
          const s = Math.sin(angle);
          const t = 1 - c;
          const m = new Float32Array([
            t * ax * ax + c, t * ax * ay, -s * ay, 0,
            t * ax * ay, t * ay * ay + c, s * ax, 0,
            s * ay, -s * ax, c, 0,
            0, 0, 0, 1
          ]);
          // A finger mark where the tap lands, for recordings.
          const screen = (new Vector(...target) as unknown as { project(c: unknown): { x: number; y: number } }).project(camera);
          const mark = document.createElement("div");
          mark.dataset.phoneTap = "";
          mark.style.cssText = `position:fixed;z-index:99999;pointer-events:none;width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:3px solid #fff3cf;background:rgb(255 200 114 / 45%);left:${(screen.x + 1) / 2 * innerWidth}px;top:${(1 - screen.y) / 2 * innerHeight}px`;
          document.body.append(mark);
          setTimeout(() => mark.remove(), 900);
          const source = new InputSource("none", "screen", ["generic-touchscreen", "generic-button"], new Space(device.viewerSpace, m));
          screenSources.push(source);
          const EventCtor = (globalThis as { XRInputSourceEvent?: new (type: string, init: object) => Event }).XRInputSourceEvent;
          if (!EventCtor) throw new Error("XRInputSourceEvent unavailable");
          await frameOf(session);
          await frameOf(session, (frame) => session.dispatchEvent(new EventCtor("selectstart", { frame, inputSource: source })));
          await new Promise((resolve) => setTimeout(resolve, 200));
          await frameOf(session, (frame) => {
            session.dispatchEvent(new EventCtor("select", { frame, inputSource: source }));
            session.dispatchEvent(new EventCtor("selectend", { frame, inputSource: source }));
          });
          screenSources.splice(screenSources.indexOf(source), 1);
          await frameOf(session);
        };
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
  await expect.poll(async () => {
    last = await snapshot(page).catch(() => null);
    return last ? accept(last) : false;
  }, { timeout }).toBe(true);
  return last!;
}

async function readHeadPose(page: Page): Promise<{ position: Vec3; forward: Vec3 }> {
  return page.evaluate(() => {
    const camera = (window as { __HOLOIM_XR_VIEWER__?: { world: { camera: { matrixWorld: { elements: number[] } } } } }).__HOLOIM_XR_VIEWER__!.world.camera;
    const e = camera.matrixWorld.elements;
    return { position: [e[12]!, e[13]!, e[14]!] as Vec3, forward: [-e[8]!, -e[9]!, -e[10]!] as Vec3 };
  });
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

test("VR: Step inside shows the hologram at recorded scale on the floor ahead, plays it with its audio, and exit returns to its card", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await mockFeed(page);
  await page.goto("/");
  await assertViewerShell(page);
  await waitForIwerRuntime(page);
  const vrTrigger = page.locator(".vr-trigger-button");
  await expect(vrTrigger).toHaveCount(1, { timeout: 15_000 });
  await expect(vrTrigger).toHaveText("Step inside");
  await expect(page.locator(".ar-trigger-button")).toHaveAttribute("aria-label", "View in your room");

  const visits: unknown[] = [];
  for (let visit = 1; visit <= 2; visit++) {
    await page.locator(".vr-trigger-button").click();
    await expect(page).toHaveURL(/\/vr\/mock-1$/);
    await enterSession(page, "Step inside", "opaque");

    const placed = await waitForSnapshot(page, (s) => s.placement.stage === "placed" && s.hologram.visible);
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
    if (visit === 1) await captureEvidence(page, testInfo, "vr-life-size");

    await endSession(page);
    await expectTornDown(page);
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
      renderer: second.renderer
    });
  }
  report.vr = { visits };
});

test("AR (IWSDK shell, phone): places on the floor ahead, a tap on the hologram pauses and resumes it, a tap on the floor moves it, and exit returns to the feed", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockFeed(page);
  await emulatePhone(page);
  await page.goto("/ar/mock-1?shell=iwsdk");
  await waitForIwerRuntime(page);
  await enterSession(page, "View in your room", "alpha-blend");

  const placed = await waitForSnapshot(page, (s) => s.placement.stage !== "searching" && s.hologram.visible);
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
  await captureEvidence(page, testInfo, "ar-placed");

  // Tap the hologram's chest: pause, then resume.
  const chest: Vec3 = [position[0], position[1] + placed.hologram.recordedSize[1] * 0.6, position[2]];
  await page.evaluate((target) => (window as unknown as { __phoneTap(t: Vec3): Promise<void> }).__phoneTap(target), chest);
  const paused = await waitForSnapshot(page, (s) => !s.hologram.playing, 3_000);
  const pausedAt = paused.hologram.clipTime;
  await page.waitForTimeout(500);
  expect((await snapshot(page)).hologram.clipTime, "paused clock holds").toBeCloseTo(pausedAt, 5);
  expect((await snapshot(page)).hologram.audio?.playing ?? false, "paused audio stops").toBe(false);
  await page.evaluate((target) => (window as unknown as { __phoneTap(t: Vec3): Promise<void> }).__phoneTap(target), chest);
  await waitForSnapshot(page, (s) => s.hologram.playing, 3_000);

  // Tap the floor beside it: the hologram moves there.
  const floorTarget: Vec3 = [position[0] + 0.8, position[1], position[2] + 0.4];
  await page.evaluate((target) => (window as unknown as { __phoneTap(t: Vec3): Promise<void> }).__phoneTap(target), floorTarget);
  const moved = await waitForSnapshot(page, (s) => s.placement.mode === "tap" && s.placement.sequence > placed.placement.sequence, 3_000);
  const miss = Math.hypot(moved.hologram.worldPosition[0] - floorTarget[0], moved.hologram.worldPosition[2] - floorTarget[2]);
  expect(miss, "moved to the tapped floor point").toBeLessThan(0.05);
  const reanchored = await waitForSnapshot(page, (s) => s.placement.stage === "anchored", 3_000).catch(() => null);
  await captureEvidence(page, testInfo, "ar-tap-moved");

  await endSession(page);
  await expectTornDown(page);
  report.ar = {
    placement: placed.placement,
    anchoredAfterPlacement: Boolean(anchored),
    head,
    forwardDot,
    horizontalDistance,
    surfaceHeightM: position[1],
    pausedAtClipTime: pausedAt,
    tapMove: { target: floorTarget, position: moved.hologram.worldPosition, missM: miss, reanchored: Boolean(reanchored) }
  };
});
