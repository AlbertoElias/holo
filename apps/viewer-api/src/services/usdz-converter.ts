import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CONVERSION_TIMEOUT_MS = 120_000;

const conversionLocks = new Map<string, Promise<void>>();

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "tools",
  "glb_to_usdz.py"
);

async function runConversion(
  glbAbsolutePath: string,
  usdzAbsolutePath: string
): Promise<void> {
  await execFileAsync("python3", [SCRIPT_PATH, glbAbsolutePath, usdzAbsolutePath], {
    timeout: CONVERSION_TIMEOUT_MS,
    cwd: process.cwd(),
  });

  await access(usdzAbsolutePath);
}

export async function convertGlbToUsdz(
  lockKey: string,
  glbAbsolutePath: string,
  usdzAbsolutePath: string
): Promise<void> {
  const existing = conversionLocks.get(lockKey);
  if (existing) {
    await existing;
    return;
  }

  const promise = runConversion(glbAbsolutePath, usdzAbsolutePath).finally(() => {
    conversionLocks.delete(lockKey);
  });

  conversionLocks.set(lockKey, promise);
  await promise;
}
