import type { Page } from "@playwright/test";
import type * as Three from "three";
import type { Probe } from "./ar-bubble-types";

// Where a hologram's recorded floor ends up against the floor the viewer
// draws (B-022). The recorded floor is the capture scene's own ground under
// the author, found by casting down through the exported scene; the viewer's
// ground is the cloche's foot and, in AR, the surface the hologram is placed on.
// Read at the take's start, where the author stands: a take can walk off a
// ledge, and a bubble that follows its author carries the dome down with it.
// In the feed the dome wraps all the bubble draws, so its foot is the lowest
// drawn ground, which is under the author's floor where the ground falls away.
export type FloorReport = {
  mode: "feed" | "ar";
  /** The exported scene's ground under the author, world y. */
  recordedFloorY: number;
  /** The author's lowest foot bone (the ankle, a few centimetres up), world y. */
  footBoneY: number;
  /** The cloche's foot (its floor and shade), world y. */
  clocheBaseY: number;
  /** AR only: the placed hologram's origin, on the room floor. */
  placementY: number | null;
  /** Feed only: the lowest recorded ground inside the bubble, world y. */
  lowestDrawnY: number | null;
  /** Feed only: the drawn points of the recorded scene outside the glass. */
  outsideGlass: number | null;
};

type ClocheBase = { base: { x: number; y: number; z: number }; radii: { x: number; y: number; z: number }; exponent: number };

type FloorProbe = Probe & {
  cloche?: { current: ClocheBase | null } | { shape: { current: ClocheBase | null }; fitted: { current: Three.Vector3 | null } };
  group?: { current: Three.Object3D | null };
};

export async function measureFloor(page: Page, mode: "feed" | "ar"): Promise<FloorReport> {
  return page.evaluate(async (mode) => {
    const { Raycaster, Vector3 } = (await (window as unknown as { __HOLOIM_TEST_MODULES__: Promise<{ three: typeof Three }> }).__HOLOIM_TEST_MODULES__).three;
    const hooks = window as unknown as { __feedProbe: FloorProbe; __bubbleProbe: FloorProbe };
    const probe = mode === "feed" ? hooks.__feedProbe : hooks.__bubbleProbe;
    const { model, mixer } = probe;
    mixer.setTime(0);
    model.updateWorldMatrix(true, true);
    const avatar = model.getObjectByName("RecordedAvatar");
    if (!avatar) throw new Error("export has no RecordedAvatar");
    const author = avatar.getWorldPosition(new Vector3());
    const ground: Three.Object3D[] = [];
    model.getObjectByName("RecordedSceneBubble")?.traverse((node) => { if ((node as Three.Mesh).isMesh) ground.push(node); });
    if (ground.length === 0) throw new Error("export has no recorded scene");
    let footBoneY = Infinity;
    const foot = new Vector3();
    avatar.traverse((node) => {
      if ((node as Three.Bone).isBone && /(Left|Right)(Foot|ToeBase)$/.test(node.name)) footBoneY = Math.min(footBoneY, node.getWorldPosition(foot).y);
    });
    // Down from above the author's head: the first ground at or below the feet.
    const raycaster = new Raycaster(author.clone().setY(author.y + 2), new Vector3(0, -1, 0));
    const hit = raycaster.intersectObjects(ground, false).find((h) => h.point.y <= footBoneY + 0.05);
    if (!hit) throw new Error("no recorded ground under the author");

    let clocheBaseY = Number.NaN;
    let placementY: number | null = null;
    let lowestDrawnY: number | null = null;
    let outsideGlass: number | null = null;
    if (mode === "feed") {
      // The dome follows the bubble by its centre's shift since the fit.
      const cloche = probe.cloche as { shape: { current: ClocheBase | null }; fitted: { current: Three.Vector3 | null } };
      const sphere = model.getObjectByName("RecordedBubbleSphere");
      const shift = sphere && cloche.fitted.current ? sphere.getWorldPosition(new Vector3()).y - cloche.fitted.current.y : 0;
      const shape = cloche.shape.current;
      if (shape) clocheBaseY = shape.base.y + shift;
      if (shape && sphere && cloche.fitted.current) {
        const mesh = sphere as Three.Mesh;
        mesh.geometry.computeBoundingSphere();
        const bubble = mesh.geometry.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld);
        const offset = bubble.center.clone().sub(cloche.fitted.current);
        const point = new Vector3();
        lowestDrawnY = Infinity;
        outsideGlass = 0;
        for (const node of ground) {
          const position = (node as Three.Mesh).geometry.getAttribute("position");
          for (let i = 0; i < position.count; i += 1) {
            point.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
            if (point.distanceTo(bubble.center) > bubble.radius) continue;
            lowestDrawnY = Math.min(lowestDrawnY, point.y);
            // |x/rx|^n + |y/ry|^n + |z/rz|^n of the point against the dome where it is now.
            const { base, radii, exponent: n } = shape;
            const value = Math.abs((point.x - base.x - offset.x) / radii.x) ** n + Math.abs((point.y - base.y - offset.y) / radii.y) ** n + Math.abs((point.z - base.z - offset.z) / radii.z) ** n;
            if (point.y < base.y + offset.y - 0.01 || value > 1) outsideGlass += 1;
          }
        }
      }
    } else {
      const group = probe.group?.current;
      const shape = (probe.cloche as { current: ClocheBase | null }).current;
      if (group) {
        placementY = group.getWorldPosition(new Vector3()).y;
        if (shape) clocheBaseY = group.localToWorld(new Vector3(shape.base.x, shape.base.y, shape.base.z)).y;
      }
    }
    return { mode, recordedFloorY: hit.point.y, footBoneY, clocheBaseY, placementY, lowestDrawnY, outsideGlass };
  }, mode);
}
