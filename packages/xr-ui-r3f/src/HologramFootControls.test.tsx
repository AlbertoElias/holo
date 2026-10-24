// Styleguide 1.2, 5.2, 6, 6.1, 7.3, 9.2: the foot controls carry out the core
// contracts (chip opacity, hit areas, text distance) in hologram space.
import { apxToMeters, tokens, type HitInput } from "@holoim/design-tokens";
import { CONTROL_NAMES, VIEW_TARGETS, pausedText, type ViewTarget } from "@holoim/xr-ui-core";
import { act } from "@react-three/test-renderer";
import type { ReactNode } from "react";
import { type Camera, type Mesh, type Object3D, type PlaneGeometry } from "three";
import { describe, expect, it, vi } from "vitest";

import { HologramFootControls, type HologramFootControlsProps } from "./HologramFootControls.js";
import type { GlyphSpec, LabelFont } from "./internal.js";
import { CameraProbe, hexOf, hitByLabel, instanceOf, meshesOf, mount, named, nonChrome, testFont, watchDispose, type TestRenderer } from "./testHelpers.js";

const FONT: LabelFont = await testFont();
const UNLISTED_AR: ViewTarget = { kind: "ar", compositor: "unlisted", headset: false };
const DISTANCE = tokens.placement.worldPanelDefaultM;

function glyphs(onSelect: () => void = () => undefined): GlyphSpec[] {
  return [
    { id: "play", label: CONTROL_NAMES.play, onSelect },
    { id: "free", label: "Free", onSelect },
    { id: "return", label: CONTROL_NAMES.returnToAuthorView, onSelect },
    { id: "record", label: CONTROL_NAMES.startRecording, onSelect }
  ];
}

function hologram(props: Partial<HologramFootControlsProps>, into: { camera?: Camera } = {}): ReactNode {
  return (
    <>
      <CameraProbe into={into} />
      <group name="hologram" position={[1, 0, -2]}>
        <HologramFootControls target={VIEW_TARGETS.questPassthrough} glyphs={glyphs()} font={FONT} {...props} />
      </group>
    </>
  );
}

function root(renderer: TestRenderer): Object3D {
  return named(renderer.scene.instance, "foot-controls");
}

function chipMesh(renderer: TestRenderer): Mesh {
  const chip = meshesOf(root(renderer)).find((mesh) => mesh.name === "chip");
  if (!chip) throw new Error("no chip");
  return chip;
}

describe("HologramFootControls: chrome flag (brief Q-chrome, failure case 'chrome is exported')", () => {
  it("marks every object it mounts as chrome, again after every change of props", async () => {
    const renderer = await mount(hologram({ text: pausedText(8000) }));
    expect(nonChrome(root(renderer))).toEqual([]);
    // A new text, a recording glyph (Record turns into Stop: a new mesh), another list, another target, another input.
    await renderer.update(hologram({ text: pausedText(9000) }));
    expect(nonChrome(root(renderer))).toEqual([]);
    await renderer.update(hologram({ text: pausedText(9000), glyphs: glyphs().map((g) => ({ ...g, recording: g.id === "record" })) }));
    expect(nonChrome(root(renderer))).toEqual([]);
    await renderer.update(hologram({ glyphs: glyphs().slice(0, 2) }));
    expect(nonChrome(root(renderer))).toEqual([]);
    await renderer.update(hologram({ target: VIEW_TARGETS.vr, input: "gazePinch", distanceM: 2 }));
    expect(nonChrome(root(renderer))).toEqual([]);
    await renderer.unmount();
  });
});

describe("HologramFootControls: placement (1.2 'No interactive UI is locked to the head')", () => {
  it("stays in the hologram's space when the head moves, as a child of the hologram's own group", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(hologram({ position: [0, -0.3, 0.1] }, into));
    const controls = root(renderer);
    const hologramGroup = named(renderer.scene.instance, "hologram");
    expect(controls.parent).toBe(hologramGroup);
    const before = controls.getWorldPosition(controls.position.clone());
    expect(controls.position.toArray()).toEqual([0, -0.3, 0.1]);

    const camera = into.camera!;
    camera.position.set(4, 1.6, 3);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    await renderer.advanceFrames(3, 0.016);

    expect(controls.position.toArray()).toEqual([0, -0.3, 0.1]);
    expect(controls.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(controls.getWorldPosition(controls.position.clone()).toArray()).toEqual(before.toArray());
    await renderer.unmount();
  });

  it("is moved only by its hologram", async () => {
    const renderer = await mount(hologram({}));
    const hologramGroup = named(renderer.scene.instance, "hologram");
    hologramGroup.position.set(-3, 0, 2);
    hologramGroup.updateMatrixWorld(true);
    await renderer.advanceFrames(2, 0.016);
    const controls = root(renderer);
    expect(controls.getWorldPosition(controls.position.clone()).toArray()).toEqual([-3, 0, 2]);
    await renderer.unmount();
  });

  it("holds no controls in Quick Look, where no chip is possible (5.2)", async () => {
    const renderer = await mount(hologram({ target: VIEW_TARGETS.quickLook }));
    expect(renderer.scene.instance.getObjectByName("foot-controls")).toBeUndefined();
    await renderer.unmount();
  });
});

