// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CompanionMessageDto } from "@termloop/contract/current";
import type { Task } from "../src/renderer/model.js";
import { AssistantTaskRow } from "../src/renderer/ui/AssistantTaskRows.js";
import type { RoutineConfigurationDto } from "@termloop/contract/current";
import {
  pendingPlaybookTaskDecision, routineFindingTasks, usePlaybookTaskDecision, type PlaybookTaskDecisionActions,
} from "../src/renderer/ui/PlaybookTaskDecision.js";

function message(sequence: number, author: CompanionMessageDto["author"], kind: CompanionMessageDto["kind"], taskId?: string, content = `message ${sequence}`): CompanionMessageDto {
  return {
    id: `m${sequence}`, projectId: "p", sequence, author, kind, content, createdAtEpochMs: sequence,
    ...(taskId ? { refs: { taskId } } : {}),
  };
}

it("returns the open Steward proposal only when it names a Task", () => {
  expect(pendingPlaybookTaskDecision([message(1, "steward", "proposal", "t1")]))
    .toMatchObject({ taskIds: ["t1"], kind: "proposal", message: { id: "m1" } });
  expect(pendingPlaybookTaskDecision([message(1, "steward", "proposal")])).toBeNull();
  expect(pendingPlaybookTaskDecision([message(1, "steward", "suggestion", "t2")]))
    .toMatchObject({ taskIds: ["t2"], kind: "suggestion" });
});

it("follows Core's single open interaction: answered and replaced proposals never surface", () => {
  expect(pendingPlaybookTaskDecision([
    message(1, "steward", "proposal", "t1"), message(2, "user", "approval", "t1"),
  ])).toBeNull();
  expect(pendingPlaybookTaskDecision([
    message(1, "steward", "proposal", "t1"), message(2, "steward", "proposal", "t2"),
  ])).toMatchObject({ taskIds: ["t2"] });
  expect(pendingPlaybookTaskDecision([
    message(1, "steward", "proposal", "t1"), message(2, "steward", "update", "t3"),
  ])).toMatchObject({ taskIds: ["t1"] });
});

function routine(findings: Record<string, readonly string[]>): RoutineConfigurationDto {
  return {
    pendingRoutineFindings: Object.entries(findings).map(([id, relatedTaskIds]) => ({ id, relatedTaskIds })),
  } as unknown as RoutineConfigurationDto;
}
function batched(findingIds: string[]): CompanionMessageDto {
  return { ...message(1, "steward", "proposal"), refs: { routineFindingIds: findingIds } };
}

it("covers every Task of a proposal that batches several Playbook findings", () => {
  const findings = routineFindingTasks([routine({ f1: ["t1"], f2: ["t2"] }), routine({ f3: ["t3", "t1"] })]);
  expect(pendingPlaybookTaskDecision([batched(["f1", "f2", "f3"])], findings))
    .toMatchObject({ taskIds: ["t1", "t2", "t3"], kind: "proposal" });
  expect(pendingPlaybookTaskDecision([batched(["gone"])], findings)).toBeNull();
  expect(pendingPlaybookTaskDecision([batched(["f1"])])).toBeNull();
});

let host: HTMLDivElement;
let root: Root;
const task = { id: "t1", title: "Fix search", status: "open" } as Task;
const otherTask = { id: "t2", title: "Ship docs", status: "open" } as Task;
let messages: CompanionMessageDto[];
const actions = {
  listTranscript: vi.fn(),
  respondToProposal: vi.fn(),
  acceptSuggestion: vi.fn(),
};
const openSteward = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  messages = [message(1, "steward", "proposal", "t1", "Request review from the owner.\nThe PR has been idle for two days.")];
  actions.listTranscript.mockReset().mockImplementation(async () => ({ messages }));
  actions.respondToProposal.mockReset().mockResolvedValue({ message: message(2, "user", "approval", "t1") });
  actions.acceptSuggestion.mockReset().mockResolvedValue({ message: message(2, "user", "acceptance", "t1") });
  openSteward.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function Rows(props: { refreshToken?: number; disabled?: boolean; routines?: RoutineConfigurationDto[] }) {
  const decision = usePlaybookTaskDecision("p", props.refreshToken ?? 0, actions as unknown as PlaybookTaskDecisionActions, props.routines);
  return <>{[task, otherTask].map((value) => <AssistantTaskRow key={value.id} task={value} processingTaskId={null}
    openTask={() => undefined} decision={decision} openSteward={openSteward} notesDisabled={props.disabled} />)}</>;
}
async function render(props: { refreshToken?: number; disabled?: boolean; routines?: RoutineConfigurationDto[] } = {}) {
  await act(async () => root.render(<Rows {...props} />));
}
const button = (text: string) => [...host.querySelectorAll("button")].find((value) => value.textContent === text);

