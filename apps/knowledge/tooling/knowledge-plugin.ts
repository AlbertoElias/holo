import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { type DocumentSummary, summarize } from "../src/markdown-tree";

const moduleId = "virtual:holoim-knowledge";
const resolvedId = `\0${moduleId}`;
const rootFiles = [
  "BUGS.md",
  "TODOS.md",
  "HANDOFF.md",
  "AGENT_CONTRACT.md",
  "README.md",
];

// Only Markdown under docs/ and these named root documents can enter the bundle.
export function knowledgePlugin(repoRoot: string): Plugin {
  function requireRegularPath(filename: string): void {
    // Do not follow a symlink in any component, including docs/ itself.
    let current = repoRoot;
    for (const segment of path.relative(repoRoot, filename).split(path.sep)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink())
        throw new Error(`Knowledge source cannot be a symlink: ${current}`);
    }
  }
  function listMarkdown(directory: string): string[] {
    requireRegularPath(directory);
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return listMarkdown(filename);
      return entry.isFile() && entry.name.endsWith(".md") ? [filename] : [];
    });
  }

  // Parsing every document on each reload is the slow part, so keep summaries
  // per file and recompute only the ones whose content changed.
  const summaries = new Map<string, { content: string; summary: DocumentSummary }>();
  function summaryFor(filename: string, content: string): DocumentSummary {
    const cached = summaries.get(filename);
    if (cached?.content === content) return cached.summary;
    const summary = summarize(content);
    summaries.set(filename, { content, summary });
    return summary;
  }

  return {
    name: "holoim-knowledge",
    resolveId(id) {
      return id === moduleId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return;
      const files = [
        ...listMarkdown(path.join(repoRoot, "docs")),
        ...rootFiles.map((file) => path.join(repoRoot, file)),
      ];
      const documents = files.sort().map((filename) => {
        requireRegularPath(filename);
        this.addWatchFile(filename);
        const content = readFileSync(filename, "utf8");
        return {
          path: path.relative(repoRoot, filename).split(path.sep).join("/"),
          content,
          ...summaryFor(filename, content),
        };
      });
      return `export default ${JSON.stringify(documents)};`;
    },
    configureServer(server) {
      server.watcher.add([
        path.join(repoRoot, "docs"),
        ...rootFiles.map((file) => path.join(repoRoot, file)),
      ]);
      const refresh = (filename: string) => {
        const relative = path
          .relative(repoRoot, filename)
          .split(path.sep)
          .join("/");
        if (
          !(relative.startsWith("docs/") && relative.endsWith(".md")) &&
          !rootFiles.includes(relative)
        )
          return;
        const module = server.moduleGraph.getModuleById(resolvedId);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher
        .on("add", refresh)
        .on("change", refresh)
        .on("unlink", refresh);
      server.httpServer?.once("close", () => {
        server.watcher
          .off("add", refresh)
          .off("change", refresh)
          .off("unlink", refresh);
      });
    },
  };
}
