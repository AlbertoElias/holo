import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONVERSION_TIMEOUT_MS = 120_000;
// Bump whenever conversion changes: existing uploads must not keep the old preview.
export const USDZ_CONVERTER_VERSION = "ql2";
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
const SCRIPT_PATH = path.join(import.meta.dirname, "..", "..", "tools", "glb_to_usdz.py");

export function usdzFilenameFor(glbFilename: string): string {
  return glbFilename.replace(/\.glb$/i, `-${USDZ_CONVERTER_VERSION}.usdz`);
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

async function runConversion(glbAbsolutePath: string, usdzAbsolutePath: string): Promise<void> {
  if (await hasConversion(usdzAbsolutePath)) return;
  // Keep incomplete packages private, then publish atomically after success.
  const temporaryPath = path.join(path.dirname(usdzAbsolutePath), `.${randomUUID()}.usdz`);
  try {
    await execFileAsync(process.env.USDZ_PYTHON ?? "python3", [SCRIPT_PATH, glbAbsolutePath, temporaryPath], {
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
  usdzAbsolutePath: string
): Promise<void> {
  if (await hasConversion(usdzAbsolutePath)) return;
  await withConversionSlot(() => runConversion(glbAbsolutePath, usdzAbsolutePath));
}
