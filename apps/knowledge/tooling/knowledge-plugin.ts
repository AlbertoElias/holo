import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Nodes } from "mdast";
import type { Plugin } from "vite";
import {
  type DocumentSummary,
  parser,
  summarize,
} from "../src/markdown-tree";

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

  // Local raster images a document references, found once per content so a live
  // update does not reparse every document.
  const mime: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
  };
  const imageRefs = new Map<string, { content: string; refs: string[] }>();
  function imageRefsFor(docPath: string, content: string): string[] {
    const cached = imageRefs.get(docPath);
    if (cached?.content === content) return cached.refs;
    const refs = new Set<string>();
    const tree = parser.parse(content);
    const definitions = new Map<string, string>();
    for (const node of tree.children)
      if (node.type === "definition") definitions.set(node.identifier, node.url);
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
          const relative = path
            .relative(
              repoRoot,
              path.resolve(
                repoRoot,
                path.dirname(docPath),
                decodeURIComponent(url.split("#")[0]!.split("?")[0]!),
              ),
            )
            .split(path.sep)
            .join("/");
          if (relative.startsWith("docs/") && mime[path.extname(relative).toLowerCase()])
            refs.add(relative);
        } catch {
          /* Undecodable references stay textual. */
        }
      }
      if ("children" in node) node.children.forEach(visit);
    };
    visit(tree);
    const list = [...refs];
    imageRefs.set(docPath, { content, refs: list });
    return list;
  }

  // The dev server already watches these paths (configureServer). Vite's dev
  // addWatchFile also records each file as an import of the virtual module, so
  // a deleted document then fails import analysis ("Failed to resolve import"),
  // and the log line carries the \0 module-id prefix. Watch from the plugin
  // only outside the dev server.
  let dev = false;
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
        if (!dev) this.addWatchFile(filename);
        const content = readFileSync(filename, "utf8");
        return {
          path: path.relative(repoRoot, filename).split(path.sep).join("/"),
          content,
          ...summaryFor(filename, content),
        };
      });
      const images: Record<string, string> = {};
      for (const doc of documents) {
        for (const relative of imageRefsFor(doc.path, doc.content)) {
          const filename = path.resolve(repoRoot, relative);
          try {
            requireRegularPath(filename);
            const stat = lstatSync(filename);
            if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
            if (!dev) this.addWatchFile(filename);
            const type = mime[path.extname(filename).toLowerCase()]!;
            images[relative] =
              `data:${type};base64,${readFileSync(filename).toString("base64")}`;
          } catch {
            /* Missing, escaped or symlinked assets stay textual references. */
          }
        }
      }
      return `export const images = ${JSON.stringify(images)}; export default ${JSON.stringify(documents)};`;
    },
    configureServer(server) {
      dev = true;
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
