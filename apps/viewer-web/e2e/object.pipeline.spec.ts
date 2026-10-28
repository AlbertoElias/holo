import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Page } from "@playwright/test";

import { launchXrBrowser } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, expect, test } from "./bootstrap";
import { cardCenter, installProbe, readPortal, waitForPortalReady } from "./portal-helpers";

// Explain with an object (PRD-043) in the viewer. Capture's own IWER take
// (lib/object-take.mjs: grab the bracket, move and turn it, put it down) is
// recorded in beforeAll, uploaded through the real API with Quick Look on,
// and played in the feed card. With the animation paused and seeked to keys
// of the export, the object node in the card must sit where the GLB puts it
// (relative to the recording's root), stay at a fixed pose in the avatar's
// right hand while held, and never be cut by the bubble. The USDZ the API
// converts must animate the object prim the same way.

const execFileAsync = promisify(execFile);
const DESKTOP = { width: 1280, height: 720 };
const POSITION_TOLERANCE_M = 0.01;
const ANGLE_TOLERANCE_DEG = 1;
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/object-viewer");
const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";

type Pose = { position: [number, number, number]; quaternion: [number, number, number, number] };
type Expected = { label: string; key: number; time: number; object: Pose; hand: Pose; held: boolean };
type Take = {
  file: string;
  node: number;
  keys: Expected[];
  holdRelation: Pose;
  displacementM: number;
  turnDeg: number;
  grab: { start: number; end: number };
};

type Thrown = {
  file: string;
  node: number;
  /** Poses at key times: before the grab, held, just released, mid-flight, landed. */
  keys: Array<{ label: string; key: number; time: number; object: Pose }>;
  flightKeys: number;
  keyCount: number;
  flightDisplacementM: number;
};

let take: Take | undefined;
let thrown: Thrown | undefined;

test.beforeAll(async () => {
  if (process.env.RUN_E2E_PIPELINE !== "1") return;
  test.setTimeout(300_000);
  // @ts-expect-error capture's .mjs scripts are untyped
  const { runIwerObjectTake } = await import("../../capture/scripts/lib/object-take.mjs");
  // @ts-expect-error capture's .mjs scripts are untyped
  const glbLib = await import("../../capture/scripts/lib/object-glb.mjs");
  const browser = await launchXrBrowser(chromium);
  const consoleErrors: string[] = [];
  try {
    const report = await runIwerObjectTake({ browser, baseUrl: captureUrl, artifactDir: path.join(evidenceDir, "take"), consoleErrors });
    expect(report.failures, "capture take").toEqual([]);
    expect(consoleErrors, "capture runtime errors").toEqual([]);
    take = expectedFrom(glbLib, report.glb, await readFile(report.glb));
    // A thrown take (capture's physics scenarios): the flight and the landing are recorded poses.
    // @ts-expect-error capture's .mjs scripts are untyped
    const { runIwerObjectPhysics } = await import("../../capture/scripts/lib/object-physics.mjs");
    const physics = await runIwerObjectPhysics({ browser, baseUrl: captureUrl, artifactDir: path.join(evidenceDir, "throw"), consoleErrors });
    expect(physics.failures, "capture physics scenarios").toEqual([]);
    thrown = thrownFrom(glbLib, physics.glb, await readFile(physics.glb));
  } finally {
    await browser.close();
  }
});

