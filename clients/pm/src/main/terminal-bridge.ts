// Relays PM agent terminals between the daemon's binary terminal plane and
// the renderer. The socket, the bearer, and the runtime epoch stay in main;
// the renderer names a session and receives binary output only.
import WebSocket, { type RawData } from "ws";
import {
  FRAME_MAGIC,
  KIND_ACK,
  KIND_ATTACH,
  KIND_DETACH,
  KIND_EOF,
  KIND_ERROR,
  KIND_GAP,
  KIND_INPUT,
  KIND_OUTPUT,
  KIND_REPLAY_OUTPUT,
  KIND_RESIZE,
  decodeFrame,
  encodeFrame,
  encodeResize,
  replayRequestPayload,
} from "@termloop/terminal-wire";
import type { PmTerminalMessage } from "../pm-api.js";

/** Output bytes the renderer may hold unconsumed before main queues. */
export const IN_FLIGHT_WINDOW_BYTES = 1024 * 1024;
/** Queued bytes per session before the oldest output is dropped as a gap. */
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const INITIAL_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 4_000;
const MAX_INPUT_BYTES = 64 * 1024;

type Output = Extract<PmTerminalMessage, { type: "output" }>;

type Attachment = {
  sessionId: string;
  sequence: bigint;
  dimensions: { rows: number; cols: number } | undefined;
  inFlight: number;
  queue: Output[];
  queuedBytes: number;
  gapPending: boolean;
};

export type TerminalSocket = Pick<WebSocket, "send" | "close" | "once" | "on" | "off" | "readyState"> & { binaryType: string };

export class TerminalBridge {
  readonly #attachments = new Map<string, Attachment>();
  #socket: TerminalSocket | undefined;
  #connecting = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectMs = INITIAL_RECONNECT_MS;
  #stopped = false;

  constructor(
    readonly terminalUrl: string,
    readonly token: string,
    readonly runtimeEpoch: number,
    readonly send: (message: PmTerminalMessage) => void,
    readonly socketFactory: (url: string) => TerminalSocket = (url) =>
      new WebSocket(url, { maxPayload: MAX_MESSAGE_BYTES }) as unknown as TerminalSocket,
  ) {}

  attach(sessionId: string): void {
    if (this.#stopped) return;
    if (this.#attachments.has(sessionId)) this.detach(sessionId);
    const attachment: Attachment = {
      sessionId,
      sequence: 1n,
      dimensions: undefined,
      inFlight: 0,
      queue: [],
      queuedBytes: 0,
      gapPending: false,
    };
    this.#attachments.set(sessionId, attachment);
    if (this.#isOpen()) this.#sendAttach(attachment);
    else this.#ensureConnected();
  }

  detach(sessionId: string): void {
    const attachment = this.#attachments.get(sessionId);
    if (!attachment) return;
    this.#attachments.delete(sessionId);
    if (this.#isOpen()) this.#sendFrame(attachment, KIND_DETACH);
  }

  input(sessionId: string, data: Uint8Array): void {
    const attachment = this.#attachments.get(sessionId);
    if (!attachment || data.byteLength === 0 || data.byteLength > MAX_INPUT_BYTES) return;
    if (!this.#isOpen()) {
      this.send({ sessionId, type: "error", message: "The terminal connection is unavailable; input was not sent." });
      return;
    }
    this.#sendFrame(attachment, KIND_INPUT, Uint8Array.from(data));
  }

  resize(sessionId: string, rows: number, cols: number): void {
    const attachment = this.#attachments.get(sessionId);
    if (!attachment || !validDimension(rows) || !validDimension(cols)) return;
    attachment.dimensions = { rows, cols };
    if (this.#isOpen()) this.#sendFrame(attachment, KIND_RESIZE, encodeResize(rows, cols));
  }

  credit(sessionId: string, bytes: number): void {
    const attachment = this.#attachments.get(sessionId);
    if (!attachment || !Number.isFinite(bytes) || bytes <= 0) return;
    attachment.inFlight = Math.max(0, attachment.inFlight - bytes);
    this.#flush(attachment);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    for (const sessionId of [...this.#attachments.keys()]) this.detach(sessionId);
    this.#socket?.close();
    this.#socket = undefined;
  }

  #isOpen(): boolean {
    return this.#socket !== undefined && this.#socket.readyState === WebSocket.OPEN;
  }

  #ensureConnected(): void {
    if (this.#stopped || this.#connecting || this.#isOpen() || this.#attachments.size === 0) return;
    this.#connecting = true;
    this.#broadcast("connecting");
    const socket = this.socketFactory(this.terminalUrl);
    socket.binaryType = "arraybuffer";
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.#connecting = false;
      socket.close();
      this.#broadcast("connectionLost");
      this.#scheduleReconnect();
    };
    const timeout = setTimeout(fail, AUTH_TIMEOUT_MS);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("open", () => {
      const token = new TextEncoder().encode(this.token);
      const auth = new Uint8Array(4 + token.byteLength);
      auth.set(new TextEncoder().encode(FRAME_MAGIC));
      auth.set(token, 4);
      socket.send(auth);
    });
    const authenticate = (raw: RawData, binary: boolean) => {
      const reply = new TextDecoder().decode(rawBytes(raw));
      if (!binary || reply !== "TLOK") {
        fail();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("message", authenticate);
      socket.off("error", fail);
      socket.off("close", fail);
      this.#connecting = false;
      if (this.#stopped) {
        socket.close();
        return;
      }
      this.#opened(socket);
    };
    socket.on("message", authenticate);
  }

  #opened(socket: TerminalSocket): void {
    this.#socket = socket;
    this.#reconnectMs = INITIAL_RECONNECT_MS;
    socket.on("message", (raw: RawData, binary: boolean) => {
      if (binary) this.#receive(rawBytes(raw));
      else socket.close();
    });
    const closed = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#broadcast("connectionLost");
      this.#scheduleReconnect();
    };
    socket.once("close", closed);
    socket.once("error", () => socket.close());
    this.#broadcast("connected");
    for (const attachment of this.#attachments.values()) this.#sendAttach(attachment);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer || this.#attachments.size === 0) return;
    const delay = this.#reconnectMs;
    this.#reconnectMs = Math.min(MAX_RECONNECT_MS, this.#reconnectMs * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#ensureConnected();
    }, delay);
  }

  #sendAttach(attachment: Attachment): void {
    // A fresh attach replays recent output; queued output of an earlier
    // attach is superseded by that replay.
    attachment.queue = [];
    attachment.queuedBytes = 0;
    attachment.inFlight = 0;
    attachment.gapPending = false;
    this.#sendFrame(attachment, KIND_ATTACH, replayRequestPayload());
    if (attachment.dimensions) {
      this.#sendFrame(attachment, KIND_RESIZE, encodeResize(attachment.dimensions.rows, attachment.dimensions.cols));
    }
  }

