import { describe, expect, it } from "vitest";
import { defaultAgentPermission, permissionLabel, readLastQuickActionAgentSelection, readQuickActionDraft, readQuickActionMemory, readTaskAgentPreset, rememberQuickActionAttachments, rememberQuickActionDraft, rememberQuickActionRun } from "../src/renderer/quick-action-memory.js";

function memoryStorage() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
}

describe("Quick Action launch memory", () => {
  it("retains OpenCode thinking options when restoring a run", () => {
    const storage = memoryStorage();
    for (const reasoning of ["none", "thinking"] as const) {
      const preset = { model: "opencode-go/minimax-m3", permission: "default" as const, reasoning };
      rememberQuickActionRun("project-1", "opencode", preset, storage);
      expect(readQuickActionMemory(storage).presets.opencode).toEqual(preset);
    }
  });

  it("keeps an unsent draft per Project and clears only the launched Project's draft", () => {
    const storage = memoryStorage();
    rememberQuickActionDraft("project-1", "finish the pending refactor", storage);
    rememberQuickActionDraft("project-2", "review the release notes", storage);
    expect(readQuickActionDraft("project-1", storage).text).toBe("finish the pending refactor");
    expect(readQuickActionDraft("project-2", storage).text).toBe("review the release notes");
    expect(readQuickActionDraft("project-3", storage)).toEqual({});

    rememberQuickActionRun("project-1", "claude", { model: "fable", permission: "acceptEdits", reasoning: "high" }, storage);
    rememberQuickActionRun("project-1", "codex", { model: "gpt-5.6-sol", permission: "plan", reasoning: "xhigh" }, storage);

    const restored = readQuickActionMemory(storage);
    expect(restored.lastAgentId).toBe("codex");
    expect(restored.presets.claude).toEqual({ model: "fable", permission: "acceptEdits", reasoning: "high" });
    expect(restored.presets.codex).toEqual({ model: "gpt-5.6-sol", permission: "plan", reasoning: "xhigh" });
    expect(readQuickActionDraft("project-1", storage)).toEqual({});
    expect(readQuickActionDraft("project-2", storage).text).toBe("review the release notes");
  });

  it("clears a draft when the composer is emptied", () => {
    const storage = memoryStorage();
    rememberQuickActionDraft("project-1", "temporary text", storage);
    rememberQuickActionDraft("project-1", "", storage);
    expect(readQuickActionDraft("project-1", storage)).toEqual({});
    expect(readQuickActionMemory(storage).drafts).toBeUndefined();
  });

  it("keeps unsent image ids per Project and clears them after that Project runs", () => {
    const storage = memoryStorage();
    const first = "58df9988-2939-4d63-a546-6ebbd0c15f16";
    const second = "68df9988-2939-4d63-a546-6ebbd0c15f16";
    rememberQuickActionAttachments("project-1", [first, second, first, "not-an-id"], storage);
    rememberQuickActionAttachments("project-2", [second], storage);
    rememberQuickActionDraft("project-1", "inspect these", storage);
    expect(readQuickActionDraft("project-1", storage)).toEqual({ text: "inspect these", attachmentIds: [first, second] });

    rememberQuickActionRun("project-1", "codex", { model: "default", permission: "default", reasoning: "default" }, storage);
    expect(readQuickActionDraft("project-1", storage)).toEqual({});
    expect(readQuickActionDraft("project-2", storage).attachmentIds).toEqual([second]);
  });

  it("gives an older single draft to the Project that last ran", () => {
    const id = "58df9988-2939-4d63-a546-6ebbd0c15f16";
    const storage = { getItem: () => JSON.stringify({ projectId: "project-1", draft: "old text", draftAttachmentIds: [id] }) };
    expect(readQuickActionDraft("project-1", storage)).toEqual({ text: "old text", attachmentIds: [id] });
    expect(readQuickActionDraft("project-2", storage)).toEqual({});
  });

  it("lets the first Project that opens claim an older draft saved without a Project", () => {
    const id = "58df9988-2939-4d63-a546-6ebbd0c15f16";
    let value: string | null = JSON.stringify({ draftAttachment: { id, previewDataUrl: "data:image/png;base64,AA==" }, draft: "old text" });
    const storage = { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
    expect(readQuickActionDraft("project-2", storage)).toEqual({ text: "old text", attachmentIds: [id] });

    rememberQuickActionDraft("project-2", "old text", storage);
    expect(readQuickActionDraft("project-2", storage)).toEqual({ text: "old text", attachmentIds: [id] });
    expect(readQuickActionDraft("project-3", storage)).toEqual({});
  });

  it("bounds saved image ids to the Quick Action limit", () => {
    const storage = memoryStorage();
    const ids = Array.from({ length: 10 }, (_, index) => `${index}8df9988-2939-4d63-a546-6ebbd0c15f16`);
    rememberQuickActionAttachments("project-1", ids, storage);
    expect(readQuickActionDraft("project-1", storage).attachmentIds).toEqual(ids.slice(0, 8));
  });

  it("bounds remembered drafts by dropping the longest-untouched Project", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 33; index += 1) rememberQuickActionDraft(`project-${index}`, `draft ${index}`, storage);
    rememberQuickActionDraft("project-1", "touched again", storage);
    rememberQuickActionDraft("project-33", "newest", storage);
    const drafts = readQuickActionMemory(storage).drafts ?? {};
    expect(Object.keys(drafts)).toHaveLength(32);
    expect(drafts["project-0"]).toBeUndefined();
    expect(drafts["project-2"]).toBeUndefined();
    expect(drafts["project-1"]?.text).toBe("touched again");
    expect(drafts["project-33"]?.text).toBe("newest");
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
