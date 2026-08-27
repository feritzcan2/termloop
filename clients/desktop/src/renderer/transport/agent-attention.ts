type Listener = (sessionId: string) => void;

export function onAgentAttentionActivated(listener: Listener): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = event.data as {
      source?: string;
      type?: string;
      payload?: { sessionId?: string };
    };
    if (
      message.source === "termloop"
      && message.type === "agent-attention-activated"
      && typeof message.payload?.sessionId === "string"
    ) {
      listener(message.payload.sessionId);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
