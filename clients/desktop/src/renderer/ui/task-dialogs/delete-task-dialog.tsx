import { useEffect, useState } from "react";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import {
  taskDeletePreviewCanProceed,
  taskWorktreeCleanupBlockerMessage,
  type Task,
  type TaskDeleteWorktreeReview,
} from "../../model.js";

type StaleDeleteChoice = "forgetStaleBinding" | "discardStaleDirectory";

export function StaleDeleteOptions({ preview, choice, choose }: {
  preview: TaskWorktreeCleanupPreviewDto;
  choice: StaleDeleteChoice | undefined;
  choose(choice: StaleDeleteChoice): void;
}) {
  const forgetAvailable = preview.stale_resolution.forget_status === "available";
  const disposalAvailable = preview.stale_resolution.disposal_status === "available"
    || preview.stale_resolution.disposal_status === "sessionRetirementRequired";
  return <fieldset className="stale-delete-options">
    <legend>Unverified stale folder</legend>
    <p className="confirm-copy">
      TermLoop cannot verify this folder&apos;s current contents or Git ownership: <strong>{preview.target_path}</strong>
    </p>
    {forgetAvailable ? <label className="stale-delete-choice">
      <input type="radio" name="stale-delete-choice" checked={choice === "forgetStaleBinding"} onChange={() => choose("forgetStaleBinding")} />
      <span><strong>Keep the folder</strong><small>Forget only the stale Task binding. The folder and its Sessions remain untouched.</small></span>
    </label> : null}
    {disposalAvailable ? <label className="stale-delete-choice danger-choice">
      <input type="radio" name="stale-delete-choice" checked={choice === "discardStaleDirectory"} onChange={() => choose("discardStaleDirectory")} />
      <span><strong>Permanently delete the unverified folder</strong><small>Its contents cannot be inspected or recovered by TermLoop. Attached Sessions will be stopped first.</small></span>
    </label> : null}
  </fieldset>;
}

export function DeleteTaskDialog({ task, inspect, close, remove }: {
  task: Task;
  inspect(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  close(): void;
  remove(review?: TaskDeleteWorktreeReview): void;
}) {
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<TaskWorktreeCleanupPreviewDto>();
  const [staleChoice, setStaleChoice] = useState<StaleDeleteChoice>();
  useEffect(() => {
    let active = true;
    setError(undefined);
    if (!task.worktree) {
      setPreview(undefined);
      setStaleChoice(undefined);
      return () => { active = false; };
    }
    setPreview(undefined);
    setStaleChoice(undefined);
    void inspect(task.id).then((value) => {
      if (!active) return;
      setPreview(value);
      setStaleChoice(value.stale_resolution.forget_status === "available"
        ? "forgetStaleBinding"
        : undefined);
    }).catch((failure) => {
      if (active) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { active = false; };
  }, [inspect, task.id, task.worktree?.path]);

  const forgetAvailable = preview?.stale_resolution.forget_status === "available";
  const disposalAvailable = preview?.stale_resolution.disposal_status === "available"
    || preview?.stale_resolution.disposal_status === "sessionRetirementRequired";
  const staleResolutionOffered = Boolean(forgetAvailable || disposalAvailable);
  const inspecting = Boolean(task.worktree && !preview && !error);
  const previewCanProceed = Boolean(preview && taskDeletePreviewCanProceed(preview));
  const canDelete = Boolean(!task.worktree || (preview
    && previewCanProceed
    && (!staleResolutionOffered || staleChoice)));

  const submit = () => {
    const review: TaskDeleteWorktreeReview | undefined = task.worktree && preview
      ? { preview, kind: staleResolutionOffered ? staleChoice! : "cleanup" }
      : undefined;
    close();
    remove(review);
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
    <button className="dialog-backdrop" aria-label="Cancel deleting Task" onClick={close} />
    <section className="dialog-card task-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-task-title" aria-busy={inspecting}>
      <header className="dialog-header"><div><span className="dialog-eyebrow danger-eyebrow">{task.worktree ? "Delete Task and worktree" : "Delete Task"}</span><h2 id="delete-task-title">Delete “{task.title}”?</h2></div></header>
      <div className="dialog-body">
        {!task.worktree ? <p className="confirm-copy">This permanently deletes the Task.</p> : <>
          <p className="confirm-copy">{staleResolutionOffered
            ? "This permanently deletes the Task record. Choose explicitly what happens to the unverified stale folder; the Git branch is kept."
            : "This permanently deletes the Task, its worktree contents, and attached Sessions. The Git branch is kept."}</p>
          <p className="confirm-copy">Worktree: <strong>{task.worktree.path}</strong></p>
          {preview && staleResolutionOffered ? <StaleDeleteOptions preview={preview} choice={staleChoice} choose={setStaleChoice} /> : null}
          <p className="delete-check-status field-help" role="status" aria-live="polite">
            {inspecting ? <><span className="loading-spinner" aria-hidden="true" />Checking worktree…</>
              : staleResolutionOffered && !staleChoice ? "Choose how to handle the unverified folder."
                : canDelete && staleChoice === "forgetStaleBinding" ? "Ready to delete the Task and keep the unverified folder."
                  : canDelete && staleChoice === "discardStaleDirectory" ? "Ready to permanently delete the unverified folder."
                    : canDelete ? "Ready to delete."
                      : preview ? "Deletion is blocked." : "Worktree check failed."}
          </p>
          {preview && !previewCanProceed ? <div className="form-error" role="alert">
            <strong>Deletion is blocked.</strong>
            <p>Resolve every item below, then close and inspect again. These safety checks cannot be overridden.</p>
            <ul>{preview.blockers.map((blocker) => <li key={blocker}>{taskWorktreeCleanupBlockerMessage(blocker, false)}</li>)}</ul>
          </div> : null}
        </>}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="danger-button loading-button" disabled={!canDelete} onClick={submit}>{inspecting ? <span className="loading-spinner" aria-hidden="true" /> : null}{inspecting ? "Checking…" : canDelete && staleChoice === "forgetStaleBinding" ? "Delete Task; keep folder" : canDelete && staleChoice === "discardStaleDirectory" ? "Delete Task and folder" : canDelete ? "Delete" : staleResolutionOffered ? "Choose folder action" : "Delete blocked"}</button></footer>
    </section>
  </div>;
}