describe("HologramFootControls: hit areas (6.1)", () => {
  it.each<[HitInput, number]>([
    ["touch", 44],
    ["ray", 56],
    ["gazePinch", 72]
  ])("makes every glyph's hit mesh at least the %s minimum, %i apx, never scaled by the headset", async (input, apx) => {
    for (const target of [VIEW_TARGETS.questPassthrough, VIEW_TARGETS.vr, VIEW_TARGETS.androidChrome]) {
      const renderer = await mount(hologram({ target, input }));
      const minimum = apxToMeters(apx, DISTANCE, { headset: false });
      for (const { label } of glyphs()) {
        const geometry = hitByLabel(root(renderer), label).geometry as PlaneGeometry;
        expect(geometry.parameters.width).toBeGreaterThanOrEqual(minimum - 1e-9);
        expect(geometry.parameters.height).toBeGreaterThanOrEqual(minimum - 1e-9);
      }
      await renderer.unmount();
    }
  });

  it("never scales the input's minimum by the headset factor: a flat AR target's ray hit is exactly 56 apx, a headset's is its 2.5x ring", async () => {
    const quest = await mount(hologram({ target: VIEW_TARGETS.questPassthrough, input: "ray" }));
    const android = await mount(hologram({ target: VIEW_TARGETS.androidChrome, input: "ray" }));
    const width = (renderer: TestRenderer) => (hitByLabel(root(renderer), CONTROL_NAMES.play).geometry as PlaneGeometry).parameters.width;
    expect(width(android)).toBeCloseTo(apxToMeters(tokens.hit.ray, DISTANCE, { headset: false }), 9);
    // The drawn ring (90 apx in a headset) is larger than the minimum, so it rules there.
    expect(width(quest)).toBeCloseTo(apxToMeters(tokens.glyph.ring, DISTANCE, { headset: true }), 9);
    await quest.unmount();
    await android.unmount();
  });

  it("keeps neighbouring hit areas apart by the glyph gap (poke: at least 30 apx)", async () => {
    const renderer = await mount(hologram({ input: "poke" }));
    const hits = glyphs().map(({ label }) => hitByLabel(root(renderer), label));
    const gap = apxToMeters(tokens.hit.pokeGap, DISTANCE, { headset: false });
    for (let i = 1; i < hits.length; i += 1) {
      const a = hits[i - 1]!;
      const b = hits[i]!;
      const half = ((a.geometry as PlaneGeometry).parameters.width + (b.geometry as PlaneGeometry).parameters.width) / 2;
      const centres = b.parent!.position.x - a.parent!.position.x;
      expect(centres - half).toBeGreaterThanOrEqual(gap - 1e-9);
    }
    await renderer.unmount();
  });
});

