import { describe, expect, it } from "vitest";

import { PointSampleStore, type AimPointSample } from "./PointSampleStore";

/**
 * One Undo history for held marks and hand traces (PRD-023 v1, brief
 * "Undo and Redo"). The e2e proves trace undo and redo through the headset
 * Halo; no scripted take interleaves holds with traces, so the ordering rule
 * is tested here. Failure modes, each with its test below:
 *
 * 1. Undo takes the older entry: a hold began, then a trace, and Undo removes the hold.
 * 2. Undo takes the trace when a closed trace began before a later hold.
 * 3. Undo while tracing leaves the open trace and removes a hold begun inside it.
 * 4. Undo of a still-held mark keeps recording that hold's later samples.
 * 5. Redo puts an entry back at the end, so the next Undo takes the wrong one.
 * 6. A new hold or trace after Undo leaves Redo able to restore the undone entry.
 * 7. Undo or Redo with nothing to take throws or reports a kind.
 * 8. Undo or Redo while not recording changes the take.
 * 9. Stop leaves a trace open, so export sees an unbounded span.
 */

const aim = (timeSec: number, side: "left" | "right" = "right"): AimPointSample => ({
  timeSec,
  side,
  input: "hands",
  origin: { x: 0, y: 1.4, z: 0 },
  direction: { x: 0, y: 0, z: -1 }
});

function recording(): PointSampleStore {
  const store = new PointSampleStore();
  store.setEnabled(true);
  return store;
}

function hold(store: PointSampleStore, from: number, to: number): void {
  for (let t = from; t <= to + 1e-9; t += 0.25) store.recordAim(aim(t));
  store.endAim(to);
}

const holdStarts = (store: PointSampleStore): number[] => store.getAimHolds().map((h) => h.samples[0]!.timeSec);
const traceStarts = (store: PointSampleStore): number[] => store.getTraces().map((t) => t.startSec);

describe("PointSampleStore: one history for holds and traces", () => {
  it("1. Undo removes the trace that began after a hold", () => {
    const store = recording();
    hold(store, 1, 2);
    store.startTrace(3, "right");
    store.endTrace(5, "right");
    expect(store.undoLast(6)).toBe("trace");
    expect(traceStarts(store)).toEqual([]);
    expect(holdStarts(store)).toEqual([1]);
  });

  it("2. Undo removes the hold that began after a closed trace", () => {
    const store = recording();
    store.startTrace(1, "right");
    store.endTrace(3, "right");
    hold(store, 4, 5);
    expect(store.undoLast(6)).toBe("hold");
    expect(holdStarts(store)).toEqual([]);
    expect(traceStarts(store)).toEqual([1]);
  });

  it("3. Undo while tracing ends and removes the open trace, keeping a hold begun inside it", () => {
    const store = recording();
    store.startTrace(1, "right");
    hold(store, 2, 3);
    expect(store.undoLast(4)).toBe("trace");
    expect(store.openTrace()).toBeNull();
    expect(traceStarts(store)).toEqual([]);
    expect(holdStarts(store)).toEqual([2]);
    // The hold kept its own place in the history: the next Undo takes it.
    expect(store.undoLast(5)).toBe("hold");
    expect(holdStarts(store)).toEqual([]);
    expect(store.redoLast()).toBe("hold");
    // The undone trace was ended at the press, so Redo restores a bounded span.
    expect(store.redoLast()).toBe("trace");
    expect(store.getTraces()[0]).toMatchObject({ startSec: 1, endSec: 4 });
  });

  it("4. Undo of a still-held mark ends it at the press and drops the rest of that hold", () => {
    const store = recording();
    store.recordAim(aim(1));
    store.recordAim(aim(1.5));
    expect(store.undoLast(1.6)).toBe("hold");
    store.recordAim(aim(2));
    store.recordAim(aim(2.5));
    expect(store.getAimHolds()).toHaveLength(0);
    store.endAim(3);
    // After the release, a new hold records again.
    store.recordAim(aim(4));
    expect(holdStarts(store)).toEqual([4]);
  });

  it("5. Redo restores entries in the order they began, so Undo keeps taking the latest", () => {
    const store = recording();
    store.startTrace(1, "right");
    hold(store, 2, 3);
    store.undoLast(4); // the open trace goes, the hold inside it stays
    expect(store.redoLast()).toBe("trace");
    expect(traceStarts(store)).toEqual([1]);
    // The hold began after the trace, so it is the latest entry again.
    expect(store.undoLast(5)).toBe("hold");
    expect(store.undoLast(5)).toBe("trace");
    expect(store.undoLast(5)).toBeNull();
    expect(store.redoLast()).toBe("trace");
    expect(store.redoLast()).toBe("hold");
    expect(traceStarts(store)).toEqual([1]);
    expect(holdStarts(store)).toEqual([2]);
  });

  it("6. A new hold or trace after Undo clears what can be redone", () => {
    const store = recording();
    store.startTrace(1, "right");
    store.endTrace(2, "right");
    store.undoLast(3);
    store.startTrace(4, "left");
    store.endTrace(5, "left");
    expect(store.redoLast()).toBeNull();
    store.undoLast(6);
    hold(store, 7, 8);
    expect(store.redoLast()).toBeNull();
    expect(traceStarts(store)).toEqual([]);
    expect(holdStarts(store)).toEqual([7]);
  });

  it("7. Undo and Redo with nothing to take report null", () => {
    const store = recording();
    expect(store.undoLast(1)).toBeNull();
    expect(store.redoLast()).toBeNull();
  });

  it("8. Undo and Redo while not recording leave the take alone", () => {
    const store = recording();
    store.startTrace(1, "right");
    store.endTrace(2, "right");
    store.setEnabled(false);
    expect(store.undoLast(3)).toBeNull();
    expect(traceStarts(store)).toEqual([1]);
    expect(store.redoLast()).toBeNull();
    expect(store.startTrace(4, "right")).toBe(false);
  });

  it("9. Stop ends an open trace where the take ended", () => {
    const store = recording();
    store.startTrace(1, "right");
    store.noteTime(2.5);
    store.recordAim(aim(3));
    store.setEnabled(false);
    expect(store.getTraces()[0]).toMatchObject({ startSec: 1, endSec: 3 });
    expect(store.getAimHolds()[0]!.endSec).toBe(3);
  });
});
