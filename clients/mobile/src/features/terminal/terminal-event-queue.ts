import type { TerminalEvent } from "../../application/ports";
import type { TerminalScreenProjection, TerminalScreenSnapshot } from "../../presentation/terminal-screen";

// Preserve terminal event order while large replays yield the JS thread. No
// output is silently dropped: exceeding the queue bound requires a fresh replay.
export class TerminalEventQueue {
  private events: TerminalEvent[] = [];
  private bytes = 0;
  private running = false;
  private disposed = false;
  private readonly idleListeners = new Set<() => void>();

  constructor(
    private readonly consume: (event: TerminalEvent) => Promise<void>,
    private readonly onFailure: () => void,
  ) {}

  push(event: TerminalEvent): void {
    if (this.disposed) return;
    this.bytes += event.type === "live" || event.type === "replay" ? event.bytes.byteLength : 0;
    if (this.bytes > 4 * 1024 * 1024 || this.events.length >= 4096) {
      this.dispose();
      this.onFailure();
      return;
    }
    this.events.push(event);
    if (!this.running) void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.events = [];
    this.bytes = 0;
    this.resolveIdle();
  }

  whenIdle(): Promise<void> {
    if (this.disposed || (!this.running && this.events.length === 0)) return Promise.resolve();
    return new Promise((resolve) => this.idleListeners.add(resolve));
  }

  private resolveIdle(): void {
    for (const listener of this.idleListeners) listener();
    this.idleListeners.clear();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (!this.disposed) {
        const event = this.events.shift();
        if (event === undefined) break;
        await this.consume(event);
        if (!this.disposed) this.bytes -= event.type === "live" || event.type === "replay" ? event.bytes.byteLength : 0;
      }
    } catch {
      if (!this.disposed) {
        this.dispose();
        this.onFailure();
      }
    } finally {
      this.running = false;
      this.resolveIdle();
    }
  }
}

export async function projectTerminalOutput(
  projection: Pick<TerminalScreenProjection, "write">,
  bytes: Uint8Array,
  active: () => boolean,
  now: () => number = () => performance.now(),
  yieldToUI: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<TerminalScreenSnapshot | undefined> {
  let started = now();
  for (let offset = 0; offset < bytes.byteLength; offset += 8192) {
    if (!active()) return undefined;
    const end = Math.min(bytes.byteLength, offset + 8192);
    const last = end === bytes.byteLength;
    const screen = projection.write(bytes.subarray(offset, end), last);
    if (last) return screen;
    if (now() - started >= 4) {
      await yieldToUI();
      started = now();
    }
  }
  return active() ? projection.write(bytes) : undefined;
}
