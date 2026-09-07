import { describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@termloop/contract/current";
import { openAgentCreator } from "../src/renderer/composition/agent-creator.js";
import type { SourceDesktopApi } from "../src/renderer/transport/desktop-api.js";
import { sessionIsImprover } from "../src/renderer/model.js";

const selection = { agentId: "claude", model: "sonnet", permission: "acceptEdits", reasoning: "high" } as const;
const session: SessionDto = {
  id: "creator", project_id: "project", kind: "Agent", name: "Agent Creator", lifecycle_state: "running",
  runtime_epoch: 1, retryable: true, archived_at_epoch_ms: null,
  resume_failure_reason: null, closable: true, forkable: false, ask_to_source_session_id: null, run_configuration_id: null,
  process: { program: "claude", args: [], cwd: "/project", agent_id: "claude", template_ref: "builtin.builder.agent", template_version: 1 },
  improver_target: { targetKind: "agentCreator", targetId: null },
};

function api() {
  return {
    agentCreatorPreview: vi.fn().mockResolvedValue({ launch_ticket: "inspected" }),
    agentCreatorLaunch: vi.fn().mockResolvedValue(session),
    sessionListDeleted: vi.fn().mockResolvedValue([]),
    sessionPreviewResumeAgent: vi.fn().mockResolvedValue({ launch_ticket: "resume", manifest: { digest: "sha256:test" } }),
    sessionResumeAgent: vi.fn().mockResolvedValue(session),
  };
}

describe("Agent Creator launch", () => {
  it("launches the inspected creator with the user's complete settings", async () => {
    const client = api();
    await expect(openAgentCreator(client as unknown as SourceDesktopApi, [], "project", selection, vi.fn())).resolves.toEqual(session);
    expect(client.agentCreatorPreview).toHaveBeenCalledWith({ projectId: "project", ...selection, templateRef: "builtin.builder.agent" });
    expect(client.agentCreatorLaunch).toHaveBeenCalledWith({ projectId: "project", ...selection, templateRef: "builtin.builder.agent", launchTicket: "inspected" });
    expect(sessionIsImprover(session)).toBe(true);
  });

  it("reopens only the exact project's current creator without duplicating it", async () => {
    const client = api();
    await expect(openAgentCreator(client as unknown as SourceDesktopApi, [session], "project", selection, vi.fn())).resolves.toEqual(session);
    expect(client.agentCreatorPreview).not.toHaveBeenCalled();
    expect(client.sessionPreviewResumeAgent).not.toHaveBeenCalled();
    await openAgentCreator(client as unknown as SourceDesktopApi, [session], "other-project", selection, vi.fn());
    expect(client.agentCreatorPreview).toHaveBeenCalledWith(expect.objectContaining({ projectId: "other-project" }));
  });

  it("keeps an existing conversation when resume fails and retires it only for Start fresh", async () => {
    const client = api();
    client.sessionResumeAgent.mockRejectedValue(new Error("Resume unavailable"));
    const stopped = { ...session, lifecycle_state: "exited" } as SessionDto;
    const retire = vi.fn().mockResolvedValue(undefined);
    await expect(openAgentCreator(client as unknown as SourceDesktopApi, [stopped], "project", selection, retire)).rejects.toThrow("Resume unavailable");
    expect(client.agentCreatorLaunch).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    await openAgentCreator(client as unknown as SourceDesktopApi, [session], "project", selection, retire, { fresh: true });
    expect(retire).toHaveBeenCalledWith("creator");
    expect(retire.mock.invocationCallOrder[0]).toBeLessThan(client.agentCreatorPreview.mock.invocationCallOrder[0]!);
  });
});
