import type { SocketFactory, SocketLike } from "@termloop/contract/current";

import type { TerminalAttachment, TerminalEvent } from "../../application/ports";
import type { SavedConnection } from "../../platform/secure-connections";
import {
  dataSocketMessageBytes,
  type DataSocket,
  type DataSocketFactory,
} from "./data-socket";
import {
  mobileDiagnostics,
  websocketEndpointLabel,
  type MobileDiagnosticReporter,
  type MobileDiagnosticValue,
} from "../../platform/mobile-diagnostics";
import { MobileControlClient } from "./mobile-control-client";
import {
  KIND_ACK,
  KIND_ATTACH,
  KIND_DETACH,
  KIND_EOF,
  KIND_ERROR,
  KIND_GAP,
  KIND_INPUT,
  KIND_INPUT_ACK,
  KIND_OUTPUT,
  KIND_REPLAY_OUTPUT,
  decodeFrame,
  decodeGapCount,
  encodeFrame,
} from "./terminal-frame";

const MOBILE_TRANSPORT_VERSION = 2;
const CONNECT_TIMEOUT_MS = 5_000;
const ATTACH_TIMEOUT_MS = 5_000;
const INPUT_RECEIPT_TIMEOUT_MS = 5_000;
const INBOUND_LIVENESS_TIMEOUT_MS = 75_000;
const FORCE_RECONNECT_TIMEOUT_MS = 12_000;
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const ONLINE_ACTIVITY_PUBLISH_MS = 5_000;
const MAX_INPUT_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_INPUT_RECEIPTS = 128;
const REPLAY_BATCH_SETTLE_MS = 16;
const MAX_REPLAY_BATCH_BYTES = 1024 * 1024;

export interface ProjectionInvalidation {
  readonly stateRevision: number;
  readonly observationSequence: number;
  readonly topics: readonly string[];
}

interface ControlChannel {
  closed: boolean;
  readonly listeners: Map<string, Set<(event: { data?: unknown; type?: string; code?: number; reason?: string; wasClean?: boolean }) => void>>;
}

interface TerminalSubscription {
  readonly key: string;
  readonly sessionId: string;
  readonly runtimeEpoch: number;
  readonly attachmentId: string;
  readonly onEvent: (event: TerminalEvent) => void;
  sequence: bigint;
  lastInboundSequence: bigint;
  attachedCount: number;
  awaitingAck: boolean;
  detached: boolean;
  replayChunks: Uint8Array[];
  replayBytes: number;
  replayTimer: ReturnType<typeof setTimeout> | undefined;
  firstResolve: (() => void) | undefined;
  firstReject: ((cause: Error) => void) | undefined;
  readonly reconnectWaiters: Set<{
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }>;
}

