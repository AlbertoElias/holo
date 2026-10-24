// Styleguide 1.2, 6.1, 7.3, 9.1; brief Q11: the non-dominant wrist's glyphs,
// in world space, glyphs only, reachable before placement.
import { apxToMeters, tokens } from "@holoim/design-tokens";
import { CONTROL_NAMES, nonDominantHand, type Hand, type Handedness } from "@holoim/xr-ui-core";
import type { ReactNode } from "react";
import { Euler, type Camera, type Mesh, Object3D, type PlaneGeometry, Quaternion } from "three";
import { describe, expect, it, vi } from "vitest";

import type { GlyphSpec } from "./internal.js";
import { CameraProbe, hexOf, hitByLabel, instanceOf, meshesOf, mount, nonChrome, watchDispose } from "./testHelpers.js";
import { WristControls, type WristControlsProps } from "./WristControls.js";

const ARM = tokens.placement.armReachM;

function glyphs(onSelect: () => void = () => undefined): GlyphSpec[] {
  return [
    { id: "play", label: CONTROL_NAMES.play, onSelect },
    { id: "free", label: "Free", onSelect },
    { id: "return", label: CONTROL_NAMES.returnToAuthorView, onSelect },
    { id: "record", label: CONTROL_NAMES.startRecording, onSelect }
  ];
}

function wristAt(x: number, y: number, z: number): Object3D {
  const wrist = new Object3D();
  wrist.position.set(x, y, z);
  wrist.updateMatrixWorld(true);
  return wrist;
}

function row(props: Partial<WristControlsProps> = {}, into: { camera?: Camera } = {}): ReactNode {
  return (
    <>
      <CameraProbe into={into} />
      <WristControls handedness="right" glyphs={glyphs()} input="poke" wrist={wristAt(0.2, 1.1, -0.3)} {...props} />
    </>
  );
}

function rootOf(scene: Object3D, hand: Hand): Object3D {
  const found = scene.getObjectByName(`wrist-glyphs-${hand}`);
  if (!found) throw new Error("no wrist row");
  return found;
}

describe("WristControls: handedness (failure case 'handedness read in one place and not another')", () => {
  it.each<[Handedness, Hand]>([
    ["right", "left"],
    ["left", "right"]
  ])("for a %s-handed person the row is on the %s hand", async (handedness, hand) => {
    const onHand = vi.fn();
    const renderer = await mount(row({ handedness, onHand }));
    expect(onHand).toHaveBeenCalledWith(hand);
    expect(hand).toBe(nonDominantHand(handedness));
    expect(rootOf(renderer.scene.instance, hand)).toBeDefined();
    await renderer.unmount();
  });

  it("reports the other hand when the setting changes", async () => {
    const onHand = vi.fn();
    const renderer = await mount(row({ handedness: "right", onHand }));
    await renderer.update(row({ handedness: "left", onHand }));
    expect(onHand).toHaveBeenLastCalledWith("right");
    await renderer.unmount();
  });
});

describe("WristControls: chrome flag", () => {
  it("marks every object it mounts as chrome, again after every change of props", async () => {
    const renderer = await mount(row());
    const scene = renderer.scene.instance;
    expect(nonChrome(rootOf(scene, "left"))).toEqual([]);
    await renderer.update(row({ glyphs: glyphs().map((g) => ({ ...g, recording: g.id === "record" })) }));
    expect(nonChrome(rootOf(scene, "left"))).toEqual([]);
    await renderer.update(row({ input: "ray", handedness: "left" }));
    expect(nonChrome(rootOf(scene, "right"))).toEqual([]);
    await renderer.update(row({ wrist: null }));
    expect(nonChrome(rootOf(scene, "left"))).toEqual([]);
    await renderer.unmount();
  });
});

describe("WristControls: hit areas (6.1)", () => {
  it("makes a poke hit area at least 20 mm and 72 apx, at arm's reach", async () => {
    const renderer = await mount(row({ input: "poke" }));
    const floor = tokens.hit.pokeFloorMm / 1000;
    const minimum = apxToMeters(tokens.hit.poke, ARM, { headset: false });
    for (const { label } of glyphs()) {
      const geometry = hitByLabel(renderer.scene.instance, label).geometry as PlaneGeometry;
      expect(geometry.parameters.width).toBeGreaterThanOrEqual(floor - 1e-9);
      expect(geometry.parameters.width).toBeGreaterThanOrEqual(minimum - 1e-9);
      expect(geometry.parameters.height).toBeGreaterThanOrEqual(floor - 1e-9);
    }
    await renderer.unmount();
  });

  it("makes a ray hit area at least 56 apx", async () => {
    const renderer = await mount(row({ input: "ray" }));
    const minimum = apxToMeters(tokens.hit.ray, ARM, { headset: false });
    for (const { label } of glyphs()) {
      expect((hitByLabel(renderer.scene.instance, label).geometry as PlaneGeometry).parameters.width).toBeGreaterThanOrEqual(minimum - 1e-9);
    }
    await renderer.unmount();
  });

  it("keeps pokeable neighbours 30 apx apart, hit area to hit area", async () => {
    const renderer = await mount(row({ input: "poke" }));
    const hits = glyphs().map(({ label }) => hitByLabel(renderer.scene.instance, label));
    const gap = apxToMeters(tokens.hit.pokeGap, ARM, { headset: false });
    for (let i = 1; i < hits.length; i += 1) {
      const a = hits[i - 1]!;
      const b = hits[i]!;
      const half = ((a.geometry as PlaneGeometry).parameters.width + (b.geometry as PlaneGeometry).parameters.width) / 2;
      expect(b.parent!.position.x - a.parent!.position.x - half).toBeGreaterThanOrEqual(gap - 1e-9);
    }
    await renderer.unmount();
  });
});

