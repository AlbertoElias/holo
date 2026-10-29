import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";
import type * as Three from "three";

import { assertViewerShell, expect, test } from "./bootstrap";
import { pauseTake, readRimState, seekTake, type RimState } from "./floor-proof";
import { RECORDED_SECONDS, recordWalkTake } from "./pipeline-takes";

// Capture drops the set triangles no viewer draws (docs/features/export-trim-hidden.md).
// One walk recording is exported twice, as capture exports it and with the
// trim off; both are uploaded and drawn in the feed, and every view of the
// trimmed take must match the untrimmed one's.

type CardProbe = {
  url: string;
  renderer: Three.WebGLRenderer;
  scene: Three.Scene;
  model: Three.Object3D;
  cloche: { shape: { current: { base: Three.Vector3Like; radii: Three.Vector3Like } | null }; fitted: { current: Three.Vector3 | null } };
  rim: { heights: Float32Array | null };
};

/** A view's verdict: pixels that differ by more than `CHANNEL_TOLERANCE` in any channel, of those either take draws. */
type ViewDiff = { label: string; differing: number; drawn: number; share: number };

const CHANNEL_TOLERANCE = 8;
const MAX_DIFFERING_SHARE = 0.0005;
const VIEW_SIZE = 384;
const PITCHES = [-8, 12, 30, 55, 78];
const DISTANCES = [3.2, 1.6];

type GlbJson = {
  nodes?: Array<{ name?: string; mesh?: number; children?: number[] }>;
  meshes?: Array<{ name?: string; primitives: Array<{ indices?: number; attributes: Record<string, number> }> }>;
  accessors?: Array<{ count: number }>;
};

function readJson(bytes: Buffer): GlbJson {
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString("utf8")) as GlbJson;
}

/** Triangles and vertices per mesh under `RecordedSceneBubble`. */
function setGeometry(bytes: Buffer): { triangles: number; vertices: number; meshes: Record<string, number> } {
  const gltf = readJson(bytes);
  const nodes = gltf.nodes ?? [];
  const bubble = nodes.find((node) => node.name === "RecordedSceneBubble");
  const meshes: Record<string, number> = {};
  let triangles = 0;
  let vertices = 0;
  const visit = (index: number) => {
    const node = nodes[index]!;
    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes![node.mesh]!.primitives) {
        const vertexCount = gltf.accessors![primitive.attributes.POSITION!]!.count;
        const count = (primitive.indices !== undefined ? gltf.accessors![primitive.indices]!.count : vertexCount) / 3;
        meshes[node.name ?? `mesh ${node.mesh}`] = (meshes[node.name ?? `mesh ${node.mesh}`] ?? 0) + count;
        triangles += count;
        vertices += vertexCount;
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of bubble?.children ?? []) visit(child);
  return { triangles, vertices, meshes };
}

async function uploadTake(page: Page, path: string, name: string): Promise<{ id: string; url: string }> {
  await page.getByRole("button", { name: "Upload a hologram" }).click();
  await page.getByLabel("Hologram name").fill(name);
  await page.getByLabel("Submitted by").fill("pipeline-e2e");
  await page.locator("#glb-upload").setInputFiles(path);
  const uploadResponse = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/holograms"
  ));
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const uploaded = (await (await uploadResponse).json()) as { id: string; url: string };
  const card = page.locator(`.feed-card[data-card-id="${uploaded.id}"]`);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await expect(card).toHaveAttribute("data-model-bubble", "active");
  return uploaded;
}

/** Points the floor-proof helpers (they read `__feedProbe`) at the card drawing `url`. */
async function selectCard(page: Page, card: { id: string; url: string }): Promise<void> {
  const { url } = card;
  // Only a card on screen draws frames, and seeking waits on them.
  await page.locator(`.feed-card[data-card-id="${card.id}"]`).scrollIntoViewIfNeeded();
  const file = url.split("/").pop()!;
  await page.waitForFunction((file) => ((window as unknown as { __cardProbes: CardProbe[] }).__cardProbes ?? []).some((probe) => probe.url.endsWith(file)), file);
  await page.evaluate((file) => {
    const hooks = window as unknown as { __cardProbes: CardProbe[]; __feedProbe: CardProbe };
    hooks.__feedProbe = hooks.__cardProbes.filter((probe) => probe.url.endsWith(file)).at(-1)!;
  }, file);
}

