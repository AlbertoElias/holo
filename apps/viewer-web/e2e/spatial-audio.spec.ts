import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { assertViewerShell, captureEvidence, expect, reachFor, test } from "./bootstrap";
import { cardCenter, installProbe, readPortal, scrollFeedToTop, waitForPortalReady } from "./portal-helpers";
import { BELL_POSITION, SPATIAL_CLIP_S, spatialAudioGlb, TONE_S } from "./spatial-audio-fixture";

// Positional audio in the feed portal (docs/features/archive/positional-audio.md).
// Nobody listens here: each placed sound is measured. Analysers sit on its
// emitter before the panner and on each ear after it, so a reading is the
// panner's gain per ear (post RMS over pre RMS, the same whatever the clip
// plays at that moment). Each reading is also predicted from where the
// probe says the source is as the ear sees it (the viewer sends each panner
// the source in ear coordinates; the context's listener stays at the
// origin looking down -Z): its azimuth by the Web Audio rules and its
// distance gain by the file's inverse distance model. The feed pans HRTF
// (the user's pick, 2026-11-10), whose ear levels depend on frequency, so
// left and right are checked by side and the distance by the change in
// level, under real pointer orbit and wheel zoom.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(testDir, "../../../output/test-results/spatial-audio-report.json");
const item = {
  id: "spatial-1",
  url: "/uploads/spatial-1.glb",
  usdzUrl: null,
  quickLookEnabled: false,
  createdAt: "2026-11-10T00:00:00.000Z",
  sizeBytes: 2048,
  filenameOriginal: "spatial-1.glb",
  hologramName: "Placed sounds",
  submittedBy: "automation"
};
/** Which ear is louder must be clear: HRTF gives about 4 dB at this fixture's smallest azimuth (about 20 degrees). */
const SIDE_DB = 1;
/**
 * A level change against the distance gain the model predicts. HRTF's overall
 * level also shifts a little with azimuth, which changes as the ear zooms in,
 * so this is that residual plus analysis noise.
 */
const DISTANCE_TOLERANCE_DB = 1.5;
/** How long the analysers listen before a reading: their window (16384 samples) plus margin for ramps. */
const SETTLE_MS = 700;

type Vec3 = [number, number, number];
type Tap = { emitter: number; name: string | null; node: string; leftDb: number; rightDb: number; preRms: number };
type Placement = { emitter: number; name: string | null; node: string; nodeWorld: Vec3; placedWorld: Vec3; sent: Vec3; panner: Vec3; refDistance: number; panningModel: string; placed: boolean };
type Voice = { emitter: number; kind: string; playing: boolean; gain: number; duration: number; loop: boolean; offset: number | null };
type Reading = {
  ear: { position: Vec3; forward: Vec3; up: Vec3 };
  camera: Vec3;
  portal: { mode: string; yaw: number; zoom: number; cameraDistance: number; paused: boolean };
  taps: Tap[];
  placements: Placement[];
  voices: Voice[];
};

const report: Record<string, unknown> = {};

