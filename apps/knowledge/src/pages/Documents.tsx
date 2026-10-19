import { byPath, referencedIdeas } from "../knowledge";
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
          {references.length > 0 && (
            <>
              <h3>Related ideas</h3>
              {references.map((idea) => (
                <a key={idea.id} href={`#/idea/${idea.id}`}>
                  <span>{idea.id}</span>
                  {idea.title}
                </a>
              ))}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
