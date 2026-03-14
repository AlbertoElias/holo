import { spawnSync } from "node:child_process";

export function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function runCapture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    return "";
  }

  return result.stdout.trim();
}

export function hasHeadCommit() {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    stdio: "ignore"
  });
  return result.status === 0;
}

export function listChangedFiles() {
  if (hasHeadCommit()) {
    const tracked = runCapture("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
    const untracked = runCapture("git", ["ls-files", "--others", "--exclude-standard"]);
    return [...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean);
  }

  const initial = runCapture("git", ["ls-files", "--cached", "--others", "--exclude-standard"]);
  return initial.split("\n").filter(Boolean);
}

export function unique(values) {
  return Array.from(new Set(values));
}
