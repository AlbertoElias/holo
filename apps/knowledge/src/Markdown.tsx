import { useEffect } from "react";
import type { Root } from "mdast";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { headingId, nodeText, resolveLink } from "./knowledge";

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
          // Repository images may reference private captures or arbitrary URLs. Keep them as links.
          img: ({ alt, src }) => (
            <span className="image-reference">
              Image: {alt || src || "source reference"}
            </span>
          ),
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
