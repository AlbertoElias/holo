import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";
import type * as Three from "three";

import type { Probe } from "./ar-bubble-types";
import { assertViewerShell, expect, test } from "./bootstrap";
import { chartTakeGltf } from "./bubble-fixture";

// A far recorded object must not shrink the performer on the feed card
// (feature brief card-framing-objects, option B, styleguide 3.4). The same
// performer is opened with a chart standing inside her silhouette (the
// reference: it widens nothing, and a card with an object has the same
// viewing box as the ones below) and with a chart 0.5, 2, 3 and 5 m off to
// her side and toward the viewer. Her height on the card, read by projecting
// her own mesh through the card's camera, never falls under 75 % of the
// reference; she is always wholly on the card; and the chart sits wholly on
// it while it is near and only partly, or not at all, once it is far.

const artifactDir = resolve(import.meta.dirname, "../../../output/card-framing-floor");
const FLOOR = 0.75;
const PHONE = { width: 390, height: 844 };

type Placement = { label: string; at: readonly [number, number] };
type Reading = { label: string; performerPx: number; performerOnCard: number; chartOnCard: number | null; camera: number[] };

const placements: Placement[] = [
  { label: "chart inside her", at: [0, 0] },
  { label: "chart 0.5 m to her side", at: [0.5, 0] },
  { label: "chart 2 m to her side", at: [2, 0] },
  { label: "chart 3 m to her side", at: [3, 0] },
  { label: "chart 5 m to her side", at: [5, 0] },
  { label: "chart 3 m toward the viewer", at: [0, 3] },
  { label: "chart 5 m toward the viewer", at: [0, 5] }
];

test.use({ viewport: PHONE });

async function readCard(page: Page, glb: Buffer, label: string): Promise<Reading> {
  const hologram = {
    id: "floor-1",
    url: "/uploads/floor.glb",
    usdzUrl: null,
    quickLookEnabled: false,
    createdAt: "2026-11-17T00:00:00.000Z",
    sizeBytes: 2048,
    filenameOriginal: "floor.glb",
    hologramName: "Chart",
    submittedBy: "automation"
  };
  await page.addInitScript(() => {
    const hooks = window as unknown as { __feedProbe?: Probe; __HOLOIM_FEED_TEST_OBSERVER__?: (probe: Probe) => void };
    hooks.__HOLOIM_FEED_TEST_OBSERVER__ = (probe) => { hooks.__feedProbe = probe; };
  });
  await page.route("**/api/holograms?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [hologram], nextCursor: null }) }));
  await page.route(`**/api/holograms/${hologram.id}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hologram) }));
  await page.route("**/uploads/**", (route) => route.fulfill({ status: 200, body: glb, contentType: "model/gltf-binary" }));
  await page.goto("/");
  await assertViewerShell(page);
  const card = page.locator(`.feed-card[data-card-id="${hologram.id}"]`);
  await expect(card).toHaveAttribute("data-model-state", "rendered", { timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __feedProbe?: { cloche: { shape: { current: unknown } } } }).__feedProbe;
    return Boolean(probe?.cloche.shape.current);
  });
  // The focused card draws every frame once it is active; the framing has settled by 20 frames.
  const frame = () => page.evaluate(() => (window as unknown as { __feedProbe: Probe }).__feedProbe.renderer.info.render.frame);
  const from = await frame();
  await expect.poll(frame, { message: "the focused card draws every frame", timeout: 15_000 }).toBeGreaterThan(from + 20);
  return page.evaluate(async (label): Promise<Reading> => {
    const { Vector3 } = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
    const probe = (window as unknown as { __feedProbe: Probe }).__feedProbe;
    const camera = probe.camera!;
    camera.updateMatrixWorld();
    const canvas = probe.renderer.domElement.getBoundingClientRect();
    const cardBox = (probe.renderer.domElement.closest(".feed-card") ?? probe.renderer.domElement).getBoundingClientRect();
    const visible = { left: Math.max(cardBox.left, 0), top: Math.max(cardBox.top, 0), right: Math.min(cardBox.right, innerWidth), bottom: Math.min(cardBox.bottom, innerHeight) };
    probe.model.updateWorldMatrix(true, true);
    const read = (name: string) => {
      const root = probe.model.getObjectByName(name);
      if (!root) return null;
      let top = Infinity;
      let bottom = -Infinity;
      let inside = 0;
      let total = 0;
      const vertex = new Vector3();
      root.traverse((child) => {
        const mesh = child as Three.Mesh;
        if (!mesh.isMesh) return;
        const position = mesh.geometry.getAttribute("position");
        for (let i = 0; i < position.count; i += 1) {
          vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).project(camera);
          const x = canvas.left + ((vertex.x + 1) / 2) * canvas.width;
          const y = canvas.top + ((1 - vertex.y) / 2) * canvas.height;
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          total += 1;
          if (vertex.z > -1 && vertex.z < 1 && x >= visible.left && x <= visible.right && y >= visible.top && y <= visible.bottom) inside += 1;
        }
      });
      return { height: bottom - top, onCard: total ? inside / total : 0 };
    };
    const performer = read("RecordedAvatar")!;
    const chart = read("RecordedObject");
    return { label, performerPx: performer.height, performerOnCard: performer.onCard, chartOnCard: chart ? chart.onCard : null, camera: camera.position.toArray() };
  }, label);
}

test("a far recorded object leaves the performer at 75 % or more of her size, wholly on the card", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const readings: Reading[] = [];
  for (const placement of placements) {
    const { baseURL } = testInfo.project.use;
    const context = await browser.newContext({ viewport: PHONE, ignoreHTTPSErrors: true, ...(baseURL ? { baseURL } : {}) });
    const page = await context.newPage();
    try {
      readings.push(await readCard(page, chartTakeGltf(placement.at), placement.label));
    } finally {
      await context.close();
    }
  }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(resolve(artifactDir, "report.json"), `${JSON.stringify(readings, null, 2)}\n`);
  const reference = readings[0]!;
  expect(reference.performerPx, "the performer is read at a usable size").toBeGreaterThan(100);
  expect(reference.chartOnCard, "the reference chart is on the card").toBe(1);
  for (const reading of readings.slice(1)) {
    expect(reading.performerPx, `${reading.label}: the performer keeps ${FLOOR * 100} % of her size without the chart widening the frame (${reference.performerPx.toFixed(0)} px)`).toBeGreaterThanOrEqual(reference.performerPx * FLOOR - 2);
    expect(reading.performerOnCard, `${reading.label}: she is wholly on the card`).toBe(1);
  }
  const chartOnCard = (label: string) => readings.find((reading) => reading.label === label)!.chartOnCard!;
  expect(chartOnCard("chart 0.5 m to her side"), "a near chart is wholly on the card").toBe(1);
  expect(chartOnCard("chart 3 m to her side"), "a chart 3 m off is only partly on the card, the performer being kept large").toBeLessThan(1);
  expect(chartOnCard("chart 5 m to her side"), "and further, less of it").toBeLessThanOrEqual(chartOnCard("chart 3 m to her side"));
});
