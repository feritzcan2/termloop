import type { PmPlaybookStep, PmStepCheck } from "@termloop/pm-contract/pm";

/** Mirrors the daemon's Playbook bounds so a save is refused here, not there. */
const STEPS_MAX = 16;
const CHECKS_MAX = 4;
const RETRY_MINUTES_DEFAULT = 30;

/** Never reused, so a removed step's stored answers never land on a new one. */
function newStepId(steps: PmPlaybookStep[]): string {
  const base = `step-${Date.now().toString(36)}`;
  let id = base;
  for (let n = 2; steps.some((step) => step.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/** One fact check in a line, as the PM would say it. */
export function describeCheck(check: PmStepCheck): string {
  if (check.kind === "pullRequest") return `Pull request ${check.state}${check.baseBranch ? ` into ${check.baseBranch}` : ""}`;
  const names = check.names.length > 0 ? check.names.join(", ") : null;
  const category = check.category === "started" ? "any started status" : check.category === "done" ? "any done status" : null;
  return `Jira status: ${[names, category].filter(Boolean).join(" or ")}`;
}

/** The steps as the daemon takes them: labels trimmed, blank status names dropped. */
export function tidySteps(steps: PmPlaybookStep[]): PmPlaybookStep[] {
  return steps.map((step) => ({
    ...step,
    title: step.title.trim(),
    checks: step.checks.map((check) => check.kind === "status"
      ? { ...check, names: check.names.map((name) => name.trim()).filter(Boolean) }
      : { ...check, baseBranch: check.baseBranch?.trim() || null }),
    agent: step.agent && { ...step.agent, instructions: step.agent.instructions.trim() },
  }));
}

/** Why the steps cannot be saved yet, or undefined when they can. */
export function stepsProblem(steps: PmPlaybookStep[]): string | undefined {
  if (steps.length === 0) return "Keep at least one step.";
  const tidy = tidySteps(steps);
  if (tidy.some((step) => step.title === "")) return "Give every step a title.";
  if (tidy.some((step) => step.checks.some((check) => check.kind === "status" && check.names.length === 0 && check.category === null))) {
    return "A Jira status check needs a status name or a category.";
  }
  if (tidy.some((step) => step.agent?.instructions === "")) return "Tell each agent step what to look for.";
  return undefined;
}

/**
 * The Playbook's steps in order, each with the facts that pass it and,
 * optionally, what an agent looks for. A step with neither passes only when
 * the PM marks it.
 */
export function PlaybookStepsEditor(props: { steps: PmPlaybookStep[]; onChange(steps: PmPlaybookStep[]): void }) {
  const { steps } = props;
  const edit = (index: number, change: Partial<PmPlaybookStep>) => props.onChange(steps.map((step, at) => at === index ? { ...step, ...change } : step));
  const move = (index: number, delta: number) => {
    const next = [...steps];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    props.onChange(next);
  };
  return (
    <div className="playbook-editor">
      <ol className="playbook-steps">
        {steps.map((step, index) => (
          <li key={step.id} className="playbook-step">
            <div className="playbook-step-head">
              <span className="playbook-step-n">{index + 1}</span>
              <input aria-label={`Step ${index + 1} title`} value={step.title} placeholder="Step title" onChange={(event) => edit(index, { title: event.target.value })} />
              <button type="button" className="icb" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className="icb" aria-label="Move down" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" className="icb" aria-label={`Remove step ${index + 1}`} disabled={steps.length === 1} onClick={() => props.onChange(steps.filter((_, at) => at !== index))}>×</button>
            </div>
            <ul className="playbook-checks">
              {step.checks.map((check, at) => (
                <CheckRow
                  key={at}
                  check={check}
                  onChange={(next) => edit(index, { checks: step.checks.map((item, i) => i === at ? next : item) })}
                  onRemove={() => edit(index, { checks: step.checks.filter((_, i) => i !== at) })}
                />
              ))}
            </ul>
            <div className="playbook-step-actions">
              <button
                type="button"
                className="link"
                disabled={step.checks.length >= CHECKS_MAX}
                onClick={() => edit(index, { checks: [...step.checks, { kind: "status", names: [], category: "done" }] })}
              >
                + Fact check
              </button>
              <label className="check">
                <input
                  type="checkbox"
                  checked={step.agent !== null}
                  onChange={(event) => edit(index, { agent: event.target.checked ? { instructions: "", retryMinutes: RETRY_MINUTES_DEFAULT } : null })}
                />
                An agent checks this step
              </label>
            </div>
            {step.agent && (
              <div className="playbook-agent">
                <textarea
                  aria-label={`Step ${index + 1} agent instructions`}
                  rows={4}
                  placeholder="What the agent reads, from where, and what counts as passed. It never changes anything."
                  value={step.agent.instructions}
                  onChange={(event) => edit(index, { agent: { ...step.agent!, instructions: event.target.value } })}
                />
                <label className="field inline">
                  <span>Looks again after</span>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    aria-label={`Step ${index + 1} retry minutes`}
                    value={step.agent.retryMinutes}
                    onChange={(event) => edit(index, { agent: { ...step.agent!, retryMinutes: Math.min(1440, Math.max(5, Number(event.target.value) || RETRY_MINUTES_DEFAULT)) } })}
                  />
                  <span>minutes while waiting</span>
                </label>
              </div>
            )}
            {step.checks.length === 0 && !step.agent && <p className="hint">Passes only when you mark it.</p>}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn sm"
        disabled={steps.length >= STEPS_MAX}
        onClick={() => props.onChange([...steps, { id: newStepId(steps), title: "", checks: [], agent: null }])}
      >
        Add step
      </button>
    </div>
  );
}

function CheckRow(props: { check: PmStepCheck; onChange(check: PmStepCheck): void; onRemove(): void }) {
  const { check } = props;
  return (
    <li className="playbook-check">
      <select
        aria-label="Check kind"
        value={check.kind}
        onChange={(event) => props.onChange(event.target.value === "pullRequest"
          ? { kind: "pullRequest", state: "merged", baseBranch: null }
          : { kind: "status", names: [], category: "done" })}
      >
        <option value="status">Jira status</option>
        <option value="pullRequest">Pull request</option>
      </select>
      {check.kind === "status" ? (
        <>
          <input
            key={check.names.join("\n")}
            aria-label="Status names"
            placeholder="Status names, comma separated"
            defaultValue={check.names.join(", ")}
            onBlur={(event) => props.onChange({ ...check, names: event.target.value.split(",").map((name) => name.trim()).filter(Boolean) })}
          />
          <select
            aria-label="Status category"
            value={check.category ?? ""}
            onChange={(event) => props.onChange({ ...check, category: event.target.value === "" ? null : event.target.value as "started" | "done" })}
          >
            <option value="">or no category</option>
            <option value="started">or any started status</option>
            <option value="done">or any done status</option>
          </select>
        </>
      ) : (
        <>
          <select aria-label="Pull request state" value={check.state} onChange={(event) => props.onChange({ ...check, state: event.target.value as "open" | "merged" })}>
            <option value="open">open</option>
            <option value="merged">merged</option>
          </select>
          <input
            aria-label="Base branch"
            placeholder="into any branch"
            value={check.baseBranch ?? ""}
            onChange={(event) => props.onChange({ ...check, baseBranch: event.target.value === "" ? null : event.target.value })}
          />
        </>
      )}
      <button type="button" className="icb" aria-label={`Remove check: ${describeCheck(check)}`} onClick={props.onRemove}>×</button>
    </li>
  );
}
