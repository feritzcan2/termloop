import { describe, expect, it, vi } from "vitest";
import type { AgentLaunchPreviewResult, SessionDto } from "@termloop/contract/current";
import { restoreDeletedAgent, retryAgentSession, type DeletedSessionRestoreApi, type SessionResumeApi } from "../src/renderer/composition/session-resume.js";

function preview(): AgentLaunchPreviewResult {
  return {
    launch_ticket: "resume-ticket",
    manifest: { digest: "sha256:test" },
  } as AgentLaunchPreviewResult;
}

describe("single-action Session Retry", () => {
  it("resolves and immediately consumes the exact resume ticket", async () => {
    const calls: string[] = [];
    const api: SessionResumeApi = {
      sessionPreviewResumeAgent: vi.fn(async (sessionId) => {
        calls.push(`preview:${sessionId}`);
        return preview();
      }),
      sessionResumeAgent: vi.fn(async (sessionId, ticket) => {
        calls.push(`resume:${sessionId}:${ticket}`);
        return {} as SessionDto;
      }),
    };

    await retryAgentSession(api, "session-1");

    expect(calls).toEqual(["preview:session-1", "resume:session-1:resume-ticket"]);
  });

  it("coalesces repeated Retry clicks for the same Session", async () => {
    let releasePreview: ((value: AgentLaunchPreviewResult) => void) | undefined;
    const api: SessionResumeApi = {
      sessionPreviewResumeAgent: vi.fn(() => new Promise<AgentLaunchPreviewResult>((resolve) => { releasePreview = resolve; })),
      sessionResumeAgent: vi.fn(async () => ({} as SessionDto)),
    };

    const first = retryAgentSession(api, "session-2");
    const second = retryAgentSession(api, "session-2");
    expect(first).toBe(second);
    expect(api.sessionPreviewResumeAgent).toHaveBeenCalledTimes(1);

    releasePreview?.(preview());
    await Promise.all([first, second]);
    expect(api.sessionResumeAgent).toHaveBeenCalledTimes(1);
  });
});

describe("deleted Agent restore", () => {
  function restoreApi(restored: Partial<SessionDto>, resume: () => Promise<SessionDto>): DeletedSessionRestoreApi {
    return {
      sessionRestoreDeleted: vi.fn(async (sessionId) => ({ id: sessionId, ...restored } as SessionDto)),
      sessionPreviewResumeAgent: vi.fn(async () => preview()),
      sessionResumeAgent: vi.fn(resume),
    };
  }

  it("resumes a retryable Agent instead of leaving it exited", async () => {
    const api = restoreApi(
      { lifecycle_state: "exited", retryable: true },
      async () => ({ id: "deleted-1", lifecycle_state: "running" } as SessionDto),
    );

    const { session, resumeError } = await restoreDeletedAgent(api, "deleted-1");

    expect(api.sessionResumeAgent).toHaveBeenCalledWith("deleted-1", "resume-ticket");
    expect(session.lifecycle_state).toBe("running");
    expect(resumeError).toBeUndefined();
  });

  it("keeps a non-resumable restore as returned", async () => {
    const api = restoreApi({ lifecycle_state: "exited", retryable: false }, async () => ({} as SessionDto));

    const { session } = await restoreDeletedAgent(api, "deleted-2");

    expect(api.sessionPreviewResumeAgent).not.toHaveBeenCalled();
    expect(session.lifecycle_state).toBe("exited");
  });

  it("reports a resume failure without hiding the committed restore", async () => {
    const failure = new Error("resume failed");
    const api = restoreApi({ lifecycle_state: "exited", retryable: true }, async () => { throw failure; });

    const { session, resumeError } = await restoreDeletedAgent(api, "deleted-3");

    expect(session.id).toBe("deleted-3");
    expect(resumeError).toBe(failure);
  });
});
