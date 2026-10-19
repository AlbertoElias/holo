import { useEffect, useState } from "react";
import { byPath, bugs, docUrl, documents } from "./knowledge";
import { NotFound } from "./components";
import { Overview } from "./pages/Overview";
import { IdeaGarden, IdeaDetail } from "./pages/Ideas";
import { Library } from "./pages/Library";
import { Bugs } from "./pages/Bugs";
import { DocumentReader } from "./pages/Documents";
const navigation = [
  { route: "/", title: "Our approach", icon: "◉", detail: "The way forward" },
  {
    route: "/ideas",
    title: "Idea garden",
    icon: "✳",
    detail: "Possibilities, kept alive",
  },
  {
    route: "/wiki",
    title: "Concept wiki",
    icon: "◇",
    detail: "A shared vocabulary",
  },
  {
    route: "/prds",
    title: "Product briefs",
    icon: "▤",
    detail: "Ideas in more detail",
  },
  {
    route: "/bugs",
    title: "Open bugs",
    icon: "⊙",
    detail: "What needs attention",
  },
];
function useRoute() {
  const [hash, setHash] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const listener = () => {
      setHash(location.hash.slice(1) || "/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  return hash;
}
export function App() {
  const route = useRoute();
  const [search, setSearch] = useState("");
  let decoded: string;
  try {
    decoded = decodeURIComponent(route.split("?")[0] ?? "/");
  } catch {
    decoded = "/missing";
  }
  const section =
    new URLSearchParams(route.split("?")[1]).get("section") ?? undefined;
  const docPath = decoded.startsWith("/doc/") ? decoded.slice(5) : null;
  const doc = docPath ? byPath.get(docPath) : null;
  const active = decoded.startsWith("/idea")
    ? "/ideas"
    : doc?.kind === "Concept" || doc?.kind === "Research"
      ? "/wiki"
      : doc?.kind === "PRD"
        ? "/prds"
        : docPath === "BUGS.md"
          ? "/bugs"
          : docPath
            ? "/"
            : decoded;
  useEffect(() => {
    document.title = `${doc?.title ?? navigation.find((item) => item.route === active)?.title ?? "Knowledge Atlas"} / HoloIM`;
  }, [active, doc]);
  return (
    <div className="atlas">
      <aside className="sidebar">
        <a className="brand" href="#/" aria-label="HoloIM Knowledge Atlas home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            HoloIM<small>KNOWLEDGE ATLAS</small>
          </span>
        </a>
        <div className="sidebar-rule" />
        <span className="nav-label">THE EXPLORATION</span>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <a
              key={item.route}
              href={`#${item.route}`}
              aria-current={active === item.route ? "page" : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>
                {item.title}
                <small>{item.detail}</small>
              </span>
              {item.route === "/bugs" && (
                <span className="nav-count">{bugs.length}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="read-only">
            <span /> READ-ONLY BY DESIGN
          </div>
          <p>
            The repository holds the knowledge.
            <br />
            This is a window into it.
          </p>
          <a href={docUrl("docs/product/README.md")}>
            How this knowledge is organized ↗
          </a>
        </div>
      </aside>
      <div className="workspace">
        <div className="topbar">
          <span>
            HOLOIM <span className="slash">/</span>{" "}
            {navigation.find((item) => item.route === active)?.title ??
              "Knowledge Atlas"}
          </span>
          <a href={docUrl("docs/product/README.md")}>
            <span className="live-dot" /> Repository Markdown <span>↗</span>
          </a>
        </div>
        <main
          id="main-content"
          key={decoded.startsWith("/idea/") ? decoded : active}
        >
          {decoded === "/" ? (
            <Overview />
          ) : decoded === "/ideas" ? (
            <IdeaGarden search={search} setSearch={setSearch} />
          ) : decoded.startsWith("/idea/") ? (
            <IdeaDetail id={decoded.slice(6)} />
          ) : decoded === "/wiki" || decoded === "/prds" ? (
            <Library
              mode={decoded === "/wiki" ? "wiki" : "prds"}
              allDocuments={
                new URLSearchParams(route.split("?")[1]).get("collection") ===
                "all"
              }
              key={decoded}
            />
          ) : decoded === "/bugs" ? (
            <Bugs />
          ) : docPath ? (
            <DocumentReader path={docPath} section={section} />
          ) : (
            <NotFound path={decoded} />
          )}
        </main>
        <footer className="app-footer">
          <span>HOLOIM / A MEDIUM IN THE MAKING</span>
          <span>
            {documents.length} source documents · Read, explore, connect.
          </span>
        </footer>
      </div>
    </div>
  );
}
