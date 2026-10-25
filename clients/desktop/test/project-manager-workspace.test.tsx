// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectManagerBoardResult, TaskDeliveryFactsDto } from "@termloop/contract/current";

import type { Task } from "../src/renderer/model.js";
import {
  ProjectManagerStage,
  projectManagerFindingsSections,
  jiraIssueKey,
  projectManagerTaskCheck,
  visibleProjectManagerTasks,
  type ProjectManagerWorkspaceActions,
} from "../src/renderer/ui/ProjectManagerWorkspace.js";
import { ProjectManagerTaskList, nextSprintName, projectManagerSprintGroups } from "../src/renderer/ui/ProjectManagerSidebar.js";
import { jiraWikiToMarkdown, sameTicket, ticketDraft, ticketFieldChanges, ticketSaveParams } from "../src/renderer/ui/project-manager-ticket.js";
import { ProjectManagerTicketHistory } from "../src/renderer/ui/ProjectManagerTicketHistory.js";
import { ProjectManagerAddTaskDialog } from "../src/renderer/ui/ProjectManagerAddTaskDialog.js";
import { PROFILED_DESKTOP_OPERATIONS } from "../src/source-operations.js";
import { projectManagerDigest } from "../src/renderer/ui/ProjectManagerOverview.js";
import { argvText, commandArgv } from "../src/renderer/ui/ProjectManagerProbes.js";
import { projectManagerLayoutActive } from "../src/renderer/ui/ProjectModeMenuItems.js";
import { projectManagerStageTrack, stageLabel } from "../src/renderer/ui/project-manager-stage.js";
import { ProjectManagerEnvironments } from "../src/renderer/ui/ProjectManagerEnvironments.js";

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

function facts(overrides: Partial<TaskDeliveryFactsDto> = {}): TaskDeliveryFactsDto {
  return {
    taskId: "task-1",
    jira: { status: "In Review", statusCategory: "indeterminate", assignee: "Ada Lovelace", observedAtEpochMs: NOW, changedAtEpochMs: NOW },
    pullRequests: {
      repository: "github.com/acme/pay",
      items: [{ number: 9, title: "PAY-42 retry checkout", url: "https://github.com/acme/pay/pull/9", state: "merged", checks: "passing", baseBranch: "main", headBranch: "feature/PAY-42", mergeCommit: "abc1234", updatedAtEpochMs: NOW }],
      truncated: false,
      observedAtEpochMs: NOW,
      changedAtEpochMs: NOW,
    },
    environments: [{ name: "Staging", state: "deployed", detail: "v1.4", source: "check", observedAtEpochMs: NOW, changedAtEpochMs: NOW }],
    checkNotes: { blockers: "Waiting for QA", markdown: "## Observed\n- deploy-staging run 812 shipped v1.4", recordedAtEpochMs: NOW },
    readFailures: [],
    ...overrides,
  };
}

