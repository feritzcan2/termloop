import { describe, expect, it, vi } from "vitest";
import type { AgentLaunchPreviewResult, SessionDto } from "@termloop/contract/current";
import { executeProviderHistoryRepair, fixProviderHistoryAndRetry } from "../src/renderer/composition/provider-history-repair.js";
import type { Session } from "../src/renderer/model.js";

function session(lifecycleState: Session["lifecycle_state"]): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: null,
    kind: "Agent",
    process: {
      program: "codex",
      args: [],
      cwd: "/project",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    lifecycle_state: lifecycleState,
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: "providerHistoryDamaged",
    retryable: false,
    closable: true,
    forkable: false,
    ask_to_source_session_id: null,
    fork_source_session_id: null,
    improver_target: null,
    run_configuration_id: null,
  };
}

describe("provider history repair orchestration", () => {
  it("fully terminates a live source before requesting the acknowledged repair", async () => {
    const order: string[] = [];
    const api = {
      sessionTerminate: vi.fn(async () => {
        order.push("terminate");
        return { ok: true as const, result: { sessionId: "session-1", lifecycleState: "exited" as const } };
      }),
      sessionRepairProviderHistory: vi.fn(async () => {
        order.push("repair");
        return { ok: true as const, result: {
          sessionId: "session-1",
          outcome: "repaired" as const,
          repairedRecords: 3,
          duplicateBoundaries: 1,
          backupCreated: true,
        } };
      }),
    };
    const result = await executeProviderHistoryRepair(api, session("running"));
    expect(order).toEqual(["terminate", "repair"]);
    expect(result.success).toContain("3 records");
  });

  it("repairs and then retries the same conversation from one row action", async () => {
    const order: string[] = [];
    const api = {
      sessionTerminate: vi.fn(async () => {
        order.push("terminate");
        return { ok: true as const, result: { sessionId: "session-1", lifecycleState: "exited" as const } };
      }),
      sessionRepairProviderHistory: vi.fn(async () => {
        order.push("repair");
        return { ok: true as const, result: {
          sessionId: "session-1",
          outcome: "repaired" as const,
          repairedRecords: 3,
          duplicateBoundaries: 1,
          backupCreated: true,
        } };
      }),
      sessionPreviewResumeAgent: vi.fn(async () => {
        order.push("preview");
        return {
          launch_ticket: "resume-ticket",
          manifest: { digest: "sha256:test" },
        } as AgentLaunchPreviewResult;
      }),
      sessionResumeAgent: vi.fn(async () => {
        order.push("resume");
        return {} as SessionDto;
      }),
    };

    const result = await fixProviderHistoryAndRetry(api, session("resumeFailed"));

    expect(order).toEqual(["terminate", "repair", "preview", "resume"]);
    expect(result.failure).toBeUndefined();
  });

  it("does not mutate history when termination is refused", async () => {
    const repair = vi.fn();
    const result = await executeProviderHistoryRepair({
      sessionTerminate: vi.fn(async () => ({ ok: false as const, code: "conflict" as const, details: undefined, message: "still running" })),
      sessionRepairProviderHistory: repair,
    }, session("resumeFailed"));
    expect(repair).not.toHaveBeenCalled();
    expect(result.failure).toBe("still running");
  });

  it("skips termination for an already exited Session", async () => {
    const terminate = vi.fn();
    const result = await executeProviderHistoryRepair({
      sessionTerminate: terminate,
      sessionRepairProviderHistory: vi.fn(async () => ({ ok: true as const, result: {
        sessionId: "session-1",
        outcome: "alreadyHealthy" as const,
        repairedRecords: 0,
        duplicateBoundaries: 0,
        backupCreated: false,
      } })),
    }, session("exited"));
    expect(terminate).not.toHaveBeenCalled();
    expect(result.success).toContain("healthy");
  });
});
