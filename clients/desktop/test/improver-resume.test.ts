import { describe, expect, it, vi } from "vitest";
import type { AgentLaunchPreviewResult, SessionDto } from "@termloop/contract/current";
import {
  previousImproverSession,
  resumeImproverOrLaunchFresh,
  resumePreviousImprover,
  settingsImproverSessionTarget,
  type ImproverResumeApi,
} from "../src/renderer/composition/improver-resume.js";

const target = { targetKind: "routineInstructions", targetId: "routine-1" } as const;

function session(
  id: string,
  lifecycle_state: SessionDto["lifecycle_state"],
  retryable: boolean,
  exactTarget: SessionDto["improver_target"] = target,
): SessionDto {
  return {
    id,
    project_id: "project-1",
    name: "improve: Deploy check",
    kind: "Agent",
    process: {
      program: "claude",
      args: [],
      cwd: "/project",
      agent_id: "claude",
      template_ref: "builtin.improver.routine-instructions",
      template_version: 1,
    },
    lifecycle_state,
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable,
    closable: true,
    forkable: true,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    improver_target: exactTarget,
  };
}

function api(
  result: SessionDto | Error,
  deleted: Awaited<ReturnType<ImproverResumeApi["sessionListDeleted"]>> = [],
): ImproverResumeApi {
  return {
    sessionListDeleted: vi.fn(async () => deleted),
    sessionRestoreDeleted: vi.fn(async (sessionId) => {
      const item = deleted.find((candidate) => candidate.session.id === sessionId);
      if (!item) throw new Error("deleted Session not found");
      return item.session;
    }),
    sessionPreviewResumeAgent: vi.fn(async () => ({
      launch_ticket: "resume-ticket",
      manifest: { digest: "sha256:test" },
    } as AgentLaunchPreviewResult)),
    sessionResumeAgent: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function deletedSession(
  value: SessionDto,
  deletedAt: number,
  restoreBlocker: "sourceUnavailable" | "taskArchived" | null = null,
) {
  return {
    session: value,
    deleted_at_epoch_ms: deletedAt,
    purge_at_epoch_ms: deletedAt + 1_000,
    source_available: restoreBlocker !== "sourceUnavailable",
    restore_blocker: restoreBlocker,
  };
}

describe("improver resume-first selection", () => {
  it("selects the newest Session for the exact durable target", () => {
    const sessions = [
      session("older", "exited", true),
      session("other", "running", true, { targetKind: "routineInstructions", targetId: "routine-2" }),
      session("newest", "resumeFailed", true),
    ];
    expect(previousImproverSession(sessions, "project-1", target)?.id).toBe("newest");
  });

  it("reuses a live improver without issuing a resume", async () => {
    const resumeApi = api(session("unused", "running", true));
    const previous = session("live", "running", true);
    const legacy = vi.fn(async () => undefined);
    await expect(resumePreviousImprover(resumeApi, [previous], "project-1", target, legacy))
      .resolves.toEqual(previous);
    expect(resumeApi.sessionPreviewResumeAgent).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("uses the guarded legacy identity only when durable target provenance is absent", () => {
    const legacy = session("legacy", "exited", true, null);
    expect(previousImproverSession([legacy], "project-1", target, {
      templateRef: "builtin.improver.routine-instructions",
      sessionName: "improve: Deploy check",
      targetNameIsUnique: true,
    })?.id).toBe("legacy");
  });

  it("returns the resumed Session when inspected resume succeeds", async () => {
    const resumed = session("previous", "running", true);
    const resumeApi = api(resumed);
    await expect(resumePreviousImprover(
      resumeApi,
      [session("previous", "exited", true)],
      "project-1",
      target,
    )).resolves.toEqual(resumed);
    expect(resumeApi.sessionPreviewResumeAgent).toHaveBeenCalledWith("previous");
  });

  it("restores the newest closed improver and resumes its exact conversation", async () => {
    const older = session("older-deleted", "exited", true);
    const newest = session("newest-deleted", "exited", true);
    const resumed = session("newest-deleted", "running", true);
    const resumeApi = api(resumed, [
      deletedSession(older, 10),
      deletedSession(newest, 20),
    ]);

    await expect(resumePreviousImprover(
      resumeApi,
      [],
      "project-1",
      target,
    )).resolves.toEqual(resumed);
    expect(resumeApi.sessionRestoreDeleted).toHaveBeenCalledWith("newest-deleted");
    expect(resumeApi.sessionPreviewResumeAgent).toHaveBeenCalledWith("newest-deleted");
  });

  it("does not silently replace a closed conversation that cannot be restored", async () => {
    const closed = session("closed", "exited", true);
    const resumeApi = api(session("unused", "running", true), [
      deletedSession(closed, 20, "sourceUnavailable"),
    ]);

    await expect(resumePreviousImprover(
      resumeApi,
      [],
      "project-1",
      target,
    )).rejects.toThrow("Use Start fresh");
    expect(resumeApi.sessionRestoreDeleted).not.toHaveBeenCalled();
    expect(resumeApi.sessionPreviewResumeAgent).not.toHaveBeenCalled();
  });

  it("resumes the durable Playbook Builder target after an app restart", async () => {
    const playbookTarget = { targetKind: "playbook" as const, targetId: null };
    const stopped = session("playbook-builder", "exited", true, playbookTarget);
    const resumed = session("playbook-builder", "running", true, playbookTarget);
    const resumeApi = api(resumed);

    await expect(resumePreviousImprover(
      resumeApi,
      [stopped],
      "project-1",
      playbookTarget,
    )).resolves.toEqual(resumed);
    expect(resumeApi.sessionPreviewResumeAgent).toHaveBeenCalledWith("playbook-builder");
  });

  it("never runs a customized fresh launch while the exact improver can resume", async () => {
    const resumed = session("previous", "running", true);
    const launchFresh = vi.fn(async () => session("fresh", "running", true));

    await expect(resumeImproverOrLaunchFresh(
      api(resumed),
      [session("previous", "exited", true)],
      "project-1",
      target,
      undefined,
      launchFresh,
    )).resolves.toEqual(resumed);
    expect(launchFresh).not.toHaveBeenCalled();
  });

  it("does not silently launch fresh when the previous improver fails to resume", async () => {
    const fresh = session("fresh", "running", true);
    const launchFresh = vi.fn(async () => fresh);

    await expect(resumeImproverOrLaunchFresh(
      api(new Error("provider rejected resume")),
      [session("previous", "exited", true)],
      "project-1",
      target,
      undefined,
      launchFresh,
    )).rejects.toThrow("provider rejected resume");
    expect(launchFresh).not.toHaveBeenCalled();
  });

  it("retires the previous improver and launches new when fresh is explicitly requested", async () => {
    const previous = session("previous", "running", true);
    const fresh = session("fresh", "running", true);
    const launchFresh = vi.fn(async () => fresh);
    const retire = vi.fn(async () => undefined);
    const resumeApi = api(previous);

    await expect(resumeImproverOrLaunchFresh(
      resumeApi,
      [previous],
      "project-1",
      target,
      undefined,
      launchFresh,
      { requested: true, retire },
    )).resolves.toEqual(fresh);
    expect(retire).toHaveBeenCalledWith(previous);
    expect(launchFresh).toHaveBeenCalledOnce();
    expect(resumeApi.sessionPreviewResumeAgent).not.toHaveBeenCalled();
  });

  it("launches fresh directly when fresh is requested and nothing exists to retire", async () => {
    const fresh = session("fresh", "running", true);
    const launchFresh = vi.fn(async () => fresh);
    const retire = vi.fn(async () => undefined);

    await expect(resumeImproverOrLaunchFresh(
      api(fresh),
      [],
      "project-1",
      target,
      undefined,
      launchFresh,
      { requested: true, retire },
    )).resolves.toEqual(fresh);
    expect(retire).not.toHaveBeenCalled();
    expect(launchFresh).toHaveBeenCalledOnce();
  });

  it("keeps resume-first when the fresh option is present but not requested", async () => {
    const resumed = session("previous", "running", true);
    const launchFresh = vi.fn(async () => session("fresh", "running", true));

    await expect(resumeImproverOrLaunchFresh(
      api(resumed),
      [session("previous", "exited", true)],
      "project-1",
      target,
      undefined,
      launchFresh,
      undefined,
    )).resolves.toEqual(resumed);
    expect(launchFresh).not.toHaveBeenCalled();
  });

  it("surfaces resume failures instead of replacing the conversation", async () => {
    const failed = session("previous", "resumeFailed", true);
    await expect(resumePreviousImprover(
      api(failed),
      [session("previous", "exited", true)],
      "project-1",
      target,
    )).rejects.toThrow("did not resume");
    await expect(resumePreviousImprover(
      api(new Error("provider rejected resume")),
      [session("previous", "exited", true)],
      "project-1",
      target,
    )).rejects.toThrow("provider rejected resume");
  });

  it("maps every Settings improver to its durable resume identity", () => {
    expect(settingsImproverSessionTarget({
      kind: "skill", id: "skill-1", name: null, path: null, content: null,
    })).toEqual({ targetKind: "settingsSkill", targetId: "skill-1" });
    expect(settingsImproverSessionTarget({
      kind: "prompt", id: "prompt-1", name: "Prompt", path: "/prompts/one.md", content: "body",
    })).toEqual({ targetKind: "settingsPrompt", targetId: "/prompts/one.md" });
    expect(settingsImproverSessionTarget({
      kind: "mcpTool", id: "server:tool", name: null, path: null, content: null,
    })).toEqual({ targetKind: "settingsMcpTool", targetId: "server:tool" });
  });
});
