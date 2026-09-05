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
import { GatewayReachabilityError } from "./gateway-compatibility";
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
  decodeReplayAck,
  decodeFrame,
  decodeGapCount,
  encodeFrame,
  replayRequestPayload,
} from "./terminal-frame";

const MOBILE_TRANSPORT_VERSION = 2;
const CONNECT_TIMEOUT_MS = 5_000;
const ATTACH_TIMEOUT_MS = 5_000;
const INPUT_RECEIPT_TIMEOUT_MS = 7_000;
const INBOUND_LIVENESS_TIMEOUT_MS = 75_000;
const FORCE_RECONNECT_TIMEOUT_MS = 12_000;
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const RECONNECT_STALLED_MS = 15_000;
const PREFLIGHT_STALLED_FAILURES = 3;
const PREFLIGHT_LATE_SETTLEMENT_OBSERVATION_MS = 5_000;
const STABLE_CONNECTION_MS = 30_000;
const ONLINE_ACTIVITY_PUBLISH_MS = 5_000;
const INITIAL_ATTACH_RETRY_MS = 100;
const MAX_ATTACH_RETRY_MS = 1_000;
const MAX_INPUT_FRAME_BYTES = 16 * 1024;
const MAX_PENDING_INPUT_RECEIPTS = 128;
/// Older daemons have no replay-complete metadata. Their 16 KiB replay frames can be
/// 700+ ms apart over Tailnet, so retain a one-second quiet-window fallback. Newer
/// daemons negotiate the exact replay frame count and complete synchronously.
const REPLAY_BATCH_SETTLE_MS = 1_000;
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
  attachRetryMs: number;
  attachRetryTimer: ReturnType<typeof setTimeout> | undefined;
  detached: boolean;
  replayChunks: Uint8Array[];
  replayBytes: number;
  replayTimer: ReturnType<typeof setTimeout> | undefined;
  replayExpectedFrames: number | undefined;
  replayExpectedBytes: number | undefined;
  replayReceivedFrames: number;
  replayDroppedFrames: number;
  replayEof: boolean;
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

