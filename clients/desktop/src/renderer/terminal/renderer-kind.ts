import { desktopApi } from "../transport/desktop-api.js";

export type TerminalRendererKind = "xterm" | "ghostty";

let kind: TerminalRendererKind = "xterm";

export async function initTerminalRendererKind(): Promise<void> {
  kind = await desktopApi.terminalRendererKind().catch(() => "xterm");
}

export function terminalRendererKind(): TerminalRendererKind {
  return kind;
}
