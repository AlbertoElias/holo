import { useEffect, useId, useState } from "react";

let rendering = Promise.resolve();
/** Serialize Mermaid's DOM-based renderer; only its sanitized, inert SVG image is displayed. */
export function Diagram({
  definition,
  label,
}: {
  definition: string;
  label: string;
}) {
  const id = `diagram-${useId().replace(/[^a-z0-9]/gi, "")}`;
  const [result, setResult] = useState<{
    source: string;
    url?: string;
    error?: string;
  }>();
  useEffect(() => {
    let cancelled = false;
    rendering = rendering.then(async () => {
      if (cancelled || !definition) return;
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          flowchart: { htmlLabels: false },
          themeVariables: {
            fontFamily: "Trebuchet MS, sans-serif",
            primaryColor: "#eef3e5",
            primaryTextColor: "#193f3b",
            primaryBorderColor: "#7f9c83",
            lineColor: "#7f9c83",
            secondaryColor: "#fffef9",
            tertiaryColor: "#f6f5ef",
          },
        });
        const { svg } = await mermaid.render(id, definition);
        if (!cancelled)
          setResult({
            source: definition,
            url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          });
      } catch {
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled)
          setResult({
            source: definition,
            error: "Diagram unavailable. Read its Markdown definition below.",
          });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [definition, id]);
  const current = result?.source === definition ? result : undefined;
  if (!definition)
    return (
      <p className="small-note">Diagram not defined in the source guide.</p>
    );
  return (
    <figure className="source-diagram" aria-label={label}>
      {current?.url ? (
        <img src={current.url} alt={label} />
      ) : (
        <p role="status">{current?.error ?? "Drawing from Markdown…"}</p>
      )}
      <details>
        <summary>Diagram source</summary>
        <pre>
          <code>{definition}</code>
        </pre>
      </details>
    </figure>
  );
}
