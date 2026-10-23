export const KEY_REPEAT_DELAY_MS = 400;
/// Slower than a hardware keyboard's ~30 Hz on purpose: every repeat is one
/// WebSocket frame to the Mac, and a held arrow must not flood a Tailnet path.
export const KEY_REPEAT_INTERVAL_MS = 60;

export interface KeyRepeatTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: KeyRepeatTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/// Press-and-hold repetition for one accessory key at a time.
///
/// The first press sends immediately; holding past the delay repeats until release.
/// A generation counter makes a release authoritative even if a timer callback was
/// already queued, so a lifted finger never sends one more arrow.
export function createKeyRepeat(timers: KeyRepeatTimers = defaultTimers) {
  let generation = 0;
  let handle: unknown;

  const stop = () => {
    generation += 1;
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };

  return {
    /// `delay` is how long the first repeat waits. A press that already waited out a
    /// long-press can start repeating at the interval.
    start(send: () => void, delay: number = KEY_REPEAT_DELAY_MS) {
      stop();
      const current = generation;
      send();
      const tick = () => {
        if (current !== generation) return;
        send();
        handle = timers.setTimeout(tick, KEY_REPEAT_INTERVAL_MS);
      };
      handle = timers.setTimeout(tick, delay);
    },
    stop,
  };
}

export type KeyRepeat = ReturnType<typeof createKeyRepeat>;
