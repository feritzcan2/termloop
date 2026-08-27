import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectLocalBranchListResult,
  SessionRelocationBlocker,
  SessionRelocationPreviewDto,
  TaskProvisionWorktreeParams,
} from "@termloop/contract/current";
import type { Session, Task } from "../model.js";
import { basename, sessionLabel } from "../model.js";
import type { TaskCreateOutcome } from "./task-dialogs/task-editor.js";
import { sortLocalBranches, suggestedBranchName, worktreeDestination, worktreePathParent } from "./worktree-path-suggestion.js";

const NEW_TASK_VALUE = "__new_task__";

type InlineTaskCreation = {
  projectId: string;
  repositoryPath: string;
  createTask(title: string, brief: string | null): Promise<TaskCreateOutcome>;
  listBranches(projectId: string): Promise<ProjectLocalBranchListResult>;
  beginProvisioning(params: TaskProvisionWorktreeParams, mode: "resume" | "fresh"): void;
};

export function SessionRelocationDialog({
  session,
  tasks,
  initialTaskId,
  initialMode,
  close,
  preview,
  relocate,
  repairProviderHistory,
  taskCreation,
  provision,
}: {
  session: Session;
  tasks: readonly Task[];
  initialTaskId?: string | undefined;
  initialMode?: "resume" | "fresh" | undefined;
  close(): void;
  preview(sessionId: string, taskId: string, mode: "resume" | "fresh"): Promise<SessionRelocationPreviewDto>;
  relocate(
    sessionId: string,
    taskId: string,
    operationId: string,
    relocationTicket: string,
    mode: "resume" | "fresh",
    manifestDigest: string,
  ): Promise<boolean>;
  repairProviderHistory(): void;
  taskCreation?: InlineTaskCreation | undefined;
  provision(taskId: string): void;
}) {
  const eligibleTasks = useMemo(
    () => tasks.filter((task) => task.status === "open" && task.archived_at_epoch_ms === null),
    [tasks],
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(initialTaskId);
  const [mode, setMode] = useState<"resume" | "fresh">(
    initialMode ?? (session.process.agent_id === "claude" && session.lifecycle_state === "resumeFailed"
      ? "fresh"
      : "resume"),
  );
  const [result, setResult] = useState<SessionRelocationPreviewDto>();
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [creatingTask, setCreatingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [autoContinueTaskId, setAutoContinueTaskId] = useState<string>();
  const [error, setError] = useState<string>();
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const selectedTask = eligibleTasks.find((task) => task.id === selectedTaskId);
  const blocker = result?.blockers[0];

  useEffect(() => {
    if (!selectedTaskId) {
      setResult(undefined);
      return;
    }
    let current = true;
    setLoading(true);
    setResult(undefined);
    void previewRef.current(session.id, selectedTaskId, mode)
      .then((value) => { if (current) { setResult(value); setError(undefined); } })
      .catch((cause) => { if (current) setError(errorMessage(cause)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [mode, selectedTaskId, session.id]);

  const submit = async () => {
    if (!selectedTaskId || !result?.can_relocate || !result.relocation_ticket || !result.manifest || moving) return;
    setMoving(true);
    setError(undefined);
    try {
      const requiresRepair = await relocate(
        session.id,
        selectedTaskId,
        crypto.randomUUID(),
        result.relocation_ticket,
        mode,
        result.manifest.digest,
      );
      close();
      if (requiresRepair) repairProviderHistory();
    } catch (cause) {
      setError(errorMessage(cause));
      setResult(undefined);
    } finally {
      setMoving(false);
    }
  };

  useEffect(() => {
    if (
      autoContinueTaskId !== selectedTaskId
      || !selectedTask?.worktree
      || !result?.can_relocate
      || !result.relocation_ticket
      || !result.manifest
      || moving
    ) return;
    setAutoContinueTaskId(undefined);
    void submit();
  }, [autoContinueTaskId, moving, result, selectedTask?.worktree, selectedTaskId]);

  const createNewTask = async () => {
    if (!taskCreation || creatingTask) return;
    const title = newTaskTitle.trim();
    if (!title) {
      setError("Enter a Task title.");
      return;
    }
    setCreatingTask(true);
    setError(undefined);
    try {
      const repositoryPath = taskCreation.repositoryPath.trim();
      const localBranches = sortLocalBranches((await taskCreation.listBranches(taskCreation.projectId)).branches);
      const baseRef = localBranches[0]?.exact_ref;
      if (!baseRef) {
        setError("This repository has no local branch to create the Task worktree from.");
        return;
      }
      const proposedBranch = suggestedBranchName(title) || `task/${globalThis.crypto.randomUUID().slice(0, 4)}`;
      const branchName = localBranches.some((branch) => branch.name === proposedBranch)
        ? `${proposedBranch}-${globalThis.crypto.randomUUID().slice(0, 4)}`
        : proposedBranch;
      const created = await taskCreation.createTask(title, null);
      if ("failure" in created) {
        setError(created.failure);
        return;
      }
      taskCreation.beginProvisioning({
        operationId: globalThis.crypto.randomUUID(),
        taskId: created.taskId,
        repositoryPath,
        destinationPath: worktreeDestination(worktreePathParent(repositoryPath), branchName),
        branchName,
        branchMode: "create",
        baseRef,
      }, mode);
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCreatingTask(false);
    }
  };

  return (
    <div className="dialog-layer relocation-dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
      <button className="dialog-backdrop" type="button" aria-label={moving ? "Hide Task worktree move" : "Cancel continuing in a Task worktree"} onClick={close} />
      <section className="dialog-card inline-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="relocation-dialog-title" aria-describedby="relocation-dialog-message" aria-busy={loading || moving}>
        <div className="dialog-body">
          <h2 id="relocation-dialog-title">Move {sessionLabel(session)} to {selectedTask ? `“${selectedTask.title}”` : "a Task"}?</h2>
          <p id="relocation-dialog-message">The Agent will stop here and continue in the Task worktree.</p>
          {!initialTaskId ? <label htmlFor="relocation-task">Task</label> : null}
          {!initialTaskId ? (
          <select id="relocation-task" value={newTaskOpen ? NEW_TASK_VALUE : selectedTaskId ?? ""} disabled={moving || creatingTask} onChange={(event) => {
            const value = event.target.value;
            setError(undefined);
            setAutoContinueTaskId(undefined);
            setNewTaskOpen(value === NEW_TASK_VALUE);
            setSelectedTaskId(value && value !== NEW_TASK_VALUE ? value : undefined);
          }}>
            <option value="">Choose an open Task…</option>
            {eligibleTasks.map((task) => <option key={task.id} value={task.id}>{task.title}{task.worktree ? ` — ${basename(task.worktree.path)}` : " — worktree required"}</option>)}
            {taskCreation ? <option value={NEW_TASK_VALUE}>＋ New Task…</option> : null}
          </select>
          ) : null}
          {newTaskOpen && !initialTaskId ? (
            <div className="relocation-new-task">
              <label htmlFor="relocation-new-task-title">New Task title</label>
              <div>
                <input
                  id="relocation-new-task-title"
                  value={newTaskTitle}
                  maxLength={160}
                  disabled={moving}
                  autoFocus
                  placeholder="What is this work?"
                  onChange={(event) => { setNewTaskTitle(event.target.value); setError(undefined); }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void createNewTask();
                  }}
                />
                <button className="secondary-button" type="button" disabled={creatingTask || moving || !newTaskTitle.trim()} onClick={() => void createNewTask()}>{creatingTask ? "Creating…" : "Create & continue"}</button>
              </div>
              <p className="field-help">Creates the Task, then closes this dialog. Its row shows worktree progress while the Agent waits to move.</p>
            </div>
          ) : null}
          {session.process.agent_id === "claude" && !initialTaskId ? <>
            <label htmlFor="relocation-mode">Conversation</label>
            <select id="relocation-mode" value={mode} disabled={moving} onChange={(event) => {
              setError(undefined);
              setMode(event.target.value as "resume" | "fresh");
            }}>
              <option value="resume">Continue existing</option>
              <option value="fresh">Start fresh</option>
            </select>
          </> : null}
          {eligibleTasks.length === 0 && !newTaskOpen ? <p className="form-error" role="status">No open Task is available. Choose New Task above.</p> : null}
          {selectedTask && !selectedTask.worktree ? <p className="form-error" role="status">This Task needs a worktree first.</p> : null}
          {blocker ? <p className="form-error" role="status">{blockerMessage(blocker)}</p> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {moving ? <p role="status">The move continues in the background. You can hide this dialog.</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" type="button" onClick={close}>{moving ? "Hide" : error ? "Close" : "No"}</button>
          {selectedTask && !selectedTask.worktree ? <button className="primary-button" type="button" disabled={moving} onClick={() => { setAutoContinueTaskId(selectedTask.id); provision(selectedTask.id); }}>Create worktree & continue…</button> : null}
          {selectedTask?.worktree && !error ? <button className="primary-button" type="button" disabled={!result?.can_relocate || !result.relocation_ticket || !result.manifest || moving} onClick={() => void submit()}>{moving ? "Moving…" : loading || !result ? "Checking…" : "Yes"}</button> : null}
        </footer>
      </section>
    </div>
  );
}

function blockerMessage(blocker: SessionRelocationBlocker): string {
  const messages: Record<SessionRelocationBlocker, string> = {
    sourceNotRunning: "The source Agent is no longer running.",
    sourceNotOrdinaryAgent: "Only ordinary Claude or Codex Agents can be moved.",
    resumeRefMissing: "This Agent has no valid provider resume reference.",
    resumeCapabilityUnavailable: "This provider cannot resume this conversation.",
    freshHandoffUnsupported: "Starting fresh during a move is currently available only for Claude Agents.",
    askToInProgress: "Finish or cancel the current Ask-To request first.",
    sameProjectRequired: "The target Task must belong to the same Project.",
    taskNotOpen: "Reopen the Task before moving the Agent.",
    taskArchived: "Restore the Task before moving the Agent.",
    worktreeRequired: "Provision this Task's worktree first.",
    managedProofMissing: "The target worktree is not safely managed by TermLoop.",
    managedProofMismatch: "The target worktree identity changed; repair it first.",
    worktreeUnhealthy: "The target worktree did not pass its launch-readiness inspection.",
    sourceAlreadyTaskAttached: "This Agent is already projected under a Task.",
    alreadyInTargetWorktree: "This Agent already uses the selected worktree.",
    lifecycleInProgress: "Another Session or Task lifecycle operation is in progress.",
    launchReserved: "The target worktree is temporarily reserved by another lifecycle launch.",
    sourceNotTaskAttached: "This Agent is not currently attached to a managed Task worktree.",
    projectRootUnavailable: "The Project checkout is unavailable.",
  };
  return messages[blocker];
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
