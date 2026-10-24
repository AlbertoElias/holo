import { describe, expect, it } from "vitest";

import {
  CAPTURE_HALO_ACTIONS,
  CHROME_FLAG,
  HALO_CLOSED,
  HALO_DIRECTIONS,
  HELD_IDLE,
  haloDirectionOf,
  haloLayout,
  heldMarkTrigger,
  isChrome,
  isInChrome,
  markChromeTree,
  stepHalo,
  stepHeldMode,
  type ChromeObjectLike,
  type HaloEvent,
  type HaloStep,
  type HeldModeEvent,
  type HeldModeStep
} from "./index.js";

// Failure cases: a Halo flick is read as a drag; the Halo and the held mark
// share a trigger; the held mode gets stuck on when the release is lost on
// tracking loss or blur; releasing a held trigger fires select at whatever
// its ray hits; a held mark on hands is confused with an ordinary pinch;
// chrome is exported in the GLB or becomes a pointing referent.

describe("Halo directions (Q20)", () => {
  it("has eight fixed directions, and capture's first Halo fills S, W and E", () => {
    const layout = haloLayout(CAPTURE_HALO_ACTIONS, { headset: false });
    expect(layout.slots.map((slot) => slot.direction)).toEqual([...HALO_DIRECTIONS]);
    expect(Object.fromEntries(layout.slots.map((slot) => [slot.direction, slot.action]))).toEqual({
      n: null, ne: null, e: "redo", se: null, s: "record", sw: null, w: "undo", nw: null
    });
  });

  it("puts N up and E right, at the same places whatever is available", () => {
    const empty = haloLayout([], { headset: false });
    const full = haloLayout(CAPTURE_HALO_ACTIONS, { headset: false });
    expect(empty.slots.map(({ x, y }) => [x, y])).toEqual(full.slots.map(({ x, y }) => [x, y]));
    const north = full.slots[0]!;
    const east = full.slots[2]!;
    expect(north.x).toBeCloseTo(0, 10);
    expect(north.y).toBeCloseTo(full.radiusApx, 10);
    expect(east.x).toBeCloseTo(full.radiusApx, 10);
  });

  it("keeps neighbouring slots one glyph gap apart, 2.5× in a headset", () => {
    for (const headset of [false, true]) {
      const layout = haloLayout([], { headset });
      const [a, b] = layout.slots;
      expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeCloseTo(headset ? 90 + 30 : 36 + 12, 6);
    }
  });

  it("snaps a movement to the nearest direction, and nothing inside the dead zone", () => {
    expect(haloDirectionOf(0, 40, 18)).toBe("n");
    expect(haloDirectionOf(30, 32, 18)).toBe("ne");
    expect(haloDirectionOf(-40, -3, 18)).toBe("w");
    expect(haloDirectionOf(10, -10, 18)).toBeNull();
  });
});

describe("Halo interaction", () => {
  const layout = haloLayout(CAPTURE_HALO_ACTIONS, { headset: false });
  const run = (events: HaloEvent[]) => {
    let state = HALO_CLOSED;
    const steps: HaloStep[] = [];
    for (const event of events) {
      const step = stepHalo(state, event, layout);
      steps.push(step);
      state = step.state;
    }
    return steps;
  };

  it("commits a flick without drawing the ring", () => {
    const steps = run([{ type: "press", atMs: 0 }, { type: "move", atMs: 60, dx: -50, dy: 0 }, { type: "release", atMs: 120 }]);
    expect(steps.some((step) => step.ringDrawn)).toBe(false);
    expect(steps.at(-1)!.commit).toEqual({ direction: "w", action: "undo", flick: true });
  });

  it("draws the ring after the hold delay for a novice, then commits on release", () => {
    const steps = run([{ type: "press", atMs: 0 }, { type: "tick", atMs: 299 }, { type: "tick", atMs: 300 }, { type: "move", atMs: 800, dx: 0, dy: -60 }, { type: "release", atMs: 900 }]);
    expect(steps[1]!.ringDrawn).toBe(false);
    expect(steps[2]!.ringDrawn).toBe(true);
    expect(steps[3]!.highlighted).toBe("s");
    expect(steps.at(-1)!.commit).toEqual({ direction: "s", action: "record", flick: false });
  });

  it("does nothing for an empty direction, a release in the dead zone, or a cancel", () => {
    expect(run([{ type: "press", atMs: 0 }, { type: "move", atMs: 50, dx: 0, dy: 60 }, { type: "release", atMs: 90 }]).at(-1)!.commit)
      .toEqual({ direction: "n", action: null, flick: true });
    expect(run([{ type: "press", atMs: 0 }, { type: "move", atMs: 50, dx: 4, dy: 3 }, { type: "release", atMs: 90 }]).at(-1)!.commit).toBeNull();
    expect(run([{ type: "press", atMs: 0 }, { type: "move", atMs: 50, dx: 60, dy: 0 }, { type: "cancel" }, { type: "release", atMs: 90 }]).map((step) => step.commit)).toEqual([null, null, null, null]);
  });
});

