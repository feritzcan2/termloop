// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookRuntimeResult, ProjectManagerBoardResult } from "@termloop/contract/current";

import type { Session, Task } from "../src/renderer/model.js";
import {
  ProjectManagerStage,
  projectManagerFindingsSections,
  jiraIssueKey,
  projectManagerStepTrack,
  projectManagerTaskAgent,
  visibleProjectManagerTasks,
  type ProjectManagerWorkspaceActions,
} from "../src/renderer/ui/ProjectManagerWorkspace.js";
import { ProjectManagerTaskList, nextSprintName, projectManagerSprintGroups } from "../src/renderer/ui/ProjectManagerSidebar.js";
import { jiraWikiToMarkdown, sameTicket, ticketDraft, ticketFieldChanges, ticketSaveParams } from "../src/renderer/ui/project-manager-ticket.js";
import { ProjectManagerTicketHistory } from "../src/renderer/ui/ProjectManagerTicketHistory.js";
import { ProjectManagerAddTaskDialog } from "../src/renderer/ui/ProjectManagerAddTaskDialog.js";
import { PROFILED_DESKTOP_OPERATIONS } from "../src/source-operations.js";
import { projectManagerLayoutActive } from "../src/renderer/ui/ProjectModeMenuItems.js";

const NOW = 1_700_000_000_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Checkout times out",
    brief: "Users see a timeout at checkout.",
    jira_url: "https://example.atlassian.net/browse/PAY-42",
    status: "open",
    archived_at_epoch_ms: null,
    branch: { repository_root: "/repository", name: "task/pay-42" },
    worktree: { path: "/worktrees/pay-42" },
    rank: 1,
    created_at_epoch_ms: NOW,
    updated_at_epoch_ms: NOW,
    ...overrides,
  } as Task;
}

function agent(overrides: Partial<Session> = {}): Session {
  return {
    id: "agent-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
    process: { program: "claude", args: [], cwd: "/worktrees/pay-42", agent_id: "claude", template_ref: "builtin.agent.task-investigation", template_version: 1 },
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: true,
    forkable: false,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    ...overrides,
  } as Session;
}

const milestones = [
  { id: "merged", title: "Merged" },
  { id: "staging", title: "Deployed to staging" },
  { id: "production", title: "Deployed to production" },
];

function runtime(overrides: Partial<PlaybookRuntimeResult> = {}): PlaybookRuntimeResult {
  return {
    processingTaskIds: [],
    evaluations: [],
    activePipelineName: "Delivery",
    evaluation: null,
    processingTaskId: null,
    steps: [
      { milestoneId: "merged", routineId: "r1", waitingTaskIds: [], progress: [], agentReports: [], nextAttemptAtEpochMs: null },
      {
        milestoneId: "staging", routineId: "r2", waitingTaskIds: ["task-1"], agentReports: [], nextAttemptAtEpochMs: null,
        progress: [{ evaluator: "routine", deterministicFallback: null, taskId: "task-1", verdict: "waiting", evidence: "Deploy #812 is still running", decidedAtEpochMs: NOW, nextAttemptAtEpochMs: null }],
      },
      { milestoneId: "production", routineId: "r3", waitingTaskIds: [], progress: [], agentReports: [], nextAttemptAtEpochMs: null },
    ],
    doneTaskIds: ["task-done"],
    stateRevision: 3,
    ...overrides,
  } as PlaybookRuntimeResult;
}

function board(overrides: Partial<ProjectManagerBoardResult> = {}): ProjectManagerBoardResult {
  return {
    projectId: "project-1",
    sprints: [
      { id: "s14", name: "Sprint 14", state: "active", createdAtEpochMs: NOW },
      { id: "s15", name: "Sprint 15", state: "planned", createdAtEpochMs: NOW },
      { id: "s13", name: "Sprint 13", state: "closed", createdAtEpochMs: NOW },
    ],
    tracking: [
      { taskId: "task-1", sprintId: "s14", developer: "Ada", jiraStatus: "In Review", environments: [{ name: "Staging", state: "deployed", detail: "v1.4" }], blockers: null, note: null, updatedAtEpochMs: NOW },
      { taskId: "task-2", sprintId: "s15", developer: "Linus", jiraStatus: "To Do", environments: [], blockers: null, note: null, updatedAtEpochMs: NOW },
    ],
    tickets: [],
    stateRevision: 4,
    ...overrides,
  };
}

