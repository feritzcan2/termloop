import { useEffect, useState } from "react";
import type { TaskCleanupWorktreeParams, TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import {
  taskWorktreeCleanupBlockerMessage,
  taskWorktreeCleanupOperationId,
  taskWorktreeCleanupWarningMessage,
  type Task,
} from "../../model.js";
import { Icon } from "../Icon.js";

export function CleanupWorktreeDialog({ task, close, inspect, cleanup }: {
  task: Task;
  close(): void;
  inspect(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  cleanup(params: TaskCleanupWorktreeParams): Promise<string | undefined>;
}) {
  const [preview, setPreview] = useState<TaskWorktreeCleanupPreviewDto>();
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState(false);
  const [destructiveConfirmed, setDestructiveConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void inspect(task.id).then((value) => { if (active) setPreview(value); }).catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { active = false; };
  }, [inspect, task.id]);
  const submit = async () => {
    if (!preview?.managed_worktree_operation_id) return;
    const destructive = preview.destructive_cleanup.status === "available";
    if (preview.decision !== "allowed" && (!destructive || !destructiveConfirmed)) return;
    const cleanupMode = destructive ? "discardCheckoutContent" : "safe";
    const acknowledgedContentBlockers = destructive
      ? preview.destructive_cleanup.eligible_blockers
      : [];
    setBusy(true); setError(undefined);
    const failure = await cleanup({
      operationId: taskWorktreeCleanupOperationId(task, cleanupMode, acknowledgedContentBlockers, () => globalThis.crypto.randomUUID()),
      taskId: task.id,
      expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id,
      expectedWorktreeGeneration: preview.worktree_generation,
      cleanupMode,
      acknowledgedContentBlockers,
    });
    if (failure) { setError(failure); setBusy(false); } else close();
  };
  const warningsConfirmed = preview?.warnings.length ? confirmed : true;
  const destructiveAvailable = preview?.destructive_cleanup.status === "available";
  const canSubmit = preview?.decision === "allowed" || (destructiveAvailable && destructiveConfirmed);
  const blocked = preview?.decision === "refused" && !destructiveAvailable;
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
    <button className="dialog-backdrop" aria-label="Cancel worktree cleanup" onClick={close} />
    <section className="dialog-card task-dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-worktree-title">
      <header className="dialog-header"><div><span className="dialog-eyebrow">Worktree cleanup</span><h2 id="cleanup-worktree-title">Cleanup “{task.title}”?</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header>
      <div className="dialog-body">
        <p className="confirm-copy">{preview?.target_path ?? task.worktree?.path ?? "Inspecting exact worktree…"}</p>
        {preview?.blockers.length ? <div className="form-error" role="alert">
          <strong>Cleanup is blocked.</strong>
          <p>{destructiveAvailable ? "This checkout-local content can be permanently discarded only with the separate acknowledgement below." : "Resolve every item below, then close and inspect again. Warning confirmation cannot override these safety checks."}</p>
          <ul>{preview.blockers.map((blocker) => <li key={blocker}>{taskWorktreeCleanupBlockerMessage(blocker, destructiveAvailable)}</li>)}</ul>
        </div> : null}
        {destructiveAvailable ? <div className="form-error" role="alert">
          <strong>Irreversible checkout cleanup</strong>
          <p>This permanently deletes the acknowledged local tracked, staged, untracked, ignored, or initialized submodule content in this exact worktree. TermLoop keeps the Task and branch, but cannot recover discarded file content.</p>
          <label><input type="checkbox" checked={destructiveConfirmed} onChange={(event) => setDestructiveConfirmed(event.target.checked)} /> I understand these local files will be permanently deleted and cannot be recovered.</label>
        </div> : null}
        {preview?.warnings.length ? <div className="field-help">
          <strong>Warnings — these do not block cleanup.</strong>
          <ul>{preview.warnings.map((warning) => <li key={warning}>{taskWorktreeCleanupWarningMessage(warning)}</li>)}</ul>
          {preview.decision === "allowed" || destructiveAvailable ? <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed these warnings and understand that the local branch will be kept.</label> : <p>Fix the blocking items above first; these warnings require no action to enable cleanup.</p>}
        </div> : null}
        {preview?.decision === "allowed" ? <p className="field-help" role="status">Safety inspection passed. Cleanup removes only the worktree directory and registration; the branch and Task will be kept.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="danger-button" disabled={busy || !canSubmit || !warningsConfirmed} onClick={() => void submit()}>{busy ? "Cleaning…" : blocked ? "Cleanup blocked" : destructiveAvailable ? "Force cleanup and delete local files" : "Cleanup worktree"}</button></footer>
    </section>
  </div>;
}