/** The dome as fitted and the rim now, on the selected card. */
async function readDome(page: Page): Promise<{ base: number[]; radii: number[]; heights: number[] }> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __feedProbe: CardProbe }).__feedProbe;
    const shape = probe.cloche.shape.current!;
    return { base: [shape.base.x, shape.base.y, shape.base.z], radii: [shape.radii.x, shape.radii.y, shape.radii.z], heights: probe.rim.heights ? Array.from(probe.rim.heights) : [] };
  });
}

/**
 * Draws the selected card's take (the avatar, the set and its objects, as the
 * card's clip draws them; never the glass) from every view around `centre`,
 * and keeps the pixels in the page under `key`.
 */
async function drawViews(page: Page, key: string, centre: number[], wider: number): Promise<void> {
  await page.evaluate(async ({ key, centre, wider, size, pitches, distances }) => {
    const three = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
    const { WebGLRenderTarget, PerspectiveCamera, Vector3, Color } = three;
    const probe = (window as unknown as { __feedProbe: CardProbe }).__feedProbe;
    const { renderer, scene, model } = probe;
    const within = (node: Three.Object3D) => {
      for (let at: Three.Object3D | null = node; at; at = at.parent) if (at === model) return true;
      return false;
    };
    const visibility = new Map<Three.Object3D, boolean>();
    scene.traverse((node) => visibility.set(node, node.visible));
    const previousTarget = renderer.getRenderTarget();
    const previousBackground = scene.background;
    const previousClear = renderer.getClearColor(new Color());
    const previousAlpha = renderer.getClearAlpha();
    const target = new WebGLRenderTarget(size, size);
    const views: Uint8Array[] = [];
    const at = new Vector3(centre[0], centre[1], centre[2]);
    try {
      scene.background = null;
      scene.traverse((node) => {
        if ((node as Three.Mesh).isMesh || (node as Three.Points).isPoints || (node as Three.Line).isLine) node.visible = within(node) && visibility.get(node) === true;
      });
      for (const distance of distances) {
        for (const pitch of pitches) {
          for (let yaw = 0; yaw < 360; yaw += 45) {
            const camera = new PerspectiveCamera(40, 1, wider * 0.05, wider * 12);
            const p = (pitch * Math.PI) / 180;
            const y = (yaw * Math.PI) / 180;
            camera.position.copy(at).add(new Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)).multiplyScalar(wider * distance));
            camera.lookAt(at);
            camera.updateMatrixWorld();
            renderer.setRenderTarget(target);
            renderer.setClearColor(0, 0);
            renderer.clear();
            renderer.render(scene, camera);
            const pixels = new Uint8Array(size * size * 4);
            renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
            views.push(pixels);
          }
        }
      }
    } finally {
      scene.traverse((node) => {
        const visible = visibility.get(node);
        if (visible !== undefined) node.visible = visible;
      });
      scene.background = previousBackground;
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(previousClear, previousAlpha);
      target.dispose();
    }
    const store = window as unknown as { __trimViews?: Record<string, Uint8Array[]> };
    store.__trimViews ??= {};
    store.__trimViews[key] = views;
  }, { key, centre, wider, size: VIEW_SIZE, pitches: PITCHES, distances: DISTANCES });
}