describe("HologramFootControls: the chip (2.3, 5.2, 9.2)", () => {
  it.each<[string, ViewTarget, number]>([
    ["Quest passthrough", VIEW_TARGETS.questPassthrough, 0.97],
    ["Android Chrome", VIEW_TARGETS.androidChrome, 0.88],
    ["an unlisted AR target", UNLISTED_AR, 0.92]
  ])("is %s at its opacity, never opaque, in AR", async (_name, target, opacity) => {
    const renderer = await mount(hologram({ target }));
    await renderer.advanceFrames(2, 0.016);
    const material = chipMesh(renderer).material as Mesh["material"] & { opacity: number; transparent: boolean };
    expect(material.opacity).toBeCloseTo(opacity, 9);
    expect(material.opacity).toBeLessThan(1);
    expect(material.transparent).toBe(true);
    await renderer.unmount();
  });

  it("fades in over 0.3 s in VR, and a background that alternates every few frames never makes it flicker", async () => {
    let wanted = true;
    const renderer = await mount(hologram({ target: VIEW_TARGETS.vr, chipWanted: wanted }));
    expect(chipMesh(renderer).visible).toBe(false);
    await renderer.advanceFrames(30, 0.016);
    const chip = chipMesh(renderer);
    expect((chip.material as { opacity: number }).opacity).toBeCloseTo(tokens.chip.opacity.vr, 9);

    // Wavering at a threshold: a few frames asking, a few not, for several seconds.
    const seen = new Set<number>();
    for (let round = 0; round < 60; round += 1) {
      wanted = !wanted;
      await renderer.update(hologram({ target: VIEW_TARGETS.vr, chipWanted: wanted }));
      await renderer.advanceFrames(3, 0.016);
      expect(chip.visible).toBe(true);
      seen.add((chip.material as { opacity: number }).opacity);
    }
    expect([...seen]).toEqual([tokens.chip.opacity.vr]);
    await renderer.unmount();
  });

  it("holds at least 2 s after the background last asked, then leaves", async () => {
    const renderer = await mount(hologram({ target: VIEW_TARGETS.vr, chipWanted: true }));
    await renderer.advanceFrames(30, 0.016);
    await renderer.update(hologram({ target: VIEW_TARGETS.vr, chipWanted: false }));
    await renderer.advanceFrames(110, 0.016);
    expect(chipMesh(renderer).visible).toBe(true);
    await renderer.advanceFrames(60, 0.016);
    expect(chipMesh(renderer).visible).toBe(false);
    await renderer.unmount();
  });
});

describe("HologramFootControls: colour (failure case 'gold converted twice or tone-mapped')", () => {
  it("reads back as token hexes and is never tone mapped", async () => {
    const renderer = await mount(hologram({ text: pausedText(8000) }));
    const meshes = meshesOf(root(renderer));
    const byName = (name: string) => meshes.find((mesh) => mesh.name === name)!;
    expect(hexOf(chipMesh(renderer).material as never)).toBe(tokens.chip.color);
    expect(hexOf(byName("glyph-ring").material as never)).toBe(tokens.glyph.color);
    expect(hexOf(byName("glyph-path").material as never)).toBe(tokens.glyph.color);
    expect(hexOf(byName("glyph-recordIdle").material as never)).toBe(tokens.color.record);
    expect(hexOf(byName("msdf-label").material as never)).toBe(tokens.color.textMuted);
    for (const mesh of meshes) expect((mesh.material as { toneMapped: boolean }).toneMapped).toBe(false);
    await renderer.unmount();
  });
});

describe("HologramFootControls: controls (6)", () => {
  it("names each hit mesh by its label, and a click on it selects", async () => {
    const onSelect = vi.fn();
    const specs: GlyphSpec[] = [
      { id: "play", label: CONTROL_NAMES.play, onSelect },
      { id: "free", label: "Free", onSelect: vi.fn() }
    ];
    const renderer = await mount(hologram({ glyphs: specs }));
    const play = hitByLabel(root(renderer), CONTROL_NAMES.play);
    expect(play.name).toBe(CONTROL_NAMES.play);
    expect(play.userData.label).toBe(CONTROL_NAMES.play);
    await renderer.fireEvent(instanceOf(play), "click");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(specs[1]!.onSelect).not.toHaveBeenCalled();
    await renderer.unmount();
  });

  it("calls the latest onSelect, and renames the hit mesh when a label changes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const renderer = await mount(hologram({ glyphs: [{ id: "play", label: CONTROL_NAMES.play, onSelect: first }] }));
    await renderer.update(hologram({ glyphs: [{ id: "play", label: CONTROL_NAMES.pause, onSelect: second }] }));
    const hit = hitByLabel(root(renderer), CONTROL_NAMES.pause);
    expect(hit.name).toBe(CONTROL_NAMES.pause);
    await renderer.fireEvent(instanceOf(hit), "click");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await renderer.unmount();
  });

  it("brightens to the cream highlight on hover and dims to 55% when pressed (6 'States')", async () => {
    const renderer = await mount(hologram({}));
    const play = hitByLabel(root(renderer), CONTROL_NAMES.play);
    const shape = play.parent!.children.find((child) => child.name === "glyph-path") as Mesh;
    expect(hexOf(shape.material as never)).toBe(tokens.glyph.color);
    await renderer.fireEvent(instanceOf(play), "pointerOver");
    expect(hexOf(shape.material as never)).toBe(tokens.glyph.states.hoverColor);
    await renderer.fireEvent(instanceOf(play), "pointerDown");
    expect((shape.material as { opacity: number }).opacity).toBeCloseTo(tokens.glyph.states.pressedOpacity, 9);
    await renderer.fireEvent(instanceOf(play), "pointerUp");
    expect((shape.material as { opacity: number }).opacity).toBe(1);
    await renderer.fireEvent(instanceOf(play), "pointerOut");
    expect(hexOf(shape.material as never)).toBe(tokens.glyph.color);
    await renderer.unmount();
  });

  it("turns Record into the Stop shape while recording (8.5), in the same rose", async () => {
    const renderer = await mount(hologram({ glyphs: glyphs().map((g) => ({ ...g, recording: g.id === "record" })) }));
    const meshes = meshesOf(root(renderer));
    expect(meshes.some((mesh) => mesh.name === "glyph-recordStop")).toBe(true);
    expect(meshes.some((mesh) => mesh.name === "glyph-recordIdle")).toBe(false);
    const stop = meshes.find((mesh) => mesh.name === "glyph-recordStop")!;
    expect(hexOf(stop.material as never)).toBe(tokens.color.record);
    await renderer.unmount();
  });
});

