import { useEffect, useRef, useState } from "react";
import type {
  PlaybookStepEvaluator,
  PlaybookStepVerdict,
  PlaybookTaskTimelineEntryDto,
  PlaybookTaskTimelineResult,
} from "@termloop/contract/current";
import type { Task } from "../model.js";
import { Icon } from "./Icon.js";
import { PlaybookEvaluationEntry } from "./PlaybookEvaluationHistory.js";
import "./playbook-evaluation-history.css";

export type LoadPlaybookTaskTimeline = (taskId: string) => Promise<PlaybookTaskTimelineResult>;

const verdictLabels: Record<PlaybookStepVerdict, string> = { passed: "Passed", waiting: "Pending", blocked: "Blocked" };
const deciderLabels: Record<PlaybookStepEvaluator, string> = {
  deterministic: "TermLoop checked the Git host",
  routine: "Evaluator",
  agent: "Trusted Task Agent report",
  user: "Set by you",
};

/** A Task row's own Playbook story, read only while open: evaluator checks
    with what the Task Agent claimed, verdicts decided without an evaluator,
    and what the Steward did about this Task. The daemon bounds it to the
    newest entries, so long-running Tasks stay as cheap to open as new ones. */
export function PlaybookTaskHistory(props: { task: Task; load: LoadPlaybookTaskTimeline }) {
  const load = useRef(props.load);
  load.current = props.load;
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<PlaybookTaskTimelineResult>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void load.current(props.task.id).then((next) => {
      if (active) setResult(next);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [open, refresh, props.task.id]);

  return <>
    <button type="button" className="playbook-history-toggle" aria-label={`Check history for ${props.task.title}`}
      title="Playbook history" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="history" />
    </button>
    {open ? <section className="playbook-task-history" aria-label={`Check history for ${props.task.title}`} aria-busy={loading}>
      <header>
        <strong>Playbook history</strong>
        <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          <Icon name="restart" /> Refresh
        </button>
      </header>
      {error ? <p role="alert">Playbook history could not be loaded. Try Refresh.</p> : null}
      {loading && !result ? <small role="status">Loading history…</small>
        : result ? <PlaybookTaskTimeline result={result} /> : null}
    </section> : null}
  </>;
}

function PlaybookTaskTimeline({ result }: { result: PlaybookTaskTimelineResult }) {
  if (result.entries.length === 0) {
    return <p className="peh-empty">No checks recorded yet. Checks, decisions, and Steward actions for this Task will appear here.</p>;
  }
  return <>
    <ol className="peh-list">{result.entries.map((entry, index) =>
      <li key={entryKey(entry, index)} className={`peh-entry peh-${entry.kind}`}><TimelineEntry entry={entry} /></li>)}</ol>
    {result.truncated ? <p className="peh-empty">Showing the newest {result.entries.length} entries.</p> : null}
  </>;
}

function entryKey(entry: PlaybookTaskTimelineEntryDto, index: number): string {
  if (entry.evaluation) return `evaluation:${entry.evaluation.id}`;
  if (entry.steward) return `steward:${entry.steward.messageId}`;
  return `${entry.kind}:${entry.milestoneId ?? ""}:${entry.atEpochMs}:${index}`;
}

function TimelineEntry({ entry }: { entry: PlaybookTaskTimelineEntryDto }) {
  const at = <time className="peh-time" dateTime={new Date(entry.atEpochMs).toISOString()}>{new Date(entry.atEpochMs).toLocaleString()}</time>;
  if (entry.evaluation) {
    return <PlaybookEvaluationEntry entry={entry.evaluation} heading="Evaluator check" />;
  }
  if (entry.decision) {
    const decision = entry.decision;
    return <>
      <div className="peh-entry-heading"><h3>{deciderLabels[decision.evaluator]}</h3>
        <span className={`peh-outcome ${decision.verdict}`}>{verdictLabels[decision.verdict]}</span></div>
      <p className="peh-step">{entry.milestoneTitle ?? entry.milestoneId}
        {decision.pullRequestNumber === null ? null : <> · PR #{decision.pullRequestNumber}</>}</p>
      {decision.evidence ? <p className="peh-evidence">{decision.evidence}</p> : null}
      {at}
    </>;
  }
  if (entry.agentReport) {
    const report = entry.agentReport;
    return <>
      <div className="peh-entry-heading"><h3>Task Agent report</h3>
        <span className="peh-outcome inProgress">{report.status === "reached" ? "Says reached" : "Says blocked"}</span></div>
      <p className="peh-step">{entry.milestoneTitle ?? entry.milestoneId} · not checked yet</p>
      <p className="peh-evidence">{report.evidence}</p>
      {at}
    </>;
  }
  if (entry.steward) {
    return <>
      <div className="peh-entry-heading"><h3>Steward</h3></div>
      <p className="peh-evidence peh-steward-content">{entry.steward.content}</p>
      {at}
    </>;
  }
  return null;
}
