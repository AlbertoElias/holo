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

type Box = { min: [number, number, number]; max: [number, number, number] };
type Resized = {
  file: string;
  /** The object wrapper node, and the RecordedObjectSize node under it. */
  node: number;
  sizeNode: number;
  /** Per key: the scale track's value (x), the key time, and the prop's world bounds in the recording's frame. */
  keys: Array<{ key: number; time: number; size: number; bounds: Box }>;
  keyCount: number;
  captureSizeMax: number;
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
let resized: Resized | undefined;
let unresizedHasSizeNode: boolean | undefined;

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
    unresizedHasSizeNode = glbLib.findNode(glbLib.loadTake(await readFile(report.glb)), "RecordedObjectSize") >= 0;
    // A resized take: the other controller stretches the held prop (capture's resizeIwer scenario).
    // @ts-expect-error capture's .mjs scripts are untyped
    const { runIwerResizeTake } = await import("../../capture/scripts/lib/object-resize.mjs");
    const stretch = await runIwerResizeTake({ browser, baseUrl: captureUrl, artifactDir: path.join(evidenceDir, "resize"), consoleErrors });
    expect(stretch.failures, "capture resize take").toEqual([]);
    expect(consoleErrors, "capture runtime errors").toEqual([]);
    resized = resizedFrom(glbLib, stretch.glb, await readFile(stretch.glb), stretch.capture.series.map((c: { size: number }) => c.size));
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

/** The size track and the prop's world bounds (corners of the meshes' local boxes, which the accessors give) at sampled keys. */
function resizedFrom(lib: Record<string, unknown>, file: string, buffer: Buffer, captureSizes: number[]): Resized {
  type Take = { json: { nodes: Array<{ mesh?: number; children?: number[] }>; meshes: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>; accessors: Array<{ min: number[]; max: number[] }> }; channels: Map<number, { scale?: { values: Float32Array } }>; times: number[] };
  const loadTake = lib.loadTake as (b: Buffer) => Take;
  const findNode = lib.findNode as (t: unknown, name: string) => number;
  const objectNodes = lib.objectNodes as (t: unknown) => number[];
  const worldAt = lib.worldAt as (t: unknown, node: number, key: number) => { elements: number[] };
  const parsed = loadTake(buffer);
  const wrappers = objectNodes(parsed);
  const sizeNode = findNode(parsed, "RecordedObjectSize");
  expect(wrappers.length, "one object wrapper in the resized export").toBe(1);
  expect(sizeNode, "the resized export has a RecordedObjectSize node").toBeGreaterThanOrEqual(0);
  const scale = parsed.channels.get(sizeNode)?.scale?.values;
  expect(scale, "the size node has a scale track").toBeDefined();
  const bounds = (key: number): Box => {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const visit = (index: number) => {
      const node = parsed.json.nodes[index]!;
      if (node.mesh !== undefined) {
        const e = worldAt(parsed, index, key).elements;
        for (const primitive of parsed.json.meshes[node.mesh]!.primitives) {
          const accessor = parsed.json.accessors[primitive.attributes.POSITION]!;
          for (const x of [accessor.min[0]!, accessor.max[0]!]) for (const y of [accessor.min[1]!, accessor.max[1]!]) for (const z of [accessor.min[2]!, accessor.max[2]!]) {
            const w = [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
            for (let a = 0; a < 3; a += 1) { min[a] = Math.min(min[a]!, w[a]!); max[a] = Math.max(max[a]!, w[a]!); }
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(wrappers[0]!);
    return { min, max };
  };
  // Sampled across the take, always including the largest size and the first key.
  const count = parsed.times.length;
  const sizes = Array.from({ length: count }, (_, i) => scale![i * 3]!);
  const largest = sizes.indexOf(Math.max(...sizes));
  const picks = [...new Set([0, Math.round(count * 0.2), Math.round(count * 0.35), Math.round(count * 0.5), largest, Math.round(count * 0.8), count - 1].map((k) => Math.min(Math.max(k, 0), count - 1)))].sort((a, b) => a - b);
  return {
    file,
    node: wrappers[0]!,
    sizeNode,
    keys: picks.map((key) => ({ key, time: parsed.times[key]!, size: sizes[key]!, bounds: bounds(key) })),
    keyCount: count,
    captureSizeMax: Math.max(...captureSizes)
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

/** Seek the paused animation, then read the prop's size node and its world bounds relative to the recording's root. */
async function readSizeAt(page: Page, modelPath: string, seconds: number): Promise<{ objects: number; hasSizeNode: boolean; sizeUnderObject: boolean; scale: number[] | null; bounds: Box | null }> {
  return page.evaluate(([target, time]) => {
    type O = {
      name: string;
      isMesh?: boolean;
      geometry?: { boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null; computeBoundingBox: () => void };
      matrixWorld: { elements: number[]; clone: () => M };
      scale: { x: number; y: number; z: number };
      parent: O | null;
      traverse: (fn: (o: O) => void) => void;
      updateWorldMatrix: (parents: boolean, children: boolean) => void;
      getObjectByName: (name: string) => O | undefined;
    };
    type M = { elements: number[]; invert: () => M };
    type Probe = { model: O; mixer: { update: (dt: number) => void }; actions: Record<string, { time: number } | null>; objects: Array<{ node: O }> };
    const probes = (window as unknown as { __portalProbes: Record<string, Probe> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
    probe.model.updateWorldMatrix(true, true);
    const inverse = probe.model.matrixWorld.clone().invert().elements;
    const mul = (a: number[], b: number[]) => {
      const out = new Array<number>(16).fill(0);
      for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
      return out;
    };
    const node = probe.objects[0]?.node;
    const sizeNode = probe.model.getObjectByName("RecordedObjectSize");
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let meshes = 0;
    node?.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      meshes += 1;
      if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
      const box = child.geometry.boundingBox!;
      const e = mul(inverse, child.matrixWorld.elements);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const w = [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
        for (let a = 0; a < 3; a += 1) { min[a] = Math.min(min[a]!, w[a]!); max[a] = Math.max(max[a]!, w[a]!); }
      }
    });
    return {
      objects: probe.objects.length,
      hasSizeNode: Boolean(sizeNode),
      sizeUnderObject: Boolean(sizeNode && node && sizeNode.parent === node),
      scale: sizeNode ? [sizeNode.scale.x, sizeNode.scale.y, sizeNode.scale.z] : null,
      bounds: meshes > 0 ? { min: min as [number, number, number], max: max as [number, number, number] } : null
    };
  }, [modelPath, seconds] as const);
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

/** The size prim's local scale in the converted USDZ at the given seconds, and how many time samples its scale has. */
const USD_SCALE_PROBE = `
import json, sys
from pxr import Usd, UsdGeom
stage = Usd.Stage.Open(sys.argv[1])
node = int(sys.argv[2])
times = json.loads(sys.argv[3])
fps = stage.GetTimeCodesPerSecond()
prim = next((p for p in stage.Traverse() if p.GetCustomDataByKey("gltfNodeIndex") == node), None)
out = {"found": prim is not None, "name": prim.GetName() if prim else None, "scaleSamples": 0, "anySamples": 0, "scales": []}
if prim is not None:
    xformable = UsdGeom.Xformable(prim)
    ops = xformable.GetOrderedXformOps()
    out["scaleSamples"] = max([len(op.GetTimeSamples()) for op in ops if op.GetOpType() == UsdGeom.XformOp.TypeScale] or [0])
    out["anySamples"] = max([len(op.GetTimeSamples()) for op in ops] or [0])
    for t in times:
        m = xformable.GetLocalTransformation(Usd.TimeCode(t * fps))
        m = m[0] if isinstance(m, tuple) else m
        out["scales"].append([sum(m[r][c] ** 2 for c in range(3)) ** 0.5 for r in range(3)])
print(json.dumps(out))
`;

test("the unresized take exports no size node", async () => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  expect(unresizedHasSizeNode, "an unresized prop has no RecordedObjectSize node").toBe(false);
});

test("a resized take: the prop's size animates in the viewer as the GLB has it, and in the USDZ", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(240_000);
  const expected = resized!;
  const sizes = expected.keys.map((key) => key.size);
  expect(expected.keys.length, "sampled keys").toBeGreaterThanOrEqual(5);
  expect(Math.min(...sizes), "the take starts at size 1").toBeCloseTo(1, 3);
  expect(Math.max(...sizes), "the take grows the prop").toBeGreaterThan(1.5);

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

  const report: Record<string, unknown> = { glb: expected.file, hologram: uploaded.id, node: expected.node, sizeNode: expected.sizeNode, keyCount: expected.keyCount, captureSizeMax: expected.captureSizeMax, keys: [] };
  for (const key of expected.keys) {
    const reading = await readSizeAt(page, uploaded.url, key.time);
    expect(reading.objects, "the extension names one object (the size node is not a second one)").toBe(1);
    expect(reading.hasSizeNode, `key ${key.key}: the viewer has the size node`).toBe(true);
    expect(reading.sizeUnderObject, "the size node sits under the object node").toBe(true);
    expect(reading.bounds, "the prop has meshes").not.toBeNull();
    const sizeError = Math.abs(reading.scale![0]! / key.size - 1);
    expect(sizeError, `key ${key.key}: size node scale against the GLB track`).toBeLessThanOrEqual(0.01);
    let worst = 0;
    for (let a = 0; a < 3; a += 1) {
      const extent = key.bounds.max[a]! - key.bounds.min[a]!;
      worst = Math.max(worst, Math.abs(reading.bounds!.min[a]! - key.bounds.min[a]!) / extent, Math.abs(reading.bounds!.max[a]! - key.bounds.max[a]!) / extent);
    }
    expect(worst, `key ${key.key} (size ${key.size.toFixed(2)}): viewer world bounds against the GLB, as a fraction of extent`).toBeLessThanOrEqual(0.02);
    (report.keys as unknown[]).push({ key: key.key, time: key.time, glbSize: key.size, viewerScale: reading.scale![0], sizeError, boundsErrorFractionOfExtent: worst, glbExtentM: key.bounds.max.map((v, a) => v - key.bounds.min[a]!) });
    await page.waitForTimeout(150);
  }
  report.midScreenshot = await shot(page, uploaded.id, "resize-largest");

  // Quick Look: the converted USDZ has the size prim, animated, with the GLB's scale at those times.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await expect.poll(async () => (await page.request.get(quickLookUrl, { timeout: 30_000 })).status(), { timeout: 120_000, intervals: [2_000] }).toBe(200);
  const usdzPath = path.join(evidenceDir, "object-resize.usdz");
  await writeFile(usdzPath, await (await page.request.get(quickLookUrl, { timeout: 120_000 })).body());
  const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-c", USD_SCALE_PROBE, usdzPath, String(expected.sizeNode), JSON.stringify(expected.keys.map((key) => key.time))], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const usd = JSON.parse(stdout) as { found: boolean; name: string; scaleSamples: number; anySamples: number; scales: number[][] };
  expect(usd.found, "the size prim is in the USDZ").toBe(true);
  expect(usd.scaleSamples, "the size prim's scale has time samples").toBeGreaterThan(1);
  const usdErrors = expected.keys.map((key, i) => Math.max(...usd.scales[i]!.map((s) => Math.abs(s / key.size - 1))));
  for (const [i, error] of usdErrors.entries()) expect(error, `USDZ scale at key ${expected.keys[i]!.key} (GLB ${expected.keys[i]!.size.toFixed(3)}, USDZ ${usd.scales[i]!.map((v) => v.toFixed(3)).join("/")})`).toBeLessThanOrEqual(0.01);
  report.usdz = { path: usdzPath, prim: usd.name, scaleSamples: usd.scaleSamples, anySamples: usd.anySamples, scales: usd.scales, maxRelError: Math.max(...usdErrors) };
  await writeFile(path.join(evidenceDir, "resize-report.json"), JSON.stringify(report, null, 2));
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