/** Poses at chosen keys of the export, in the recording root's frame, read without a renderer. */
function expectedFrom(lib: Record<string, (...args: never[]) => unknown>, file: string, buffer: Buffer): Take {
  const loadTake = lib.loadTake as (b: Buffer) => { times: number[]; validation: { ok: true; value: { objects: Array<{ node: number; holds: Array<{ start: number; end: number }> }> } } };
  const findNode = lib.findNode as (t: unknown, name: string) => number;
  const worldAt = lib.worldAt as (t: unknown, node: number, key: number) => { decompose: (p: unknown, q: unknown, s: unknown) => void };
  const rigidPose = lib.rigidPose as (m: unknown) => { position: { toArray: () => number[]; distanceTo: (v: unknown) => number }; quaternion: { toArray: () => number[]; angleTo: (q: unknown) => number } };
  const relativePose = lib.relativePose as (a: unknown, b: unknown) => { position: { toArray: () => number[] }; quaternion: { toArray: () => number[] } };
  const parsed = loadTake(buffer);
  const entry = parsed.validation.value.objects[0]!;
  const hold = entry.holds[0]!;
  const hand = findNode(parsed, "RightHand");
  const keyAt = (time: number) => parsed.times.reduce((best, t, i) => (Math.abs(t - time) < Math.abs(parsed.times[best]! - time) ? i : best), 0);
  const picks: Array<[string, number]> = [
    ["0-before-grab", hold.start / 2],
    ["1-grabbed", hold.start + 0.1],
    ["2-moving", hold.start + (hold.end - hold.start) * 0.5],
    ["3-moved-turned", hold.end - 0.1],
    ["4-put-down", (hold.end + parsed.times.at(-1)!) / 2]
  ];
  const pose = (p: ReturnType<typeof rigidPose>): Pose => ({ position: p.position.toArray() as Pose["position"], quaternion: p.quaternion.toArray() as Pose["quaternion"] });
  const keys = picks.map(([label, time]) => {
    const key = keyAt(time);
    return {
      label,
      key,
      time: parsed.times[key]!,
      object: pose(rigidPose(worldAt(parsed, entry.node, key))),
      hand: pose(rigidPose(worldAt(parsed, hand, key))),
      held: parsed.times[key]! > hold.start && parsed.times[key]! < hold.end
    };
  });
  const grabbed = rigidPose(worldAt(parsed, entry.node, keys[1]!.key));
  const moved = rigidPose(worldAt(parsed, entry.node, keys[3]!.key));
  const relation = relativePose(rigidPose(worldAt(parsed, hand, keys[2]!.key)), rigidPose(worldAt(parsed, entry.node, keys[2]!.key)));
  return {
    file,
    node: entry.node,
    keys,
    holdRelation: { position: relation.position.toArray() as Pose["position"], quaternion: relation.quaternion.toArray() as Pose["quaternion"] },
    displacementM: moved.position.distanceTo(grabbed.position),
    turnDeg: (moved.quaternion.angleTo(grabbed.quaternion) * 180) / Math.PI,
    grab: hold
  };
}

/** Poses of a thrown take at key times of the export, in the recording root's frame. */
function thrownFrom(lib: Record<string, (...args: never[]) => unknown>, file: string, buffer: Buffer): Thrown {
  const loadTake = lib.loadTake as (b: Buffer) => { times: number[]; validation: { ok: true; value: { objects: Array<{ node: number; holds: Array<{ start: number; end: number }> }> } } };
  const worldAt = lib.worldAt as (t: unknown, node: number, key: number) => unknown;
  const rigidPose = lib.rigidPose as (m: unknown) => { position: { toArray: () => number[]; distanceTo: (v: unknown) => number }; quaternion: { toArray: () => number[] } };
  const parsed = loadTake(buffer);
  const entry = parsed.validation.value.objects[0]!;
  const hold = entry.holds[0]!;
  const at = (key: number) => rigidPose(worldAt(parsed, entry.node, key));
  // The last key at which the object still moves is where it lands.
  let landedKey = parsed.times.length - 1;
  while (landedKey > 0 && at(landedKey).position.distanceTo(at(landedKey - 1).position) < 1e-4) landedKey -= 1;
  const releaseKey = parsed.times.findIndex((t) => t >= hold.end);
  const flightKeys = landedKey - releaseKey;
  const keyAt = (time: number) => parsed.times.reduce((best, t, i) => (Math.abs(t - time) < Math.abs(parsed.times[best]! - time) ? i : best), 0);
  const midFlight = parsed.times[Math.round((releaseKey + landedKey) / 2)]!;
  const picks: Array<[string, number]> = [
    ["t0-before-grab", hold.start / 2],
    ["t1-held", (hold.start + hold.end) / 2],
    ["t2-released", hold.end + 0.05],
    ["t3-mid-flight", midFlight],
    ["t4-landed", parsed.times[landedKey]! + 0.1],
    ["t5-end", parsed.times.at(-1)!]
  ];
  const keys = picks.map(([label, time]) => {
    const key = keyAt(time);
    const p = at(key);
    return { label, key, time: parsed.times[key]!, object: { position: p.position.toArray() as Pose["position"], quaternion: p.quaternion.toArray() as Pose["quaternion"] } };
  });
  return { file, node: entry.node, keys, flightKeys, keyCount: parsed.times.length, flightDisplacementM: at(releaseKey).position.distanceTo(at(landedKey).position) };
}

