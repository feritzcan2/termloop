import type { TerminalPresentationPort as SurfacePresentationPort } from "@termloop/terminal-surface/presentation";
import type { SessionConversationReadResult } from "@termloop/contract/current";
export type { TerminalPresentation } from "@termloop/terminal-surface/presentation";

export type TerminalPresentationPort = SurfacePresentationPort & {
  reconnect?(sessionId: string): Promise<void>;
  conversation?: ConversationPort;
};

/// One in-process subagent of an Agent Session, named by its opaque roster key.
export type ConversationSubagent = { key: string; label: string };

export type ConversationState = {
  loading: boolean;
  /// Present while the view shows a subagent's own transcript instead of the
  /// Session's saved messages. That view follows the live transcript.
  subagent?: ConversationSubagent | undefined;
  page?: SessionConversationReadResult | undefined;
  error?: string | undefined;
  hasNewer: boolean;
};

export type ConversationPort = {
  supported(sessionId: string): boolean;
  subscribe(listener: () => void): () => void;
  snapshot(sessionId: string): ConversationState | undefined;
  open(sessionId: string, subagent?: ConversationSubagent): void;
  close(sessionId: string): void;
  older(sessionId: string): void;
  newer(sessionId: string): void;
  retry(sessionId: string): void;
};
