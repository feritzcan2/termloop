import type { EnvironmentDeployState } from "@termloop/contract/current";

import { Icon } from "./Icon.js";
import { ENVIRONMENT_STATES, type EnvironmentDraft } from "./project-manager-ticket.js";

const SUGGESTED_ENVIRONMENTS = ["Dev", "Staging", "Production"];
const MAX_ENVIRONMENTS = 12;

/// The environments a Task's change ships through, each with whether it got
/// there and short evidence.
export function ProjectManagerTicketEnvironments(props: {
  environments: readonly EnvironmentDraft[];
  disabled: boolean;
  change(environments: EnvironmentDraft[]): void;
}) {
  const { environments } = props;
  const update = (index: number, patch: Partial<EnvironmentDraft>) => props.change(
    environments.map((environment, position) => position === index ? { ...environment, ...patch } : environment),
  );
  const add = (name: string) => props.change([...environments, { name, state: "unknown", detail: "" }]);
  const missing = SUGGESTED_ENVIRONMENTS.filter((name) =>
    !environments.some((environment) => environment.name.trim().toLowerCase() === name.toLowerCase()));
  const room = environments.length < MAX_ENVIRONMENTS;
  return <section className="pm-doc-section" aria-label="Environments">
    <div className="pm-doc-section-head">
      <h2>Environments</h2>
      <div className="pm-env-add">
        {room ? missing.map((name) => <button key={name} type="button" className="pm-chip" disabled={props.disabled} onClick={() => add(name)}>
          <Icon name="add" />{name}
        </button>) : null}
        {room ? <button type="button" className="pm-chip" disabled={props.disabled} onClick={() => add("")}>
          <Icon name="add" />Other
        </button> : null}
      </div>
    </div>
    {environments.length === 0
      ? <p className="td-note">No environment yet. The Task Agent adds the ones the change ships through.</p>
      : <ul className="pm-env-rows">
        {environments.map((environment, index) => <li key={index} className={`pm-env-row ${environment.state}`}>
          <i className="pm-env-dot" aria-hidden="true" />
          <input aria-label="Environment name" className="pm-env-name" value={environment.name} placeholder="Environment" maxLength={120} disabled={props.disabled}
            onChange={(event) => update(index, { name: event.target.value })} />
          <select aria-label={`${environment.name || "Environment"} state`} value={environment.state} disabled={props.disabled}
            onChange={(event) => update(index, { state: event.target.value as EnvironmentDeployState })}>
            {ENVIRONMENT_STATES.map((state) => <option key={state.value} value={state.value}>{state.label}</option>)}
          </select>
          <input aria-label={`${environment.name || "Environment"} detail`} className="pm-env-detail" value={environment.detail} placeholder="Version, date, or run" maxLength={120} disabled={props.disabled}
            onChange={(event) => update(index, { detail: event.target.value })} />
          <button type="button" className="icon-button quiet" aria-label={`Remove ${environment.name || "environment"}`} disabled={props.disabled}
            onClick={() => props.change(environments.filter((_, position) => position !== index))}>
            <Icon name="close" />
          </button>
        </li>)}
      </ul>}
  </section>;
}

/// A textarea that grows with its content, for blockers and notes.
export function ProjectManagerTicketText(props: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  tone?: "warning";
  change(value: string): void;
}) {
  return <section className={`pm-doc-section${props.tone ? ` ${props.tone}` : ""}`} aria-label={props.label}>
    <div className="pm-doc-section-head"><h2>{props.label}</h2></div>
    <textarea
      className="pm-doc-text"
      aria-label={props.label}
      value={props.value}
      rows={Math.min(12, Math.max(2, props.value.split("\n").length + 1))}
      maxLength={4000}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => props.change(event.target.value)}
    />
  </section>;
}
