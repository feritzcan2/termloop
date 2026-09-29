import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { KIND_ACK, KIND_GAP, KIND_OUTPUT, KIND_REPLAY_OUTPUT } from "@termloop/terminal-wire";
import { TerminalPool, type TerminalAttachmentLike } from "../src/renderer/terminal/pool.js";
import type { AttachmentEvent } from "../src/renderer/terminal/attachment.js";

describe("reconnect scrollback", () => {
  it("keeps old history and the active screen when replay no longer overlaps", async () => {
    const terminal = new Terminal({ rows: 3, cols: 40, scrollback: 100, allowProposedApi: true });
    let event!: (event: AttachmentEvent) => void;
    const attachment: TerminalAttachmentLike = {
      onEvent: (listener) => { event = listener; return () => {}; }, input: () => true,
      resize() {}, focus() {}, acknowledge() {}, dispose() {},
    };
    const pool = new TerminalPool((_input, resize) => ({
      mount: () => resize(3, 40), unmount() {}, focus() {}, writeln() {}, probe: () => undefined,
      write: (bytes, done) => terminal.write(bytes, done), dispose: () => terminal.dispose(),
    }), async () => attachment, false, () => {}, { retain: () => true, canAttach: () => true, connectionScope: () => "local" });
    pool.reconcile([{ id: "s", runtime_epoch: 1, lifecycle_state: "running" }]);
    await pool.mount("s", {} as HTMLElement);
    const output = (kind: number, text: string) => event({ type: "frame", kind, data: new TextEncoder().encode(text).buffer });
    const text = () => Array.from({ length: terminal.buffer.normal.length }, (_, i) => terminal.buffer.normal.getLine(i)?.translateToString(true)).join("\n");
    output(KIND_OUTPUT, "HISTORY\r\nOLD SCREEN\r\nOLD TAIL");
    await vi.waitFor(() => expect(text()).toContain("OLD TAIL"));
    event({ type: "state", state: "connectionLost" });
    const replay = new TextEncoder().encode("NEW REPLAY");
    const ack = new Uint8Array(12);
    ack.set(new TextEncoder().encode("TLRA"));
    new DataView(ack.buffer).setUint32(4, 2);
    new DataView(ack.buffer).setUint32(8, replay.length);
    event({ type: "frame", kind: KIND_ACK, data: ack.buffer as ArrayBuffer });
    event({ type: "frame", kind: KIND_GAP, data: new ArrayBuffer(0) });
    event({ type: "frame", kind: KIND_REPLAY_OUTPUT, data: replay.buffer });
    await vi.waitFor(() => expect(text()).toContain("NEW REPLAY"));
    expect(text()).toContain("HISTORY\nOLD SCREEN\nOLD TAIL\nNEW REPLAY");
    expect(pool.presentationPort.snapshot("s")?.phase).toBe("live");
    terminal.scrollToTop();
    expect(terminal.buffer.normal.viewportY).toBe(0);
    pool.dispose();
  });
});