interface PendingInputReceipt {
  readonly subscription: TerminalSubscription;
  readonly frameSequence: bigint;
  readonly inputBytes: number;
  readonly resolve: () => void;
  readonly reject: (cause: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

let attachmentSequence = 0;

/// One route-independent transport owner per paired Mac.
///
/// Control stays JSON text and PTY bytes stay TL01 binary frames, but both travel
/// over one authenticated WebSocket. Session routes only add/remove logical
/// subscriptions; navigating between Agents never pays another TLS/Tailscale/WS
/// handshake. A transport reconnect replays every still-active subscription.
export class MobileConnectionCoordinator {
  readonly control: MobileControlClient;

  private physical: DataSocket | undefined;
  private connecting: Promise<DataSocket> | undefined;
  private generation = 0;
  private stopped = false;
  private ready = false;
  private inputReceiptSource: "daemon" | "gateway" | undefined;
  private reconnectDelay = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessTimer: ReturnType<typeof setTimeout> | undefined;
  private controlChannel: ControlChannel | undefined;
  private inbound = Promise.resolve();
  private readonly subscriptions = new Map<string, TerminalSubscription>();
  private readonly inputReceipts = new Map<string, PendingInputReceipt>();
  private readonly invalidationListeners = new Set<(event: ProjectionInvalidation) => void>();
  private readonly statusListeners = new Set<(status: "online" | "offline") => void>();
  private lastOnlineActivityAtEpochMs = 0;

  constructor(
    private readonly connection: SavedConnection,
    private readonly socketFactory: DataSocketFactory,
    private readonly diagnostics: MobileDiagnosticReporter = mobileDiagnostics,
  ) {
    this.control = new MobileControlClient(
      mobileEndpoint(connection.controlUrl),
      connection.controlToken,
      this.controlSocketFactory,
      diagnostics,
      connection.id,
    );
  }

  matches(connection: SavedConnection): boolean {
    return connection.controlUrl === this.connection.controlUrl
      && connection.controlToken === this.connection.controlToken
      && connection.terminalToken === this.connection.terminalToken;
  }

  subscribeInvalidations(listener: (event: ProjectionInvalidation) => void): () => void {
    this.invalidationListeners.add(listener);
    void this.ensureConnected().catch(() => this.scheduleReconnect("subscriptionConnectFailed"));
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  subscribeStatus(listener: (status: "online" | "offline") => void): () => void {
    this.statusListeners.add(listener);
    void this.ensureConnected().catch(() => this.scheduleReconnect("statusConnectFailed"));
    return () => this.statusListeners.delete(listener);
  }

  async attachTerminal(
    session: { id: string; runtime_epoch: number },
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalAttachment> {
    const key = terminalKey(session.id, session.runtime_epoch);
    if (this.subscriptions.has(key)) {
      throw new Error("This terminal is already attached on this phone.");
    }
    const attachmentId = `terminal-${++attachmentSequence}`;
    let firstResolve: (() => void) | undefined;
    let firstReject: ((cause: Error) => void) | undefined;
    const first = new Promise<void>((resolve, reject) => {
      firstResolve = resolve;
      firstReject = reject;
    });
    const subscription: TerminalSubscription = {
      key,
      sessionId: session.id,
      runtimeEpoch: session.runtime_epoch,
      attachmentId,
      onEvent,
      sequence: 1n,
      lastInboundSequence: 0n,
      attachedCount: 0,
      awaitingAck: false,
      detached: false,
      replayChunks: [],
      replayBytes: 0,
      replayTimer: undefined,
      firstResolve,
      firstReject,
      reconnectWaiters: new Set(),
    };
    this.subscriptions.set(key, subscription);
    this.reportTerminal(subscription, "attachment_started", {
      endpoint: websocketEndpointLabel(mobileEndpoint(this.connection.controlUrl)),
      activeSubscriptions: this.subscriptions.size,
    });
    onEvent({ type: "state", state: "connecting" });
    try {
      await this.ensureConnected();
      this.sendAttach(subscription);
      await withTimeout(first, ATTACH_TIMEOUT_MS, "Terminal attachment timed out.");
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error("Terminal attachment failed.");
      this.detachSubscription(subscription, "attachment_failed", error);
      throw error;
    }

    return {
      input: async (bytes) => {
        if (subscription.detached || subscription.attachedCount === 0 || subscription.awaitingAck) {
          throw new Error("Terminal is not connected.");
        }
        const socket = this.openSocket();
        if (socket === undefined) throw new Error("Terminal is not connected.");
        const inputReceiptSource = this.inputReceiptSource;
        const requireReceipts = inputReceiptSource !== undefined;
        const inputFrames = Math.ceil(bytes.byteLength / MAX_INPUT_FRAME_BYTES);
        if (requireReceipts
          && this.inputReceipts.size + inputFrames > MAX_PENDING_INPUT_RECEIPTS) {
          throw new Error("Too much terminal input is awaiting delivery.");
        }
        const receipts: Promise<void>[] = [];
        try {
          for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_FRAME_BYTES) {
            const payload = bytes.slice(offset, offset + MAX_INPUT_FRAME_BYTES);
            const sequence = subscription.sequence++;
            if (requireReceipts) {
              receipts.push(this.expectInputReceipt(subscription, sequence, payload.byteLength));
            }
            socket.send(encodeFrame(
              subscription.sessionId,
              subscription.runtimeEpoch,
              sequence,
              KIND_INPUT,
              payload,
            ));
          }
          await Promise.all(receipts);
          this.reportTerminal(subscription, "input_delivered", {
            inputBytes: bytes.byteLength,
            inputFrames,
            receipted: requireReceipts,
            receiptSource: inputReceiptSource,
          });
        } catch (cause: unknown) {
          this.rejectInputReceipts(subscription, new Error("Terminal input delivery failed."));
          await Promise.allSettled(receipts);
          this.reportTerminal(subscription, "input_send_failed", {
            inputBytes: bytes.byteLength,
            causeType: cause instanceof Error ? cause.name : typeof cause,
          });
          if (this.openSocket() !== undefined) this.invalidateTransport("inputSendFailed");
          throw cause;
        }
      },
      reconnect: () => this.forceReconnect(subscription),
      detach: async () => {
        this.detachSubscription(subscription, "attachment_detached", new Error("Terminal is detached."));
      },
    };
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer);
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.control.close();
    const socket = this.physical;
    this.physical = undefined;
    this.connecting = undefined;
    this.ready = false;
    this.inputReceiptSource = undefined;
    this.rejectAllInputReceipts(new Error("Connection closed."));
    socket?.close();
    for (const subscription of this.subscriptions.values()) {
      subscription.detached = true;
      this.clearReplay(subscription);
      subscription.onEvent({ type: "state", state: "connectionLost" });
      subscription.firstReject?.(new Error("Connection closed."));
      subscription.firstResolve = undefined;
      subscription.firstReject = undefined;
      this.settleWaiters(subscription, new Error("Connection closed."));
    }
    this.subscriptions.clear();
    this.invalidationListeners.clear();
    this.statusListeners.clear();
  }

  private readonly controlSocketFactory: SocketFactory = (): SocketLike => {
    const channel: ControlChannel = { closed: false, listeners: new Map() };
    this.controlChannel = channel;
    queueMicrotask(() => {
      void this.ensureConnected().then(
        () => this.emitControl(channel, "open", {}),
        (cause: unknown) => {
          this.emitControl(channel, "error", { type: cause instanceof Error ? cause.name : "error" });
          this.emitControl(channel, "close", {});
        },
      );
    });
    return {
      addEventListener: (type, listener) => {
        const listeners = channel.listeners.get(type) ?? new Set();
        listeners.add(listener);
        channel.listeners.set(type, listeners);
      },
      send: (data) => {
        const socket = this.openSocket();
        if (channel.closed || socket === undefined) throw new Error("Mobile transport is not connected.");
        socket.send(data);
      },
      close: () => {
        if (channel.closed) return;
        channel.closed = true;
        if (this.controlChannel === channel) this.controlChannel = undefined;
      },
    };
  };

  private ensureConnected(): Promise<DataSocket> {
    if (this.stopped) return Promise.reject(new Error("Mobile connection is closed."));
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ready && this.physical !== undefined) return Promise.resolve(this.physical);
    if (this.connecting !== undefined) return this.connecting;
    const generation = ++this.generation;
    const startedAtEpochMs = Date.now();
    this.diagnostics.report("connection", "connection_started", {
      connectionId: this.connection.id,
      generation,
      endpoint: websocketEndpointLabel(mobileEndpoint(this.connection.controlUrl)),
      activeTerminalSubscriptions: this.subscriptions.size,
    });
    let socket: DataSocket;
    try {
      socket = this.socketFactory(mobileEndpoint(this.connection.controlUrl));
    } catch (cause: unknown) {
      return Promise.reject(cause);
    }
    this.physical = socket;
    socket.binaryType = "arraybuffer";
    const connecting = new Promise<DataSocket>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled || generation !== this.generation) return;
        settled = true;
        reject(new Error("Mobile connection timed out."));
        this.invalidateTransport("authenticationTimeout");
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        if (generation !== this.generation || this.stopped) return socket.close();
        opened = true;
        try {
          socket.send(JSON.stringify({
            type: "mobile.authenticate",
            mobileTransportVersion: MOBILE_TRANSPORT_VERSION,
            mobileHeartbeatVersion: 1,
            mobileInputReceiptVersion: 1,
            terminalInputAckVersion: 1,
            ...this.diagnostics.correlation(),
            controlToken: this.connection.controlToken,
            terminalToken: this.connection.terminalToken,
          }));
        } catch (cause: unknown) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(cause);
          }
          this.invalidateTransport("authenticationSendFailed");
        }
      };
      socket.onmessage = (event) => {
        this.inbound = this.inbound.then(async () => {
          if (generation !== this.generation || this.stopped) return;
          this.refreshInboundLiveness(generation);
          if (!this.ready) {
            const ready = parseReady(event.data);
            if (ready === undefined) throw new Error("Mobile gateway authentication was refused.");
            this.ready = true;
            this.inputReceiptSource = ready.inputReceiptSource;
            this.connecting = undefined;
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              resolve(socket);
            }
            this.diagnostics.report("connection", "connection_ready", {
              connectionId: this.connection.id,
              generation,
              durationMs: Date.now() - startedAtEpochMs,
              activeTerminalSubscriptions: this.subscriptions.size,
            });
            this.publishStatus("online");
            if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer);
            this.stabilityTimer = setTimeout(() => {
              if (generation !== this.generation || !this.ready) return;
              this.reconnectDelay = MIN_RECONNECT_MS;
            }, STABLE_CONNECTION_MS);
            for (const subscription of this.subscriptions.values()) {
              if (subscription.detached) continue;
              if (subscription.attachedCount > 0) subscription.onEvent({ type: "reset" });
              subscription.onEvent({ type: "state", state: "connecting" });
              this.sendAttach(subscription);
            }
            return;
          }
          await this.receive(event.data);
        }).catch((cause: unknown) => {
          this.diagnostics.report("connection", "message_failed", {
            connectionId: this.connection.id,
            generation,
            causeType: cause instanceof Error ? cause.name : typeof cause,
          });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(cause instanceof Error ? cause : new Error("Mobile connection failed."));
          }
          this.invalidateTransport("messageFailed");
        });
      };
      socket.onerror = (event) => {
        this.diagnostics.report("connection", "socket_error", {
          connectionId: this.connection.id,
          generation,
          opened,
          eventType: event?.type,
        });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("Mobile connection failed."));
        }
        this.handleDisconnected(generation, "socketError");
      };
      socket.onclose = (event) => {
        this.diagnostics.report("connection", "connection_closed", {
          connectionId: this.connection.id,
          generation,
          opened,
          closeCode: event?.code,
          closeReasonLength: event?.reason?.length,
          wasClean: event?.wasClean,
          lifetimeMs: Date.now() - startedAtEpochMs,
        });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("Mobile connection closed."));
        }
        this.handleDisconnected(generation, "socketClose");
      };
    });
    this.connecting = connecting;
    return connecting;
  }

  private async receive(data: unknown): Promise<void> {
    this.publishStatus("online");
    if (typeof data === "string") {
      let message: unknown;
      try { message = JSON.parse(data); } catch { throw new Error("Invalid mobile gateway JSON."); }
      if (isMobilePing(message)) {
        const socket = this.openSocket();
        if (socket === undefined) throw new Error("Mobile heartbeat arrived without an open transport.");
        socket.send(JSON.stringify({ type: "mobile.pong" }));
        return;
      }
      if (isMobileInputAccepted(message)) {
        if (this.inputReceiptSource === "gateway") {
          this.acceptInputReceipt(
            message.sessionId,
            message.runtimeEpoch,
            BigInt(message.frameSequence),
            false,
          );
        }
        return;
      }
      if (isInvalidation(message)) {
        for (const listener of this.invalidationListeners) listener(message.payload);
        return;
      }
      const channel = this.controlChannel;
      if (channel !== undefined && !channel.closed) this.emitControl(channel, "message", { data });
      return;
    }
    const frame = decodeFrame(await dataSocketMessageBytes(data));
    const subscription = this.subscriptions.get(terminalKey(frame.sessionId, frame.epoch));
    if (subscription === undefined || subscription.detached) {
      this.diagnostics.report("terminal", "orphan_frame_ignored", {
        connectionId: this.connection.id,
        sessionId: frame.sessionId,
        runtimeEpoch: frame.epoch,
        frameKind: frame.kind,
      });
      return;
    }
    if (frame.kind === KIND_INPUT_ACK) {
      if (this.inputReceiptSource === "daemon") {
        this.acceptInputReceipt(frame.sessionId, frame.epoch, frame.sequence, true);
      }
      return;
    }
    if (frame.kind === KIND_ACK) {
      subscription.awaitingAck = false;
      subscription.attachedCount += 1;
      subscription.onEvent({ type: "state", state: "connected" });
      this.reportTerminal(subscription, "attached", {
        attachedCount: subscription.attachedCount,
        transportGeneration: this.generation,
      });
      subscription.firstResolve?.();
      subscription.firstResolve = undefined;
      subscription.firstReject = undefined;
      this.settleWaiters(subscription);
      return;
    }
    if (frame.kind === KIND_ERROR) {
      const error = new Error("The Mac refused this terminal attachment.");
      this.reportTerminal(subscription, "server_frame_error", { errorBytes: frame.payload.byteLength });
      subscription.firstReject?.(error);
      subscription.firstResolve = undefined;
      subscription.firstReject = undefined;
      this.settleWaiters(subscription, error);
      return;
    }
    if (frame.sequence <= subscription.lastInboundSequence) {
      this.reportTerminal(subscription, "duplicate_frame_ignored", {
        frameSequence: frame.sequence.toString(),
        lastSequence: subscription.lastInboundSequence.toString(),
      });
      return;
    }
    const expected = subscription.lastInboundSequence + 1n;
    if (subscription.lastInboundSequence > 0n && frame.sequence > expected) {
      const missing = Number(frame.sequence - expected);
      this.flushReplay(subscription);
      subscription.onEvent({ type: "gap", droppedFrames: missing });
      this.reportTerminal(subscription, "sequence_gap", {
        expectedSequence: expected.toString(),
        receivedSequence: frame.sequence.toString(),
        droppedFrames: missing,
      });
    }
    subscription.lastInboundSequence = frame.sequence;
    if (frame.kind === KIND_REPLAY_OUTPUT) {
      this.queueReplay(subscription, frame.payload);
      return;
    }
    this.flushReplay(subscription);
    if (frame.kind === KIND_OUTPUT) subscription.onEvent({ type: "live", bytes: frame.payload });
    else if (frame.kind === KIND_GAP) {
      const droppedFrames = decodeGapCount(frame.payload);
      subscription.onEvent({ type: "gap", droppedFrames });
      this.reportTerminal(subscription, "output_gap", { droppedFrames });
    } else if (frame.kind === KIND_EOF) subscription.onEvent({ type: "eof" });
  }

  private sendAttach(subscription: TerminalSubscription): void {
    const socket = this.openSocket();
    if (socket === undefined || subscription.detached || subscription.awaitingAck) return;
    subscription.awaitingAck = true;
    subscription.lastInboundSequence = 0n;
    this.clearReplay(subscription);
    socket.send(encodeFrame(
      subscription.sessionId,
      subscription.runtimeEpoch,
      subscription.sequence++,
      KIND_ATTACH,
    ));
    this.reportTerminal(subscription, "attach_sent", { transportGeneration: this.generation });
  }

  private forceReconnect(subscription: TerminalSubscription): Promise<void> {
    if (subscription.detached) return Promise.reject(new Error("Terminal is detached."));
    const waiting = new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timeout: setTimeout(() => {
          subscription.reconnectWaiters.delete(waiter);
          reject(new Error("Terminal did not reconnect."));
        }, FORCE_RECONNECT_TIMEOUT_MS),
      };
      subscription.reconnectWaiters.add(waiter);
    });
    this.invalidateTransport("forcedReconnect");
    void this.ensureConnected().catch(() => this.scheduleReconnect("forcedReconnectFailed"));
    return waiting;
  }

  private detachSubscription(
    subscription: TerminalSubscription,
    event: "attachment_detached" | "attachment_failed",
    waiterError: Error,
  ): void {
    if (subscription.detached) return;
    subscription.detached = true;
    this.rejectInputReceipts(subscription, waiterError);
    this.subscriptions.delete(subscription.key);
    this.clearReplay(subscription);
    subscription.firstResolve = undefined;
    subscription.firstReject = undefined;
    this.settleWaiters(subscription, waiterError);
    const socket = this.openSocket();
    if (socket !== undefined) {
      try {
        socket.send(encodeFrame(
          subscription.sessionId,
          subscription.runtimeEpoch,
          subscription.sequence++,
          KIND_DETACH,
        ));
      } catch {
        this.invalidateTransport("detachSendFailed");
      }
    }
    this.reportTerminal(subscription, event, {
      activeSubscriptions: this.subscriptions.size,
      attachedCount: subscription.attachedCount,
    });
  }

  private invalidateTransport(reason: string): void {
    const generation = this.generation;
    const socket = this.physical;
    this.handleDisconnected(generation, reason);
    socket?.close();
  }

  private handleDisconnected(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.ready = false;
    this.inputReceiptSource = undefined;
    this.physical = undefined;
    this.connecting = undefined;
    if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer);
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.livenessTimer = undefined;
    const channel = this.controlChannel;
    if (channel !== undefined && !channel.closed) {
      channel.closed = true;
      this.controlChannel = undefined;
      this.emitControl(channel, "close", {});
    }
    for (const subscription of this.subscriptions.values()) {
      subscription.awaitingAck = false;
      this.clearReplay(subscription);
      subscription.onEvent({ type: "state", state: "connectionLost" });
    }
    this.rejectAllInputReceipts(new Error("Terminal transport disconnected."));
    this.diagnostics.report("connection", "transport_disconnected", {
      connectionId: this.connection.id,
      generation,
      reason,
      activeTerminalSubscriptions: this.subscriptions.size,
      invalidationSubscribers: this.invalidationListeners.size,
    });
    this.publishStatus("offline");
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer !== undefined
      || this.subscriptions.size + this.invalidationListeners.size + this.statusListeners.size === 0) return;
    const delayMs = this.reconnectDelay;
    this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2);
    this.diagnostics.report("connection", "reconnect_scheduled", {
      connectionId: this.connection.id,
      reason,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch(() => this.scheduleReconnect("reconnectFailed"));
    }, delayMs);
  }

  private openSocket(): DataSocket | undefined {
    return this.ready && this.physical?.readyState === 1 ? this.physical : undefined;
  }

  private refreshInboundLiveness(generation: number): void {
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      if (generation !== this.generation || !this.ready) return;
      this.diagnostics.report("connection", "inbound_liveness_timeout", {
        connectionId: this.connection.id,
        generation,
        timeoutMs: INBOUND_LIVENESS_TIMEOUT_MS,
      });
      this.invalidateTransport("inboundLivenessTimeout");
    }, INBOUND_LIVENESS_TIMEOUT_MS);
  }

  private emitControl(channel: ControlChannel, type: string, event: { data?: unknown; type?: string; code?: number; reason?: string; wasClean?: boolean }): void {
    for (const listener of channel.listeners.get(type) ?? []) listener(event);
  }

  private queueReplay(subscription: TerminalSubscription, bytes: Uint8Array): void {
    if (subscription.replayBytes > 0
      && subscription.replayBytes + bytes.byteLength > MAX_REPLAY_BATCH_BYTES) {
      this.flushReplay(subscription);
    }
    subscription.replayChunks.push(bytes);
    subscription.replayBytes += bytes.byteLength;
    if (subscription.replayTimer !== undefined) clearTimeout(subscription.replayTimer);
    subscription.replayTimer = setTimeout(() => this.flushReplay(subscription), REPLAY_BATCH_SETTLE_MS);
  }

  private flushReplay(subscription: TerminalSubscription): void {
    if (subscription.replayTimer !== undefined) clearTimeout(subscription.replayTimer);
    subscription.replayTimer = undefined;
    if (subscription.detached || subscription.replayBytes === 0) return;
    const bytes = new Uint8Array(subscription.replayBytes);
    let offset = 0;
    for (const chunk of subscription.replayChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const chunks = subscription.replayChunks.length;
    subscription.replayChunks = [];
    subscription.replayBytes = 0;
    subscription.onEvent({ type: "replay", bytes });
    this.reportTerminal(subscription, "replay_received", { bytes: bytes.byteLength, chunks });
  }

  private clearReplay(subscription: TerminalSubscription): void {
    if (subscription.replayTimer !== undefined) clearTimeout(subscription.replayTimer);
    subscription.replayTimer = undefined;
    subscription.replayChunks = [];
    subscription.replayBytes = 0;
  }

  private settleWaiters(subscription: TerminalSubscription, cause?: Error): void {
    for (const waiter of subscription.reconnectWaiters) {
      clearTimeout(waiter.timeout);
      if (cause === undefined) waiter.resolve();
      else waiter.reject(cause);
    }
    subscription.reconnectWaiters.clear();
  }

  private reportTerminal(
    subscription: TerminalSubscription,
    event: string,
    details: Readonly<Record<string, MobileDiagnosticValue | undefined>> = {},
  ): void {
    this.diagnostics.report("terminal", event, {
      connectionId: this.connection.id,
      ...this.diagnostics.correlation(),
      sessionId: subscription.sessionId,
      runtimeEpoch: subscription.runtimeEpoch,
      attachmentId: subscription.attachmentId,
      ...details,
    });
  }

  private expectInputReceipt(
    subscription: TerminalSubscription,
    sequence: bigint,
    inputBytes: number,
  ): Promise<void> {
    const frameSequence = sequence.toString();
    const key = inputReceiptKey(subscription.sessionId, subscription.runtimeEpoch, frameSequence);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.inputReceipts.get(key);
        if (pending === undefined) return;
        this.inputReceipts.delete(key);
        const error = new Error("Terminal input delivery timed out.");
        pending.reject(error);
        this.reportTerminal(subscription, "input_receipt_timeout", {
          frameSequence,
          inputBytes,
        });
        this.invalidateTransport("inputReceiptTimeout");
      }, INPUT_RECEIPT_TIMEOUT_MS);
      this.inputReceipts.set(key, {
        subscription,
        frameSequence: sequence,
        inputBytes,
        resolve,
        reject,
        timeout,
      });
    });
  }

  private acceptInputReceipt(
    sessionId: string,
    runtimeEpoch: number,
    frameSequence: bigint,
    cumulative: boolean,
  ): void {
    const accepted: PendingInputReceipt[] = [];
    for (const [key, pending] of this.inputReceipts) {
      if (pending.subscription.sessionId !== sessionId
        || pending.subscription.runtimeEpoch !== runtimeEpoch
        || (cumulative ? pending.frameSequence > frameSequence : pending.frameSequence !== frameSequence)) {
        continue;
      }
      this.inputReceipts.delete(key);
      clearTimeout(pending.timeout);
      accepted.push(pending);
    }
    if (accepted.length === 0) {
      this.diagnostics.report("terminal", "orphan_input_receipt_ignored", {
        connectionId: this.connection.id,
        sessionId,
        runtimeEpoch,
        frameSequence: frameSequence.toString(),
      });
      return;
    }
    for (const pending of accepted) {
      pending.resolve();
      this.reportTerminal(pending.subscription, "input_receipt_received", {
        frameSequence: pending.frameSequence.toString(),
        acknowledgedThroughSequence: frameSequence.toString(),
        inputBytes: pending.inputBytes,
        receiptSource: this.inputReceiptSource,
      });
    }
  }

  private rejectInputReceipts(subscription: TerminalSubscription, error: Error): void {
    for (const [key, pending] of this.inputReceipts) {
      if (pending.subscription !== subscription) continue;
      this.inputReceipts.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private rejectAllInputReceipts(error: Error): void {
    const pending = [...this.inputReceipts.values()];
    this.inputReceipts.clear();
    for (const receipt of pending) {
      clearTimeout(receipt.timeout);
      receipt.reject(error);
    }
  }

  private publishStatus(status: "online" | "offline"): void {
    if (status === "online") {
      const now = Date.now();
      if (now - this.lastOnlineActivityAtEpochMs < ONLINE_ACTIVITY_PUBLISH_MS) return;
      this.lastOnlineActivityAtEpochMs = now;
    } else {
      this.lastOnlineActivityAtEpochMs = 0;
    }
    for (const listener of this.statusListeners) listener(status);
  }
}

function mobileEndpoint(controlUrl: string): string {
  const endpoint = new URL(controlUrl);
  endpoint.pathname = "/mobile";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

function terminalKey(sessionId: string, runtimeEpoch: number): string {
  return `${sessionId}:${runtimeEpoch}`;
}

function parseReady(
  data: unknown,
): { readonly inputReceiptSource: "daemon" | "gateway" | undefined } | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    if (!(isRecord(value)
      && value.event === "mobile.ready"
      && value.mobileTransportVersion === MOBILE_TRANSPORT_VERSION)) return undefined;
    return {
      inputReceiptSource: value.terminalInputAckVersion === 1
        ? "daemon"
        : value.mobileInputReceiptVersion === 1 ? "gateway" : undefined,
    };
  } catch {
    return undefined;
  }
}

