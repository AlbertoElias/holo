import type { Page } from "@playwright/test";
import type * as Three from "three";

import type { Probe } from "./ar-bubble-types";
import { assertViewerShell, expect } from "./bootstrap";

export type Reading = { label: string; performerPx: number; performerOnCard: number; chartOnCard: number | null; setOnCard: number | null; camera: number[]; over: { time: number; performerPx: number; performerOnCard: number }[] };

/**
 * One take alone in the feed, its card focused and settled: the height of
 * the performer on the screen (her mesh projected through the card's
 * camera), the share of her, of a recorded object and of a recorded set
 * that is on the card, and, at each of `times` (seconds into the take, the
 * clip held there), her height and share again.
 */
export async function readCard(page: Page, glb: Buffer, label: string, times: readonly number[] = []): Promise<Reading> {
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
  return page.evaluate(async ({ label, times }): Promise<Reading> => {
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
          vertex.fromBufferAttribute(position, i);
          // A skinned body is read where its bones put it, not in its bind pose.
          if ((mesh as Three.SkinnedMesh).isSkinnedMesh) (mesh as Three.SkinnedMesh).applyBoneTransform(i, vertex);
          vertex.applyMatrix4(mesh.matrixWorld).project(camera);
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
    const set = read("RecordedSet");
    // The framing is fixed for the take, so she is read again at each moment with the clip held there.
    const over = times.map((time) => {
      probe.mixer.setTime(time);
      probe.model.updateWorldMatrix(true, true);
      const at = read("RecordedAvatar")!;
      return { time, performerPx: at.height, performerOnCard: at.onCard };
    });
    return { label, performerPx: performer.height, performerOnCard: performer.onCard, chartOnCard: chart ? chart.onCard : null, setOnCard: set ? set.onCard : null, camera: camera.position.toArray(), over };
  }, { label, times });
}
