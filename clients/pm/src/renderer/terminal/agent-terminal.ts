// Mounts one agent session's xterm surface on top of the `window.pm.terminal`
// bridge. Main owns the socket and token; this side only sees frame payloads.
// It follows the developer app's TerminalPool path: the surface is fitted
// before anything is written, the measured grid travels with the attach so
// the PTY is resized before replay, replay is staged and stitched onto the
// retained tail, and output is batched and credited back once xterm consumed it.
import { TerminalWriteBatcher } from "@termloop/terminal-surface/output-batcher";
import { TerminalReplayBuffer } from "@termloop/terminal-surface/replay-buffer";
import { TerminalOutputTail, continueReplay } from "@termloop/terminal-surface/replay-continuity";
import type { TerminalSurface } from "@termloop/terminal-surface/surface";
import { replayMouseModesSequence } from "@termloop/terminal-wire";
import type { PmApi } from "../../pm-api.js";

/** xterm opens at 80x24; its onResize reports every change after that. */
const OPENING_GRID = { rows: 24, cols: 80 };

export type SurfaceFactory = (onInput: (data: string) => void, onResize: (rows: number, cols: number) => void) => TerminalSurface;

export function mountAgentTerminal(
  terminal: PmApi["terminal"],
  host: HTMLElement,
  sessionId: string,
  createSurface: SurfaceFactory,
): () => void {
  const encoder = new TextEncoder();
  let disposed = false;
  let attachRequested = false;
  let grid = { ...OPENING_GRID };
  const surface = createSurface(
    (data) => terminal.input(sessionId, encoder.encode(data)),
    (rows, cols) => {
      grid = { rows, cols };
      if (attachRequested) terminal.resize(sessionId, rows, cols);
    },
  );
  const batcher = new TerminalWriteBatcher((bytes, done) => surface.write(bytes, done));
  const tail = new TerminalOutputTail();
  const write = (bytes: Uint8Array, done: () => void) => {
    tail.append(bytes);
    batcher.push(bytes, done);
  };
  const replay = new TerminalReplayBuffer((bytes, _complete, mouseModes) => {
    const continuation = continueReplay(tail.snapshot(), bytes);
    if (!continuation.continuous && bytes.length) {
      // Keep what is already on screen as history, then replay onto a clean
      // active screen (same sequence as the developer app's pool).
      tail.clear();
      batcher.push(encoder.encode("\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[!p\x1b[0m\x1b[r\x1b[9999;1H"
        + "\r\n".repeat(Math.max(1, Math.min(1024, grid.rows))) + "\x1b[H"), () => undefined);
    }
    if (continuation.bytes.length) write(continuation.bytes, () => undefined);
    // Restore the program's wheel protocol even when its startup modes fell
    // out of the replay ring; these bytes never enter the overlap tail.
    if (mouseModes !== undefined) batcher.push(replayMouseModesSequence(mouseModes), () => undefined);
  }, () => undefined);

  // Mount fits the surface synchronously, so `grid` is the real pane grid
  // before the attach below is sent.
  void surface.mount(host, true);
  const unsubscribe = terminal.onMessage((message) => {
    if (disposed || message.sessionId !== sessionId) return;
    switch (message.type) {
      case "attached":
        replay.begin(message.ack);
        break;
      case "output": {
        const bytes = message.data.byteLength;
        // Staged replay is bounded separately; credit it now so a replay
        // larger than the bridge window can complete.
        if (message.replay && replay.accept(message.data)) {
          terminal.credit(sessionId, bytes);
          break;
        }
        replay.flush();
        write(message.data, () => terminal.credit(sessionId, bytes));
        break;
      }
      case "gap":
        if (!replay.accept()) tail.clear();
        batcher.flush();
        surface.writeln("[some output was skipped]");
        break;
      case "eof":
        replay.accept();
        replay.flush();
        batcher.flush();
        surface.writeln("[agent exited]");
        break;
      case "error":
        batcher.flush();
        surface.writeln(`[terminal error: ${message.message}]`);
        break;
      case "state":
        batcher.flush();
        if (message.state !== "connected") replay.cancel();
        if (message.state === "connectionLost") surface.writeln("[reconnecting to the PM daemon…]");
        break;
    }
  });
  attachRequested = true;
  terminal.attach(sessionId, grid.rows, grid.cols).catch((error: unknown) => {
    if (!disposed) surface.writeln(`[could not attach: ${error instanceof Error ? error.message : String(error)}]`);
  });
  surface.focus();
  return () => {
    disposed = true;
    unsubscribe();
    replay.cancel();
    batcher.flush();
    terminal.detach(sessionId);
    surface.dispose();
  };
}
