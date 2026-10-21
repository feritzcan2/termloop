import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { SourceControlStatus, type SourceControlApi, type SourceControlSubject } from "../source-control-status.js";

/// Safety poll while the panel is visible. Window focus and a changed
/// daemon summary refresh sooner, so this only catches edits made elsewhere.
export const SOURCE_CONTROL_POLL_MS = 15_000;

const DETACHED = new SourceControlStatus({ projectId: "", taskId: null }, () => { throw new Error("Source Control is unavailable."); });

/** One disposable status observation for the visible Source Control root. */
export function useSourceControl(
  subject: SourceControlSubject | undefined,
  /// Any daemon fact that moves when the checkout changes, such as the
  /// worktree health observation sequence or the Project change count.
  refreshSignal: string,
  api: SourceControlApi,
) {
  const current = useRef(api);
  current.current = api;
  const projectId = subject?.projectId;
  const taskId = subject?.taskId ?? null;
  const status = useMemo(() => projectId
    ? new SourceControlStatus({ projectId, taskId }, () => current.current)
    : DETACHED, [projectId, taskId]);
  const snapshot = useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot);
  useEffect(() => {
    if (status === DETACHED) return;
    status.start();
    const refreshVisible = () => { if (document.visibilityState === "visible" && !status.getSnapshot().busy) void status.refresh(); };
    const timer = window.setInterval(refreshVisible, SOURCE_CONTROL_POLL_MS);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      status.dispose();
    };
  }, [status]);
  const lastSignal = useRef({ status, refreshSignal });
  useEffect(() => {
    // A new root already loads on start; only a moved signal on the same root refreshes.
    const last = lastSignal.current;
    lastSignal.current = { status, refreshSignal };
    if (last.status === status && last.refreshSignal !== refreshSignal && !status.getSnapshot().busy) void status.refresh();
  }, [refreshSignal, status]);
  return { status, snapshot };
}
