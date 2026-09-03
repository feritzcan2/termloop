import { useCallback, useEffect, useState } from "react";
import type { Session, Task, TaskDeleteWorktreeResult, TaskDeleteWorktreeReview } from "../model.js";
import { Icon } from "./Icon.js";
import { RailHeader } from "./RailHeader.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { DeleteTaskDialog } from "./task-dialogs/delete-task-dialog.js";
import type { TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import type { WorkspaceView } from "./WorkspaceViewSwitch.js";

export type ArchivedTasksBinding = {
  tasks: readonly Task[];
  sessions: readonly Session[];
  loading: boolean;
  /// How many Tasks are archived right now, for the Tasks header breadcrumb.
  count: number;
  /// Re-read the archived page after an archive succeeds.
  reload(): void;
  restore(taskId: string): void;
  restoreSession(sessionId: string): void;
};

/// Archived Tasks are a separate paginated read rather than part of the active
/// projection, so the state holding them belongs to the sidebar rather than to
/// `TaskRail`, which renders the active list. The Archived section is pinned
/// outside the scrolling rail while the Tasks header breadcrumb sits inside it,
/// so both read from this one binding.
export function useArchivedTasks(options: {
  projectId: string | undefined;
  /// The observable edge of an archive or restore, used to re-read the page.
  activeTaskCount: number;
  list(projectId: string): Promise<Task[]>;
  listSessions(projectId: string): Promise<Session[]>;
  restore(taskId: string): Promise<string | undefined>;
  restoreSession(sessionId: string): Promise<string | undefined>;
}): ArchivedTasksBinding {
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [loading, setLoading] = useState(false);
  const { list, projectId, restore: restoreTask } = options;
  const reload = useCallback(() => {
    if (!projectId) { setTasks([]); setSessions([]); return; }
    setLoading(true);
    void Promise.all([list(projectId), options.listSessions(projectId)])
      .then(([page, archivedSessions]) => {
        setTasks(page);
        setSessions(archivedSessions);
      })
      .finally(() => setLoading(false));
  }, [list, options.listSessions, projectId]);

  useEffect(() => { reload(); }, [reload, options.activeTaskCount]);

  const restore = useCallback((taskId: string) => {
    void restoreTask(taskId).then((failure) => { if (!failure) reload(); });
  }, [restoreTask, reload]);

  const restoreSession = useCallback((sessionId: string) => {
    void options.restoreSession(sessionId).then((failure) => { if (!failure) reload(); });
  }, [options.restoreSession, reload]);

  return { tasks, sessions, loading, count: tasks.length, reload, restore, restoreSession };
}

export type ArchivedRailProps = {
  tasks: readonly Task[];
  loading: boolean;
  disabled: boolean;
  deletingTaskIds: ReadonlySet<string>;
  restore(taskId: string): void;
  inspectTaskWorktreeCleanup(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  deleteTask(task: Task, review?: TaskDeleteWorktreeReview): Promise<TaskDeleteWorktreeResult>;
  overlayVisibilityChanged(visible: boolean): void;
  overlayContainer: Element | undefined;
};

/// An archived Task states when it left active work and nothing else. The
/// generated projection carries no retained-context health on the list DTO, so
/// this line never claims recoverability it cannot prove.
function archivedMeta(task: Task): string {
  if (!task.archived_at_epoch_ms) return "Context parked";
  return `Context parked · ${new Date(task.archived_at_epoch_ms).toLocaleDateString()}`;
}

/// Archived Tasks remain available from the Tasks view. Archived Agents live
/// in Session History so the Agents view has one history entry point.
export function archivedRailVisible(workspaceRailActive: boolean, workspaceView: WorkspaceView): boolean {
  return workspaceRailActive && workspaceView === "overview";
}

/// A compact Task-only drawer pinned below the scrolling Tasks rail.
export function ArchivedRail(props: ArchivedRailProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Task>();
  useEffect(() => {
    props.overlayVisibilityChanged(Boolean(deleteTarget));
    return () => props.overlayVisibilityChanged(false);
  }, [deleteTarget, props.overlayVisibilityChanged]);
  /// Emptiness is owned here so the sidebar never has to predict it.
  const total = props.tasks.length;
  if (total === 0) return null;
  return (
    <section className="rail-section archived-section" data-rail="archived" aria-label="Archived items">
      <RailHeader collapsed={collapsed} label="Archived items" toggle={() => setCollapsed((value) => !value)}>
        <span className="rail-glyph" aria-hidden="true"><Icon name="archive" /></span>
        <h2>Archived</h2>
        <span className="count-badge" title={`${total} archived items`}>{total}</span>
      </RailHeader>
      {collapsed ? null : (
        <div className="archived-list" role="list" aria-label="Archived items">
          {props.tasks.map((task) => (
            <div key={task.id} className={`archived-row${props.deletingTaskIds.has(task.id) ? " deleting" : ""}`} role="listitem">
              <span className="archived-glyph" aria-hidden="true"><Icon name="archive" /></span>
              <span className="archived-title" title={`${task.title} · ${props.deletingTaskIds.has(task.id) ? "Deleting…" : archivedMeta(task)}`}>{props.deletingTaskIds.has(task.id) ? "Deleting…" : task.title}</span>
              <span className="archived-actions">
                <button
                  type="button"
                  className="archived-restore"
                  disabled={props.disabled || props.deletingTaskIds.has(task.id)}
                  aria-label={`Restore ${task.title}`}
                  title="Restore Task and recover its resumable Agents"
                  onClick={() => props.restore(task.id)}
                >restore</button>
                <button type="button" className="archived-delete" disabled={props.disabled || props.deletingTaskIds.has(task.id)} aria-label={`Delete archived Task ${task.title}`} title="Delete Task and worktree; keep the Git branch" onClick={() => setDeleteTarget(task)}><Icon name="close" /></button>
              </span>
            </div>
          ))}
          {props.loading ? <p className="rail-empty" role="status">Refreshing archived Tasks…</p> : null}
        </div>
      )}
      <OverlayPortal container={props.overlayContainer}>
      {deleteTarget ? <DeleteTaskDialog
        task={deleteTarget}
        inspect={props.inspectTaskWorktreeCleanup}
        close={() => setDeleteTarget(undefined)}
        remove={(review) => { void props.deleteTask(deleteTarget, review); }}
      /> : null}
      </OverlayPortal>
    </section>
  );
}
