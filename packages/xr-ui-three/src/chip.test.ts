// Styleguide 2.3, 5.2, 8.4: the chip's opacity per target, never opaque in AR,
// and a VR chip that does not flicker at a boundary.
import { VIEW_TARGETS, type ViewTarget } from "@holoim/xr-ui-core";
import { describe, expect, it } from "vitest";

import { ThreeChip } from "./ThreeChip.js";
import { everyDescendantIsChrome } from "./testing.js";

const unlistedAr: ViewTarget = { kind: "ar", compositor: "unlisted", headset: false };

function fadedIn(target: ViewTarget): ThreeChip {
  const chip = new ThreeChip({ target, distanceM: 1.5 });
  for (let t = 0; t < 400; t += 16) chip.update(16, true);
  return chip;
}

describe("ThreeChip opacity (2.3)", () => {
  it.each([
    ["VR", VIEW_TARGETS.vr, 0.72],
    ["Quest passthrough", VIEW_TARGETS.questPassthrough, 0.97],
    ["Android Chrome", VIEW_TARGETS.androidChrome, 0.88],
    ["an unlisted AR target (brief Q18)", unlistedAr, 0.92]
  ])("is %s at %s opacity", (_name, target, opacity) => {
    const chip = fadedIn(target);
    expect(chip.presence).toBe(1);
    expect(chip.material.opacity).toBeCloseTo(opacity, 9);
  });

  it("is never opaque in AR, at any presence", () => {
    for (const target of [VIEW_TARGETS.questPassthrough, VIEW_TARGETS.androidChrome, unlistedAr]) {
      const chip = new ThreeChip({ target, distanceM: 1.5 });
      expect(chip.presence).toBe(1);
      expect(chip.material.opacity).toBeLessThan(1);
      expect(chip.material.transparent).toBe(true);
      expect(chip.material.depthWrite).toBe(false);
    }
  });

  it("holds no chip in Quick Look (5.2)", () => {
    expect(() => new ThreeChip({ target: VIEW_TARGETS.quickLook, distanceM: 1 })).toThrow(/Quick Look/);
  });

  it("is plain deep sea: no map, no rim (2.3)", () => {
    const chip = new ThreeChip({ target: VIEW_TARGETS.vr, distanceM: 1.5 });
    expect(chip.material.map).toBeNull();
    expect(chip.group.children).toHaveLength(1);
  });

  it("takes the headset's 2.5x on its shape and none on a phone's (2.3)", () => {
    const vr = new ThreeChip({ target: VIEW_TARGETS.vr, distanceM: 1.5 });
    const phone = new ThreeChip({ target: VIEW_TARGETS.phone, distanceM: 1.5 });
    expect(vr.radiusM / phone.radiusM).toBeCloseTo(2.5, 9);
    expect(vr.paddingInlineM / phone.paddingInlineM).toBeCloseTo(2.5, 9);
  });

  it("grows by its padding around the content", () => {
    const chip = new ThreeChip({ target: VIEW_TARGETS.vr, distanceM: 1.5 });
    chip.setSize(0.3, 0.05);
    chip.mesh.geometry.computeBoundingBox();
    const box = chip.mesh.geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(0.3 + 2 * chip.paddingInlineM, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(0.05 + 2 * chip.paddingBlockM, 6);
    expect(everyDescendantIsChrome(chip.group)).toBe(true);
  });
});

describe("ThreeChip in VR (8.4)", () => {
  it("fades in over 0.3 s", () => {
    const chip = new ThreeChip({ target: VIEW_TARGETS.vr, distanceM: 1.5 });
    expect(chip.presence).toBe(0);
    expect(chip.mesh.visible).toBe(false);
    chip.update(150, true);
    expect(chip.presence).toBeCloseTo(0.5);
    chip.update(150, true);
    expect(chip.presence).toBe(1);
  });

  it("does not flicker when the background alternates every 90 ms: presence stays at 1", () => {
    const chip = fadedIn(VIEW_TARGETS.vr);
    let wanted = false;
    for (let ms = 0; ms < 6000; ms += 90) {
      chip.update(90, wanted);
      wanted = !wanted;
      expect(chip.presence).toBe(1);
    }
  });

  it("holds at least 2 s after the last ask, then leaves over 0.4 s", () => {
    const chip = fadedIn(VIEW_TARGETS.vr);
    chip.update(1900, false);
    expect(chip.presence).toBe(1);
    chip.update(200, false);
    expect(chip.presence).toBeLessThan(1);
    chip.update(400, false);
    expect(chip.presence).toBe(0);
    expect(chip.mesh.visible).toBe(false);
  });

  it("is always present in AR, whatever the background asks", () => {
    const chip = new ThreeChip({ target: VIEW_TARGETS.questPassthrough, distanceM: 1.5 });
    chip.update(5000, false);
    expect(chip.presence).toBe(1);
  });
});
