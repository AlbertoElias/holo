import { describe, expect, it } from "vitest";

import {
  readIwerRuntime,
  readXrCapabilities,
  resolveXrTestMode
} from "@holoim/xr-runtime";

function createTarget(overrides: Record<string, unknown> = {}): typeof globalThis {
  return {
    ...globalThis,
    ...overrides
  } as typeof globalThis;
}

describe("resolveXrTestMode", () => {
  it("normalizes the public test modes", () => {
    expect(resolveXrTestMode()).toBe("iwer");
    expect(resolveXrTestMode("off")).toBe("off");
    expect(resolveXrTestMode("iwer")).toBe("iwer");
  });

  it("maps legacy aliases to iwer", () => {
    expect(resolveXrTestMode("shim")).toBe("iwer");
    expect(resolveXrTestMode("polyfill")).toBe("iwer");
    expect(resolveXrTestMode("unknown")).toBe("iwer");
  });
});

describe("readIwerRuntime", () => {
  it("returns an empty snapshot when IWER is unavailable", () => {
    expect(readIwerRuntime(createTarget({ IWER_DEVICE: undefined }))).toEqual({
      available: false,
      pose: null,
      hasSem: false,
      trackedPlanes: null,
      trackedPlanesCount: 0,
      trackedMeshesCount: 0
    });
  });

  it("returns safe empty pose data for incomplete IWER state", () => {
    const trackedPlanes = new Set([{ orientation: "horizontal" }]);
    const snapshot = readIwerRuntime(createTarget({
      IWER_DEVICE: {
        sem: {
          trackedPlanes
        }
      }
    }));

    expect(snapshot.available).toBe(true);
    expect(snapshot.pose).toBeNull();
    expect(snapshot.trackedPlanes).toBe(trackedPlanes);
    expect(snapshot.trackedPlanesCount).toBe(1);
  });

  it("returns pose and SEM data when available", () => {
    const trackedPlanes = new Set([{ orientation: "horizontal", planeSpace: {} as XRSpace }]);
    const snapshot = readIwerRuntime(createTarget({
      IWER_DEVICE: {
        position: { x: 1, y: 2, z: 3 },
        quaternion: { x: 0, y: 0.5, z: 0, w: 0.5 },
        sem: {
          trackedPlanes,
          trackedMeshes: new Set([{}])
        }
      }
    }));

    expect(snapshot).toEqual({
      available: true,
      pose: {
        position: { x: 1, y: 2, z: 3 },
        quaternion: { x: 0, y: 0.5, z: 0, w: 0.5 }
      },
      hasSem: true,
      trackedPlanes,
      trackedPlanesCount: 1,
      trackedMeshesCount: 1
    });
  });
});

describe("readXrCapabilities", () => {
  it("does not infer IWER from navigator.xr alone", async () => {
    const capabilities = await readXrCapabilities({
      target: createTarget({
        navigator: {
          xr: {
            isSessionSupported: async () => true
          }
        } as unknown as Navigator
      })
    });

    expect(capabilities.hasNavigatorXr).toBe(true);
    expect(capabilities.supportsImmersiveAr).toBe(true);
    expect(capabilities.hasIwerRuntime).toBe(false);
    expect(capabilities.isNativeRuntime).toBe(true);
    expect(capabilities.shouldRequestDepthSensing).toBe(true);
    expect(capabilities.depthSensingEnabled).toBe(false);
  });

  it("disables native depth requests when IWER is active", async () => {
    const capabilities = await readXrCapabilities({
      target: createTarget({
        IWER_DEVICE: {},
        navigator: {
          xr: {
            isSessionSupported: async () => true
          }
        } as unknown as Navigator
      })
    });

    expect(capabilities.hasIwerRuntime).toBe(true);
    expect(capabilities.isNativeRuntime).toBe(false);
    expect(capabilities.shouldRequestDepthSensing).toBe(false);
  });

  it("detects native depth sensing from the active session", async () => {
    const session = {
      enabledFeatures: new Set(["depth-sensing", "hit-test"]),
      environmentBlendMode: "alpha-blend",
      depthUsage: "cpu-optimized",
      depthDataFormat: "luminance-alpha"
    } as unknown as XRSession;

    const capabilities = await readXrCapabilities({
      forceImmersiveArSupport: true,
      session,
      sessionMode: "immersive-ar",
      target: createTarget()
    });

    expect(capabilities.depthSensingEnabled).toBe(true);
    expect(capabilities.enabledFeatures).toContain("depth-sensing");
    expect(capabilities.sessionEnvironmentBlendMode).toBe("alpha-blend");
  });
});
