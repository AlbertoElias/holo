import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function createDoctorReporter() {
  const failures = [];
  const warnings = [];

  return {
    failures,
    warnings,
    fail(message) {
      failures.push(message);
    },
    warn(message) {
      warnings.push(message);
    }
  };
}

export function checkNodeVersion({ fail }, minMajor = 20) {
  const [majorRaw] = process.versions.node.split(".");
  const major = Number(majorRaw);
  if (!Number.isFinite(major) || major < minMajor) {
    fail(`Node.js ${minMajor}+ is required. Current: ${process.versions.node}`);
  }
}

export function checkCommand({ fail }, commandName) {
  const result = spawnSync("bash", ["-lc", `command -v ${commandName}`], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    fail(`Missing required command: ${commandName}`);
  }
}

export function checkPathExists({ fail }, rootDir, relativePath, label = relativePath) {
  if (!existsSync(path.join(rootDir, relativePath))) {
    fail(`Missing required file: ${label}`);
  }
}

export function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        resolve({ ok: false, reason: "in_use" });
        return;
      }
      resolve({ ok: false, reason: "probe_error" });
    });
    server.listen({ host, port }, () => {
      server.close(() => resolve({ ok: true, reason: "available" }));
    });
  });
}

export function printDoctorResult({ failures, warnings }, scopeLabel) {
  for (const message of warnings) {
    console.warn(`[doctor:warn] ${message}`);
  }

  if (failures.length > 0) {
    for (const message of failures) {
      console.error(`[doctor:error] ${message}`);
    }
    process.exit(1);
  }

  console.log(`[doctor] ${scopeLabel} checks passed.`);
}