async function upload(page: Page, glb: Buffer): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `Object ${Date.now()}`,
      submittedBy: "object-e2e",
      quickLookEnabled: "true",
      file: { name: "object-take.glb", mimeType: "model/gltf-binary", buffer: glb }
    }
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

type Reading = {
  objects: number;
  object: Pose | null;
  hand: Pose | null;
  objectMeshes: number;
  objectMeshesClipped: number;
  avatarMeshesClipped: number;
  bubbleActive: boolean;
};

/** Seek the paused animation, then read the object and the right hand relative to the recording's root. */
async function readAt(page: Page, modelPath: string, seconds: number): Promise<Reading> {
  return page.evaluate(([target, time]) => {
    type V = { x: number; y: number; z: number };
    type Q = V & { w: number };
    type O = {
      name: string;
      isMesh?: boolean;
      material?: { customProgramCacheKey?: () => string } | Array<{ customProgramCacheKey?: () => string }>;
      matrixWorld: { clone: () => M };
      position: { clone: () => V };
      quaternion: { clone: () => Q };
      scale: { clone: () => V };
      parent: O | null;
      traverse: (fn: (o: O) => void) => void;
      updateWorldMatrix: (parents: boolean, children: boolean) => void;
      getObjectByName: (name: string) => O | undefined;
    };
    type M = { invert: () => M; premultiply: (m: M) => M; decompose: (p: V, q: Q, s: V) => void };
    type Probe = {
      model: O;
      mixer: { update: (dt: number) => void };
      actions: Record<string, { time: number } | null>;
      bubble: { active: boolean };
      objects: Array<{ node: O }>;
    };
    const probes = (window as unknown as { __portalProbes: Record<string, Probe> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
    probe.model.updateWorldMatrix(true, true);
    const rootInverse = probe.model.matrixWorld.clone().invert();
    const poseOf = (object: O | undefined): { position: [number, number, number]; quaternion: [number, number, number, number] } | null => {
      if (!object) return null;
      // decompose needs three's own Vector3 and Quaternion; the page has them only on objects.
      const p = object.position.clone();
      const q = object.quaternion.clone();
      const s = object.scale.clone();
      object.matrixWorld.clone().premultiply(rootInverse).decompose(p, q, s);
      return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
    };
    const clipped = (mesh: O) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      return materials.some((material) => material?.customProgramCacheKey?.().includes("sphere-clip"));
    };
    const node = probe.objects[0]?.node;
    let objectMeshes = 0;
    let objectMeshesClipped = 0;
    node?.traverse((child) => {
      if (!child.isMesh) return;
      objectMeshes += 1;
      if (clipped(child)) objectMeshesClipped += 1;
    });
    let avatarMeshesClipped = 0;
    probe.model.getObjectByName("RecordedAvatar")?.traverse((child) => {
      if (child.isMesh && clipped(child)) avatarMeshesClipped += 1;
    });
    return {
      objects: probe.objects.length,
      object: poseOf(node),
      hand: poseOf(probe.model.getObjectByName("RecordedAvatar")?.getObjectByName("RightHand")),
      objectMeshes,
      objectMeshesClipped,
      avatarMeshesClipped,
      bubbleActive: probe.bubble.active
    };
  }, [modelPath, seconds] as const);
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function angleDeg(a: [number, number, number, number], b: [number, number, number, number]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** `b` in the frame of `a`. */
function relative(a: Pose, b: Pose): Pose {
  const [ax, ay, az, aw] = a.quaternion;
  const inv: [number, number, number, number] = [-ax, -ay, -az, aw];
  const mul = (p: number[], q: number[]): [number, number, number, number] => [
    p[3]! * q[0]! + p[0]! * q[3]! + p[1]! * q[2]! - p[2]! * q[1]!,
    p[3]! * q[1]! - p[0]! * q[2]! + p[1]! * q[3]! + p[2]! * q[0]!,
    p[3]! * q[2]! + p[0]! * q[1]! - p[1]! * q[0]! + p[2]! * q[3]!,
    p[3]! * q[3]! - p[0]! * q[0]! - p[1]! * q[1]! - p[2]! * q[2]!
  ];
  const d = [b.position[0] - a.position[0], b.position[1] - a.position[1], b.position[2] - a.position[2], 0];
  const rotated = mul(mul(inv, d), a.quaternion);
  return { position: [rotated[0], rotated[1], rotated[2]], quaternion: mul(inv, b.quaternion) };
}

async function shot(page: Page, id: string, name: string): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.png`);
  await page.locator(`.feed-card[data-card-id="${id}"]`).screenshot({ path: file });
  return file;
}

/** World transforms of the object prim in the converted USDZ at the given seconds, via pxr. */
const USD_PROBE = `
import json, sys
from pxr import Usd, UsdGeom
stage = Usd.Stage.Open(sys.argv[1])
node = int(sys.argv[2])
times = json.loads(sys.argv[3])
fps = stage.GetTimeCodesPerSecond()
prim = next((p for p in stage.Traverse() if p.GetCustomDataByKey("gltfNodeIndex") == node), None)
out = {"found": prim is not None, "name": prim.GetName() if prim else None, "timeSamples": 0, "poses": []}
if prim is not None:
    xformable = UsdGeom.Xformable(prim)
    out["timeSamples"] = max([len(op.GetTimeSamples()) for op in xformable.GetOrderedXformOps()] or [0])
    for t in times:
        m = xformable.ComputeLocalToWorldTransform(Usd.TimeCode(t * fps))
        tr = m.ExtractTranslation()
        q = m.RemoveScaleShear().ExtractRotationQuat()
        i = q.GetImaginary()
        out["poses"].append({"position": [tr[0], tr[1], tr[2]], "quaternion": [i[0], i[1], i[2], q.GetReal()]})
print(json.dumps(out))
`;

test("real capture export: the object plays in the hand, matches the track, orbits, and survives USDZ", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(240_000);
  const expected = take!;
  expect(expected.displacementM, "the take moved the object").toBeGreaterThan(0.1);
  expect(expected.turnDeg, "the take turned the object").toBeGreaterThan(60);

  const glb = await readFile(expected.file);
  const uploaded = await upload(page, glb);
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "true");

  // Screenshots look from the author's front-right and closer in: Follow
  // looks over their shoulder, where the body hides a held object. Readings
  // are relative to the recording's root, so the view does not change them.
  const view = await cardCenter(page, uploaded.id);
  await page.mouse.move(view.x, view.y);
  await page.mouse.down();
  await page.mouse.move(view.x + 20, view.y, { steps: 2 });
  await page.mouse.move(view.x + 420, view.y + 10, { steps: 10 });
  await page.mouse.up();
  await expect(card).toHaveAttribute("data-portal-mode", "free");
  // The wheel zooms only on the hologram itself; the drag ended off it.
  await page.mouse.move(view.x, view.y);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);

  const report: Record<string, unknown> = { glb: expected.file, hologram: uploaded.id, node: expected.node, grab: expected.grab, keys: [] };
  const viewerRelations: Pose[] = [];
  for (const key of expected.keys) {
    const reading = await readAt(page, uploaded.url, key.time);
    expect(reading.objects, "the extension names one object").toBe(1);
    expect(reading.object, "the object node is in the card").not.toBeNull();
    expect(reading.bubbleActive).toBe(true);
    expect(reading.objectMeshes).toBeGreaterThan(0);
    expect(reading.objectMeshesClipped, "the object is never bubble-clipped").toBe(0);
    expect(reading.avatarMeshesClipped, "the avatar still is").toBeGreaterThan(0);
    const positionError = distance(reading.object!.position, key.object.position);
    const angleError = angleDeg(reading.object!.quaternion, key.object.quaternion);
    expect(positionError, `${key.label}: position against the GLB`).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
    expect(angleError, `${key.label}: rotation against the GLB`).toBeLessThanOrEqual(ANGLE_TOLERANCE_DEG);
    const relation = relative(reading.hand!, reading.object!);
    if (key.held) viewerRelations.push(relation);
    // One more frame so the screenshot shows the state that was read.
    await page.waitForTimeout(300);
    const file = await shot(page, uploaded.id, key.label);
    (report.keys as unknown[]).push({ label: key.label, time: key.time, held: key.held, positionErrorM: positionError, angleErrorDeg: angleError, screenshot: file });
  }

  // Held: one pose in the hand, the GLB's.
  expect(viewerRelations.length, "held keys").toBeGreaterThanOrEqual(3);
  const handErrors = viewerRelations.map((relation) => ({
    positionM: distance(relation.position, expected.holdRelation.position),
    angleDeg: angleDeg(relation.quaternion, expected.holdRelation.quaternion)
  }));
  for (const error of handErrors) {
    expect(error.positionM, "object stays in the hand").toBeLessThanOrEqual(POSITION_TOLERANCE_M);
    expect(error.angleDeg, "object keeps its grip").toBeLessThanOrEqual(ANGLE_TOLERANCE_DEG);
  }
  report.handRelationErrors = handErrors;

  // Paused mid-move, orbit again to see the object from another side: it stays put in the event.
  const mid = expected.keys[2]!;
  const before = await readAt(page, uploaded.url, mid.time);
  const yawBefore = (await readPortal(page, uploaded.url)).yaw;
  const center = await cardCenter(page, uploaded.id);
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 20, center.y - 5, { steps: 2 });
  await page.mouse.move(center.x - 240, center.y - 30, { steps: 6 });
  await page.mouse.up();
  expect((await readPortal(page, uploaded.url)).yaw, "the second drag orbits").not.toBe(yawBefore);
  const after = await readAt(page, uploaded.url, mid.time);
  expect(distance(after.object!.position, before.object!.position), "orbiting is a view change only").toBeLessThan(1e-6);
  await page.waitForTimeout(300);
  report.orbitScreenshot = await shot(page, uploaded.id, "5-orbited-mid-move");

  // Quick Look: the API's converted USDZ animates the object prim like the GLB.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await expect.poll(async () => (await page.request.get(quickLookUrl, { timeout: 30_000 })).status(), { timeout: 120_000, intervals: [2_000] }).toBe(200);
  const usdzPath = path.join(evidenceDir, "object-take.usdz");
  await writeFile(usdzPath, await (await page.request.get(quickLookUrl, { timeout: 120_000 })).body());
  const times = [expected.keys[1]!.time, expected.keys[3]!.time];
  const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-c", USD_PROBE, usdzPath, String(expected.node), JSON.stringify(times)], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const usd = JSON.parse(stdout) as { found: boolean; name: string; timeSamples: number; poses: Pose[] };
  expect(usd.found, "the object prim is in the USDZ").toBe(true);
  expect(usd.timeSamples, "the object prim is animated").toBeGreaterThan(1);
  const usdDisplacement = distance(usd.poses[1]!.position, usd.poses[0]!.position);
  const usdTurn = angleDeg(usd.poses[1]!.quaternion, usd.poses[0]!.quaternion);
  expect(Math.abs(usdDisplacement - expected.displacementM), "USDZ moves the object as far as the GLB").toBeLessThanOrEqual(POSITION_TOLERANCE_M);
  expect(Math.abs(usdTurn - expected.turnDeg), "USDZ turns the object as far as the GLB").toBeLessThanOrEqual(ANGLE_TOLERANCE_DEG);
  report.usdz = { path: usdzPath, prim: usd.name, timeSamples: usd.timeSamples, displacementM: usdDisplacement, glbDisplacementM: expected.displacementM, turnDeg: usdTurn, glbTurnDeg: expected.turnDeg };

  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
});

test("a thrown take: the flight and landing play in the viewer as the GLB has them, and in the USDZ", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(240_000);
  const expected = thrown!;
  expect(expected.flightKeys, "the take recorded a flight").toBeGreaterThanOrEqual(10);
  expect(expected.flightDisplacementM, "the object travelled in flight").toBeGreaterThan(0.3);

  const uploaded = await upload(page, await readFile(expected.file));
  await page.setViewportSize(DESKTOP);
  await installProbe(page);
  await showOnly(page, uploaded.id);
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await waitForPortalReady(page, uploaded.id, uploaded.url);
  await card.getByRole("button", { name: "Pause" }).click();
  await expect(card).toHaveAttribute("data-portal-paused", "true");

  const report: Record<string, unknown> = { glb: expected.file, hologram: uploaded.id, node: expected.node, keyCount: expected.keyCount, flightKeys: expected.flightKeys, keys: [] };
  for (const key of expected.keys) {
    const reading = await readAt(page, uploaded.url, key.time);
    expect(reading.object, `${key.label}: the object node is in the card`).not.toBeNull();
    const positionError = distance(reading.object!.position, key.object.position);
    const angleError = angleDeg(reading.object!.quaternion, key.object.quaternion);
    expect(positionError, `${key.label}: position against the GLB`).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
    expect(angleError, `${key.label}: rotation against the GLB`).toBeLessThanOrEqual(ANGLE_TOLERANCE_DEG);
    (report.keys as unknown[]).push({ label: key.label, time: key.time, positionErrorM: positionError, angleErrorDeg: angleError });
    if (key.label === "t3-mid-flight") {
      await page.waitForTimeout(300);
      report.midFlightScreenshot = await shot(page, uploaded.id, "throw-mid-flight");
    }
  }

  // Quick Look: the converted USDZ animates the object across the flight, to where the GLB lands.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await expect.poll(async () => (await page.request.get(quickLookUrl, { timeout: 30_000 })).status(), { timeout: 120_000, intervals: [2_000] }).toBe(200);
  const usdzPath = path.join(evidenceDir, "object-throw.usdz");
  await writeFile(usdzPath, await (await page.request.get(quickLookUrl, { timeout: 120_000 })).body());
  const flight = expected.keys.filter((key) => key.label === "t2-released" || key.label === "t3-mid-flight" || key.label === "t4-landed");
  const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-c", USD_PROBE, usdzPath, String(expected.node), JSON.stringify(flight.map((key) => key.time))], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const usd = JSON.parse(stdout) as { found: boolean; name: string; timeSamples: number; poses: Pose[] };
  expect(usd.found, "the object prim is in the USDZ").toBe(true);
  expect(usd.timeSamples, "the USDZ samples the object across the flight").toBeGreaterThanOrEqual(expected.flightKeys);
  // Displacements between flight keys match the GLB's (the USDZ frame differs, distances do not).
  for (let i = 1; i < flight.length; i += 1) {
    const glbStep = distance(flight[i]!.object.position, flight[i - 1]!.object.position);
    const usdStep = distance(usd.poses[i]!.position, usd.poses[i - 1]!.position);
    expect(Math.abs(usdStep - glbStep), `USDZ ${flight[i - 1]!.label} to ${flight[i]!.label}`).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
  }
  report.usdz = { path: usdzPath, prim: usd.name, timeSamples: usd.timeSamples, poses: usd.poses };
  await writeFile(path.join(evidenceDir, "throw-report.json"), JSON.stringify(report, null, 2));
});
