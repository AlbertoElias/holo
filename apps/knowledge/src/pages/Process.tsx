import { useReadingState } from "../useReadingState";
import { GuideUnavailable } from "../components";
import { agentRoles, guideDiagram, opening, processSteps } from "../guide";
import { Diagram } from "../Diagram";
import { docUrl } from "../knowledge";

export function Process() {
  const [active, setActive] = useReadingState("process-step", 0);
  const step = processSteps[active] ?? processSteps[0];
  if (!processSteps.length || !opening["Process title"])
    return <GuideUnavailable />;
  return (
    <>
      <header className="narrative-intro">
        <span className="eyebrow">HOW WE TEST AN IDEA</span>
        <h1>{opening["Process title"]}</h1>
        <p>{opening["Process intro"]}</p>
      </header>
      <section aria-label="Learning loop" className="process-section">
        <Diagram
          definition={guideDiagram("Learning Loop")}
          label="Problem to bet to trial to evidence to decision, with a revision loop"
        />
        <div className="process-map" role="group" aria-label="Experiment steps">
          {processSteps.map((item, index) => (
            <button
              key={item.Step}
              id={`process-${index}`}
              aria-pressed={active === index}
              aria-controls="process-detail"
              onClick={() => setActive(index)}
            >
              <span>{item.Step}</span>
              <strong>{item.Title}</strong>
            </button>
          ))}
        </div>
        {step && (
          <div
            className="process-detail"
            role="region"
            id="process-detail"
            aria-labelledby={`process-${active}`}
          >
            <span className="eyebrow">
              {step.Step} / {step.Title}
            </span>
            <h2>{step.Prompt}</h2>
            <p>{step.Detail}</p>
            <a className="text-link" href={docUrl(step.Source!)}>
              Full guidance ↗
            </a>
          </div>
        )}
        <div className="loop-return">
          ↶ Revise the idea when the evidence changes it.
        </div>
      </section>
      <section className="agent-section">
        <div className="section-label">
          <h2>Give each agent a clear job.</h2>
          <a className="text-link" href={docUrl("docs/FEATURE_WORKFLOW.md")}>
            Delivery workflow ↗
          </a>
        </div>
        <div className="agent-flow">
          {agentRoles.map((role) => (
            <div key={role.Role}>
              <span className="eyebrow">{role.Role}</span>
              <h3>{role.Job}</h3>
              <p>{role.Output}</p>
            </div>
          ))}
        </div>
      </section>
      <p className="small-note">
        This is a process template. Actual evidence and decisions belong to the
        relevant PRD or feature brief.
      </p>
    </>
  );
}
