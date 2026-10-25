// Styleguide 3.1 to 3.3: one hologram, one edge, wherever it is drawn.
import { edgeOutline, edgePointsYUp, haloMaterialOpacity } from "@holoim/xr-ui-core";
import { describe, expect, it } from "vitest";

import { ThreeEdge } from "./ThreeEdge.js";
import { everyDescendantIsChrome } from "./testing.js";

const size = { width: 0.62, height: 0.74 };

function positions(edge: ThreeEdge, layer: "soot" | "halo" | "core" | "highlight"): number[] {
  return [...edge.meshes[layer].geometry.getAttribute("position").array];
}

describe("ThreeEdge", () => {
  it("draws the same points from the same seed, and other points from another (3.1, brief Q10)", () => {
    const a = new ThreeEdge({ seed: "holo-1", ...size });
    const b = new ThreeEdge({ seed: "holo-1", ...size });
    const other = new ThreeEdge({ seed: "holo-2", ...size });
    for (const layer of ["soot", "halo", "core", "highlight"] as const) expect(positions(a, layer)).toEqual(positions(b, layer));
    expect(a.points).toEqual(edgePointsYUp(edgeOutline({ seed: "holo-1", ...size }), size.width, size.height));
    expect(a.points).toEqual(b.points);
    expect(positions(other, "core")).not.toEqual(positions(a, "core"));
    expect(other.points).not.toEqual(a.points);
  });

  it("keeps the outline's 280 points, centred and y up", () => {
    const edge = new ThreeEdge({ seed: "holo-1", ...size });
    expect(edge.points).toHaveLength(280);
    const xs = edge.points.map((p) => p.x);
    const ys = edge.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(size.height / 2);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-size.height / 2);
  });

  it("orders soot, halo, core, highlight, with the halo and soot soft and the core and highlight solid (3.2)", () => {
    const edge = new ThreeEdge({ seed: "holo-1", ...size });
    const order = ["soot", "halo", "core", "highlight"] as const;
    const renderOrders = order.map((layer) => edge.meshes[layer].renderOrder);
    expect([...renderOrders].sort((x, y) => x - y)).toEqual(renderOrders);
    expect(new Set(renderOrders).size).toBe(4);
    for (const layer of ["soot", "halo"] as const) {
      const color = edge.meshes[layer].geometry.getAttribute("color");
      expect(color.itemSize).toBe(4);
      expect(edge.materials[layer].vertexColors).toBe(true);
      const alphas = Array.from({ length: color.count }, (_, i) => color.getW(i));
      expect(Math.max(...alphas)).toBe(1);
      expect(Math.min(...alphas)).toBe(0);
    }
    for (const layer of ["core", "highlight"] as const) {
      expect(edge.meshes[layer].geometry.getAttribute("color")).toBeUndefined();
      expect(edge.materials[layer].vertexColors).toBe(false);
    }
  });

  it("offsets each ribbon by half its stroke width along the normals (3.3)", () => {
    const edge = new ThreeEdge({ seed: "holo-1", ...size });
    for (const layer of ["halo", "core", "highlight"] as const) {
      const array = edge.meshes[layer].geometry.getAttribute("position");
      const rows = layer === "halo" ? 9 : 2;
      let widest = 0;
      for (let i = 0; i < edge.points.length; i += 1) {
        const first = i * rows;
        const last = first + rows - 1;
        widest = Math.max(widest, Math.hypot(array.getX(last) - array.getX(first), array.getY(last) - array.getY(first)));
      }
      expect(widest).toBeCloseTo(edge.strokes[layer].width, 5);
    }
  });

  it("follows the frame: hidden when not drawn, halo opacity from the glow level, soot and core from the frame", () => {
    const edge = new ThreeEdge({ seed: "holo-1", ...size });
    edge.update({ drawn: true, glowLevel: 0.5, sootOpacity: 0.3, coreOpacity: 0.55, highlightOpacity: 0.55, sparks: 0 });
    expect(edge.group.visible).toBe(true);
    expect(edge.materials.halo.opacity).toBeCloseTo(haloMaterialOpacity(0.5));
    expect(edge.materials.halo.opacity).toBeCloseTo(0.9);
    expect(edge.materials.soot.opacity).toBeCloseTo(0.3);
    expect(edge.materials.core.opacity).toBeCloseTo(0.55);
    expect(edge.materials.highlight.opacity).toBeCloseTo(0.55);
    edge.update({ drawn: false, glowLevel: 0, sootOpacity: 0, coreOpacity: 0, highlightOpacity: 0, sparks: 0 });
    expect(edge.group.visible).toBe(false);
  });

  it("is chrome from the root down, after updates too (chrome flag)", () => {
    const edge = new ThreeEdge({ seed: "holo-1", ...size });
    edge.update({ drawn: true, glowLevel: 0.2, sootOpacity: 0.6, coreOpacity: 1, highlightOpacity: 1, sparks: 0 });
    expect(everyDescendantIsChrome(edge.group)).toBe(true);
  });
});
