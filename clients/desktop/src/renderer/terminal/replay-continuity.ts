const LIMIT = 1024 * 1024;

// Keep a bounded rolling suffix without copying the entire suffix per live write.
export class TerminalOutputTail {
  private ring = new Uint8Array(LIMIT);
  private size = 0;
  private offset = 0;
  append(bytes: Uint8Array): void {
    if (bytes.length >= LIMIT) {
      this.ring.set(bytes.subarray(bytes.length - LIMIT));
      this.size = LIMIT;
      this.offset = 0;
      return;
    }
    const first = Math.min(bytes.length, LIMIT - this.offset);
    this.ring.set(bytes.subarray(0, first), this.offset);
    this.ring.set(bytes.subarray(first), 0);
    this.offset = (this.offset + bytes.length) % LIMIT;
    this.size = Math.min(LIMIT, this.size + bytes.length);
  }
  clear(): void { this.size = 0; this.offset = 0; }
  snapshot(): Uint8Array {
    const result = new Uint8Array(this.size);
    const start = (this.offset - this.size + LIMIT) % LIMIT;
    const first = Math.min(this.size, LIMIT - start);
    result.set(this.ring.subarray(start, start + first));
    result.set(this.ring.subarray(0, this.size - first), first);
    return result;
  }
}

// Replay has no durable output offset. Match a complete retained boundary or a
// substantial suffix; on a missing boundary the caller must visibly reset.
export function continueReplay(previous: Uint8Array, replay: Uint8Array): { bytes: Uint8Array; continuous: boolean } {
  if (!previous.length) return { bytes: replay, continuous: true };
  if (!replay.length) return { bytes: replay, continuous: false };
  const prefix = new Uint32Array(replay.length);
  for (let i = 1, n = 0; i < replay.length; i++) {
    while (n && replay[i] !== replay[n]) n = prefix[n - 1]!;
    if (replay[i] === replay[n]) n++;
    prefix[i] = n;
  }
  let overlap = 0;
  for (let i = 0; i < previous.length; i++) {
    while (overlap && (overlap === replay.length || previous[i] !== replay[overlap])) overlap = prefix[overlap - 1]!;
    if (previous[i] === replay[overlap]) overlap++;
  }
  const continuous = overlap > 0 && (overlap === previous.length || overlap === replay.length || overlap >= 64);
  return { bytes: continuous ? replay.slice(overlap) : replay, continuous };
}
