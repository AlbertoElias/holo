// Styleguide 3 and 8.5: one hologram, one edge, wherever it is drawn; none in a
// headset while recording.
import { tokens } from "@holoim/design-tokens";
import { VIEW_TARGETS, edgeOutline, edgePointsYUp, edgeStrokes, haloMaterialOpacity, type ViewTarget } from "@holoim/xr-ui-core";
import type { ReactNode } from "react";
import { type Mesh, type Object3D } from "three";
import { describe, expect, it } from "vitest";

import { Edge, type EdgeProps } from "./Edge.js";
import { hexOf, meshesOf, mount, nonChrome, watchDispose } from "./testHelpers.js";

const SIZE = { width: 0.62, height: 0.74 };
const DARK_ROOM = { groundLuminance: 0.02 };

function edge(props: Partial<EdgeProps> = {}): ReactNode {
  return <Edge seed="holo-1" {...SIZE} target={VIEW_TARGETS.vr} recording={false} inFocus={true} reducedMotion={false} soot={DARK_ROOM} {...props} />;
}

function rootOf(scene: Object3D): Object3D {
  const found = scene.getObjectByName("edge");
  if (!found) throw new Error("no edge");
  return found;
}

function layer(scene: Object3D, name: "soot" | "halo" | "core" | "highlight"): Mesh {
  return scene.getObjectByName(`edge-${name}`) as Mesh;
}

/** The outline's points back out of the solid core ribbon: the middle of the two rows at each point. */
function coreCentres(mesh: Mesh): Array<{ x: number; y: number }> {
  const positions = mesh.geometry.getAttribute("position");
  const centres: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < positions.count; i += 2) {
    centres.push({ x: (positions.getX(i) + positions.getX(i + 1)) / 2, y: (positions.getY(i) + positions.getY(i + 1)) / 2 });
  }
  return centres;
}

describe("Edge: one outline from one seed (3.1, brief Q10)", () => {
  it("draws the core's points: edgePointsYUp of the seeded outline, the same for two edges of one seed", async () => {
    const a = await mount(edge());
    const b = await mount(edge({ target: VIEW_TARGETS.questPassthrough }));
    const expected = edgePointsYUp(edgeOutline({ seed: "holo-1", ...SIZE }), SIZE.width, SIZE.height);
    const first = coreCentres(layer(a.scene.instance, "core"));
    const second = coreCentres(layer(b.scene.instance, "core"));
    expect(first).toHaveLength(tokens.edge.samples);
    expect(first).toHaveLength(expected.length);
    first.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expected[index]!.x, 6);
      expect(point.y).toBeCloseTo(expected[index]!.y, 6);
    });
    expect(second).toEqual(first);
    await a.unmount();
    await b.unmount();
  });

  it("draws other points for another seed, and the same again when the seed returns", async () => {
    const renderer = await mount(edge({ seed: "holo-1" }));
    const first = coreCentres(layer(renderer.scene.instance, "core"));
    await renderer.update(edge({ seed: "holo-2" }));
    const other = coreCentres(layer(renderer.scene.instance, "core"));
    expect(other).not.toEqual(first);
    await renderer.update(edge({ seed: "holo-1" }));
    expect(coreCentres(layer(renderer.scene.instance, "core"))).toEqual(first);
    await renderer.unmount();
  });
});

