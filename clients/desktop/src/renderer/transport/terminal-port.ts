import type { Session } from "../model.js";
import { desktopApi } from "./desktop-api.js";
import { connectionProfileIdOf } from "../../connection-scope.js";

const INITIAL_CREDIT_BYTES = 512 * 1024;
const PORT_TIMEOUT_MS = 5_000;
const MAX_INPUT_CHUNK_BYTES = 16 * 1024;
const MAX_QUEUED_INPUT_BYTES = 1024 * 1024;

export type AttachmentState = "connecting" | "connected" | "connectionLost" | "gatewayProcessLost";
export type AttachmentEvent =
  | { type: "frame"; kind: number; data: ArrayBuffer }
  | { type: "gap" }
  | { type: "inputRejected"; message: string }
  | { type: "resizeOwnership"; active: boolean }
  | { type: "state"; state: AttachmentState };

type PortIncoming = AttachmentEvent | { type: "inputCredit"; bytes: number };

type GatewayMessage =
  | AttachmentEvent
  | { type: "terminal-port"; requestId: string }
  | { type: "gateway-state"; profileId: string; state: AttachmentState };

type PendingPort = {
  resolve(port: MessagePort): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingPorts = new Map<string, PendingPort>();
const gatewayListeners = new Set<(profileId: string, state: AttachmentState) => void>();

window.addEventListener("message", (event: MessageEvent<GatewayMessage>) => {
  if (event.source !== window || !event.data || !("type" in event.data)) return;
  if (event.data.type === "terminal-port") {
    const pending = pendingPorts.get(event.data.requestId);
    const port = event.ports[0];
    if (!port) return;
    if (!pending) {
      port.close();
      return;
    }
    pendingPorts.delete(event.data.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(port);
  } else if (event.data.type === "gateway-state") {
    for (const listener of gatewayListeners) listener(event.data.profileId, event.data.state);
  }
});

export class TerminalAttachment {
  #listener: ((event: AttachmentEvent) => void) | undefined;
  #inputCredit = 0;
  #queuedInputBytes = 0;
  #inputQueue: ArrayBuffer[] = [];
  #outputCreditStarted = false;
  #pendingEvents: AttachmentEvent[] = [];

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event: MessageEvent<PortIncoming>) => {
      if (event.data.type === "inputCredit") {
        this.#inputCredit += Math.max(0, event.data.bytes);
        this.#flushInput();
      } else if (this.#listener) {
        this.#listener(event.data);
      } else {
        if (this.#pendingEvents.length === 16) this.#pendingEvents.shift();
        this.#pendingEvents.push(event.data);
      }
    };
    port.start();
  }

  onEvent(listener: (event: AttachmentEvent) => void): () => void {
    this.#listener = listener;
    for (const event of this.#pendingEvents.splice(0)) listener(event);
    if (!this.#outputCreditStarted) {
      this.#outputCreditStarted = true;
      this.port.postMessage({ type: "credit", bytes: INITIAL_CREDIT_BYTES });
    }
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  input(data: string | Uint8Array): boolean {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (this.#queuedInputBytes + bytes.byteLength > MAX_QUEUED_INPUT_BYTES) {
      this.#listener?.({ type: "inputRejected", message: "input paste exceeded the 1 MiB client queue" });
      return false;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_CHUNK_BYTES) {
      const chunk = bytes.slice(offset, offset + MAX_INPUT_CHUNK_BYTES).buffer;
      this.#inputQueue.push(chunk);
      this.#queuedInputBytes += chunk.byteLength;
    }
    this.#flushInput();
    return true;
  }

  resize(rows: number, cols: number): void {
    this.port.postMessage({ type: "resize", rows, cols });
  }

  focus(): void {
    this.port.postMessage({ type: "focus" });
  }

  acknowledge(bytes: number, startupReplay: boolean): void {
    if (bytes > 0) this.port.postMessage({ type: "credit", bytes, startupReplay });
  }

  dispose(): void {
    this.port.postMessage({ type: "detach" });
    this.port.close();
    this.#listener = undefined;
    this.#pendingEvents = [];
    this.#inputQueue = [];
    this.#queuedInputBytes = 0;
  }

  #flushInput(): void {
    while (this.#inputQueue.length > 0) {
      const chunk = this.#inputQueue[0]!;
      if (this.#inputCredit < chunk.byteLength) return;
      this.#inputQueue.shift();
      this.#queuedInputBytes -= chunk.byteLength;
      this.#inputCredit -= chunk.byteLength;
      this.port.postMessage({ type: "input", data: chunk });
    }
  }
}

export async function attachTerminal(session: Session): Promise<TerminalAttachment> {
  const requestId = crypto.randomUUID();
  const portPromise = new Promise<MessagePort>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPorts.delete(requestId);
      reject(new Error("terminal attachment timed out"));
    }, PORT_TIMEOUT_MS);
    pendingPorts.set(requestId, { resolve, reject, timeout });
  });
  try {
    await desktopApi.source(connectionProfileIdOf(session)).terminalAttach(
      requestId,
      session.id,
      session.runtime_epoch,
    );
  } catch (error) {
    const pending = pendingPorts.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingPorts.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    throw error;
  }
  return new TerminalAttachment(await portPromise);
}

export function onGatewayState(
  listener: (profileId: string, state: AttachmentState) => void,
): () => void {
  gatewayListeners.add(listener);
  return () => gatewayListeners.delete(listener);
}
