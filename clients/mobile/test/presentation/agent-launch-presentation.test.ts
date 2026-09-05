import { describe, expect, it } from "vitest";
import type { AgentCapabilityDto } from "@termloop/contract/current";

import {
  coerceModel,
  defaultLaunchSelection,
  firstAvailableAgent,
  launchAgentOptions,
  launchBlockedReason,
  restoreLaunchSelection,
  modelLabel,
  permissionLabel,
} from "../../src/presentation/agent-launch-presentation";

const CAPABILITIES: AgentCapabilityDto[] = [
  {
    agent_id: "claude", label: "Claude", available: false, version: null,
    integration_level: "launchOnly", degraded_reason: "cliUnavailable",
    models: ["default", "opus[1m]", "sonnet"], permissions: ["default", "acceptEdits"],
    reasoning: ["default", "high"], observation_supported: false,
    quick_action_supported: false, tracked_helpers_supported: false,
    resume_supported: false, native_fork_supported: false,
  },
  {
    agent_id: "codex", label: "Codex", available: true, version: "0.51.0",
    integration_level: "full", degraded_reason: null,
    models: ["default", "gpt-5.6-sol", "gpt-5.5-pro"],
    permissions: ["default", "plan"], reasoning: ["default", "high"],
    observation_supported: true, quick_action_supported: true,
    tracked_helpers_supported: true, resume_supported: true, native_fork_supported: true,
  },
  {
    agent_id: "gemini", label: "Gemini CLI", available: true, version: "0.39.1",
    integration_level: "launchOnly", degraded_reason: "observationUnavailable",
    models: ["default", "auto", "flash"],
    permissions: ["default", "acceptEdits", "plan", "bypassPermissions"], reasoning: ["default"],
    observation_supported: false, quick_action_supported: false,
    tracked_helpers_supported: false, resume_supported: false, native_fork_supported: false,
  },
];

describe("the launch choices a phone offers", () => {
  it("offers each provider its own models and nothing else", () => {
    const options = launchAgentOptions(CAPABILITIES);
    expect(options.find((option) => option.agentId === "claude")?.models).toContain("opus[1m]");
    expect(options.find((option) => option.agentId === "codex")?.models).toContain("gpt-5.6-sol");
    expect(options.find((option) => option.agentId === "gemini")?.models).toEqual(["default", "auto", "flash"]);
  });

  it("drops a model the newly chosen provider has never heard of", () => {
    expect(coerceModel("codex", "opus[1m]", CAPABILITIES)).toBe("default");
    expect(coerceModel("codex", "gpt-5.5-pro", CAPABILITIES)).toBe("gpt-5.5-pro");
    expect(coerceModel("gemini", "flash", CAPABILITIES)).toBe("flash");
  });

  it("starts from the provider's own defaults rather than a remembered guess", () => {
    expect(defaultLaunchSelection("claude"))
      .toEqual({ agentId: "claude", model: "default", permission: "default", reasoning: "default" });
  });

  it("states an unavailable provider instead of hiding it", () => {
    const options = launchAgentOptions(CAPABILITIES);
    expect(options.map((option) => option.agentId)).toEqual(["claude", "codex", "gemini"]);
    expect(options[0]?.available).toBe(false);
    expect(firstAvailableAgent(CAPABILITIES)).toBe("codex");
  });

  it("has no available provider to offer when the Mac reports none", () => {
    expect(firstAvailableAgent([])).toBeUndefined();
  });

  it("labels the defaults the way each provider's own client does", () => {
    expect(modelLabel("claude", "default")).toBe("Default (recommended)");
    expect(modelLabel("codex", "default")).toBe("Default");
    expect(modelLabel("claude", "sonnet")).toBe("sonnet");
    expect(permissionLabel("claude", "default")).toBe("auto");
    expect(permissionLabel("codex", "default")).toBe("default");
    expect(permissionLabel("claude", "bypassPermissions")).toBe("bypass");
  });
});

describe("saved launch choices", () => {
  it("restores supported choices for the same available provider", () => {
    expect(restoreLaunchSelection({
      agentId: "codex",
      model: "gpt-5.6-sol",
      permission: "plan",
      reasoning: "high",
    }, CAPABILITIES)).toEqual({
      agentId: "codex",
      model: "gpt-5.6-sol",
      permission: "plan",
      reasoning: "high",
    });
  });

  it("falls back safely when a saved choice is no longer offered", () => {
    expect(restoreLaunchSelection({
      agentId: "missing",
      model: "old-model",
      permission: "plan",
      reasoning: "max",
    }, CAPABILITIES)).toEqual(defaultLaunchSelection("codex"));
  });
});

describe("when a Task cannot host a launch", () => {
  const ready = {
    status: "open",
    worktree: { path: "/worktrees/task" },
    worktree_health: { launch_ready: true },
  };

  it("lets a launch-ready open Task through", () => {
    expect(launchBlockedReason(ready)).toBeUndefined();
  });

  it("refuses before reserving a ticket, and says which fact refused it", () => {
    expect(launchBlockedReason({ ...ready, status: "closed" })).toContain("closed");
    expect(launchBlockedReason({ ...ready, worktree: null })).toContain("no worktree");
    expect(launchBlockedReason({ ...ready, worktree_health: undefined })).toContain("not checked");
    expect(launchBlockedReason({ ...ready, worktree_health: { launch_ready: false } }))
      .toContain("cannot prove");
  });
});
