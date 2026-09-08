import type { TerminalSessionState } from "./terminal-session-state";

/// Matches the daemon's bounded recent-output ring. The cache is memory-only and
/// runtime-epoch scoped; it is continuity for a phone navigating away and back, not
/// durable terminal history.
export const TERMINAL_OUTPUT_TAIL_BYTES = 1024 * 1024;
const MAX_CACHED_TERMINALS = 8;
export { continueTerminalReplay, type ReplayContinuation } from "../../application/terminal-replay";

export function terminalContinuityKey(
  connectionId: string,
  sessionId: string,
  runtimeEpoch: number,
): string {
  return `${connectionId}\u0000${sessionId}\u0000${runtimeEpoch}`;
}

export function appendTerminalOutputTail(
  current: Uint8Array,
  addition: Uint8Array,
): Uint8Array {
  if (addition.byteLength >= TERMINAL_OUTPUT_TAIL_BYTES) {
    return addition.slice(addition.byteLength - TERMINAL_OUTPUT_TAIL_BYTES);
  }
  const retained = Math.min(
    current.byteLength,
    TERMINAL_OUTPUT_TAIL_BYTES - addition.byteLength,
  );
  const next = new Uint8Array(retained + addition.byteLength);
  next.set(current.subarray(current.byteLength - retained), 0);
  next.set(addition, retained);
  return next;
}


export class TerminalContinuityCache {
  readonly #entries = new Map<string, TerminalSessionState>();

  get(key: string): TerminalSessionState | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  put(key: string, value: TerminalSessionState): void {
    const previous = this.#entries.get(key);
    if (previous !== value) previous?.dispose();
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > MAX_CACHED_TERMINALS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  clear(): void {
    for (const entry of this.#entries.values()) entry.dispose();
    this.#entries.clear();
  }

  delete(key: string): void {
    this.#entries.get(key)?.dispose();
    this.#entries.delete(key);
  }
}

export const terminalContinuityCache = new TerminalContinuityCache();
