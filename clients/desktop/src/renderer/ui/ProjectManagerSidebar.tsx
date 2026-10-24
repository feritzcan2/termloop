import { useMemo, useState, type ReactNode } from "react";
import type {
  PlaybookMilestoneDto,
  PlaybookRuntimeResult,
  ProjectManagerBoardResult,
  ProjectSprintDto,
  SprintState,
  TaskTrackingDto,
} from "@termloop/contract/current";

import type { AgentStatus, Session, Task } from "../model.js";
import { Icon } from "./Icon.js";
import { agentLabel } from "./workflow-presentation.js";
import {
  agentStatusLabel,
  jiraIssueKey,
  projectManagerStepTrack,
  projectManagerTaskAgent,
  visibleProjectManagerTasks,
} from "./ProjectManagerWorkspace.js";

export type SprintGroup = { sprint: ProjectSprintDto | null; tasks: Task[] };

export type ProjectManagerSprintGroups = {
  active: SprintGroup | null;
  planned: SprintGroup[];
  backlog: SprintGroup;
  closed: SprintGroup[];
};

export function trackingByTask(board: ProjectManagerBoardResult | null): Map<string, TaskTrackingDto> {
  return new Map((board?.tracking ?? []).map((record) => [record.taskId, record]));
}

/// Groups the visible Tasks by their local sprint: the one active sprint,
/// then planned sprints, the backlog, and closed sprints.
export function projectManagerSprintGroups(
  tasks: readonly Task[],
  board: ProjectManagerBoardResult | null,
): ProjectManagerSprintGroups {
  const tracking = trackingByTask(board);
  const sprints = board?.sprints ?? [];
  const group = (sprint: ProjectSprintDto): SprintGroup => ({
    sprint,
    tasks: tasks.filter((task) => tracking.get(task.id)?.sprintId === sprint.id),
  });
  const known = new Set(sprints.map((sprint) => sprint.id));
  const active = sprints.find((sprint) => sprint.state === "active");
  return {
    active: active ? group(active) : null,
    planned: sprints.filter((sprint) => sprint.state === "planned").map(group),
    backlog: {
      sprint: null,
      tasks: tasks.filter((task) => {
        const sprintId = tracking.get(task.id)?.sprintId;
        return !sprintId || !known.has(sprintId);
      }),
    },
    closed: sprints.filter((sprint) => sprint.state === "closed").map(group).reverse(),
  };
}

export type ProjectManagerSidebarActions = {
  addTask(sprintId: string | null): void;
  createSprint(name: string): Promise<string | undefined>;
  updateSprint(sprint: ProjectSprintDto, state: SprintState): Promise<string | undefined>;
  deleteSprint(sprintId: string): Promise<string | undefined>;
  moveTask(taskId: string, sprintId: string | null): Promise<string | undefined>;
};

