import type { TerminalEvent } from "../../application/ports";

// Bound both latency and memory. Control/replay boundaries flush earlier bytes
// synchronously, so a disconnect or EOF cannot overtake accepted output.
export class TerminalOutputBatcher {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly emit: (event: TerminalEvent) => void) {}
  push(event: TerminalEvent): void {
    if (event.type !== "live") {
      this.flush();
      this.emit(event);
      return;
    }
    if (this.size + event.bytes.byteLength > 64 * 1024) this.flush();
    this.chunks.push(event.bytes);
    this.size += event.bytes.byteLength;
    if (this.size >= 64 * 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 16);
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.size === 0) return;
    const bytes = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.chunks = [];
    this.size = 0;
    this.emit({ type: "live", bytes });
  }
}
