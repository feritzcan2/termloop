import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { LocalChangeListResult } from "../changes-local-recovery.js";
import { SourceControlStatus, type SourceControlSubject } from "../source-control-status.js";

/// Safety poll while the panel is visible. Window focus and a changed
/// daemon summary refresh sooner, so this only catches edits made elsewhere.
export const SOURCE_CONTROL_POLL_MS = 15_000;

/** One disposable status observation for the visible Source Control root. */
export function useSourceControl(
  subject: SourceControlSubject | undefined,
  /// Any daemon fact that moves when the checkout changes, such as the
  /// worktree health observation sequence or the Project change count.
  refreshSignal: string,
  listProject: (projectId: string) => Promise<LocalChangeListResult>,
  listTask: (taskId: string) => Promise<LocalChangeListResult>,
) {
  const reader = useRef({ listProject, listTask });
  reader.current = { listProject, listTask };
  const kind = subject?.kind;
  const id = subject?.id;
  const status = useMemo(() => new SourceControlStatus(() => kind === "task"
    ? reader.current.listTask(id!)
    : reader.current.listProject(id!)), [kind, id]);
  const snapshot = useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot);
  useEffect(() => {
    if (!id) return;
    status.start();
    const refreshVisible = () => { if (document.visibilityState === "visible") void status.refresh(); };
    const timer = window.setInterval(refreshVisible, SOURCE_CONTROL_POLL_MS);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      status.dispose();
    };
  }, [status, id]);
  const lastSignal = useRef({ status, refreshSignal });
  useEffect(() => {
    // A new root already loads on start; only a moved signal on the same root refreshes.
    const last = lastSignal.current;
    lastSignal.current = { status, refreshSignal };
    if (last.status === status && last.refreshSignal !== refreshSignal) void status.refresh();
  }, [refreshSignal, status]);
  return { status, snapshot };
}