/// The Project Manager sidebar: local sprints with their Tasks. Only the
/// active sprint's Tasks have Agents, so only they show one.
export function ProjectManagerTaskList(props: {
  tasks: readonly Task[];
  board: ProjectManagerBoardResult | null;
  sessionsById: ReadonlyMap<string, Session>;
  statusesById: ReadonlyMap<string, AgentStatus>;
  milestones: readonly Pick<PlaybookMilestoneDto, "id" | "title">[];
  playbookRuntime: PlaybookRuntimeResult | null;
  selectedTaskId: string | undefined;
  disabled: boolean;
  select(taskId: string): void;
  /// Opens the Task's Agent as a full terminal in place of the Task page.
  openAgent(taskId: string, sessionId: string): void;
  /// The Agent terminal currently filling the stage, if any.
  terminalSessionId: string | undefined;
  openTaskSources(): void;
  actions: ProjectManagerSidebarActions;
}) {
  const [query, setQuery] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [newSprint, setNewSprint] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const visibleTasks = useMemo(
    () => visibleProjectManagerTasks(props.tasks, query, showClosed),
    [props.tasks, query, showClosed],
  );
  const groups = useMemo(() => projectManagerSprintGroups(visibleTasks, props.board), [visibleTasks, props.board]);
  const tracking = useMemo(() => trackingByTask(props.board), [props.board]);
  const run = async (operation: Promise<string | undefined>) => {
    setMessage(undefined);
    const failure = await operation;
    if (failure) setMessage(failure);
  };

  const section = (group: SprintGroup, options: { collapsed?: boolean } = {}) => {
    const key = group.sprint?.id ?? "backlog";
    const state = group.sprint?.state;
    const active = state === "active";
    return <ProjectManagerSprintSection
      key={key}
      group={group}
      defaultOpen={!options.collapsed}
      dropActive={dropTarget === key}
      disabled={props.disabled}
      canStart={state === "planned" && !groups.active}
      onDragOver={() => setDropTarget(key)}
      onDragLeave={() => setDropTarget((current) => current === key ? undefined : current)}
      onDrop={(taskId) => {
        setDropTarget(undefined);
        if ((tracking.get(taskId)?.sprintId ?? null) !== (group.sprint?.id ?? null)) {
          void run(props.actions.moveTask(taskId, group.sprint?.id ?? null));
        }
      }}
      addTask={() => props.actions.addTask(group.sprint?.id ?? null)}
      setState={(next) => group.sprint ? void run(props.actions.updateSprint(group.sprint, next)) : undefined}
      remove={() => group.sprint ? void run(props.actions.deleteSprint(group.sprint.id)) : undefined}
    >
      {group.tasks.map((task) => {
        const record = tracking.get(task.id);
        const agent = active ? projectManagerTaskAgent(task, props.sessionsById) : undefined;
        const status = agent ? props.statusesById.get(agent.id)?.status : undefined;
        const track = projectManagerStepTrack(task.id, props.milestones, props.playbookRuntime);
        const step = track.length > 0 && track.every((entry) => entry.state === "passed")
          ? "Done"
          : track.find((entry) => entry.state === "current")?.title;
        const terminalOpen = Boolean(agent && agent.id === props.terminalSessionId);
        const selected = task.id === props.selectedTaskId && !terminalOpen;
        const detail = active
          ? agent ? null : "No Agent yet"
          : [record?.developer, record?.jiraStatus].filter(Boolean).join(" · ") || null;
        return <li key={task.id}>
          <button
            type="button"
            draggable={!props.disabled}
            className={selected ? "selected" : undefined}
            aria-current={selected ? "true" : undefined}
            onDragStart={(event) => { event.dataTransfer.setData("text/plain", task.id); event.dataTransfer.effectAllowed = "move"; }}
            onClick={() => props.select(task.id)}
          >
            {active
              ? <span className={`pm-agent-dot ${status ?? (agent ? "unknown" : "none")}`} title={status ?? (agent ? "Agent" : "No Agent")} aria-hidden="true" />
              : <span className={`pm-task-status ${task.status}`} aria-hidden="true" />}
            <span className="pm-task-key">{jiraIssueKey(task.jira_url) ?? "Local"}</span>
            <span className="pm-task-title">{task.title}</span>
            {detail ? <span className={`pm-task-agent${active && !agent ? " none" : ""}`}>{detail}</span> : null}
            {active && step ? <span className="pm-task-step">{step}</span> : null}
          </button>
          {agent ? <button
            type="button"
            className={`pm-task-agent-open${terminalOpen ? " selected" : ""}`}
            aria-current={terminalOpen ? "true" : undefined}
            title="Open the Agent's terminal"
            onClick={() => props.openAgent(task.id, agent.id)}
          >
            <Icon name="terminal" />
            <span>{[agentLabel(agent.process.agent_id ?? null), agentStatusLabel(status)].filter(Boolean).join(" · ")}</span>
          </button> : null}
        </li>;
      })}
    </ProjectManagerSprintSection>;
  };

  const openCount = props.tasks.filter((task) => task.status === "open" && task.archived_at_epoch_ms === null).length;
  return <div className="pm-task-list" aria-label="Tasks">
    <header className="pm-task-list-header">
      <span className="pm-eyebrow">Project Manager · {openCount} open</span>
      <div className="pm-task-list-actions">
        <button type="button" className="icon-button quiet" aria-label="Jira settings" title="Jira settings" onClick={props.openTaskSources}>
          <Icon name="settings" />
        </button>
        <button type="button" className="pm-add-task" disabled={props.disabled} onClick={() => props.actions.addTask(groups.active?.sprint?.id ?? null)}>
          <Icon name="add" />Task
        </button>
      </div>
    </header>
    <div className="pm-task-tools">
      <input
        type="search"
        aria-label="Filter Tasks"
        placeholder="Filter by title or Jira key"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <label className="pm-toggle">
        <input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />
        Closed
      </label>
    </div>
    {message ? <p className="form-error pm-list-error" role="alert">{message}</p> : null}
    <div className="pm-sprints">
      {groups.active ? section(groups.active) : null}
      {groups.planned.map((group) => section(group))}
      {newSprint !== undefined ? <form
        className="pm-new-sprint"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newSprint.trim();
          if (!name) return;
          void props.actions.createSprint(name).then((failure) => {
            if (failure) setMessage(failure);
            else setNewSprint(undefined);
          });
        }}
      >
        <input
          aria-label="Sprint name"
          autoFocus
          value={newSprint}
          maxLength={80}
          placeholder="Sprint name"
          onChange={(event) => setNewSprint(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setNewSprint(undefined); }}
        />
        <button type="submit" className="td-mini" disabled={!newSprint.trim()}>Create</button>
      </form> : <button type="button" className="pm-new-sprint-button" disabled={props.disabled} onClick={() => setNewSprint(nextSprintName(props.board?.sprints ?? []))}>
        <Icon name="add" />New sprint
      </button>}
      {section(groups.backlog)}
      {groups.closed.map((group) => section(group, { collapsed: true }))}
      {props.tasks.length === 0 ? <p className="pm-empty">No Tasks yet. Add one, or copy it from Jira.</p> : null}
    </div>
  </div>;
}

