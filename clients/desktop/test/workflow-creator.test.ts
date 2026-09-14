// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDto, WorkflowCreatorDraftGetResult } from "@termloop/contract/current";
import { openWorkflowCreator } from "../src/renderer/composition/workflow-creator.js";
import type { SourceDesktopApi } from "../src/renderer/transport/desktop-api.js";
import { WorkflowCreator, workflowCreatorSession } from "../src/renderer/ui/WorkflowCreator.js";
import { WorkflowEditorPanel } from "../src/renderer/ui/WorkflowEditorPanel.js";
import { workflowConfiguration } from "./workflow-fixture.js";
import { fullAgentCapability } from "./agent-capability-fixture.js";
import { sessionIsImprover } from "../src/renderer/model.js";

const selection = { agentId: "claude", model: "default", permission: "default", reasoning: "default" } as const;
const session: SessionDto = {
  id: "creator", project_id: "project-1", kind: "Agent", name: "Workflow Creator", lifecycle_state: "running", runtime_epoch: 1,
  retryable: true, archived_at_epoch_ms: null, resume_failure_reason: null, closable: true, forkable: false, ask_to_source_session_id: null, run_configuration_id: null,
  process: { program: "claude", args: [], cwd: "/project", agent_id: "claude", template_ref: "builtin.builder.workflow", template_version: 1 },
  improver_target: { targetKind: "workflowDraft", targetId: null },
};
const { id, projectId, generation, updatedAtEpochMs, ...workflow } = workflowConfiguration();
const proposal: WorkflowCreatorDraftGetResult = { versionId: "v1", summary: "One focused implementation step", proposal: { sourceGeneration: null, workflow } };
const target = { workflowId: null, taskId: "task-1", draft: workflow };

function api() {
  return {
    workflowCreatorPreview: vi.fn().mockResolvedValue({ launch_ticket: "inspected" }),
    workflowCreatorLaunch: vi.fn().mockResolvedValue(session),
    sessionListDeleted: vi.fn().mockResolvedValue([]),
    sessionPreviewResumeAgent: vi.fn().mockResolvedValue({ launch_ticket: "resume", manifest: { digest: "sha256:test" } }),
    sessionResumeAgent: vi.fn().mockResolvedValue(session),
  };
}

describe("workflow creator orchestration", () => {
  it("pins task, unsaved draft, user selection and the one-use preview ticket", async () => {
    const client = api();
    await openWorkflowCreator(client as unknown as SourceDesktopApi, [], projectId, target, selection, vi.fn());
    const expected = { projectId, ...target, ...selection, templateRef: "builtin.builder.workflow" };
    expect(client.workflowCreatorPreview).toHaveBeenCalledWith(expected);
    expect(client.workflowCreatorLaunch).toHaveBeenCalledWith({ ...expected, launchTicket: "inspected" });
    expect(sessionIsImprover(session)).toBe(true);
  });
  it("resumes only the exact project/template creator, regardless of display name", async () => {
    const client = api();
    const existing = { ...session, name: "Renamed" };
    await expect(openWorkflowCreator(client as unknown as SourceDesktopApi, [existing], projectId, target, selection, vi.fn())).resolves.toEqual(existing);
    expect(client.workflowCreatorPreview).not.toHaveBeenCalled();
    expect(workflowCreatorSession([existing], projectId, null)).toBe(existing);
    expect(workflowCreatorSession([existing], projectId, "workflow-2")).toBeUndefined();
    expect(workflowCreatorSession([existing], "other", null)).toBeUndefined();
    await openWorkflowCreator(client as unknown as SourceDesktopApi, [existing], projectId, { ...target, workflowId: "workflow-2" }, selection, vi.fn());
    expect(client.workflowCreatorPreview).toHaveBeenCalledTimes(1);
  });
  it("does not replace a failed resume without explicit Start fresh", async () => {
    const client = api(); const retire = vi.fn();
    client.sessionResumeAgent.mockRejectedValue(new Error("Offline"));
    await expect(openWorkflowCreator(client as unknown as SourceDesktopApi, [{ ...session, lifecycle_state: "exited" }], projectId, target, selection, retire)).rejects.toThrow("Offline");
    expect(client.workflowCreatorLaunch).not.toHaveBeenCalled(); expect(retire).not.toHaveBeenCalled();
    await openWorkflowCreator(client as unknown as SourceDesktopApi, [session], projectId, target, selection, retire, { fresh: true });
    expect(retire).toHaveBeenCalledWith(session.id);
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(client.workflowCreatorPreview.mock.invocationCallOrder[0]!);
  });
  it("never launches after preview failure", async () => {
    const client = api(); client.workflowCreatorPreview.mockRejectedValue(new Error("Stale draft"));
    await expect(openWorkflowCreator(client as unknown as SourceDesktopApi, [], projectId, target, selection, vi.fn())).rejects.toThrow("Stale draft");
    expect(client.workflowCreatorLaunch).not.toHaveBeenCalled();
  });
});

