import { useEffect, useRef, useState } from "react";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import {
  taskDeletePreviewCanProceed,
  taskWorktreeCleanupBlockerMessage,
  type Task,
  type TaskDeleteWorktreeResult,
  type TaskDeleteWorktreeReview,
} from "../../model.js";

/// What bulk delete will do with one archived Task. It applies the same
/// unattended default as the single-Task dialog and never chooses an
/// irreversible option that dialog would make the user pick explicitly:
/// a Task whose only route is permanent deletion of an unverified folder,
/// or whose worktree is blocked, is skipped and left for individual review.
export type ArchivedTaskBulkDeletePlan =
  | { kind: "delete"; review: TaskDeleteWorktreeReview | undefined; note: string }
  | { kind: "skip"; reason: string };

export function planArchivedTaskBulkDelete(
  task: Task,
  preview: TaskWorktreeCleanupPreviewDto | undefined,
): ArchivedTaskBulkDeletePlan {
  if (!task.worktree) return { kind: "delete", review: undefined, note: "No worktree" };
  if (!preview) return { kind: "skip", reason: "Worktree check failed" };
  if (!taskDeletePreviewCanProceed(preview)) {
    const first = preview.blockers[0];
    return { kind: "skip", reason: first ? taskWorktreeCleanupBlockerMessage(first, false) : "Deletion is blocked" };
  }
  if (preview.stale_resolution.forget_status === "available") {
    return { kind: "delete", review: { preview, kind: "forgetStaleBinding" }, note: "Stale folder kept on disk" };
  }
  if (preview.stale_resolution.disposal_status === "available"
    || preview.stale_resolution.disposal_status === "sessionRetirementRequired") {
    return { kind: "skip", reason: "Unverified folder needs individual review" };
  }
  const discards = !(preview.decision === "allowed" && preview.blockers.length === 0);
  return {
    kind: "delete",
    review: { preview, kind: "cleanup" },
    note: discards ? "Worktree removed, uncommitted changes discarded" : "Worktree removed",
  };
}

type Row = {
  task: Task;
  plan: ArchivedTaskBulkDeletePlan | undefined;
  outcome?: { ok: boolean; message?: string | undefined };
};

const INSPECT_CONCURRENCY = 4;

export function DeleteArchivedTasksDialog({ tasks, inspect, remove, close }: {
  /// A snapshot of the archived page when the dialog opened. Deletions re-read
  /// the page underneath, so the dialog never follows the live list.
  tasks: readonly Task[];
  inspect(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  remove(task: Task, review: TaskDeleteWorktreeReview | undefined): Promise<TaskDeleteWorktreeResult>;
  close(): void;
}) {
  const [rows, setRows] = useState<readonly Row[]>(() => tasks.map((task) => ({
    task,
    plan: task.worktree ? undefined : planArchivedTaskBulkDelete(task, undefined),
  })));
  const [phase, setPhase] = useState<"inspecting" | "ready" | "deleting" | "done">("inspecting");
  const [progress, setProgress] = useState(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    let active = true;
    const pending = tasks.filter((task) => task.worktree);
    let cursor = 0;
    const worker = async () => {
      while (active && cursor < pending.length) {
        const task = pending[cursor++]!;
        let plan: ArchivedTaskBulkDeletePlan;
        try {
          plan = planArchivedTaskBulkDelete(task, await inspect(task.id));
        } catch (failure) {
          plan = { kind: "skip", reason: failure instanceof Error ? failure.message : String(failure) };
        }
        if (!active) return;
        setRows((current) => current.map((row) => row.task.id === task.id ? { ...row, plan } : row));
      }
    };
    void Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, pending.length) }, worker))
      .then(() => { if (active) setPhase("ready"); });
    return () => { active = false; };
  }, [inspect, tasks]);

  const deletable = rows.flatMap((row) => row.plan?.kind === "delete" ? [{ task: row.task, review: row.plan.review }] : []);
  const skipped = rows.filter((row) => row.plan?.kind === "skip");
  const failed = rows.filter((row) => row.outcome && !row.outcome.ok);
  const busy = phase === "inspecting" || phase === "deleting";

  const run = async () => {
    setPhase("deleting");
    let done = 0;
    for (const { task, review } of deletable) {
      let outcome: Row["outcome"];
      try {
        const result = await remove(task, review);
        outcome = result.status === "completed"
          ? { ok: true }
          : { ok: false, message: result.message ?? "Needs individual review" };
      } catch (failure) {
        outcome = { ok: false, message: failure instanceof Error ? failure.message : String(failure) };
      }
      done += 1;
      if (!mounted.current) continue;
      setProgress(done);
      setRows((current) => current.map((row) => row.task.id === task.id ? { ...row, outcome } : row));
    }
    if (mounted.current) setPhase("done");
  };

  const status = phase === "inspecting"
    ? "Checking worktrees…"
    : phase === "deleting"
      ? `Deleting ${progress + 1} of ${deletable.length}…`
      : phase === "done"
        ? failed.length > 0
          ? `${progress - failed.length} deleted, ${failed.length} failed.`
          : `${progress} deleted.`
        : deletable.length === 0
          ? "Nothing can be deleted without individual review."
          : skipped.length > 0
            ? `${deletable.length} ready; ${skipped.length} will be kept for individual review.`
            : `${deletable.length} ready to delete.`;

  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && phase !== "deleting" && close()}>
    <button className="dialog-backdrop" aria-label="Cancel deleting archived Tasks" disabled={phase === "deleting"} onClick={close} />
    <section className="dialog-card task-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-archived-tasks-title" aria-busy={busy}>
      <header className="dialog-header"><div><span className="dialog-eyebrow danger-eyebrow">Delete archived Tasks</span><h2 id="delete-archived-tasks-title">Delete all {tasks.length} archived Task{tasks.length === 1 ? "" : "s"}?</h2></div></header>
      <div className="dialog-body">
        <p className="confirm-copy">This permanently deletes each Task, its Jira link, its worktree contents, and its parked Agents. Git branches are kept. Jira issues can be imported again afterwards.</p>
        <ul className="bulk-delete-list" aria-label="Archived Tasks">
          {rows.map((row) => <li key={row.task.id} className={`bulk-delete-row${row.plan?.kind === "skip" ? " skipped" : ""}${row.outcome ? row.outcome.ok ? " deleted" : " failed" : ""}`}>
            <span className="bulk-delete-title" title={row.task.title}>{row.task.title}</span>
            <span className="bulk-delete-note">{row.outcome
              ? row.outcome.ok ? "Deleted" : row.outcome.message
              : !row.plan ? "Checking…"
                : row.plan.kind === "skip" ? `Kept: ${row.plan.reason}` : row.plan.note}</span>
          </li>)}
        </ul>
        <p className="delete-check-status field-help" role="status" aria-live="polite">
          {busy ? <span className="loading-spinner" aria-hidden="true" /> : null}{status}
        </p>
      </div>
      <footer className="dialog-actions">
        {phase === "done"
          ? <button className="secondary-button" onClick={close}>Done</button>
          : <>
            <button className="secondary-button" disabled={phase === "deleting"} onClick={close}>Cancel</button>
            <button className="danger-button loading-button" disabled={phase !== "ready" || deletable.length === 0} onClick={() => { void run(); }}>
              {busy ? <span className="loading-spinner" aria-hidden="true" /> : null}
              {phase === "inspecting" ? "Checking…" : phase === "deleting" ? "Deleting…" : `Delete ${deletable.length} Task${deletable.length === 1 ? "" : "s"}`}
            </button>
          </>}
      </footer>
    </section>
  </div>;
}
