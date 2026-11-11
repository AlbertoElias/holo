import { describe, expect, it } from "vitest";

import { CaptureHistory, MAX_HISTORY_ENTRIES, type HistoryEntry } from "./CaptureHistory";

/**
 * Regressions the independent verifier reproduced (docs/features/archive/undo-redo.md);
 * the e2e phases cover the rest of the history through the real Halo.
 *
 * 1. A redone entry jumped to the top: an open trace undone first (W prefers
 *    it), then redone, was undone again before the mark made inside it.
 * 2. The pre-take cap dropped a take's oldest entries, so an open trace left
 *    the history and W undid something newer.
 */
function entry(word: string, log: string[]): HistoryEntry {
  return { kind: "meaning", word, undo: () => (log.push(`undo ${word}`), true), redo: () => (log.push(`redo ${word}`), true) };
}

describe("CaptureHistory", () => {
  it("puts a redone entry back at its place in time", () => {
    const log: string[] = [];
    const history = new CaptureHistory();
    const trace = entry("Trace", log);
    history.push(trace);
    history.push(entry("Mark", log));
    expect(history.undo({ timeSec: 1 }, trace).text).toBe("Trace undone");
    expect(history.redo().text).toBe("Trace restored");
    expect(history.counts().words).toEqual(["Trace", "Mark"]);
    expect(history.undo({ timeSec: 2 }).text).toBe("Mark undone");
  });

  it("keeps every entry of a take, and caps only before one", () => {
    const log: string[] = [];
    const history = new CaptureHistory();
    history.capped = false;
    const trace = entry("Trace", log);
    history.push(trace);
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) history.push(entry("Size", log));
    expect(history.has(trace)).toBe(true);
    expect(history.undo({ timeSec: 1 }, trace).text).toBe("Trace undone");
    history.clear();
    history.capped = true;
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) history.push(entry("Size", log));
    expect(history.counts().done).toBe(MAX_HISTORY_ENTRIES);
  });
});
