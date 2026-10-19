import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.js";
import "./steward-how-it-works.css";

/// The "How it works?" button and the explanation it opens.
export function StewardHowItWorksButton(props: { className: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={props.className} aria-haspopup="dialog"
      title="How the Playbook and Steward work" onClick={() => setOpen(true)}>How it works?</button>
    {/* Rendered at the document root so a narrow or clipped sidebar never
        constrains the dialog. */}
    {open ? createPortal(<StewardHowItWorks close={() => setOpen(false)} />, document.body) : null}
  </>;
}

/// A static explanation of how the Playbook and Steward work together. It
/// describes product behavior only; it reads no Project state.
export function StewardHowItWorks(props: { close(): void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeRef.current?.focus(); }, []);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.close();
  };
  return <div className="shiw-layer" onKeyDown={keyDown}>
    <button type="button" className="shiw-backdrop" aria-label="Close how it works" onClick={props.close} />
    <section className="shiw-dialog" role="dialog" aria-modal="true" aria-labelledby="shiw-title">
      <header>
        <div><small>Project Steward</small><h2 id="shiw-title">How the Playbook and Steward work</h2></div>
        <button ref={closeRef} type="button" className="icon-button quiet" aria-label="Close how it works" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="shiw-body">
        <p className="shiw-lead">The Playbook sets the rules. TermLoop checks each step with its own evaluators. The Steward acts on the results.</p>

        <h3>The parts</h3>
        <ul>
          <li><strong>Playbook:</strong> the Project’s delivery pipeline, an ordered list of steps.</li>
          <li><strong>Step Routine:</strong> each step has a completion rule, a while-waiting mode of <em>off</em>, <em>ask</em>, or <em>auto</em>, and instructions for the Steward.</li>
          <li><strong>Evaluator:</strong> a temporary agent that checks one step for one Task. It only observes and never changes anything.</li>
          <li><strong>Steward:</strong> the Project manager. It never evaluates steps. It acts on their results.</li>
          <li><strong>Task Agent:</strong> the developer agent that does the work.</li>
        </ul>

        <h3>How a Task moves through the pipeline</h3>
        <ol>
          <li><strong>Position.</strong> A Task stands at the first step it has not passed. The steps it already passed, including ones you set by hand, are its passed earlier steps.</li>
          <li><strong>Scheduling.</strong> When a step is due, TermLoop starts the check itself. It does not wait for the Steward to be idle. Up to 8 checks run at once per Project. The Steward only has to be enabled; turning it off pauses Playbook automation.</li>
          <li><strong>Choosing the evaluator.</strong> TermLoop first forks the agent that worked most on the Task, because it knows where the evidence is. If there is no agent to fork, it starts a fresh evaluator with your last agent’s provider, in the Task’s worktree or else the Project folder. If neither is possible, the step shows as waiting and is retried later.</li>
          <li><strong>Evaluation.</strong> The evaluator reads the step and the Task, then checks evidence live in the repository, pull requests, the issue tracker, or CI. It does not re-check earlier steps; it treats them as passed. It reports <em>satisfied</em>, <em>pending</em>, or <em>blocked</em> with short evidence and then closes.</li>
        </ol>

        <h3>What happens with the result</h3>
        <ul>
          <li><strong>Satisfied:</strong> the pass is recorded and the Task moves to the next step. The Steward is woken and posts a short status update. When a Task passes the final step, the Steward proposes once to close it. It closes the Task only if you approve, and never asks again if you decline.</li>
          <li><strong>Pending or blocked:</strong> the Task stays at the step and is checked again after the retry delay. What follows depends on the step’s mode:
            <ul>
              <li><em>Off:</em> it waits silently. Nothing reaches the Steward.</li>
              <li><em>Ask:</em> the Steward receives a finding and makes one proposal, or tells you when the next action is yours.</li>
              <li><em>Auto:</em> the Steward receives a finding and performs the authorized action itself, such as an issue transition, or hands the missing work to the Task Agent.</li>
            </ul>
          </li>
          <li>The Steward never disputes an evaluator’s verdict or re-judges the step. After it acts, the next evaluation verifies the result. The Steward can never declare a step passed.</li>
        </ul>

        <h3>When a running check is discarded</h3>
        <p>A check’s report is rejected if the step’s Routine was edited, the Task left that step, the Task was closed or archived, or its worktree changed. A Steward restart, model change, or long turn no longer affects running checks.</p>

        <h3>Editing the Playbook</h3>
        <ul>
          <li>A new step added behind a Task counts as passed for that Task, so it never moves back.</li>
          <li>Editing one step does not disturb running checks of other steps.</li>
          <li>You can set a Task’s position by hand, or check a step immediately with Run now.</li>
        </ul>

        <h3>The Steward’s other work</h3>
        <ul>
          <li>It answers your messages.</li>
          <li>It runs its own scheduled Routines. These are periodic scans, not pipeline steps.</li>
          <li>It reviews Task Agent reports and asks the agent to continue when work is incomplete.</li>
        </ul>

        <h3>What you see</h3>
        <ul>
          <li>A ✦ badge on an agent’s row means an evaluator is checking its work. Click it to open the evaluator.</li>
          <li>A step shows Checking · Task agent, Checking · Evaluator, or Waiting.</li>
          <li>History lists every check with its evaluator, outcome, and evidence.</li>
        </ul>
      </div>
    </section>
  </div>;
}
