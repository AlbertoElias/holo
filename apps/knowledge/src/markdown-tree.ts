import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Shared by the browser and the Vite plugin so card summaries match the reader.
export const parser = unified().use(remarkParse).use(remarkGfm);

export function nodeText(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node)
    return node.children.map((child) => nodeText(child)).join("");
  return "";
}

export type DocumentSummary = { title: string | null; description: string };

export function summarize(content: string): DocumentSummary {
  const tree = parser.parse(content);
  const title = tree.children.find((node) => node.type === "heading");
  const description = tree.children.find(
    (node) =>
      node.type === "paragraph" &&
      !/^\*\*/.test(content.slice(node.position?.start.offset ?? 0)),
  );
  return {
    title: title ? nodeText(title) : null,
    description: description ? nodeText(description) : "",
  };
}
