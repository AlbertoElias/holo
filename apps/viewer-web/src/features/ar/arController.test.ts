import { describe, expect, it } from "vitest";

import type { XrCapabilities } from "@holoim/xr-runtime";

import {
  resolveArSupportMessage,
  resolveDepthOcclusionStatus,
  resolvePlacementPreviewStatus,
  shouldRetryArSessionEntry
} from "./arController";

function createCapabilities(overrides: Partial<XrCapabilities> = {}): XrCapabilities {
  return {
    hasNavigatorXr: true,
    supportsImmersiveAr: true,
    hasIwerRuntime: false,
    isNativeRuntime: true,
    shouldRequestDepthSensing: true,
    depthSensingEnabled: false,
    sessionMode: null,
    sessionEnvironmentBlendMode: null,
    enabledFeatures: [],
    ...overrides
  };
}

describe("resolveArSupportMessage", () => {
  it("returns a browser support error when navigator.xr is unavailable", () => {
    expect(resolveArSupportMessage(false, createCapabilities({
      hasNavigatorXr: false,
      supportsImmersiveAr: false,
      isNativeRuntime: false,
      shouldRequestDepthSensing: false
    }))).toMatch("WebXR is not supported");
  });
});

describe("shouldRetryArSessionEntry", () => {
  it("retries connectivity failures within the attempt budget", () => {
    expect(shouldRetryArSessionEntry("not connected to three.js yet", 1, 3)).toBe(true);
    expect(shouldRetryArSessionEntry("not connected to three.js yet", 3, 3)).toBe(false);
    expect(shouldRetryArSessionEntry("permission denied", 1, 3)).toBe(false);
  });
});

describe("resolvePlacementPreviewStatus", () => {
  it("uses plane-detected preview when IWER planes are present", () => {
    expect(resolvePlacementPreviewStatus(null, {
      available: true,
      pose: null,
      hasSem: true,
      trackedPlanes: new Set([{ orientation: "horizontal" }]),
      trackedPlanesCount: 1,
      trackedMeshesCount: 0
    }, false)).toEqual({
      stage: "placed",
      mode: "floor",
      reason: "plane-detected",
      anchored: false,
      sequence: 1
    });
  });

  it("falls back to visibility placement after timeout without planes", () => {
    expect(resolvePlacementPreviewStatus(null, {
      available: false,
      pose: null,
      hasSem: false,
      trackedPlanes: null,
      trackedPlanesCount: 0,
      trackedMeshesCount: 0
    }, true)).toEqual({
      stage: "placed",
      mode: "visibility-fallback",
      reason: "hit-test-timeout",
      anchored: false,
      sequence: 1
    });
  });
});

describe("resolveDepthOcclusionStatus", () => {
  it("disables depth occlusion for IWER runtime", () => {
    expect(resolveDepthOcclusionStatus(createCapabilities({
      hasIwerRuntime: true,
      isNativeRuntime: false,
      shouldRequestDepthSensing: false,
      sessionMode: "immersive-ar"
    }))).toEqual({
      enabled: false,
      reason: "iwer-runtime"
    });
  });

  it("enables depth occlusion for supported native sessions with depth sensing", () => {
    expect(resolveDepthOcclusionStatus(createCapabilities({
      depthSensingEnabled: true,
      sessionMode: "immersive-ar"
    }))).toEqual({
      enabled: true,
      reason: "active"
    });
  });
});