type TransportPhase = "idle" | "preflight" | "socketConnecting" | "authenticating" | "ready";

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
  private cancelConnecting: ((cause: Error) => void) | undefined;
  private generation = 0;
  private stopped = false;
  private ready = false;
  private inputReceiptSource: "daemon" | "gateway" | undefined;
  private reconnectDelay = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectStallTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectStartedAtEpochMs: number | undefined;
  private reconnectAttempt = 0;
  private stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessTimer: ReturnType<typeof setTimeout> | undefined;
  private controlChannel: ControlChannel | undefined;
  private inbound = Promise.resolve();
  private readonly subscriptions = new Map<string, TerminalSubscription>();
  private readonly inputReceipts = new Map<string, PendingInputReceipt>();
  private readonly invalidationListeners = new Set<(event: ProjectionInvalidation) => void>();
  private readonly statusListeners = new Set<(status: "online" | "offline") => void>();
  private lastOnlineActivityAtEpochMs = 0;
  private transportPhase: TransportPhase = "idle";
  private transportPhaseStartedAtEpochMs: number | undefined;
  private preflightsInFlight = 0;
  private preflightFailuresSinceReady = 0;
  private preflightFailureStartedAtEpochMs: number | undefined;
  private preflightStallReported = false;
  private lastReadyAtEpochMs: number | undefined;
  private lastDisconnectAtEpochMs: number | undefined;
  private lastDisconnectReason: string | undefined;

  constructor(
    private readonly connection: SavedConnection,
    private readonly socketFactory: DataSocketFactory,
    private readonly diagnostics: MobileDiagnosticReporter = mobileDiagnostics,
    private readonly prepareConnection?: () => Promise<void>,
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
      this.stopReconnectIfIdle();
    };
  }

  subscribeStatus(listener: (status: "online" | "offline") => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async attachTerminal(
    session: { id: string; runtime_epoch: number },
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalAttachment> {
    const key = terminalKey(session.id, session.runtime_epoch);
    const previous = this.subscriptions.get(key);
    if (previous !== undefined) {
      this.detachSubscription(
        previous,
        "attachment_detached",
        new Error("Terminal attachment was replaced by a newer view."),
      );
    }
    const attachmentId = `terminal-${++attachmentSequence}`;
    let firstResolve: (() => void) | undefined;
    let firstReject: ((cause: Error) => void) | undefined;
    const first = new Promise<void>((resolve, reject) => {
      firstResolve = resolve;
      firstReject = reject;
    });
    // A lifecycle reset can reject the subscription while attachTerminal is
    // still awaiting authentication and has not reached `withTimeout(first)`.
    // Keep that early rejection observed; the original promise still rejects
    // normally once the caller reaches the ACK wait.
    void first.catch(() => {});
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
      attachRetryMs: INITIAL_ATTACH_RETRY_MS,
      attachRetryTimer: undefined,
      detached: false,
      replayChunks: [],
      replayBytes: 0,
      replayTimer: undefined,
      replayExpectedFrames: undefined,
      replayExpectedBytes: undefined,
      replayReceivedFrames: 0,
      replayDroppedFrames: 0,
      replayEof: false,
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

  /// Retires only the native WebSocket. Logical terminal subscriptions survive
  /// foreground recovery and are attached again when the next authenticated
  /// transport becomes ready. Closing the whole coordinator here strands an
  /// already-resolved TerminalAttachment on a permanently stopped owner.
  resetTransport(reconnect = false): void {
    if (this.stopped) return;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectDelay = MIN_RECONNECT_MS;
    const shouldReconnect = reconnect && this.hasActiveReconnectDemand();
    this.diagnostics.report("connection", "transport_reset_requested", {
      connectionId: this.connection.id,
      reconnect,
      shouldReconnect,
      ...this.connectionDiagnosticState(),
      ...this.diagnostics.correlation(),
    });
    if (!shouldReconnect) this.clearReconnectCycle();
    const generation = this.generation;
    const socket = this.physical;
    if (socket === undefined && this.connecting === undefined && !this.ready) {
      if (shouldReconnect) {
        this.beginReconnectCycle("clientResume");
        void this.ensureConnected().catch(() => this.scheduleReconnect("clientResumeFailed"));
      }
      return;
    }
    this.handleDisconnected(generation, "clientReset", shouldReconnect);
    socket?.close();
    if (shouldReconnect) {
      void this.ensureConnected().catch(() => this.scheduleReconnect("clientResumeFailed"));
    }
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.reconnectStallTimer !== undefined) clearTimeout(this.reconnectStallTimer);
    if (this.stabilityTimer !== undefined) clearTimeout(this.stabilityTimer);
    if (this.livenessTimer !== undefined) clearTimeout(this.livenessTimer);
    this.control.close();
    this.cancelConnecting?.(new Error("Connection closed."));
    this.cancelConnecting = undefined;
    const socket = this.physical;
    this.physical = undefined;
    this.connecting = undefined;
    this.ready = false;
    this.inputReceiptSource = undefined;
    this.rejectAllInputReceipts(new Error("Connection closed."));
    socket?.close();
    for (const subscription of this.subscriptions.values()) {
      subscription.detached = true;
      this.clearAttachmentRetry(subscription);
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
    if (this.reconnectStartedAtEpochMs !== undefined) {
      this.reconnectAttempt += 1;
      this.diagnostics.report("connection", "reconnect_attempt_started", {
        connectionId: this.connection.id,
        generation,
        reconnectAttempt: this.reconnectAttempt,
        reconnectElapsedMs: startedAtEpochMs - this.reconnectStartedAtEpochMs,
        ...this.diagnostics.correlation(),
      });
    }
    this.diagnostics.report("connection", "connection_started", {
      connectionId: this.connection.id,
      generation,
      endpoint: websocketEndpointLabel(mobileEndpoint(this.connection.controlUrl)),
      ...this.connectionDiagnosticState(startedAtEpochMs),
    });
    const connecting = this.openPreparedConnection(generation, startedAtEpochMs);
    this.connecting = connecting;
    void connecting.then(
      () => {},
      () => {
        if (this.connecting === connecting) this.connecting = undefined;
      },
    );
    return connecting;
  }

  private async openPreparedConnection(
    generation: number,
    startedAtEpochMs: number,
  ): Promise<DataSocket> {
    if (this.prepareConnection !== undefined) {
      const preflightStartedAtEpochMs = Date.now();
      this.preflightsInFlight += 1;
      this.setTransportPhase(generation, "preflight", preflightStartedAtEpochMs);
      this.diagnostics.report("connection", "preflight_started", {
        connectionId: this.connection.id,
        generation,
        currentGeneration: this.generation,
        ...this.connectionDiagnosticState(preflightStartedAtEpochMs),
      });
      try {
        await this.prepareConnection();
      } catch (cause: unknown) {
        const failedAtEpochMs = Date.now();
        const attemptSuperseded = generation !== this.generation || this.stopped;
        const failure = preflightFailureDetails(cause);
        this.observeTimedOutPreflight(cause, generation, failedAtEpochMs);
        this.preflightsInFlight = Math.max(0, this.preflightsInFlight - 1);
        const countsTowardStall = !this.ready;
        if (countsTowardStall) {
          this.preflightFailuresSinceReady += 1;
          this.preflightFailureStartedAtEpochMs ??= preflightStartedAtEpochMs;
        }
        this.diagnostics.report("connection", "preflight_failed", {
          connectionId: this.connection.id,
          generation,
          currentGeneration: this.generation,
          durationMs: failedAtEpochMs - preflightStartedAtEpochMs,
          causeType: cause instanceof Error ? cause.name : typeof cause,
          ...failure,
          attemptSuperseded,
          countsTowardStall,
          preflightFailuresSinceReady: this.preflightFailuresSinceReady,
          preflightFailureElapsedMs: this.preflightFailureStartedAtEpochMs === undefined
            ? undefined
            : failedAtEpochMs - this.preflightFailureStartedAtEpochMs,
          ...this.connectionDiagnosticState(failedAtEpochMs),
        });
        if (!this.preflightStallReported
          && this.preflightFailuresSinceReady >= PREFLIGHT_STALLED_FAILURES
          && this.subscriptions.size > 0) {
          this.preflightStallReported = true;
          this.diagnostics.report("connection", "preflight_stalled", {
            connectionId: this.connection.id,
            generation,
            currentGeneration: this.generation,
            ...failure,
            attemptSuperseded,
            preflightFailuresSinceReady: this.preflightFailuresSinceReady,
            preflightFailureElapsedMs: this.preflightFailureStartedAtEpochMs === undefined
              ? undefined
              : failedAtEpochMs - this.preflightFailureStartedAtEpochMs,
            ...this.connectionDiagnosticState(failedAtEpochMs),
            ...this.diagnostics.correlation(),
          });
        }
        if (!attemptSuperseded) this.setTransportPhase(generation, "idle", failedAtEpochMs);
        throw cause;
      }
      const completedAtEpochMs = Date.now();
      this.preflightsInFlight = Math.max(0, this.preflightsInFlight - 1);
      if (generation !== this.generation || this.stopped) {
        this.diagnostics.report("connection", "preflight_superseded", {
          connectionId: this.connection.id,
          generation,
          currentGeneration: this.generation,
          durationMs: completedAtEpochMs - preflightStartedAtEpochMs,
          stopped: this.stopped,
          ...this.connectionDiagnosticState(completedAtEpochMs),
        });
        throw new Error("Mobile connection was superseded.");
      }
      this.diagnostics.report("connection", "preflight_completed", {
        connectionId: this.connection.id,
        generation,
        durationMs: completedAtEpochMs - preflightStartedAtEpochMs,
        ...this.connectionDiagnosticState(completedAtEpochMs),
      });
    }
    this.setTransportPhase(generation, "socketConnecting");
    let socket: DataSocket;
    try {
      socket = this.socketFactory(mobileEndpoint(this.connection.controlUrl));
    } catch (cause: unknown) {
      this.diagnostics.report("connection", "socket_factory_failed", {
        connectionId: this.connection.id,
        generation,
        causeType: cause instanceof Error ? cause.name : typeof cause,
        ...this.connectionDiagnosticState(),
      });
      this.setTransportPhase(generation, "idle");
      return Promise.reject(cause);
    }
    this.physical = socket;
    socket.binaryType = "arraybuffer";
    return await new Promise<DataSocket>((resolve, reject) => {
      let opened = false;
      let settled = false;
      const fail = (cause: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelConnecting === fail) this.cancelConnecting = undefined;
        reject(cause);
      };
      const timer = setTimeout(() => {
        if (settled || generation !== this.generation) return;
        this.diagnostics.report("connection", "connection_timeout", {
          connectionId: this.connection.id,
          generation,
          timeoutMs: CONNECT_TIMEOUT_MS,
          ...this.connectionDiagnosticState(),
        });
        fail(new Error("Mobile connection timed out."));
        this.invalidateTransport("authenticationTimeout");
      }, CONNECT_TIMEOUT_MS);
      this.cancelConnecting = fail;
      socket.onopen = () => {
        if (generation !== this.generation || this.stopped) return socket.close();
        opened = true;
        this.setTransportPhase(generation, "authenticating");
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
          fail(cause instanceof Error ? cause : new Error("Mobile authentication could not be sent."));
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
            this.lastReadyAtEpochMs = Date.now();
            this.setTransportPhase(generation, "ready", this.lastReadyAtEpochMs);
            if (this.preflightFailuresSinceReady > 0) {
              this.diagnostics.report("connection", "preflight_recovered", {
                connectionId: this.connection.id,
                generation,
                failedAttempts: this.preflightFailuresSinceReady,
                recoveryElapsedMs: this.preflightFailureStartedAtEpochMs === undefined
                  ? undefined
                  : this.lastReadyAtEpochMs - this.preflightFailureStartedAtEpochMs,
                ...this.connectionDiagnosticState(this.lastReadyAtEpochMs),
              });
            }
            this.preflightFailuresSinceReady = 0;
            this.preflightFailureStartedAtEpochMs = undefined;
            this.preflightStallReported = false;
            this.inputReceiptSource = ready.inputReceiptSource;
            this.connecting = undefined;
            clearTimeout(timer);
            if (this.cancelConnecting === fail) this.cancelConnecting = undefined;
            if (!settled) {
              settled = true;
              resolve(socket);
            }
            this.finishReconnectCycle(generation);
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
          // A retired socket may finish decoding after its replacement is
          // already live. It must not invalidate that newer generation.
          if (generation !== this.generation || this.stopped) return;
          fail(cause instanceof Error ? cause : new Error("Mobile connection failed."));
          this.invalidateTransport("messageFailed");
        });
      };
      socket.onerror = (event) => {
        this.diagnostics.report("connection", "socket_error", {
          connectionId: this.connection.id,
          generation,
          opened,
          eventType: event?.type,
          attemptSuperseded: generation !== this.generation,
          ...this.connectionDiagnosticState(),
        });
        fail(new Error("Mobile connection failed."));
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
          attemptSuperseded: generation !== this.generation,
          ...this.connectionDiagnosticState(),
        });
        fail(new Error("Mobile connection closed."));
        this.handleDisconnected(generation, "socketClose");
      };
    });
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
      this.clearAttachmentRetry(subscription);
      subscription.attachRetryMs = INITIAL_ATTACH_RETRY_MS;
      const replay = decodeReplayAck(frame.payload);
      if (replay !== undefined) {
        subscription.replayExpectedFrames = replay.frameCount;
        subscription.replayExpectedBytes = replay.outputBytes;
        subscription.replayReceivedFrames = 0;
        this.reportTerminal(subscription, "replay_negotiated", {
          replayFrames: replay.frameCount,
          replayBytes: replay.outputBytes,
        });
        if (replay.frameCount === 0) this.flushReplay(subscription);
      }
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
      const receiptKey = inputReceiptKey(
        frame.sessionId,
        frame.epoch,
        frame.sequence.toString(),
      );
      const pendingInput = this.inputReceipts.get(receiptKey);
      if (pendingInput !== undefined) {
        this.inputReceipts.delete(receiptKey);
        clearTimeout(pendingInput.timeout);
        const error = new Error("The Mac refused this terminal input.");
        pendingInput.reject(error);
        this.reportTerminal(subscription, "input_refused", {
          frameSequence: frame.sequence.toString(),
          inputBytes: pendingInput.inputBytes,
        });
        return;
      }
      if (subscription.awaitingAck) {
        subscription.awaitingAck = false;
        const retryDelayMs = this.scheduleAttachmentRetry(subscription);
        this.reportTerminal(subscription, "attachment_refused", {
          errorBytes: frame.payload.byteLength,
          retryDelayMs,
        });
        return;
      }
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
    if (this.consumeNegotiatedReplayFrame(subscription, frame.kind, frame.payload)) return;
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
    this.clearAttachmentRetry(subscription);
    subscription.awaitingAck = true;
    subscription.lastInboundSequence = 0n;
    this.clearReplay(subscription);
    socket.send(encodeFrame(
      subscription.sessionId,
      subscription.runtimeEpoch,
      subscription.sequence++,
      KIND_ATTACH,
      replayRequestPayload(),
    ));
    this.reportTerminal(subscription, "attach_sent", { transportGeneration: this.generation });
  }

  private scheduleAttachmentRetry(subscription: TerminalSubscription): number | undefined {
    if (subscription.detached || subscription.attachRetryTimer !== undefined) return undefined;
    const delayMs = subscription.attachRetryMs;
    subscription.attachRetryMs = Math.min(MAX_ATTACH_RETRY_MS, delayMs * 2);
    subscription.attachRetryTimer = setTimeout(() => {
      subscription.attachRetryTimer = undefined;
      if (this.subscriptions.get(subscription.key) !== subscription || subscription.detached) return;
      this.sendAttach(subscription);
    }, delayMs);
    return delayMs;
  }

  private clearAttachmentRetry(subscription: TerminalSubscription): void {
    if (subscription.attachRetryTimer !== undefined) clearTimeout(subscription.attachRetryTimer);
    subscription.attachRetryTimer = undefined;
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
    this.clearAttachmentRetry(subscription);
    this.clearReplay(subscription);
    subscription.firstReject?.(waiterError);
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
      ...(event === "attachment_failed" ? {
        causeType: waiterError.name,
        generation: this.generation,
        ...this.connectionDiagnosticState(),
      } : {}),
    });
    this.stopReconnectIfIdle();
  }

  private invalidateTransport(reason: string): void {
    const generation = this.generation;
    const socket = this.physical;
    this.handleDisconnected(generation, reason);
    socket?.close();
  }

  private handleDisconnected(generation: number, reason: string, reconnect = true): void {
    if (generation !== this.generation) return;
    const disconnectedAtEpochMs = Date.now();
    const diagnosticState = this.connectionDiagnosticState(disconnectedAtEpochMs);
    const shouldReconnect = reconnect && this.hasActiveReconnectDemand();
    if (shouldReconnect) this.beginReconnectCycle(reason);
    else this.clearReconnectCycle();
    this.cancelConnecting?.(new Error("Mobile transport disconnected."));
    this.cancelConnecting = undefined;
    this.generation += 1;
    this.lastDisconnectAtEpochMs = disconnectedAtEpochMs;
    this.lastDisconnectReason = reason;
    this.transportPhase = "idle";
    this.transportPhaseStartedAtEpochMs = disconnectedAtEpochMs;
    this.ready = false;
    this.inputReceiptSource = undefined;
    this.physical = undefined;
    this.connecting = undefined;
    // A suspended iOS Blob read can leave the old serial inbound chain pending.
    // New-generation authentication must not queue behind work owned by a socket
    // we have already fenced out.
    this.inbound = Promise.resolve();
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
      this.clearAttachmentRetry(subscription);
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
      ...diagnosticState,
    });
    this.publishStatus("offline");
    if (shouldReconnect) this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    if (!this.hasActiveReconnectDemand()) {
      this.stopReconnectIfIdle();
      return;
    }
    this.beginReconnectCycle(reason);
    const delayMs = this.reconnectDelay;
    this.reconnectDelay = Math.min(MAX_RECONNECT_MS, this.reconnectDelay * 2);
    this.diagnostics.report("connection", "reconnect_scheduled", {
      connectionId: this.connection.id,
      reason,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const attempt = this.reconnectAttempt + 1;
      void this.ensureConnected().catch((cause: unknown) => {
        this.diagnostics.report("connection", "reconnect_attempt_failed", {
          connectionId: this.connection.id,
          reconnectAttempt: attempt,
          reconnectElapsedMs: this.reconnectStartedAtEpochMs === undefined
            ? undefined
            : Date.now() - this.reconnectStartedAtEpochMs,
          causeType: cause instanceof Error ? cause.name : typeof cause,
          reason: "connectionAttemptRejected",
          ...this.diagnostics.correlation(),
        });
        this.scheduleReconnect("reconnectFailed");
      });
    }, delayMs);
  }

  private beginReconnectCycle(reason: string): void {
    if (!this.hasActiveReconnectDemand() || this.reconnectStartedAtEpochMs !== undefined) return;
    this.reconnectStartedAtEpochMs = Date.now();
    this.reconnectAttempt = 0;
    this.diagnostics.report("connection", "reconnect_cycle_started", {
      connectionId: this.connection.id,
      generation: this.generation,
      reason,
      activeTerminalSubscriptions: this.subscriptions.size,
      ...this.diagnostics.correlation(),
    });
    if (this.reconnectStallTimer !== undefined) clearTimeout(this.reconnectStallTimer);
    this.reconnectStallTimer = setTimeout(() => {
      this.reconnectStallTimer = undefined;
      if (this.stopped || this.ready || this.reconnectStartedAtEpochMs === undefined
        || !this.hasActiveReconnectDemand()) {
        this.clearReconnectCycle();
        return;
      }
      this.diagnostics.report("connection", "reconnect_stalled", {
        connectionId: this.connection.id,
        generation: this.generation,
        reconnectAttempt: this.reconnectAttempt,
        reconnectElapsedMs: Date.now() - this.reconnectStartedAtEpochMs,
        activeTerminalSubscriptions: this.subscriptions.size,
        invalidationSubscribers: this.invalidationListeners.size,
        statusSubscribers: this.statusListeners.size,
        socketReadyState: this.physical?.readyState,
        connecting: this.connecting !== undefined,
        ...this.connectionDiagnosticState(),
        ...this.diagnostics.correlation(),
      });
    }, RECONNECT_STALLED_MS);
  }

  private finishReconnectCycle(generation: number): void {
    if (this.reconnectStartedAtEpochMs === undefined) return;
    this.diagnostics.report("connection", "reconnect_recovered", {
      connectionId: this.connection.id,
      generation,
      reconnectAttempts: this.reconnectAttempt,
      reconnectElapsedMs: Date.now() - this.reconnectStartedAtEpochMs,
      ...this.diagnostics.correlation(),
    });
    this.clearReconnectCycle();
  }

  private clearReconnectCycle(): void {
    if (this.reconnectStallTimer !== undefined) clearTimeout(this.reconnectStallTimer);
    this.reconnectStallTimer = undefined;
    this.reconnectStartedAtEpochMs = undefined;
    this.reconnectAttempt = 0;
  }

  private hasActiveReconnectDemand(): boolean {
    return this.subscriptions.size + this.invalidationListeners.size > 0;
  }

  private stopReconnectIfIdle(): void {
    if (this.hasActiveReconnectDemand()) return;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectDelay = MIN_RECONNECT_MS;
    this.clearReconnectCycle();
  }

  private setTransportPhase(
    generation: number,
    phase: TransportPhase,
    atEpochMs = Date.now(),
  ): void {
    if (generation !== this.generation) return;
    this.transportPhase = phase;
    this.transportPhaseStartedAtEpochMs = atEpochMs;
  }

  private observeTimedOutPreflight(
    cause: unknown,
    generation: number,
    failedAtEpochMs: number,
  ): void {
    if (!(cause instanceof GatewayReachabilityError) || cause.lateSettlement === undefined) return;
    let settled = false;
    void cause.lateSettlement.then((outcome) => {
      settled = true;
      this.diagnostics.report("connection", "preflight_request_settled_after_timeout", {
        connectionId: this.connection.id,
        generation,
        currentGeneration: this.generation,
        settlementDelayMs: Math.max(0, Date.now() - failedAtEpochMs),
        lateSettlement: outcome.kind,
        requestCauseType: outcome.kind === "requestRejected" ? outcome.causeType : undefined,
        httpStatus: outcome.kind === "response" ? outcome.httpStatus : undefined,
        attemptSuperseded: generation !== this.generation || this.stopped,
        ...this.connectionDiagnosticState(),
      });
    });
    setTimeout(() => {
      if (settled) return;
      this.diagnostics.report("connection", "preflight_request_unsettled_after_timeout", {
        connectionId: this.connection.id,
        generation,
        currentGeneration: this.generation,
        observationMs: PREFLIGHT_LATE_SETTLEMENT_OBSERVATION_MS,
        attemptSuperseded: generation !== this.generation || this.stopped,
        ...this.connectionDiagnosticState(),
      });
    }, PREFLIGHT_LATE_SETTLEMENT_OBSERVATION_MS);
  }

  private connectionDiagnosticState(
    atEpochMs = Date.now(),
  ): Readonly<Record<string, MobileDiagnosticValue | undefined>> {
    return {
      transportPhase: this.transportPhase,
      transportPhaseElapsedMs: this.transportPhaseStartedAtEpochMs === undefined
        ? undefined
        : Math.max(0, atEpochMs - this.transportPhaseStartedAtEpochMs),
      ready: this.ready,
      connecting: this.connecting !== undefined,
      socketReadyState: this.physical?.readyState,
      preflightsInFlight: this.preflightsInFlight,
      preflightFailuresSinceReady: this.preflightFailuresSinceReady,
      reconnectCycleActive: this.reconnectStartedAtEpochMs !== undefined,
      reconnectAttempt: this.reconnectAttempt,
      reconnectTimerPending: this.reconnectTimer !== undefined,
      activeTerminalSubscriptions: this.subscriptions.size,
      invalidationSubscribers: this.invalidationListeners.size,
      statusSubscribers: this.statusListeners.size,
      routeKind: gatewayRouteKind(this.connection.controlUrl),
      sinceLastReadyMs: this.lastReadyAtEpochMs === undefined
        ? undefined
        : Math.max(0, atEpochMs - this.lastReadyAtEpochMs),
      sinceLastDisconnectMs: this.lastDisconnectAtEpochMs === undefined
        ? undefined
        : Math.max(0, atEpochMs - this.lastDisconnectAtEpochMs),
      lastDisconnectReason: this.lastDisconnectReason,
    };
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

  /// A negotiated ACK describes the exact number of frozen replay events. Hold every
  /// one — including its leading Gap and trailing EOF — until the final frame, then
  /// publish the snapshot synchronously with no quiet-window delay.
  private consumeNegotiatedReplayFrame(
    subscription: TerminalSubscription,
    kind: number,
    payload: Uint8Array,
  ): boolean {
    const expected = subscription.replayExpectedFrames;
    if (expected === undefined || subscription.replayReceivedFrames >= expected) return false;
    if (kind === KIND_REPLAY_OUTPUT) {
      if (subscription.replayBytes + payload.byteLength > MAX_REPLAY_BATCH_BYTES) {
        this.flushReplay(subscription);
        return false;
      }
      subscription.replayChunks.push(payload);
      subscription.replayBytes += payload.byteLength;
    } else if (kind === KIND_GAP) {
      subscription.replayDroppedFrames += decodeGapCount(payload);
    } else if (kind === KIND_EOF) {
      subscription.replayEof = true;
    } else {
      this.flushReplay(subscription);
      return false;
    }
    subscription.replayReceivedFrames += 1;
    if (subscription.replayReceivedFrames === expected) this.flushReplay(subscription);
    return true;
  }

  private flushReplay(subscription: TerminalSubscription): void {
    if (subscription.replayTimer !== undefined) clearTimeout(subscription.replayTimer);
    subscription.replayTimer = undefined;
    if (subscription.detached) return;
    const expectedFrames = subscription.replayExpectedFrames;
    const expectedBytes = subscription.replayExpectedBytes;
    const receivedFrames = subscription.replayReceivedFrames;
    const droppedFrames = subscription.replayDroppedFrames;
    const eof = subscription.replayEof;
    const replayBytes = subscription.replayBytes;
    const bytes = new Uint8Array(replayBytes);
    let offset = 0;
    for (const chunk of subscription.replayChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const chunks = subscription.replayChunks.length;
    this.clearReplay(subscription);
    if (droppedFrames > 0) subscription.onEvent({ type: "gap", droppedFrames });
    if (bytes.byteLength > 0) subscription.onEvent({ type: "replay", bytes });
    if (eof) subscription.onEvent({ type: "eof" });
    if (bytes.byteLength > 0 || droppedFrames > 0 || eof || expectedFrames !== undefined) {
      this.reportTerminal(subscription, "replay_received", {
        bytes: bytes.byteLength,
        chunks,
        droppedFrames,
        expectedFrames,
        expectedBytes,
        receivedFrames,
        complete: expectedFrames === undefined || receivedFrames === expectedFrames,
      });
    }
  }

  private clearReplay(subscription: TerminalSubscription): void {
    if (subscription.replayTimer !== undefined) clearTimeout(subscription.replayTimer);
    subscription.replayTimer = undefined;
    subscription.replayChunks = [];
    subscription.replayBytes = 0;
    subscription.replayExpectedFrames = undefined;
    subscription.replayExpectedBytes = undefined;
    subscription.replayReceivedFrames = 0;
    subscription.replayDroppedFrames = 0;
    subscription.replayEof = false;
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

function preflightFailureDetails(
  cause: unknown,
): Readonly<Record<string, MobileDiagnosticValue | undefined>> {
  if (!(cause instanceof GatewayReachabilityError)) {
    return { preflightFailureReason: "other" };
  }
  return {
    preflightFailureReason: cause.reason,
    requestCauseType: cause.requestCauseType,
    httpStatus: cause.httpStatus,
  };
}

function gatewayRouteKind(controlUrl: string): string {
  try {
    const hostname = new URL(controlUrl).hostname.toLowerCase();
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return "loopback";
    }
    if (hostname.endsWith(".ts.net")) return "tailnetDns";
    if (/^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./u.test(hostname)) {
      return "tailnetIpv4";
    }
    if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/u.test(hostname)) {
      return "privateIpv4";
    }
    return "hostname";
  } catch {
    return "invalid";
  }
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
