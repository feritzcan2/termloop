import type { TerminalPresentationPort as SurfacePresentationPort } from "@termloop/terminal-surface/presentation";
import type { SessionConversationReadResult } from "@termloop/contract/current";
export type { TerminalPresentation } from "@termloop/terminal-surface/presentation";

export type TerminalPresentationPort = SurfacePresentationPort & {
  reconnect?(sessionId: string): Promise<void>;
  conversation?: ConversationPort;
};

export type ConversationState = {
  loading: boolean;
  page?: SessionConversationReadResult | undefined;
  error?: string | undefined;
  hasNewer: boolean;
};

export type ConversationPort = {
  supported(sessionId: string): boolean;
  subscribe(listener: () => void): () => void;
  snapshot(sessionId: string): ConversationState | undefined;
  open(sessionId: string): void;
  close(sessionId: string): void;
  older(sessionId: string): void;
  newer(sessionId: string): void;
  retry(sessionId: string): void;
};
