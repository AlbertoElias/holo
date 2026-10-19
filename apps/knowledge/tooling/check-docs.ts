import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const parser = unified().use(remarkParse).use(remarkGfm);
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? files(filename)
      : entry.isFile() && entry.name.endsWith(".md")
        ? [filename]
        : [];
  });
}
function visit(node: Nodes, action: (node: Nodes) => void): void {
  action(node);
  if ("children" in node)
    node.children.forEach((child) => visit(child, action));
}
const errors: string[] = [];
const productFiles = files(path.join(root, "docs/product"));
for (const filename of productFiles) {
  const tree: Root = parser.parse(readFileSync(filename, "utf8"));
  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "definition") return;
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(node.url)) return;
    const target = decodeURIComponent(node.url.split("#")[0]!);
    if (!target || existsSync(path.resolve(path.dirname(filename), target)))
      return;
    errors.push(`${path.relative(root, filename)} -> ${node.url}`);
  });
}
const registry = readFileSync(path.join(root, "docs/product/IDEAS.md"), "utf8");
const ids = [...registry.matchAll(/^\| (IDEA-\d+) \|/gm)].map(
  (match) => match[1]!,
);
if (new Set(ids).size !== ids.length)
  errors.push("Duplicate idea identifiers in IDEAS.md");
for (const filename of productFiles) {
  const content = readFileSync(filename, "utf8");
  for (const id of content.match(/\bIDEA-\d{3}\b/g) ?? []) {
    if (!ids.includes(id))
      errors.push(`${path.relative(root, filename)} references unknown ${id}`);
  }
}
if (errors.length)
  throw new Error(`Knowledge integrity errors:\n${errors.join("\n")}`);
console.log(
  `Knowledge integrity: ${ids.length} unique ideas, ${productFiles.length} product documents, local links and idea references checked.`,
);