let root: Root | undefined;
let host: HTMLDivElement;
async function mount(node: ReturnType<typeof createElement>) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(node));
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
  expect(result, label).toBeTruthy(); return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); });
function controls(overrides: Partial<ComponentProps<typeof WorkflowCreator>> = {}): ComponentProps<typeof WorkflowCreator> {
  return { projectId, workflowId: null, generation: undefined, actions: { read: vi.fn().mockResolvedValue(proposal), start: vi.fn() },
    session: undefined, busy: false, unavailableReason: undefined, dirty: false, start: vi.fn(), continue: vi.fn(), useDraft: vi.fn(), ...overrides };
}

describe("workflow proposal UX", () => {
  it("shows AI creation and a reviewable proposal, never applying it on arrival", async () => {
    const props = controls(); await mount(createElement(WorkflowCreator, props));
    expect(props.useDraft).not.toHaveBeenCalled();
    await click("Create with AI"); expect(props.start).toHaveBeenCalledTimes(1);
    await click("Review AI draft"); expect(host.textContent).toContain("One focused implementation step");
    expect(host.textContent).toContain("Nothing starts automatically");
    await click("Use AI draft"); expect(props.useDraft).toHaveBeenCalledWith(proposal.proposal);
  });
  it("requires confirmation before replacing manual edits and pins it to the reviewed version", async () => {
    const read = vi.fn().mockResolvedValue(proposal); const props = controls({ dirty: true, session, actions: { start: vi.fn(), read } });
    await mount(createElement(WorkflowCreator, props)); await click("Review AI draft"); await click("Use AI draft");
    expect(props.useDraft).not.toHaveBeenCalled(); expect(button("Replace editor draft")).toBeTruthy();
    read.mockResolvedValue({ ...proposal, versionId: "v2", summary: "New version" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click("Use AI draft"); expect(props.useDraft).not.toHaveBeenCalled();
    await click("Replace editor draft"); expect(props.useDraft).toHaveBeenCalledTimes(1);
  });
  it("blocks a proposal from an older saved template generation", async () => {
    const props = controls({ workflowId: id, generation: 2, actions: { start: vi.fn(), read: vi.fn().mockResolvedValue({ ...proposal, proposal: { ...proposal.proposal, sourceGeneration: 1 } }) } });
    await mount(createElement(WorkflowCreator, props)); await click("Review AI draft");
    expect(button("Use AI draft").disabled).toBe(true); expect(host.textContent).toContain("another saved version");
    expect(props.useDraft).not.toHaveBeenCalled();
  });
  it("keeps offline failures actionable without applying anything", async () => {
    const props = controls({ unavailableReason: "Reconnect to continue", actions: { start: vi.fn(), read: vi.fn().mockRejectedValue(new Error("Offline")) } });
    await mount(createElement(WorkflowCreator, props));
    expect(button("Create with AI").disabled).toBe(true); expect(host.textContent).toContain("Could not load the AI draft: Offline");
    expect(props.useDraft).not.toHaveBeenCalled();
  });
  it("polls only a mounted creator, never overlapping reads, and stops after unmount", async () => {
    vi.useFakeTimers(); let resolve: ((value: WorkflowCreatorDraftGetResult) => void) | undefined;
    const read = vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount(createElement(WorkflowCreator, controls({ session, actions: { start: vi.fn(), read } })));
    await act(async () => { vi.advanceTimersByTime(6_000); }); expect(read).toHaveBeenCalledTimes(1);
    await act(async () => resolve!(proposal));
    await act(async () => vi.advanceTimersByTime(2_000)); expect(read).toHaveBeenCalledTimes(2);
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => { resolve!(proposal); vi.advanceTimersByTime(10_000); }); expect(read).toHaveBeenCalledTimes(2);
  });
  it("loads the AI result into the actual editor but requires a separate explicit save", async () => {
    const save = vi.fn().mockResolvedValue(workflowConfiguration()); const setup = vi.fn();
    await mount(createElement(WorkflowEditorPanel, { projectId, stateRevision: 8,
      agentCapabilities: [fullAgentCapability("codex"), fullAgentCapability("claude")], agentProfiles: [], close: vi.fn(), save, remove: vi.fn(),
      creator: { actions: { start: vi.fn(), read: vi.fn().mockResolvedValue(proposal) }, session: undefined, unavailableReason: undefined, setup, continue: vi.fn() } }));
    await click("Create with AI"); expect(setup).toHaveBeenCalledWith(null);
    await click("Review AI draft"); await click("Use AI draft");
    expect((host.querySelector("#workflow-name") as HTMLInputElement).value).toBe(workflow.name);
    expect(host.querySelector(".workflow-lead-card")?.getAttribute("aria-pressed")).toBe("true");
    expect(save).not.toHaveBeenCalled();
    await click("Create template"); expect(save).toHaveBeenCalledWith({ ...workflow, projectId, expectedRevision: 8 });
  });
});
