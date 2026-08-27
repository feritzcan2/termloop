import type { PlaybookRuntimeResult } from "@termloop/contract/current";
import type { DragEvent } from "react";
import type { Task } from "../model.js";
import { Icon } from "./Icon.js";

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

export function AssistantTaskRow(props: {
  task: Task;
  processingTaskId: string | null;
  openTask(taskId: string): void;
  dragging?: boolean;
  beginDrag?: ((task: Task, event: DragEvent<HTMLButtonElement>) => void) | undefined;
  endDrag?: (() => void) | undefined;
}) {
  const processing = props.processingTaskId === props.task.id;
  const draggable = props.task.status === "open" && props.beginDrag !== undefined;
  return <button
    type="button"
    className={`assistant-task-row${processing ? " processing" : ""}${props.dragging ? " dragging" : ""}`}
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
      <strong>{props.task.title}</strong>
      <small>{props.task.branch?.name ?? (props.task.worktree ? "Worktree ready" : "No worktree")}</small>
    </span>
    {processing ? <em>Active</em> : null}
  </button>;
}

export function AssistantTaskTail(props: {
  placement: AssistantTaskPlacement;
  processingTaskId: string | null;
  openTask(taskId: string): void;
  draggingTaskId?: string | undefined;
  beginDrag?: ((task: Task, event: DragEvent<HTMLButtonElement>) => void) | undefined;
  endDrag?: (() => void) | undefined;
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
      processingTaskId={props.processingTaskId}
      openTask={props.openTask}
      dragging={props.draggingTaskId === task.id}
      beginDrag={props.beginDrag}
      endDrag={props.endDrag}
    />)}</div>
  </section> : null)}</>;
}