describe("Edge: recording (8.5)", () => {
  it.each<[string, ViewTarget]>([
    ["VR", VIEW_TARGETS.vr],
    ["Quest passthrough", VIEW_TARGETS.questPassthrough],
    ["Android Chrome", VIEW_TARGETS.androidChrome]
  ])("is not drawn in %s while recording, at once and on every frame, and returns when the take ends", async (_name, target) => {
    const renderer = await mount(edge({ target, soot: { arSootOn: null } }));
    expect(rootOf(renderer.scene.instance).visible).toBe(true);
    await renderer.update(edge({ target, recording: true, soot: { arSootOn: null } }));
    expect(rootOf(renderer.scene.instance).visible).toBe(false);
    await renderer.advanceFrames(10, 0.016);
    expect(rootOf(renderer.scene.instance).visible).toBe(false);
    await renderer.update(edge({ target, recording: false, soot: { arSootOn: null } }));
    await renderer.advanceFrames(2, 0.016);
    expect(rootOf(renderer.scene.instance).visible).toBe(true);
    await renderer.unmount();
  });

  it("on a flat screen only quiets the edge: core and highlight at 0.55, the halo at level 0.08", async () => {
    const renderer = await mount(edge({ target: VIEW_TARGETS.desktop, recording: true }));
    await renderer.advanceFrames(3, 0.016);
    const scene = renderer.scene.instance;
    expect(rootOf(scene).visible).toBe(true);
    const quiet = tokens.motion.recording;
    expect((layer(scene, "core").material as { opacity: number }).opacity).toBeCloseTo(quiet.flatCoreAndHighlightOpacity, 9);
    expect((layer(scene, "highlight").material as { opacity: number }).opacity).toBeCloseTo(quiet.flatCoreAndHighlightOpacity, 9);
    expect((layer(scene, "halo").material as { opacity: number }).opacity).toBeCloseTo(haloMaterialOpacity(quiet.flatHaloLevel), 9);
    await renderer.unmount();
  });
});

describe("Edge: soot (3.2)", () => {
  it("is on at full opacity in AR with no lighting estimate, and drops out when the estimate says dark", async () => {
    const renderer = await mount(edge({ target: VIEW_TARGETS.questPassthrough, soot: { arSootOn: null } }));
    await renderer.advanceFrames(2, 0.016);
    expect((layer(renderer.scene.instance, "soot").material as { opacity: number }).opacity).toBe(tokens.edge.soot.arNoEstimateOpacity);
    await renderer.update(edge({ target: VIEW_TARGETS.androidChrome, soot: { arSootOn: false } }));
    await renderer.advanceFrames(2, 0.016);
    expect((layer(renderer.scene.instance, "soot").material as { opacity: number }).opacity).toBe(0);
    await renderer.unmount();
  });
});

describe("Edge: chrome flag and colour", () => {
  it("marks every object it mounts as chrome, again after every change of props", async () => {
    const renderer = await mount(edge());
    expect(nonChrome(rootOf(renderer.scene.instance))).toEqual([]);
    await renderer.update(edge({ seed: "holo-2", width: 1, height: 0.5, recording: true }));
    await renderer.advanceFrames(2, 0.016);
    expect(nonChrome(rootOf(renderer.scene.instance))).toEqual([]);
    await renderer.update(edge({ seed: "holo-2", width: 1, height: 0.5, target: VIEW_TARGETS.desktop }));
    expect(nonChrome(rootOf(renderer.scene.instance))).toEqual([]);
    await renderer.unmount();
  });

  it("reads each stroke back as its token hex, never tone mapped", async () => {
    const renderer = await mount(edge());
    const scene = renderer.scene.instance;
    const strokes = edgeStrokes(Math.min(SIZE.width, SIZE.height));
    expect(hexOf(layer(scene, "soot").material as never)).toBe(tokens.edge.soot.color);
    expect(hexOf(layer(scene, "halo").material as never)).toBe(tokens.edge.halo.color);
    expect(hexOf(layer(scene, "core").material as never)).toBe(tokens.edge.core.color);
    expect(hexOf(layer(scene, "highlight").material as never)).toBe(tokens.edge.highlight.color);
    expect(strokes.core.color).toBe(tokens.edge.core.color);
    for (const mesh of meshesOf(rootOf(scene))) expect((mesh.material as { toneMapped: boolean }).toneMapped).toBe(false);
    await renderer.unmount();
  });

  it("disposes what it built when it unmounts", async () => {
    const renderer = await mount(edge());
    const watches = meshesOf(renderer.scene.instance).flatMap((mesh) => [watchDispose(mesh.geometry), watchDispose(mesh.material as never)]);
    await renderer.unmount();
    expect(watches).toHaveLength(8);
    expect(watches.every((watch) => watch.disposed)).toBe(true);
  });
});
