import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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

function isSymlinkTo(relativePath, relativeTarget) {
  const linkPath = path.join(rootDir, relativePath);
  const targetPath = path.join(rootDir, relativeTarget);
  return (
    existsSync(linkPath) &&
    existsSync(targetPath) &&
    lstatSync(linkPath).isSymbolicLink() &&
    realpathSync(linkPath) === realpathSync(targetPath)
  );
}

// Codex and Claude Code share one source of truth; see "Agent configuration" in AGENTS.md.
function checkAgentConfigParity() {
  if (!isSymlinkTo(".claude/skills", ".agents/skills")) {
    reporter.fail(".claude/skills must be a symlink to ../.agents/skills (add skills under .agents/skills).");
  }

  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "CLAUDE.md", "**/CLAUDE.md", ":!.agents/**", ":!.claude/**"],
    { cwd: rootDir, encoding: "utf8" }
  );
  for (const claudeFile of new Set(listed.stdout.split("\n").filter(Boolean))) {
    const agentsFile = path.join(path.dirname(claudeFile), "AGENTS.md");
    if (!isSymlinkTo(claudeFile, agentsFile)) {
      reporter.fail(`${claudeFile} must be a symlink to the adjacent AGENTS.md (edit ${agentsFile} instead).`);
    }
  }

  const claudeServers = Object.keys(JSON.parse(readFileSync(path.join(rootDir, ".mcp.json"), "utf8")).mcpServers ?? {});
  const codexToml = readFileSync(path.join(rootDir, ".codex/config.toml"), "utf8");
  const codexServers = [...codexToml.matchAll(/^\[mcp_servers\.([\w-]+)\]/gm)].map((match) => match[1]);
  for (const name of claudeServers.filter((server) => !codexServers.includes(server))) {
    reporter.fail(`MCP server "${name}" is in .mcp.json but missing from .codex/config.toml.`);
  }
  for (const name of codexServers.filter((server) => !claudeServers.includes(server))) {
    reporter.fail(`MCP server "${name}" is in .codex/config.toml but missing from .mcp.json.`);
  }
}

// Instructions drift from the code silently (a package renamed, a command
// moved). Every `--filter <name>` in a tracked instruction or doc file must
// name a workspace package; archives record history and are skipped.
function checkInstructionFilters() {
  const packages = new Set();
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(rootDir, group))) {
      const manifest = path.join(rootDir, group, entry, "package.json");
      if (existsSync(manifest)) packages.add(JSON.parse(readFileSync(manifest, "utf8")).name);
    }
  }
  const listed = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md", ":!**/archive/**", ":!.agents/skills/gstack/**", ":!**/node_modules/**"],
    { cwd: rootDir, encoding: "utf8" }
  );
  for (const file of new Set(listed.stdout.split("\n").filter(Boolean))) {
    if (!existsSync(path.join(rootDir, file)) || lstatSync(path.join(rootDir, file)).isSymbolicLink()) continue;
    const lines = readFileSync(path.join(rootDir, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/--filter[= ](@holoim\/[\w-]+)/g)) {
        if (!packages.has(match[1])) {
          reporter.fail(`${file}:${index + 1} filters on ${match[1]}, which is not a workspace package; fix the line to the real name.`);
        }
      }
    });
  }
}

// The pre-push hook (scripts/hooks/pre-push-checks.mjs) is installed through core.hooksPath.
function checkPrePushHook() {
  const read = () => spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: rootDir, encoding: "utf8" }).stdout.trim();
  let configured = read();
  if (configured !== "scripts/hooks/git") {
    // Self-heal (an app-created worktree may carry an absolute override), then re-read.
    spawnSync(process.execPath, [path.resolve(rootDir, "scripts/hooks/install.mjs")], { cwd: rootDir, stdio: "ignore" });
    configured = read();
  }
  if (configured !== "scripts/hooks/git") {
    reporter.fail(`Pre-push hook is not installed (core.hooksPath is "${configured || "unset"}"); run "pnpm run hooks:install".`);
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
  checkNodeVersion(reporter, 24);
  checkCommand(reporter, "git");
  checkCommand(reporter, "pnpm");
  checkPnpmVersion();

  checkPathExists(reporter, rootDir, "apps/capture/package.json");
  checkPathExists(reporter, rootDir, "apps/viewer-api/package.json");
  checkPathExists(reporter, rootDir, "apps/viewer-web/package.json");
  checkPathExists(reporter, rootDir, "apps/viewer-api/.env", "apps/viewer-api/.env (run `pnpm run hooks:install` to create it from .env.example)");

  checkPackageManagerAlignment();
  checkAgentConfigParity();
  checkInstructionFilters();
  checkPrePushHook();
  await checkPorts();

  printDoctorResult(reporter, "workspace");
}

await main();
