import type { ReactNode } from "react";
import { docUrl } from "./knowledge";
import type { KnowledgeDocument } from "./knowledge";
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </header>
  );
}
export function Source({ path }: { path: string }) {
  return (
    <a className="source-link" href={docUrl(path)}>
      <span aria-hidden="true">↗</span> {path}
    </a>
  );
}
export function DocumentCard({ doc }: { doc: KnowledgeDocument }) {
  return (
    <a className="document-card" href={docUrl(doc.path)}>
      <div className="card-top">
        <Badge>{doc.kind}</Badge>
        {doc.status && <span className="small-meta">{doc.status}</span>}
        <span className="arrow">↗</span>
      </div>
      <h3>{doc.title.replace(/^PRD:\s*/, "")}</h3>
      <span className="card-path">{doc.path.split("/").at(-1)}</span>
    </a>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">✳</span>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="button" onClick={action}>
        Clear filters
      </button>
    </div>
  );
}
export function NotFound({ path }: { path: string }) {
  return (
    <div className="empty-state">
      <h1>Document not found.</h1>
      <p>The source may have moved or is outside the knowledge collection.</p>
      <code>{path}</code>
      <a className="button" href="#/">
        Return to the atlas
      </a>
    </div>
  );
}

export function GuideUnavailable() {
  return (
    <section className="empty-state">
      <h1>Reading guide unavailable.</h1>
      <p>
        The source guide is missing or incomplete. The knowledge is still
        accessible.
      </p>
      <div className="quiet-links">
        <a href={docUrl("docs/product/concepts/what-a-hologram-is.md")}>
          Hologram model
        </a>
        <a href="#/ideas?layer=all">All ideas</a>
        <a href={docUrl("docs/product/APPROACH.md")}>Full approach</a>
      </div>
    </section>
  );
}