it("shows the decision only on its Task row and needs the message open before approving", async () => {
  await render();
  const strips = host.querySelectorAll(".playbook-task-decision");
  expect(strips).toHaveLength(1);
  expect(strips[0]!.getAttribute("aria-label")).toBe("Needs your approval for Fix search");
  expect(host.textContent).toContain("Request review from the owner.");
  expect(host.textContent).not.toContain("idle for two days");
  expect(button("Approve")).toBeUndefined();

  await act(async () => host.querySelector<HTMLButtonElement>(".playbook-task-decision-head")!.click());
  expect(host.textContent).toContain("idle for two days");
  await act(async () => button("Approve")!.click());
  expect(actions.respondToProposal).toHaveBeenCalledExactlyOnceWith("m1", "approve");
  expect(host.querySelector(".playbook-task-decision")).toBeNull();
});

it("declines, keeps the strip with the error when Core refuses, and links to the Steward", async () => {
  actions.respondToProposal.mockRejectedValueOnce(new Error("Proposal is no longer pending"));
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>(".playbook-task-decision-head")!.click());
  await act(async () => button("Decline")!.click());
  expect(actions.respondToProposal).toHaveBeenCalledExactlyOnceWith("m1", "decline");
  expect(host.querySelector('[role="alert"]')!.textContent).toBe("Proposal is no longer pending");
  await act(async () => button("Open Steward")!.click());
  expect(openSteward).toHaveBeenCalledOnce();
});

it("offers acceptance for a suggestion and disables answers while the rail is disabled", async () => {
  messages = [message(1, "steward", "suggestion", "t1", "Rebase onto develop.")];
  await render({ disabled: true });
  await act(async () => host.querySelector<HTMLButtonElement>(".playbook-task-decision-head")!.click());
  expect(button("Approve")).toBeUndefined();
  expect(button("Accept suggestion")!.disabled).toBe(true);
  await render({ disabled: false });
  await act(async () => button("Accept suggestion")!.click());
  expect(actions.acceptSuggestion).toHaveBeenCalledExactlyOnceWith("m1");
});

it("rereads the transcript on a new projection token and drops an answered proposal", async () => {
  await render();
  expect(host.querySelector(".playbook-task-decision")).not.toBeNull();
  messages = [...messages, message(2, "user", "reply", undefined, "Not now")];
  await render({ refreshToken: 1 });
  expect(actions.listTranscript).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".playbook-task-decision")).toBeNull();
});

it("shows one batched proposal on each covered Task row and one approval answers all of them", async () => {
  messages = [batched(["f1", "f2"])];
  await render({ routines: [routine({ f1: ["t1"], f2: ["t2"] })] });
  const strips = host.querySelectorAll(".playbook-task-decision");
  expect([...strips].map((strip) => strip.getAttribute("aria-label")))
    .toEqual(["Needs your approval for Fix search", "Needs your approval for Ship docs"]);
  expect(strips[0]!.textContent).toContain("2 Tasks");

  await act(async () => strips[1]!.querySelector<HTMLButtonElement>(".playbook-task-decision-head")!.click());
  expect(strips[1]!.textContent).toContain("One approval answers this for this Task and 1 other.");
  await act(async () => button("Approve")!.click());
  expect(actions.respondToProposal).toHaveBeenCalledExactlyOnceWith("m1", "approve");
  expect(host.querySelector(".playbook-task-decision")).toBeNull();
});
