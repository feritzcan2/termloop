import { useEffect, useRef, useState } from "react";
import type { PlaybookCriterionStatus, PlaybookEvaluationHistoryResult, PlaybookEvaluationRecordDto } from "@termloop/contract/current";
import { Icon } from "./Icon.js";
import "./playbook-evaluation-history.css";

const outcomeLabels: Record<PlaybookEvaluationRecordDto["outcome"], string> = {
  inProgress: "In progress", passed: "Passed", waiting: "Pending",
  blocked: "Blocked", failed: "Failed to start", interrupted: "Interrupted",
  rewound: "Sent back",
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
  if (entries.length === 0) return <p className="peh-empty">No checks recorded yet. New task checks and their results will appear here.</p>;
  return <ol className="peh-list">{entries.map((entry) => <li key={entry.id} className="peh-entry">
    <PlaybookEvaluationEntry entry={entry} heading={entry.taskTitle} />
  </li>)}</ol>;
}

const criterionLabels: Record<PlaybookCriterionStatus, string> = { met: "Met", unmet: "Not met", unknown: "Unknown" };

/** One evaluator check: its verdict, what the Task Agent had claimed, and
    the per-criterion findings behind the verdict, collapsed by default. */
export function PlaybookEvaluationEntry({ entry, heading }: { entry: PlaybookEvaluationRecordDto; heading: string }) {
  const criteria = entry.criteria ?? [];
  return <>
    <div className="peh-entry-heading"><h3>{heading}</h3><span className={`peh-outcome ${entry.outcome}`}>{outcomeLabels[entry.outcome]}</span></div>
    <p className="peh-step">{entry.milestoneTitle}
      {entry.rewoundTo ? <> → sent back to <strong>{entry.rewoundTo.title}</strong></> : null}
      {entry.pullRequestNumber === undefined ? null : <> · PR #{entry.pullRequestNumber}</>}</p>
    <p className="peh-agent"><Icon name={entry.agentId} /><span>{entry.sourceName === null ? <>Fresh evaluator</> : <>Fork of <strong>{entry.sourceName}</strong></>} · {entry.model === "default" ? "Provider default model" : entry.model}</span></p>
    {entry.agentReport ? <p className="peh-claim"><span>Task Agent reported {entry.agentReport.status === "reached" ? "the step reached" : "it was blocked"}:</span> {entry.agentReport.evidence}</p> : null}
    <p className="peh-evidence">{entry.evidence || "Waiting for the evaluator’s result…"}</p>
    {criteria.length > 0 ? <details className="peh-criteria">
      <summary>{criteria.filter((item) => item.status === "met").length} of {criteria.length} criteria met</summary>
      <ul>{criteria.map((item, index) => <li key={index}>
        <span className={`peh-criterion ${item.status}`}>{criterionLabels[item.status]}</span>
        <strong>{item.criterion}</strong> <span>{item.evidence}</span>
      </li>)}</ul>
    </details> : null}
    <details className="peh-details">
      <summary><time dateTime={new Date(entry.startedAtEpochMs).toISOString()}>{new Date(entry.startedAtEpochMs).toLocaleString()}</time></summary>
      <dl>
        <dt>Finished</dt><dd>{entry.finishedAtEpochMs === null ? "Still running" : new Date(entry.finishedAtEpochMs).toLocaleString()}</dd>
        <dt>Permission</dt><dd>{entry.permission}</dd>
        <dt>Source agent</dt><dd>{entry.sourceSessionId ?? "None"}</dd>
        <dt>Evaluator</dt><dd>{entry.sessionId}</dd>
        <dt>Check</dt><dd>{entry.id}</dd>
      </dl>
    </details>
  </>;
}
