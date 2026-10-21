import { parseUpdateStatus, type UpdateStatus } from "../../update-status.js";

export function onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = event.data as { source?: string; type?: string; payload?: unknown };
    if (message.source !== "termloop" || message.type !== "update-status") return;
    const status = parseUpdateStatus(message.payload);
    if (status) listener(status);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
