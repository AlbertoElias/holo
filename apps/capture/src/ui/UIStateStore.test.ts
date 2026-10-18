import { describe, expect, it } from "vitest";

import { UIStateStore } from "./UIStateStore";

describe("UIStateStore.publishMode", () => {
  it("publishes the AR mode with recenter guidance while an AR session presents", () => {
    const store = new UIStateStore();
    store.publishMode("ar");
    const state = store.getState();
    expect(state.mode).toBe("ar");
    expect(state.controls).toContain("Recenter AR");
  });

  it("keeps desktop guidance free of the AR recenter action", () => {
    const store = new UIStateStore();
    store.publishMode("desktop-third");
    const state = store.getState();
    expect(state.mode).toBe("desktop-third");
    expect(state.controls).not.toContain("Recenter AR");
  });
});
