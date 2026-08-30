import { useEffect, useMemo, useState } from "react";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type {
  Project,
  Task,
  TaskDeleteWorktreeResult,
  TaskDeleteWorktreeReview,
} from "../../model.js";
import { Icon } from "../Icon.js";

export type DeleteProjectDialogProps = {
  project: Project;
  tasks: readonly Task[];
  tasksLoading?: boolean;
  close(): void;
  deleteProject(projectId: string): Promise<string | undefined>;
  inspectTaskWorktreeCleanup(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  deleteBlockingTask(task: Task, review: TaskDeleteWorktreeReview): Promise<TaskDeleteWorktreeResult>;
  reviewTasks(): void;
};

function taskDeleteFailure(task: Task, result: Exclude<TaskDeleteWorktreeResult, { status: "completed" }>): string {
  const detail = result.message || "The stale binding changed before it could be removed.";
  return `${task.title}: ${detail}`;
}

/// Project deletion already removes every Task record, so an explicitly
/// forgettable stale binding is safe to clear on the way there: the reviewed
/// operation touches neither the unverified folder nor its Sessions. Healthy
/// or otherwise unverifiable worktrees remain blocked and lead back to Tasks.
export function DeleteProjectDialog(props: DeleteProjectDialogProps) {
  const { project } = props;
  const blockingTasks = useMemo(
    () => props.tasks.filter((task) => task.project_id === project.id && task.worktree),
    [project.id, props.tasks],
  );
  const inspectionKey = blockingTasks
    .map((task) => `${task.id}:${task.worktree_generation}:${task.worktree?.path ?? ""}`)
    .join("|");
  const [previews, setPreviews] = useState<ReadonlyMap<string, TaskWorktreeCleanupPreviewDto>>(new Map());
  const [inspectionError, setInspectionError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setPreviews(new Map());
    setInspectionError(undefined);
    if (props.tasksLoading || blockingTasks.length === 0) return () => { active = false; };
    void Promise.all(blockingTasks.map(async (task) => [
      task.id,
      await props.inspectTaskWorktreeCleanup(task.id),
    ] as const)).then((entries) => {
      if (active) setPreviews(new Map(entries));
    }).catch((failure) => {
      if (active) setInspectionError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { active = false; };
  }, [inspectionKey, props.inspectTaskWorktreeCleanup, props.tasksLoading]);

  const inspecting = Boolean(
    props.tasksLoading
      || (blockingTasks.length > 0 && previews.size !== blockingTasks.length && !inspectionError),
  );
  const allForgettable = blockingTasks.length > 0
    && previews.size === blockingTasks.length
    && blockingTasks.every((task) => previews.get(task.id)?.stale_resolution.forget_status === "available");
  const cleanupRequired = blockingTasks.length > 0 && !inspecting && !allForgettable;

  const submit = async () => {
    if (inspecting || cleanupRequired) return;
    setBusy(true);
    setError(undefined);
    try {
      for (const task of blockingTasks) {
        const preview = previews.get(task.id);
        if (!preview || preview.stale_resolution.forget_status !== "available") {
          setError(`${task.title}: inspect this worktree again from Tasks.`);
          return;
        }
        const result = await props.deleteBlockingTask(task, {
          preview,
          kind: "forgetStaleBinding",
        });
        if (result.status !== "completed") {
          setError(taskDeleteFailure(task, result));
          return;
        }
      }
      const failure = await props.deleteProject(project.id);
      if (failure) setError(failure);
      else props.close();
    } finally {
      setBusy(false);
    }
  };

  const actionLabel = busy
    ? "Deleting…"
    : inspecting
      ? "Checking worktrees…"
      : allForgettable
        ? `Forget ${blockingTasks.length} stale binding${blockingTasks.length === 1 ? "" : "s"} & delete`
        : cleanupRequired
          ? "Worktree cleanup required"
          : "Delete Project";

  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && props.close()}>
    <button className="dialog-backdrop" aria-label="Cancel deleting Project" onClick={props.close} />
    <section className="dialog-card project-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" aria-busy={busy || inspecting}>
      <header className="dialog-header">
        <div><span className="dialog-eyebrow danger-eyebrow">Delete Project</span><h2 id="delete-project-title">Remove {project.name} from TermLoop?</h2></div>
        <button className="icon-button quiet" aria-label="Close dialog" onClick={props.close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <p className="confirm-copy">This force-closes the Project&apos;s Sessions and removes everything TermLoop keeps for this Project, including its bounded configuration versions. Your own files in <strong>{project.folder_path}</strong> stay untouched.</p>
        {blockingTasks.length > 0 ? <section className="project-delete-blockers" aria-labelledby="project-delete-blockers-title">
          <h3 id="project-delete-blockers-title">{blockingTasks.length} Task worktree{blockingTasks.length === 1 ? "" : "s"} still block deletion</h3>
          <ul>{blockingTasks.map((task) => {
            const preview = previews.get(task.id);
            const forgettable = preview?.stale_resolution.forget_status === "available";
            return <li key={task.id}>
              <span className="project-delete-blocker-icon" aria-hidden="true"><Icon name="folder" /></span>
              <span className="project-delete-blocker-copy"><strong>{task.title}</strong><small>{task.worktree?.path}</small></span>
              <span className={`project-delete-blocker-status${forgettable ? " safe" : ""}`}>
                {!preview ? inspectionError ? "Inspection failed" : "Checking…" : forgettable ? "Safe to forget" : "Needs cleanup"}
              </span>
            </li>;
          })}</ul>
          {allForgettable ? <p className="project-delete-safe"><span aria-hidden="true">✓</span><span>These stale bindings can be forgotten without deleting folders. Project deletion will still close the Project&apos;s Sessions.</span></p> : null}
          {cleanupRequired ? <p className="form-error" role="alert">At least one worktree still needs individual review before the Project can be deleted.</p> : null}
          {inspectionError ? <p className="form-error" role="alert">Worktree inspection failed: {inspectionError}</p> : null}
        </section> : <p className="field-help">No Task worktrees block deletion.</p>}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        {cleanupRequired ? <button className="secondary-button" disabled={busy} onClick={props.reviewTasks}>Review Tasks</button> : null}
        <button className="secondary-button" disabled={busy} onClick={props.close}>Cancel</button>
        <button id="confirm-delete-project" className="danger-button loading-button" disabled={busy || inspecting || cleanupRequired} onClick={() => void submit()}>
          {busy || inspecting ? <span className="loading-spinner" aria-hidden="true" /> : null}{actionLabel}
        </button>
      </footer>
    </section>
  </div>;
}
