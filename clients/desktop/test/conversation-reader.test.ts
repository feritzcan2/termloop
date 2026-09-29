import { describe, expect, it, vi } from "vitest";
import type { SessionConversationReadResult } from "@termloop/contract/current";
import { createConversationReader } from "../src/renderer/composition/conversation-reader.js";

const target = { id: "scoped-session", project_id: "scoped-project", runtime_epoch: 1, process: { agent_id: "codex" } };
const page = (text: string, next_before: number | null = null): SessionConversationReadResult => ({ status: "available", messages: [{ role: "assistant", text, truncated: false }], next_before, incomplete: false });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("saved conversation reader", () => {
  it("reads exact scoped sessions and navigates pages without accumulating message text", async () => {
    const read = vi.fn().mockResolvedValueOnce(page("newest", 500)).mockResolvedValueOnce(page("older", 100)).mockResolvedValueOnce(page("newest", 500));
    const cover = vi.fn();
    const reader = createConversationReader(() => target, read, cover);
    reader.open(target.id); await tick();
    expect(cover).toHaveBeenCalledWith(target.id, true);
    expect(read).toHaveBeenLastCalledWith(target.project_id, target.id, undefined);
    reader.older(target.id); reader.older(target.id); await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(target.project_id, target.id, 500);
    expect(reader.snapshot(target.id)).toMatchObject({ hasNewer: true, page: page("older", 100) });
    reader.newer(target.id); await tick();
    expect(read).toHaveBeenLastCalledWith(target.project_id, target.id, undefined);
    expect(reader.snapshot(target.id)?.page?.messages).toHaveLength(1);
    reader.close(target.id);
    expect(reader.snapshot(target.id)).toBeUndefined();
    expect(cover).toHaveBeenLastCalledWith(target.id, false);
  });

  it("ignores responses after close or reopen and rejects a changed runtime", async () => {
    let finish!: (value: SessionConversationReadResult) => void;
    let current = target;
    const read = vi.fn(() => new Promise<SessionConversationReadResult>((resolve) => { finish = resolve; }));
    const reader = createConversationReader(() => current, read, vi.fn());
    reader.open(target.id);
    const first = finish;
    reader.close(target.id);
    reader.open(target.id);
    first(page("stale")); await tick();
    expect(reader.snapshot(target.id)?.loading).toBe(true);
    current = { ...target, runtime_epoch: 2 };
    finish(page("wrong runtime")); await tick();
    expect(reader.snapshot(target.id)?.error).toContain("Session changed");
    expect(reader.snapshot(target.id)?.page).toBeUndefined();
  });

  it("handles unavailable providers and retries read failures", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValueOnce(page("Recovered"));
    const reader = createConversationReader((id) => id === "shell" ? { ...target, process: { agent_id: null } } : target, read, vi.fn());
    reader.open("shell"); expect(read).not.toHaveBeenCalled();
    reader.open(target.id); await tick();
    expect(reader.snapshot(target.id)?.error).toBe("Disconnected");
    reader.retry(target.id); await tick();
    expect(reader.snapshot(target.id)?.page).toEqual(page("Recovered"));
    expect(reader.snapshot(target.id)?.error).toBeUndefined();
  });
});
