import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";

export type SelectionReason =
  | "no-changes"
  | "docs-only"
  | "package-changes"
  | "all-packages-fallback";

export interface WorkspacePackage {
  dependencies: readonly string[];
  name: string;
  path: string;
  scripts: Readonly<Record<string, string>>;
}

export interface WorkspaceGraph {
  packages: readonly WorkspacePackage[];
  reverseDependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface PackageSelection {
  changedFiles: readonly string[];
  docFiles: readonly string[];
  directPackages: readonly string[];
  fallbackFiles: readonly string[];
  reason: SelectionReason;
  selectedPackages: readonly string[];
}

export interface CheckPlan {
  lint: "lint" | null;
  package: string;
  path: string;
  test: "test:unit" | "test" | null;
  typecheck: "typecheck" | null;
}

export interface RootAction {
  args: readonly string[];
  command: "pnpm";
}

export interface DryRunReport {
  changedFiles: readonly string[];
  checks: readonly CheckPlan[];
  rootActions: readonly RootAction[];
  schemaVersion: 1;
  selection: {
    directPackages: readonly string[];
    docFiles: readonly string[];
    fallbackFiles: readonly string[];
    reason: SelectionReason;
    selectedPackages: readonly string[];
  };
}

export const VERIFY_WORKSPACE_ACTION: RootAction = {
  args: ["run", "verify:workspace"],
  command: "pnpm"
};

// Documentation needs its own checks, not every package's: Markdown anywhere
// and everything under docs/. Knowledge's check:docs validates the links.
export const VERIFY_DOCS_ACTION: RootAction = {
  args: ["--filter", "@holoim/knowledge", "run", "check:docs"],
  command: "pnpm"
};

// Files outside a package's directory that are that package's source, and
// files whose change reaches packages that do not depend on their owner.
// The design token file stays beside the styleguide but generates
// @holoim/design-tokens, and the shared lint rule in @holoim/config-eslint
// reads the generated colours, so a token edit lints every package.
export const RELATED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  "docs/product/design/tokens.json": ["@holoim/design-tokens", "@holoim/config-eslint"],
  "packages/design-tokens/src/generated/tokens.json": ["@holoim/config-eslint"]
};

export function isDocumentationFile(file: string): boolean {
  if (file in RELATED_PACKAGES) return false;
  return file.endsWith(".md") || file.startsWith("docs/");
}

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
] as const;

function normalizeRelativePath(file: string): string {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}

function readDirectoryNames(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*")}$`);
}

function expandDirectoryPattern(rootDir: string, pattern: string): string[] {
  const normalizedPattern = normalizeRelativePath(pattern).replace(/\/$/, "");
  if (
    normalizedPattern.startsWith("/")
    || normalizedPattern.split("/").includes("..")
  ) {
    throw new Error(`Unsupported workspace package pattern: ${pattern}`);
  }

  const segments = normalizedPattern === "" ? [] : normalizedPattern.split("/");
  const matches = new Set<string>();

  function visit(directory: string, segmentIndex: number): void {
    if (segmentIndex === segments.length) {
      if (existsSync(path.join(directory, "package.json"))) {
        matches.add(normalizeRelativePath(path.relative(rootDir, directory)));
      }
      return;
    }

    const segment = segments[segmentIndex];
    if (segment === undefined) {
      throw new Error(`Could not resolve workspace package pattern: ${pattern}`);
    }
    if (segment === "**") {
      visit(directory, segmentIndex + 1);
      for (const child of readDirectoryNames(directory)) {
        visit(path.join(directory, child), segmentIndex);
      }
      return;
    }

    const matcher = segmentMatcher(segment);
    for (const child of readDirectoryNames(directory)) {
      if (matcher.test(child)) {
        visit(path.join(directory, child), segmentIndex + 1);
      }
    }
  }

  visit(rootDir, 0);
  return [...matches].sort();
}

