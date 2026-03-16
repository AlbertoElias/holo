const PUBLIC_XR_TEST_MODES = new Set(['iwer', 'off']);
const XR_TEST_MODE_ALIASES = new Map([
  ['polyfill', 'iwer'],
  ['shim', 'iwer']
]);

export const XR_CHROMIUM_ARGS = Object.freeze(['--use-gl=angle', '--use-angle=swiftshader']);
export const XR_CONTEXT_OPTIONS = Object.freeze({ ignoreHTTPSErrors: true });

export function resolveXrTestMode(rawMode = process.env.XR_TEST_MODE) {
  const normalized = String(rawMode ?? 'iwer').toLowerCase();
  if (PUBLIC_XR_TEST_MODES.has(normalized)) {
    return normalized;
  }
  return XR_TEST_MODE_ALIASES.get(normalized) ?? 'iwer';
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

  return { mode: 'iwer' };
}