function board(overrides: Partial<ProjectManagerBoardResult> = {}): ProjectManagerBoardResult {
  return {
    projectId: "project-1",
    sprints: [
      { id: "s14", name: "Sprint 14", state: "active", createdAtEpochMs: NOW, jira: null },
      { id: "s15", name: "Sprint 15", state: "planned", createdAtEpochMs: NOW, jira: null },
      { id: "s13", name: "Sprint 13", state: "closed", createdAtEpochMs: NOW, jira: null },
    ],
    sprintSync: null,
    tracking: [
      { taskId: "task-1", sprintId: "s14", developer: "Ada", blockers: null, note: null, updatedAtEpochMs: NOW },
      { taskId: "task-2", sprintId: "s15", developer: "Linus", blockers: null, note: null, updatedAtEpochMs: NOW },
    ],
    facts: [facts()],
    tickets: [],
    proposals: [],
    probes: [],
    risks: [],
    stages: [{ taskId: "task-1", stage: "deployed", environment: "Staging", sinceEpochMs: NOW }],
    environments: [],
    checks: [],
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
    saveTicket: vi.fn(async () => ({ taskId: "task-1", version: 1, board: board() })),
    loadTicketVersions: vi.fn(async () => ({ taskId: "task-1", versions: [] })),
    restoreTicket: vi.fn(async () => ({ taskId: "task-1", version: 1, board: board() })),
    requestCheck: vi.fn(async () => ({ status: "started" as const, sessionId: "check-1", taskIds: ["task-1"] })),
    createProbe: async () => board(),
    approveProbe: async () => board(),
    deleteProbe: async () => board(),
    refreshFacts: async () => board(),
    setEnvironment: async () => board(),
    setEnvironments: async () => board(),
    acceptProposal: vi.fn(async () => ({ taskId: "task-1", version: 2, board: board() })),
    dismissProposal: async () => board(),
    openTaskSources: vi.fn(),
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

  it("places a Task on its delivery stages from the daemon's stage", () => {
    const deployed = { taskId: "task-1", stage: "deployed" as const, environment: "uat", sinceEpochMs: NOW };
    const environments = [{ name: "dev", production: false }, { name: "uat", production: false }, { name: "live", production: true }];
    expect(projectManagerStageTrack(deployed, environments).map((step) => [step.title, step.state])).toEqual([
      ["To do", "passed"],
      ["In progress", "passed"],
      ["In review", "passed"],
      ["Merged", "passed"],
      ["On dev", "passed"],
      ["On uat", "current"],
      ["Live on live", "ahead"],
      ["Done", "ahead"],
    ]);
    // Without a list, one deploy step names the environment it reached.
    const track = projectManagerStageTrack({ ...deployed, environment: "Staging" }, []);
    expect(track.find((step) => step.state === "current")).toMatchObject({ title: "Deployed", detail: "Staging" });
    expect(projectManagerStageTrack({ ...deployed, stage: "done" }, []).every((step) => step.state === "passed")).toBe(true);
    expect(projectManagerStageTrack(undefined, [])[0]!.state).toBe("current");
    expect(stageLabel({ ...deployed, stage: "live", environment: "prod" })).toBe("Live · prod");
    expect(stageLabel({ ...deployed, stage: "inReview", environment: null })).toBe("In review");
  });

  it("reads Jira keys, filters Tasks, and finds the check that covers a Task", () => {
    expect(jiraIssueKey("https://example.atlassian.net/browse/PAY-42")).toBe("PAY-42");
    expect(jiraIssueKey("https://example.com/not-an-issue")).toBeNull();
    const tasks = [task(), task({ id: "task-2", title: "Old", status: "closed", jira_url: null, rank: 2 })];
    expect(visibleProjectManagerTasks(tasks, "pay-4", false).map((item) => item.id)).toEqual(["task-1"]);
    expect(visibleProjectManagerTasks(tasks, "", true).map((item) => item.id)).toEqual(["task-1", "task-2"]);
    const checked = board({ checks: [{ sessionId: "check-1", taskIds: ["task-1", "task-2"] }] });
    expect(projectManagerTaskCheck("task-2", checked)?.sessionId).toBe("check-1");
    expect(projectManagerTaskCheck("task-3", checked)).toBeUndefined();
    expect(projectManagerTaskCheck("task-1", null)).toBeUndefined();
  });

  it("splits a check's notes into Observed, Inferred, and Unknown", () => {
    expect(projectManagerFindingsSections("Intro line\n## Observed\n- PR #9 merged\n\n## Inferred\n* On staging\n## Unknown\n- Production")).toEqual([
      { title: "Notes", tone: "other", lines: ["Intro line"] },
      { title: "Observed", tone: "observed", lines: ["PR #9 merged"] },
      { title: "Inferred", tone: "inferred", lines: ["On staging"] },
      { title: "Unknown", tone: "unknown", lines: ["Production"] },
    ]);
  });

  it("allowlists the Project Manager Task commands", () => {
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerCheckRequest).toBe("termloop:project-manager-check-request");
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerFactsRefresh).toBe("termloop:project-manager-facts-refresh");
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerEnvironmentSet).toBe("termloop:project-manager-environment-set");
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerProposalAccept).toBe("termloop:project-manager-proposal-accept");
    expect(PROFILED_DESKTOP_OPERATIONS.projectManagerProposalDismiss).toBe("termloop:project-manager-proposal-dismiss");
    expect(Object.keys(PROFILED_DESKTOP_OPERATIONS)).not.toContain("taskInvestigationRequest");
  });
});

type StageProps = Parameters<typeof ProjectManagerStage>[0];

