import { useEffect, useState } from "react";
import type { ProjectEnvironmentDto } from "@termloop/contract/current";

import { Icon } from "./Icon.js";

const ENVIRONMENTS_MAX = 12;

/// The Project's environments in delivery order, and which one is
/// production. Stages and risks read this list; without one, an environment
/// whose name contains "prod" counts as production.
export function ProjectManagerEnvironments(props: {
  environments: readonly ProjectEnvironmentDto[];
  disabled: boolean;
  save(environments: ProjectEnvironmentDto[]): Promise<string | undefined>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProjectEnvironmentDto[]>([]);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setDraft([...props.environments]); }, [props.environments, editing]);
  const names = draft.map((environment) => environment.name.trim().toLowerCase());
  const valid = names.every((name, index) => name.length > 0 && names.indexOf(name) === index);
  const change = (index: number, patch: Partial<ProjectEnvironmentDto>) =>
    setDraft((current) => current.map((environment, position) => position === index ? { ...environment, ...patch } : environment));
  const move = (index: number, offset: number) => setDraft((current) => {
    const next = [...current];
    const [moved] = next.splice(index, 1);
    next.splice(index + offset, 0, moved!);
    return next;
  });
  const save = async () => {
    setBusy(true);
    setMessage(undefined);
    const failure = await props.save(draft.map((environment) => ({ name: environment.name.trim(), production: environment.production })));
    setBusy(false);
    if (failure) setMessage(failure);
    else setEditing(false);
  };
  return <section className="pm-environments" aria-label="Environments">
    <header>
      <h3>Environments</h3>
      {!editing ? <button type="button" className="secondary-button" disabled={props.disabled} onClick={() => setEditing(true)}>
        {props.environments.length === 0 ? "Set up" : "Edit"}
      </button> : null}
    </header>
    {message ? <p className="form-error" role="alert">{message}</p> : null}
    {!editing ? props.environments.length === 0
      ? <p className="pm-muted">No list yet. An environment whose name contains “prod” counts as production.</p>
      : <ol className="pm-environment-list">
        {props.environments.map((environment) => <li key={environment.name}>
          {environment.name}{environment.production ? <span className="pm-environment-production">Production</span> : null}
        </li>)}
      </ol>
      : <form className="pm-environment-form" onSubmit={(event) => { event.preventDefault(); if (valid) void save(); }}>
        <ol>
          {draft.map((environment, index) => <li key={index}>
            <input
              aria-label={`Environment ${index + 1}`}
              maxLength={120}
              value={environment.name}
              placeholder="Staging"
              onChange={(event) => change(index, { name: event.target.value })}
            />
            <label>
              <input type="checkbox" checked={environment.production} onChange={(event) => change(index, { production: event.target.checked })} />
              Production
            </label>
            <button type="button" className="td-mini" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="td-mini" aria-label="Move down" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="td-mini" aria-label="Remove" onClick={() => setDraft((current) => current.filter((_, position) => position !== index))}><Icon name="close" /></button>
          </li>)}
        </ol>
        <div className="pm-environment-actions">
          <button type="button" className="td-mini" disabled={draft.length >= ENVIRONMENTS_MAX}
            onClick={() => setDraft((current) => [...current, { name: "", production: false }])}><Icon name="add" />Environment</button>
          <button type="submit" className="td-mini" disabled={busy || !valid}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" className="td-mini" onClick={() => { setEditing(false); setMessage(undefined); }}>Cancel</button>
        </div>
      </form>}
  </section>;
}