describe("held mode", () => {
  const run = (events: HeldModeEvent[]) => {
    let state = HELD_IDLE;
    const steps: HeldModeStep[] = [];
    for (const event of events) {
      const step = stepHeldMode(state, event);
      steps.push(step);
      state = step.state;
    }
    return steps;
  };

  it("starts on hold, ends on release and consumes that release", () => {
    const steps = run([{ type: "press", source: "mouse:2", atMs: 0, delayMs: 0 }, { type: "release", source: "mouse:2", atMs: 500 }]);
    expect(steps[0]!.started).toBe(true);
    expect(steps[1]).toMatchObject({ ended: "release", consumeRelease: true, state: { phase: "idle" } });
  });

  it("ends on tracking loss and swallows the stale release when the hand comes back", () => {
    const steps = run([
      { type: "press", source: "left:trigger", atMs: 0, delayMs: 0 },
      { type: "trackingLost", source: "left:trigger" },
      { type: "release", source: "left:trigger", atMs: 900 },
      { type: "release", source: "left:trigger", atMs: 1900 }
    ]);
    expect(steps[1]).toMatchObject({ ended: "trackingLost", state: { phase: "idle" } });
    expect(steps[2]!.consumeRelease).toBe(true);
    expect(steps[3]!.consumeRelease).toBe(false);
  });

  it("ends on blur", () => {
    const steps = run([{ type: "press", source: "touch:1", atMs: 0, delayMs: 0 }, { type: "blur" }, { type: "release", source: "touch:1", atMs: 50 }]);
    expect(steps[1]!.ended).toBe("blur");
    expect(steps[2]!.consumeRelease).toBe(true);
  });

  it("waits out the hold delay for touch-and-hold, and a scroll or a tap never starts it", () => {
    const hold = run([{ type: "press", source: "touch:1", atMs: 0, delayMs: 300 }, { type: "tick", atMs: 299 }, { type: "tick", atMs: 300 }]);
    expect(hold.map((step) => step.started)).toEqual([false, false, true]);
    const scroll = run([{ type: "press", source: "touch:1", atMs: 0, delayMs: 300 }, { type: "move", source: "touch:1", distanceApx: 30 }, { type: "tick", atMs: 400 }]);
    expect(scroll.some((step) => step.started)).toBe(false);
    const tap = run([{ type: "press", source: "touch:1", atMs: 0, delayMs: 300 }, { type: "release", source: "touch:1", atMs: 120 }]);
    expect(tap[1]).toMatchObject({ started: false, ended: null, consumeRelease: false });
  });

  it("ignores another source's release", () => {
    const steps = run([{ type: "press", source: "left:thumbMiddle", atMs: 0, delayMs: 0 }, { type: "release", source: "right:thumbIndex", atMs: 50 }]);
    expect(steps[1]).toMatchObject({ consumeRelease: false, state: { phase: "held" } });
  });

  it("holds the mark on the non-dominant thumb–middle pinch, never the ordinary pinch, and on its own triggers (Q21)", () => {
    expect(heldMarkTrigger("hands", "right")).toEqual({ input: "hands", hand: "left", pinch: "thumbMiddle" });
    expect(heldMarkTrigger("hands", "left")).toMatchObject({ hand: "right" });
    expect(heldMarkTrigger("controllers", "right")).toEqual({ input: "controllers", hand: "left", button: "trigger" });
    expect(heldMarkTrigger("mouse", "right")).toEqual({ input: "mouse", button: "right" });
    expect(heldMarkTrigger("touch", "right")).toEqual({ input: "touch", on: "referent", delayMs: 300 });
  });
});

describe("chrome flag", () => {
  const node = (children: ChromeObjectLike[] = []): ChromeObjectLike => {
    const object: ChromeObjectLike = { userData: {}, parent: null, children };
    for (const child of children) child.parent = object;
    return object;
  };

  it("marks a whole subtree, and a hit on a child is in chrome", () => {
    const leaf = node();
    const root = markChromeTree(node([node([leaf])]));
    expect(isChrome(root)).toBe(true);
    expect(isChrome(leaf)).toBe(true);
    expect(leaf.userData[CHROME_FLAG]).toBe(true);
    const unmarkedChild = node();
    unmarkedChild.parent = root;
    expect(isChrome(unmarkedChild)).toBe(false);
    expect(isInChrome(unmarkedChild)).toBe(true);
  });

  it("leaves the hologram's own objects unmarked", () => {
    expect(isInChrome(node())).toBe(false);
    expect(isChrome(null)).toBe(false);
  });
});