function actions(overrides: Partial<ProjectManagerWorkspaceActions> = {}): ProjectManagerWorkspaceActions {
  return {
    loadBoard: async () => board(),
    createSprint: async () => board(),
    updateSprint: async () => board(),
    deleteSprint: async () => board(),
    setTracking: async () => board(),
    createTask: async () => ({ task: task(), board: board() }),
    searchJira: async () => ({ issues: [], truncated: false, failureReason: null }),
    loadPlaybook: async () => ({ playbook: null, stateRevision: 1 }),
    saveTicket: vi.fn(async () => ({ taskId: "task-1", version: 1, board: board() })),
    loadTicketVersions: vi.fn(async () => ({ taskId: "task-1", versions: [] })),
    restoreTicket: vi.fn(async () => ({ taskId: "task-1", version: 1, board: board() })),
    startTaskAgent: vi.fn(async () => undefined),
    requestInvestigation: vi.fn(async () => undefined),
    openTaskSources: vi.fn(),
    openPlaybookBuilder: vi.fn(),
    openExternal: vi.fn(),
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(label));

describe("Project Manager layout helpers", () => {
  it("is used only while the switch is on and the daemon says Project Manager", () => {
    expect(projectManagerLayoutActive(false, "projectManager")).toBe(false);
    expect(projectManagerLayoutActive(true, "developer")).toBe(false);
    expect(projectManagerLayoutActive(true, undefined)).toBe(false);
    expect(projectManagerLayoutActive(true, "projectManager")).toBe(true);
  });

  it("places a Task on the Playbook from the daemon runtime", () => {
    expect(projectManagerStepTrack("task-1", milestones, runtime()).map((step) => [step.state, step.evidence])).toEqual([
      ["passed", null],
      ["current", "Deploy #812 is still running"],
      ["ahead", null],
    ]);
    expect(projectManagerStepTrack("task-done", milestones, runtime()).every((step) => step.state === "passed")).toBe(true);
    expect(projectManagerStepTrack("unplaced", milestones, null).every((step) => step.state === "ahead")).toBe(true);
  });

  it("reads Jira keys, filters Tasks, and picks the Task's own Agent over helpers", () => {
    expect(jiraIssueKey("https://example.atlassian.net/browse/PAY-42")).toBe("PAY-42");
    expect(jiraIssueKey("https://example.com/not-an-issue")).toBeNull();
    const tasks = [task(), task({ id: "task-2", title: "Old", status: "closed", jira_url: null, rank: 2 })];
    expect(visibleProjectManagerTasks(tasks, "pay-4", false).map((item) => item.id)).toEqual(["task-1"]);
    expect(visibleProjectManagerTasks(tasks, "", true).map((item) => item.id)).toEqual(["task-1", "task-2"]);
    const helper = agent({ id: "helper", ask_to_source_session_id: "agent-1" });
    const sessions = new Map([["helper", helper], ["agent-1", agent()]]);
    expect(projectManagerTaskAgent(task(), sessions)?.id).toBe("agent-1");
    expect(projectManagerTaskAgent(task({ worktree: null }), sessions)).toBeUndefined();
    // A stopped Agent has no terminal to open.
    expect(projectManagerTaskAgent(task(), new Map([["agent-1", agent({ lifecycle_state: "exited" })]]))).toBeUndefined();
  });

  it("splits the Agent's findings into Observed, Inferred, and Unknown", () => {
    expect(projectManagerFindingsSections("Intro line\n## Observed\n- PR #9 merged\n\n## Inferred\n* On staging\n## Unknown\n- Production")).toEqual([
      { title: "Notes", tone: "other", lines: ["Intro line"] },
      { title: "Observed", tone: "observed", lines: ["PR #9 merged"] },
      { title: "Inferred", tone: "inferred", lines: ["On staging"] },
      { title: "Unknown", tone: "unknown", lines: ["Production"] },
    ]);
  });

  it("allowlists the Project Manager Task commands", () => {
    expect(PROFILED_DESKTOP_OPERATIONS.taskInvestigationRequest).toBe("termloop:task-investigation-request");
    expect(PROFILED_DESKTOP_OPERATIONS.taskProjectManagerAgentStart).toBe("termloop:task-project-manager-agent-start");
  });
});

describe("Project Manager workspace", () => {
  it("groups Tasks by local sprint and shows Agents only in the active sprint", async () => {
    const select = vi.fn();
    const moveTask = vi.fn(async () => undefined);
    const updateSprint = vi.fn(async () => undefined);
    const addTask = vi.fn();
    const openAgent = vi.fn();
    await act(async () => root.render(<ProjectManagerTaskList
      tasks={[task(), task({ id: "task-2", title: "Planned work", jira_url: null, worktree: null, rank: 2 }), task({ id: "task-3", title: "Loose idea", jira_url: null, worktree: null, rank: 3 })]}
      board={board()}
      sessionsById={new Map([["agent-1", agent()]])}
      statusesById={new Map([["agent-1", { sessionId: "agent-1", status: "working", source: "hook", observedAtEpochMs: NOW }]])}
      milestones={milestones}
      playbookRuntime={runtime()}
      selectedTaskId="task-1"
      disabled={false}
      select={select}
      openAgent={openAgent}
      terminalSessionId={undefined}
      openTaskSources={vi.fn()}
      actions={{ addTask, createSprint: vi.fn(async () => undefined), updateSprint, deleteSprint: vi.fn(async () => undefined), moveTask }}
    />));
    const sections = [...host.querySelectorAll(".pm-sprint")];
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Sprint 14", "Sprint 15", "Backlog", "Sprint 13"]);
    const activeRow = sections[0]!.querySelector(".pm-task-rows button")!;
    expect(activeRow.querySelector(".pm-task-key")?.textContent).toBe("PAY-42");
    expect(activeRow.querySelector(".pm-agent-dot")?.className).toContain("working");
    const agentButton = sections[0]!.querySelector<HTMLButtonElement>(".pm-task-agent-open")!;
    expect(agentButton.textContent).toBe("Claude · Working");
    await act(async () => agentButton.click());
    expect(openAgent).toHaveBeenCalledWith("task-1", "agent-1");
    expect(activeRow.querySelector(".pm-task-step")?.textContent).toBe("Deployed to staging");
    const plannedRow = sections[1]!.querySelector(".pm-task-rows button")!;
    expect(plannedRow.querySelector(".pm-agent-dot")).toBeNull();
    expect(plannedRow.querySelector(".pm-task-agent")?.textContent).toBe("Linus · To Do");
    expect(sections[2]!.textContent).toContain("Loose idea");
    // Closed sprints start collapsed.
    expect(sections[3]!.querySelector(".pm-task-rows")).toBeNull();
    // Only one sprint can be active, so a planned one cannot start yet.
    expect(button("Start")!.disabled).toBe(true);
    await act(async () => button("Complete")!.click());
    expect(updateSprint).toHaveBeenCalledWith(expect.objectContaining({ id: "s14" }), "closed");
    await act(async () => (plannedRow as HTMLButtonElement).click());
    expect(select).toHaveBeenCalledWith("task-2");
    await act(async () => button("Task")!.click());
    expect(addTask).toHaveBeenCalledWith("s14");
  });

  it("names the next sprint and groups unknown sprints into the backlog", () => {
    expect(nextSprintName([])).toBe("Sprint 1");
    expect(nextSprintName(board().sprints)).toBe("Sprint 16");
    const groups = projectManagerSprintGroups([task({ id: "orphan" })], board({ tracking: [{ ...board().tracking[0]!, taskId: "orphan", sprintId: "gone" }] }));
    expect(groups.backlog.tasks.map((item) => item.id)).toEqual(["orphan"]);
  });

  it("turns the ticket into one versioned save and shows Jira wiki as Markdown", () => {
    const tracking = board().tracking[0]!;
    const draft = ticketDraft(task({ brief: "h2. Goal\n* Fix *checkout* in {{api}}" }), tracking, false);
    expect(draft.brief).toBe("## Goal\n\n- Fix **checkout** in `api`");
    expect(ticketDraft(task({ brief: "h2. Goal" }), tracking, true).brief).toBe("h2. Goal");
    expect(jiraWikiToMarkdown("{code}\nnpm test\n{code}")).toBe("```\nnpm test\n```");
    expect(ticketSaveParams("task-1", { ...draft, developer: "  ", environments: [...draft.environments, { name: " ", state: "unknown", detail: "" }] }, " Staging done ", 3)).toEqual({
      taskId: "task-1", title: "Checkout times out", brief: "## Goal\n\n- Fix **checkout** in `api`", developer: null, jiraStatus: "In Review",
      environments: [{ name: "Staging", state: "deployed", detail: "v1.4" }], blockers: null, note: null,
      summary: "Staging done", expectedVersion: 3,
    });
    expect(sameTicket(draft, { ...draft, note: "  " })).toBe(true);
    expect(sameTicket(draft, { ...draft, note: "Ask QA" })).toBe(false);
    const before = { title: "A", brief: "x", developer: null, jiraStatus: "To Do", environments: [], blockers: null, note: null };
    expect(ticketFieldChanges(before, { ...before, jiraStatus: "Done", environments: [{ name: "Prod", state: "deployed" as const, detail: "v2" }] })).toEqual([
      { field: "Jira status", before: "To Do", after: "Done" },
      { field: "Environments", before: "", after: "Prod: Deployed (v2)" },
    ]);
  });

  it("lists ticket versions, shows what one changed, and restores it", async () => {
    const restore = vi.fn(async () => undefined);
    const content = { title: "Checkout times out", brief: "Users wait.", developer: "Ada", jiraStatus: "To Do", environments: [], blockers: null, note: null };
    await act(async () => root.render(<ProjectManagerTicketHistory
      taskId="task-1"
      headVersion={2}
      disabled={false}
      load={async () => ({ taskId: "task-1", versions: [
        { number: 2, author: "agent", summary: "PR #9 merged", createdAtEpochMs: NOW, content: { ...content, brief: "Users wait at checkout.", jiraStatus: "In Review" } },
        { number: 1, author: "projectManager", summary: "Created", createdAtEpochMs: NOW, content },
      ] })}
      restore={restore}
      close={vi.fn()}
    />));
    const versions = [...host.querySelectorAll<HTMLButtonElement>(".pm-version")];
    expect(versions.map((version) => version.textContent)).toEqual([expect.stringContaining("v2Current"), expect.stringContaining("v1")]);
    expect(versions[0]!.textContent).toContain("PR #9 merged");
    expect(host.querySelector(".pm-field-changes")?.textContent).toContain("To DoIn Review");
    expect(host.querySelector(".pm-diff ins")?.textContent).toContain("at checkout");
    expect(button("Restore")).toBeUndefined();
    await act(async () => versions[1]!.click());
    await act(async () => button("Restore")!.click());
    expect(restore).toHaveBeenCalledWith(1);
  });

  it("copies a Jira issue into a new Task in the chosen sprint", async () => {
    const create = vi.fn(async () => undefined);
    const close = vi.fn();
    await act(async () => root.render(<ProjectManagerAddTaskDialog
      sprints={board().sprints}
      defaultSprintId="s14"
      searchJira={async () => ({
        issues: [
          { key: "PAY-42", url: "https://example.atlassian.net/browse/PAY-42", summary: "Checkout times out", description: "Users wait.", statusName: "In Progress", assigneeDisplay: "Ada", taskId: null },
          { key: "PAY-7", url: "https://example.atlassian.net/browse/PAY-7", summary: "Old", description: null, statusName: "Done", assigneeDisplay: null, taskId: "task-9" },
        ],
        truncated: false,
        failureReason: null,
      })}
      create={create}
      openTaskSources={vi.fn()}
      close={close}
    />));
    const search = host.querySelector<HTMLInputElement>('input[aria-label="Search Jira"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "checkout");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Search")!.click());
    const results = [...host.querySelectorAll<HTMLButtonElement>(".pm-jira-results button")];
    expect(results[1]!.disabled).toBe(true);
    expect(results[1]!.textContent).toContain("Already a Task");
    await act(async () => results[0]!.click());
    expect(host.querySelector<HTMLInputElement>("#pm-add-title")!.value).toBe("Checkout times out");
    await act(async () => button("Add Task")!.click());
    expect(create).toHaveBeenCalledWith({
      title: "Checkout times out", brief: "Users wait.", sprintId: "s14",
      jiraUrl: "https://example.atlassian.net/browse/PAY-42", developer: "Ada", jiraStatus: "In Progress",
    });
    expect(close).toHaveBeenCalled();
  });

  it("shows the ticket, the Agent's findings and terminal, and asks it to check again", async () => {
    const saveTicket = vi.fn(async () => undefined);
    const workspace = actions();
    await act(async () => root.render(<ProjectManagerStage
      task={task({ steward_brief_markdown: "## Observed\n- PR #9 merged" })}
      board={board()}
      setTracking={vi.fn(async () => undefined)}
      saveTicket={saveTicket}
      restoreTicket={vi.fn(async () => undefined)}
      addTask={vi.fn()}
      sessionsById={new Map([["agent-1", agent()]])}
      milestones={milestones as never}
      playbookError={undefined}
      playbookRuntime={runtime()}
      agents={[{ id: "claude", label: "Claude" }]}
      disabled={false}
      actions={workspace}
      renderTerminal={(sessionId) => <div data-terminal={sessionId} />}
    />));
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')?.value).toBe("Checkout times out");
    expect(host.querySelector(".pm-md")?.textContent).toContain("Users see a timeout at checkout.");
    expect(host.querySelector(".pm-finding.observed li")?.textContent).toBe("PR #9 merged");
    expect(host.querySelector(".pm-meta-step")?.textContent).toBe("Deployed to staging");
    expect(host.querySelector(".pm-delivery")?.textContent).toContain("Deploy #812 is still running");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Sprint"]')?.value).toBe("s14");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Developer"]')?.value).toBe("Ada");
    expect(host.querySelector("[data-terminal]")?.getAttribute("data-terminal")).toBe("agent-1");
    expect([...host.querySelectorAll(".pm-step")].map((step) => step.getAttribute("data-step-state"))).toEqual(["passed", "current", "ahead"]);
    await act(async () => button("Check again")!.click());
    expect(workspace.requestInvestigation).toHaveBeenCalledWith("task-1");
  });

  it("keeps Tasks outside the active sprint without an Agent and offers to move them in", async () => {
    const saveTicket = vi.fn(async () => undefined);
    const setTracking = vi.fn(async () => undefined);
    await act(async () => root.render(<ProjectManagerStage
      task={task({ id: "task-2", title: "Planned work" })}
      board={board()}
      setTracking={setTracking}
      saveTicket={saveTicket}
      restoreTicket={vi.fn(async () => undefined)}
      addTask={vi.fn()}
      sessionsById={new Map([["agent-1", agent()]])}
      milestones={milestones as never}
      playbookError={undefined}
      playbookRuntime={runtime()}
      agents={[{ id: "claude", label: "Claude" }]}
      disabled={false}
      actions={actions()}
      renderTerminal={(sessionId) => <div data-terminal={sessionId} />}
    />));
    expect(host.querySelector("[data-terminal]")).toBeNull();
    expect(host.textContent).toContain("Agents run only for Tasks in the active sprint (Sprint 14)");
    await act(async () => button("Move to Sprint 14")!.click());
    expect(setTracking).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-2", sprintId: "s14", developer: "Linus" }));
  });

  it("edits the ticket in TermLoop and starts an Agent for a Task without one", async () => {
    const saveTicket = vi.fn(async () => undefined);
    const workspace = actions({ startTaskAgent: vi.fn(async () => "The selected agent CLI is unavailable.") });
    await act(async () => root.render(<ProjectManagerStage
      task={task({ worktree: null })}
      board={board()}
      setTracking={vi.fn(async () => undefined)}
      saveTicket={saveTicket}
      restoreTicket={vi.fn(async () => undefined)}
      addTask={vi.fn()}
      sessionsById={new Map()}
      milestones={[]}
      playbookError={undefined}
      playbookRuntime={null}
      agents={[{ id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }]}
      disabled={false}
      actions={workspace}
      renderTerminal={() => null}
    />));
    expect(host.textContent).toContain("No Playbook yet");
    expect(host.textContent).toContain("Jira is not changed");
    expect(host.querySelector(".pm-save-bar")).toBeNull();
    const title = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, "Checkout times out on mobile");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".pm-save-bar")?.textContent).toContain("Unsaved changes");
    await act(async () => button("Save version")!.click());
    expect(saveTicket).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1", title: "Checkout times out on mobile", brief: "Users see a timeout at checkout.", developer: "Ada", expectedVersion: null,
    }));

    expect([...host.querySelectorAll(".pm-agent-choices button")].map((choice) => choice.textContent)).toEqual([
      "Start with Claude",
      "Start with Codex",
    ]);
    await act(async () => button("Start with Codex")!.click());
    expect(workspace.startTaskAgent).toHaveBeenCalledWith("task-1", "codex");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The selected agent CLI is unavailable.");
  });

  it("keeps the Project Manager's draft when the Agent saves a newer version", async () => {
    const saveTicket = vi.fn(async () => "state revision changed");
    const stage = (version: number, brief: string) => <ProjectManagerStage
      task={task({ brief })}
      board={board({ tickets: [{ taskId: "task-1", number: version, author: version > 1 ? "agent" : "projectManager", summary: null, createdAtEpochMs: NOW }] })}
      setTracking={vi.fn(async () => undefined)}
      saveTicket={saveTicket}
      restoreTicket={vi.fn(async () => undefined)}
      addTask={vi.fn()}
      sessionsById={new Map([["agent-1", agent()]])}
      milestones={[]}
      playbookError={undefined}
      playbookRuntime={null}
      agents={[]}
      disabled={false}
      actions={actions()}
      renderTerminal={() => null}
    />;
    await act(async () => root.render(stage(1, "Users wait.")));
    expect(host.querySelector(".pm-version-badge")?.textContent).toContain("v1");
    const note = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Ask QA");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(stage(2, "Users wait at checkout.")));
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!.value).toBe("Ask QA");
    expect(host.querySelector(".pm-banner.warning")?.textContent).toContain("The Agent saved v2 while you were editing.");
    await act(async () => button("Save version")!.click());
    expect(saveTicket).toHaveBeenCalledWith(expect.objectContaining({ note: "Ask QA", expectedVersion: 1 }));
    expect(host.querySelector(".pm-banner.warning")?.textContent).toContain("Saving yours would replace it.");
    await act(async () => button("Load v2")!.click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!.value).toBe("");
    expect(host.querySelector(".pm-md")?.textContent).toContain("Users wait at checkout.");
    expect(host.querySelector(".pm-save-bar")).toBeNull();
  });
});
