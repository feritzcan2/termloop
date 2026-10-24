import { useEffect, useMemo, useState } from "react";
import { diffWordsWithSpace } from "diff";
import type { ProjectManagerTicketVersionsResult, TaskTicketVersionDto } from "@termloop/contract/current";

import { Icon } from "./Icon.js";
import { relativeTime, ticketFieldChanges } from "./project-manager-ticket.js";

export function ticketAuthorLabel(author: TaskTicketVersionDto["author"]): string {
  return author === "agent" ? "Agent" : "You";
}

/// One ticket's kept versions, newest first. Selecting a version shows what
/// it changed from the one before; any older version can be restored as the
/// newest.
export function ProjectManagerTicketHistory(props: {
  taskId: string;
  headVersion: number | null;
  disabled: boolean;
  load(taskId: string): Promise<ProjectManagerTicketVersionsResult>;
  restore(number: number): Promise<string | undefined>;
  close(): void;
}) {
  const [versions, setVersions] = useState<readonly TaskTicketVersionDto[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<number>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    props.load(props.taskId).then(
      (result) => {
        if (!active) return;
        setVersions(result.versions);
        setError(undefined);
        setSelected((current) => current !== undefined && result.versions.some((version) => version.number === current)
          ? current
          : result.versions[0]?.number);
      },
      (failure: unknown) => { if (active) setError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.taskId, props.headVersion]);
  const index = versions?.findIndex((version) => version.number === selected) ?? -1;
  const version = index >= 0 ? versions?.[index] : undefined;
  const previous = index >= 0 ? versions?.[index + 1] : undefined;
  const changes = useMemo(() => version ? ticketFieldChanges(previous?.content, version.content) : [], [version, previous]);
  const description = useMemo(() => version
    ? diffWordsWithSpace(previous?.content.brief ?? "", version.content.brief ?? "")
    : [], [version, previous]);
  const descriptionChanged = description.some((part) => part.added || part.removed);

  const restore = async () => {
    if (!version) return;
    setBusy(true);
    setError(undefined);
    const failure = await props.restore(version.number);
    setBusy(false);
    if (failure) setError(failure);
  };

  return <aside className="pm-history" aria-label="Ticket history">
    <header className="pm-history-head">
      <h2>History</h2>
      <button type="button" className="icon-button quiet" aria-label="Close history" onClick={props.close}><Icon name="close" /></button>
    </header>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {!versions ? <p className="td-note">Loading versions…</p> : versions.length === 0
      ? <p className="td-note">No saved version yet. Each save — yours or the Agent's — becomes a version here.</p>
      : <div className="pm-history-body">
        <ol className="pm-versions">
          {versions.map((entry) => <li key={entry.number}>
            <button
              type="button"
              className={`pm-version${entry.number === selected ? " selected" : ""}`}
              aria-current={entry.number === selected ? "true" : undefined}
              onClick={() => setSelected(entry.number)}
            >
              <span className={`pm-version-author ${entry.author}`}>{entry.author === "agent" ? "AI" : "PM"}</span>
              <span className="pm-version-main">
                <strong>v{entry.number}{entry.number === props.headVersion ? <em>Current</em> : null}</strong>
                <span>{entry.summary ?? (entry.author === "agent" ? "Updated by the Agent" : "Edited")}</span>
              </span>
              <time title={new Date(entry.createdAtEpochMs).toLocaleString()}>{relativeTime(entry.createdAtEpochMs)}</time>
            </button>
          </li>)}
        </ol>
        {version ? <section className="pm-version-detail" aria-label={`Version ${version.number}`}>
          <div className="pm-version-detail-head">
            <div>
              <strong>Version {version.number}</strong>
              <span>{ticketAuthorLabel(version.author)} · {new Date(version.createdAtEpochMs).toLocaleString()}</span>
            </div>
            {version.number !== props.headVersion ? <button
              type="button"
              className="td-mini"
              disabled={props.disabled || busy}
              onClick={() => void restore()}
            ><Icon name="restart" />{busy ? "Restoring…" : "Restore"}</button> : null}
          </div>
          <p className="pm-version-compare">{previous ? `Changes since v${previous.number}` : "The first kept version"}</p>
          {changes.length > 0 ? <dl className="pm-field-changes">
            {changes.map((change) => <div key={change.field}>
              <dt>{change.field}</dt>
              <dd>
                {change.before ? <del>{change.before}</del> : null}
                {change.after ? <ins>{change.after}</ins> : <span className="pm-dim">cleared</span>}
              </dd>
            </div>)}
          </dl> : null}
          {descriptionChanged || !previous ? <div className="pm-diff">
            <span className="pm-diff-label">Description</span>
            <pre>{description.length === 0 || (!previous && !version.content.brief)
              ? <span className="pm-dim">No description</span>
              : description.map((part, partIndex) => part.added
                ? <ins key={partIndex}>{part.value}</ins>
                : part.removed ? <del key={partIndex}>{part.value}</del> : <span key={partIndex}>{part.value}</span>)}</pre>
          </div> : null}
          {previous && changes.length === 0 && !descriptionChanged ? <p className="td-note">No content change.</p> : null}
        </section> : null}
      </div>}
  </aside>;
}
