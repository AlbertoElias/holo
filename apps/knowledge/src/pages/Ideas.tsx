import { useReadingState } from "../useReadingState";
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
import {
  ideaLabel,
  ideaStatus,
  ideaTakeaway,
  opening,
  territories,
} from "../guide";
import { RelationshipMap } from "../visuals";

export function IdeaCard({ idea }: { idea: Idea }) {
  return (
    <a href={`#/idea/${idea.id}`} className="idea-card idea-row">
      <span className="idea-id">{idea.id}</span>
      <div>
        <h2>{ideaLabel(idea)}</h2>
        <p>{ideaTakeaway(idea)}</p>
      </div>
      <Badge>{ideaStatus(idea)}</Badge>
      <span className="idea-layer">{idea.layer}</span>
      <span className="arrow" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
export function IdeaGarden({
  search,
  setSearch,
  layer,
}: {
  search: string;
  setSearch: (value: string) => void;
  layer: string;
}) {
  const [theme, setTheme] = useReadingState("idea-theme", "All themes");
  const [depth, setDepth] = useReadingState("idea-depth", "All ideas");
  const showing = Boolean(
    layer || search || theme !== "All themes" || depth !== "All ideas",
  );
  const groups = [
    ...territories,
    ...[...new Set(ideas.map((idea) => idea.layer))]
      .filter((key) => !territories.some((row) => row.Layer === key))
      .map((key) => ({
        Layer: key,
        Title: key || "Other ideas",
        Description: "New territory from the idea registry.",
      })),
  ];
  const filtered = ideas.filter((idea) => {
    const links = relatedDocuments(idea.id);
    const query = search.trim().toLowerCase();
    return (
      (!layer || layer === "all" || idea.layer === layer) &&
      (theme === "All themes" || theme === idea.theme) &&
      (depth === "All ideas" ||
        (depth === "With PRDs"
          ? links.some((doc) => doc.kind === "PRD")
          : links.length)) &&
      (/^idea-\d+$/.test(query)
        ? idea.id.toLowerCase() === query
        : `${idea.searchText} ${ideaLabel(idea)} ${ideaTakeaway(idea)} ${links.map((doc) => doc.title).join(" ")}`
            .toLowerCase()
            .includes(query))
    );
  });
  return (
    <>
      <PageHeading
        eyebrow="EXPLORE IDEAS"
        title={opening["Map title"] || "Explore ideas."}
        description={
          opening["Map intro"] ||
          "Browse the idea registry by layer, or search every idea."
        }
      />
      <div className="filter-bar">
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Search ideas"
            placeholder={`Search ${ideas.length} ideas…`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <a
          className="button subtle"
          href={layer === "all" ? "#/ideas" : "#/ideas?layer=all"}
        >
          {layer === "all"
            ? "Back to territories"
            : `All ${ideas.length} ideas`}
        </a>
      </div>
      <details className="advanced-filters">
        <summary>More filters</summary>
        <div className="filter-bar">
          <select
            aria-label="Filter by layer"
            value={layer}
            onChange={(event) => {
              location.hash = event.target.value
                ? `/ideas?layer=${encodeURIComponent(event.target.value)}`
                : "/ideas";
            }}
          >
            <option value="">Every layer</option>
            <option value="all">All ideas</option>
            {groups.map((group) => (
              <option key={group.Layer} value={group.Layer}>
                {group.Layer}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by theme"
            value={theme}
            onChange={(event) => setTheme(event.target.value)}
          >
            <option>All themes</option>
            {[...new Set(ideas.map((idea) => idea.theme))]
              .sort()
              .map((item) => (
                <option key={item}>{item}</option>
              ))}
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
      </details>
      {!showing ? (
        <>
          <div className="territory-grid">
            {groups.map((group, index) => (
              <a
                className="territory-card"
                href={`#/ideas?layer=${encodeURIComponent(group.Layer!)}`}
                key={group.Layer}
              >
                <span className="territory-number">0{index + 1}</span>
                <span className="eyebrow">{group.Layer}</span>
                <h2>{group.Title}</h2>
                <p>{group.Description}</p>
                <span className="territory-count">
                  {ideas.filter((idea) => idea.layer === group.Layer).length}{" "}
                  ideas <span aria-hidden="true">↗</span>
                </span>
              </a>
            ))}
          </div>
          <RelationshipMap />
        </>
      ) : (
        <>
          <div className="results-line">
            <span>
              {filtered.length} of {ideas.length} ideas
              {layer && layer !== "all" ? ` / ${layer}` : ""}
            </span>
            <a
              href="#/ideas"
              onClick={() => {
                setSearch("");
                setTheme("All themes");
                setDepth("All ideas");
              }}
            >
              Back to territories
            </a>
          </div>
          {filtered.length ? (
            <div className="idea-list">
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
                setDepth("All ideas");
                location.hash = "/ideas";
              }}
            />
          )}
        </>
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
      <a
        className="back-link"
        href={`#/ideas?layer=${encodeURIComponent(idea.layer)}`}
      >
        ← Back to this territory
      </a>
      <PageHeading
        eyebrow={`${idea.id} / ${idea.layer}`}
        title={ideaLabel(idea)}
        description={ideaTakeaway(idea)}
      >
        <Badge>{ideaStatus(idea)}</Badge>
      </PageHeading>
      <div className="question-panel">
        <span className="eyebrow">THE OPEN QUESTION</span>
        <p>{idea.question}</p>
      </div>
      <details className="source-details">
        <summary>Original idea and source status</summary>
        <h2>{idea.title}</h2>
        <p>
          {idea.theme} · {idea.state}
        </p>
        <Source path="docs/product/IDEAS.md" />
      </details>
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
            No PRD yet. An idea is not a delivery commitment.
          </p>
        )}
      </section>
      {(id === "IDEA-032" || id === "IDEA-045") && (
        <RelationshipMap focus={id} />
      )}
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