describe("HologramFootControls: the timecode (7.3 'Within 1 m of a hologram')", () => {
  it("draws the text after the glyphs, in the timecode role's colour", async () => {
    const renderer = await mount(hologram({ text: pausedText(8000) }));
    const label = named(root(renderer), "label");
    expect(label.visible).toBe(true);
    const lastGlyph = hitByLabel(root(renderer), CONTROL_NAMES.startRecording).parent!;
    expect(label.position.x).toBeGreaterThan(lastGlyph.position.x);
    await renderer.unmount();
  });

  it("fades out within 1 m of the hologram in a headset, and returns beyond it; the glyphs stay", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(hologram({ text: pausedText(8000) }, into));
    const camera = into.camera!;
    const label = named(root(renderer), "label");
    const chip = chipMesh(renderer);
    const wide = (chip.geometry.boundingBox ?? (chip.geometry.computeBoundingBox(), chip.geometry.boundingBox))!.max.x;

    // The hologram sits at (1, 0, -2); stand 0.5 m from it.
    camera.position.set(1, 0, -1.5);
    camera.updateMatrixWorld(true);
    await renderer.advanceFrames(2, 0.016);
    expect(label.visible).toBe(false);
    expect(hitByLabel(root(renderer), CONTROL_NAMES.play).parent!.visible).toBe(true);
    chip.geometry.computeBoundingBox();
    // The chip hugs what is shown.
    expect(chip.geometry.boundingBox!.max.x).toBeLessThan(wide);

    camera.position.set(1, 0, 1.5);
    camera.updateMatrixWorld(true);
    await renderer.advanceFrames(2, 0.016);
    expect(label.visible).toBe(true);
    await renderer.unmount();
  });

  it("keeps the text on a phone in AR, which is not a headset", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(hologram({ target: VIEW_TARGETS.androidChrome, text: pausedText(8000) }, into));
    into.camera!.position.set(1, 0, -1.8);
    into.camera!.updateMatrixWorld(true);
    await renderer.advanceFrames(2, 0.016);
    expect(named(root(renderer), "label").visible).toBe(true);
    await renderer.unmount();
  });
});

describe("HologramFootControls: lifecycle", () => {
  it("disposes the geometries and materials it built when it unmounts", async () => {
    const renderer = await mount(hologram({ text: pausedText(8000) }));
    const meshes = meshesOf(root(renderer));
    const watches = meshes.flatMap((mesh) => [watchDispose(mesh.geometry), watchDispose(mesh.material as never)]);
    await renderer.unmount();
    expect(watches.length).toBeGreaterThan(8);
    expect(watches.every((watch) => watch.disposed)).toBe(true);
  });

  it("rebuilds the row when the glyph list changes, and keeps one root", async () => {
    const renderer = await mount(hologram({}));
    await renderer.update(hologram({ glyphs: glyphs().slice(0, 1) }));
    await act(async () => undefined);
    const roots: Object3D[] = [];
    renderer.scene.instance.traverse((object) => {
      if (object.name === "foot-controls") roots.push(object);
    });
    expect(roots).toHaveLength(1);
    expect(meshesOf(roots[0]!).filter((mesh) => mesh.userData.label)).toHaveLength(1);
    await renderer.unmount();
  });
});
