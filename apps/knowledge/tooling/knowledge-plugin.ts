import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

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
        return {
          path: path.relative(repoRoot, filename).split(path.sep).join("/"),
          content: readFileSync(filename, "utf8"),
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
