import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XR_TEST_MODES = new Set(['polyfill', 'shim', 'off']);

function resolvePolyfillScriptPath() {
  const candidates = [
    'webxr-polyfill/build/webxr-polyfill.js',
    'webxr-polyfill/dist/webxr-polyfill.js'
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

const polyfillScriptPath = resolvePolyfillScriptPath();

export function resolveXrTestMode(rawMode = process.env.XR_TEST_MODE) {
  const normalized = String(rawMode ?? 'polyfill').toLowerCase();
  if (XR_TEST_MODES.has(normalized)) {
    return normalized;
  }
  return 'polyfill';
}

async function installXrShim(page) {
  await page.addInitScript(() => {
    if ('xr' in navigator) return;
    const xrStub = {
      isSessionSupported: async (mode) => mode === 'immersive-ar' || mode === 'immersive-vr',
      requestSession: async () => {
        throw new Error('XR session stubbed for automation. Use mock hooks for deterministic flows.');
      },
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      enumerable: true,
      value: xrStub
    });
  });
  return 'shim';
}

export async function attachXrEnvironment(page, { mode } = {}) {
  const resolvedMode = resolveXrTestMode(mode);
  if (resolvedMode === 'off') {
    return { mode: 'off' };
  }

  if (resolvedMode === 'polyfill' && polyfillScriptPath) {
    await page.addInitScript({ path: polyfillScriptPath });
    await page.addInitScript(() => {
      if ('xr' in navigator) return;
      const maybeCtor = globalThis.WebXRPolyfill;
      if (typeof maybeCtor !== 'function') return;
      try {
        globalThis.__webxrPolyfill = new maybeCtor({ allowCardboardOnDesktop: true });
      } catch {
        // Fallback shim may still run.
      }
    });
    await page.addInitScript(() => {
      if ('xr' in navigator) return;
      const xrStub = {
        isSessionSupported: async (sessionMode) => sessionMode === 'immersive-ar' || sessionMode === 'immersive-vr',
        requestSession: async () => {
          throw new Error('XR session stubbed for automation. Use mock hooks for deterministic flows.');
        },
        addEventListener: () => {},
        removeEventListener: () => {}
      };
      Object.defineProperty(navigator, 'xr', {
        configurable: true,
        enumerable: true,
        value: xrStub
      });
    });
    return { mode: 'polyfill', fallbackShim: !polyfillScriptPath };
  }

  const shimMode = await installXrShim(page);
  return { mode: shimMode, fallbackFromPolyfill: resolvedMode === 'polyfill' };
}
