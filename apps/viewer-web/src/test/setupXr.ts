import { resolveXrTestMode } from "@holoim/xr-runtime";

export { resolveXrTestMode } from "@holoim/xr-runtime";

function installIwerUnitTestStub(): void {
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

  // In e2e, XR_TEST_MODE=iwer means the localhost page gets a Vite-injected IWER runtime.
  // In jsdom unit tests, the same public mode installs an internal stub only.
  if (!("xr" in navigator)) {
    installIwerUnitTestStub();
  }
}
