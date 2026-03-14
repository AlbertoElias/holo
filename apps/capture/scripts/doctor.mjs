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

async function main() {
  checkNodeVersion(reporter, 20);
  checkCommand(reporter, "pnpm");
  checkPathExists(reporter, rootDir, "public/models/avatar.glb");
  checkPathExists(reporter, rootDir, "public/models/scene.glb");
  checkPathExists(reporter, rootDir, "scripts/ci-mock-vr-playwright.mjs");

  await checkPorts();

  printDoctorResult(reporter, "capture");
}

await main();
