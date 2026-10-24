import { useState } from "react";
import type { DeliveryProbeDto, ProbeMatcher, ProjectManagerProbeCreateParams } from "@termloop/contract/current";

import { Icon } from "./Icon.js";
import { relativeTime } from "./project-manager-ticket.js";

export type ProjectManagerProbeActions = {
  create(params: Omit<ProjectManagerProbeCreateParams, "projectId">): Promise<string | undefined>;
  approve(probeId: string): Promise<string | undefined>;
  remove(probeId: string): Promise<string | undefined>;
};

const MATCHERS: readonly { value: ProbeMatcher; label: string; hint: string }[] = [
  { value: "commitAncestry", label: "Names the deployed commit", hint: "Tasks whose merge commit it contains are deployed there" },
  { value: "agent", label: "Anything else", hint: "A change in its output starts a delivery check" },
];

const PROBE_FAILURES: Record<string, string> = {
  notFound: "the program is not installed",
  notStarted: "it could not start",
  timedOut: "it timed out",
  failed: "it exited with an error",
  outputTooLarge: "its output was too large",
  noCommit: "its output named no commit",
};

/// Splits a command line into a program and its arguments. Quotes group
/// words; nothing is expanded, and the command never runs in a shell.
export function commandArgv(text: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const character of text.trim()) {
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "\"" || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) argv.push(current);
  return argv;
}

/// The command line a probe runs, quoting arguments with spaces.
export function argvText(argv: readonly string[]): string {
  return argv.map((argument) => /[\s"']/u.test(argument) || argument === "" ? `'${argument.replaceAll("'", "\"")}'` : argument).join(" ");
}

/// The Project's delivery probes: what each environment runs, read by a
/// command TermLoop runs on schedule. A delivery check may propose one; it
/// runs only once approved here.
export function ProjectManagerProbes(props: {
  probes: readonly DeliveryProbeDto[];
  disabled: boolean;
  actions: ProjectManagerProbeActions;
}) {
  const [adding, setAdding] = useState(false);
  const [environment, setEnvironment] = useState("");
  const [command, setCommand] = useState("");
  const [matcher, setMatcher] = useState<ProbeMatcher>("commitAncestry");
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (operation: () => Promise<string | undefined>) => {
    setBusy(true);
    setMessage(undefined);
    const failure = await operation();
    setBusy(false);
    if (failure) setMessage(failure);
    return failure;
  };
  const argv = commandArgv(command);
  const proposed = props.probes.filter((probe) => probe.status === "proposed");
  const approved = props.probes.filter((probe) => probe.status === "approved");
  return <section className="pm-probes" aria-label="Probes">
    <div className="pm-doc-section-head">
      <h3>Probes</h3>
      {!adding ? <button type="button" className="pm-chip" disabled={props.disabled || props.probes.length >= 16} onClick={() => setAdding(true)}>
        <Icon name="add" />Probe
      </button> : null}
    </div>
    <p className="pm-muted">Commands that tell what an environment runs. TermLoop runs approved ones with the delivery facts, without a shell, in the Project folder.</p>
    {message ? <p className="form-error" role="alert">{message}</p> : null}
    {adding ? <form className="pm-probe-form" onSubmit={(event) => {
      event.preventDefault();
      if (!environment.trim() || argv.length === 0) return;
      void run(() => props.actions.create({ environment: environment.trim(), argv, matcher })).then((failure) => {
        if (!failure) {
          setAdding(false);
          setEnvironment("");
          setCommand("");
        }
      });
    }}>
      <input aria-label="Probe environment" placeholder="Environment, such as Staging" maxLength={120} value={environment} onChange={(event) => setEnvironment(event.target.value)} />
      <input aria-label="Probe command" className="pm-probe-command" placeholder="curl -s https://staging.example.com/version" value={command} onChange={(event) => setCommand(event.target.value)} />
      <select aria-label="Probe output" value={matcher} onChange={(event) => setMatcher(event.target.value as ProbeMatcher)}>
        {MATCHERS.map((option) => <option key={option.value} value={option.value} title={option.hint}>{option.label}</option>)}
      </select>
      <button type="submit" className="td-mini" disabled={busy || !environment.trim() || argv.length === 0}>Add</button>
      <button type="button" className="td-mini" onClick={() => setAdding(false)}>Cancel</button>
    </form> : null}
    {props.probes.length === 0 && !adding ? <p className="td-note">No probe yet. A delivery check proposes the ones it finds.</p> : null}
    <ul className="pm-probe-rows">
      {[...proposed, ...approved].map((probe) => <li key={probe.id} className={`pm-probe ${probe.status}`}>
        <div className="pm-probe-main">
          <strong>{probe.environment}</strong>
          <code>{argvText(probe.argv)}</code>
          <span className="pm-dim">{MATCHERS.find((option) => option.value === probe.matcher)?.hint}</span>
          {probe.status === "proposed"
            ? <span className="pm-probe-state">Proposed by a delivery check{probe.reason ? `: ${probe.reason}` : ""}</span>
            : <span className="pm-probe-state">{probeRunText(probe)}</span>}
        </div>
        <div className="pm-probe-actions">
          {probe.status === "proposed" ? <button type="button" className="td-mini" disabled={props.disabled || busy}
            title="Let TermLoop run this command on schedule" onClick={() => void run(() => props.actions.approve(probe.id))}>Approve</button> : null}
          <button type="button" className="td-mini" disabled={props.disabled || busy}
            onClick={() => void run(() => props.actions.remove(probe.id))}>{probe.status === "proposed" ? "Reject" : "Remove"}</button>
        </div>
      </li>)}
    </ul>
  </section>;
}

function probeRunText(probe: DeliveryProbeDto): string {
  const run = probe.lastRun;
  if (!run) return "Not run yet";
  const failure = run.failure ? `Last run ${relativeTime(run.atEpochMs)}: ${PROBE_FAILURES[run.failure] ?? run.failure}` : null;
  const commit = run.deployedCommit ? `Runs ${run.deployedCommit.slice(0, 12)}` : null;
  const seen = `read ${relativeTime(run.atEpochMs)}${run.changedAtEpochMs ? `, changed ${relativeTime(run.changedAtEpochMs)}` : ""}`;
  return failure ?? [commit, seen].filter(Boolean).join(" · ");
}
