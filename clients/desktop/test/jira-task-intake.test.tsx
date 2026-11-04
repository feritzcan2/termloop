// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JiraTaskProposalDto } from "@termloop/contract/current";
import type { Session } from "../src/renderer/model.js";
import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import { JiraTaskProposalCards, jiraTaskWorktreeParams, type JiraTaskProposalActions } from "../src/renderer/ui/JiraTaskProposalCards.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

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

const project = { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" };

async function renderComposer(available: boolean) {
  const preview = vi.fn(async () => ({ ok: false as const, message: "not inspected" }));
  await act(async () => root.render(<QuickActionComposer
    projects={[project]}
    selectedProject={project}
    capabilities={[fullAgentCapability("claude")]}
    profiles={[]}
    jiraTaskSourceAvailable={async () => available}
    pasteImage={vi.fn()} restoreImage={vi.fn()} discardImage={vi.fn()} preview={preview as never} launch={vi.fn()} close={vi.fn()}
  />));
  await act(async () => {});
  return preview;
}

describe("Jira task intake option", () => {
  it("is hidden without an enabled Jira Task Source", async () => {
    await renderComposer(false);
    expect(host.textContent).not.toContain("Create Jira issue and task");
  });

  it("is offered with an explanatory tooltip when a Jira Task Source is enabled", async () => {
    await renderComposer(true);
    const checkbox = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.parentElement?.textContent?.includes("Create Jira issue and task"));
    expect(checkbox).toBeDefined();
    expect(checkbox!.checked).toBe(false);
    const help = host.querySelector('[aria-label="What Create Jira issue and task does"]');
    expect(help?.getAttribute("aria-describedby")).toBe("quick-action-jira-task-help");
    expect(host.querySelector("#quick-action-jira-task-help")?.textContent).toContain("Task worktree");
  });
});

const proposal: JiraTaskProposalDto = {
  proposal_id: "00000000-0000-4000-8000-000000000001",
  project_key: "PAY",
  issue_type: "Task",
  epic_key: "PAY-9",
  summary: "Add refund export",
  description: "Export refunds as CSV.",
  rationale: "PAY-9 tracks reporting work.",
  state: "awaitingUser",
  failure: null,
  proposed_at_epoch_ms: 1,
};

function session(jira: JiraTaskProposalDto | null): Session {
  return { id: "session-1", project_id: "project-1", name: "Refunds", kind: "Agent", jira_task_proposal: jira } as unknown as Session;
}

