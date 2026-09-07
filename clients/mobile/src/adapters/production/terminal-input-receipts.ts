// A receipt proves a PTY write, never provider execution. Unknown outcomes are
// rejected without replaying input, including when a connection is replaced.
export class TerminalInputReceipts {
  private readonly pending = new Map<bigint, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  assertCapacity(frames: number): void {
    if (this.pending.size + frames > 128) throw new Error("Too much input is awaiting delivery.");
  }
  expect(sequence: bigint): Promise<void> {
    this.assertCapacity(1);
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sequence);
        reject(new Error("Delivery unconfirmed. Check the terminal before sending again."));
      }, 7_000);
      this.pending.set(sequence, { resolve, reject, timer });
    });
    void result.catch(() => {});
    return result;
  }
  accept(sequence: bigint): void {
    for (const [key, value] of this.pending) {
      if (key > sequence) continue;
      clearTimeout(value.timer);
      this.pending.delete(key);
      value.resolve();
    }
  }
  clear(): void {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("Delivery unconfirmed. Check the terminal before sending again."));
    }
    this.pending.clear();
  }
}
