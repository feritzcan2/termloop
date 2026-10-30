import type { PlaybookRuntimeResult, TaskWorktreeCleanupPreviewDto } from "@termloop/contract/current";
import { useState, type DragEvent } from "react";
import { taskJiraIssueKey, type Task, type TaskDeleteWorktreeResult, type TaskDeleteWorktreeReview } from "../model.js";
import { taskCardTitle } from "../task-card-copy.js";
import { OverlayPortal } from "./OverlayPortal.js";
import { DeleteTaskDialog } from "./task-dialogs/delete-task-dialog.js";
import { useOverlayLease } from "./overlay-lease.js";
import { PlaybookTaskNotes, type SavePlaybookTaskNotes } from "./PlaybookTaskNotes.js";
import { Icon } from "./Icon.js";
import { PlaybookTaskDecisionStrip, type PlaybookTaskDecisionHandle } from "./PlaybookTaskDecision.js";

export type AssistantTaskPlacement = Readonly<{
  byRoutineId: ReadonlyMap<string, readonly Task[]>;
  completed: readonly Task[];
  unplaced: readonly Task[];
  closed: readonly Task[];
}>;

/** The runtime is the authority for a Task's current pipeline position. Closed
    Tasks stay in their own archive group even if a just-refreshed runtime still
    mentions them, and a Task is rendered only at its first reported position. */
export function assistantTaskPlacement(
  tasks: readonly Task[],
  runtime: PlaybookRuntimeResult | null,
  renderedRoutineIds?: ReadonlySet<string>,
): AssistantTaskPlacement {
  const openTasks = tasks.filter((task) => task.status === "open");
  const taskById = new Map(openTasks.map((task) => [task.id, task]));
  const placed = new Set<string>();
  const take = (taskIds: readonly string[]): Task[] => taskIds.flatMap((taskId) => {
    const task = taskById.get(taskId);
    if (!task || placed.has(taskId)) return [];
    placed.add(taskId);
    return [task];
  });
  const byRoutineId = new Map<string, readonly Task[]>();
  for (const step of runtime?.steps ?? []) {
    if (renderedRoutineIds && !renderedRoutineIds.has(step.routineId)) continue;
    const positioned = take(step.waitingTaskIds);
    if (positioned.length > 0) {
      byRoutineId.set(step.routineId, [...(byRoutineId.get(step.routineId) ?? []), ...positioned]);
    }
  }
  const completed = take(runtime?.doneTaskIds ?? []);
  return {
    byRoutineId,
    completed,
    unplaced: openTasks.filter((task) => !placed.has(task.id)),
    closed: tasks.filter((task) => task.status === "closed"),
  };
}

/** Closing a completed Task from the Playbook reuses the Task rail's close
    path: a Task with a worktree goes through the same inspected removal
    dialog, and one without a worktree closes directly. */
export type CloseCompletedTask = Readonly<{
  inspect(taskId: string): Promise<TaskWorktreeCleanupPreviewDto>;
  closeTaskAndWorktree(taskId: string, review?: TaskDeleteWorktreeReview): Promise<TaskDeleteWorktreeResult>;
  busyTaskIds: ReadonlySet<string>;
  overlayContainer: Element | undefined;
  /** The native terminal sits above the page; while the dialog is open it
      must hold an overlay lease or the terminal keeps its clicks and focus. */
  overlayVisibilityChanged(visible: boolean): void;
}>;

function CloseCompletedTaskButton(props: { task: Task; close: CloseCompletedTask; disabled?: boolean | undefined }) {
  const [reviewing, setReviewing] = useState(false);
  useOverlayLease(reviewing, props.close.overlayVisibilityChanged);
  const busy = props.close.busyTaskIds.has(props.task.id);
  const label = props.task.worktree
    ? `Close ${props.task.title} and remove its worktree`
    : `Close ${props.task.title}`;
  return <>
    <button
      type="button"
      className="assistant-task-close"
      aria-label={label}
      title={props.task.worktree ? "Close Task and remove worktree" : "Close Task"}
      disabled={props.disabled || busy}
      onClick={() => {
        if (props.task.worktree) setReviewing(true);
        else void props.close.closeTaskAndWorktree(props.task.id);
      }}
    ><Icon name="close" /></button>
    {reviewing ? <OverlayPortal container={props.close.overlayContainer}><DeleteTaskDialog
      task={props.task}
      inspect={props.close.inspect}
      close={() => setReviewing(false)}
      closeAfterWorktreeRemoval
      remove={(review) => { void props.close.closeTaskAndWorktree(props.task.id, review); }}
    /></OverlayPortal> : null}
  </>;
}

