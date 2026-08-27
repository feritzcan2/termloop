export type TerminalRendererKind = "xterm" | "ghostty";

export function terminalRendererFor(
  platform: NodeJS.Platform,
  requested: string | undefined,
): TerminalRendererKind {
  if (platform !== "darwin") return "xterm";
  return requested === "xterm" ? "xterm" : "ghostty";
}

/// Ghostty is the macOS default; TERMLOOP_TERMINAL_RENDERER=xterm is the
/// explicit kill switch. Windows and Linux always use xterm. The effective
/// kind additionally requires the native addon to load, so callers retain
/// an automatic xterm fallback when the native layer is unavailable.
export function requestedTerminalRenderer(): TerminalRendererKind {
  return terminalRendererFor(process.platform, process.env.TERMLOOP_TERMINAL_RENDERER);
}
