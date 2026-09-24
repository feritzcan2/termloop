export type AttachmentState = "connecting" | "connected" | "connectionLost" | "gatewayProcessLost";
export type AttachmentEvent =
  | { type: "inputDelivery"; state: "sending" | "confirmed" | "uncertain" }
  | { type: "frame"; kind: number; data: ArrayBuffer }
  | { type: "gap" }
  | { type: "inputRejected"; message: string }
  | { type: "resizeOwnership"; active: boolean }
  | { type: "state"; state: AttachmentState };
