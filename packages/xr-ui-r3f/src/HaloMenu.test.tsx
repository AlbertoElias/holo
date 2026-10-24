// Styleguide 6.2; brief Q20, Q21: eight fixed directions, a ring after the hold
// delay, a flick that commits without drawing, empty directions reserved.
import { tokens } from "@holoim/design-tokens";
import { CAPTURE_HALO_ACTIONS, haloLayout, type HaloCommit, type HaloDirection, type HaloStep } from "@holoim/xr-ui-core";
import { createRef, type ReactNode, type RefObject } from "react";
import { type Mesh, type Object3D, type PlaneGeometry } from "three";
import { describe, expect, it, vi } from "vitest";

import { HaloMenu, type HaloMenuHandle } from "./HaloMenu.js";
import { hexOf, meshesOf, mount, nonChrome, watchDispose } from "./testHelpers.js";

const DISTANCE = 1.5;
const LAYOUT = haloLayout(CAPTURE_HALO_ACTIONS, { headset: true });
/** A movement well outside the centre, in the direction, in apx (y up). */
const OUT = LAYOUT.radiusApx;

const VECTORS: Record<HaloDirection, [number, number]> = {
  n: [0, OUT],
  ne: [OUT, OUT],
  e: [OUT, 0],
  se: [OUT, -OUT],
  s: [0, -OUT],
  sw: [-OUT, -OUT],
  w: [-OUT, 0],
  nw: [-OUT, OUT]
};

function menu(ref: RefObject<HaloMenuHandle>, onCommit: (commit: HaloCommit) => void, props: Partial<Parameters<typeof HaloMenu>[0]> = {}): ReactNode {
  return <HaloMenu ref={ref} actions={CAPTURE_HALO_ACTIONS} distanceM={DISTANCE} onCommit={onCommit} {...props} />;
}

function ring(scene: Object3D): Mesh {
  return scene.getObjectByName("halo-ring") as Mesh;
}

/** Press, move out in the direction, release: a flick, all inside the hold delay. */
function flick(handle: HaloMenuHandle, direction: HaloDirection): HaloStep[] {
  const [dx, dy] = VECTORS[direction];
  return [handle.handle({ type: "press", atMs: 0 }), handle.handle({ type: "move", atMs: 40, dx, dy }), handle.handle({ type: "release", atMs: 80 })];
}

describe("HaloMenu: directions (6.2)", () => {
  it("commits Undo on a flick west and never draws the ring", async () => {
    const ref = createRef<HaloMenuHandle>();
    const onCommit = vi.fn();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, onCommit));
    const scene = renderer.scene.instance;
    const handle = ref.current!;
    const seenDrawn: boolean[] = [ring(scene).visible];
    const [dx, dy] = VECTORS.w;
    handle.handle({ type: "press", atMs: 0 });
    seenDrawn.push(ring(scene).visible);
    handle.handle({ type: "move", atMs: 40, dx, dy });
    seenDrawn.push(ring(scene).visible);
    const release = handle.handle({ type: "release", atMs: 80 });
    seenDrawn.push(ring(scene).visible);
    expect(seenDrawn).toEqual([false, false, false, false]);
    expect(release.commit).toEqual({ direction: "w", action: "undo", flick: true });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ direction: "w", action: "undo", flick: true });
    await renderer.unmount();
  });

  it.each([
    ["s", "record"],
    ["e", "redo"],
    ["w", "undo"]
  ] as const)("commits %s as %s", async (direction, action) => {
    const ref = createRef<HaloMenuHandle>();
    const onCommit = vi.fn();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, onCommit));
    flick(ref.current!, direction);
    expect(onCommit).toHaveBeenCalledWith({ direction, action, flick: true });
    await renderer.unmount();
  });

  it.each(["n", "ne", "se", "sw", "nw"] as const)("does not call onCommit for %s, an empty direction reserved for later (Q20)", async (direction) => {
    const ref = createRef<HaloMenuHandle>();
    const onCommit = vi.fn();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, onCommit));
    const steps = flick(ref.current!, direction);
    // The core still reports the direction; the component only acts on an action.
    expect(steps[2]!.commit).toEqual({ direction, action: null, flick: true });
    expect(onCommit).not.toHaveBeenCalled();
    await renderer.unmount();
  });

  it("commits nothing when released in the centre or cancelled", async () => {
    const ref = createRef<HaloMenuHandle>();
    const onCommit = vi.fn();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, onCommit));
    const handle = ref.current!;
    handle.handle({ type: "press", atMs: 0 });
    handle.handle({ type: "release", atMs: 80 });
    handle.handle({ type: "press", atMs: 100 });
    handle.handle({ type: "move", atMs: 120, dx: -OUT, dy: 0 });
    handle.handle({ type: "cancel" });
    expect(onCommit).not.toHaveBeenCalled();
    await renderer.unmount();
  });
});

