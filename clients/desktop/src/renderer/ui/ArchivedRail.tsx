import { useCallback, useEffect, useState } from "react";
import type { Session, Task } from "../model.js";

export type ArchivedTasksBinding = {
  tasks: readonly Task[];
  sessions: readonly Session[];
  loading: boolean;
  /// How many Tasks are archived right now, for the Tasks header breadcrumb.
  count: number;
  /// Re-read the archived page after an archive succeeds.
  reload(): Promise<void>;
  /// Settles once the restored Task has left the re-read archived page.
  restore(taskId: string): Promise<void>;
  /// `cwd` reopens the Agent there instead of its recorded folder.
  restoreSession(sessionId: string, cwd?: string): Promise<string | undefined>;
};

/// Archived Tasks are a separate paginated read rather than part of the active
/// projection, so the state holding them belongs to the sidebar rather than to
/// `TaskRail`, which renders the active list. Session History and the Tasks
/// header breadcrumb both read from this one binding.
export function useArchivedTasks(options: {
  projectId: string | undefined;
  /// The observable edge of an archive or restore, used to re-read the page.
  activeTaskCount: number;
  list(projectId: string): Promise<Task[]>;
  listSessions(projectId: string): Promise<Session[]>;
  restore(taskId: string): Promise<string | undefined>;
  restoreSession(sessionId: string, cwd?: string): Promise<string | undefined>;
}): ArchivedTasksBinding {
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [loading, setLoading] = useState(false);
  const { list, projectId, restore: restoreTask } = options;
  const reload = useCallback(() => {
    if (!projectId) { setTasks([]); setSessions([]); return Promise.resolve(); }
    setLoading(true);
    return Promise.all([list(projectId), options.listSessions(projectId)])
      .then(([page, archivedSessions]) => {
        setTasks(page);
        setSessions(archivedSessions);
      })
      .finally(() => setLoading(false));
  }, [list, options.listSessions, projectId]);

  useEffect(() => { reload(); }, [reload, options.activeTaskCount]);

  const restore = useCallback((taskId: string) => {
    return restoreTask(taskId).then((failure) => { if (!failure) return reload(); });
  }, [restoreTask, reload]);

  const restoreSession = useCallback((sessionId: string, cwd?: string) => (
    (cwd ? options.restoreSession(sessionId, cwd) : options.restoreSession(sessionId)).then((failure) => {
      if (!failure) void reload();
      return failure;
    })
  ), [options.restoreSession, reload]);

  return { tasks, sessions, loading, count: tasks.length, reload, restore, restoreSession };
}
