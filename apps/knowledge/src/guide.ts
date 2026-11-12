import type { Table } from "mdast";
import { byPath, nodeText, relatedDocuments } from "./knowledge";
import type { Idea } from "./knowledge";

export const guidePath = "docs/product/ATLAS_GUIDE.md";
export function guideRows(
  section: string,
  path = guidePath,
): Record<string, string>[] {
  const nodes = byPath.get(path)?.tree.children ?? [];
  const start = nodes.findIndex(
    (node) => node.type === "heading" && nodeText(node) === section,
  );
  if (start < 0) return [];
  const nextHeading = nodes.findIndex(
    (node, index) =>
      index > start && node.type === "heading" && node.depth <= 2,
  );
  const table = nodes
    .slice(start + 1, nextHeading < 0 ? undefined : nextHeading)
    .find((node): node is Table => node.type === "table");
  const headers = table?.children[0]?.children.map(nodeText) ?? [];
  return (table?.children.slice(1) ?? []).map((row) =>
    Object.fromEntries(
      headers.map((header, index) => [
        header,
        row.children[index] ? nodeText(row.children[index]!) : "",
      ]),
    ),
  );
}
export const opening = Object.fromEntries(
  guideRows("Opening").map((row) => [row.Key, row.Copy]),
);
export const layers = guideRows("Layers");
export const wireframe = Object.fromEntries(
  guideRows("Wireframe").map((row) => [row.Key, row.Copy]),
);
export const example = guideRows("Example");
export const viewModes = guideRows("View Modes");
export const territories = guideRows("Territories");
export const connections = guideRows("Connections");
export const processSteps = guideRows("Process");
export const agentRoles = guideRows("Agent Roles");
const labels = new Map(
  guideRows("Idea Labels", "docs/product/research/idea-labels.md").map(
    (row) => [row.ID, row],
  ),
);
export function ideaLabel(idea: Idea): string {
  return labels.get(idea.id)?.Label || idea.title.split(":")[0] || idea.title;
}
export function ideaTakeaway(idea: Idea): string {
  return labels.get(idea.id)?.Takeaway || idea.title;
}
const lens = byPath.get("docs/product/concepts/what-a-hologram-is.md");
const parked = new Set(
  (
    lens?.content.match(/Parked for now:([^\n]+)/)?.[1]?.match(/\b\d{3}\b/g) ??
    []
  ).map((id) => `IDEA-${id}`),
);
export function ideaStatus(idea: Idea): string {
  if (parked.has(idea.id) || /parked/i.test(idea.state)) return "Parked";
  const prd = relatedDocuments(idea.id).find((doc) => doc.kind === "PRD");
  return prd?.status ? `PRD · ${prd.status}` : "Idea";
}

export function guideDiagram(section: string): string {
  const nodes = byPath.get(guidePath)?.tree.children ?? [];
  const start = nodes.findIndex(
    (node) => node.type === "heading" && nodeText(node) === section,
  );
  if (start < 0) return "";
  for (const node of nodes.slice(start + 1)) {
    if (node.type === "heading" && node.depth <= 2) break;
    if (node.type === "code" && node.lang === "mermaid") return node.value;
  }
  return "";
}
