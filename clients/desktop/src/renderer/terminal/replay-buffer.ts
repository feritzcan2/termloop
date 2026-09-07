import { decodeReplayAck } from "../../utility/terminal-frame.js";

export class TerminalReplayBuffer {
  private chunks: Uint8Array[] = [];
  private received = 0;
  private remaining: number | undefined;
  private total = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  constructor(private readonly complete: (bytes: Uint8Array, complete: boolean) => void, private readonly progress: (percent: number | undefined) => void) {}
  begin(payload: Uint8Array): void {
    this.cancel();
    const metadata = decodeReplayAck(payload);
    this.active = true;
    this.remaining = metadata?.frames;
    this.total = metadata?.bytes ?? 0;
    this.progress(this.total ? 0 : undefined);
    if (this.remaining === 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), metadata ? 5_000 : 1_000);
  }
  accept(bytes?: Uint8Array): boolean {
    if (!this.active) return false;
    if (bytes) {
      if (this.received + bytes.length > 1024 * 1024) { this.flush(); return false; }
      this.chunks.push(bytes);
      this.received += bytes.length;
    }
    if (this.remaining !== undefined) this.remaining--;
    this.progress(this.total ? Math.min(100, Math.floor(this.received * 100 / this.total)) : undefined);
    if (this.remaining === 0) this.flush();
    return true;
  }
  flush(): void {
    if (!this.active) return;
    const bytes = new Uint8Array(this.received);
    let offset = 0;
    for (const chunk of this.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const complete = this.remaining === undefined || (this.remaining === 0 && this.received === this.total);
    this.cancel();
    this.complete(bytes, complete);
  }
  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.active = false;
    this.chunks = [];
    this.received = 0;
    this.remaining = undefined;
  }
}
