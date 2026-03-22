import { describe, expect, it } from "vitest";

import { createArImmersiveActions, resolveArShellNoticeState, type ArImmersiveAction } from "./index.js";

describe("resolveArShellNoticeState", () => {
  it("maps bubble failures and native depth occlusion warnings", () => {
    expect(resolveArShellNoticeState({
      bubbleStatus: "missing-bubble",
      depthOcclusionEnabled: false,
      isNativeRuntime: true
    })).toEqual({
      bubbleWarning: "Bubble effect unavailable for this hologram.",
      depthOcclusionWarning: "Native AR session active, but depth occlusion is unavailable on this device."
    });
  });

  it("omits warnings when the AR shell is healthy", () => {
    expect(resolveArShellNoticeState({
      bubbleStatus: "enabled",
      depthOcclusionEnabled: true,
      isNativeRuntime: false
    })).toEqual({
      bubbleWarning: null,
      depthOcclusionWarning: null
    });
  });
});

describe("createArImmersiveActions", () => {
  it("keeps the AR exit/recenter button labels and order", () => {
    const actions = createArImmersiveActions({
      onExit: () => undefined,
      onRecenter: () => undefined
    });

    expect(actions.map((action: ArImmersiveAction) => action.id)).toEqual(["exit", "recenter"]);
    expect(actions.map((action: ArImmersiveAction) => action.label)).toEqual(["Exit AR", "Recenter Model"]);
    expect(actions.map((action: ArImmersiveAction) => action.tone)).toEqual(["danger", "ghost"]);
  });
});
