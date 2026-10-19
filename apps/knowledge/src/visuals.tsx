import { useReadingState } from "./useReadingState";
import { docUrl, ideas } from "./knowledge";
import {
  connections,
  guideDiagram,
  example,
  ideaLabel,
  ideaStatus,
  layers,
  viewModes,
  wireframe,
} from "./guide";
import { Badge } from "./components";
import { Diagram } from "./Diagram";

export function Backbone({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (key: string) => void;
}) {
  return (
    <section className="backbone" aria-label="Three layers of one hologram">
      <div className="diagram-caption">
        <span className="eyebrow">ONE HOLOGRAM, THREE LAYERS</span>
        <span>The event stays intact.</span>
      </div>
      <Diagram
        definition={guideDiagram("Backbone Map")}
        label="Event, meaning and view remain connected"
      />
      <div className="layer-map" role="group" aria-label="Hologram layers">
        {layers.map((layer) => (
          <button
            key={layer.Key}
            id={`layer-${layer.Key}`}
            aria-pressed={selected === layer.Key}
            aria-controls="layer-explanation"
            className={`layer-node ${selected === layer.Key ? "selected" : ""}`}
            onClick={() => onSelect(layer.Key!)}
          >
            <span className="layer-number">{layer.Number}</span>
            <strong>{layer.Title}</strong>
            <span>{layer.Question}</span>
          </button>
        ))}
      </div>

      {layers
        .filter((layer) => layer.Key === selected)
        .map((layer) => (
          <div
            className="layer-explanation"
            role="region"
            id="layer-explanation"
            aria-labelledby={`layer-${selected}`}
            key={selected}
          >
            <p>{layer.Detail}</p>
            <a className="text-link" href={docUrl(layer.Source!)}>
              Read the source ↗
            </a>
          </div>
        ))}
    </section>
  );
}

export function ExampleWireframe({
  layer,
  setLayer,
  title,
  intro,
}: {
  layer: string;
  setLayer: (key: string) => void;
  title: string;
  intro: string;
}) {
  const [mode, setMode] = useReadingState("view-mode", "Follow");
  const [angle, setAngle] = useReadingState("view-angle", 0);
  const beat = example.find((row) => row.Layer === layer) ?? example[0];
  return (
    <section
      className="example-section"
      aria-label="Illustrative hologram wireframe"
    >
      <div className="example-copy">
        <span className="eyebrow">SEE IT IN ONE EXPLANATION</span>
        <h2>{title}</h2>
        <p>{intro}</p>
        <div className="example-steps">
          {example.map((step, index) => (
            <button
              key={step.Layer}
              aria-pressed={layer === step.Layer}
              onClick={() => setLayer(step.Layer!)}
            >
              <span>0{index + 1}</span>
              {step.Label}
            </button>
          ))}
        </div>
      </div>
      <div className="wireframe-card">
        <div className="wireframe-header">
          <span>{wireframe["Sketch label"]}</span>
          <span>{layer}</span>
        </div>
        <div
          className={`wireframe-stage ${mode === "Free" && layer === "View" ? "is-free" : ""}`}
        >
          <div
            className="scene-volume"
            style={{
              transform: `perspective(600px) rotateY(${mode === "Free" && layer === "View" ? angle : 0}deg)`,
            }}
          >
            <div className="scene-floor" />
            <div className="speaker-block">
              <span className="wire-label">{wireframe.Speaker}</span>
              <div className="speech-chip">{wireframe.Speech}</div>
            </div>
            <div className="referent-line">
              <span>
                {layer === "Event"
                  ? wireframe["Recorded reference"]
                  : wireframe["Inferred reference"]}
              </span>
            </div>
            <div
              className={`hinge-block ${layer !== "Event" ? "highlighted" : ""}`}
            >
              <span className="wire-label">{wireframe.Object}</span>
              <span className="hinge-motion">↻</span>
            </div>
            {layer !== "Event" && (
              <span className="inference-label">
                {wireframe["Inference label"]}
              </span>
            )}
            <span className="event-anchor">{wireframe["Event label"]}</span>
          </div>
        </div>
        <div className="wireframe-controls">
          {layer === "View" ? (
            <>
              <div className="segmented" aria-label="Illustrative viewing mode">
                {viewModes.map((view) => (
                  <button
                    key={view.Mode}
                    aria-pressed={mode === view.Mode}
                    onClick={() => setMode(view.Mode!)}
                  >
                    {view.Mode}
                  </button>
                ))}
              </div>
              {mode === "Free" && (
                <label className="view-angle">
                  Viewpoint{" "}
                  <input
                    aria-label="Explore viewpoint in wireframe"
                    type="range"
                    min="-35"
                    max="35"
                    value={angle}
                    onChange={(event) => setAngle(Number(event.target.value))}
                  />
                </label>
              )}
              <p>{viewModes.find((view) => view.Mode === mode)?.Explanation}</p>
            </>
          ) : (
            <p>{beat?.Result}</p>
          )}
        </div>
        <div className="wireframe-disclaimer">{wireframe.Disclaimer}</div>
      </div>
      <details className="wireframe-source">
        <summary>See the source flowchart</summary>
        <Diagram
          definition={guideDiagram("Example Wireframe")}
          label="The recorded event persists while inferred meaning stays anchored and the view changes"
        />
      </details>
    </section>
  );
}

export function RelationshipMap({ focus = "IDEA-032" }: { focus?: string }) {
  const [selection, setSelection] = useReadingState(`relationship-${focus}`, focus);
  const fromIds = [...new Set(connections.map((row) => row.From))];
  const origin = ideas.find((idea) => idea.id === selection);
  const edges = connections.filter((row) => row.From === selection);
  if (!origin || !edges.length) return null;
  return (
    <section className="relationship-section">
      <div className="section-label">
        <h2>How ideas connect</h2>
        <span>Reasoning links, not a delivery plan</span>
      </div>
      <div className="segmented">
        {fromIds.map((id) => {
          const idea = ideas.find((item) => item.id === id);
          return (
            idea && (
              <button
                key={id}
                aria-pressed={selection === id}
                onClick={() => setSelection(id!)}
              >
                {ideaLabel(idea)}
              </button>
            )
          );
        })}
      </div>
      <Diagram
        definition={guideDiagram(
          selection === "IDEA-045" ? "Portal Map" : "Pointing Map",
        )}
        label="Reasoning links between ideas, not a delivery plan"
      />
      <div className="reasoning-map">
        <a className="origin-node" href={`#/idea/${origin.id}`}>
          <span className="eyebrow">{origin.id}</span>
          <strong>{ideaLabel(origin)}</strong>
          <Badge>{ideaStatus(origin)}</Badge>
        </a>
        <div className="reasoning-branches">
          {edges.map((edge) => {
            const target = ideas.find((idea) => idea.id === edge.To);
            return (
              target && (
                <div className="reasoning-edge" key={edge.To}>
                  <span className="edge-reason">{edge.Relationship}</span>
                  <a href={`#/idea/${target.id}`}>
                    <span>{ideaLabel(target)}</span>
                    <small>
                      {target.id} · {ideaStatus(target)}
                    </small>
                    <span aria-hidden="true">↗</span>
                  </a>
                </div>
              )
            );
          })}
        </div>
      </div>
      <a
        className="text-link"
        href={docUrl("docs/product/concepts/what-a-hologram-is.md")}
      >
        Where these relationships come from ↗
      </a>
    </section>
  );
}
