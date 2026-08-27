import { describe, expect, it, vi } from "vitest";
import type {
  AgentLaunchPreviewResult,
  InspectableLaunchManifest,
  SessionDto,
  SessionRelocationPreviewDto,
} from "@termloop/contract/current";
import {
  relocateAgentToProjectWithStartupRetry,
  relocateAgentToTaskWithStartupRetry,
  type SessionRelocationApi,
} from "../src/renderer/composition/session-relocation.js";

const sessionId = "session-1";

function session(overrides: Partial<SessionDto> = {}): SessionDto {
  return {
    id: sessionId,
    project_id: "project-1",
    name: "Codex",
    kind: "Agent",
    process: {
      program: "codex",
      args: [],
      cwd: "/repo",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: true,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    ...overrides,
  };
}

function startupTimeout(): SessionDto {
  return session({
    lifecycle_state: "resumeFailed",
    resume_failure_reason: "startupTimedOut",
    retryable: true,
  });
}

function manifest(digest = "sha256:approved"): InspectableLaunchManifest {
  return { digest } as InspectableLaunchManifest;
}

function resumePreview(): AgentLaunchPreviewResult {
  return {
    launch_ticket: "resume-ticket",
    manifest: manifest("sha256:resume"),
  } as AgentLaunchPreviewResult;
}

function relocationPreview(digest = "sha256:approved"): SessionRelocationPreviewDto {
  return {
    can_relocate: true,
    relocation_ticket: "retry-relocation-ticket",
    manifest: manifest(digest),
  } as SessionRelocationPreviewDto;
}

function createApi(): SessionRelocationApi {
  return {
    sessionPreviewResumeAgent: vi.fn(async () => resumePreview()),
    sessionResumeAgent: vi.fn(async () => session()),
    sessionPreviewRelocateAgent: vi.fn(async () => relocationPreview()),
    sessionRelocateAgent: vi.fn(async () => session()),
    sessionPreviewRelocateAgentToProject: vi.fn(async () => relocationPreview()),
    sessionRelocateAgentToProject: vi.fn(async () => session()),
  };
}

function taskRequest() {
  return {
    sessionId,
    taskId: "task-1",
    operationId: "operation-1",
    relocationTicket: "initial-relocation-ticket",
    mode: "resume" as const,
    manifestDigest: "sha256:approved",
  };
}

describe("Session relocation startup recovery", () => {
  it("does not enter recovery when the first Task relocation succeeds", async () => {
    const api = createApi();

    await expect(relocateAgentToTaskWithStartupRetry(api, taskRequest())).resolves.toMatchObject({
      lifecycle_state: "running",
    });

    expect(api.sessionRelocateAgent).toHaveBeenCalledOnce();
    expect(api.sessionPreviewResumeAgent).not.toHaveBeenCalled();
    expect(api.sessionPreviewRelocateAgent).not.toHaveBeenCalled();
  });

  it("does not automatically retry another relocation failure class", async () => {
    const api = createApi();
    const failed = session({
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "providerSessionUnavailable",
      retryable: true,
    });
    vi.mocked(api.sessionRelocateAgent).mockResolvedValueOnce(failed);

    await expect(relocateAgentToTaskWithStartupRetry(api, taskRequest())).resolves.toBe(failed);
    expect(api.sessionRelocateAgent).toHaveBeenCalledOnce();
    expect(api.sessionPreviewResumeAgent).not.toHaveBeenCalled();
  });

  it("restores the source and retries a Task relocation once with a fresh matching ticket", async () => {
    const api = createApi();
    vi.mocked(api.sessionRelocateAgent)
      .mockResolvedValueOnce(startupTimeout())
      .mockResolvedValueOnce(session());

    await relocateAgentToTaskWithStartupRetry(api, taskRequest());

    expect(api.sessionPreviewResumeAgent).toHaveBeenCalledWith(sessionId);
    expect(api.sessionResumeAgent).toHaveBeenCalledWith(sessionId, "resume-ticket");
    expect(api.sessionPreviewRelocateAgent).toHaveBeenCalledWith(sessionId, "task-1", "resume");
    expect(api.sessionRelocateAgent).toHaveBeenCalledTimes(2);
    expect(api.sessionRelocateAgent).toHaveBeenNthCalledWith(
      2,
      sessionId,
      "task-1",
      expect.not.stringMatching(/^operation-1$/),
      "retry-relocation-ticket",
    );
  });

  it("refuses the automatic retry when the newly inspected manifest changed", async () => {
    const api = createApi();
    vi.mocked(api.sessionRelocateAgent).mockResolvedValueOnce(startupTimeout());
    vi.mocked(api.sessionPreviewRelocateAgent).mockResolvedValueOnce(
      relocationPreview("sha256:changed"),
    );

    await expect(relocateAgentToTaskWithStartupRetry(api, taskRequest()))
      .rejects.toThrow("The move changed while retrying");
    expect(api.sessionRelocateAgent).toHaveBeenCalledOnce();
  });

  it("routes damaged provider history to the existing repair flow", async () => {
    const api = createApi();
    const damaged = session({
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "providerHistoryDamaged",
      retryable: true,
    });
    vi.mocked(api.sessionRelocateAgent).mockResolvedValueOnce(startupTimeout());
    vi.mocked(api.sessionResumeAgent).mockResolvedValueOnce(damaged);

    await expect(relocateAgentToTaskWithStartupRetry(api, taskRequest())).resolves.toBe(damaged);
    expect(api.sessionPreviewRelocateAgent).not.toHaveBeenCalled();
    expect(api.sessionRelocateAgent).toHaveBeenCalledOnce();
  });

  it("stops after a second startup timeout", async () => {
    const api = createApi();
    vi.mocked(api.sessionRelocateAgent)
      .mockResolvedValueOnce(startupTimeout())
      .mockResolvedValueOnce(startupTimeout());

    await expect(relocateAgentToTaskWithStartupRetry(api, taskRequest()))
      .rejects.toThrow("after one automatic retry");
    expect(api.sessionRelocateAgent).toHaveBeenCalledTimes(2);
    expect(api.sessionPreviewResumeAgent).toHaveBeenCalledOnce();
  });

  it("uses the same bounded recovery when moving back to the Project", async () => {
    const api = createApi();
    vi.mocked(api.sessionRelocateAgentToProject)
      .mockResolvedValueOnce(startupTimeout())
      .mockResolvedValueOnce(session());

    await relocateAgentToProjectWithStartupRetry(api, {
      sessionId,
      projectId: "project-1",
      operationId: "operation-1",
      relocationTicket: "initial-relocation-ticket",
      manifestDigest: "sha256:approved",
    });

    expect(api.sessionPreviewRelocateAgentToProject).toHaveBeenCalledWith(sessionId, "project-1");
    expect(api.sessionRelocateAgentToProject).toHaveBeenCalledTimes(2);
  });
});