describe("HaloMenu: the ring (6.2 'A press held 300 ms draws the ring')", () => {
  it("draws the ring after the hold delay, hides it on release, and still commits", async () => {
    const ref = createRef<HaloMenuHandle>();
    const onCommit = vi.fn();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, onCommit));
    const scene = renderer.scene.instance;
    const handle = ref.current!;
    handle.handle({ type: "press", atMs: 0 });
    handle.handle({ type: "tick", atMs: tokens.motion.hold.delay - 1 });
    expect(ring(scene).visible).toBe(false);
    handle.handle({ type: "tick", atMs: tokens.motion.hold.delay });
    expect(ring(scene).visible).toBe(true);
    handle.handle({ type: "move", atMs: 400, dx: 0, dy: -OUT });
    const release = handle.handle({ type: "release", atMs: 500 });
    expect(ring(scene).visible).toBe(false);
    expect(release.commit).toEqual({ direction: "s", action: "record", flick: false });
    expect(onCommit).toHaveBeenCalledWith({ direction: "s", action: "record", flick: false });
    await renderer.unmount();
  });

  it("converts metres in its plane to the apx a Halo event takes", async () => {
    const ref = createRef<HaloMenuHandle>();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, vi.fn()));
    const metres = tokens.size.radiansPerApx * DISTANCE * 10;
    expect(ref.current!.apxFromMetres(metres)).toBeCloseTo(10, 9);
    await renderer.unmount();
  });

  it("calls the latest onCommit", async () => {
    const ref = createRef<HaloMenuHandle>();
    const first = vi.fn();
    const second = vi.fn();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, first));
    await renderer.update(menu(ref as RefObject<HaloMenuHandle>, second));
    flick(ref.current!, "w");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await renderer.unmount();
  });
});

describe("HaloMenu: sizes, chrome flag and colour", () => {
  it("makes each slot's hit area at least the ray minimum", async () => {
    const ref = createRef<HaloMenuHandle>();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, vi.fn()));
    const hits = meshesOf(renderer.scene.instance).filter((mesh) => mesh.name === "glyph-hit");
    expect(hits).toHaveLength(CAPTURE_HALO_ACTIONS.length);
    const minimum = tokens.hit.ray * tokens.size.radiansPerApx * DISTANCE;
    for (const hit of hits) expect((hit.geometry as PlaneGeometry).parameters.width).toBeGreaterThanOrEqual(minimum - 1e-9);
    await renderer.unmount();
  });

  it("marks every object it mounts as chrome, again after every change of props and every event", async () => {
    const ref = createRef<HaloMenuHandle>();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, vi.fn()));
    const scene = renderer.scene.instance;
    expect(nonChrome(scene.getObjectByName("halo")!)).toEqual([]);
    ref.current!.handle({ type: "press", atMs: 0 });
    ref.current!.handle({ type: "tick", atMs: 400 });
    expect(nonChrome(scene.getObjectByName("halo")!)).toEqual([]);
    await renderer.update(menu(ref as RefObject<HaloMenuHandle>, vi.fn(), { input: "gazePinch", distanceM: 2, actions: ["record"] }));
    expect(nonChrome(scene.getObjectByName("halo")!)).toEqual([]);
    await renderer.unmount();
  });

  it("reads the ring back as the glyph token hex, never tone mapped", async () => {
    const ref = createRef<HaloMenuHandle>();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, vi.fn()));
    const scene = renderer.scene.instance;
    expect(hexOf(ring(scene).material as never)).toBe(tokens.glyph.color);
    for (const mesh of meshesOf(scene.getObjectByName("halo")!)) expect((mesh.material as { toneMapped: boolean }).toneMapped).toBe(false);
    await renderer.unmount();
  });

  it("disposes what it built when it unmounts", async () => {
    const ref = createRef<HaloMenuHandle>();
    const renderer = await mount(menu(ref as RefObject<HaloMenuHandle>, vi.fn()));
    const watches = meshesOf(renderer.scene.instance).flatMap((mesh) => [watchDispose(mesh.geometry), watchDispose(mesh.material as never)]);
    await renderer.unmount();
    expect(watches.length).toBeGreaterThan(6);
    expect(watches.every((watch) => watch.disposed)).toBe(true);
  });
});
