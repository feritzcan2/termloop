import { describe, expect, it, vi } from "vitest";

import { executeSessionRecovery } from "../src/features/session-actions/session-recovery";

describe("mobile Session recovery", () => {
  it("repairs damaged provider history before retrying the Agent", async () => {
    const calls: string[] = [];
    const actions = {
      repairProviderHistory: vi.fn(async () => { calls.push("repair"); }),
      retry: vi.fn(async () => {
        calls.push("retry");
        return {} as never;
      }),
    };

    await executeSessionRecovery(actions, "mac", "session", {
      kind: "repairAndRetry",
      label: "Fix",
      detail: "Repair provider history and retry this Agent",
    });

    expect(calls).toEqual(["repair", "retry"]);
  });

  it("retries an otherwise recoverable Agent without rewriting history", async () => {
    const actions = {
      repairProviderHistory: vi.fn(async () => {}),
      retry: vi.fn(async () => ({} as never)),
    };

    await executeSessionRecovery(actions, "mac", "session", {
      kind: "retry",
      label: "Retry",
      detail: "Restart this Agent in the same Session",
    });

    expect(actions.repairProviderHistory).not.toHaveBeenCalled();
    expect(actions.retry).toHaveBeenCalledWith("mac", "session");
  });

  it("shares one in-flight recovery across repeated taps", async () => {
    let finish: (() => void) | undefined;
    const actions = {
      repairProviderHistory: vi.fn(async () => {}),
      retry: vi.fn(() => new Promise<never>((resolve) => {
        finish = () => resolve(undefined as never);
      })),
    };
    const recovery = {
      kind: "retry" as const,
      label: "Retry" as const,
      detail: "Restart this Agent in the same Session",
    };

    const first = executeSessionRecovery(actions, "mac", "session", recovery);
    const second = executeSessionRecovery(actions, "mac", "session", recovery);
    expect(second).toBe(first);
    expect(actions.retry).toHaveBeenCalledOnce();

    finish?.();
    await first;
  });
});
