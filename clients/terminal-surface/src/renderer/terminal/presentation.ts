export type TerminalPresentation = {
  phase: "connecting" | "replaying" | "live" | "reconnecting" | "exited" | "failed";
  progress?: number | undefined;
  notice?: string | undefined;
  input?: "sending" | "confirmed" | "uncertain" | undefined;
  reading?: string | undefined;
  unread?: boolean | undefined;
};
export type TerminalPresentationPort = {
  subscribe(listener: () => void): () => void;
  snapshot(sessionId: string): TerminalPresentation | undefined;
  read(sessionId: string, enabled: boolean): void;
  recover(sessionId: string): void;
};
