import { resolveXrTestMode } from '@holoim/xr-runtime';

export { resolveXrTestMode };

export const XR_CHROMIUM_ARGS = Object.freeze(['--use-gl=angle', '--use-angle=swiftshader']);
export const XR_CONTEXT_OPTIONS = Object.freeze({ ignoreHTTPSErrors: true });

// IWER clears and composites the full canvas on every device frame with a
// synchronous GL readback, so software-GL cost scales with pixel count. Checks
// that assert simulation state rather than pixels use a small canvas; set
// XR_TEST_VIEWPORT=1280x720 for readable failure screenshots.
export function resolveSimulationViewport(value = process.env.XR_TEST_VIEWPORT) {
  const match = /^(\d+)x(\d+)$/.exec(value ?? '');
  if (!match) return { width: 320, height: 180 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function createXrLaunchOptions(overrides = {}) {
  const { args = [], ...rest } = overrides;
  return {
    headless: true,
    ...rest,
    args: [...XR_CHROMIUM_ARGS, ...args]
  };
}

export function createXrContextOptions(overrides = {}) {
  return {
    ...XR_CONTEXT_OPTIONS,
    ...overrides
  };
}

// Pauses the page's timers and animation frames. Use only after the page and
// any XR session are ready, in flows that advance simulation time explicitly:
// IWER otherwise composites and GPU-syncs every frame, which saturates small
// CI runners without contributing to any assertion.
const frozenPages = new WeakSet();

export async function freezePageClock(page) {
  await page.clock.install();
  frozenPages.add(page);
  // The fake clock runs until paused, and one long task (shader compile,
  // XR session start) on a slow runner can carry it past the pause point.
  // Re-read the page's time and retry only for that specific error.
  for (let attempt = 0; ; attempt += 1) {
    const pageNow = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(new Date(pageNow + 1000));
      return;
    } catch (error) {
      if (attempt >= 4 || !String(error).includes('fast-forward to the past')) throw error;
    }
  }
}

// After freezePageClock: releases frames until the app's XR session renders
// steadily. three.js awaits gl.makeXRCompatible() — a real-time promise, not
// on the frozen clock — before it sets the session's base layer and starts its
// frame loop, and the first frames can still wait on real-time work, so this
// pauses in real time between releases until three consecutive releases each
// deliver XR frames. Run it while the app does not tick (manual clock), so the
// frames released here change nothing.
export async function waitForXrRenderLoop(page, { stepMs = 1000 / 30, maxSteps = 600, steadySteps = 3 } = {}) {
  await page.evaluate(() => {
    window.__xrFramesDelivered = 0;
    const session = window.IWER_DEVICE?.activeSession;
    const count = () => {
      window.__xrFramesDelivered += 1;
      session?.requestAnimationFrame(count);
    };
    session?.requestAnimationFrame(count);
  });
  let steady = 0;
  let last = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    await page.clock.runFor(stepMs);
    const { frames, ready } = await page.evaluate(() => ({
      frames: window.__xrFramesDelivered,
      ready: Boolean(window.IWER_DEVICE?.activeSession?.renderState?.baseLayer)
    }));
    steady = ready && frames > last ? steady + 1 : 0;
    last = frames;
    if (steady >= steadySteps) {
      await alignFrameClock(page);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The app never rendered XR frames steadily.');
}

// The frozen clock fires animation frames every 16 ms counted from when it
// was installed (in real time), and runFor rounds to whole milliseconds, so
// the frames that a sequence of 30 Hz steps releases depend on where the
// clock stands. Moving it to a multiple of 48 ms (three frames) before a
// replay makes every later step release the same frames on every run.
export async function alignFrameClock(page) {
  const ticks = await page.evaluate(() => performance.now());
  const offset = 48 - (Math.ceil(ticks) % 48);
  await page.clock.runFor(offset + (Math.ceil(ticks) - ticks));
}

// Screenshot for simulation checks. The small simulation canvas is mostly
// covered by IWER's DevUI, so it is enlarged for the capture, and a few frozen
// frames run so the page draws and IWER composites the current state. Pages
// under a manual app clock draw on those frames without advancing.
export async function captureXrScreenshot(page, screenshotPath, { timeout = 3_000 } = {}) {
  const simulationViewport = page.viewportSize();
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    if (frozenPages.has(page)) await page.clock.runFor(100);
    await page.screenshot({ path: screenshotPath, timeout });
  } finally {
    if (simulationViewport) await page.setViewportSize(simulationViewport).catch(() => undefined);
  }
}

export async function launchXrBrowser(chromium, launchOptions = {}) {
  return chromium.launch(createXrLaunchOptions(launchOptions));
}

export async function createXrContext(browser, contextOptions = {}) {
  return browser.newContext(createXrContextOptions(contextOptions));
}

export function wireXrConsoleErrors(page, sink, { label } = {}) {
  const prefix = label ? `${label} ` : '';
  page.on('pageerror', (error) => {
    sink.push(`${prefix}pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      sink.push(`${prefix}console.error: ${message.text()}`);
    }
  });
}

export async function waitForPageFunctions(page, functionNames, { timeout = 20000, pollIntervalMs = 250 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((names) => (
      names.every((name) => typeof window[name] === 'function')
    ), functionNames);
    if (ready) {
      return;
    }
    await page.waitForTimeout(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for page functions: ${functionNames.join(', ')}`);
}

export async function waitForTextContentPrefix(
  page,
  selector,
  prefix,
  { timeout = 20000 } = {}
) {
  await page.waitForFunction(
    ({ query, expectedPrefix }) => {
      const element = document.querySelector(query);
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const text = element.textContent?.trim().toLowerCase();
      return Boolean(text?.startsWith(expectedPrefix));
    },
    { query: selector, expectedPrefix: prefix.trim().toLowerCase() },
    { timeout }
  );
}

export async function readIwerRuntimeState(page) {
  return page.evaluate(() => ({
    hasIwerDevice: Boolean(window.IWER_DEVICE),
    hasNavigatorXr: 'xr' in navigator,
    isSecureContext: window.isSecureContext,
    origin: window.location.origin,
    hasSem: Boolean(window.IWER_DEVICE?.sem),
    trackedPlanesCount: window.IWER_DEVICE?.sem?.trackedPlanes?.size ?? 0,
    trackedMeshesCount: window.IWER_DEVICE?.sem?.trackedMeshes?.size ?? 0
  }));
}

export async function waitForIwerRuntime(page, { timeout = 10000 } = {}) {
  await page.waitForFunction(
    () => window.isSecureContext && Boolean(window.IWER_DEVICE && navigator.xr),
    null,
    { timeout }
  );
  return readIwerRuntimeState(page);
}

export async function readIwerSessionState(page) {
  return page.evaluate(() => {
    const session = window.IWER_DEVICE?.activeSession;
    if (!session) {
      return null;
    }

    return {
      environmentBlendMode: session.environmentBlendMode ?? null,
      interactionMode: session.interactionMode ?? null,
      visibilityState: session.visibilityState ?? null,
      enabledFeatures: Array.isArray(session.enabledFeatures)
        ? [...session.enabledFeatures]
        : Array.from(session.enabledFeatures ?? [])
    };
  });
}

export async function waitForIwerSession(page, { timeout = 10000, environmentBlendMode } = {}) {
  await waitForIwerRuntime(page, { timeout });
  await page.waitForFunction(
    (expectedBlendMode) => {
      const session = window.IWER_DEVICE?.activeSession;
      if (!session) {
        return false;
      }

      return expectedBlendMode ? session.environmentBlendMode === expectedBlendMode : true;
    },
    environmentBlendMode ?? null,
    { timeout }
  );
  return readIwerSessionState(page);
}

export async function waitForNoIwerSession(page, { timeout = 10000 } = {}) {
  await page.waitForFunction(() => !window.IWER_DEVICE?.activeSession, null, { timeout });
}

export async function readIwerEnvironmentState(page) {
  return page.evaluate(() => ({
    hasSem: Boolean(window.IWER_DEVICE?.sem),
    trackedPlanesCount: window.IWER_DEVICE?.sem?.trackedPlanes?.size ?? 0,
    trackedMeshesCount: window.IWER_DEVICE?.sem?.trackedMeshes?.size ?? 0
  }));
}

export async function waitForIwerEnvironment(page, { timeout = 10000, minTrackedPlanes = 1 } = {}) {
  await waitForIwerSession(page, { timeout });
  await page.waitForFunction(
    (minimumTrackedPlanes) => {
      const sem = window.IWER_DEVICE?.sem;
      if (!sem) {
        return false;
      }
      return (sem.trackedPlanes?.size ?? 0) >= minimumTrackedPlanes;
    },
    minTrackedPlanes,
    { timeout }
  );
  return readIwerEnvironmentState(page);
}

export async function clickEnterXrButton(page, buttonSelector, { timeout = 10000 } = {}) {
  await page.locator(buttonSelector).waitFor({ state: 'visible', timeout });
  await page.locator(buttonSelector).click();
}

export async function enterIwerSessionFromButton(
  page,
  buttonSelector,
  {
    timeout = 10000,
    environmentBlendMode,
    readyCheck
  } = {}
) {
  await clickEnterXrButton(page, buttonSelector, { timeout });
  await waitForIwerSession(page, { timeout, environmentBlendMode });
  if (readyCheck) {
    await page.waitForFunction(readyCheck, null, { timeout });
  }
}

export async function attachXrEnvironment(page, { mode } = {}) {
  const resolvedMode = resolveXrTestMode(mode);
  if (resolvedMode === 'off') {
    await page.addInitScript(() => {
      const currentUserAgent = navigator.userAgent;
      try {
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          get: () => `${currentUserAgent} OculusBrowser`
        });
      } catch {
        // Best effort only.
      }
    });
    return { mode: 'off' };
  }

  await page.addInitScript(cacheWebGlClearState);
  return { mode: 'iwer' };
}

// IWER saves and restores the app's clear color, depth, and stencil around
// every emulated XR frame with gl.getParameter, and on software GL each of
// those reads stalls the pipeline (most of a frame's cost in replays). The
// values are plain context state that only clearColor/clearDepth/clearStencil
// change, so they are tracked here and answered without the stall.
function cacheWebGlClearState() {
  const COLOR_CLEAR_VALUE = 0x0c22;
  const DEPTH_CLEAR_VALUE = 0x0b73;
  const STENCIL_CLEAR_VALUE = 0x0b91;
  const state = new WeakMap();
  const stateOf = (gl) => {
    let value = state.get(gl);
    if (!value) {
      value = { color: [0, 0, 0, 0], depth: 1, stencil: 0 };
      state.set(gl, value);
    }
    return value;
  };
  for (const Context of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!Context) continue;
    const proto = Context.prototype;
    const { clearColor, clearDepth, clearStencil, getParameter } = proto;
    proto.clearColor = function (r, g, b, a) {
      // Stored as the GL would: clamped to [0, 1] in single precision.
      stateOf(this).color = [r, g, b, a].map((v) => Math.fround(Math.min(1, Math.max(0, v))));
      return clearColor.call(this, r, g, b, a);
    };
    proto.clearDepth = function (depth) {
      stateOf(this).depth = Math.fround(Math.min(1, Math.max(0, depth)));
      return clearDepth.call(this, depth);
    };
    proto.clearStencil = function (s) {
      stateOf(this).stencil = s;
      return clearStencil.call(this, s);
    };
    proto.getParameter = function (pname) {
      if (pname === COLOR_CLEAR_VALUE) return new Float32Array(stateOf(this).color);
      if (pname === DEPTH_CLEAR_VALUE) return stateOf(this).depth;
      if (pname === STENCIL_CLEAR_VALUE) return stateOf(this).stencil;
      return getParameter.call(this, pname);
    };
  }
}
