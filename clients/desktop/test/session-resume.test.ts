import { describe, expect, it, vi } from "vitest";
import type { AgentLaunchPreviewResult, SessionDto } from "@termloop/contract/current";
import { retryAgentSession, type SessionResumeApi } from "../src/renderer/composition/session-resume.js";

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
