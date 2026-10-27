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
const installedPages = new WeakSet();

/** True while the page's clock is paused by freezePageClock. */
export function isPageClockFrozen(page) {
  return frozenPages.has(page);
}

// Installs the fake clock before the page loads, running in real time until
// freezePageClock pauses it. Installed later, performance.now restarts from
// 0 under a running app, and a clock it already read (IWSDK's) takes one
// large negative frame delta: a playing hologram's clip time goes backwards.
export async function installPageClock(page) {
  if (installedPages.has(page)) return;
  await page.clock.install();
  installedPages.add(page);
}

// Lets the page's fake clock run in real time again (the feed after an XR
// session needs its own frames and timers).
export async function resumePageClock(page) {
  if (!frozenPages.has(page)) return;
  frozenPages.delete(page);
  await page.clock.resume();
}

export async function freezePageClock(page) {
  // A page is installed once; freezing it again (a second XR session after
  // resumePageClock) only pauses it.
  if (!installedPages.has(page)) {
    await page.clock.install();
    installedPages.add(page);
  }
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

// One emulated XR frame per stepXr frame, each `dtMs` of page time apart.
// 50 ms matches the viewer's locomotion step clamp, so a stepped frame moves
// the app as a slow real frame would, at a fraction of the draws.
export const XR_STEP_MS = 50;

const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Counts the active session's frames on the page, once per session.
async function readXrFrameCount(page) {
  return page.evaluate(() => {
    const session = window.IWER_DEVICE?.activeSession;
    if (!session) return null;
    if (window.__xrStepSession !== session) {
      window.__xrStepSession = session;
      window.__xrStepFrames = 0;
      const count = () => {
        window.__xrStepFrames += 1;
        if (window.__xrStepSession === session) session.requestAnimationFrame(count);
      };
      session.requestAnimationFrame(count);
    }
    return window.__xrStepFrames;
  });
}

/**
 * After freezePageClock and waitForXrRenderLoop: draws exactly `frames` XR
 * frames, each `dtMs` of page time after the last, so app time (IWSDK's clock
 * reads performance.now) and frames advance together and identically on
 * every run. fastForward fires each due timer once, so one step is one
 * animation frame with a `dtMs` delta, however long it takes to draw.
 *
 * Work outside the fake clock (fetch, GLB parsing, audio decode, workers)
 * still finishes in real time: wait for its completion signal before
 * stepping when a result depends on when it lands. A frame that is not
 * pending yet (its callback still awaits such work) is retried after a real
 * pause; `stats.late` counts those extra 16 ms page-time nudges.
 */
// With `untilSessionEnds`, stepping stops once the session has ended (an
// exit pressed on a frame), and fails if it is still running after `frames`.
export async function stepXr(page, frames = 1, options = {}) {
  const startedAt = Date.now();
  try {
    await stepXrFrames(page, frames, options);
  } finally {
    stepTotals.ms += Date.now() - startedAt;
  }
}

// Frames stepped, real ms spent stepping them, and late frames, over this
// process: what the stepped checks cost (read with xrStepTotals).
const stepTotals = { frames: 0, ms: 0, late: 0 };
export function xrStepTotals() {
  return { ...stepTotals };
}

async function stepXrFrames(page, frames, { dtMs = XR_STEP_MS, stats, untilSessionEnds = false }) {
  if (!frozenPages.has(page)) throw new Error('stepXr needs a page frozen by freezePageClock');
  let count = await readXrFrameCount(page);
  if (count === null) {
    if (untilSessionEnds) return;
    throw new Error('stepXr: no active XR session');
  }
  for (let frame = 0; frame < frames; frame += 1) {
    await page.clock.fastForward(dtMs);
    let next = await readXrFrameCount(page);
    if (next === null && untilSessionEnds) return;
    for (let retry = 0; next === count; retry += 1) {
      if (retry >= 200) throw new Error(`stepXr: no XR frame after ${retry} retries (at frame ${count})`);
      stepTotals.late += 1;
      if (stats) stats.late = (stats.late ?? 0) + 1;
      await realDelay(10);
      await page.clock.runFor(16);
      next = await readXrFrameCount(page);
    }
    if (next === null) {
      if (untilSessionEnds) return;
      throw new Error('stepXr: the XR session ended');
    }
    stepTotals.frames += next - count;
    if (stats) stats.frames = (stats.frames ?? 0) + (next - count);
    count = next;
  }
  if (untilSessionEnds) throw new Error(`stepXr: the XR session was still running after ${frames} frames`);
}

/**
 * Steps XR frames until `read()` returns a value `accept` takes, and returns
 * it (read before each step, so an already-true condition costs no frame).
 * Fails once both `maxFrames` frames and `realMs` of real time have passed:
 * frames bound app time, and the real-time floor leaves room for loads that
 * do not ride the fake clock.
 */
export async function stepXrUntil(page, read, accept, { maxFrames = 200, realMs = 15_000, dtMs = XR_STEP_MS, stats, describe } = {}) {
  const startedAt = Date.now();
  let last;
  for (let frame = 0; ; frame += 1) {
    last = await read();
    if (accept(last)) return last;
    if (frame >= maxFrames && Date.now() - startedAt >= realMs) {
      const detail = describe ? describe(last) : JSON.stringify(last);
      throw new Error(`stepXrUntil: not reached after ${frame} frames (${dtMs} ms each) and ${Date.now() - startedAt} ms real\nlast: ${detail}`);
    }
    await stepXr(page, 1, { dtMs, stats });
  }
}

/**
 * Calls the page's `window[name](...args)`, in-page work that waits on XR
 * frames (the IWER phone helpers' taps, drags and pinches), and steps one
 * frame at a time until its promise settles; returns its value. The settled
 * flag is read in the page before each step, so the same call takes the same
 * frames on every run.
 */
export async function stepXrCall(page, name, args = [], { maxFrames = 600, dtMs = XR_STEP_MS, stats } = {}) {
  await page.evaluate(({ name, args }) => {
    const task = { done: false, value: undefined, error: null };
    window.__xrStepTask = task;
    Promise.resolve()
      .then(() => window[name](...args))
      .then((value) => { task.value = value; }, (error) => { task.error = String(error?.message ?? error); })
      .finally(() => { task.done = true; });
  }, { name, args });
  const readTask = () => page.evaluate(() => {
    const { done, value, error } = window.__xrStepTask ?? { done: true, value: undefined, error: 'the page reloaded' };
    return { done, value, error };
  });
  for (let frame = 0; ; frame += 1) {
    const task = await readTask();
    if (task.done) {
      if (task.error !== null) throw new Error(`${name}: ${task.error}`);
      return task.value;
    }
    if (frame >= maxFrames) throw new Error(`stepXrCall(${name}): still pending after ${frame} frames`);
    await stepXr(page, 1, { dtMs, stats });
  }
}

/**
 * On a page running in real time: resolves once the active XR session has
 * delivered `count` more frames (or has ended), so input set before the call
 * has been read by the app's callback in each of those frames. A completion signal, unlike a sleep:
 * as fast as frames come, and never early on a slow runner.
 */
// `ended: true` also accepts a session that has already ended (input that
// exits, pressed in the frames before the call).
export async function waitForXrFrames(page, count = 2, { timeout = 30_000, ended = false } = {}) {
  await page.evaluate(({ count, timeout, ended }) => new Promise((resolve, reject) => {
    const session = window.IWER_DEVICE?.activeSession;
    if (!session) {
      if (ended) resolve();
      else reject(new Error('waitForXrFrames: no active XR session'));
      return;
    }
    let left = count;
    const done = () => {
      clearTimeout(timer);
      session.removeEventListener('end', done);
      resolve();
    };
    const timer = setTimeout(() => reject(new Error(`waitForXrFrames: ${left} of ${count} frames missing after ${timeout} ms`)), timeout);
    // Input that ends the session (an Exit press) has been read once it has ended.
    session.addEventListener('end', done);
    const tick = () => {
      left -= 1;
      if (left <= 0) done();
      else session.requestAnimationFrame(tick);
    };
    session.requestAnimationFrame(tick);
  }), { count, timeout, ended });
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

// cacheClearState: answer IWER's per-frame clear-state reads without a GL
// stall (see cacheWebGlClearState); opt-in for suites that step many frames.
export async function attachXrEnvironment(page, { mode, cacheClearState = false } = {}) {
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

  if (cacheClearState) await page.addInitScript(cacheWebGlClearState);
  return { mode: 'iwer' };
}

// IWER saves and restores the app's clear color, depth, and stencil around
// every emulated XR frame with gl.getParameter, and on software GL each of
// those reads stalls the pipeline (most of a frame's cost in replays). The
// values are plain context state that only clearColor/clearDepth/clearStencil
// change, so they are tracked here. What the GL stores for a given input
// (clamped or not, depending on context and extensions) is learned from one
// real read per distinct input and context, never assumed.
function cacheWebGlClearState() {
  const COLOR_CLEAR_VALUE = 0x0c22;
  const DEPTH_CLEAR_VALUE = 0x0b73;
  const STENCIL_CLEAR_VALUE = 0x0b91;
  const contexts = new WeakMap();
  const stateOf = (gl, getParameter) => {
    let state = contexts.get(gl);
    if (!state) {
      // Initial values, read once.
      state = {
        current: {
          [COLOR_CLEAR_VALUE]: getParameter.call(gl, COLOR_CLEAR_VALUE),
          [DEPTH_CLEAR_VALUE]: getParameter.call(gl, DEPTH_CLEAR_VALUE),
          [STENCIL_CLEAR_VALUE]: getParameter.call(gl, STENCIL_CLEAR_VALUE)
        },
        learned: new Map()
      };
      contexts.set(gl, state);
    }
    return state;
  };
  const remember = (gl, getParameter, pname, key) => {
    const state = stateOf(gl, getParameter);
    const learnedKey = `${pname}:${key}`;
    if (!state.learned.has(learnedKey)) state.learned.set(learnedKey, getParameter.call(gl, pname));
    state.current[pname] = state.learned.get(learnedKey);
  };
  for (const Context of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!Context) continue;
    const proto = Context.prototype;
    const { clearColor, clearDepth, clearStencil, getParameter } = proto;
    proto.clearColor = function (r, g, b, a) {
      stateOf(this, getParameter);
      const result = clearColor.call(this, r, g, b, a);
      remember(this, getParameter, COLOR_CLEAR_VALUE, `${r},${g},${b},${a}`);
      return result;
    };
    proto.clearDepth = function (depth) {
      stateOf(this, getParameter);
      const result = clearDepth.call(this, depth);
      remember(this, getParameter, DEPTH_CLEAR_VALUE, `${depth}`);
      return result;
    };
    proto.clearStencil = function (s) {
      stateOf(this, getParameter);
      const result = clearStencil.call(this, s);
      remember(this, getParameter, STENCIL_CLEAR_VALUE, `${s}`);
      return result;
    };
    proto.getParameter = function (pname) {
      if (pname === COLOR_CLEAR_VALUE || pname === DEPTH_CLEAR_VALUE || pname === STENCIL_CLEAR_VALUE) {
        const value = stateOf(this, getParameter).current[pname];
        return value instanceof Float32Array ? new Float32Array(value) : value;
      }
      return getParameter.call(this, pname);
    };
  }
}

// Runs worker(item, index) over items with at most `concurrency` in flight and
// returns the results in input order. Pages in simulation checks each run on
// their own frozen clock, so concurrency changes wall time, not results.
export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

// Fixture filter shared by the replay checks: XR_REPLAY_ONLY=<substring>
// (comma-separated for several) keeps only matching fixture names.
export function filterReplayFixtures(names, filter = process.env.XR_REPLAY_ONLY) {
  const needles = (filter ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (needles.length === 0) return names;
  const kept = names.filter((name) => needles.some((needle) => name.includes(needle)));
  if (kept.length === 0) throw new Error(`XR_REPLAY_ONLY=${filter} matched none of: ${names.join(', ')}`);
  return kept;
}