export function AssistantTaskRow(props: {
  task: Task;
  /** Every Task whose own step check is running; each is checked independently. */
  processingTaskIds: readonly string[];
  openTask(taskId: string): void;
  saveTaskNotes?: SavePlaybookTaskNotes | undefined;
  notesDisabled?: boolean | undefined;
  dragging?: boolean;
  /** The Task pointed at or clicked in the Task rail. */
  highlighted?: boolean | undefined;
  beginDrag?: ((task: Task, event: DragEvent<HTMLButtonElement>) => void) | undefined;
  endDrag?: (() => void) | undefined;
  decision?: PlaybookTaskDecisionHandle | null | undefined;
  openSteward?: (() => void) | undefined;
  closeTask?: CloseCompletedTask | undefined;
  /** Offered only at a human gate: the approver passes the Task through it. */
  approve?: { approver: string | null; busy: boolean; run(): void } | undefined;
}) {
  const decision = props.decision?.decision.taskIds.includes(props.task.id) ? props.decision : null;
  const processing = props.processingTaskIds.includes(props.task.id);
  const draggable = props.task.status === "open" && props.beginDrag !== undefined;
  /** The ticket key leads the title, as on the Task rail's card. */
  const title = taskCardTitle(props.task.title, props.task.jira_url ? taskJiraIssueKey(props.task.jira_url) : undefined);
  return <div className="assistant-task-item" role="listitem"><button
    type="button"
    className={`assistant-task-row${processing ? " processing" : ""}${props.dragging ? " dragging" : ""}${props.highlighted ? " highlighted" : ""}`}
    data-highlighted={props.highlighted ? "true" : undefined}
    draggable={draggable}
    data-playbook-task-id={draggable ? props.task.id : undefined}
    data-playbook-processing={processing ? "true" : undefined}
    aria-label={processing ? `${props.task.title}, processing now` : props.task.title}
    onDragStart={draggable ? (event) => props.beginDrag?.(props.task, event) : undefined}
    onDragEnd={draggable ? props.endDrag : undefined}
    onClick={() => props.openTask(props.task.id)}
  >
    <span className="assistant-task-icon" aria-hidden="true"><Icon name="task" /></span>
    <span className="assistant-task-copy">
      <strong>{title.key ? <span className="assistant-task-key">{title.key}</span> : null}{title.scope ? `[${title.scope}] ` : ""}{title.title}</strong>
      <small>{props.task.branch?.name ?? (props.task.worktree ? "Worktree ready" : "No worktree")}</small>
    </span>
    {processing ? <em>Active</em> : null}
  </button>{props.approve && props.task.status === "open"
    ? <button
      type="button"
      className="assistant-task-approve"
      aria-label={`Approve ${props.task.title} and pass this gate`}
      title={props.approve.approver ? `Approve as ${props.approve.approver} and move to the next step` : "Approve and move to the next step"}
      disabled={props.notesDisabled || props.approve.busy}
      onClick={props.approve.run}
    ><Icon name="check" /></button>
    : null}{props.closeTask && props.task.status === "open"
    ? <CloseCompletedTaskButton task={props.task} close={props.closeTask} disabled={props.notesDisabled} />
    : null}{props.saveTaskNotes ? <PlaybookTaskNotes task={props.task} save={props.saveTaskNotes} disabled={props.notesDisabled} /> : null}
  {decision ? <PlaybookTaskDecisionStrip
    taskTitle={props.task.title}
    handle={decision}
    disabled={props.notesDisabled}
    openSteward={props.openSteward ?? (() => props.openTask(props.task.id))}
  /> : null}</div>;
}

export function AssistantTaskTail(props: {
  placement: AssistantTaskPlacement;
  processingTaskIds: readonly string[];
  openTask(taskId: string): void;
  saveTaskNotes?: SavePlaybookTaskNotes | undefined;
  notesDisabled?: boolean | undefined;
  draggingTaskId?: string | undefined;
  highlightedTaskId?: string | undefined;
  beginDrag?: ((task: Task, event: DragEvent<HTMLButtonElement>) => void) | undefined;
  endDrag?: (() => void) | undefined;
  decision?: PlaybookTaskDecisionHandle | null | undefined;
  openSteward?: (() => void) | undefined;
  /** Offered only on Completed Tasks: they finished the Playbook and are ready to close. */
  closeTask?: CloseCompletedTask | undefined;
}) {
  const groups = [
    { key: "completed", label: "Completed Tasks", tasks: props.placement.completed },
    { key: "unplaced", label: "Tasks awaiting pipeline position", tasks: props.placement.unplaced },
    { key: "closed", label: "Closed Tasks", tasks: props.placement.closed },
  ] as const;
  return <>{groups.map((group) => group.tasks.length > 0 ? <section
    key={group.key}
    className={`assistant-task-tail ${group.key}`}
    aria-label={group.label}
  >
    <span className="ar-routines-label">{group.label} · {group.tasks.length}</span>
    <div role="list">{group.tasks.map((task) => <AssistantTaskRow
      key={task.id}
      task={task}
      processingTaskIds={props.processingTaskIds}
      openTask={props.openTask}
      saveTaskNotes={props.saveTaskNotes}
      notesDisabled={props.notesDisabled}
      dragging={props.draggingTaskId === task.id}
      highlighted={props.highlightedTaskId === task.id}
      beginDrag={props.beginDrag}
      endDrag={props.endDrag}
      decision={props.decision}
      openSteward={props.openSteward}
      closeTask={group.key === "completed" ? props.closeTask : undefined}
    />)}</div>
  </section> : null)}</>;
}
