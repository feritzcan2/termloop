import type { BrowserWindow } from "electron";

type ConsoleMessageSource = Pick<BrowserWindow["webContents"], "on">;

/// Renderer diagnostic prefixes relayed to the desktop log only in development
/// builds. They carry identifiers and counts, never Task or pull request text.
const DEVELOPMENT_RENDERER_DIAGNOSTIC_PREFIXES = ["[githost-diag] "] as const;

export function isDevelopmentRendererDiagnostic(message: unknown): message is string {
  return typeof message === "string"
    && DEVELOPMENT_RENDERER_DIAGNOSTIC_PREFIXES.some((prefix) => message.startsWith(prefix));
}

export function forwardDevelopmentRendererDiagnostics(
  contents: ConsoleMessageSource,
  isPackaged: boolean,
  write: (line: string) => void = (line) => console.info(line),
): void {
  if (isPackaged) return;
  contents.on("console-message", (details: { message?: unknown }) => {
    if (isDevelopmentRendererDiagnostic(details.message)) write(details.message);
  });
}