export function parseWorkspacePackagePatterns(contents: string): string[] {
  const lines = contents.split(/\r?\n/);
  const patterns: string[] = [];
  let packagesIndent: number | null = null;

  for (const line of lines) {
    if (packagesIndent === null) {
      const match = /^(\s*)packages:\s*(?:#.*)?$/.exec(line);
      if (match) {
        packagesIndent = (match[1] ?? "").length;
      }
      continue;
    }

    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (indent <= packagesIndent) {
      break;
    }

    const item = /^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/.exec(line);
    if (item) {
      const pattern = item[1] ?? item[2] ?? item[3];
      if (pattern !== undefined) {
        patterns.push(pattern);
      }
    }
  }

  if (patterns.length === 0) {
    throw new Error("pnpm-workspace.yaml does not define any package patterns.");
  }

  return patterns;
}

function readManifest(manifestPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${manifestPath}: ${String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected ${manifestPath} to contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function readScripts(manifest: Record<string, unknown>, manifestPath: string): Record<string, string> {
  if (manifest.scripts === undefined) {
    return {};
  }
  if (typeof manifest.scripts !== "object" || manifest.scripts === null || Array.isArray(manifest.scripts)) {
    throw new Error(`Expected scripts in ${manifestPath} to be an object.`);
  }

  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (typeof command !== "string") {
      throw new Error(`Expected script ${name} in ${manifestPath} to be a string.`);
    }
    scripts[name] = command;
  }
  return scripts;
}

function readDependencyNames(manifest: Record<string, unknown>, manifestPath: string): string[] {
  const dependencies = new Set<string>();
  for (const field of dependencyFields) {
    const value = manifest[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Expected ${field} in ${manifestPath} to be an object.`);
    }
    for (const [name, version] of Object.entries(value)) {
      if (typeof version !== "string") {
        throw new Error(`Expected dependency ${name} in ${manifestPath} to have a string version.`);
      }
      dependencies.add(name);
    }
  }
  return [...dependencies].sort();
}

export function discoverWorkspaceGraph(rootDir: string): WorkspaceGraph {
  const workspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  const patterns = parseWorkspacePackagePatterns(readFileSync(workspacePath, "utf8"));
  const includedPaths = new Set<string>();
  const excludedPaths = new Set<string>();

  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    for (const packagePath of expandDirectoryPattern(rootDir, pattern)) {
      (excluded ? excludedPaths : includedPaths).add(packagePath);
    }
  }

  const packages: WorkspacePackage[] = [];
  const packageNames = new Set<string>();
  for (const packagePath of [...includedPaths].filter((item) => !excludedPaths.has(item)).sort()) {
    const manifestPath = path.join(rootDir, packagePath, "package.json");
    const manifest = readManifest(manifestPath);
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      throw new Error(`Expected ${manifestPath} to define a non-empty package name.`);
    }
    if (packageNames.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    }
    packageNames.add(manifest.name);
    packages.push({
      dependencies: readDependencyNames(manifest, manifestPath),
      name: manifest.name,
      path: packagePath,
      scripts: readScripts(manifest, manifestPath)
    });
  }

  if (packages.length === 0) {
    throw new Error("No workspace packages were discovered.");
  }

  packages.sort((left, right) => left.name.localeCompare(right.name));
  const reverseDependencies = new Map<string, Set<string>>(
    packages.map((workspacePackage) => [workspacePackage.name, new Set<string>()])
  );
  for (const workspacePackage of packages) {
    for (const dependency of workspacePackage.dependencies) {
      reverseDependencies.get(dependency)?.add(workspacePackage.name);
    }
  }

  return { packages, reverseDependencies };
}

function packageForFile(packages: readonly WorkspacePackage[], file: string): WorkspacePackage | null {
  const matches = packages.filter(
    (workspacePackage) => file === workspacePackage.path || file.startsWith(`${workspacePackage.path}/`)
  );
  matches.sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name));
  return matches[0] ?? null;
}

export function selectAffectedPackages(
  graph: WorkspaceGraph,
  changedFiles: readonly string[]
): PackageSelection {
  const normalizedFiles = [...new Set(changedFiles.map(normalizeRelativePath).filter(Boolean))].sort();
  if (normalizedFiles.length === 0) {
    return {
      changedFiles: [],
      directPackages: [],
      docFiles: [],
      fallbackFiles: [],
      reason: "no-changes",
      selectedPackages: []
    };
  }

  const docFiles = normalizedFiles.filter(isDocumentationFile);
  const codeFiles = normalizedFiles.filter((file) => !isDocumentationFile(file));
  if (codeFiles.length === 0) {
    return {
      changedFiles: normalizedFiles,
      directPackages: [],
      docFiles,
      fallbackFiles: [],
      reason: "docs-only",
      selectedPackages: []
    };
  }

  const directPackages = new Set<string>();
  const fallbackFiles: string[] = [];
  const knownPackages = new Set(graph.packages.map((workspacePackage) => workspacePackage.name));
  for (const file of codeFiles) {
    const related = (RELATED_PACKAGES[file] ?? []).filter((name) => knownPackages.has(name));
    for (const name of related) directPackages.add(name);
    const workspacePackage = packageForFile(graph.packages, file);
    if (workspacePackage) {
      directPackages.add(workspacePackage.name);
    } else if (related.length === 0) {
      fallbackFiles.push(file);
    }
  }

  const allPackageNames = graph.packages.map((workspacePackage) => workspacePackage.name).sort();
  if (fallbackFiles.length > 0) {
    return {
      changedFiles: normalizedFiles,
      directPackages: [...directPackages].sort(),
      docFiles,
      fallbackFiles,
      reason: "all-packages-fallback",
      selectedPackages: allPackageNames
    };
  }

  const selectedPackages = new Set(directPackages);
  const queue = [...directPackages].sort();
  while (queue.length > 0) {
    const dependency = queue.shift();
    if (dependency === undefined) {
      break;
    }
    const dependents = [...(graph.reverseDependencies.get(dependency) ?? [])].sort();
    for (const dependent of dependents) {
      if (!selectedPackages.has(dependent)) {
        selectedPackages.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return {
    changedFiles: normalizedFiles,
    directPackages: [...directPackages].sort(),
    docFiles,
    fallbackFiles: [],
    reason: "package-changes",
    selectedPackages: [...selectedPackages].sort()
  };
}

export function createCheckPlans(
  graph: WorkspaceGraph,
  selectedPackages: readonly string[]
): CheckPlan[] {
  const packageByName = new Map(graph.packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  return [...selectedPackages].sort().map((packageName) => {
    const workspacePackage = packageByName.get(packageName);
    if (!workspacePackage) {
      throw new Error(`Selected package was not found in the workspace graph: ${packageName}`);
    }
    return {
      lint: workspacePackage.scripts.lint ? "lint" : null,
      package: workspacePackage.name,
      path: workspacePackage.path,
      test: workspacePackage.scripts["test:unit"]
        ? "test:unit"
        : workspacePackage.scripts.test
          ? "test"
          : null,
      typecheck: workspacePackage.scripts.typecheck ? "typecheck" : null
    };
  });
}

export function createDryRunReport(graph: WorkspaceGraph, selection: PackageSelection): DryRunReport {
  const usesWorkspaceFallback = selection.reason === "all-packages-fallback";
  return {
    changedFiles: selection.changedFiles,
    checks: usesWorkspaceFallback ? [] : createCheckPlans(graph, selection.selectedPackages),
    rootActions: [
      ...(selection.docFiles.length > 0 ? [VERIFY_DOCS_ACTION] : []),
      ...(usesWorkspaceFallback ? [VERIFY_WORKSPACE_ACTION] : [])
    ],
    schemaVersion: 1,
    selection: {
      directPackages: selection.directPackages,
      docFiles: selection.docFiles,
      fallbackFiles: selection.fallbackFiles,
      reason: selection.reason,
      selectedPackages: selection.selectedPackages
    }
  };
}

function runGit(rootDir: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

export function listChangedFiles(rootDir: string): string[] {
  const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: rootDir,
    stdio: "ignore"
  }).status === 0;
  const tracked = hasHead
    ? runGit(rootDir, ["diff", "--name-only", "--no-renames", "--diff-filter=ACMRD", "HEAD"])
    : runGit(rootDir, ["ls-files", "--cached"]);
  const untracked = runGit(rootDir, ["ls-files", "--others", "--exclude-standard"]);

  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))]
    .map(normalizeRelativePath)
    .sort();
}
