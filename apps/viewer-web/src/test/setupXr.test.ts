import { afterEach, describe, expect, it } from "vitest";

import { installTestXrEnvironment, resolveXrTestMode } from "./setupXr";

const originalXrTestMode = process.env.XR_TEST_MODE;
const originalNavigatorXrDescriptor = Object.getOwnPropertyDescriptor(navigator, "xr");

function restoreNavigatorXr(): void {
  if (originalNavigatorXrDescriptor) {
    Object.defineProperty(navigator, "xr", originalNavigatorXrDescriptor);
    return;
  }

  delete (navigator as Navigator & { xr?: unknown }).xr;
}

afterEach(() => {
  if (typeof originalXrTestMode === "string") {
    process.env.XR_TEST_MODE = originalXrTestMode;
  } else {
    delete process.env.XR_TEST_MODE;
  }
  restoreNavigatorXr();
});

describe("setupXr", () => {
  it("uses iwer as the default public test mode", () => {
    delete process.env.XR_TEST_MODE;

    expect(resolveXrTestMode()).toBe("iwer");
  });

  it("installs nothing when XR_TEST_MODE is off", () => {
    delete (navigator as Navigator & { xr?: unknown }).xr;
    process.env.XR_TEST_MODE = "off";

    installTestXrEnvironment();

    expect("xr" in navigator).toBe(false);
  });

  it("installs the internal stub when XR_TEST_MODE is iwer", async () => {
    delete (navigator as Navigator & { xr?: unknown }).xr;
    process.env.XR_TEST_MODE = "iwer";

    installTestXrEnvironment();

    expect("xr" in navigator).toBe(true);
    await expect(navigator.xr?.isSessionSupported("immersive-ar")).resolves.toBe(true);
    await expect(navigator.xr?.requestSession("immersive-ar")).rejects.toThrow(
      "XR session stubbed for tests. Use dedicated mock hooks for deterministic flows."
    );
  });
});
