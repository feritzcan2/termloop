import { describe, expect, it, vi } from "vitest";

import { executeSessionRecovery } from "../src/features/session-actions/session-recovery";

describe("mobile Session recovery", () => {
  it("repairs damaged provider history before retrying the Agent", async () => {
    const calls: string[] = [];
    const actions = {
      repairProviderHistory: vi.fn(async () => { calls.push("repair"); }),
      restart: vi.fn(async () => {
        calls.push("restart");
        return {} as never;
      }),
    };

    await executeSessionRecovery(actions, "mac", "session", {
      kind: "repairAndRetry",
      label: "Fix",
      detail: "Repair provider history and retry this Agent",
    });

    expect(calls).toEqual(["repair", "restart"]);
  });

  it("retries an otherwise recoverable Agent without rewriting history", async () => {
    const actions = {
      repairProviderHistory: vi.fn(async () => {}),
      restart: vi.fn(async () => ({} as never)),
    };

    await executeSessionRecovery(actions, "mac", "session", {
      kind: "retry",
      label: "Retry",
      detail: "Restart this Agent in the same Session",
    });

    expect(actions.repairProviderHistory).not.toHaveBeenCalled();
    expect(actions.restart).toHaveBeenCalledWith("mac", "session");
  });
});
