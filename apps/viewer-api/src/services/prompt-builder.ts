import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { env } from "../lib/env.js";

export type BuiltPromptTake = {
  glbBuffer: Buffer;
  sizeBytes: number;
  title: string;
  intent: string;
  durationSec: number;
  beatCount: number;
  hasVoice: boolean;
};

export type PromptBuildFn = (sheet: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<BuiltPromptTake>;

/** Locate `apps/capture` relative to this module (works in both src/ and dist/). */
function findCaptureDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../../capture"),
    path.resolve(here, "../../../capture"),
    path.resolve(process.cwd(), "../capture"),
    path.resolve(process.cwd(), "apps/capture")
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "scripts/authoring/direct.ts"))) {
      return dir;
    }
  }
  throw new Error("Could not locate apps/capture/scripts/authoring/direct.ts for prompt builds.");
}

function sheetMetadata(sheet: Record<string, unknown>): {
  title: string;
  intent: string;
  durationSec: number;
  beatCount: number;
  hasVoice: boolean;
} {
  const title = typeof sheet.title === "string" && sheet.title.trim() ? sheet.title.trim() : "AI Hologram";
  const intent = typeof sheet.intent === "string" && sheet.intent.trim() ? sheet.intent.trim() : "";
  const durationSec = typeof sheet.duration === "number" && Number.isFinite(sheet.duration) ? sheet.duration : 6;
  const beats = Array.isArray(sheet.beats) ? sheet.beats : [];
  const hasVoice = beats.some((b) => b && typeof b === "object" && "say" in b && Boolean((b as { say?: unknown }).say));
  return { title, intent, durationSec, beatCount: beats.length, hasVoice };
}

/**
 * Runs `apps/capture/scripts/authoring/direct.ts` in an isolated child process
 * so Three.js + Kokoro ONNX memory is reclaimed immediately on exit.
 */
export const buildPromptTakeWithDirect: PromptBuildFn = async (sheet, options) => {
  const captureDir = findCaptureDir();
  const workDir = await mkdtemp(path.join(tmpdir(), "holoim-prompt-"));
  const sheetPath = path.join(workDir, "sheet.json");
  const outPath = path.join(workDir, "take.glb");
  const timeoutMs = options?.timeoutMs ?? env.PROMPT_BUILD_TIMEOUT_MS;

  try {
    await writeFile(sheetPath, JSON.stringify(sheet, null, 2), "utf8");

    const { code, stderr, stdout } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        ["--conditions=development", "--import", "tsx", "scripts/authoring/direct.ts", sheetPath, "--out", outPath],
        {
          cwd: captureDir,
          env: {
            ...process.env,
            NODE_NO_WARNINGS: "1"
          },
          stdio: ["ignore", "pipe", "pipe"]
        }
      );

      let out = "";
      let err = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Hologram build timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (out.length < 32_768) out += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (err.length < 32_768) err += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ code: exitCode, stdout: out, stderr: err });
      });
    });

    if (code !== 0 || !existsSync(outPath)) {
      const detail = (stderr || stdout).trim().slice(0, 800);
      throw new Error(detail || `direct.ts exited with code ${code ?? "unknown"}`);
    }

    const [glbBuffer, info] = await Promise.all([readFile(outPath), stat(outPath)]);
    const meta = sheetMetadata(sheet);
    return {
      glbBuffer,
      sizeBytes: info.size,
      ...meta
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};
