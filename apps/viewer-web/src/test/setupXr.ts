import WebXRPolyfill from "webxr-polyfill";

type XrTestMode = "polyfill" | "shim" | "off";

function resolveXrTestMode(): XrTestMode {
  const raw = String(process.env.XR_TEST_MODE ?? "polyfill").toLowerCase();
  if (raw === "polyfill" || raw === "shim" || raw === "off") {
    return raw;
  }
  return "polyfill";
}

function installShim(): void {
  if ("xr" in navigator) return;
  const xrStub = {
    isSessionSupported: async (mode: string) => mode === "immersive-ar" || mode === "immersive-vr",
    requestSession: async () => {
      throw new Error("XR session stubbed for tests. Use dedicated mock hooks for deterministic flows.");
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    enumerable: true,
    value: xrStub
  });
}

export function installTestXrEnvironment(): void {
  const mode = resolveXrTestMode();
  if (mode === "off") return;

  if (mode === "polyfill" && !("xr" in navigator)) {
    try {
      // Keep this test-only and avoid touching app runtime behavior.
      (globalThis as { __webxrPolyfill?: unknown }).__webxrPolyfill = new WebXRPolyfill({
        allowCardboardOnDesktop: true
      });
    } catch {
      installShim();
      return;
    }
  }

  if (!("xr" in navigator)) {
    installShim();
  }
}
