export class InputReceiptLedger {
  private pending = new Map<bigint, { bytes: number; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly settled: (bytes: number, confirmed: boolean, waiting: boolean) => void) {}
  expect(sequence: bigint, bytes: number): void {
    const timer = setTimeout(() => {
      this.pending.delete(sequence);
      this.settled(bytes, false, this.pending.size > 0);
    }, 7_000);
    this.pending.set(sequence, { bytes, timer });
  }
  accept(sequence: bigint): void {
    let bytes = 0;
    for (const [key, pending] of this.pending) {
      if (key > sequence) continue;
      clearTimeout(pending.timer);
      bytes += pending.bytes;
      this.pending.delete(key);
    }
    if (bytes) this.settled(bytes, true, this.pending.size > 0);
  }
  clear(): void {
    let bytes = 0;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); bytes += pending.bytes; }
    this.pending.clear();
    if (bytes) this.settled(bytes, false, this.pending.size > 0);
  }
}
