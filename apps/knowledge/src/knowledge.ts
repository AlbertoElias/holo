import type { Nodes, Root, RootContent, Table } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import sources, { images } from "virtual:holoim-knowledge";

export type DocumentKind = "Concept" | "PRD" | "Research" | "Feature" | "Guide";
export type KnowledgeDocument = {
  path: string;
  title: string;
  content: string;
  description: string;
  kind: DocumentKind;
  status: string | null;
  tree: Root;
};
export type Idea = {
  id: string;
  title: string;
  theme: string;
  layer: string;
  state: string;
  question: string;
  searchText: string;
  detailPaths: string[];
};
export type Bug = {
  id: string;
  title: string;
  content: string;
  severity: string;
  area: string;
};
const parser = unified().use(remarkParse).use(remarkGfm);

export function nodeText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node)
    return node.children.map((child) => nodeText(child)).join("");
  return "";
}

function kindFor(path: string): DocumentKind {
  if (path.startsWith("docs/product/concepts/")) return "Concept";
  if (path.startsWith("docs/product/prds/")) return "PRD";
  if (path.startsWith("docs/product/research/")) return "Research";
  if (path.startsWith("docs/features/")) return "Feature";
  return "Guide";
}

export const documents: KnowledgeDocument[] = sources.map((source) => {
  const tree = parser.parse(source.content);
  const title = tree.children.find((node) => node.type === "heading");
  const description = tree.children.find(
    (node) =>
      node.type === "paragraph" &&
      !/^\*\*/.test(source.content.slice(node.position?.start.offset ?? 0)),
  );
  return {
    ...source,
    tree,
    title: title ? nodeText(title) : source.path,
    description: description ? nodeText(description) : "",
    kind: kindFor(source.path),
    status:
      source.content.match(/\*\*Status:\*\*\s*([^\n]+)/)?.[1]?.trim() ?? null,
  };
});
export const byPath = new Map(documents.map((doc) => [doc.path, doc]));
export const concepts = documents.filter(
  (doc) => doc.kind === "Concept" && !doc.path.endsWith("/README.md"),
);
export const prds = documents.filter(
  (doc) =>
    doc.kind === "PRD" && !/\/(?:PRD-TEMPLATE|README)\.md$/.test(doc.path),
);
export const research = documents.filter((doc) => doc.kind === "Research");

function linkedPaths(node: Nodes): string[] {
  if (node.type === "link") {
    const link = resolveLink("docs/product/IDEAS.md", node.url);
    return link?.startsWith("#/doc/")
      ? [decodeURIComponent(link.slice(6).split("?")[0]!)]
      : [];
  }
  return "children" in node ? node.children.flatMap(linkedPaths) : [];
}
const registry = byPath.get("docs/product/IDEAS.md");
const table = registry?.tree.children.find(
  (node): node is Table =>
    node.type === "table" &&
    node.children.some((row) => /^IDEA-\d+/.test(nodeText(row.children[0]!))),
);
const columns =
  table?.children[0]?.children.map((cell) =>
    nodeText(cell).trim().toLowerCase(),
  ) ?? [];
export const ideas: Idea[] = (table?.children.slice(1) ?? []).flatMap((row) => {
  const cells = row.children.map(nodeText);
  const cell = (name: string) => cells[columns.indexOf(name)]?.trim() ?? "";
  const id = cell("id");
  const title = cell("idea");
  const theme = cell("theme");
  const layer = cell("layer");
  const state = cell("state");
  const question = cell("next question");
  if (!/^IDEA-\d+$/.test(id)) return [];
  return [
    {
      id,
      title,
      theme,
      layer,
      state,
      question,
      searchText: cells.join(" ").toLowerCase(),
      detailPaths: linkedPaths(row),
    },
  ];
});

export function relatedDocuments(id: string): KnowledgeDocument[] {
  const pattern = new RegExp(`\\b${id}\\b`);
  const explicitLinks = ideas.find((idea) => idea.id === id)?.detailPaths ?? [];
  return documents.filter((doc) => {
    // PRD ownership comes from its explicit source field, never incidental mentions.
    const content =
      doc.kind === "PRD"
        ? (doc.content.match(/\*\*Source ideas:\*\*\s*([^\n]+)/)?.[1] ?? "")
        : doc.content;
    if (doc.kind === "PRD") return prds.includes(doc) && pattern.test(content);
    return (
      explicitLinks.includes(doc.path) ||
      (concepts.includes(doc) && pattern.test(content))
    );
  });
}

export function referencedIdeas(doc: KnowledgeDocument): Idea[] {
  const ids = new Set(doc.content.match(/\bIDEA-\d+\b/g));
  return ideas.filter((idea) => ids.has(idea.id));
}

function sectionNodes(doc: KnowledgeDocument, heading: string): RootContent[] {
  const start = doc.tree.children.findIndex(
    (node) =>
      node.type === "heading" &&
      node.depth === 2 &&
      nodeText(node).toLowerCase() === heading,
  );
  if (start === -1) return [];
  const following = doc.tree.children.slice(start + 1);
  const end = following.findIndex(
    (node) => node.type === "heading" && node.depth <= 2,
  );
  return end === -1 ? following : following.slice(0, end);
}

const bugsDoc = byPath.get("BUGS.md");
const bugNodes = bugsDoc ? sectionNodes(bugsDoc, "open") : [];
export const bugs: Bug[] = bugNodes.flatMap((node, index) => {
  if (node.type !== "heading" || node.depth !== 3) return [];
  const match = nodeText(node).match(/^(B-\d+)\s*[—–-]\s*(.+)$/);
  if (!match || !bugsDoc) return [];
  const following = bugNodes.slice(index + 1);
  const nextHeading = following.find(
    (entry) => entry.type === "heading" && entry.depth <= 3,
  );
  const content = bugsDoc.content.slice(
    node.position?.start.offset ?? 0,
    nextHeading?.position?.start.offset ??
      bugNodes.at(-1)?.position?.end.offset,
  );
  return [
    {
      id: match[1]!,
      title: match[2]!,
      content,
      severity:
        content.match(/\*\*Severity:\*\*\s*(P[0-3])/)?.[1] ?? "Unspecified",
      area: content.match(/\*\*Area:\*\*\s*([^\n]+)/)?.[1] ?? "",
    },
  ];
});

export function docUrl(path: string, fragment = ""): string {
  return `#/doc/${path.split("/").map(encodeURIComponent).join("/")}${fragment ? `?section=${encodeURIComponent(fragment)}` : ""}`;
}

export function resolveLink(from: string, href: string): string | null {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const [rawPath = "", fragment = ""] = href.split("#");
  if (!rawPath) return docUrl(from, fragment);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const segments = decoded.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment && segment !== ".") segments.push(segment);
  }
  return docUrl(segments.join("/"), fragment);
}

export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function localImage(source: string, href: string): string | undefined {
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) ||
    href.startsWith("/") ||
    href.startsWith("#")
  )
    return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#")[0]!.split("?")[0]!);
  } catch {
    return undefined;
  }
  const parts = source.split("/").slice(0, -1);
  for (const segment of decoded.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return images[parts.join("/")];
}
