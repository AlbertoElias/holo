// The cloche as a three.js object (styleguide 3.4). Its failure modes: a part
// not flagged as chrome (it would be exported or hit by rays), tone mapping
// or depth writes that dim or hide the event, an eye read in the wrong space
// once the hologram is placed and rescaled (AR), glass still drawn with the
// eye inside, the hologram's floor shade lost with it, and a dome drawn in a
// headset during a take.
import { VIEW_TARGETS, edgeFrame, fitCloche, type ClocheShape } from "@holoim/xr-ui-core";
import { Group, Vector3, type ShaderMaterial } from "three";
import { describe, expect, it } from "vitest";

import { ThreeCloche } from "./ThreeCloche.js";
import { everyDescendantIsChrome } from "./testing.js";

const shape = fitCloche([
  { x: 1, y: 0, z: -1 },
  { x: 3, y: 1.5, z: 1 }
]) as ClocheShape;
const soot = { groundLuminance: 0.02 };
const resting = edgeFrame(VIEW_TARGETS.desktop, { timeMs: 0, recording: false, inFocus: true, reducedMotion: true, soot });

function placed(): { cloche: ThreeCloche; parent: Group } {
  const cloche = new ThreeCloche({ seed: "town", shape });
  const parent = new Group();
  parent.position.set(10, 0, -4);
  parent.rotation.y = Math.PI / 3;
  parent.scale.setScalar(0.25);
  parent.add(cloche.group);
  cloche.group.position.set(shape.base.x, shape.base.y, shape.base.z);
  parent.updateWorldMatrix(true, true);
  return { cloche, parent };
}

describe("ThreeCloche (3.4)", () => {
  it("is chrome throughout, never tone-mapped, and writes no depth over the event", () => {
    const cloche = new ThreeCloche({ seed: "town", shape });
    expect(cloche.group.name).toBe("cloche");
    expect(everyDescendantIsChrome(cloche.group)).toBe(true);
    for (const mesh of [cloche.shell, cloche.shade]) {
      const material = mesh.material as ShaderMaterial;
      expect(material.toneMapped).toBe(false);
      expect(material.depthWrite).toBe(false);
    }
  });

  it("reads the eye in the hologram's own space once it is placed, turned and rescaled (AR)", () => {
    const { cloche, parent } = placed();
    const local = new Vector3(shape.base.x + 0.2, shape.base.y + 0.5, shape.base.z - 0.3);
    const world = parent.localToWorld(local.clone());
    const eye = cloche.eyeInShape(world);
    expect(eye.x).toBeCloseTo(local.x, 9);
    expect(eye.y).toBeCloseTo(local.y, 9);
    expect(eye.z).toBeCloseTo(local.z, 9);
  });

  it("is drawn from outside, and inside drops the glass but keeps the hologram's shade", () => {
    const { cloche, parent } = placed();
    const outside = parent.localToWorld(new Vector3(shape.base.x, shape.base.y + 1, shape.base.z + shape.radii.z * 4));
    cloche.update(resting, { eye: cloche.eyeInShape(outside), radiusPx: 200 });
    expect(cloche.group.visible).toBe(true);
    expect(cloche.shell.visible).toBe(true);
    expect((cloche.shell.material as ShaderMaterial).uniforms.uOpacity!.value).toBe(1);

    const inside = parent.localToWorld(new Vector3(shape.base.x, shape.base.y + 0.3, shape.base.z));
    cloche.update(resting, { eye: cloche.eyeInShape(inside), radiusPx: 200 });
    expect(cloche.shell.visible, "nothing of the glass between the viewer and the event").toBe(false);
    expect(cloche.group.visible).toBe(true);
    expect(cloche.shade.visible, "the floor shade is the hologram's, not the glass's").toBe(true);
  });

  it("draws nothing in a headset while recording (8.5)", () => {
    const cloche = new ThreeCloche({ seed: "town", shape });
    const recording = edgeFrame(VIEW_TARGETS.vr, { timeMs: 0, recording: true, inFocus: true, reducedMotion: false, soot });
    cloche.update(recording, { eye: { x: 0, y: 1, z: 20 }, radiusPx: 200 });
    expect(cloche.group.visible).toBe(false);
  });
});
