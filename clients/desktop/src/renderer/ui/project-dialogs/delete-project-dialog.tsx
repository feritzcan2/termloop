import { useEffect, useMemo, useState } from "react";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type {
  Project,
  Task,
  TaskDeleteWorktreeResult,
  TaskDeleteWorktreeReview,
} from "../../model.js";
import { taskDeletePreviewCanProceed } from "../../model.js";
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

type CleanupProgress = "queued" | "deleting" | "removed" | "failed";
type DeletePhase = "idle" | "cleaningWorktrees" | "deletingProject";

function projectDeleteReview(preview: TaskWorktreeCleanupPreviewDto): TaskDeleteWorktreeReview | undefined {
  if (preview.stale_resolution.disposal_status === "available"
    || preview.stale_resolution.disposal_status === "sessionRetirementRequired") {
    return { preview, kind: "discardStaleDirectory" };
  }
  if (preview.stale_resolution.forget_status === "available") {
    return { preview, kind: "forgetStaleBinding" };
  }
  return taskDeletePreviewCanProceed(preview) ? { preview, kind: "cleanup" } : undefined;
}

/// Project deletion already removes every Task record, so an explicitly
/// forgettable stale binding is safe to clear on the way there. Managed
/// worktrees use the same bounded cleanup orchestration as Task deletion,
/// including exact content acknowledgement and Session retirement; hard or
/// unknown core gates remain blocked and lead back to Tasks.
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
  const [phase, setPhase] = useState<DeletePhase>("idle");
  const [runTasks, setRunTasks] = useState<readonly Task[]>();
  const [runForceCleanup, setRunForceCleanup] = useState<boolean>();
  const [progress, setProgress] = useState<ReadonlyMap<string, CleanupProgress>>(new Map());

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
  const cleanupReviews = new Map(blockingTasks.flatMap((task) => {
    const preview = previews.get(task.id);
    const review = preview ? projectDeleteReview(preview) : undefined;
    return review ? [[task.id, review] as const] : [];
  }));
  const allCleanupReady = blockingTasks.length > 0
    && previews.size === blockingTasks.length
    && cleanupReviews.size === blockingTasks.length;
  const cleanupRequired = blockingTasks.length > 0 && !inspecting && !allCleanupReady;
  const forceCleanup = [...cleanupReviews.values()].some((review) => review.kind !== "forgetStaleBinding");
  const displayedTasks = runTasks ?? blockingTasks;
  const displayCleanupReady = runTasks ? true : allCleanupReady;
  const displayForceCleanup = runForceCleanup ?? forceCleanup;

  const submit = async () => {
    if (inspecting || cleanupRequired) return;
    setBusy(true);
    setPhase(blockingTasks.length > 0 ? "cleaningWorktrees" : "deletingProject");
    setRunTasks(blockingTasks.length > 0 ? [...blockingTasks] : undefined);
    setRunForceCleanup(forceCleanup);
    setProgress(new Map(blockingTasks.map((task) => [task.id, "queued" as const])));
    setError(undefined);
    try {
      for (const task of blockingTasks) {
        const review = cleanupReviews.get(task.id);
        if (!review) {
          setError(`${task.title}: inspect this worktree again from Tasks.`);
          return;
        }
        setProgress((current) => new Map(current).set(task.id, "deleting"));
        const result = await props.deleteBlockingTask(task, review);
        if (result.status !== "completed") {
          setProgress((current) => new Map(current).set(task.id, "failed"));
          setError(taskDeleteFailure(task, result));
          return;
        }
        setProgress((current) => new Map(current).set(task.id, "removed"));
      }
      setPhase("deletingProject");
      const failure = await props.deleteProject(project.id);
      if (failure) setError(failure);
      else props.close();
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  };

  const actionLabel = busy
    ? phase === "deletingProject" ? "Deleting Project…" : "Cleaning worktrees…"
    : inspecting
      ? "Checking worktrees…"
      : allCleanupReady
        ? forceCleanup
          ? `Force cleanup ${blockingTasks.length} worktree${blockingTasks.length === 1 ? "" : "s"} & delete`
          : `Forget ${blockingTasks.length} stale binding${blockingTasks.length === 1 ? "" : "s"} & delete`
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
        {displayedTasks.length > 0 ? <section className="project-delete-blockers" aria-labelledby="project-delete-blockers-title">
          <h3 id="project-delete-blockers-title">{displayedTasks.length} Task worktree{displayedTasks.length === 1 ? "" : "s"} {busy ? "being removed" : "still block deletion"}</h3>
          <ul>{displayedTasks.map((task) => {
            const preview = previews.get(task.id);
            const review = preview ? projectDeleteReview(preview) : undefined;
            const taskProgress = progress.get(task.id);
            const status = taskProgress === "queued" ? "Queued"
              : taskProgress === "deleting" ? "Deleting…"
                : taskProgress === "removed" ? "Removed"
                  : taskProgress === "failed" ? "Failed"
                    : !preview ? inspectionError ? "Inspection failed" : "Checking…"
                      : review?.kind === "forgetStaleBinding" ? "Safe to forget"
                        : review ? "Ready to remove" : "Needs cleanup";
            const statusTone = taskProgress === "deleting" || taskProgress === "queued" ? " working"
              : taskProgress === "removed" ? " done"
                : taskProgress === "failed" ? " failed"
                  : review ? " safe" : "";
            return <li key={task.id}>
              <span className="project-delete-blocker-icon" aria-hidden="true"><Icon name="folder" /></span>
              <span className="project-delete-blocker-copy"><strong>{task.title}</strong><small>{task.worktree?.path}</small></span>
              <span className={`project-delete-blocker-status${statusTone}`}>{status}</span>
            </li>;
          })}</ul>
          {displayCleanupReady && !displayForceCleanup ? <p className="project-delete-safe"><span aria-hidden="true">✓</span><span>These stale bindings can be forgotten without deleting folders. Project deletion will still close the Project&apos;s Sessions.</span></p> : null}
          {displayCleanupReady && displayForceCleanup ? <p className="project-delete-force"><Icon name="trash" /><span>Force cleanup permanently deletes every removable worktree directory and its reported local content; already-missing bindings are only forgotten. Git branches are kept. Attached Sessions are stopped first.</span></p> : null}
          {busy ? <p className="project-delete-progress" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />{phase === "deletingProject" ? "Worktrees removed. Deleting Project…" : "Removing Task worktrees one at a time…"}</p> : null}
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
