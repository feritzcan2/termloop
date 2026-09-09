import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileOverview, TerminalAttachment, TerminalEvent } from "../src/application/ports";
import { submitChangeReview } from "../src/features/changes/submit-change-review";
import { fixtureSessions, fixtureTasks } from "../src/fixtures/mobile-overview";
import { MAX_REVIEW_MESSAGE_BYTES } from "../src/presentation/change-review-notes";

afterEach(() => vi.useRealTimers());

describe("mobile batch feedback delivery", () => {
  it("revalidates the exact Task Agent and epoch, then pastes one batch and enters once", async () => {
    const h = harness();
    await h.send();
    expect(h.runtime.control.loadOverview.mock.calls).toEqual([["mac-a"], ["mac-a"]]);
    expect(h.runtime.terminal.attach).toHaveBeenCalledWith("mac-a", h.target, expect.any(Function), { signal: h.controller.signal });
    expect(h.input.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual(["\u001b[200~First\nSecond\u001b[201~", "\r"]);
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it.each(["removed", "restarted", "moved"])("sends no bytes if the selected Agent is %s while attaching", async (change) => {
    const h = harness();
    const changed = change === "removed" ? { ...h.overview, sessions: [] }
      : change === "restarted" ? { ...h.overview, sessions: [{ ...h.target, runtime_epoch: h.target.runtime_epoch + 1 }] }
      : { ...h.overview, tasks: [{ ...fixtureTasks[0]!, worktree_presence: { ...fixtureTasks[0]!.worktree_presence!, attached_sessions: [] } }] };
    h.runtime.control.loadOverview.mockResolvedValueOnce(h.overview).mockResolvedValueOnce(changed);
    await expect(h.send()).rejects.toThrow("selected agent changed");
    expect(h.input).not.toHaveBeenCalled();
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it("does not send Enter or retry a paste when its receipt fails", async () => {
    const h = harness();
    h.input.mockRejectedValueOnce(new Error("receipt missing"));
    await expect(h.send()).rejects.toThrow("receipt missing");
    expect(h.input).toHaveBeenCalledOnce();
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it("does not retry Enter and still detaches when submission fails", async () => {
    const h = harness();
    h.input.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("uncertain Enter"));
    await expect(h.send()).rejects.toThrow("uncertain Enter");
    expect(h.input).toHaveBeenCalledTimes(2);
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it("cancels between paste and Enter without resending", async () => {
    const h = harness();
    h.input.mockImplementationOnce(async () => { h.controller.abort(); });
    await expect(h.send()).rejects.toThrow("interrupted");
    expect(h.input).toHaveBeenCalledOnce();
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it("waits for readiness and refuses a reconnect during validation", async () => {
    const h = harness(false);
    const pending = h.send();
    await vi.waitFor(() => expect(h.runtime.terminal.attach).toHaveBeenCalledOnce());
    expect(h.input).not.toHaveBeenCalled();
    h.emit({ type: "ready" });
    h.emit({ type: "state", state: "connecting" });
    await expect(pending).rejects.toThrow("interrupted");
    expect(h.input).not.toHaveBeenCalled();
  });

  it("times out without writing when replay never becomes ready", async () => {
    vi.useFakeTimers();
    const h = harness(false);
    const pending = expect(h.send()).rejects.toThrow("not ready");
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(h.input).not.toHaveBeenCalled();
    expect(h.detach).toHaveBeenCalledOnce();
  });

  it("keeps a successful result even if detach fails", async () => {
    const h = harness();
    h.detach.mockRejectedValueOnce(new Error("already disconnected"));
    await expect(h.send()).resolves.toBeUndefined();
  });

  it("rejects an oversized UTF-8 message before any I/O", async () => {
    const h = harness();
    await expect(h.send("🙂".repeat(MAX_REVIEW_MESSAGE_BYTES / 4 + 1))).rejects.toThrow("64 KiB");
    expect(h.runtime.control.loadOverview).not.toHaveBeenCalled();
    expect(h.runtime.terminal.attach).not.toHaveBeenCalled();
  });
});

function harness(ready = true) {
  const target = fixtureSessions[0]!;
  const overview: MobileOverview = {
    projects: [], tasks: fixtureTasks, sessions: [target], agentStatuses: [],
    stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: {},
  };
  const input = vi.fn<TerminalAttachment["input"]>().mockResolvedValue(undefined);
  const detach = vi.fn<TerminalAttachment["detach"]>().mockResolvedValue(undefined);
  let emit: (event: TerminalEvent) => void = () => {};
  const runtime = {
    control: { loadOverview: vi.fn().mockResolvedValue(overview), subscribeInvalidations: vi.fn(() => () => {}) },
    terminal: { attach: vi.fn(async (_connection: string, _target: unknown, onEvent: (event: TerminalEvent) => void) => {
      emit = onEvent;
      onEvent({ type: "state", state: "connecting" });
      onEvent({ type: "state", state: "connected" });
      if (ready) onEvent({ type: "ready" });
      return { input, detach, reconnect: vi.fn() };
    }) },
  };
  const controller = new AbortController();
  return { runtime, overview, input, detach, target, controller, emit: (event: TerminalEvent) => emit(event),
    send: (message = "First\nSecond") => submitChangeReview(runtime, "mac-a", fixtureTasks[0]!.id, target, message, controller.signal) };
}