function isInvalidation(value: unknown): value is { event: "projection.invalidated"; payload: ProjectionInvalidation } {
  if (!isRecord(value) || value.event !== "projection.invalidated" || !isRecord(value.payload)) return false;
  return typeof value.payload.stateRevision === "number"
    && typeof value.payload.observationSequence === "number"
    && Array.isArray(value.payload.topics)
    && value.payload.topics.every((topic) => typeof topic === "string");
}

function isMobilePing(value: unknown): value is { event: "mobile.ping" } {
  return isRecord(value) && value.event === "mobile.ping";
}

interface MobileInputAccepted {
  readonly event: "mobile.inputAccepted";
  readonly mobileInputReceiptVersion: 1;
  readonly sessionId: string;
  readonly runtimeEpoch: number;
  readonly frameSequence: string;
}

function isMobileInputAccepted(value: unknown): value is MobileInputAccepted {
  return isRecord(value)
    && value.event === "mobile.inputAccepted"
    && value.mobileInputReceiptVersion === 1
    && typeof value.sessionId === "string"
    && typeof value.runtimeEpoch === "number"
    && Number.isSafeInteger(value.runtimeEpoch)
    && typeof value.frameSequence === "string"
    && /^(?:0|[1-9][0-9]*)$/u.test(value.frameSequence);
}

function inputReceiptKey(sessionId: string, runtimeEpoch: number, frameSequence: string): string {
  return `${sessionId}:${runtimeEpoch}:${frameSequence}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (cause: unknown) => { clearTimeout(timeout); reject(cause); },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
