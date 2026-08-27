import type { ConnectionSourceSummary } from "../../connection-profile-types.js";

type Listener = (summary: ConnectionSourceSummary) => void;

export function onConnectionStatus(listener: Listener): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = event.data as {
      source?: string;
      type?: string;
      payload?: Partial<ConnectionSourceSummary>;
    };
    const payload = message.payload;
    if (message.source !== "termloop"
      || message.type !== "connection-status"
      || !payload
      || typeof payload.id !== "string"
      || typeof payload.name !== "string"
      || !(payload.state === "connecting" || payload.state === "connected" || payload.state === "offline")) {
      return;
    }
    listener(payload as ConnectionSourceSummary);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
