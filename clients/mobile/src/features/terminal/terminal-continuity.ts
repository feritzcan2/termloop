import type { TerminalBuffer } from "@/presentation/terminal-buffer";
import type { TerminalScreenProjection } from "@/presentation/terminal-screen";

/// Matches the daemon's bounded recent-output ring. The cache is memory-only and
/// runtime-epoch scoped; it is continuity for a phone navigating away and back, not
/// durable terminal history.
export const TERMINAL_OUTPUT_TAIL_BYTES = 1024 * 1024;
const MAX_CACHED_TERMINALS = 8;
const MIN_PARTIAL_OVERLAP_BYTES = 64;

export interface TerminalContinuity {
  readonly buffer: TerminalBuffer;
  readonly projection: TerminalScreenProjection;
  readonly outputTail: Uint8Array;
}

export interface ReplayContinuation {
  readonly continuous: boolean;
  readonly bytes: Uint8Array;
}

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
  next.set(current.slice(current.byteLength - retained), 0);
  next.set(addition, retained);
  return next;
}

/// Finds the longest prefix of `replay` that is also a suffix of `previous` in
/// linear time. This is the exact relationship between two snapshots of the same
/// rolling daemon ring when bytes were appended and, optionally, evicted.
function replayOverlap(previous: Uint8Array, replay: Uint8Array): number {
  if (previous.byteLength === 0 || replay.byteLength === 0) return 0;
  const prefix = new Uint32Array(replay.byteLength);
  for (let index = 1, matched = 0; index < replay.byteLength; index += 1) {
    while (matched > 0 && replay[index] !== replay[matched]) matched = prefix[matched - 1] ?? 0;
    if (replay[index] === replay[matched]) matched += 1;
    prefix[index] = matched;
  }

  let matched = 0;
  for (const byte of previous) {
    while (matched > 0 && byte !== replay[matched]) matched = prefix[matched - 1] ?? 0;
    if (byte === replay[matched]) matched += 1;
    if (matched === replay.byteLength) {
      /// Keep a complete match only when it ends at the previous tail. Otherwise the
      /// next byte must continue from the pattern's longest proper prefix.
      matched = prefix[matched - 1] ?? 0;
    }
  }
  /// A replay identical to the previous tail is the common reconnect case. The loop
  /// above falls back after a complete match, so recover that exact boundary here.
  if (previous.byteLength >= replay.byteLength) {
    const start = previous.byteLength - replay.byteLength;
    let identicalSuffix = true;
    for (let index = 0; index < replay.byteLength; index += 1) {
      if (previous[start + index] !== replay[index]) {
        identicalSuffix = false;
        break;
      }
    }
    if (identicalSuffix) return replay.byteLength;
  }
  return matched;
}

/// Returns only bytes not already represented by the retained projection. A tiny
/// accidental suffix/prefix match is not enough evidence: in that case the caller
/// rebuilds from the complete replay rather than risking a stale screen.
export function continueTerminalReplay(
  previous: Uint8Array,
  replay: Uint8Array,
): ReplayContinuation {
  const overlap = replayOverlap(previous, replay);
  const completeBoundary = overlap === previous.byteLength || overlap === replay.byteLength;
  const continuous = overlap > 0
    && (completeBoundary || overlap >= MIN_PARTIAL_OVERLAP_BYTES);
  return continuous
    ? { continuous: true, bytes: replay.slice(overlap) }
    : { continuous: false, bytes: replay };
}

export class TerminalContinuityCache {
  readonly #entries = new Map<string, TerminalContinuity>();

  get(key: string): TerminalContinuity | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  put(key: string, value: TerminalContinuity): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > MAX_CACHED_TERMINALS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  clear(): void {
    this.#entries.clear();
  }
}

export const terminalContinuityCache = new TerminalContinuityCache();
