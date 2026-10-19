import { useReadingState } from "../useReadingState";
import { concepts, documents, prds, research } from "../knowledge";
import { DocumentCard, Empty, PageHeading } from "../components";
export function Library({
  mode,
  allDocuments = false,
}: {
  mode: "wiki" | "prds";
  allDocuments?: boolean;
}) {
  const [query, setQuery] = useReadingState("library-search", "");
  const scope = allDocuments
    ? "All repository documents"
    : "Concepts and research";
  const list =
    mode === "wiki"
      ? scope === "All repository documents"
        ? documents
        : [...concepts, ...research]
      : prds;
  const filtered = list.filter((doc) =>
    `${doc.title} ${doc.content}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow={
          mode === "wiki"
            ? "A SHARED VOCABULARY"
            : "FROM POSSIBILITY TO PROPOSAL"
        }
        title={mode === "wiki" ? "The reference library." : "Product briefs."}
        description={
          mode === "wiki"
            ? "The full thinking, when you want to go deeper."
            : "Bounded user outcomes, proposed interactions, and evidence to seek. Status comes from each source document."
        }
      />
      <div className="library-tabs">
        <a
          href="#/wiki"
          aria-current={mode === "wiki" && !allDocuments ? "page" : undefined}
        >
          Concepts
        </a>
        <a href="#/prds" aria-current={mode === "prds" ? "page" : undefined}>
          Product briefs
        </a>
        <a
          href="#/wiki?collection=all"
          aria-current={allDocuments ? "page" : undefined}
        >
          All documents
        </a>
      </div>
      <div className="filter-bar">
        <label className="search-field library-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label={mode === "wiki" ? "Search wiki" : "Search PRDs"}
            placeholder="Find a concept or question…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {mode === "wiki" && (
          <select
            aria-label="Document collection"
            value={scope}
            onChange={(event) => {
              location.hash =
                event.target.value === "All repository documents"
                  ? "/wiki?collection=all"
                  : "/wiki";
            }}
          >
            <option>Concepts and research</option>
            <option>All repository documents</option>
          </select>
        )}
      </div>
      <div className="results-line">
        <span>{filtered.length} documents</span>
        <span>Living notes, open questions</span>
      </div>
      <div className="document-grid library-index">
        {filtered.map((doc) => (
          <DocumentCard key={doc.path} doc={doc} />
        ))}
      </div>
      {!filtered.length && (
        <Empty
          title="No documents found."
          description="Try a different search."
          action={() => setQuery("")}
        />
      )}
    </>
  );
}
