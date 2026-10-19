import { isValidElement, useEffect } from "react";
import { Diagram } from "./Diagram";
import type { Root } from "mdast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { headingId, localImage, nodeText, resolveLink } from "./knowledge";

function headingAnchors() {
  return (tree: Root) => {
    const counts = new Map<string, number>();
    for (const node of tree.children) {
      if (node.type !== "heading") continue;
      const slug = headingId(nodeText(node));
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      node.data = {
        ...node.data,
        hProperties: { id: `${slug}${count ? `-${count}` : ""}` },
      };
    }
  };
}

export function Markdown({
  content,
  source,
  section,
}: {
  content: string;
  source: string;
  section?: string | undefined;
}) {
  useEffect(() => {
    if (section)
      document.getElementById(section)?.scrollIntoView({ block: "start" });
  }, [section, content]);
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, headingAnchors]}
        skipHtml
        components={{
          pre: ({ children }) => {
            if (
              isValidElement<{ className?: string; children?: string }>(
                children,
              ) &&
              children.props.className === "language-mermaid"
            ) {
              return (
                <Diagram
                  definition={String(children.props.children ?? "").trimEnd()}
                  label="Diagram from repository Markdown"
                />
              );
            }
            return <pre>{children}</pre>;
          },
          a: ({ href, children }) => {
            const resolved = href ? resolveLink(source, href) : null;
            if (!resolved)
              return <span className="unavailable-link">{children}</span>;
            const external = /^(https?:|mailto:)/.test(resolved);
            return (
              <a
                href={resolved}
                {...(external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
              >
                {children}
                {external && <span aria-label=" (external link)"> ↗</span>}
              </a>
            );
          },
          // Remote images never fetch; only pre-bundled local raster assets display.
          img: ({ alt, src }) => {
            const image = src ? localImage(source, src) : undefined;
            return image ? (
              <img
                className="repository-image"
                src={image}
                alt={alt || "Repository illustration"}
                loading="lazy"
              />
            ) : (
              <span className="image-reference">
                Image: {alt || src || "source reference"}
              </span>
            );
          },
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
