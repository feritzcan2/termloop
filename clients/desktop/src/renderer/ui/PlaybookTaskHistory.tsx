import { useEffect, useRef, useState } from "react";
import type { PlaybookEvaluationHistoryResult, PlaybookEvaluationRecordDto } from "@termloop/contract/current";
import type { Task } from "../model.js";
import { Icon } from "./Icon.js";
import { PlaybookEvaluationList } from "./PlaybookEvaluationHistory.js";
import "./playbook-evaluation-history.css";

export type LoadPlaybookEvaluationHistory = () => Promise<PlaybookEvaluationHistoryResult>;

/** A Task row's own Playbook check history: the project's retained checks,
    narrowed to this Task, so a finished evaluator's verdict stays readable. */
export function PlaybookTaskHistory(props: { task: Task; load: LoadPlaybookEvaluationHistory }) {
  const load = useRef(props.load);
  load.current = props.load;
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<readonly PlaybookEvaluationRecordDto[]>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(false);
    void load.current().then((result) => {
      if (active) setEntries(result.entries.filter((entry) => entry.taskId === props.task.id));
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [open, refresh, props.task.id]);

  return <>
    <button type="button" className="playbook-history-toggle" aria-label={`Check history for ${props.task.title}`}
      title="Playbook check history" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="history" />
    </button>
    {open ? <section className="playbook-task-history" aria-label={`Check history for ${props.task.title}`} aria-busy={loading}>
      <header>
        <strong>Check history</strong>
        <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          <Icon name="restart" /> Refresh
        </button>
      </header>
      {error ? <p role="alert">Check history could not be loaded. Try Refresh.</p> : null}
      {loading && !entries ? <small role="status">Loading checks…</small>
        : entries ? <PlaybookEvaluationList entries={entries} /> : null}
    </section> : null}
  </>;
}
