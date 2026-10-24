// Styleguide 9.2: in WebXR AR the edge outlines the bubble, a burnt ring
// around its silhouette, facing the viewer.
import { tokens } from "@holoim/design-tokens";
import { VIEW_TARGETS, bubbleSilhouette, edgeOutline, edgePointsYUp, haloMaterialOpacity } from "@holoim/xr-ui-core";
import type { ReactNode } from "react";
import { type Camera, type Mesh, type Object3D, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { BubbleEdge, type BubbleEdgeProps } from "./BubbleEdge.js";
import { CameraProbe, mount, nonChrome } from "./testHelpers.js";

const BUBBLE = { center: { x: 0.1, y: 0.9, z: -1.6 }, radius: 0.55 };

function ring(into: { camera?: Camera }, props: Partial<BubbleEdgeProps> = {}): ReactNode {
  return (
    <>
      <CameraProbe into={into} />
      <BubbleEdge
        seed="holo-1"
        bubble={BUBBLE}
        target={VIEW_TARGETS.questPassthrough}
        recording={false}
        inFocus={true}
        reducedMotion={false}
        soot={{ arSootOn: null }}
        {...props}
      />
    </>
  );
}

function rootOf(scene: Object3D): Object3D {
  const found = scene.getObjectByName("bubble-edge");
  if (!found) throw new Error("no bubble edge");
  return found;
}

/** The core ribbon's centre line in world space. */
function coreWorld(scene: Object3D): Vector3[] {
  const core = scene.getObjectByName("edge-core") as Mesh;
  core.updateWorldMatrix(true, false);
  const positions = core.geometry.getAttribute("position");
  const points: Vector3[] = [];
  for (let i = 0; i < positions.count; i += 2) {
    const a = new Vector3().fromBufferAttribute(positions, i);
    const b = new Vector3().fromBufferAttribute(positions, i + 1);
    points.push(a.add(b).multiplyScalar(0.5).applyMatrix4(core.matrixWorld));
  }
  return points;
}

async function lookFrom(renderer: Awaited<ReturnType<typeof mount>>, into: { camera?: Camera }, eye: Vector3) {
  into.camera!.position.copy(eye);
  into.camera!.lookAt(BUBBLE.center.x, BUBBLE.center.y, BUBBLE.center.z);
  into.camera!.updateMatrixWorld();
  await renderer.advanceFrames(1, 0.016);
}

describe("BubbleEdge: the burnt ring around the AR bubble (9.2)", () => {
  it("draws the hologram's seeded circle, the same points for the same seed", async () => {
    const into: { camera?: Camera } = {};
    const a = await mount(ring(into));
    const b = await mount(ring({}));
    const core = a.scene.instance.getObjectByName("edge-core") as Mesh;
    const expected = edgePointsYUp(edgeOutline({ seed: "holo-1", width: 1, height: 1, shape: "circle" }), 1, 1);
    const positions = core.geometry.getAttribute("position");
    expect(positions.count / 2).toBe(tokens.edge.samples);
    for (let i = 0; i < expected.length; i += 1) {
      expect((positions.getX(2 * i) + positions.getX(2 * i + 1)) / 2).toBeCloseTo(expected[i]!.x, 6);
      expect((positions.getY(2 * i) + positions.getY(2 * i + 1)) / 2).toBeCloseTo(expected[i]!.y, 6);
    }
    const other = b.scene.instance.getObjectByName("edge-core") as Mesh;
    expect(Array.from(other.geometry.getAttribute("position").array)).toEqual(Array.from(positions.array));
    await a.unmount();
    await b.unmount();
  });

  it("stays on the bubble's silhouette, facing the viewer, as they walk round it", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(ring(into));
    const centre = new Vector3(BUBBLE.center.x, BUBBLE.center.y, BUBBLE.center.z);
    const most = (tokens.edge.waveAmplitude + tokens.edge.tearAmplitude * 1.4 + tokens.edge.jitter) * 2;
    for (let step = 0; step < 8; step += 1) {
      const angle = (step / 8) * Math.PI * 2;
      const eye = new Vector3(centre.x + 1.8 * Math.sin(angle), 1.6, centre.z + 1.8 * Math.cos(angle));
      await lookFrom(renderer, into, eye);
      const silhouette = bubbleSilhouette(BUBBLE.center, BUBBLE.radius, eye)!;
      const ringCentre = new Vector3(silhouette.center.x, silhouette.center.y, silhouette.center.z);
      const normal = new Vector3(silhouette.normal.x, silhouette.normal.y, silhouette.normal.z);
      for (const point of coreWorld(renderer.scene.instance)) {
        const offset = point.clone().sub(ringCentre);
        // In the plane facing the viewer, on the silhouette's radius give or take the burn.
        expect(Math.abs(offset.dot(normal))).toBeLessThan(1e-6);
        expect(Math.abs(offset.length() - silhouette.radius)).toBeLessThanOrEqual(most * silhouette.radius + 1e-6);
      }
    }
    await renderer.unmount();
  });

  it("scales its strokes with the bubble", async () => {
    const into: { camera?: Camera } = {};
    const small = await mount(ring(into, { bubble: { ...BUBBLE, radius: 0.2 } }));
    await lookFrom(small, into, new Vector3(0.1, 0.9, 2.4));
    const smallScale = rootOf(small.scene.instance).scale.x;
    const intoLarge: { camera?: Camera } = {};
    const large = await mount(ring(intoLarge, { bubble: { ...BUBBLE, radius: 0.8 } }));
    await lookFrom(large, intoLarge, new Vector3(0.1, 0.9, 2.4));
    const largeScale = rootOf(large.scene.instance).scale.x;
    const expectedSmall = bubbleSilhouette(BUBBLE.center, 0.2, { x: 0.1, y: 0.9, z: 2.4 })!.radius * 2;
    const expectedLarge = bubbleSilhouette(BUBBLE.center, 0.8, { x: 0.1, y: 0.9, z: 2.4 })!.radius * 2;
    expect(smallScale).toBeCloseTo(expectedSmall, 6);
    expect(largeScale).toBeCloseTo(expectedLarge, 6);
    expect(largeScale / smallScale).toBeGreaterThan(3.5);
    await small.unmount();
    await large.unmount();
  });

  it("marks every object as chrome, and hides from inside the bubble or with no bubble", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(ring(into));
    await lookFrom(renderer, into, new Vector3(0.1, 1.2, 0.5));
    const root = rootOf(renderer.scene.instance);
    expect(nonChrome(root)).toEqual([]);
    expect(root.visible).toBe(true);
    await lookFrom(renderer, into, new Vector3(0.1, 0.9, -1.4));
    expect(root.visible).toBe(false);
    await renderer.update(ring(into, { bubble: { ...BUBBLE, active: false } }));
    await lookFrom(renderer, into, new Vector3(0.1, 1.2, 0.5));
    expect(root.visible).toBe(false);
    expect(nonChrome(root)).toEqual([]);
    await renderer.unmount();
  });

  it("follows the AR soot rule: on with no lighting estimate, off when the estimate says dark", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(ring(into));
    await lookFrom(renderer, into, new Vector3(0.1, 1.2, 0.5));
    const material = (name: string) => ((renderer.scene.instance.getObjectByName(name) as Mesh).material as { opacity: number }).opacity;
    expect(material("edge-soot")).toBeCloseTo(tokens.edge.soot.arNoEstimateOpacity, 6);
    expect(material("edge-halo")).toBe(0);
    await renderer.update(ring(into, { target: VIEW_TARGETS.androidChrome, soot: { arSootOn: false } }));
    await renderer.advanceFrames(1, 0.016);
    expect(material("edge-soot")).toBe(0);
    expect(material("edge-halo")).toBeGreaterThan(haloMaterialOpacity(0.2));
    await renderer.unmount();
  });
});
