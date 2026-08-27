import { describe, expect, it } from "vitest";
import { defaultAgentPermission, permissionLabel, readLastQuickActionAgentSelection, readQuickActionMemory, readTaskAgentPreset, rememberQuickActionAttachment, rememberQuickActionDraft, rememberQuickActionRun } from "../src/renderer/quick-action-memory.js";

function memoryStorage() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

describe("Quick Action launch memory", () => {
  it("keeps an unsent draft and clears it after a successful run", () => {
    const storage = memoryStorage();
    rememberQuickActionDraft("finish the pending refactor", storage);
    expect(readQuickActionMemory(storage).draft).toBe("finish the pending refactor");

    rememberQuickActionRun("project-1", "claude", { model: "fable", permission: "acceptEdits", reasoning: "high" }, storage);
    rememberQuickActionRun("project-1", "codex", { model: "gpt-5.6-sol", permission: "plan", reasoning: "xhigh" }, storage);

    const restored = readQuickActionMemory(storage);
    expect(restored.lastAgentId).toBe("codex");
    expect(restored.presets.claude).toEqual({ model: "fable", permission: "acceptEdits", reasoning: "high" });
    expect(restored.presets.codex).toEqual({ model: "gpt-5.6-sol", permission: "plan", reasoning: "xhigh" });
    expect(restored.draft).toBeUndefined();
  });

  it("clears a draft when the composer is emptied", () => {
    const storage = memoryStorage();
    rememberQuickActionDraft("temporary text", storage);
    rememberQuickActionDraft("", storage);
    expect(readQuickActionMemory(storage).draft).toBeUndefined();
  });

  it("keeps an unsent image handle and clears it after a successful run", () => {
    const storage = memoryStorage();
    rememberQuickActionAttachment({
      id: "58df9988-2939-4d63-a546-6ebbd0c15f16",
      mediaType: "image/png",
      byteLength: 128,
      sha256: `sha256:${"a".repeat(64)}`,
      width: 40,
      height: 30,
      previewDataUrl: "data:image/png;base64,cHJldmlldw==",
    }, storage);
    expect(readQuickActionMemory(storage).draftAttachment?.width).toBe(40);

    rememberQuickActionRun("project-1", "codex", { model: "default", permission: "default", reasoning: "default" }, storage);
    expect(readQuickActionMemory(storage).draftAttachment).toBeUndefined();
  });

  it("retains only bounded provider-shaped presets and leaves catalog validation to launch", () => {
    const storage = {
      getItem: () => JSON.stringify({
        lastAgentId: "claude",
        presets: { claude: { model: "gpt-5.6-sol", permission: "default", reasoning: "default" } },
      }),
    };
    expect(readQuickActionMemory(storage).presets.claude?.model).toBe("gpt-5.6-sol");
    const invalid = {
      getItem: () => JSON.stringify({
        lastAgentId: "../../provider",
        presets: { "../../provider": { model: "default", permission: "default", reasoning: "default" } },
      }),
    };
    expect(readQuickActionMemory(invalid).lastAgentId).toBeUndefined();
    expect(readQuickActionMemory(invalid).presets).toEqual({});
  });

  it("remembers a catalog-discovered provider without teaching storage its model list", () => {
    const storage = memoryStorage();
    rememberQuickActionRun("project-1", "gemini", {
      model: "flash",
      permission: "plan",
      reasoning: "default",
    }, storage);
    expect(readQuickActionMemory(storage).presets.gemini).toEqual({
      model: "flash",
      permission: "plan",
      reasoning: "default",
    });
  });

  it("uses provider defaults for a first Task worktree Agent launch", () => {
    const storage = memoryStorage();

    // Claude's own default asks before every edit and TermLoop reapplies the
    // recorded selection on every resume, so an unconfigured Claude opens in
    // auto instead of reverting to manual permission after each restart.
    expect(readTaskAgentPreset("claude", storage)).toEqual({
      model: "default",
      permission: "acceptEdits",
      reasoning: "default",
    });
    expect(readTaskAgentPreset("codex", storage)).toEqual({
      model: "default",
      permission: "default",
      reasoning: "default",
    });
    expect(readLastQuickActionAgentSelection(storage)).toEqual({
      agentId: "claude",
      model: "default",
      permission: "acceptEdits",
      reasoning: "default",
    });
  });

  it("labels Claude's permission modes the way the provider names them", () => {
    expect(defaultAgentPermission("claude")).toBe("acceptEdits");
    expect(defaultAgentPermission("codex")).toBe("default");
    expect(permissionLabel("claude", "acceptEdits")).toBe("auto");
    expect(permissionLabel("claude", "default")).toBe("manual");
    expect(permissionLabel("claude", "bypassPermissions")).toBe("bypass");
    expect(permissionLabel("claude", "plan")).toBe("plan");
    expect(permissionLabel("codex", "default")).toBe("default");
    expect(permissionLabel("codex", "acceptEdits")).toBe("auto");
  });

  it("reuses the saved Quick Action options for later Task worktree launches", () => {
    const storage = memoryStorage();
    rememberQuickActionRun("project-1", "codex", {
      model: "gpt-5.6-sol",
      permission: "acceptEdits",
      reasoning: "high",
    }, storage);

    expect(readTaskAgentPreset("codex", storage)).toEqual({
      model: "gpt-5.6-sol",
      permission: "acceptEdits",
      reasoning: "high",
    });
    expect(readLastQuickActionAgentSelection(storage)).toEqual({
      agentId: "codex",
      model: "gpt-5.6-sol",
      permission: "acceptEdits",
      reasoning: "high",
    });
  });
});
