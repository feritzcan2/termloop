import type { ProjectionInvalidatedPayload } from "@termloop/contract/current";

export type SourceProjectionInvalidation = {
  profileId: string;
  payload: ProjectionInvalidatedPayload;
};

type Listener = (event: SourceProjectionInvalidation) => void;

export function onProjectionInvalidated(listener: Listener): () => void {
  const handler = (event: MessageEvent) => {
    if (event.source !== window) return;
    const message = event.data as {
      source?: string;
      type?: string;
      payload?: SourceProjectionInvalidation;
    };
    if (
      message.source === "termloop"
      && message.type === "projection-invalidated"
      && typeof message.payload?.profileId === "string"
      && message.payload.payload
    ) {
      listener(message.payload);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
