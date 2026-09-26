import type { TerminalPresentationPort as SurfacePresentationPort } from "@termloop/terminal-surface/presentation";
export type { TerminalPresentation } from "@termloop/terminal-surface/presentation";

export type TerminalPresentationPort = SurfacePresentationPort & {
  reconnect?(sessionId: string): Promise<void>;
};
