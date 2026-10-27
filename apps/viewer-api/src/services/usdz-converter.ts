import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONVERSION_TIMEOUT_MS = 120_000;
// Bump whenever conversion changes: new uploads store a new versioned package,
// and scripts/rebuild-usdz.ts moves stored ones onto it (ql3: the baked cloche).
export const USDZ_CONVERTER_VERSION = "ql3";
/** Earlier versions a stored hologram may still hold, until the rebuild moves it on. */
const PREVIOUS_USDZ_VERSIONS = ["ql2"];
const lifecycleLocks = new Map<string, Promise<unknown>>();
const MAX_ACTIVE_CONVERSIONS = 2;
const MAX_PENDING_CONVERSIONS = 8;
let activeConversions = 0;
const waitingConversions: Array<() => void> = [];

// Serialize publication, database updates, and deletion for one upload. Failed
// operations release the lock so the original GLB can be retried.
export async function withHologramLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  lifecycleLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (lifecycleLocks.get(key) === current) lifecycleLocks.delete(key);
  }
}

async function withConversionSlot(operation: () => Promise<void>): Promise<void> {
  if (activeConversions >= MAX_ACTIVE_CONVERSIONS) {
    if (waitingConversions.length >= MAX_PENDING_CONVERSIONS) throw new Error("Quick Look conversion queue is full.");
    await new Promise<void>((resolve) => waitingConversions.push(resolve));
  } else {
    activeConversions += 1;
  }
  try {
    await operation();
  } finally {
    const next = waitingConversions.shift();
    if (next) next();
    else activeConversions -= 1;
  }
}
// Works from src (tsx), from the compiled dist tree, and in the container.
export function resolveToolPath(name: string): string {
  const candidates = [
    path.join(import.meta.dirname, "..", "..", "tools", name),
    path.join(import.meta.dirname, "..", "..", "..", "tools", name),
    path.join(process.cwd(), "apps/viewer-api/tools", name),
    path.join(process.cwd(), "tools", name)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

const SCRIPT_PATH = resolveToolPath("glb_to_usdz.py");

export function usdzFilenameFor(glbFilename: string): string {
  return glbFilename.replace(/\.glb$/i, `-${USDZ_CONVERTER_VERSION}.usdz`);
}

/** Every preview name a hologram may have stored, current first: deletion removes them all. */
export function usdzFilenamesFor(glbFilename: string): string[] {
  return [USDZ_CONVERTER_VERSION, ...PREVIOUS_USDZ_VERSIONS].map((version) => glbFilename.replace(/\.glb$/i, `-${version}.usdz`));
}

export type ConversionOptions = {
  /** The hologram's id: its cloche's burns (styleguide 3.4, Q10), the same as on the web. */
  seed?: string;
};

/**
 * True when a conversion died only because it ran out of wall-clock time:
 * the Python converter's 100 s alarm (its message rides on stderr), or the
 * 120 s process deadline killing it (ETIMEDOUT / SIGTERM). Such failures say
 * the CPU was slow, not that the GLB is bad, so callers retry them later.
 */
export function isUsdzConversionTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; signal?: unknown; killed?: unknown; message?: unknown; stderr?: unknown };
  if (candidate.code === "ETIMEDOUT") return true;
  if (candidate.killed === true && candidate.signal === "SIGTERM") return true;
  const text = [candidate.message, candidate.stderr].filter((part): part is string => typeof part === "string").join("\n");
  return /exceeded \d+ seconds|ETIMEDOUT|timed?\s?out/i.test(text);
}

async function hasConversion(filename: string): Promise<boolean> {
  try {
    const info = await stat(filename);
    return info.isFile() && info.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runConversion(glbAbsolutePath: string, usdzAbsolutePath: string, { seed }: ConversionOptions): Promise<void> {
  if (await hasConversion(usdzAbsolutePath)) return;
  // Keep incomplete packages private, then publish atomically after success.
  const temporaryPath = path.join(path.dirname(usdzAbsolutePath), `.${randomUUID()}.usdz`);
  try {
    await execFileAsync(process.env.USDZ_PYTHON ?? "python3", [SCRIPT_PATH, glbAbsolutePath, temporaryPath, ...(seed ? ["--seed", seed] : [])], {
      timeout: CONVERSION_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      cwd: process.cwd()
    });
    if (!(await hasConversion(temporaryPath))) throw new Error("USDZ converter produced no package.");
    await rename(temporaryPath, usdzAbsolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function convertGlbToUsdz(
  glbAbsolutePath: string,
  usdzAbsolutePath: string,
  options: ConversionOptions = {}
): Promise<void> {
  if (await hasConversion(usdzAbsolutePath)) return;
  await withConversionSlot(() => runConversion(glbAbsolutePath, usdzAbsolutePath, options));
}
