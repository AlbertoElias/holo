import { useReadingState } from "../useReadingState";
import { GuideUnavailable } from "../components";
import { Backbone, ExampleWireframe } from "../visuals";
import { guidePath, layers, opening, wireframe } from "../guide";
import { docUrl } from "../knowledge";

export function Overview() {
  const [selected, setSelected] = useReadingState("home-layer", "Event");
  if (layers.length < 3 || !opening.Title || !wireframe.Speech)
    return <GuideUnavailable />;
  return (
    <>
      <header className="narrative-intro">
        <span className="eyebrow">START WITH THE BACKBONE</span>
        <h1>{opening.Title || "Understand the medium."}</h1>
        <p>{opening.Intro}</p>
      </header>
      <Backbone selected={selected} onSelect={setSelected} />
      <ExampleWireframe
        layer={selected}
        setLayer={setSelected}
        title={opening["Example title"] || ""}
        intro={opening["Example intro"] || ""}
      />
      <div className="next-paths">
        <a href="#/ideas">
          <span className="eyebrow">EXPLORE THE POSSIBILITY SPACE</span>
          <h2>Where do the ideas fit?</h2>
          <p>Find a territory, then follow an idea.</p>
          <span className="path-arrow" aria-hidden="true">
            ↗
          </span>
        </a>
        <a href="#/process">
          <span className="eyebrow">TURN CURIOSITY INTO EVIDENCE</span>
          <h2>What should we try?</h2>
          <p>Walk through one useful learning loop.</p>
          <span className="path-arrow" aria-hidden="true">
            ↗
          </span>
        </a>
      </div>
      <footer className="quiet-source">
        <a href={docUrl(guidePath)}>Reading guide ↗</a>
        <a href={docUrl("docs/product/APPROACH.md")}>Full approach ↗</a>
      </footer>
    </>
  );
}
