import { bugs, docUrl } from "../knowledge";
import { Markdown } from "../Markdown";
import { Badge, PageHeading, Source } from "../components";
export function Bugs() {
  return (
    <>
      <PageHeading
        eyebrow="THE REPAIR DESK"
        title="Open bugs."
        description="Verified, reproducible defects from BUGS.md. Product ideas and planned work live separately."
      />
      <div className="results-line">
        <span>
          {bugs.length} verified open {bugs.length === 1 ? "bug" : "bugs"}
        </span>
        <Source path="BUGS.md" />
      </div>
      {bugs.length ? (
        <div className="bugs-list">
          {bugs.map((bug) => (
            <article className="bug-card" key={bug.id}>
              <div className="card-top">
                <span className="idea-id">{bug.id}</span>
                <Badge tone="warning">{bug.severity}</Badge>
              </div>
              <Markdown source="BUGS.md" content={bug.content} />
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <span className="empty-symbol">◎</span>
          <h2>No verified open bugs.</h2>
          <p>
            Device validation and planned improvements may still be outstanding.
          </p>
        </div>
      )}
      <div className="quiet-links">
        <a href={docUrl("TODOS.md")}>Planned work ↗</a>
        <a href={docUrl("docs/archive/closed-bugs.md")}>Closed bugs ↗</a>
      </div>
    </>
  );
}
