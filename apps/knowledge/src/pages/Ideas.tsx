import { useState } from "react";
import { ideas, relatedDocuments } from "../knowledge";
import type { Idea } from "../knowledge";
import {
  Badge,
  DocumentCard,
  Empty,
  NotFound,
  PageHeading,
  Source,
} from "../components";
export function IdeaCard({ idea }: { idea: Idea }) {
  const related = relatedDocuments(idea.id);
  const specs = related.filter((doc) => doc.kind === "PRD");
  return (
    <a href={`#/idea/${idea.id}`} className="idea-card">
      <div className="card-top">
        <span className="idea-id">{idea.id}</span>
        <Badge tone={specs.length ? "accent" : ""}>
          {specs.length
            ? `${specs.length} PRD${specs.length > 1 ? "s" : ""}`
            : idea.state}
        </Badge>
        <span className="arrow">↗</span>
      </div>
      <h2>{idea.title}</h2>
      <p className="idea-question">{idea.question}</p>
      <div className="card-bottom">
        <span>{idea.layer && <small className="idea-layer">{idea.layer}</small>}{idea.theme}</span>
        <span>
          {related.length ? `${related.length} linked notes` : "Seed idea"}
        </span>
      </div>
    </a>
  );
}
export function IdeaGarden({
  search,
  setSearch,
}: {
  search: string;
  setSearch: (value: string) => void;
}) {
  const [theme, setTheme] = useState("All themes");
  const [layer, setLayer] = useState("All layers");
  const [depth, setDepth] = useState("All ideas");
  const themes = [...new Set(ideas.map((idea) => idea.theme))].sort();
  const filtered = ideas.filter((idea) => {
    const links = relatedDocuments(idea.id);
    const query = search.trim().toLowerCase();
    const matches = /^idea-\d+$/.test(query)
      ? idea.id.toLowerCase() === query
      : `${idea.searchText} ${links.map((doc) => doc.title).join(" ")}`
          .toLowerCase()
          .includes(query);
    return (
      (theme === "All themes" || idea.theme === theme) &&
      (layer === 'All layers' || idea.layer === layer) &&
      (depth === "All ideas" ||
        (depth === "With PRDs"
          ? links.some((doc) => doc.kind === "PRD")
          : links.length > 0)) &&
      matches
    );
  });
  return (
    <>
      <PageHeading
        eyebrow="THE POSSIBILITY SPACE"
        title="The idea garden."
        description="Seeds, questions, and possibilities. Open an idea to follow its thinking into concepts and product briefs."
      />
      <div className="filter-bar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Search ideas"
            placeholder="Search ideas, questions, or linked notes…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <select
          aria-label="Filter by theme"
          value={theme}
          onChange={(event) => setTheme(event.target.value)}
        >
          <option>All themes</option>
          {themes.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
        <select
          aria-label="Filter by layer"
          value={layer}
          onChange={(event) => setLayer(event.target.value)}
        >
          <option>All layers</option>
          {[...new Set(ideas.map((idea) => idea.layer))].filter((item) => item && item !== 'All layers').sort().map((item) => <option key={item}>{item}</option>)}
        </select>
        <select
          aria-label="Filter by detail"
          value={depth}
          onChange={(event) => setDepth(event.target.value)}
        >
          <option>All ideas</option>
          <option>With notes</option>
          <option>With PRDs</option>
        </select>
      </div>
      <div className="results-line">
        <span>
          {filtered.length} of {ideas.length} ideas
        </span>
        <span>Curiosity before commitment</span>
      </div>
      {filtered.length ? (
        <div className="idea-grid">
          {filtered.map((idea) => (
            <IdeaCard key={idea.id} idea={idea} />
          ))}
        </div>
      ) : (
        <Empty
          title="Nothing growing here yet."
          description="Try another word or widen your filters."
          action={() => {
            setSearch("");
            setTheme("All themes");
            setLayer('All layers');
            setDepth("All ideas");
          }}
        />
      )}
      <footer className="page-source">
        <Source path="docs/product/IDEAS.md" />
      </footer>
    </>
  );
}
export function IdeaDetail({ id }: { id: string }) {
  const idea = ideas.find((item) => item.id === id);
  if (!idea) return <NotFound path={id} />;
  const related = relatedDocuments(id);
  const specifications = related.filter((doc) => doc.kind === "PRD");
  const notes = related.filter((doc) => doc.kind !== "PRD");
  return (
    <>
      <a className="back-link" href="#/ideas">
        ← Back to the idea garden
      </a>
      <PageHeading
        eyebrow={`${idea.id} / ${idea.layer} / ${idea.theme}`}
        title={idea.title}
        description="Read the source status and any PRD decision before treating an idea as implementation work. A linked PRD may be Draft, Approved, or Parked."
      >
        <Badge>{idea.state}</Badge>
      </PageHeading>
      <div className="question-panel">
        <span className="eyebrow">THE NEXT QUESTION</span>
        <p>{idea.question}</p>
      </div>
      <section className="bottom-section">
        <div className="section-label">
          <h2>Product briefs</h2>
          <span>{specifications.length} linked</span>
        </div>
        {specifications.length ? (
          <div className="document-grid">
            {specifications.map((doc) => (
              <DocumentCard key={doc.path} doc={doc} />
            ))}
          </div>
        ) : (
          <p className="muted">
            No PRD yet. The idea remains open for exploration.
          </p>
        )}
      </section>
      <section className="bottom-section">
        <div className="section-label">
          <h2>Explore the thinking</h2>
          <span>{notes.length} linked notes</span>
        </div>
        <div className="document-grid">
          {notes.map((doc) => (
            <DocumentCard key={doc.path} doc={doc} />
          ))}
        </div>
        {!notes.length && (
          <p className="muted">No detailed concept note yet.</p>
        )}
      </section>
      <footer className="page-source">
        <Source path="docs/product/IDEAS.md" />
      </footer>
    </>
  );
}
