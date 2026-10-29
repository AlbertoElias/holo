import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type Page } from "@playwright/test";

import { launchXrBrowser } from "@holoim/tooling-testing/xr-env";

import { assertViewerShell, expect, test } from "./bootstrap";
import { cardCenter, installProbe, waitForPortalReady } from "./portal-helpers";

// Summon and place while speaking (PRD-045) in the viewer. Capture's own
// IWER take (lib/summon-take.mjs: hold Y, summon the bracket and the image
// card from the tray into the right hand, place each) is recorded in
// beforeAll, uploaded through the real API with Quick Look on, and played in
// the feed card. Paused and seeked: before its summon each object is hidden
// (zero world scale), at its summon it is in the avatar's right hand, and
// afterwards it is where it was placed, each as the GLB has it. The USDZ the
// API converts hides each summoned prim before its summon with visibility
// and a near-zero scale, and never writes a zero scale.

const execFileAsync = promisify(execFile);
const DESKTOP = { width: 1280, height: 720 };
const POSITION_TOLERANCE_M = 0.01;
const ANGLE_TOLERANCE_DEG = 1;
const evidenceDir = path.resolve(import.meta.dirname, "../../../output/summon-viewer");
const captureUrl = process.env.E2E_CAPTURE_URL ?? "https://127.0.0.1:5175/";

type Pose = { position: [number, number, number]; quaternion: [number, number, number, number] };
type Pick = { label: string; key: number; time: number; objects: Array<{ pose: Pose; present: boolean }> };
type Take = { file: string; nodes: number[]; indices: number[]; total: number; starts: number[]; picks: Pick[] };

let take: Take | undefined;

test.beforeAll(async () => {
  if (process.env.RUN_E2E_PIPELINE !== "1") return;
  test.setTimeout(300_000);
  // @ts-expect-error capture's .mjs scripts are untyped
  const { runIwerSummonTake } = await import("../../capture/scripts/lib/summon-take.mjs");
  // @ts-expect-error capture's .mjs scripts are untyped
  const glbLib = await import("../../capture/scripts/lib/object-glb.mjs");
  const browser = await launchXrBrowser(chromium);
  const consoleErrors: string[] = [];
  try {
    const report = await runIwerSummonTake({ browser, baseUrl: captureUrl, artifactDir: path.join(evidenceDir, "take"), consoleErrors });
    expect(report.failures, "capture take").toEqual([]);
    expect(consoleErrors, "capture runtime errors").toEqual([]);
    take = expectedFrom(glbLib, report.glb, await readFile(report.glb));
  } finally {
    await browser.close();
  }
});

/** Each object's pose at chosen keys, in the recording root's frame, read without a renderer. */
function expectedFrom(lib: Record<string, (...args: never[]) => unknown>, file: string, buffer: Buffer): Take {
  type Parsed = { times: number[]; validation: { ok: true; value: { objects: Array<{ node: number; origin: string; presence: Array<{ start: number; end: number }> }> } } };
  const loadTake = lib.loadTake as (b: Buffer) => Parsed;
  const worldAt = lib.worldAt as (t: unknown, node: number, key: number) => unknown;
  const rigidPose = lib.rigidPose as (m: unknown) => { position: { toArray: () => number[] }; quaternion: { toArray: () => number[] } };
  const parsed = loadTake(buffer);
  // The take's mid-take summons; the object summoned before it is carried in
  // as `prepared` (the 60 s carry test below covers those).
  const all = parsed.validation.value.objects;
  const objects = all.filter((entry) => entry.origin === "summoned");
  const keyAt = (time: number) => parsed.times.reduce((best, t, i) => (Math.abs(t - time) < Math.abs(parsed.times[best]! - time) ? i : best), 0);
  const starts = objects.map((entry) => entry.presence[0]!.start);
  const end = parsed.times.at(-1)!;
  const picks: Array<[string, number]> = [
    ["0-before-summons", starts[0]! / 2],
    ["1-first-summoned", starts[0]! + 3 / 60],
    ["2-second-summoned", starts[1]! + 3 / 60],
    ["3-both-placed", end - 0.05]
  ];
  return {
    file,
    nodes: objects.map((entry) => entry.node),
    // Where each sits among all the take's objects, as the viewer lists them.
    indices: objects.map((entry) => all.indexOf(entry)),
    total: all.length,
    starts,
    picks: picks.map(([label, time]) => {
      const key = keyAt(time);
      return {
        label,
        key,
        time: parsed.times[key]!,
        objects: objects.map((entry, k) => {
          const pose = rigidPose(worldAt(parsed, entry.node, key));
          return { pose: { position: pose.position.toArray() as Pose["position"], quaternion: pose.quaternion.toArray() as Pose["quaternion"] }, present: parsed.times[key]! >= starts[k]! };
        })
      };
    })
  };
}

