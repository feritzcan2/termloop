import { useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { PmEnvironmentProposal, PmProbe } from "@termloop/pm-contract/pm";
import { relativeTime } from "./format.js";

function toggled(list: string[], item: string, on: boolean): string[] {
  return on ? [...list, item] : list.filter((other) => other !== item);
}

/**
 * What the Deployment control setup found, reviewed in one place: each
 * environment in delivery order with the checks that read what it runs. The
 * PM ticks what to keep; nothing is listed or run before Turn on. It is
 * opened from the sidebar but mounted on the body, so it covers the window
 * like the app's other dialogs.
 */
export function EnvironmentSetupDialog(props: {
  proposal: PmEnvironmentProposal;
  now: number;
  /** Resolves true once applied. */
  onApply(environments: string[], probeIds: string[]): Promise<boolean>;
  onDiscard(): void;
  onClose(): void;
}) {
  const { proposal } = props;
  const [environments, setEnvironments] = useState(() => proposal.environments.map((environment) => environment.name));
  const [probeIds, setProbeIds] = useState(() => proposal.probes.map((probe) => probe.id));
  const [applying, setApplying] = useState(false);
  // A check of an unticked environment is not kept.
  const kept = (probe: PmProbe) => probeIds.includes(probe.id) && environments.includes(probe.environment);
  const keptCount = proposal.probes.filter(kept).length;
  const apply = async () => {
    setApplying(true);
    const applied = await props.onApply(environments, proposal.probes.filter(kept).map((probe) => probe.id));
    setApplying(false);
    if (applied) props.onClose();
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };
  return createPortal(
    <div className="modal-backdrop" onKeyDown={keys} onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal env-setup" role="dialog" aria-modal="true" aria-label="Set up Deployment control">
        <div className="modal-head">
          <b>Set up Deployment control</b>
          <span className="meta">found {relativeTime(proposal.createdAtEpochMs, props.now)}</span>
          <span className="sp" />
          <button type="button" className="icb" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <p className="env-summary">{proposal.summary}</p>
        <span className="sec-label">Environments, in delivery order</span>
        <ol className="env-steps">
          {proposal.environments.map((environment) => {
            const on = environments.includes(environment.name);
            const probes = proposal.probes.filter((probe) => probe.environment === environment.name);
            return (
              <li key={environment.name} className={on ? "" : "off"}>
                <label className="env-name">
                  <input
                    type="checkbox"
                    checked={on}
                    aria-label={environment.name}
                    onChange={(event) => setEnvironments(toggled(environments, environment.name, event.target.checked))}
                  />
                  <b>{environment.name}</b>
                  {environment.production && <span className="chip warn">production</span>}
                </label>
                <details className="env-detail">
                  <summary>Where it was found</summary>
                  <p>{environment.evidence}</p>
                </details>
                {probes.length === 0 && <p className="env-none">No check found: a delivery check asks the agent.</p>}
                {probes.map((probe) => (
                  <div key={probe.id} className="env-probe">
                    <label>
                      <input
                        type="checkbox"
                        checked={kept(probe)}
                        disabled={!on}
                        aria-label={`Check ${environment.name}`}
                        onChange={(event) => setProbeIds(toggled(probeIds, probe.id, event.target.checked))}
                      />
                      <span>{probe.reason ?? `Reads what ${environment.name} runs`}</span>
                    </label>
                    <details className="env-detail">
                      <summary>Command</summary>
                      <code>{probe.argv.join(" ")}</code>
                    </details>
                  </div>
                ))}
              </li>
            );
          })}
        </ol>
        <div className="modal-foot">
          <span className="hint">
            {environments.length === 0
              ? "Tick at least one environment."
              : `${environments.length} environment(s), ${keptCount} check(s). Nothing runs until you turn it on.`}
          </span>
          <span className="sp" />
          <button type="button" className="btn sm ghost" onClick={() => { props.onDiscard(); props.onClose(); }}>Discard</button>
          <button type="button" className="btn sm pri" disabled={environments.length === 0 || applying} onClick={() => void apply()}>
            Turn on Deployment control
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
