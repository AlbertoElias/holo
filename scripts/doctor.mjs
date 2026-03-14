import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  canBindPort,
  checkCommand,
  checkNodeVersion,
  checkPathExists,
  createDoctorReporter,
  printDoctorResult
} from "@holoim/tooling-scripts/doctor-core";

const rootDir = process.cwd();
const reporter = createDoctorReporter();

function checkPnpmVersion() {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    reporter.fail("Unable to read pnpm version.");
    return;
  }

  const [majorRaw] = result.stdout.trim().split(".");
  const major = Number(majorRaw);
  if (!Number.isFinite(major) || major < 10) {
    reporter.fail(`pnpm 10+ is required. Current: ${result.stdout.trim()}`);
  }
}

function checkPackageManagerAlignment() {
  const rootPackageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const rootPackageManager = String(rootPackageJson.packageManager ?? "");
  if (!rootPackageManager.startsWith("pnpm@")) {
    reporter.fail(`Root packageManager must be pnpm. Found: ${rootPackageManager || "(missing)"}`);
  }
}

async function checkPorts() {
  const checks = [
    { label: "viewer-api", port: 3001 },
    { label: "viewer-web", port: 3174 },
    { label: "capture-mock-vr", port: 5174 }
  ];

  for (const check of checks) {
    const probe = await canBindPort("127.0.0.1", check.port);
    if (!probe.ok && probe.reason === "in_use") {
      reporter.warn(`Port ${check.port} (${check.label}) is currently in use.`);
    }
  }
}

async function main() {
  checkNodeVersion(reporter, 20);
  checkCommand(reporter, "git");
  checkCommand(reporter, "pnpm");
  checkPnpmVersion();

  checkPathExists(reporter, rootDir, "apps/capture/package.json");
  checkPathExists(reporter, rootDir, "apps/viewer-api/package.json");
  checkPathExists(reporter, rootDir, "apps/viewer-web/package.json");
  checkPathExists(reporter, rootDir, "apps/viewer-api/.env", "apps/viewer-api/.env (copy from .env.example)");

  checkPackageManagerAlignment();
  await checkPorts();

  printDoctorResult(reporter, "workspace");
}

await main();
