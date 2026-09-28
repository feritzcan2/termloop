import { useEffect, useRef, useState } from "react";
import type { PlaybookEvaluationHistoryResult, PlaybookEvaluationRecordDto } from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import "./playbook-evaluation-history.css";

const outcomeLabels: Record<PlaybookEvaluationRecordDto["outcome"], string> = {
  inProgress: "In progress", passed: "Passed", waiting: "Pending",
  blocked: "Blocked", failed: "Failed to start", interrupted: "Interrupted",
};

export function PlaybookEvaluationHistory(props: {
  refreshToken: number;
  load(): Promise<PlaybookEvaluationHistoryResult>;
}) {
  const load = useRef(props.load);
  load.current = props.load;
  const [result, setResult] = useState<PlaybookEvaluationHistoryResult>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void load.current().then((next) => {
      if (active) setResult(next);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [props.refreshToken, refresh]);

  return <section className="peh" aria-label="Playbook check history" aria-busy={loading}>
    <header className="peh-header">
      <div><h2>Playbook check history</h2><p>Task agent forks and their results · newest first{result ? ` · last ${result.retentionLimit} checks retained` : ""}</p></div>
      <button type="button" className="peh-refresh" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><Icon name="restart" /> Refresh</button>
    </header>
    {error ? <p role="alert" className="ap-error">Check history could not be loaded. Try Refresh.</p> : null}
    {loading && !result ? <p className="peh-empty" role="status">Loading checks…</p>
      : result ? <PlaybookEvaluationList entries={result.entries} /> : null}
  </section>;
}

export function PlaybookEvaluationList({ entries }: { entries: readonly PlaybookEvaluationRecordDto[] }) {
  if (entries.length === 0) return <p className="peh-empty">No fork checks recorded yet. New task agent checks and their results will appear here.</p>;
  return <ol className="peh-list">{entries.map((entry) => <li key={entry.id} className="peh-entry">
    <div className="peh-entry-heading"><h3>{entry.taskTitle}</h3><span className={`peh-outcome ${entry.outcome}`}>{outcomeLabels[entry.outcome]}</span></div>
    <p className="peh-step">{entry.milestoneTitle}</p>
    <p className="peh-agent"><Icon name={entry.agentId} /><span>Fork of <strong>{entry.sourceName}</strong> · {entry.model === "default" ? "Provider default model" : entry.model}</span></p>
    <p className="peh-evidence">{entry.evidence || "Waiting for the fork agent’s result…"}</p>
    <details className="peh-details">
      <summary><time dateTime={new Date(entry.startedAtEpochMs).toISOString()}>{new Date(entry.startedAtEpochMs).toLocaleString()}</time></summary>
      <dl>
        <dt>Finished</dt><dd>{entry.finishedAtEpochMs === null ? "Still running" : new Date(entry.finishedAtEpochMs).toLocaleString()}</dd>
        <dt>Permission</dt><dd>{entry.permission}</dd>
        <dt>Source agent</dt><dd>{entry.sourceSessionId}</dd>
        <dt>Fork agent</dt><dd>{entry.sessionId}</dd>
        <dt>Check</dt><dd>{entry.id}</dd>
      </dl>
    </details>
  </li>)}</ol>;
}
