import {
  canBindPort,
  checkCommand,
  checkNodeVersion,
  checkPathExists,
  createDoctorReporter,
  printDoctorResult
} from "@holoim/tooling-scripts/doctor-core";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const reporter = createDoctorReporter();

async function checkPorts() {
  const preferredHost = process.env.DEV_HOST ?? "127.0.0.1";
  const preferredPort = Number(process.env.DEV_PORT ?? "5174");
  let hasAvailablePort = false;
  let hasProbeError = false;

  for (let port = preferredPort; port < preferredPort + 20; port += 1) {
    const probe = await canBindPort(preferredHost, port);
    if (probe.ok) {
      hasAvailablePort = true;
      break;
    }
    if (probe.reason === "probe_error") {
      hasProbeError = true;
    }
  }

  if (!hasAvailablePort) {
    if (hasProbeError) {
      reporter.warn(`Unable to probe port availability on ${preferredHost}:${preferredPort}-${preferredPort + 19} in this environment.`);
    } else {
      reporter.fail(`No available port in ${preferredHost}:${preferredPort}-${preferredPort + 19} for mock VR checks.`);
    }
  }

  const devPortProbe = await canBindPort(preferredHost, 5173);
  if (!devPortProbe.ok && devPortProbe.reason === "in_use") {
    reporter.warn("Port 5173 is in use; local dev may auto-increment or require explicit --port override.");
  }
}

function checkOptionalKtxCommand() {
  const result = spawnSync("bash", ["-lc", "command -v ktx"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    reporter.warn("Optional command 'ktx' is unavailable; GLTF builds will skip the highest-quality KTX2 texture compression path.");
  }
}

async function main() {
  checkNodeVersion(reporter, 24);
  checkCommand(reporter, "pnpm");
  checkOptionalKtxCommand();
  checkPathExists(reporter, rootDir, "public/gltf/models/avatar.glb");
  checkPathExists(reporter, rootDir, "public/gltf/models/scene.glb");
  checkPathExists(reporter, rootDir, "scripts/ci-mock-vr-playwright.ts");

  await checkPorts();

  printDoctorResult(reporter, "capture");
}

await main();
