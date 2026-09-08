import { describe, expect, it, vi } from "vitest";
import { TerminalContinuityCache } from "../src/features/terminal/terminal-continuity";
import { projectTerminalOutput } from "../src/features/terminal/terminal-event-queue";
import { TerminalSessionState } from "../src/features/terminal/terminal-session-state";
import { TerminalScreenProjection } from "../src/presentation/terminal-screen";

const encoder = new TextEncoder();
const encode = (text: string) => encoder.encode(text);

describe("cached terminal state", () => {
  it("finishes received output after leaving and resumes from that checkpoint", async () => {
    let finish: (() => void) | undefined;
    let slow = false;
    const state = new TerminalSessionState("mac", "session", (projection, bytes, active) => {
      let clock = 0;
      return projectTerminalOutput(projection, bytes, active, () => clock += 4, async () => {
        if (slow) {
          slow = false;
          await new Promise<void>((resolve) => { finish = resolve; });
        }
      });
    });
    const cache = new TerminalContinuityCache();
    cache.put("session", state);
    const prefix = "\x1b[2J\x1b[HAlready visible\r\n";
    state.begin();
    state.push({ type: "replay", bytes: encode(prefix) });
    state.push({ type: "state", state: "connected" });
    state.push({ type: "ready" });
    await state.whenIdle();
    const visible = state.buffer.screen;
    const listener = vi.fn();
    const unsubscribe = state.subscribe(listener, vi.fn());
    slow = true;
    const addition = "Türkçe 😀\r\n".repeat(2000);
    state.push({ type: "live", bytes: encode(addition) });
    expect(finish).toBeDefined();
    unsubscribe();
    state.detach();
    const restored = cache.get("session")!;
    expect(restored.buffer.screen).toBe(visible);
    expect(restored.buffer.stream).toBe("detached");
    let settled = false;
    const pending = restored.whenIdle().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish!();
    await pending;
    expect(listener).not.toHaveBeenCalled();
    expect(restored.outputTail).toEqual(encode(prefix + addition));
    expect(restored.buffer.stream).toBe("detached");

    const completed = restored.buffer.screen;
    restored.begin();
    await restored.whenIdle();
    expect(restored.buffer.screen).toBe(completed);
    expect(restored.buffer.ready).toBe(false);
    restored.push({ type: "replay", bytes: encode(prefix + addition + "New output") });
    restored.push({ type: "state", state: "connected" });
    restored.push({ type: "ready" });
    await restored.whenIdle();
    expect(restored.outputTail).toEqual(encode(prefix + addition + "New output"));
    expect(restored.buffer.screen).toEqual(new TerminalScreenProjection().write(encode(prefix + addition + "New output"))?.lines);
    expect(restored.buffer).toMatchObject({ ready: true, stream: "live" });
    cache.clear();
  });

  it("retains the last visible frame while an unmatched replay is rebuilt", async () => {
    let finish: (() => void) | undefined;
    let hold = false;
    const state = new TerminalSessionState("mac", "session", async (...args) => {
      if (hold) await new Promise<void>((resolve) => { finish = resolve; });
      return projectTerminalOutput(...args);
    });
    state.begin();
    state.push({ type: "replay", bytes: encode("\x1b[2J\x1b[HOld screen") });
    await state.whenIdle();
    const visible = state.buffer.screen;
    state.detach();
    state.begin();
    await state.whenIdle();
    hold = true;
    state.push({ type: "replay", bytes: encode("\x1b[2J\x1b[HUnrelated new screen") });
    expect(state.buffer.screen).toBe(visible);
    finish!();
    await state.whenIdle();
    expect(state.buffer.screen).not.toBe(visible);
    expect(state.buffer.continuityNotice).toContain("could not be matched");
    state.dispose();
  });

  it("cancels unfinished parsing when its bounded cache entry is evicted", async () => {
    const cache = new TerminalContinuityCache();
    let finish: (() => void) | undefined;
    const evicted = new TerminalSessionState("mac", "old", async (...args) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return projectTerminalOutput(...args);
    });
    cache.put("old", evicted);
    evicted.push({ type: "replay", bytes: encode("must not reappear") });
    const listener = vi.fn();
    evicted.subscribe(listener, vi.fn());
    for (let index = 0; index < 8; index++) cache.put(String(index), new TerminalSessionState("mac", String(index)));
    expect(cache.get("old")).toBeUndefined();
    await evicted.whenIdle();
    finish!();
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(evicted.outputTail).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
    cache.clear();
  });

  it("keeps a valid frame after parser failure and requires a full replay", async () => {
    let fail = false;
    const state = new TerminalSessionState("mac", "session", async (...args) => {
      if (fail) throw new Error("parser interrupted");
      return projectTerminalOutput(...args);
    });
    const onFailure = vi.fn();
    state.subscribe(vi.fn(), onFailure);
    state.begin();
    state.push({ type: "replay", bytes: encode("\x1b[2J\x1b[HKnown good screen") });
    await state.whenIdle();
    const visible = state.buffer.screen;
    fail = true;
    state.push({ type: "live", bytes: encode("discarded") });
    await state.whenIdle();
    expect(onFailure).toHaveBeenCalledOnce();
    state.detach();
    fail = false;
    state.begin();
    await state.whenIdle();
    expect(state.buffer.screen).toBe(visible);
    expect(state.outputTail).toHaveLength(0);
    state.push({ type: "replay", bytes: encode("\x1b[2J\x1b[HRecovered") });
    await state.whenIdle();
    expect(state.buffer.screen).toEqual(new TerminalScreenProjection().write(encode("\x1b[2J\x1b[HRecovered"))?.lines);
    state.dispose();
  });
});
