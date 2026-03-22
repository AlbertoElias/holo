import type { Browser, BrowserContext, BrowserType, Page } from "@playwright/test";
import type { XrTestMode } from "@holoim/xr-runtime";

export type IwerRuntimeState = {
  hasIwerDevice: boolean;
  hasNavigatorXr: boolean;
  isSecureContext: boolean;
  origin: string;
  hasSem: boolean;
  trackedPlanesCount: number;
  trackedMeshesCount: number;
};

export type IwerSessionState = {
  environmentBlendMode: string | null;
  interactionMode: string | null;
  visibilityState: string | null;
  enabledFeatures: string[];
} | null;

export type IwerEnvironmentState = {
  hasSem: boolean;
  trackedPlanesCount: number;
  trackedMeshesCount: number;
};

export const XR_CHROMIUM_ARGS: readonly string[];
export const XR_CONTEXT_OPTIONS: Readonly<{ ignoreHTTPSErrors: true }>;

export function resolveXrTestMode(rawMode?: string): XrTestMode;
export function createXrLaunchOptions<T extends Record<string, unknown>>(overrides?: T): T & {
  headless: true;
  args: string[];
};
export function createXrContextOptions<T extends Record<string, unknown>>(overrides?: T): T & {
  ignoreHTTPSErrors: true;
};
export function launchXrBrowser(chromium: BrowserType, launchOptions?: Record<string, unknown>): Promise<Browser>;
export function createXrContext(browser: Browser, contextOptions?: Record<string, unknown>): Promise<BrowserContext>;
export function wireXrConsoleErrors(page: Page, sink: string[], options?: { label?: string }): void;
export function waitForPageFunctions(
  page: Page,
  functionNames: string[],
  options?: { timeout?: number; pollIntervalMs?: number }
): Promise<void>;
export function waitForTextContentPrefix(
  page: Page,
  selector: string,
  prefix: string,
  options?: { timeout?: number }
): Promise<void>;
export function readIwerRuntimeState(page: Page): Promise<IwerRuntimeState>;
export function waitForIwerRuntime(page: Page, options?: { timeout?: number }): Promise<IwerRuntimeState>;
export function readIwerSessionState(page: Page): Promise<IwerSessionState>;
export function waitForIwerSession(
  page: Page,
  options?: { timeout?: number; environmentBlendMode?: string }
): Promise<IwerSessionState>;
export function waitForNoIwerSession(page: Page, options?: { timeout?: number }): Promise<void>;
export function readIwerEnvironmentState(page: Page): Promise<IwerEnvironmentState>;
export function waitForIwerEnvironment(
  page: Page,
  options?: { timeout?: number; minTrackedPlanes?: number }
): Promise<IwerEnvironmentState>;
export function clickEnterXrButton(page: Page, buttonSelector: string, options?: { timeout?: number }): Promise<void>;
export function enterIwerSessionFromButton(
  page: Page,
  buttonSelector: string,
  options?: {
    timeout?: number;
    environmentBlendMode?: string;
    readyCheck?: string | ((...args: never[]) => boolean);
  }
): Promise<void>;
export function attachXrEnvironment(page: Page, options?: { mode?: string }): Promise<{ mode: XrTestMode }>;
