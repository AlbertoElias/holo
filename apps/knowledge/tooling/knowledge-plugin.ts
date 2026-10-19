import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Nodes } from "mdast";
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

// Only allowlisted Markdown and referenced, bounded raster images enter the bundle.
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
      const images: Record<string, string> = {};
      const parser = unified().use(remarkParse);
      const mime: Record<string, string> = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".avif": "image/avif",
      };
      for (const doc of documents) {
        const tree = parser.parse(doc.content);
        const definitions = new Map<string, string>();
        for (const node of tree.children)
          if (node.type === "definition")
            definitions.set(node.identifier, node.url);
        const visit = (node: Nodes): void => {
          const url =
            node.type === "image"
              ? node.url
              : node.type === "imageReference"
                ? definitions.get(node.identifier)
                : undefined;
          if (
            url &&
            !/^[a-z][a-z\d+.-]*:/i.test(url) &&
            !url.startsWith("/") &&
            !url.startsWith("#")
          ) {
            try {
              const filename = path.resolve(
                repoRoot,
                path.dirname(doc.path),
                decodeURIComponent(url.split("#")[0]!.split("?")[0]!),
              );
              const relative = path
                .relative(repoRoot, filename)
                .split(path.sep)
                .join("/");
              const type = mime[path.extname(filename).toLowerCase()];
              if (relative.startsWith("docs/") && type) {
                requireRegularPath(filename);
                const stat = lstatSync(filename);
                if (stat.isFile() && stat.size <= 5 * 1024 * 1024) {
                  this.addWatchFile(filename);
                  images[relative] =
                    `data:${type};base64,${readFileSync(filename).toString("base64")}`;
                }
              }
            } catch {
              /* Missing, escaped or symlinked assets stay textual references. */
            }
          }
          if ("children" in node) node.children.forEach(visit);
        };
        visit(tree);
      }
      return `export const images = ${JSON.stringify(images)}; export default ${JSON.stringify(documents)};`;
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
          !(
            relative.startsWith("docs/") &&
            /\.(md|png|jpe?g|webp|gif|avif)$/i.test(relative)
          ) &&
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
