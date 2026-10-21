// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PlaybookDeterministicCheckDto,
  PlaybookDto,
  PlaybookGateKind,
  PlaybookMilestoneDto,
  PlaybookUpdateParams,
} from "@termloop/contract/current";

import { PlaybookCheckSelector } from "../src/renderer/ui/PlaybookCheckSelector.js";
import { saveStepCheck } from "../src/renderer/ui/StewardPanel.js";
import type { PlaybookUpdateOutcome } from "../src/renderer/ui/playbook-policy.js";

let host: HTMLDivElement;
let root: Root;
const save = vi.fn(async (_check: PlaybookDeterministicCheckDto | null) => {});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  save.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(gate: PlaybookGateKind, check: PlaybookDeterministicCheckDto | null, busy = false) {
  await act(async () => root.render(<PlaybookCheckSelector gate={gate} check={check} busy={busy} save={save} />));
}
const select = () => host.querySelector<HTMLSelectElement>('[aria-label="Completion check"]')!;
const baseInput = () => host.querySelector<HTMLInputElement>('[aria-label="Pull request base branch"]');
const saveButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save check")!;
async function choose(value: string) {
  await act(async () => { select().value = value; select().dispatchEvent(new Event("change", { bubbles: true })); });
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PlaybookCheckSelector", () => {
  it("offers the agent Routine, the commit check, and the three pull request checks, with an optional base branch", async () => {
    await render("automatic", null);
    expect([...select().options].map((option) => option.textContent))
      .toEqual(["Agent routine (LLM)", "Committed", "PR open", "PR checks passing", "PR merged"]);
    expect(select().value).toBe("routine");
    expect(baseInput()).toBeNull();
    expect(saveButton().disabled).toBe(true);

    await choose("pullRequestMerged");
    expect(baseInput()).not.toBeNull();
    await act(async () => saveButton().click());
    expect(save).toHaveBeenLastCalledWith({ kind: "pullRequestMerged", baseBranch: null });

    await type(baseInput()!, "  dev ");
    await act(async () => saveButton().click());
    expect(save).toHaveBeenLastCalledWith({ kind: "pullRequestMerged", baseBranch: "dev" });
  });

  it("saves a commit check without a base branch", async () => {
    await render("automatic", { kind: "pullRequestOpen", baseBranch: "main" });
    await choose("branchCommitted");
    expect(baseInput()).toBeNull();
    await act(async () => saveButton().click());
    expect(save).toHaveBeenLastCalledWith({ kind: "branchCommitted", baseBranch: null });
    expect(host.textContent).toContain("reads the Task branch directly");
  });

  it("switches a checked step back to the agent Routine", async () => {
    await render("automatic", { kind: "pullRequestOpen", baseBranch: "main" });
    expect(select().value).toBe("pullRequestOpen");
    expect(baseInput()!.value).toBe("main");
    await choose("routine");
    await act(async () => saveButton().click());
    expect(save).toHaveBeenLastCalledWith(null);
  });

  it("disables the check on a human gate and drops a pending choice when the gate becomes human", async () => {
    await render("automatic", null);
    await choose("pullRequestChecksPassing");
    expect(baseInput()).not.toBeNull();
    await render("human", null);
    expect(select().disabled).toBe(true);
    expect(select().value).toBe("routine");
    expect(baseInput()).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain("Human gates wait for their approver");
  });
});

describe("saveStepCheck", () => {
  const step = (overrides: Partial<PlaybookMilestoneDto> = {}): PlaybookMilestoneDto => ({
    id: "pr-merged", title: "PR merged", gate: "automatic", routineId: "routine-merged",
    retryDelaySeconds: 600, completeWhen: "Merged.", whileWaiting: { mode: "off", instructions: "" },
    approver: null, deterministicCheck: null, ...overrides,
  });
  const doc = (milestone: PlaybookMilestoneDto, revision = 3): PlaybookDto => ({
    projectId: "project-1", revision, activePipelineName: "Ship", milestones: [milestone], savedPipelines: [], updatedAtEpochMs: 1,
  });

  it("saves only the step's check against the just-read revisions, retrying a lost race", async () => {
    const check = { kind: "pullRequestChecksPassing" as const, baseBranch: null };
    const getPlaybook = vi.fn()
      .mockResolvedValueOnce({ playbook: doc(step()), stateRevision: 10 })
      .mockResolvedValueOnce({ playbook: doc(step()), stateRevision: 11 });
    const updatePlaybook = vi.fn<(params: PlaybookUpdateParams) => Promise<PlaybookUpdateOutcome>>()
      .mockResolvedValueOnce({ ok: false, code: "conflict", message: "state revision changed" })
      .mockImplementationOnce(async (params) => ({
        ok: true, result: { playbook: doc({ ...step(), deterministicCheck: check }, 4), stateRevision: 12 } as never,
      }));
    const saved = await saveStepCheck("project-1", "routine-merged", check, getPlaybook, updatePlaybook);
    expect(saved.milestones[0]?.deterministicCheck).toEqual(check);
    expect(updatePlaybook).toHaveBeenCalledTimes(2);
    expect(updatePlaybook.mock.calls[1]![0]).toMatchObject({
      expectedPlaybookRevision: 3, expectedRevision: 11,
      milestones: [{ id: "pr-merged", deterministicCheck: check }],
    });
  });

  it("refuses a check on a human gate without writing", async () => {
    const updatePlaybook = vi.fn();
    await expect(saveStepCheck(
      "project-1", "routine-merged", { kind: "pullRequestOpen", baseBranch: null },
      async () => ({ playbook: doc(step({ gate: "human", approver: "ferit" })), stateRevision: 10 }),
      updatePlaybook,
    )).rejects.toThrow("human gate");
    expect(updatePlaybook).not.toHaveBeenCalled();
  });
});