/** Compares two sets of views kept by `drawViews`; the worst view's pair and difference come back as PNG data URLs. */
async function compareViews(page: Page, left: string, right: string, label: string): Promise<{ diffs: ViewDiff[]; worst: { label: string; images: string[] } | null }> {
  return page.evaluate(({ left, right, label, size, tolerance, pitches, distances }) => {
    const store = (window as unknown as { __trimViews: Record<string, Uint8Array[]> }).__trimViews;
    const a = store[left]!;
    const b = store[right]!;
    const labels: string[] = [];
    for (const distance of distances) for (const pitch of pitches) for (let yaw = 0; yaw < 360; yaw += 45) labels.push(`${label} d${distance} p${pitch} y${yaw}`);
    const diffs = a.map((pixels, view) => {
      const other = b[view]!;
      let differing = 0;
      let drawn = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3]! > 0 || other[i + 3]! > 0) drawn += 1;
        for (let k = 0; k < 4; k += 1) {
          if (Math.abs(pixels[i + k]! - other[i + k]!) > tolerance) {
            differing += 1;
            break;
          }
        }
      }
      return { label: labels[view]!, differing, drawn, share: drawn > 0 ? differing / drawn : 0 };
    });
    let worstView = -1;
    diffs.forEach((diff, view) => {
      if (diff.differing > 0 && (worstView < 0 || diff.differing > diffs[worstView]!.differing)) worstView = view;
    });
    if (worstView < 0) return { diffs, worst: null };
    const toPng = (pixels: Uint8Array, mark: Uint8Array | null) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d")!;
      const image = context.createImageData(size, size);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          // Read back bottom-up; drawn top-down.
          const from = ((size - 1 - y) * size + x) * 4;
          const to = (y * size + x) * 4;
          for (let k = 0; k < 4; k += 1) image.data[to + k] = pixels[from + k]!;
          if (mark) {
            let changed = false;
            for (let k = 0; k < 4; k += 1) changed ||= Math.abs(pixels[from + k]! - mark[from + k]!) > tolerance;
            image.data[to] = changed ? 255 : image.data[to]! / 3;
            image.data[to + 1] = changed ? 0 : image.data[to + 1]! / 3;
            image.data[to + 2] = changed ? 0 : image.data[to + 2]! / 3;
            image.data[to + 3] = 255;
          }
        }
      }
      context.putImageData(image, 0, 0);
      return canvas.toDataURL("image/png");
    };
    return { diffs, worst: { label: diffs[worstView]!.label, images: [toPng(a[worstView]!, null), toPng(b[worstView]!, null), toPng(a[worstView]!, b[worstView]!)] } };
  }, { left, right, label, size: VIEW_SIZE, tolerance: CHANNEL_TOLERANCE, pitches: PITCHES, distances: DISTANCES });
}

