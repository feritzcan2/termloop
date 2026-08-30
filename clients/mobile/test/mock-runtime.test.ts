import { describe, expect, it } from "vitest";

import { CONTRACT_IDENTITY } from "@termloop/contract/current";

import type { TerminalEvent } from "../src/application/ports";
import { createMockRuntime } from "../src/adapters/mock/mock-runtime";

describe("mock mobile runtime", () => {
  it("exposes every saved-Mac availability without inventing a credential", async () => {
    const runtime = createMockRuntime();
    const profiles = await runtime.connections.list();

    expect(profiles.map((profile) => profile.availability)).toEqual([
      "online",
      "offline",
      "revoked",
      "updateRequired",
    ]);
    expect(profiles[0]?.contractIdentity).toBe(CONTRACT_IDENTITY);
    expect(profiles[3]?.contractIdentity).not.toBe(CONTRACT_IDENTITY);
  });

  it("returns generated-contract-shaped overview projections", async () => {
    const runtime = createMockRuntime();
    const overview = await runtime.control.loadOverview("connection-local-mac");

    expect(overview.projects[0]?.name).toBe("TermLoop Next");
    expect(overview.tasks[0]?.status).toBe("open");
    expect(overview.sessions[0]?.kind).toBe("Agent");
    expect(overview.agentStatuses[0]?.status).toBe("awaitingInput");
  });

  it("serves a bounded worktree observation and binds its patch to that observation", async () => {
    const runtime = createMockRuntime();
    const changes = await runtime.worktreeChanges.listTask("connection-local-mac", "task-mobile");
    const diff = await runtime.worktreeChanges.diffTask(
      "connection-local-mac", "task-mobile", changes.observation_id, changes.entries[0]!.entry_id,
    );
    const preImage = await runtime.worktreeChanges.preImageTask(
      "connection-local-mac", "task-mobile", changes.observation_id, changes.entries[0]!.entry_id,
    );

    expect(changes.entries).toHaveLength(4);
    expect(diff).toMatchObject({ state: "patch", entry_id: changes.entries[0]?.entry_id });
    expect(preImage).toMatchObject({ entry_id: changes.entries[0]?.entry_id, state: "truncated" });
    await expect(runtime.worktreeChanges.diffTask(
      "connection-local-mac", "task-mobile", "stale-observation", changes.entries[0]!.entry_id,
    )).rejects.toThrow("observation is stale");
  });

  it("delivers replay and gap before live output, then accepts binary input", async () => {
    const runtime = createMockRuntime();
    const events: TerminalEvent[] = [];
    const attachment = await runtime.terminal.attach(
      "connection-local-mac",
      { id: "session-claude", runtime_epoch: 17 },
      (event) => events.push(event),
    );

    expect(events.map((event) => event.type)).toEqual([
      "state",
      "replay",
      "gap",
      "state",
      "live",
    ]);

    const input = new TextEncoder().encode("continue\r");
    await attachment.input(input);
    input.fill(0);
    expect(new TextDecoder().decode(runtime.inspection.inputs[0])).toBe("continue\r");

    await attachment.detach();
    await attachment.detach();
    expect(runtime.inspection.detachedSessions).toEqual(["session-claude"]);
    await expect(attachment.input(new Uint8Array([1]))).rejects.toThrow("mock terminal is detached");
  });

  it("rejects a stale terminal runtime epoch", async () => {
    const runtime = createMockRuntime();
    await expect(runtime.terminal.attach(
      "connection-local-mac",
      { id: "session-claude", runtime_epoch: 16 },
      () => undefined,
    )).rejects.toThrow("mock terminal epoch is stale");
  });

  it("serves a pipeline the phone can be read against without a paired Mac", async () => {
    const runtime = createMockRuntime();
    const projection = await runtime.playbook.read("connection-local-mac", "project-termloop-next");

    expect(projection.playbook?.milestones).toHaveLength(5);
    expect(projection.runtime?.steps.find((step) => step.waitingTaskIds.includes("task-mobile"))
      ?.milestoneId).toBe("review-requested");
    // A step whose Routine is off is part of the fixture on purpose: the blocked
    // answer source is a state the phone has to render.
    expect(projection.routines.some((routine) => !routine.enabled)).toBe(true);
  });

  it("records a position change and a manual check rather than pretending to move state", async () => {
    const runtime = createMockRuntime();

    await runtime.playbook.setTaskPosition("connection-local-mac", {
      projectId: "project-termloop-next",
      taskId: "task-mobile",
      passedMilestoneCount: 3,
      expectedPlaybookRevision: 6,
      expectedRevision: 118,
    });
    await runtime.playbook.runRoutineNow("connection-local-mac", "routine-request");

    expect(runtime.inspection.positionsSet).toEqual([{ taskId: "task-mobile", passedMilestoneCount: 3 }]);
    expect(runtime.inspection.routinesRun).toEqual(["routine-request"]);
  });

  it("previews a launch that names the choices it was given, then spends its ticket", async () => {
    const runtime = createMockRuntime();

    const capabilities = await runtime.agentLaunch.capabilities("connection-local-mac");
    expect(capabilities.map((capability) => capability.agent_id)).toEqual(["claude", "codex", "gemini"]);

    const inspection = await runtime.agentLaunch.preview("connection-local-mac", "task-mobile", {
      agentId: "codex", model: "gpt-5.5-pro", permission: "plan", reasoning: "high",
    });
    expect(inspection).toMatchObject({
      program: "/usr/local/bin/codex",
      args: ["--model", "gpt-5.5-pro"],
      model: "gpt-5.5-pro",
      permission: "plan",
      reasoning: "high",
    });

    const result = await runtime.agentLaunch.launch(
      "connection-local-mac", "task-mobile", { agentId: "codex" }, inspection.launchTicket, "Fix the bug",
    );
    expect(result).toEqual({ sessionId: "session-claude", runtimeEpoch: 17, promptSubmitted: true });
    expect(runtime.inspection.launches).toEqual([
      { taskId: "task-mobile", agentId: "codex", launchTicket: "mock-ticket-codex" },
    ]);
  });

  it("refuses a launch preview for a Task the fixture does not hold", async () => {
    const runtime = createMockRuntime();
    await expect(runtime.agentLaunch.preview("connection-local-mac", "task-missing", {
      agentId: "claude", model: "default", permission: "default", reasoning: "default",
    })).rejects.toThrow("mock task not found");
  });

  it("starts an unassigned Agent directly in a Project with the selected launch options", async () => {
    const runtime = createMockRuntime();
    const project = (await runtime.control.loadOverview("connection-local-mac")).projects[0]!;
    const inspection = await runtime.agentLaunch.previewProject("connection-local-mac", project, {
      agentId: "claude", model: "sonnet", permission: "acceptEdits", reasoning: "high",
    });

    await expect(runtime.agentLaunch.launchProject(
      "connection-local-mac", project, { agentId: "claude" }, inspection.launchTicket,
    )).resolves.toEqual({ sessionId: "session-claude", runtimeEpoch: 17, promptSubmitted: null });
    expect(runtime.inspection.projectLaunches).toEqual([
      { projectId: project.id, agentId: "claude", launchTicket: "mock-project-ticket-claude" },
    ]);
  });

  it("remembers the selected Project for future Watch requests", async () => {
    const runtime = createMockRuntime();

    await expect(runtime.watch.targetProject("connection-local-mac")).resolves.toBeNull();
    await expect(runtime.watch.setTargetProject("connection-local-mac", "project-termloop-next"))
      .resolves.toEqual({ synced: false });
    await expect(runtime.watch.targetProject("connection-local-mac")).resolves.toBe("project-termloop-next");
  });

  it("grows the Steward transcript in sequence and answers a pending suggestion", async () => {
    const runtime = createMockRuntime();

    const initial = await runtime.steward.transcript("connection-local-mac", "project-termloop-next");
    expect(initial.map((message) => message.kind)).toEqual(["reply", "reply", "suggestion"]);

    const afterSend = await runtime.steward.send(
      "connection-local-mac", "project-termloop-next", "ask the reviewer",
    );
    expect(afterSend.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(afterSend.at(-2)?.content).toBe("ask the reviewer");

    const afterAccept = await runtime.steward.respond(
      "connection-local-mac", "project-termloop-next", "companion-3", "accept",
    );
    expect(afterAccept.at(-1)?.kind).toBe("approval");
  });

  it("marks a mocked recording as a voice turn", async () => {
    const runtime = createMockRuntime();

    const preview = await runtime.steward.transcribeVoice(
      "connection-local-mac",
      { bytes: new Uint8Array([1, 2, 3]).buffer, mediaType: "audio/m4a" },
    );
    const appended = await runtime.steward.commitVoice(
      "connection-local-mac",
      "project-termloop-next",
      preview,
    );
    const transcript = await runtime.steward.transcript("connection-local-mac", "project-termloop-next");

    expect(appended.transcript).toBe(preview);
    expect(transcript.find((message) => message.sequence === appended.userSequence)?.inputMode).toBe("voice");
  });

  it("refuses to answer a Steward message the transcript does not hold", async () => {
    const runtime = createMockRuntime();
    await expect(runtime.steward.respond(
      "connection-local-mac", "project-termloop-next", "companion-missing", "approve",
    )).rejects.toThrow("mock steward message not found");
  });
});
