import { describe, expect, it } from "vitest";

import { resolveArShellNoticeState } from "./index.js";

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
