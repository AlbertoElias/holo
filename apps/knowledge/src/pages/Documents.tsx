import {
  byPath,
  docUrl,
  nodeText,
  headingId,
  referencedIdeas,
} from "../knowledge";
import { ideaLabel } from "../guide";
import { Markdown } from "../Markdown";
import { Badge, NotFound } from "../components";
export function DocumentReader({
  path,
  section,
}: {
  path: string;
  section?: string | undefined;
}) {
  const doc = byPath.get(path);
  if (!doc) return <NotFound path={path} />;
  const references = referencedIdeas(doc);
  return (
    <>
      <a
        className="back-link"
        href={
          doc.kind === "Concept" || doc.kind === "Research"
            ? "#/wiki"
            : doc.kind === "PRD"
              ? "#/prds"
              : "#/"
        }
      >
        ← Back to{" "}
        {doc.kind === "PRD"
          ? "product briefs"
          : doc.kind === "Concept" || doc.kind === "Research"
            ? "the wiki"
            : "our approach"}
      </a>
      <div className="reader-meta">
        <Badge>{doc.kind}</Badge>
        {doc.status && <Badge>{doc.status}</Badge>}
        <span>{doc.path}</span>
      </div>
      <div className="reader-layout">
        <article className="reading-paper">
          <Markdown content={doc.content} source={doc.path} section={section} />
        </article>
        <aside className="reader-aside">
          <span className="eyebrow">SOURCE OF TRUTH</span>
          <p>
            This page is rendered from repository Markdown. Edit the file in the
            repo to update it.
          </p>
          <code>{doc.path}</code>
          <h3>On this page</h3>
          <nav className="document-outline" aria-label="Document sections">
            {doc.tree.children
              .filter((node) => node.type === "heading" && node.depth === 2)
              .map((node, index) => (
                <a
                  key={index}
                  href={docUrl(doc.path, headingId(nodeText(node)))}
                >
                  {nodeText(node)}
                </a>
              ))}
          </nav>
          {references.length > 0 && (
            <>
              <h3>Related ideas</h3>
              {references.slice(0, 6).map((idea) => (
                <a key={idea.id} href={`#/idea/${idea.id}`}>
                  <span>{idea.id}</span>
                  {ideaLabel(idea)}
                </a>
              ))}
              {references.length > 6 && (
                <details>
                  <summary>{references.length - 6} more ideas</summary>
                  {references.slice(6).map((idea) => (
                    <a key={idea.id} href={`#/idea/${idea.id}`}>
                      {idea.id} · {ideaLabel(idea)}
                    </a>
                  ))}
                </details>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
