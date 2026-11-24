// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickActionComposer } from "../src/renderer/ui/QuickActionComposer.js";
import type { QuickActionJiraImportActions } from "../src/renderer/ui/QuickActionJiraImport.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const project = { id: "project-1", name: "TermNext", folder_path: "/tmp/termnext" };
const source = {
  id: "source-1", name: "PAY board", enabled: true, generation: 4, scopeKind: "assignedToMe", jql: null,
  boards: [{ id: "310", name: "Flow Board" }],
  statuses: [{ id: "1", name: "To Do" }, { id: "3", name: "In Progress" }],
};
const candidate = (key: string, summary: string, state: string, extra: { statusName?: string; epicKey?: string | null; epicSummary?: string | null; issueTypeName?: string | null; assigneeDisplay?: string | null } = {}) => ({
  externalId: `ext-${key}`, key, summary, state, observationSequence: 7, statusName: "To Do", assigneeDisplay: null,
  issueTypeName: "Story", epicKey: null, epicSummary: null,
  updatedAt: "2026-11-20T10:00:00Z", url: `https://jira.example/browse/${key}`, taskId: null, ...extra,
});

function jiraActions(importCandidate = vi.fn(async () => ({ task: { id: "task-9", title: "Refund export" } }))) {
  return {
    list: vi.fn(async () => ({ sources: [source, { ...source, id: "source-off", enabled: false }], stateRevision: 11 })),
    listCandidates: vi.fn(async () => ({
      candidates: [
        candidate("PAY-1", "Refund export", "new", { epicKey: "PAY-9", epicSummary: "Reporting", assigneeDisplay: "Ada" }),
        candidate("PAY-2", "Already added", "added", { epicKey: "PAY-9" }),
        candidate("PAY-3", "Ledger cleanup", "new", { statusName: "In Progress", issueTypeName: "Bug" }),
      ],
      lastSuccessfulAtEpochMs: 1,
    })),
    importCandidate,
    refresh: vi.fn(async () => ({ candidateCount: 2, truncated: false })),
    listProjectBranches: vi.fn(async () => ({ base_branches: [] })),
    getProjectAutomation: vi.fn(async () => { throw new Error("no defaults"); }),
  } as unknown as QuickActionJiraImportActions & { importCandidate: typeof importCandidate; listCandidates: ReturnType<typeof vi.fn> };
}

async function renderComposer(available: boolean, actions = jiraActions(), extra: { openTask?: (taskId: string) => void; close?: () => void } = {}) {
  await act(async () => root.render(<QuickActionComposer
    projects={[project]}
    selectedProject={project}
    capabilities={[fullAgentCapability("claude")]}
    profiles={[]}
    jiraTaskSourceAvailable={async () => available}
    jiraImport={{ actions, openTask: extra.openTask ?? vi.fn() }}
    pasteImage={vi.fn()} restoreImage={vi.fn()} discardImage={vi.fn()}
    preview={vi.fn(async () => ({ ok: false as const, message: "not inspected" })) as never}
    launch={vi.fn()} close={extra.close ?? vi.fn()}
  />));
  await act(async () => {});
}

const segment = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".quick-action-segmented button")]
  .find((button) => button.textContent === label);
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); });
  await act(async () => {});
};

describe("Quick Action Jira target", () => {
  it("is hidden without an enabled Jira Task Source", async () => {
    await renderComposer(false);
    expect(segment("Run")).toBeDefined();
    expect(segment("Worktree")).toBeDefined();
    expect(segment("Jira")).toBeUndefined();
  });

  it("shows each enabled source's scope as chips and narrows the list by its status chips", async () => {
    const actions = jiraActions();
    await renderComposer(true, actions);
    await click(segment("Jira"));
    expect(host.querySelector("#quick-action-prompt")).toBeNull();
    expect(host.querySelector(".quick-action-jira select")).toBeNull();
    expect(actions.listCandidates).toHaveBeenCalledTimes(1);
    expect(actions.listCandidates).toHaveBeenCalledWith("source-1");
    const chips = [...host.querySelectorAll('[aria-label="PAY board scope"] [role="listitem"]')].map((chip) => chip.textContent);
    expect(chips).toEqual(["Assigned to me", "Flow Board", "To Do", "In Progress"]);
    const keys = () => [...host.querySelectorAll("[data-candidate-key]")].map((row) => row.getAttribute("data-candidate-key"));
    expect(keys()).toEqual(["PAY-1", "PAY-3"]);
    const statusChip = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button.quick-action-jira-chip.status")].find((chip) => chip.textContent === name);
    await click(statusChip("In Progress"));
    expect(statusChip("In Progress")!.getAttribute("aria-pressed")).toBe("true");
    expect(keys()).toEqual(["PAY-3"]);
    await click(statusChip("To Do"));
    expect(keys()).toEqual(["PAY-1", "PAY-3"]);
    await click(statusChip("In Progress"));
    expect(keys()).toEqual(["PAY-1"]);
    await click(statusChip("To Do"));
    expect(keys()).toEqual(["PAY-1", "PAY-3"]);
  });

  it("imports the confirmed issue with its exact proofs, then closes and opens the Task", async () => {
    const actions = jiraActions();
    const openTask = vi.fn();
    const close = vi.fn();
    await renderComposer(true, actions, { openTask, close });
    await click(segment("Jira"));
    const row = host.querySelector('[data-candidate-key="PAY-1"]')!;
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Import as Task"));
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Create Task"));
    expect(actions.importCandidate).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "source-1", externalId: "ext-PAY-1", expectedGeneration: 4, expectedObservationSequence: 7, expectedRevision: 11, worktreeIntent: "none",
    }));
    expect(close).toHaveBeenCalled();
    expect(openTask).toHaveBeenCalledWith("task-9");
  });

  it("keeps the composer open and shows a non-stale import failure", async () => {
    const actions = jiraActions(vi.fn(async () => { throw new Error("Jira is unreachable"); }));
    const close = vi.fn();
    await renderComposer(true, actions, { close });
    await click(segment("Jira"));
    const row = host.querySelector('[data-candidate-key="PAY-1"]')!;
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Import as Task"));
    await click([...row.querySelectorAll("button")].find((button) => button.textContent === "Create Task"));
    expect(actions.importCandidate).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(host.querySelector('.quick-action-jira [role="alert"]')?.textContent).toContain("Jira is unreachable");
  });
});