async function upload(page: Page, glb: Buffer): Promise<{ id: string; url: string }> {
  const response = await page.request.post("/api/holograms", {
    multipart: {
      hologramName: `Summon ${Date.now()}`,
      submittedBy: "summon-e2e",
      quickLookEnabled: "true",
      file: { name: "summon-take.glb", mimeType: "model/gltf-binary", buffer: glb }
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

type Reading = { objects: number; poses: Array<{ pose: Pose; scale: number } | null>; hips: [number, number, number] | null };

/** Seek the paused animation, then read each object (pose and world scale) relative to the recording's root. */
async function readAt(page: Page, modelPath: string, seconds: number): Promise<Reading> {
  return page.evaluate(([target, time]) => {
    type V = { x: number; y: number; z: number };
    type Q = V & { w: number };
    type M = { invert: () => M; premultiply: (m: M) => M; decompose: (p: V, q: Q, s: V) => void };
    type O = {
      matrixWorld: { clone: () => M };
      position: { clone: () => V };
      quaternion: { clone: () => Q };
      scale: { clone: () => V };
      updateWorldMatrix: (parents: boolean, children: boolean) => void;
      getObjectByName: (name: string) => O | undefined;
    };
    type Probe = { model: O; mixer: { update: (dt: number) => void }; actions: Record<string, { time: number } | null>; objects: Array<{ node: O }> };
    const probes = (window as unknown as { __portalProbes: Record<string, Probe> }).__portalProbes;
    const probe = Object.entries(probes).find(([url]) => url.endsWith(target as string))![1];
    for (const action of Object.values(probe.actions)) if (action) action.time = time as number;
    probe.mixer.update(0);
    probe.model.updateWorldMatrix(true, true);
    const rootInverse = probe.model.matrixWorld.clone().invert();
    const read = (object: O | undefined) => {
      if (!object) return null;
      const p = object.position.clone();
      const q = object.quaternion.clone();
      const s = object.scale.clone();
      object.matrixWorld.clone().premultiply(rootInverse).decompose(p, q, s);
      return { pose: { position: [p.x, p.y, p.z] as [number, number, number], quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number] }, scale: Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) };
    };
    const hips = read(probe.model.getObjectByName("RecordedAvatar")?.getObjectByName("Hips"));
    return { objects: probe.objects.length, poses: probe.objects.map((entry) => read(entry.node)), hips: hips?.pose.position ?? null };
  }, [modelPath, seconds] as const);
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function angleDeg(a: [number, number, number, number], b: [number, number, number, number]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

async function shot(page: Page, id: string, name: string): Promise<string> {
  await mkdir(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.png`);
  await page.locator(`.feed-card[data-card-id="${id}"]`).screenshot({ path: file });
  return file;
}

/** Each summoned prim's visibility and world scale at the given seconds, via pxr. */
const USD_PROBE = `
import json, sys
from pxr import Usd, UsdGeom
stage = Usd.Stage.Open(sys.argv[1])
nodes = json.loads(sys.argv[2])
times = json.loads(sys.argv[3])
fps = stage.GetTimeCodesPerSecond()
out = []
for node in nodes:
    prim = next((p for p in stage.Traverse() if p.GetCustomDataByKey("gltfNodeIndex") == node), None)
    entry = {"node": node, "found": prim is not None, "visibilitySamples": 0, "minScale": None, "samples": []}
    if prim is not None:
        imageable = UsdGeom.Imageable(prim)
        entry["visibilitySamples"] = len(imageable.GetVisibilityAttr().GetTimeSamples())
        entry["defaultVisibility"] = imageable.GetVisibilityAttr().Get()
        xformable = UsdGeom.Xformable(prim)
        scale_op = next((op for op in xformable.GetOrderedXformOps() if op.GetOpType() == UsdGeom.XformOp.TypeScale), None)
        if scale_op is not None:
            entry["minScale"] = min(min(abs(v) for v in scale_op.Get(t)) for t in scale_op.GetTimeSamples()) if scale_op.GetTimeSamples() else None
        for t in times:
            code = Usd.TimeCode(t * fps)
            m = xformable.ComputeLocalToWorldTransform(code)
            s = max(abs(m.GetRow3(i).GetLength()) for i in range(3))
            entry["samples"].append({"time": t, "visibility": imageable.ComputeVisibility(code), "scale": s})
    out.append(entry)
print(json.dumps(out))
`;

test("real capture export: summoned objects appear in the hand at their summon, stay where placed, and survive USDZ", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(240_000);
  const expected = take!;
  expect(expected.nodes.length, "two summoned objects").toBe(2);

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
  const collapse = page.getByRole("button", { name: "Collapse upload panel" });
  if (await collapse.isVisible()) await collapse.click();

  // Look from the author's front-right and closer in (Follow looks over the shoulder).
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

  const report: Record<string, unknown> = { glb: expected.file, hologram: uploaded.id, nodes: expected.nodes, summonStarts: expected.starts, picks: [] };
  for (const pick of expected.picks) {
    const reading = await readAt(page, uploaded.url, pick.time);
    expect(reading.objects, "the extension names every object").toBe(expected.total);
    const errors = pick.objects.map((object, k) => {
      const read = reading.poses[expected.indices[k]!];
      expect(read, `${pick.label}: object ${k} is in the card`).not.toBeNull();
      if (!object.present) {
        expect(read!.scale, `${pick.label}: object ${k} is hidden before its summon`).toBeLessThan(1e-6);
        return { present: false, scale: read!.scale };
      }
      expect(read!.scale, `${pick.label}: object ${k} is shown`).toBeCloseTo(1, 4);
      const positionM = distance(read!.pose.position, object.pose.position);
      const angle = angleDeg(read!.pose.quaternion, object.pose.quaternion);
      expect(positionM, `${pick.label}: object ${k} position against the GLB`).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
      expect(angle, `${pick.label}: object ${k} rotation against the GLB`).toBeLessThanOrEqual(ANGLE_TOLERANCE_DEG);
      return { present: true, positionErrorM: positionM, angleErrorDeg: angle };
    });
    await page.waitForTimeout(300);
    const file = await shot(page, uploaded.id, pick.label);
    (report.picks as unknown[]).push({ label: pick.label, time: pick.time, objects: errors, hips: reading.hips, screenshot: file });
  }

  // Quick Look: hidden before each summon by visibility and a near-zero scale, never a zero scale.
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await expect.poll(async () => (await page.request.get(quickLookUrl, { timeout: 30_000 })).status(), { timeout: 120_000, intervals: [2_000] }).toBe(200);
  const usdzPath = path.join(evidenceDir, "summon-take.usdz");
  await writeFile(usdzPath, await (await page.request.get(quickLookUrl, { timeout: 120_000 })).body());
  const times = expected.picks.map((pick) => pick.time);
  const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-c", USD_PROBE, usdzPath, JSON.stringify(expected.nodes), JSON.stringify(times)], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const usd = JSON.parse(stdout) as Array<{ node: number; found: boolean; visibilitySamples: number; defaultVisibility: string; minScale: number | null; samples: Array<{ time: number; visibility: string; scale: number }> }>;
  usd.forEach((prim, k) => {
    expect(prim.found, `summoned prim ${k} is in the USDZ`).toBe(true);
    expect(prim.visibilitySamples, `summoned prim ${k} has visibility samples`).toBeGreaterThan(1);
    expect(prim.defaultVisibility, `summoned prim ${k} is visible by default (a still shows it placed)`).toBe("inherited");
    expect(prim.minScale ?? 1, `summoned prim ${k} never has a zero scale`).toBeGreaterThan(0);
    prim.samples.forEach((sample, i) => {
      const present = expected.picks[i]!.objects[k]!.present;
      expect(sample.visibility, `USDZ prim ${k} at ${expected.picks[i]!.label}`).toBe(present ? "inherited" : "invisible");
      if (!present) expect(sample.scale, `USDZ prim ${k} is tiny while hidden`).toBeLessThan(1e-3);
    });
  });
  report.usdz = { path: usdzPath, prims: usd };
  await writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
});

// The tray on every device (docs/features/tray-everywhere.md): nothing clears
// between takes, so a take can carry many objects in from before it began.
// Five placed before a 60 s take convert to USDZ, each prim visible from the
// first frame to the last.
test("a 60 s take carrying five objects from before it converts to USDZ, each present throughout", async ({ page }) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs a live API.");
  test.setTimeout(420_000);
  // @ts-expect-error capture's .mjs scripts are untyped
  const { runLongCarryTake } = await import("../../capture/scripts/lib/tray-anytime-take.mjs");
  const browser = await launchXrBrowser(chromium);
  const consoleErrors: string[] = [];
  let report: { failures: string[]; glb: string; export: { durationSec: number; objects: Array<{ name: string }> } };
  try {
    report = await runLongCarryTake({ browser, baseUrl: captureUrl, artifactDir: path.join(evidenceDir, "long-carry"), consoleErrors });
  } finally {
    await browser.close();
  }
  expect(report.failures, "capture take").toEqual([]);
  expect(consoleErrors, "capture runtime errors").toEqual([]);
  // @ts-expect-error capture's .mjs scripts are untyped
  const glbLib = await import("../../capture/scripts/lib/object-glb.mjs");
  const nodes = (glbLib.loadTake(await readFile(report.glb)) as { validation: { value: { objects: Array<{ node: number }> } } }).validation.value.objects.map((entry) => entry.node);
  expect(nodes.length, "five carried objects").toBe(5);

  const uploaded = await upload(page, await readFile(report.glb));
  const quickLookUrl = `/api/holograms/${uploaded.id}/usdz`;
  await expect.poll(async () => (await page.request.get(quickLookUrl, { timeout: 30_000 })).status(), { timeout: 240_000, intervals: [2_000] }).toBe(200);
  await mkdir(evidenceDir, { recursive: true });
  const usdzPath = path.join(evidenceDir, "long-carry.usdz");
  await writeFile(usdzPath, await (await page.request.get(quickLookUrl, { timeout: 120_000 })).body());
  const times = [0, report.export.durationSec / 2, report.export.durationSec];
  const { stdout } = await execFileAsync(process.env.USDZ_PYTHON ?? "python3", ["-c", USD_PROBE, usdzPath, JSON.stringify(nodes), JSON.stringify(times)], { timeout: 60_000, maxBuffer: 1024 * 1024 });
  const usd = JSON.parse(stdout) as Array<{ found: boolean; minScale: number | null; samples: Array<{ time: number; visibility: string; scale: number }> }>;
  usd.forEach((prim, k) => {
    expect(prim.found, `carried prim ${k} is in the USDZ`).toBe(true);
    expect(prim.minScale ?? 1, `carried prim ${k} never has a zero scale`).toBeGreaterThan(0);
    for (const sample of prim.samples) {
      expect(sample.visibility, `carried prim ${k} at ${sample.time} s`).toBe("inherited");
      expect(sample.scale, `carried prim ${k} at full size at ${sample.time} s`).toBeGreaterThan(0.5);
    }
  });
  await writeFile(path.join(evidenceDir, "long-carry-report.json"), JSON.stringify({ glb: report.glb, export: report.export, usdz: { path: usdzPath, prims: usd } }, null, 2));
});
