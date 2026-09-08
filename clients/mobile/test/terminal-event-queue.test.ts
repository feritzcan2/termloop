import { describe, expect, it, vi } from "vitest";
import { projectTerminalOutput, TerminalEventQueue } from "../src/features/terminal/terminal-event-queue";
import { TerminalScreenProjection } from "../src/presentation/terminal-screen";

describe("cooperative terminal output", () => {
  it("yields between bounded parser slices and preserves UTF-8 and escape sequences", async () => {
    const bytes = new TextEncoder().encode("\x1b[?1049h\x1b[2J" + "\x1b[32mTürkçe 😀\x1b[0m\r\n".repeat(3000));
    const expected = new TerminalScreenProjection().write(bytes);
    let clock = 0;
    const yieldToUI = vi.fn(async () => {});
    const actual = await projectTerminalOutput(new TerminalScreenProjection(), bytes, () => true, () => clock++, yieldToUI);
    expect(actual).toEqual(expected);
    expect(yieldToUI).toHaveBeenCalled();
  });

  it("stops parsing a disposed route before the next slice", async () => {
    let active = true;
    let clock = 0;
    const write = vi.fn((_bytes: Uint8Array, _publish?: boolean) => undefined);
    await projectTerminalOutput({ write }, new Uint8Array(100_000), () => active, () => clock += 4, async () => { active = false; });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]?.byteLength).toBe(8192);
  });

  it("keeps ready, live output and EOF behind an unfinished replay", async () => {
    let finish: (() => void) | undefined;
    const seen: string[] = [];
    const failure = vi.fn();
    const queue = new TerminalEventQueue(async (event) => {
      if (event.type === "replay") await new Promise<void>((resolve) => { finish = resolve; });
      seen.push(event.type);
    }, failure);
    queue.push({ type: "replay", bytes: new Uint8Array(100) });
    queue.push({ type: "ready" });
    queue.push({ type: "live", bytes: new Uint8Array([1]) });
    queue.push({ type: "eof" });
    expect(seen).toEqual([]);
    finish!();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(seen).toEqual(["replay", "ready", "live", "eof"]);
    expect(failure).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("requires recovery when a stalled parser exceeds its output budget", async () => {
    const consume = vi.fn(async () => { await new Promise(() => {}); });
    const failure = vi.fn();
    const queue = new TerminalEventQueue(consume, failure);
    for (let i = 0; i < 6; i++) queue.push({ type: "live", bytes: new Uint8Array(1024 * 1024) });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("discards queued work when its route is disposed", async () => {
    let finish: (() => void) | undefined;
    const consume = vi.fn(async () => new Promise<void>((resolve) => { finish = resolve; }));
    const failure = vi.fn();
    const queue = new TerminalEventQueue(consume, failure);
    queue.push({ type: "ready" });
    queue.push({ type: "eof" });
    queue.dispose();
    finish!();
    await Promise.resolve();
    await Promise.resolve();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });
});
