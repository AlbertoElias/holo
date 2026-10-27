// Brief Q20, Q21; design-language concept 4: eight fixed directions, a ring
// after the hold delay, and a flick that never draws.
import { CAPTURE_HALO_ACTIONS, HALO_DIRECTIONS, type HaloDirection } from "@holoim/xr-ui-core";
import { tokens } from "@holoim/design-tokens";
import { describe, expect, it } from "vitest";

import { ThreeHalo } from "./ThreeHalo.js";
import { everyDescendantIsChrome, hexOf, meshesOf, visibleInTree } from "./testing.js";

const D = 1;

function halo(): ThreeHalo {
  return new ThreeHalo({ actions: CAPTURE_HALO_ACTIONS, distanceM: D });
}

function anythingVisible(h: ThreeHalo): boolean {
  return meshesOf(h.group).some((mesh) => visibleInTree(mesh) && (mesh.material as { visible: boolean }).visible);
}

describe("ThreeHalo directions", () => {
  it("places eight slots with north up (+y) and east right (+x), on the slot radius", () => {
    const h = halo();
    const at = Object.fromEntries(HALO_DIRECTIONS.map((direction) => [direction, h.slotPositionM(direction)])) as Record<HaloDirection, ReturnType<ThreeHalo["slotPositionM"]>>;
    expect(at.n.y).toBeGreaterThan(0);
    expect(Math.abs(at.n.x)).toBeLessThan(1e-9);
    expect(at.e.x).toBeGreaterThan(0);
    expect(Math.abs(at.e.y)).toBeLessThan(1e-9);
    expect(at.s.y).toBeLessThan(0);
    expect(at.w.x).toBeLessThan(0);
    expect(at.ne.x).toBeGreaterThan(0);
    expect(at.ne.y).toBeGreaterThan(0);
    expect(at.sw.x).toBeLessThan(0);
    expect(at.sw.y).toBeLessThan(0);
    const radii = HALO_DIRECTIONS.map((direction) => at[direction].length());
    for (const radius of radii) expect(radius).toBeCloseTo(radii[0]!, 9);
  });

  it("gives objects only to S, W and E for capture's actions; the rest stay reserved and empty (Q20)", () => {
    const h = halo();
    const filled = HALO_DIRECTIONS.filter((direction) => h.slotObject(direction) !== undefined);
    expect(filled.sort()).toEqual(["e", "s", "w"]);
    expect(h.slotObject("s")!.action).toBe("record");
    expect(h.slotObject("s")!.glyph.id).toBe("record");
    // Undo and redo draw their arrows inside a gold ring of the slot size (6.2).
    for (const [direction, id] of [["w", "undo"], ["e", "redo"]] as const) {
      const slot = h.slotObject(direction)!;
      expect(slot.glyph.id).toBe(id);
      expect(slot.glyph.ring).not.toBeNull();
      expect(slot.glyph.shape).not.toBeNull();
      expect(slot.glyph.drawnSizeM).toBeCloseTo(h.slotObject("s")!.glyph.drawnSizeM, 6);
    }
    expect(h.slotObject("n")).toBeUndefined();
  });

  it("puts each object on its slot and gives it a hit area for the input", () => {
    const h = new ThreeHalo({ actions: CAPTURE_HALO_ACTIONS, distanceM: D, input: "gazePinch" });
    for (const direction of ["s", "w", "e"] as const) {
      const slot = h.slotObject(direction)!;
      expect(slot.glyph.group.position.distanceTo(h.slotPositionM(direction))).toBeLessThan(1e-9);
      expect(slot.hitSizeM).toBeGreaterThan(0);
      expect(slot.hitTarget).toBe(slot.glyph.hitTarget);
    }
  });
});

describe("ThreeHalo hold and flick (Q20, 8.4)", () => {
  it("never makes anything visible for a flick: press, move, release before 300 ms", () => {
    const h = halo();
    expect(anythingVisible(h)).toBe(false);
    const away = h.layout.radiusApx;
    const press = h.handle({ type: "press", atMs: 0 });
    expect(press.ringDrawn).toBe(false);
    expect(anythingVisible(h)).toBe(false);
    const move = h.handle({ type: "move", atMs: 120, dx: away, dy: 0 });
    expect(move.ringDrawn).toBe(false);
    expect(anythingVisible(h)).toBe(false);
    const release = h.handle({ type: "release", atMs: 250 });
    expect(release.commit).toMatchObject({ direction: "e", action: "redo", flick: true });
    expect(anythingVisible(h)).toBe(false);
  });

  it("draws the ring and slots after 300 ms and highlights the slot the movement points at", () => {
    const h = halo();
    h.handle({ type: "press", atMs: 0 });
    h.handle({ type: "tick", atMs: 299 });
    expect(h.drawn).toBe(false);
    const held = h.handle({ type: "move", atMs: 320, dx: -h.layout.radiusApx, dy: 0 });
    expect(held.ringDrawn).toBe(true);
    expect(held.highlighted).toBe("w");
    expect(h.drawn).toBe(true);
    expect(visibleInTree(h.ring)).toBe(true);
    const west = h.slotObject("w")!;
    expect(visibleInTree(west.glyph.group)).toBe(true);
    expect(hexOf(west.glyph.ring!.material as never)).toBe(tokens.glyph.states.hoverColor);
    expect(hexOf(h.slotObject("e")!.glyph.ring!.material as never)).toBe(tokens.glyph.color);
    const release = h.handle({ type: "release", atMs: 700 });
    expect(release.commit).toMatchObject({ direction: "w", action: "undo", flick: false });
    expect(anythingVisible(h)).toBe(false);
    expect(hexOf(west.glyph.ring!.material as never)).toBe(tokens.glyph.color);
  });

  it("commits nothing, and hides, on a cancel (blur, tracking loss)", () => {
    const h = halo();
    h.handle({ type: "press", atMs: 0 });
    h.handle({ type: "tick", atMs: 400 });
    expect(h.drawn).toBe(true);
    const cancel = h.handle({ type: "cancel" });
    expect(cancel.commit).toBeNull();
    expect(anythingVisible(h)).toBe(false);
  });

  it("converts a movement in metres to the layout's apx", () => {
    const h = halo();
    const slot = h.slotPositionM("e");
    expect(h.apxFromMetres(slot.x)).toBeCloseTo(h.layout.radiusApx, 6);
  });

  it("is chrome on every object", () => {
    expect(everyDescendantIsChrome(halo().group)).toBe(true);
  });
});

describe("ThreeHalo dispose", () => {
  it("frees the ring's material as well as its geometry", () => {
    const halo = new ThreeHalo({ actions: CAPTURE_HALO_ACTIONS, distanceM: 1.5 });
    let disposed = false;
    (halo.ring.material as { addEventListener(type: "dispose", listener: () => void): void }).addEventListener("dispose", () => {
      disposed = true;
    });
    halo.dispose();
    expect(disposed).toBe(true);
  });
});