describe("WristControls: placement (1.2, 9.1)", () => {
  it("sits 4 cm above the back of the wrist and follows it, in world space", async () => {
    const wrist = wristAt(0.2, 1.1, -0.3);
    const renderer = await mount(row({ wrist }));
    await renderer.advanceFrames(1, 0.016);
    const group = rootOf(renderer.scene.instance, "left");
    expect(group.parent).toBe(renderer.scene.instance);
    expect(group.position.x).toBeCloseTo(0.2, 9);
    expect(group.position.y).toBeCloseTo(1.1 + tokens.placement.wristOffsetM, 9);
    expect(group.position.z).toBeCloseTo(-0.3, 9);

    wrist.position.set(-0.4, 0.9, -0.1);
    wrist.quaternion.setFromEuler(new Euler(0, Math.PI / 2, 0));
    wrist.updateMatrixWorld(true);
    await renderer.advanceFrames(1, 0.016);
    expect(group.position.x).toBeCloseTo(-0.4, 9);
    expect(group.quaternion.angleTo(new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0)))).toBeLessThan(1e-9);
    await renderer.unmount();
  });

  it("does not follow the head", async () => {
    const into: { camera?: Camera } = {};
    const renderer = await mount(row({}, into));
    await renderer.advanceFrames(1, 0.016);
    const group = rootOf(renderer.scene.instance, "left");
    const before = group.position.toArray();
    into.camera!.position.set(3, 1.7, 2);
    into.camera!.lookAt(0, 1, 0);
    into.camera!.updateMatrixWorld(true);
    await renderer.advanceFrames(3, 0.016);
    expect(group.position.toArray()).toEqual(before);
    await renderer.unmount();
  });

  it("hides, and gives up its hit areas, while the wrist is not tracked; returns when it is", async () => {
    const renderer = await mount(row({ wrist: null }));
    const group = rootOf(renderer.scene.instance, "left");
    const hit = hitByLabel(group, CONTROL_NAMES.play);
    expect(group.visible).toBe(false);
    // r3f raycasts ignore `visible`; an off layer is what keeps a hidden row from being poked at the origin.
    expect(hit.layers.test({ mask: 1 } as never)).toBe(false);
    await renderer.update(row({ wrist: wristAt(0, 1, 0) }));
    expect(group.visible).toBe(true);
    expect(hit.layers.test({ mask: 1 } as never)).toBe(true);
    await renderer.unmount();
  });
});

describe("WristControls: glyphs only (7.3 'No text within arm's reach')", () => {
  it("draws no label", async () => {
    const renderer = await mount(row());
    expect(meshesOf(renderer.scene.instance).filter((mesh) => mesh.name === "msdf-label")).toHaveLength(0);
    await renderer.unmount();
  });

  it("turns Record into the rose Stop shape while recording (8.5), the shape alone carrying the state", async () => {
    const renderer = await mount(row({ glyphs: glyphs().map((g) => ({ ...g, recording: g.id === "record" })) }));
    const meshes = meshesOf(renderer.scene.instance);
    const stop = meshes.find((mesh) => mesh.name === "glyph-recordStop");
    expect(stop).toBeDefined();
    expect(hexOf(stop!.material as never)).toBe(tokens.color.record);
    expect(meshes.some((mesh) => mesh.name === "glyph-recordIdle")).toBe(false);
    await renderer.update(row());
    expect(meshesOf(renderer.scene.instance).some((mesh) => mesh.name === "glyph-recordIdle")).toBe(true);
    await renderer.unmount();
  });
});

describe("WristControls: colour and controls", () => {
  it("reads back as token hexes and is never tone mapped", async () => {
    const renderer = await mount(row());
    const meshes = meshesOf(renderer.scene.instance);
    expect(hexOf(meshes.find((mesh) => mesh.name === "glyph-ring")!.material as never)).toBe(tokens.glyph.color);
    expect(hexOf(meshes.find((mesh) => mesh.name === "glyph-path")!.material as never)).toBe(tokens.glyph.color);
    for (const mesh of meshes) expect((mesh.material as { toneMapped: boolean }).toneMapped).toBe(false);
    await renderer.unmount();
  });

  it("names each hit mesh by its label, and a click on it selects", async () => {
    const select = vi.fn();
    const other = vi.fn();
    const renderer = await mount(
      row({
        glyphs: [
          { id: "record", label: CONTROL_NAMES.startRecording, onSelect: select },
          { id: "play", label: CONTROL_NAMES.play, onSelect: other }
        ]
      })
    );
    const hit: Mesh = hitByLabel(renderer.scene.instance, CONTROL_NAMES.startRecording);
    expect(hit.name).toBe(CONTROL_NAMES.startRecording);
    await renderer.fireEvent(instanceOf(hit), "click");
    expect(select).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    await renderer.unmount();
  });

  it("disposes what it built when it unmounts", async () => {
    const renderer = await mount(row());
    const watches = meshesOf(renderer.scene.instance).flatMap((mesh) => [watchDispose(mesh.geometry), watchDispose(mesh.material as never)]);
    await renderer.unmount();
    expect(watches.length).toBeGreaterThan(6);
    expect(watches.every((watch) => watch.disposed)).toBe(true);
  });
});
