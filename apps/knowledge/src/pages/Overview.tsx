import { byPath, bugs, concepts, ideas, prds } from "../knowledge";
import type { KnowledgeDocument } from "../knowledge";
import { Markdown } from "../Markdown";
import { DocumentCard, Source } from "../components";
export function Overview() {
  const approach =
    byPath.get("docs/product/APPROACH.md") ??
    byPath.get("docs/product/VISION.md");
  return (
    <>
      <div className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            A FIELD GUIDE TO HOLOGRAPHIC COMMUNICATION
          </span>
          <h1>
            Ideas deserve
            <br />
            another dimension.
          </h1>
          <p>
            People, objects, space, and time.
            <br />
            Exploring what happens when all four become part of the
            conversation.
          </p>
          <a className="button button-dark" href="#/ideas">
            Explore the ideas <span>↗</span>
          </a>
        </div>
        <div className="orbital" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="orbit-core" />
          <span className="orbit-label label-presence">PRESENCE</span>
          <span className="orbit-label label-space">SPACE</span>
          <span className="orbit-label label-time">TIME</span>
          <span className="orbital-caption">A message you can step into.</span>
        </div>
      </div>
      <div className="stats-strip">
        <a href="#/ideas">
          <strong>{ideas.length}</strong>
          <span>ideas to explore</span>
        </a>
        <a href="#/wiki">
          <strong>{concepts.length}</strong>
          <span>concepts taking shape</span>
        </a>
        <a href="#/prds">
          <strong>{prds.length}</strong>
          <span>product briefs</span>
        </a>
        <a href="#/bugs">
          <strong>{bugs.length.toString().padStart(2, "0")}</strong>
          <span>open bugs</span>
        </a>
      </div>
      <section className="approach-section">
        <div className="section-label">
          <span className="eyebrow">01 / HOW WE THINK</span>
          <span>Ambitious vision. Observable progress.</span>
        </div>
        {approach && (
          <>
            <Markdown content={approach.content} source={approach.path} />
            <Source path={approach.path} />
          </>
        )}
      </section>
      <section className="bottom-section">
        <div className="section-label">
          <span className="eyebrow">02 / KEEP EXPLORING</span>
        </div>
        <div className="document-grid">
          {[
            "docs/product/VISION.md",
            "docs/product/research/open-questions.md",
            "docs/product/research/conversation-coverage.md",
          ]
            .map((path) => byPath.get(path))
            .filter((doc): doc is KnowledgeDocument => !!doc)
            .map((doc) => (
              <DocumentCard key={doc.path} doc={doc} />
            ))}
        </div>
      </section>
    </>
  );
}