test.afterAll(async () => {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`);
});

// ------------------------------------------------------------- prediction

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** The Web Audio spec's azimuth (degrees, 0 ahead, +90 right) of `source` for an ear. */
function azimuth(ear: Reading["ear"], source: Vec3): number {
  const toSource = sub(source, ear.position);
  if (Math.hypot(...toSource) < 1e-9) return 0;
  const s = norm(toSource);
  const right = norm(cross(ear.forward, ear.up));
  const forward = norm(ear.forward);
  const up = cross(right, forward);
  const projected = norm(sub(s, scale(up, dot(s, up))));
  let a = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, dot(projected, right))));
  if (dot(projected, forward) < 0) a = 360 - a;
  return a >= 0 && a <= 270 ? 90 - a : 450 - a;
}

/** Where a source is for an ear: its distance, its azimuth and the inverse distance model's gain (dB), as the Web Audio spec computes them. */
function predict(ear: Reading["ear"], source: Vec3, refDistance: number): { distance: number; azimuth: number; distanceDb: number } {
  const distance = Math.hypot(...sub(source, ear.position));
  const distanceGain = refDistance / (refDistance + (Math.max(distance, refDistance) - refDistance));
  return { distance, azimuth: Math.max(-180, Math.min(180, azimuth(ear, source))), distanceDb: 20 * Math.log10(distanceGain) };
}

// ------------------------------------------------------------- page probes

async function openFeed(page: Page): Promise<void> {
  const glb = spatialAudioGlb();
  await installProbe(page);
  await page.route("**/api/holograms?*", (route) => route.fulfill({ json: { items: [item], nextCursor: null } }));
  await page.route("**/uploads/**", (route) => route.fulfill({ body: glb, contentType: "model/gltf-binary" }));
  await page.goto("/");
  await assertViewerShell(page);
  await waitForPortalReady(page, item.id, item.url);
  await scrollFeedToTop(page);
}

type SoundProbe = {
  current: {
    playing: boolean;
    spatial: boolean;
    tap(): Array<{ emitter: number; name: string | null; node: string; read(): { preRms: number; leftDb: number; rightDb: number } }>;
    readPlacements(): Placement[];
    readVoices(): Voice[];
    readEar(): { position: Vec3; forward: Vec3; up: Vec3 };
  } | null;
};

async function tapSounds(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate((url) => {
      const probe = (window as unknown as { __portalProbes: Record<string, { sound: SoundProbe }> }).__portalProbes;
      const sound = Object.entries(probe).find(([key]) => key.endsWith(url))?.[1].sound.current;
      return Boolean(sound?.playing && sound.spatial);
    }, item.url), { message: "the card's placed sounds play", timeout: 15_000 })
    .toBe(true);
  await page.evaluate((url) => {
    const hooks = window as unknown as { __portalProbes: Record<string, { sound: SoundProbe }>; __spatialTaps: unknown };
    const sound = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(url))![1].sound.current!;
    hooks.__spatialTaps = sound.tap();
  }, item.url);
}

async function read(page: Page, settleMs = SETTLE_MS): Promise<Reading> {
  await page.waitForTimeout(settleMs);
  const reading = await page.evaluate((url) => {
    type Taps = Array<{ emitter: number; name: string | null; node: string; read(): { preRms: number; leftDb: number; rightDb: number } }>;
    type Probe = {
      sound: SoundProbe;
      camera: { position: { x: number; y: number; z: number } };
      portal: { getState(): { mode: string; yaw: number; zoom: number; paused: boolean }; runtime: { measured: { cameraDistance: number } } };
    };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe>; __spatialTaps: Taps };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(url))![1];
    const sound = probe.sound.current!;
    const state = probe.portal.getState();
    return {
      // The context's listener: where the ear is now, ramps included.
      ear: sound.readEar(),
      camera: [probe.camera.position.x, probe.camera.position.y, probe.camera.position.z],
      portal: { mode: state.mode, yaw: state.yaw, zoom: state.zoom, paused: state.paused, cameraDistance: probe.portal.runtime.measured.cameraDistance },
      taps: hooks.__spatialTaps.map((tap) => ({ emitter: tap.emitter, name: tap.name, node: tap.node, ...tap.read() })),
      placements: sound.readPlacements(),
      voices: sound.readVoices()
    };
  }, item.url);
  return reading as Reading;
}

/** Where a world point is drawn on the page, through the card's camera (view offset included). */
async function screenPoint(page: Page, world: Vec3): Promise<{ x: number; y: number }> {
  return page.evaluate(([url, point]) => {
    type Probe = { camera: { position: { clone(): { set(x: number, y: number, z: number): { project(camera: unknown): { x: number; y: number } } } } }; renderer: { domElement: HTMLCanvasElement } };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe> };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(url as string))![1];
    const [x, y, z] = point as Vec3;
    const ndc = probe.camera.position.clone().set(x, y, z).project(probe.camera);
    const rect = probe.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
  }, [item.url, world] as const);
}

/** A world point in an ear's own coordinates (+X right, +Y up, -Z ahead), worked out here from the ear the probe reports. */
function toEar(ear: Reading["ear"], world: Vec3): Vec3 {
  const forward = norm(ear.forward);
  const right = norm(cross(forward, ear.up));
  const up = cross(right, forward);
  const d = sub(world, ear.position);
  return [dot(d, right), dot(d, up), -dot(d, forward)];
}

/**
 * How far from the motion's time a sound may be: the motion's time and the audio clock are read a frame apart at most,
 * so the bound is the page's own frame length, measured where it is read, and never less than this floor. A frame is
 * 16 ms on a free machine and several hundred on a starved runner (B-051); a real desync (a source restarted from 0, or
 * left behind across a pause) is off by seconds either way.
 */
const VOICE_SYNC_TOLERANCE_S = 0.15;

function syncTolerance(step: { frameS: number }): number {
  return Math.max(VOICE_SYNC_TOLERANCE_S, 1.5 * step.frameS);
}

/** Every source's place in its buffer against the motion's, read at one instant. */
/**
 * Where each voice is against the motion. The motion's time is the last frame's, so each sample is read in an
 * animation frame, after the card's own loop (registered a frame earlier, so called first) has advanced the
 * motion: read between frames, a stalled frame on a loaded machine would count against the sound. A voice's
 * error is its median over a few frames, so one frame's stall or a restart's first frame is not the measure.
 */
async function voicesInStep(page: Page, frames = 5): Promise<{ time: number; frameS: number; voices: Array<{ duration: number; offset: number | null; errorS: number }> }> {
  const samples = await page.evaluate(([url, count]) => new Promise<Array<{ time: number; at: number; voices: Voice[] }>>((resolve) => {
    type Probe = { sound: SoundProbe; actions: Record<string, { time: number } | null> };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe> };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(url as string))![1];
    const read: Array<{ time: number; at: number; voices: Voice[] }> = [];
    const sample = () => {
      read.push({ time: Object.values(probe.actions).find(Boolean)!.time, at: performance.now(), voices: probe.sound.current!.readVoices() });
      if (read.length < (count as number)) requestAnimationFrame(sample);
      else resolve(read);
    };
    requestAnimationFrame(sample);
  }), [item.url, frames] as const);
  const errors = samples.map((sample) => sample.voices.map((voice) => {
    if (voice.offset === null) return Infinity;
    const expected = voice.loop ? sample.time % voice.duration : sample.time;
    const apart = Math.abs(voice.offset - expected) % voice.duration;
    return Math.min(apart, voice.duration - apart);
  }));
  const last = samples.at(-1)!;
  const intervals = samples.slice(1).map((sample, index) => (sample.at - samples[index]!.at) / 1000).sort((a, b) => a - b);
  return {
    time: last.time,
    frameS: intervals[Math.floor(intervals.length / 2)] ?? 0,
    voices: last.voices.map((voice, index) => {
      const sorted = errors.map((frame) => frame[index]!).sort((a, b) => a - b);
      return { duration: voice.duration, offset: voice.offset, errorS: sorted[Math.floor(sorted.length / 2)]! };
    })
  };
}

/**
 * Wait, on the page's own frames, until the motion has wrapped and run on to `settleS` of clip time. Sampling the clip
 * time from the test between `voicesInStep` reads aliased on a starved runner (B-051): a read spans 5 frames, and when
 * that is close to the 8 s clip every read can land just past the wrap and never below where it started. Watching every
 * frame sees the drop however slow the frames are, and the wall-clock timeout only catches a page that stopped.
 */
async function waitForWrap(page: Page, settleS: number): Promise<{ frames: number; wrappedFrom: number; at: number }> {
  return page.evaluate(([url, settle]) => new Promise<{ frames: number; wrappedFrom: number; at: number }>((resolve) => {
    type Probe = { actions: Record<string, { time: number } | null> };
    const hooks = window as unknown as { __portalProbes: Record<string, Probe> };
    const probe = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(url as string))![1];
    const time = () => Object.values(probe.actions).find(Boolean)!.time;
    let last = time();
    let wrappedFrom: number | null = null;
    let frames = 0;
    const step = () => {
      frames += 1;
      const now = time();
      if (wrappedFrom === null && now < last) wrappedFrom = last;
      last = now;
      if (wrappedFrom !== null && now >= (settle as number)) resolve({ frames, wrappedFrom, at: now });
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), [item.url, settleS] as const);
}

/** The context's listener, which the viewer never moves. */
const LISTENER: Reading["ear"] = { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] };

/** One placed sound's measured and predicted gains in a reading. */
function bell(reading: Reading) {
  const tap = reading.taps.find((entry) => entry.node === "Bell")!;
  const placement = reading.placements.find((entry) => entry.node === "Bell")!;
  const predicted = predict(LISTENER, placement.panner, placement.refDistance);
  // The same from the ear in world space: the ear-space panner is the world bell seen from the ear.
  const fromWorld = predict(reading.ear, placement.placedWorld, placement.refDistance);
  return {
    leftDb: tap.leftDb,
    rightDb: tap.rightDb,
    // Both ears' power together, which HRTF keeps near the distance gain wherever the source is.
    levelDb: 10 * Math.log10((10 ** (tap.leftDb / 10) + 10 ** (tap.rightDb / 10)) / 2),
    sideDb: tap.rightDb - tap.leftDb,
    predicted,
    fromWorld
  };
}

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

test.use({ viewport: { width: 900, height: 700 } });
test.describe.configure({ timeout: 90_000 });

test("feed spatial audio: placed sounds pan with drag-orbit, grow louder with wheel zoom, follow their animated node, and every source mutes, pauses and resumes together", async ({ page }, testInfo) => {
  await openFeed(page);
  const card = page.locator(`.feed-card[data-card-id="${item.id}"]`);
  await reachFor(card);
  await card.getByRole("button", { name: "Unmute audio" }).click();
  await expect(card.getByRole("button", { name: "Mute audio" })).toHaveCount(1);
  await tapSounds(page);

  // Follow: the ear looks the camera's way from nearer the middle than the camera.
  const follow = await read(page);
  expect(follow.portal.mode).toBe("follow");
  expect(follow.placements.map((p) => p.node).sort(), "one panner per placed node").toEqual(["Bell", "Orbiter"]);
  expect(follow.placements.every((p) => p.panningModel === "HRTF"), "flat screens pan HRTF too").toBe(true);
  expect(follow.voices, "three sources, all playing unmuted").toHaveLength(3);
  expect(follow.voices.every((voice) => voice.playing && voice.gain === 1)).toBe(true);
  const bellPlaced = follow.placements.find((p) => p.node === "Bell")!;
  for (let axis = 0; axis < 3; axis++) expect(Math.abs(bellPlaced.placedWorld[axis]! - BELL_POSITION[axis]!), "the bell is placed where it stands").toBeLessThan(1e-3);
  const followBell = bell(follow);
  expect(Math.abs(followBell.fromWorld.distance - followBell.predicted.distance), "the panner holds the bell as the ear sees it").toBeLessThan(1e-3);
  expect(Math.abs(followBell.fromWorld.azimuth - followBell.predicted.azimuth), "at the azimuth the ear sees it").toBeLessThan(0.1);
  expect(followBell.predicted.azimuth, "the bell is left of the ear").toBeLessThan(-10);
  expect(followBell.sideDb, `Follow: the bell is louder in the left ear (${followBell.leftDb.toFixed(2)}/${followBell.rightDb.toFixed(2)} dB)`).toBeLessThan(-SIDE_DB);
  const earToCamera = Math.hypot(...sub(follow.camera, follow.ear.position));
  expect(earToCamera, "at Follow the ear stands in front of the camera").toBeGreaterThan(0.5);
  await captureEvidence(page, testInfo, "spatial-follow");

  // Orbit half way round with real drags: the bell crosses to the right ear.
  const center = await cardCenter(page, item.id);
  const startYaw = (await readPortal(page, item.url)).followYaw;
  for (let step = 0; step < 12; step++) {
    const yaw = (await readPortal(page, item.url)).yaw;
    if (step > 0 && Math.abs(wrap(yaw - startYaw)) > 2.7) break;
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x - 160, center.y, { steps: 4 });
    await page.mouse.up();
  }
  const orbited = await read(page);
  expect(orbited.portal.mode).toBe("free");
  expect(Math.abs(wrap(orbited.portal.yaw - startYaw)), "the view went more than half way round").toBeGreaterThan(2.7);
  const orbitedBell = bell(orbited);
  expect(orbitedBell.predicted.azimuth, "seen from behind, the bell is right of the ear").toBeGreaterThan(10);
  expect(orbitedBell.sideDb, `orbited: the bell is louder in the right ear (${orbitedBell.leftDb.toFixed(2)}/${orbitedBell.rightDb.toFixed(2)} dB)`).toBeGreaterThan(SIDE_DB);
  await captureEvidence(page, testInfo, "spatial-orbited");

  // Zoom in all the way with the wheel over the hologram: the ear comes in to the camera, nearer the bell.
  // The wheel zooms only over the hologram's own meshes: wheel over the floor's middle, wherever it is drawn now.
  for (let step = 0; step < 16 && (await readPortal(page, item.url)).zoom > 0.001; step++) {
    const floor = await screenPoint(page, [0, 0, 0.2]);
    await page.mouse.move(floor.x, floor.y);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(50);
  }
  const zoomed = await read(page);
  expect(zoomed.portal.zoom, "zoomed fully in").toBeLessThan(0.01);
  const zoomedBell = bell(zoomed);
  expect(Math.hypot(...sub(zoomed.camera, zoomed.ear.position)), "fully zoomed in, the ear is the camera").toBeLessThan(0.02);
  expect(zoomedBell.predicted.distance, "the ear came nearer the bell").toBeLessThan(orbitedBell.predicted.distance);
  const louder = zoomedBell.levelDb - orbitedBell.levelDb;
  const predictedLouder = zoomedBell.predicted.distanceDb - orbitedBell.predicted.distanceDb;
  expect(louder, "and the bell is louder").toBeGreaterThan(1);
  expect(Math.abs(louder - predictedLouder), `by about what the distance model predicts (measured +${louder.toFixed(2)} dB, predicted +${predictedLouder.toFixed(2)} dB)`).toBeLessThan(DISTANCE_TOLERANCE_DB);
  expect(zoomedBell.sideDb, `zoomed: the bell stays in the right ear (${zoomedBell.leftDb.toFixed(2)}/${zoomedBell.rightDb.toFixed(2)} dB)`).toBeGreaterThan(SIDE_DB);

  // The orbiting sphere carries its sound: what its panner was sent is the node as the ear sees it, frame by
  // frame (the node's world position put into the ear's coordinates by this test, not by the viewer).
  const tracked = await page.evaluate((url) => new Promise<Array<{ nodeWorld: Vec3; sent: Vec3; panner: Vec3; ear: Reading["ear"] }>>((resolve) => {
    const hooks = window as unknown as { __portalProbes: Record<string, { sound: SoundProbe }> };
    const sound = Object.entries(hooks.__portalProbes).find(([key]) => key.endsWith(url))![1].sound.current!;
    const samples: Array<{ nodeWorld: Vec3; sent: Vec3; panner: Vec3; ear: Reading["ear"] }> = [];
    const sample = () => {
      const orbiter = sound.readPlacements().find((p) => p.node === "Orbiter")!;
      samples.push({ nodeWorld: orbiter.nodeWorld, sent: orbiter.sent, panner: orbiter.panner, ear: sound.readEar() });
      if (samples.length < 60) requestAnimationFrame(sample);
      else resolve(samples);
    };
    requestAnimationFrame(sample);
  }), item.url);
  const sentGap = Math.max(...tracked.map((s) => Math.hypot(...sub(s.sent, toEar(s.ear, s.nodeWorld)))));
  // The value the panner is at now trails what it was sent by its ramp (about a frame) plus the audio thread's
  // own schedule, which a stalled frame on a loaded machine stretches: the typical frame is the measure.
  const heardGaps = tracked.map((s) => Math.hypot(...sub(s.panner, s.sent))).sort((a, b) => a - b);
  const heardGap = heardGaps[Math.floor(heardGaps.length / 2)]!;
  const heardGapMax = heardGaps.at(-1)!;
  const steps = tracked.slice(1).map((s, i) => Math.hypot(...sub(s.nodeWorld, tracked[i]!.nodeWorld))).sort((a, b) => a - b);
  const frameStep = steps[Math.floor(steps.length / 2)]!;
  const travelled = Math.hypot(...sub(tracked.at(-1)!.nodeWorld, tracked[0]!.nodeWorld));
  expect(travelled, "the orbiter moved while sampled").toBeGreaterThan(0.1);
  expect(sentGap, "each frame the orbiter's panner is sent the node as the ear sees it").toBeLessThan(0.01);
  expect(heardGap, `and on a typical frame the panner is within about a frame of motion of it (${frameStep.toFixed(3)} m a frame)`).toBeLessThan(2.5 * frameStep + 0.01);

  // Mute silences every source; pause stops every source; resume starts them all again.
  await reachFor(card);
  await card.getByRole("button", { name: "Mute audio" }).click();
  await expect.poll(async () => (await read(page, 0)).voices.every((voice) => voice.gain === 0), { message: "muted: every voice at 0" }).toBe(true);
  await reachFor(card);
  await card.getByRole("button", { name: "Unmute audio" }).click();
  await expect.poll(async () => (await read(page, 0)).voices.every((voice) => voice.gain === 1), { message: "unmuted: every voice at 1" }).toBe(true);
  const afterUnmute = await voicesInStep(page);
  expect(Math.max(...afterUnmute.voices.map((voice) => voice.errorS)), "unmuted, every source is where the motion is").toBeLessThan(syncTolerance(afterUnmute));
  await page.mouse.click(center.x, center.y);
  await expect(card).toHaveAttribute("data-portal-paused", "true");
  await expect.poll(async () => (await read(page, 0)).voices.every((voice) => !voice.playing), { message: "paused: no source plays" }).toBe(true);
  await page.mouse.click(center.x, center.y);
  await expect(card).toHaveAttribute("data-portal-paused", "false");
  await expect.poll(async () => (await read(page, 0)).voices.every((voice) => voice.playing), { message: "resumed: every source plays" }).toBe(true);
  const afterResume = await voicesInStep(page);
  expect(Math.max(...afterResume.voices.map((voice) => voice.errorS)), "resumed, every source starts where the motion is").toBeLessThan(syncTolerance(afterResume));
  expect(afterResume.voices.map((voice) => Math.round(voice.duration)).sort(), "sources of different lengths").toEqual([SPATIAL_CLIP_S, SPATIAL_CLIP_S, TONE_S].sort());

  // Across a wrap of the motion: the 5 s tone, which has looped on its own by then, restarts with the motion. The wrap
  // is watched on the page's frames, then the sources get 0.5 s of clip time to restart before they are read.
  test.setTimeout(test.info().timeout + 60_000);
  const motionWrap = await waitForWrap(page, 0.5);
  const afterWrap = await voicesInStep(page);
  // Read within the loop that follows the wrap. Any time in it tells: a tone left running on its own would be
  // SPATIAL_CLIP_S mod TONE_S (3 s) off the motion at every point of that loop.
  expect(motionWrap.wrappedFrom, "the motion ran through its second half before it wrapped").toBeGreaterThan(SPATIAL_CLIP_S / 2);
  expect(afterWrap.time, "read in the loop after the wrap, not one later").toBeGreaterThanOrEqual(motionWrap.at);
  expect(Math.max(...afterWrap.voices.map((voice) => voice.errorS)), "after the motion wraps, every source is where the motion is").toBeLessThan(syncTolerance(afterWrap));

  report.feed = {
    follow: { bell: followBell, ear: follow.ear, camera: follow.camera, portal: follow.portal, earToCameraM: earToCamera },
    orbited: { bell: orbitedBell, ear: orbited.ear, camera: orbited.camera, portal: orbited.portal },
    zoomed: { bell: zoomedBell, ear: zoomed.ear, camera: zoomed.camera, portal: zoomed.portal, louderDb: louder, predictedLouderDb: predictedLouder },
    orbiter: { samples: tracked.length, travelledM: travelled, sentGapM: sentGap, heardGapMedianM: heardGap, heardGapMaxM: heardGapMax, frameStepM: frameStep },
    sync: { afterUnmute, afterResume, wrap: motionWrap, afterWrap },
    voices: follow.voices
  };
});
