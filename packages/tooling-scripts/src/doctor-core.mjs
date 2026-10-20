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

// The workspace pins one Node major (engines.node, .nvmrc). Another major
// still runs most scripts, but pnpm then prints "Unsupported engine" on
// stdout and breaks scripts that parse it, so name the fix.
export function checkNodeVersion({ fail }, requiredMajor = 22) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== requiredMajor) {
    fail(
      `Node.js ${requiredMajor}.x is required (engines.node, .nvmrc). Current: ${process.versions.node} at ${process.execPath}. ` +
        `For this shell: eval "$(scripts/agent-node-env.sh)" (Claude Code sessions run it at start). ` +
        `Do not switch the machine-wide default Node; other sessions share it.`
    );
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