describe("Jira task proposal card", () => {
  it("renders nothing without a pending proposal", async () => {
    const actions: JiraTaskProposalActions = { loadSources: vi.fn(async () => []), approve: vi.fn(), respond: vi.fn(), forkIntoTask: vi.fn() };
    await act(async () => root.render(<JiraTaskProposalCards reportOverlay={vi.fn()} sessions={[session(null)]} actions={actions} selectSession={vi.fn()} started={vi.fn()} />));
    expect(host.querySelector(".jira-proposal-card")).toBeNull();
  });

  it("approves the edited proposal and reports the created Task", async () => {
    const approve = vi.fn<JiraTaskProposalActions["approve"]>(async () => ({ outcome: "created", taskId: "task-1", issueKey: "PAY-42", issueUrl: "https://jira.example/browse/PAY-42", startWith: "relocate" }));
    const started = vi.fn();
    const actions: JiraTaskProposalActions = { loadSources: async () => [{ id: "source-1", name: "Jira" }], approve, respond: vi.fn(), forkIntoTask: vi.fn() };
    await act(async () => root.render(<JiraTaskProposalCards reportOverlay={vi.fn()} sessions={[session(proposal)]} actions={actions} selectSession={vi.fn()} started={started} />));
    await act(async () => {});
    const create = [...host.querySelectorAll("button")].find((button) => button.textContent === "Create issue and start")!;
    expect(create.disabled).toBe(false);
    await act(async () => create.click());
    expect(approve).toHaveBeenCalledWith("session-1", proposal.proposal_id, {
      sourceId: "source-1", projectKey: "PAY", issueType: "Task", epicKey: "PAY-9", summary: "Add refund export", description: "Export refunds as CSV.", start: "proposingAgent",
    });
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }), {
      approval: expect.objectContaining({ taskId: "task-1", issueKey: "PAY-42" }),
      summary: "Add refund export",
      kickoffMessage: "Start working on this Jira issue.",
    });
  });

  it("offers creating only the issue, or a Task started by a fresh agent with an edited first message", async () => {
    const approve = vi.fn<JiraTaskProposalActions["approve"]>(async () => ({ outcome: "created", taskId: null, issueKey: "PAY-43", issueUrl: "https://jira.example/browse/PAY-43", startWith: "none" }));
    const started = vi.fn();
    const actions: JiraTaskProposalActions = { loadSources: async () => [{ id: "source-1", name: "Jira" }], approve, respond: vi.fn(), forkIntoTask: vi.fn() };
    await act(async () => root.render(<JiraTaskProposalCards reportOverlay={vi.fn()} sessions={[session(proposal)]} actions={actions} selectSession={vi.fn()} started={started} />));
    await act(async () => {});
    const radio = (text: string) => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.parentElement?.textContent?.startsWith(text))!;
    await act(async () => radio("With a fresh agent").click());
    const kickoff = host.querySelector<HTMLTextAreaElement>(".jira-proposal-kickoff textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(kickoff, "Write the CSV exporter first.");
      kickoff.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Create issue and start")!.click());
    expect(approve).toHaveBeenLastCalledWith("session-1", proposal.proposal_id, expect.objectContaining({ start: "freshAgent" }));
    expect(started).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kickoffMessage: "Write the CSV exporter first." }));

    await act(async () => radio("Only create the Jira issue").click());
    expect(host.querySelector(".jira-proposal-kickoff")).toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Create issue")!.click());
    expect(approve).toHaveBeenLastCalledWith("session-1", proposal.proposal_id, expect.objectContaining({ start: "issueOnly" }));
  });

  it("shows a failed creation and keeps the card", async () => {
    const actions: JiraTaskProposalActions = {
      loadSources: async () => [{ id: "source-1", name: "Jira" }],
      approve: async () => ({ outcome: "failed", failure: "Jira rejected the issue: Epic does not exist." }),
      respond: vi.fn(),
      forkIntoTask: vi.fn(),
    };
    await act(async () => root.render(<JiraTaskProposalCards reportOverlay={vi.fn()} sessions={[session(proposal)]} actions={actions} selectSession={vi.fn()} started={vi.fn()} />));
    await act(async () => {});
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Create issue and start")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Epic does not exist");
  });

  it("opens as a modal native overlay and hides until its Agent is selected again", async () => {
    const reportOverlay = vi.fn();
    const actions: JiraTaskProposalActions = { loadSources: async () => [{ id: "source-1", name: "Jira" }], approve: vi.fn(), respond: vi.fn(), forkIntoTask: vi.fn() };
    const render = (selectedSessionId?: string) => root.render(<JiraTaskProposalCards sessions={[session(proposal)]} selectedSessionId={selectedSessionId} actions={actions} selectSession={vi.fn()} started={vi.fn()} reportOverlay={reportOverlay} />);
    await act(async () => render("other"));
    expect(host.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
    expect(reportOverlay).toHaveBeenLastCalledWith(true);
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Later")!.click());
    expect(host.querySelector(".jira-proposal-card")).toBeNull();
    expect(reportOverlay).toHaveBeenLastCalledWith(false);
    await act(async () => render("session-1"));
    expect(host.querySelector(".jira-proposal-card")).not.toBeNull();
  });

  it("dismisses without feedback", async () => {
    const respond = vi.fn<JiraTaskProposalActions["respond"]>(async () => undefined);
    const actions: JiraTaskProposalActions = { loadSources: async () => [{ id: "source-1", name: "Jira" }], approve: vi.fn(), respond, forkIntoTask: vi.fn() };
    await act(async () => root.render(<JiraTaskProposalCards reportOverlay={vi.fn()} sessions={[session(proposal)]} actions={actions} selectSession={vi.fn()} started={vi.fn()} />));
    await act(async () => {});
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")!.click());
    expect(respond).toHaveBeenCalledWith("session-1", proposal.proposal_id, "dismiss", "");
  });

  it("dismisses from the close button instead of deferring", async () => {
    const respond = vi.fn<JiraTaskProposalActions["respond"]>(async () => undefined);
    const actions: JiraTaskProposalActions = { loadSources: async () => [{ id: "source-1", name: "Jira" }], approve: vi.fn(), respond, forkIntoTask: vi.fn() };
    await act(async () => root.render(<JiraTaskProposalCards reportOverlay={vi.fn()} sessions={[session(proposal)]} actions={actions} selectSession={vi.fn()} started={vi.fn()} />));
    await act(async () => {});
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss the Jira issue proposal"]')!.click());
    expect(respond).toHaveBeenCalledWith("session-1", proposal.proposal_id, "dismiss", "");
  });
});

describe("Jira task worktree", () => {
  it("names a new branch after the issue on the preferred remote base", () => {
    const params = jiraTaskWorktreeParams("project-1", "/repo/app", "task-1", "PAY-42", "Add refund export", {
      branches: [], base_branches: [{ name: "origin/main", exact_ref: "refs/remotes/origin/main" }, { name: "origin/develop", exact_ref: "refs/remotes/origin/develop" }],
    } as never);
    expect(params).toMatchObject({ taskId: "task-1", branchMode: "create", baseRef: "refs/remotes/origin/develop", branchName: "task/pay-42-add-refund-export", repositoryPath: "/repo/app" });
    expect(typeof params === "string" ? "" : params.destinationPath).toBe("/repo/task-pay-42-add-refund-export_worktree");
  });

  it("refuses a repository without a remote base", () => {
    expect(jiraTaskWorktreeParams("project-1", "/repo/app", "task-1", "PAY-42", "x", { branches: [], base_branches: [] } as never)).toContain("remote-tracking branch");
  });
});
