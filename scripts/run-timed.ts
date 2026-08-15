import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

interface TimingResult {
  durationMs: number;
  finishedAt: string;
  label: string;
  startedAt: string;
  status: "failed" | "passed";
}

function parseArguments(argv: string[]): { command: string; args: string[]; label: string } {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex !== 1 || !argv[0] || !argv[2]) {
    throw new Error("Usage: pnpm timed <label> -- <command> [args...]");
  }

  return {
    label: argv[0],
    command: argv[2],
    args: argv.slice(3)
  };
}

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited via signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function writeResult(result: TimingResult): Promise<void> {
  const outputDir = path.resolve("output", "test-results");
  const safeLabel = result.label.replace(/[^a-zA-Z0-9_-]+/g, "-");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, `${safeLabel}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8"
  );

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const durationSeconds = (result.durationMs / 1000).toFixed(1);
    await appendFile(
      summaryPath,
      `| ${result.label} | ${result.status} | ${durationSeconds}s |\n`,
      "utf8"
    );
  }
}

async function main(): Promise<void> {
  const { args, command, label } = parseArguments(process.argv.slice(2));
  const startedAt = new Date();
  const started = performance.now();
  let exitCode = 1;

  try {
    exitCode = await run(command, args);
  } finally {
    const result: TimingResult = {
      label,
      status: exitCode === 0 ? "passed" : "failed",
      durationMs: Math.round(performance.now() - started),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString()
    };
    await writeResult(result);
    console.log(`[timing] ${label}: ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s`);
  }

  process.exitCode = exitCode;
}

void main();
