import { Icon } from "./Icon.js";

export type WorkflowStartingPoint = "simple" | "reviewed" | "discussed";

const startingPoints = [
  { id: "simple", title: "Start simple", description: "One agent builds and verifies. Add your own steps as you go.", steps: ["Implement"], count: 1 },
  { id: "reviewed", title: "Build & review", description: "Build, get an independent review, then fix any findings.", steps: ["Implement", "Review", "Fix if needed"], count: 3 },
  { id: "discussed", title: "Discuss, build & review", description: "Discuss the approach first, then build and get two reviews in parallel.", steps: ["Discuss", "Implement", "2 reviewers", "Fix if needed"], count: 5 },
] as const;

export function WorkflowTemplateStarter(props: { choose(start: WorkflowStartingPoint): void }) {
  return <div className="workflow-starter">
    <div className="workflow-starter-intro">
      <span className="workflow-starter-icon"><Icon name="branch" /></span>
      <h3>How should your workflow start?</h3>
      <p>Choose a starting point, then make it yours. These are examples, not your saved templates.</p>
    </div>
    <div className="workflow-starter-options" aria-label="Workflow starting points">
      {startingPoints.map((start) => <button
        key={start.id}
        type="button"
        className="workflow-starter-card"
        aria-label={start.title}
        onClick={() => props.choose(start.id)}
      >
        <span className="workflow-starter-card-head"><strong>{start.title}</strong><small>{start.count} {start.count === 1 ? "step" : "steps"}</small></span>
        <span className="workflow-starter-description">{start.description}</span>
        <span className="workflow-starter-route">{start.steps.map((step, index) => <span key={step}>{index ? <i aria-hidden="true">→</i> : null}<b>{step}</b></span>)}</span>
        <span className="workflow-starter-action">Customize this workflow <span aria-hidden="true">→</span></span>
      </button>)}
    </div>
    <p className="workflow-starter-help">Creating a template does not run any agents. After saving, choose <strong>Run workflow</strong> in a Task and enter its goal.</p>
  </div>;
}
