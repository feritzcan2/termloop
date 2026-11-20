import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "./model.js";
import { taskStage, taskStageConverging } from "./task-presentation.js";

/// How an approved Jira Task gets its first Agent: a fork of the proposing
/// Agent, or a fresh Agent of the same kind.
export type TaskAgentStartKind = "fork" | "fresh";

/// What a Task card shows about its pending first Agent. `waiting` holds the
/// start until the new worktree is launch-ready, `starting` is the launch in
/// flight, and `failed` stays on the card with Retry until the user acts.
export type TaskAgentStartView = {
  kind: TaskAgentStartKind;
  issueKey: string;
  phase: "waiting" | "starting" | "failed";
  failure: string | undefined;
};

type TaskAgentStartEntry = TaskAgentStartView & {
  /** Starts the Agent; resolves to a failure message. */
  run(): Promise<string | undefined>;
};

/// Whether a Task's worktree can host the start now. The early stages are
/// still converging after provisioning, so the start waits for them; any other
/// stage cannot host a launch and becomes the failure the card shows.
export function taskAgentStartReadiness(task: Task): "ready" | "wait" | { failure: string } {
  const stage = taskStage(task, false);
  if (stage.id === "ready") return "ready";
  if (taskStageConverging(stage.id)) return "wait";
  if (stage.id === "closed") return { failure: "The Task is closed." };
  return { failure: stage.note ? `The Task worktree cannot host an Agent. ${stage.note}` : "The Task worktree cannot host an Agent." };
}

/// Holds the first-Agent start of each approved Jira Task until its worktree is
/// launch-ready, so a fork or fresh launch never races the first worktree
/// observation, and keeps a failed start visible and retryable instead of a
/// transient message. Client-local and runtime-only: a reload drops it.
export function usePendingTaskAgentStarts(tasks: readonly Task[], reportFailure: (issueKey: string, failure: string) => void) {
  const [entries, setEntries] = useState<ReadonlyMap<string, TaskAgentStartEntry>>(new Map());
  const claimed = useRef(new Set<string>());
  const report = useRef(reportFailure);
  report.current = reportFailure;

  const patch = useCallback((taskId: string, change: (entry: TaskAgentStartEntry) => TaskAgentStartEntry | undefined) => {
    setEntries((current) => {
      const entry = current.get(taskId);
      if (!entry) return current;
      const next = new Map(current);
      const changed = change(entry);
      if (changed) next.set(taskId, changed);
      else next.delete(taskId);
      return next;
    });
  }, []);
  const fail = useCallback((taskId: string, issueKey: string, failure: string) => {
    patch(taskId, (entry) => ({ ...entry, phase: "failed", failure }));
    report.current(issueKey, failure);
  }, [patch]);

  const begin = useCallback((taskId: string, kind: TaskAgentStartKind, issueKey: string, run: () => Promise<string | undefined>) => {
    setEntries((current) => new Map(current).set(taskId, { kind, issueKey, phase: "waiting", failure: undefined, run }));
  }, []);
  const retry = useCallback((taskId: string) => {
    patch(taskId, (entry) => entry.phase === "failed" ? { ...entry, phase: "waiting", failure: undefined } : entry);
  }, [patch]);
  const dismiss = useCallback((taskId: string) => {
    patch(taskId, (entry) => entry.phase === "starting" ? entry : undefined);
  }, [patch]);

  useEffect(() => {
    for (const [taskId, entry] of entries) {
      if (entry.phase !== "waiting" || claimed.current.has(taskId)) continue;
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) continue;
      const readiness = taskAgentStartReadiness(task);
      if (readiness === "wait") continue;
      if (readiness !== "ready") {
        fail(taskId, entry.issueKey, readiness.failure);
        continue;
      }
      claimed.current.add(taskId);
      patch(taskId, (current) => ({ ...current, phase: "starting" }));
      void entry.run()
        .then((failure) => failure ? fail(taskId, entry.issueKey, failure) : patch(taskId, () => undefined))
        .catch((cause: unknown) => fail(taskId, entry.issueKey, cause instanceof Error ? cause.message : String(cause)))
        .finally(() => claimed.current.delete(taskId));
    }
  }, [entries, fail, patch, tasks]);

  const views = useMemo(() => {
    const result = new Map<string, TaskAgentStartView>();
    for (const [taskId, { kind, issueKey, phase, failure }] of entries) result.set(taskId, { kind, issueKey, phase, failure });
    return result as ReadonlyMap<string, TaskAgentStartView>;
  }, [entries]);
  return { views, begin, retry, dismiss };
}