  #sendFrame(attachment: Attachment, kind: number, payload?: Uint8Array): void {
    this.#socket?.send(encodeFrame(attachment.sessionId, this.runtimeEpoch, attachment.sequence++, kind, payload));
  }

  #receive(bytes: Uint8Array): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    const attachment = this.#attachments.get(frame.sessionId);
    if (!attachment || frame.epoch !== this.runtimeEpoch) return;
    const sessionId = attachment.sessionId;
    switch (frame.kind) {
      case KIND_ACK:
        this.send({ sessionId, type: "attached" });
        return;
      case KIND_OUTPUT:
      case KIND_REPLAY_OUTPUT:
        this.#enqueue(attachment, { sessionId, type: "output", data: frame.payload, replay: frame.kind === KIND_REPLAY_OUTPUT });
        return;
      case KIND_GAP:
        attachment.gapPending = true;
        this.#flush(attachment);
        return;
      case KIND_EOF:
        this.#flush(attachment);
        this.send({ sessionId, type: "eof" });
        return;
      case KIND_ERROR:
        this.send({ sessionId, type: "error", message: new TextDecoder().decode(frame.payload).slice(0, 512) });
        return;
      default:
        // Resize ownership and input receipts carry nothing the PM renders.
        return;
    }
  }

  #enqueue(attachment: Attachment, output: Output): void {
    const bytes = output.data.byteLength;
    if (bytes > MAX_QUEUED_BYTES) {
      attachment.gapPending = true;
      this.#flush(attachment);
      return;
    }
    while (attachment.queuedBytes + bytes > MAX_QUEUED_BYTES && attachment.queue.length > 0) {
      attachment.queuedBytes -= attachment.queue.shift()!.data.byteLength;
      attachment.gapPending = true;
    }
    attachment.queue.push(output);
    attachment.queuedBytes += bytes;
    this.#flush(attachment);
  }

  #flush(attachment: Attachment): void {
    if (attachment.gapPending && attachment.inFlight < IN_FLIGHT_WINDOW_BYTES) {
      attachment.gapPending = false;
      this.send({ sessionId: attachment.sessionId, type: "gap" });
    }
    while (attachment.queue.length > 0 && attachment.inFlight < IN_FLIGHT_WINDOW_BYTES) {
      const output = attachment.queue.shift()!;
      attachment.queuedBytes -= output.data.byteLength;
      attachment.inFlight += output.data.byteLength;
      this.send(output);
    }
  }

  #broadcast(state: "connecting" | "connected" | "connectionLost"): void {
    for (const sessionId of this.#attachments.keys()) this.send({ sessionId, type: "state", state });
  }
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 1000;
}

function rawBytes(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(Buffer.concat(raw));
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}