test("capture drops set triangles no viewer draws, and the feed draws the take the same", async ({ page, browser }, testInfo) => {
  test.skip(process.env.RUN_E2E_PIPELINE !== "1", "Needs the capture dev server and a live API.");
  test.setTimeout(480_000);
  await page.addInitScript(() => {
    const hooks = window as unknown as { __cardProbes?: unknown[]; __HOLOIM_FEED_TEST_OBSERVER__?: (probe: unknown) => void };
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => {
      (hooks.__cardProbes ??= []).push(probe);
    };
  });

  const take = await recordWalkTake(browser, testInfo);
  const { trimmedPath, untrimmedPath, trimmed, untrimmed } = take.exports;
  const trimmedBytes = await readFile(trimmedPath);
  const untrimmedBytes = await readFile(untrimmedPath);
  const trimmedSet = setGeometry(trimmedBytes);
  const untrimmedSet = setGeometry(untrimmedBytes);
  const artifactDir = resolve("../../output/export-trim");
  await mkdir(artifactDir, { recursive: true });

  const stamp = `${testInfo.testId.slice(0, 8)}-${Date.now()}`;
  await page.goto("/");
  await assertViewerShell(page);
  const before = await uploadTake(page, untrimmedPath, `Untrimmed ${stamp}`);
  const after = await uploadTake(page, trimmedPath, `Trimmed ${stamp}`);

  const cards = [["untrimmed", before], ["trimmed", after]] as const;
  const domes: Record<string, { state: RimState; times: Array<{ seconds: number; base: number[]; radii: number[]; heights: number[] }> }> = {};
  const diffs: ViewDiff[] = [];
  const worst: Array<{ label: string; files: string[] }> = [];
  let frame: { centre: number[]; wider: number } | null = null;
  const times = [["start", 0], ["middle", RECORDED_SECONDS / 2], ["end", RECORDED_SECONDS - 0.5]] as const;
  for (const [name, card] of cards) {
    await selectCard(page, card);
    await pauseTake(page, true);
    domes[name] = { state: await readRimState(page), times: [] };
  }
  for (const [label, seconds] of times) {
    for (const [name, card] of cards) {
      await selectCard(page, card);
      await seekTake(page, seconds);
      const dome = await readDome(page);
      domes[name]!.times.push({ seconds, ...dome });
      // Both takes are drawn from the untrimmed take's views: the middle of its dome, framed by its widest radius.
      frame ??= { centre: [dome.base[0]!, dome.base[1]! + dome.radii[1]! / 2, dome.base[2]!], wider: Math.max(...dome.radii) };
      await drawViews(page, `${name}-${label}`, frame.centre, frame.wider);
    }
    const compared = await compareViews(page, `untrimmed-${label}`, `trimmed-${label}`, label);
    diffs.push(...compared.diffs);
    if (compared.worst) {
      const files = ["untrimmed", "trimmed", "difference"].map((kind) => resolve(artifactDir, `${label}-worst-${kind}.png`));
      await Promise.all(compared.worst.images.map((image, k) => writeFile(files[k]!, Buffer.from(image.split(",")[1]!, "base64"))));
      worst.push({ label: compared.worst.label, files });
    }
  }

  const largest = diffs.reduce((max, diff) => (diff.share > max.share ? diff : max), diffs[0]!);
  const report = {
    sizes: { untrimmedBytes: untrimmedBytes.length, trimmedBytes: trimmedBytes.length, savedBytes: untrimmedBytes.length - trimmedBytes.length },
    set: { untrimmed: untrimmedSet, trimmed: trimmedSet },
    trim: { untrimmed, trimmed },
    views: { count: diffs.length, largest, differingViews: diffs.filter((diff) => diff.differing > 0).length, worst },
    domes
  };
  await writeFile(resolve(artifactDir, "report.json"), JSON.stringify({ ...report, diffs }, null, 2));

  // Smaller: fewer set triangles and bytes, from the same recording.
  expect(trimmed.enclosureSkipped, "the enclosure pass ran").toBe(false);
  expect(untrimmed.outOfReach + untrimmed.enclosed, "the untrimmed export drops nothing").toBe(0);
  expect(trimmed.kept, "the trimmed export's report matches its file").toBe(trimmedSet.triangles);
  expect(trimmedSet.triangles, "fewer set triangles").toBeLessThan(untrimmedSet.triangles);
  expect(trimmedBytes.length, "a smaller GLB").toBeLessThan(untrimmedBytes.length);

  // The dome does not move, and the rim decides the same.
  const [untrimmedDome, trimmedDome] = [domes.untrimmed!, domes.trimmed!];
  for (const key of ["gated", "lifts", "shadeDrawn"] as const) expect(trimmedDome.state[key], `rim ${key}`).toBe(untrimmedDome.state[key]);
  untrimmedDome.times.forEach((was, k) => {
    const now = trimmedDome.times[k]!;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(now.base[axis]! - was.base[axis]!), `dome base at ${was.seconds} s`).toBeLessThanOrEqual(0.001);
      expect(Math.abs(now.radii[axis]! - was.radii[axis]!), `dome radii at ${was.seconds} s`).toBeLessThanOrEqual(0.001);
    }
    expect(now.heights.length, "rim bins").toBe(was.heights.length);
    const furthest = now.heights.reduce((max, height, bin) => Math.max(max, Math.abs(height - was.heights[bin]!)), 0);
    expect(furthest, `rim heights at ${was.seconds} s`).toBeLessThanOrEqual(0.01);
  });

  // The feed draws the same picture from every view.
  expect(largest.share, `largest differing share (${largest.label})`).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
});
