// Mounts one agent session's xterm surface on top of the `window.pm.terminal`
// bridge. Main owns the socket and token; this side only sees frame payloads.
// Output is credited back after xterm consumed it so main can release more.
import { TerminalWriteBatcher } from "@termloop/terminal-surface/output-batcher";
import { XtermSurface } from "@termloop/terminal-surface/xterm";
import type { PmApi } from "../../pm-api.js";

const RESET = new TextEncoder().encode("\x1bc");

export function mountAgentTerminal(terminal: PmApi["terminal"], host: HTMLElement, sessionId: string): () => void {
  const encoder = new TextEncoder();
  let disposed = false;
  let attachedOnce = false;
  const surface = new XtermSurface(
    (data) => terminal.input(sessionId, encoder.encode(data)),
    (rows, cols) => terminal.resize(sessionId, rows, cols),
    () => undefined,
  );
  const batcher = new TerminalWriteBatcher((bytes, done) => surface.write(bytes, done));
  surface.mount(host, false);
  const unsubscribe = terminal.onMessage((message) => {
    if (disposed || message.sessionId !== sessionId) return;
    switch (message.type) {
      case "attached":
        // A re-attach replays the session from the start: clear first.
        if (attachedOnce) batcher.push(RESET, () => undefined);
        attachedOnce = true;
        break;
      case "output": {
        const bytes = message.data.byteLength;
        batcher.push(message.data, () => terminal.credit(sessionId, bytes));
        break;
      }
      case "gap":
        batcher.flush();
        surface.writeln("\r\n[some output was skipped]");
        break;
      case "eof":
        batcher.flush();
        surface.writeln("\r\n[agent exited]");
        break;
      case "error":
        batcher.flush();
        surface.writeln(`\r\n[terminal error: ${message.message}]`);
        break;
      case "state":
        if (message.state === "connectionLost") surface.writeln("\r\n[reconnecting to the PM daemon…]");
        break;
    }
  });
  terminal.attach(sessionId).catch((error: unknown) => {
    if (!disposed) surface.writeln(`\r\n[could not attach: ${error instanceof Error ? error.message : String(error)}]`);
  });
  surface.focus();
  return () => {
    disposed = true;
    unsubscribe();
    batcher.flush();
    terminal.detach(sessionId);
    surface.dispose();
  };
}
