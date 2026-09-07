// Coalesce adjacent writes while retaining every byte and consumption callback.
// A barrier flushes immediately; a small interactive write waits at most 8 ms.
export class TerminalWriteBatcher {
  private chunks: { data: Uint8Array; done(): void }[] = [];
  private size = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly write: (bytes: Uint8Array, done: () => void) => void) {}
  push(data: Uint8Array, done: () => void): void {
    if (this.timer === undefined && this.size === 0) {
      this.write(data, done);
      this.timer = setTimeout(() => this.flush(), 8);
      return;
    }
    if (this.size + data.byteLength > 64 * 1024) this.flush();
    this.chunks.push({ data, done });
    this.size += data.byteLength;
    if (this.size >= 64 * 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 8);
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const chunks = this.chunks;
    if (!chunks.length) return;
    const bytes = new Uint8Array(this.size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk.data, offset); offset += chunk.data.byteLength; }
    this.chunks = [];
    this.size = 0;
    this.write(bytes, () => { for (const chunk of chunks) chunk.done(); });
  }
}