export function nextSprintName(sprints: readonly ProjectSprintDto[]): string {
  const numbers = sprints
    .map((sprint) => /(\d+)\s*$/.exec(sprint.name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number);
  return `Sprint ${numbers.length > 0 ? Math.max(...numbers) + 1 : 1}`;
}

function ProjectManagerSprintSection(props: {
  group: SprintGroup;
  defaultOpen: boolean;
  dropActive: boolean;
  disabled: boolean;
  canStart: boolean;
  children: ReactNode;
  onDragOver(): void;
  onDragLeave(): void;
  onDrop(taskId: string): void;
  addTask(): void;
  setState(state: SprintState): void;
  remove(): void;
}) {
  const [open, setOpen] = useState(props.defaultOpen);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { sprint } = props.group;
  const state = sprint?.state;
  const name = sprint?.name ?? "Backlog";
  return <section
    className={`pm-sprint ${state ?? "backlog"}${props.dropActive ? " drop" : ""}`}
    aria-label={name}
    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; props.onDragOver(); }}
    onDragLeave={props.onDragLeave}
    onDrop={(event) => {
      event.preventDefault();
      const taskId = event.dataTransfer.getData("text/plain");
      if (taskId) props.onDrop(taskId);
    }}
  >
    <div className="pm-sprint-head">
      <button type="button" className="pm-sprint-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevronDown" />
        <span className="pm-sprint-name">{name}</span>
        {state === "active" ? <span className="pm-sprint-badge">Active</span> : null}
        <span className="pm-sprint-count">{props.group.tasks.length}</span>
      </button>
      <div className="pm-sprint-actions">
        {state === "planned" ? <button
          type="button"
          className="pm-sprint-action"
          disabled={props.disabled || !props.canStart}
          title={props.canStart ? "Start this sprint; its Tasks get their Agents" : "Complete the active sprint first"}
          onClick={() => props.setState("active")}
        >Start</button> : null}
        {state === "active" ? <button
          type="button"
          className="pm-sprint-action"
          disabled={props.disabled}
          title="Complete this sprint; its Agents stop and their findings stay"
          onClick={() => props.setState("closed")}
        >Complete</button> : null}
        {state === "closed" ? <button
          type="button"
          className="pm-sprint-action"
          disabled={props.disabled}
          title="Reopen as a planned sprint"
          onClick={() => props.setState("planned")}
        >Reopen</button> : null}
        {sprint && state !== "active" ? confirmDelete
          ? <button type="button" className="pm-sprint-action danger" onBlur={() => setConfirmDelete(false)} onClick={props.remove}>Delete?</button>
          : <button type="button" className="icon-button quiet pm-sprint-icon" aria-label={`Delete ${name}`} title="Delete sprint; its Tasks move to the backlog" disabled={props.disabled} onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" />
          </button> : null}
        {state !== "closed" ? <button type="button" className="icon-button quiet pm-sprint-icon" aria-label={`Add Task to ${name}`} title={`Add Task to ${name}`} disabled={props.disabled} onClick={props.addTask}>
          <Icon name="add" />
        </button> : null}
      </div>
    </div>
    {open ? <ol className="pm-task-rows">
      {props.children}
      {props.group.tasks.length === 0 ? <li className="pm-sprint-empty">{sprint ? "Drag Tasks here" : "Nothing in the backlog"}</li> : null}
    </ol> : null}
  </section>;
}
