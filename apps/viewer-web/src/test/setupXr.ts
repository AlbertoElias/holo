type XrTestMode = "shim" | "off";

function resolveXrTestMode(): XrTestMode {
  const raw = String(process.env.XR_TEST_MODE ?? "iwer").toLowerCase();
  if (raw === "off") {
    return "off";
  }
  return "shim";
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

  if (!("xr" in navigator)) {
    installShim();
  }
}
