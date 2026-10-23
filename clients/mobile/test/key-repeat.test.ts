import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createKeyRepeat, KEY_REPEAT_DELAY_MS, KEY_REPEAT_INTERVAL_MS } from "../src/features/terminal/key-repeat";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("sends at once, waits, then repeats until released", () => {
  const repeat = createKeyRepeat();
  const send = vi.fn();
  repeat.start(send);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(KEY_REPEAT_DELAY_MS - 1);
  expect(send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1 + 2 * KEY_REPEAT_INTERVAL_MS);
  expect(send).toHaveBeenCalledTimes(4);
  repeat.stop();
  vi.advanceTimersByTime(10 * KEY_REPEAT_INTERVAL_MS);
  expect(send).toHaveBeenCalledTimes(4);
});

it("lets a press that already waited out a long-press repeat at the interval", () => {
  const repeat = createKeyRepeat();
  const send = vi.fn();
  repeat.start(send, KEY_REPEAT_INTERVAL_MS);
  vi.advanceTimersByTime(KEY_REPEAT_INTERVAL_MS);
  expect(send).toHaveBeenCalledTimes(2);
  repeat.stop();
});

it("never sends one more after release, even from a callback already queued", () => {
  const callbacks: Array<() => void> = [];
  const repeat = createKeyRepeat({ setTimeout: (callback) => { callbacks.push(callback); return callbacks.length; }, clearTimeout: () => {} });
  const send = vi.fn();
  repeat.start(send);
  repeat.stop();
  callbacks[0]!();
  expect(send).toHaveBeenCalledTimes(1);
});

it("replaces the held key when another starts", () => {
  const repeat = createKeyRepeat();
  const first = vi.fn();
  const second = vi.fn();
  repeat.start(first);
  repeat.start(second);
  vi.advanceTimersByTime(KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(3);
  repeat.stop();
});