function stageProps(overrides: Partial<StageProps> = {}): StageProps {
  return {
    task: task(),
    tasks: [task()],
    board: board(),
    disabled: false,
    actions: actions(),
    setTracking: vi.fn(async () => undefined),
    saveTicket: vi.fn(async () => undefined),
    restoreTicket: vi.fn(async () => undefined),
    setEnvironment: vi.fn(async () => undefined),
    setEnvironments: vi.fn(async () => undefined),
    acceptProposal: vi.fn(async () => undefined),
    dismissProposal: vi.fn(async () => undefined),
    requestCheck: vi.fn(async () => undefined),
    openCheck: vi.fn(),
    probes: { create: vi.fn(async () => undefined), approve: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) },
    selectTask: vi.fn(),
    addTask: vi.fn(),
    ...overrides,
  };
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Project Manager workspace", () => {
  it("groups Tasks by local sprint with their facts and running checks", async () => {
    const select = vi.fn();
    const moveTask = vi.fn(async () => undefined);
    const updateSprint = vi.fn(async () => undefined);
    const checkSprint = vi.fn(async () => undefined);
    const refreshFacts = vi.fn(async () => undefined);
    const addTask = vi.fn();
    const openCheck = vi.fn();
    await act(async () => root.render(<ProjectManagerTaskList
      tasks={[task(), task({ id: "task-2", title: "Planned work", jira_url: null, worktree: null, rank: 2 }), task({ id: "task-3", title: "Loose idea", jira_url: null, worktree: null, rank: 3 })]}
      board={board({ checks: [{ sessionId: "check-1", taskIds: ["task-1"] }] })}
      selectedTaskId="task-1"
      disabled={false}
      select={select}
      selectOverview={vi.fn()}
      openCheck={openCheck}
      terminalSessionId={undefined}
      openTaskSources={vi.fn()}
      actions={{ addTask, createSprint: vi.fn(async () => undefined), updateSprint, deleteSprint: vi.fn(async () => undefined), moveTask, refreshFacts, checkSprint }}
    />));
    const sections = [...host.querySelectorAll(".pm-sprint")];
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Sprint 14", "Sprint 15", "Backlog", "Sprint 13"]);
    const activeRow = sections[0]!.querySelector(".pm-task-rows button")!;
    expect(activeRow.querySelector(".pm-task-key")?.textContent).toBe("PAY-42");
    expect(activeRow.querySelector(".pm-task-agent")?.textContent).toBe("Ada · In Review");
    const checkButton = sections[0]!.querySelector<HTMLButtonElement>(".pm-task-agent-open")!;
    expect(checkButton.textContent).toBe("Checking");
    await act(async () => checkButton.click());
    expect(openCheck).toHaveBeenCalledWith("task-1", "check-1");
    expect(activeRow.querySelector(".pm-task-step")?.textContent).toBe("Deployed · Staging");
    const plannedRow = sections[1]!.querySelector(".pm-task-rows button")!;
    expect(plannedRow.querySelector(".pm-task-agent")?.textContent).toBe("Linus");
    expect(sections[1]!.querySelector(".pm-task-agent-open")).toBeNull();
    expect(sections[2]!.textContent).toContain("Loose idea");
    // Closed sprints start collapsed.
    expect(sections[3]!.querySelector(".pm-task-rows")).toBeNull();
    // Only one sprint can be active, so a planned one cannot start yet.
    expect(button("Start")!.disabled).toBe(true);
    await act(async () => button("Check")!.click());
    expect(checkSprint).toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Read Jira and pull requests now"]')!.click());
    expect(refreshFacts).toHaveBeenCalled();
    await act(async () => button("Complete")!.click());
    expect(updateSprint).toHaveBeenCalledWith(expect.objectContaining({ id: "s14" }), "closed");
    await act(async () => (plannedRow as HTMLButtonElement).click());
    expect(select).toHaveBeenCalledWith("task-2");
    await act(async () => button("Task")!.click());
    expect(addTask).toHaveBeenCalledWith("s14");
  });

  it("follows Jira's sprints without local sprint editing", async () => {
    const jira = (sprintId: number) => ({ sprintId, boardId: 7, startEpochMs: null, endEpochMs: null });
    const synced = board({
      sprints: [
        { id: "s14", name: "PAY Sprint 14", state: "active", createdAtEpochMs: NOW, jira: jira(14) },
        { id: "s15", name: "PAY Sprint 15", state: "planned", createdAtEpochMs: NOW, jira: jira(15) },
        { id: "local", name: "Old local", state: "planned", createdAtEpochMs: NOW, jira: null },
      ],
      sprintSync: { sourceName: "Pay Jira", boardIds: [7], syncedAtEpochMs: NOW, failureReason: null, failedAtEpochMs: null },
    });
    await act(async () => root.render(<ProjectManagerTaskList
      tasks={[task(), task({ id: "task-2", title: "Local work", jira_url: null, rank: 2 })]}
      board={synced}
      selectedTaskId={undefined}
      disabled={false}
      select={vi.fn()}
      selectOverview={vi.fn()}
      openCheck={vi.fn()}
      terminalSessionId={undefined}
      openTaskSources={vi.fn()}
      actions={{ addTask: vi.fn(), createSprint: vi.fn(async () => undefined), updateSprint: vi.fn(async () => undefined), deleteSprint: vi.fn(async () => undefined), moveTask: vi.fn(async () => undefined), refreshFacts: vi.fn(async () => undefined), checkSprint: vi.fn(async () => undefined) }}
    />));
    expect(host.querySelector(".pm-sprint-sync")?.textContent).toContain("Sprints follow Pay Jira");
    expect(button("New sprint")).toBeUndefined();
    expect(button("Complete")).toBeUndefined();
    expect([...host.querySelectorAll(".pm-sprint-badge.jira")]).toHaveLength(2);
    // A local planned sprint cannot start beside Jira's active one.
    expect(button("Start")!.disabled).toBe(true);
    const rows = [...host.querySelectorAll<HTMLButtonElement>(".pm-task-rows button[draggable]")];
    expect(rows.map((row) => row.getAttribute("draggable"))).toEqual(["false", "true"]);

    const props = stageProps({ board: synced });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    const sprintSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Sprint"]')!;
    expect(sprintSelect.disabled).toBe(true);
    expect(sprintSelect.title).toBe("Jira decides this Task's sprint");
  });

  it("says when Jira sprints could not be read", async () => {
    await act(async () => root.render(<ProjectManagerTaskList
      tasks={[]}
      board={board({ sprintSync: { sourceName: "Pay Jira", boardIds: [7], syncedAtEpochMs: null, failureReason: "credentialsInvalid", failedAtEpochMs: NOW } })}
      selectedTaskId={undefined}
      disabled={false}
      select={vi.fn()}
      selectOverview={vi.fn()}
      openCheck={vi.fn()}
      terminalSessionId={undefined}
      openTaskSources={vi.fn()}
      actions={{ addTask: vi.fn(), createSprint: vi.fn(async () => undefined), updateSprint: vi.fn(async () => undefined), deleteSprint: vi.fn(async () => undefined), moveTask: vi.fn(async () => undefined), refreshFacts: vi.fn(async () => undefined), checkSprint: vi.fn(async () => undefined) }}
    />));
    expect(host.querySelector(".pm-sprint-sync.failed")?.textContent).toContain("Jira sprints could not be read (credentialsInvalid)");
  });

  it("names the next sprint and groups unknown sprints into the backlog", () => {
    expect(nextSprintName([])).toBe("Sprint 1");
    expect(nextSprintName(board().sprints)).toBe("Sprint 16");
    const groups = projectManagerSprintGroups([task({ id: "orphan" })], board({ tracking: [{ ...board().tracking[0]!, taskId: "orphan", sprintId: "gone" }] }));
    expect(groups.backlog.tasks.map((item) => item.id)).toEqual(["orphan"]);
  });

  it("turns the ticket into one versioned save and shows Jira wiki as Markdown", () => {
    const draft = ticketDraft(task({ brief: "h2. Goal\n* Fix *checkout* in {{api}}" }), false);
    expect(draft.brief).toBe("## Goal\n\n- Fix **checkout** in `api`");
    expect(ticketDraft(task({ brief: "h2. Goal" }), true).brief).toBe("h2. Goal");
    expect(jiraWikiToMarkdown("{code}\nnpm test\n{code}")).toBe("```\nnpm test\n```");
    expect(ticketSaveParams("task-1", { ...draft, title: " Checkout times out " }, " Staging done ", 3)).toEqual({
      taskId: "task-1", title: "Checkout times out", brief: "## Goal\n\n- Fix **checkout** in `api`", summary: "Staging done", expectedVersion: 3,
    });
    expect(ticketSaveParams("task-1", { title: "A", brief: "  " }, "", null).brief).toBeNull();
    expect(sameTicket(draft, { ...draft, brief: `${draft.brief}  ` })).toBe(true);
    expect(sameTicket(draft, { ...draft, title: "Other" })).toBe(false);
    expect(ticketFieldChanges({ title: "A", brief: "x" }, { title: "B", brief: "y" })).toEqual([{ field: "Title", before: "A", after: "B" }]);
    expect(ticketFieldChanges({ title: "A", brief: "x" }, { title: "A", brief: "y" })).toEqual([]);
  });

  it("lists ticket versions, shows what one changed, and restores it", async () => {
    const restore = vi.fn(async () => undefined);
    const content = { title: "Checkout times out", brief: "Users wait." };
    await act(async () => root.render(<ProjectManagerTicketHistory
      taskId="task-1"
      headVersion={2}
      disabled={false}
      load={async () => ({ taskId: "task-1", versions: [
        { number: 2, author: "agent", summary: "PR #9 merged", createdAtEpochMs: NOW, content: { title: "Checkout times out on mobile", brief: "Users wait at checkout." } },
        { number: 1, author: "projectManager", summary: "Created", createdAtEpochMs: NOW, content },
      ] })}
      restore={restore}
      close={vi.fn()}
    />));
    const versions = [...host.querySelectorAll<HTMLButtonElement>(".pm-version")];
    expect(versions.map((version) => version.textContent)).toEqual([expect.stringContaining("v2Current"), expect.stringContaining("v1")]);
    expect(versions[0]!.textContent).toContain("PR #9 merged");
    expect(host.querySelector(".pm-field-changes")?.textContent).toContain("Checkout times outCheckout times out on mobile");
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
    await act(async () => type(search, "checkout"));
    await act(async () => button("Search")!.click());
    const results = [...host.querySelectorAll<HTMLButtonElement>(".pm-jira-results button")];
    expect(results[1]!.disabled).toBe(true);
    expect(results[1]!.textContent).toContain("Already a Task");
    await act(async () => results[0]!.click());
    expect(host.querySelector<HTMLInputElement>("#pm-add-title")!.value).toBe("Checkout times out");
    await act(async () => button("Add Task")!.click());
    expect(create).toHaveBeenCalledWith({
      title: "Checkout times out", brief: "Users wait.", sprintId: "s14",
      jiraUrl: "https://example.atlassian.net/browse/PAY-42", developer: "Ada",
    });
    expect(close).toHaveBeenCalled();
  });

  it("shows the ticket with its delivery facts and starts a delivery check", async () => {
    const props = stageProps();
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')?.value).toBe("Checkout times out");
    expect(host.querySelector(".pm-md")?.textContent).toContain("Users see a timeout at checkout.");
    expect(host.querySelector(".pm-meta-step")?.textContent).toBe("Deployed · Staging");
    expect(host.querySelector(".pm-delivery")?.textContent).toContain("DeployedStagingNext: Live");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Sprint"]')?.value).toBe("s14");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Developer"]')?.value).toBe("Ada");
    const facts = host.querySelector('[aria-label="Delivery facts"]')!;
    expect(facts.textContent).toContain("In Review");
    expect(facts.textContent).toContain("Ada Lovelace");
    expect(facts.querySelector(".pm-pr-fact")?.textContent).toContain("PAY-42 retry checkout");
    expect(facts.querySelector(".pm-pr-fact")?.textContent).toContain("Merged");
    expect(facts.querySelector(".pm-env-row")?.textContent).toContain("Delivery check");
    expect(host.querySelector(".pm-finding.observed li")?.textContent).toBe("deploy-staging run 812 shipped v1.4");
    expect(host.querySelector(".pm-fact-blockers")?.textContent).toBe("Waiting for QA");
    expect([...host.querySelectorAll(".pm-step")].map((step) => step.getAttribute("data-step-state"))).toEqual(["passed", "passed", "passed", "passed", "current", "ahead", "ahead"]);
    await act(async () => facts.querySelector<HTMLButtonElement>(".pm-pr-link")!.click());
    expect(props.actions.openExternal).toHaveBeenCalledWith("https://github.com/acme/pay/pull/9");
    await act(async () => button("Check now")!.click());
    expect(props.requestCheck).toHaveBeenCalledWith(["task-1"]);
  });

  it("shows a running check instead of starting another, and says when a read failed", async () => {
    const props = stageProps({
      board: board({
        checks: [{ sessionId: "check-1", taskIds: ["task-1"] }],
        facts: [facts({ readFailures: [{ source: "jira", reason: "credentialsInvalid", atEpochMs: NOW }] })],
      }),
    });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    expect(button("Check now")).toBeUndefined();
    await act(async () => host.querySelector<HTMLButtonElement>(".pm-meta-check")!.click());
    expect(props.openCheck).toHaveBeenCalledWith("check-1");
    expect(host.querySelector(".pm-fact-failures")?.textContent).toContain("Jira could not be read: the credentials were rejected");
  });

  it("lets the Project Manager state, correct, and remove an environment", async () => {
    const props = stageProps();
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    const state = host.querySelector<HTMLSelectElement>('select[aria-label="Staging state"]')!;
    await act(async () => {
      state.value = "notDeployed";
      state.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(props.setEnvironment).toHaveBeenCalledWith({ taskId: "task-1", name: "Staging", state: "notDeployed", detail: "v1.4" });
    await act(async () => button("Production")!.click());
    expect(props.setEnvironment).toHaveBeenCalledWith({ taskId: "task-1", name: "Production", state: "unknown" });
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove Staging"]')!.click());
    expect(props.setEnvironment).toHaveBeenCalledWith({ taskId: "task-1", name: "Staging", remove: true });
  });

  it("saves the Project Manager's own fields when they lose focus", async () => {
    const props = stageProps();
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    const note = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!;
    await act(async () => type(note, "Ask QA"));
    expect(host.querySelector(".pm-save-bar")).toBeNull();
    await act(async () => note.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(props.setTracking).toHaveBeenCalledWith({ taskId: "task-1", sprintId: "s14", developer: "Ada", blockers: null, note: "Ask QA" });
  });

  it("reviews, accepts, and dismisses a check's proposed ticket update", async () => {
    const proposal = { taskId: "task-1", title: null, brief: "## Status\n- On staging", summary: "Staging runs v1.4", baseVersion: 1, proposedAtEpochMs: NOW };
    const props = stageProps({
      board: board({
        proposals: [proposal],
        tickets: [{ taskId: "task-1", number: 1, author: "projectManager", summary: null, createdAtEpochMs: NOW }],
      }),
    });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    const banner = host.querySelector('[aria-label="Proposed ticket update"]')!;
    expect(banner.textContent).toContain("Staging runs v1.4");
    await act(async () => button("Review")!.click());
    expect(banner.querySelector(".pm-proposal-brief")?.textContent).toBe("## Status\n- On staging");
    await act(async () => button("Accept")!.click());
    expect(props.acceptProposal).toHaveBeenCalledWith("task-1", 1);
    await act(async () => button("Dismiss")!.click());
    expect(props.dismissProposal).toHaveBeenCalledWith("task-1");
  });

  it("offers to move a Task outside the active sprint into it", async () => {
    const props = stageProps({ task: task({ id: "task-2", title: "Planned work" }) });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    expect(host.textContent).toContain("TermLoop reads Jira and pull requests only for Tasks in the active sprint (Sprint 14)");
    await act(async () => button("Move to Sprint 14")!.click());
    expect(props.setTracking).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-2", sprintId: "s14", developer: "Linus" }));
  });

  it("edits the ticket in TermLoop", async () => {
    const props = stageProps({ board: board({ facts: [] }) });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    expect(host.textContent).toContain("An environment whose name contains “prod” counts as production.");
    expect(host.textContent).toContain("Jira is not changed");
    expect(host.querySelector('[aria-label="Delivery facts"]')?.textContent).toContain("Not read yet");
    expect(host.querySelector(".pm-save-bar")).toBeNull();
    const title = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')!;
    await act(async () => type(title, "Checkout times out on mobile"));
    expect(host.querySelector(".pm-save-bar")?.textContent).toContain("Unsaved changes");
    await act(async () => button("Save version")!.click());
    expect(props.saveTicket).toHaveBeenCalledWith({
      taskId: "task-1", title: "Checkout times out on mobile", brief: "Users see a timeout at checkout.", summary: null, expectedVersion: null,
    });
  });

  it("keeps the Project Manager's draft when a newer version is saved", async () => {
    const saveTicket = vi.fn(async () => "state revision changed");
    const stage = (version: number, brief: string) => <ProjectManagerStage {...stageProps({
      task: task({ brief }),
      board: board({ tickets: [{ taskId: "task-1", number: version, author: version > 1 ? "agent" : "projectManager", summary: null, createdAtEpochMs: NOW }] }),
      saveTicket,
    })} />;
    await act(async () => root.render(stage(1, "Users wait.")));
    expect(host.querySelector(".pm-version-badge")?.textContent).toContain("v1");
    const title = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')!;
    await act(async () => type(title, "Checkout is slow"));
    await act(async () => root.render(stage(2, "Users wait at checkout.")));
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')!.value).toBe("Checkout is slow");
    expect(host.querySelector(".pm-banner.warning")?.textContent).toContain("v2 was saved while you were editing.");
    await act(async () => button("Save version")!.click());
    expect(saveTicket).toHaveBeenCalledWith(expect.objectContaining({ title: "Checkout is slow", expectedVersion: 1 }));
    expect(host.querySelector(".pm-banner.warning")?.textContent).toContain("Saving yours would replace it.");
    await act(async () => button("Load v2")!.click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Task title"]')!.value).toBe("Checkout times out");
    expect(host.querySelector(".pm-md")?.textContent).toContain("Users wait at checkout.");
    expect(host.querySelector(".pm-save-bar")).toBeNull();
  });

  it("counts the active sprint and lists the Tasks that need attention", async () => {
    const tasks = [task(), task({ id: "task-2", title: "Planned work", rank: 2 }), task({ id: "task-4", title: "Stuck", jira_url: null, rank: 4 })];
    const risky = board({
      tracking: [
        ...board().tracking,
        { taskId: "task-4", sprintId: "s14", developer: null, blockers: "Vendor", note: null, updatedAtEpochMs: NOW },
      ],
      risks: [
        { taskId: "task-4", kind: "blocked", detail: "Vendor", sinceEpochMs: null },
        { taskId: "task-2", kind: "reviewStalled", detail: "#3 has not moved for 4 days", sinceEpochMs: NOW },
      ],
    });
    const digest = projectManagerDigest(tasks, risky);
    expect(digest).toMatchObject({ sprintName: "Sprint 14", tasks: 2, inReview: 0, merged: 1, inProduction: 0 });
    // task-2 is outside the active sprint, so only task-4 needs attention here.
    expect(digest.atRisk.map((entry) => entry.task.id)).toEqual(["task-4"]);

    const props = stageProps({ task: undefined, tasks, board: risky });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    const overview = host.querySelector('[aria-label="Sprint overview"]')!;
    expect(overview.querySelector("h2")?.textContent).toBe("Sprint 14");
    expect([...overview.querySelectorAll(".pm-overview-stat")].map((stat) => stat.textContent)).toEqual([
      "Tasks2", "In review0", "Merged1", "In production0", "Need attention1",
    ]);
    expect(overview.querySelector(".pm-risk")?.textContent).toBe("Blocked Vendor");
    await act(async () => overview.querySelector<HTMLButtonElement>(".pm-overview-risks button")!.click());
    expect(props.selectTask).toHaveBeenCalledWith("task-4");
    await act(async () => button("Check sprint")!.click());
    expect(props.requestCheck).toHaveBeenCalledWith(null);
  });

  it("shows a Task's risks on its ticket and in the sidebar", async () => {
    const risky = board({ risks: [{ taskId: "task-1", kind: "notInProduction", detail: "On Staging for 4 days but not on Production", sinceEpochMs: NOW }] });
    await act(async () => root.render(<ProjectManagerStage {...stageProps({ board: risky })} />));
    expect(host.querySelector('[aria-label="Risks"]')?.textContent).toBe("Not in productionOn Staging for 4 days but not on Production");
    const selectOverview = vi.fn();
    await act(async () => root.render(<ProjectManagerTaskList
      tasks={[task()]}
      board={risky}
      selectedTaskId="task-1"
      disabled={false}
      select={vi.fn()}
      selectOverview={selectOverview}
      openCheck={vi.fn()}
      terminalSessionId={undefined}
      openTaskSources={vi.fn()}
      actions={{ addTask: vi.fn(), createSprint: vi.fn(async () => undefined), updateSprint: vi.fn(async () => undefined), deleteSprint: vi.fn(async () => undefined), moveTask: vi.fn(async () => undefined), refreshFacts: vi.fn(async () => undefined), checkSprint: vi.fn(async () => undefined) }}
    />));
    expect(host.querySelector('.pm-task-failing')?.getAttribute("aria-label")).toBe("1 risk");
    expect(host.querySelector(".pm-overview-count")?.textContent).toBe("1 need attention");
    await act(async () => host.querySelector<HTMLButtonElement>(".pm-overview-link")!.click());
    expect(selectOverview).toHaveBeenCalled();
  });

  it("splits a probe command without a shell and shows it back", () => {
    expect(commandArgv(`curl -s "https://staging.example.com/version" -H 'Accept: text/plain'`)).toEqual([
      "curl", "-s", "https://staging.example.com/version", "-H", "Accept: text/plain",
    ]);
    expect(commandArgv(`kubectl get deploy pay -o jsonpath='{.spec.template.spec.containers[0].image}'`).at(-1)).toBe("jsonpath={.spec.template.spec.containers[0].image}");
    expect(commandArgv("echo ''")).toEqual(["echo", ""]);
    expect(commandArgv("  ")).toEqual([]);
    expect(argvText(["curl", "-H", "Accept: text/plain"])).toBe("curl -H 'Accept: text/plain'");
  });

  it("approves or rejects a proposed probe and adds the Project Manager's own", async () => {
    const props = stageProps({
      task: undefined,
      board: board({
        probes: [
          { id: "p1", environment: "Production", argv: ["gh", "run", "list", "-w", "deploy-prod"], matcher: "agent", status: "proposed", author: "agent", reason: "The deploy workflow shows production", createdAtEpochMs: NOW, lastRun: null },
          { id: "p2", environment: "Staging", argv: ["curl", "-s", "https://staging.example.com/version"], matcher: "commitAncestry", status: "approved", author: "projectManager", reason: null, createdAtEpochMs: NOW, lastRun: { atEpochMs: NOW, changedAtEpochMs: NOW, deployedCommit: "abc1234def5678", failure: null } },
        ],
      }),
    });
    await act(async () => root.render(<ProjectManagerStage {...props} />));
    const rows = [...host.querySelectorAll(".pm-probe")];
    expect(rows[0]!.textContent).toContain("Proposed by a delivery check: The deploy workflow shows production");
    expect(rows[1]!.textContent).toContain("Runs abc1234def56");
    await act(async () => button("Approve")!.click());
    expect(props.probes.approve).toHaveBeenCalledWith("p1");
    await act(async () => button("Reject")!.click());
    expect(props.probes.remove).toHaveBeenCalledWith("p1");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Probes"] .pm-chip')!.click());
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Probe environment"]')!, "Dev"));
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Probe command"]')!, "curl -s https://dev.example.com/version"));
    await act(async () => host.querySelector<HTMLButtonElement>('.pm-probe-form button[type="submit"]')!.click());
    expect(props.probes.create).toHaveBeenCalledWith({
      environment: "Dev", argv: ["curl", "-s", "https://dev.example.com/version"], matcher: "commitAncestry",
    });
  });

  it("orders the Project's environments and marks production", async () => {
    const save = vi.fn(async () => undefined);
    await act(async () => root.render(<ProjectManagerEnvironments environments={[{ name: "prod", production: true }]} disabled={false} save={save} />));
    expect(host.querySelector(".pm-environment-list")?.textContent).toBe("prodProduction");
    await act(async () => button("Edit")!.click());
    await act(async () => button("Environment")!.click());
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Environment 2"]')!, " staging "));
    await act(async () => host.querySelectorAll<HTMLButtonElement>('button[aria-label="Move up"]')[1]!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('.pm-environment-form button[type="submit"]')!.click());
    expect(save).toHaveBeenCalledWith([{ name: "staging", production: false }, { name: "prod", production: true }]);
    // A duplicate name cannot be saved.
    await act(async () => button("Edit")!.click());
    await act(async () => button("Environment")!.click());
    await act(async () => type(host.querySelector<HTMLInputElement>('input[aria-label="Environment 2"]')!, "PROD"));
    expect(host.querySelector<HTMLButtonElement>('.pm-environment-form button[type="submit"]')!.disabled).toBe(true);
  });
});
