import { TerminalInputReceipts } from "./terminal-input-receipts";
import type { TerminalAttachment, TerminalEvent } from "../../application/ports";
import type { SavedConnection } from "../../platform/secure-connections";
import { websocketEndpointLabel, type MobileDiagnosticReporter, type MobileDiagnosticValue } from "../../platform/mobile-diagnostics";
import { dataSocketMessageBytes, type DataSocket, type DataSocketFactory } from "./data-socket";
import {
  FRAME_MAGIC,
  KIND_ACK,
  KIND_ATTACH,
  KIND_EOF,
  KIND_ERROR,
  KIND_GAP,
  KIND_INPUT,
  KIND_INPUT_ACK,
  KIND_ENABLE_INPUT_ACK,
  KIND_OUTPUT,
  KIND_REPLAY_OUTPUT,
  decodeReplayAck,
  decodeFrame,
  decodeGapCount,
  encodeFrame,
  replayRequestPayload,
} from "./terminal-frame";

const AUTH_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;
const FORCE_RECONNECT_TIMEOUT_MS = 12_000;
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const MAX_INPUT_FRAME_BYTES = 16 * 1024;
/// Older daemons have no replay-complete metadata. Their 16 KiB replay frames can be
/// 700+ ms apart over Tailnet, so retain a one-second quiet-window fallback. Newer
/// daemons negotiate the exact replay frame count and complete synchronously.
const REPLAY_BATCH_SETTLE_MS = 1_000;
const MAX_REPLAY_BATCH_BYTES = 1024 * 1024;
let terminalDiagnosticSequence = 0;

export async function attachTerminal(
  connection: SavedConnection,
  session: { id: string; runtime_epoch: number },
  onEvent: (event: TerminalEvent) => void,
  socketFactory: DataSocketFactory,
  diagnostics: MobileDiagnosticReporter,
): Promise<TerminalAttachment> {
  const attachmentId = `terminal-${++terminalDiagnosticSequence}`;
  const report = (
    event: string,
    details: Readonly<Record<string, MobileDiagnosticValue | undefined>> = {},
  ) => diagnostics.report("terminal", event, {
    connectionId: connection.id,
    ...diagnostics.correlation(),
    sessionId: session.id,
    runtimeEpoch: session.runtime_epoch,
    attachmentId,
    ...details,
  });
  const inputReceipts = new TerminalInputReceipts();
  let socket: DataSocket | undefined;
  let sequence = 1n;
  let detached = false;
  let authenticated = false;
  let reconnectDelay = MIN_RECONNECT_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined;
  let replayChunks: Uint8Array[] = [];
  let replayBytes = 0;
  let replayExpectedFrames: number | undefined;
  let replayExpectedBytes: number | undefined;
  let replayReceivedFrames = 0;
  let replayDroppedFrames = 0;
  let replayEof = false;
  let replayReady = false;
  let inbound = Promise.resolve();
  let successfulConnections = 0;
  let connectionAttempt = 0;
  let resolveFirst: (() => void) | undefined;
  let rejectFirst: ((cause: Error) => void) | undefined;
  const reconnectWaiters = new Set<{
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout>;
  }>();

  const firstConnection = new Promise<void>((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  report("attachment_started", {
    endpoint: websocketEndpointLabel(connection.terminalUrl),
  });

  const clearAuthenticationTimer = () => {
    if (authenticationTimer !== undefined) clearTimeout(authenticationTimer);
    authenticationTimer = undefined;
  };

  const clearConnectionTimer = () => {
    if (connectionTimer !== undefined) clearTimeout(connectionTimer);
    connectionTimer = undefined;
  };

  const clearReplayTimer = () => {
    if (replayTimer !== undefined) clearTimeout(replayTimer);
    replayTimer = undefined;
  };

  const clearStabilityTimer = () => {
    if (stabilityTimer !== undefined) clearTimeout(stabilityTimer);
    stabilityTimer = undefined;
  };

  const discardReplay = () => {
    clearReplayTimer();
    replayChunks = [];
    replayBytes = 0;
    replayExpectedFrames = undefined;
    replayExpectedBytes = undefined;
    replayReceivedFrames = 0;
    replayDroppedFrames = 0;
    replayEof = false;
  };

  const settleReconnectWaiters = (cause?: Error) => {
    const waiters = [...reconnectWaiters];
    reconnectWaiters.clear();
    if (waiters.length > 0) {
      report("reconnect_waiters_settled", {
        waiterCount: waiters.length,
        ok: cause === undefined,
        reason: cause?.message,
      });
    }
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      if (cause === undefined) waiter.resolve();
      else waiter.reject(cause);
    }
  };

  const flushReplay = () => {
    clearReplayTimer();
    if (detached) return;
    const expectedFrames = replayExpectedFrames;
    const expectedBytes = replayExpectedBytes;
    const receivedFrames = replayReceivedFrames;
    const droppedFrames = replayDroppedFrames;
    const eof = replayEof;
    const chunkCount = replayChunks.length;
    const bytes = new Uint8Array(replayBytes);
    let offset = 0;
    for (const chunk of replayChunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (expectedFrames !== undefined && (receivedFrames !== expectedFrames || bytes.length !== expectedBytes)) onEvent({ type: "notice", message: "Recent output is incomplete. Waiting for live output." });
    discardReplay();
    if (droppedFrames > 0) onEvent({ type: "gap", droppedFrames });
    if (bytes.byteLength > 0) onEvent({ type: "replay", bytes });
    if (eof) onEvent({ type: "eof" });
    if (!replayReady) { replayReady = true; onEvent({ type: "ready" }); }
    if (bytes.byteLength > 0 || droppedFrames > 0 || eof || expectedFrames !== undefined) {
      report("replay_received", {
        bytes: bytes.byteLength,
        chunks: chunkCount,
        droppedFrames,
        expectedFrames,
        expectedBytes,
        receivedFrames,
        complete: expectedFrames === undefined || receivedFrames === expectedFrames,
      });
    }
  };

  const queueReplay = (bytes: Uint8Array) => {
    if (replayBytes > 0
      && replayBytes + bytes.byteLength > MAX_REPLAY_BATCH_BYTES) {
      flushReplay();
    }
    replayChunks.push(bytes);
    replayBytes += bytes.byteLength;
    clearReplayTimer();
    replayTimer = setTimeout(flushReplay, REPLAY_BATCH_SETTLE_MS);
  };

  const consumeNegotiatedReplayFrame = (kind: number, payload: Uint8Array): boolean => {
    const expected = replayExpectedFrames;
    if (expected === undefined || replayReceivedFrames >= expected) return false;
    if (kind === KIND_REPLAY_OUTPUT) {
      if (replayBytes + payload.byteLength > MAX_REPLAY_BATCH_BYTES) {
        flushReplay();
        return false;
      }
      replayChunks.push(payload);
      replayBytes += payload.byteLength;
    } else if (kind === KIND_GAP) {
      replayDroppedFrames += decodeGapCount(payload);
    } else if (kind === KIND_EOF) {
      replayEof = true;
    } else {
      flushReplay();
      return false;
    }
    replayReceivedFrames += 1;
    onEvent({ type: "replayProgress", receivedBytes: replayBytes, totalBytes: replayExpectedBytes ?? 0 });
    if (replayReceivedFrames === expected) flushReplay();
    return true;
  };

  const failFirst = (message: string, reason = "initialConnectionFailed") => {
    if (rejectFirst === undefined) return;
    const reject = rejectFirst;
    resolveFirst = undefined;
    rejectFirst = undefined;
    detached = true;
    clearConnectionTimer();
    clearAuthenticationTimer();
    clearStabilityTimer();
    const failed = socket;
    inputReceipts.clear();
    socket = undefined;
    report("attachment_failed", {
      reason,
      connectionAttempt,
      successfulConnections,
    });
    failed?.close();
    reject(new Error(message));
  };

  const scheduleReconnect = (reason: string) => {
    if (detached || reconnectTimer !== undefined) return;
    report("reconnect_scheduled", {
      reason,
      delayMs: reconnectDelay,
      successfulConnections,
    });
    onEvent({ type: "state", state: "connectionLost" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
      connect();
    }, reconnectDelay);
  };

  const handleClosed = (
    closed: DataSocket,
    reason: string,
    close?: { code?: number; reason?: string; wasClean?: boolean },
  ) => {
    if (socket !== closed) return;
    report("connection_closed", {
      reason,
      connectionAttempt,
      authenticated,
      successfulConnections,
      closeCode: close?.code,
      closeReasonLength: close?.reason?.length,
      wasClean: close?.wasClean,
    });
    inputReceipts.clear();
    socket = undefined;
    authenticated = false;
    clearConnectionTimer();
    clearAuthenticationTimer();
    clearStabilityTimer();
    discardReplay();
    if (resolveFirst !== undefined) failFirst("Terminal connection failed.", reason);
    else scheduleReconnect(reason);
  };

  const connect = () => {
    if (detached) return;
    connectionAttempt += 1;
    const attempt = connectionAttempt;
    const startedAtEpochMs = Date.now();
    report("connection_started", {
      connectionAttempt: attempt,
      reconnectDelayMs: reconnectDelay,
    });
    onEvent({ type: "state", state: "connecting" });
    let next: DataSocket;
    try {
      next = socketFactory(connection.terminalUrl);
    } catch (cause: unknown) {
      report("connection_factory_failed", {
        connectionAttempt: attempt,
        causeType: cause instanceof Error ? cause.name : typeof cause,
      });
      if (resolveFirst !== undefined) failFirst("Terminal connection failed.", "socketFactoryFailed");
      else scheduleReconnect("socketFactoryFailed");
      return;
    }
    socket = next;
    next.binaryType = "arraybuffer";
    connectionTimer = setTimeout(() => {
      if (socket !== next || detached) return;
      /// iOS can leave a WebSocket in CONNECTING without ever emitting open,
      /// error, or close after foregrounding. Treat that silence as a failed
      /// transport so the bounded reconnect loop can create a new socket.
      report("connection_timeout", {
        connectionAttempt: attempt,
        durationMs: Date.now() - startedAtEpochMs,
      });
      handleClosed(next, "connectTimeout");
      next.close();
    }, CONNECT_TIMEOUT_MS);
    next.onopen = () => {
      if (socket !== next || detached) return;
      clearConnectionTimer();
      report("connection_opened", {
        connectionAttempt: attempt,
        durationMs: Date.now() - startedAtEpochMs,
      });
      try {
        next.send(authenticationBytes(connection.terminalToken));
      } catch (cause: unknown) {
        report("authentication_send_failed", {
          connectionAttempt: attempt,
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
        handleClosed(next, "authenticationSendFailed");
        next.close();
        return;
      }
      authenticationTimer = setTimeout(() => {
        report("authentication_timeout", {
          connectionAttempt: attempt,
          durationMs: Date.now() - startedAtEpochMs,
        });
        if (resolveFirst !== undefined) failFirst("Terminal authentication timed out.", "authenticationTimeout");
        else {
          handleClosed(next, "authenticationTimeout");
          next.close();
        }
      }, AUTH_TIMEOUT_MS);
    };
    next.onmessage = (event) => {
      inbound = inbound
        .then(() => handleMessage(next, event.data))
        .catch((cause: unknown) => {
          report("message_handling_failed", {
            connectionAttempt: attempt,
            causeType: cause instanceof Error ? cause.name : typeof cause,
          });
          handleClosed(next, "messageHandlingFailed");
          next.close();
        });
    };
    next.onerror = (event) => {
      report("socket_error", {
        connectionAttempt: attempt,
        eventType: event?.type,
      });
      handleClosed(next, "socketError");
    };
    next.onclose = (event) => handleClosed(next, "socketClose", event);
  };

  const handleMessage = async (source: DataSocket, data: unknown) => {
    if (socket !== source || detached) return;
    const bytes = await dataSocketMessageBytes(data);
    if (!authenticated) {
      const response = new TextDecoder().decode(bytes);
      if (response === "TLAUTH") {
        report("authentication_refused", { connectionAttempt });
        failFirst("Terminal credential was refused.", "credentialRefused");
        return;
      }
      if (response !== "TLOK") {
        report("authentication_response_ignored", {
          connectionAttempt,
          responseBytes: bytes.byteLength,
        });
        return;
      }
      clearAuthenticationTimer();
      authenticated = true;
      replayReady = false;
      clearStabilityTimer();
      stabilityTimer = setTimeout(() => {
        if (socket !== source || !authenticated || detached) return;
        reconnectDelay = MIN_RECONNECT_MS;
        report("connection_stabilized", { connectionAttempt, stableForMs: STABLE_CONNECTION_MS });
      }, STABLE_CONNECTION_MS);
      if (successfulConnections > 0) onEvent({ type: "reset" });
      successfulConnections += 1;
      report("authenticated", {
        connectionAttempt,
        successfulConnections,
        reconnected: successfulConnections > 1,
      });
      onEvent({ type: "state", state: "connected" });
      discardReplay();
      source.send(encodeFrame("00000000-0000-0000-0000-000000000000", 0, 0n, KIND_ENABLE_INPUT_ACK));
      source.send(encodeFrame(
        session.id,
        session.runtime_epoch,
        sequence++,
        KIND_ATTACH,
        replayRequestPayload(),
      ));
      settleReconnectWaiters();
      resolveFirst?.();
      resolveFirst = undefined;
      rejectFirst = undefined;
      return;
    }

    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      report("invalid_frame_ignored", {
        connectionAttempt,
        bytes: bytes.byteLength,
      });
      return;
    }
    if (frame.sessionId !== session.id || frame.epoch !== session.runtime_epoch) {
      report("stale_frame_ignored", {
        connectionAttempt,
        sessionMatched: frame.sessionId === session.id,
        epochMatched: frame.epoch === session.runtime_epoch,
        frameKind: frame.kind,
      });
      return;
    }
    if (frame.kind === KIND_INPUT_ACK) { inputReceipts.accept(frame.sequence); return; }
    if (frame.kind === KIND_ACK) {
      const replay = decodeReplayAck(frame.payload);
      if (replay !== undefined) {
        replayExpectedFrames = replay.frameCount;
        replayExpectedBytes = replay.outputBytes;
        replayReceivedFrames = 0;
        onEvent({ type: "replayProgress", receivedBytes: 0, totalBytes: replay.outputBytes });
        report("replay_negotiated", {
          connectionAttempt,
          replayFrames: replay.frameCount,
          replayBytes: replay.outputBytes,
        });
        if (replay.frameCount === 0) flushReplay();
        else replayTimer = setTimeout(flushReplay, 5_000);
      } else {
        replayTimer = setTimeout(flushReplay, REPLAY_BATCH_SETTLE_MS);
      }
      return;
    }
    if (consumeNegotiatedReplayFrame(frame.kind, frame.payload)) return;
    if (frame.kind === KIND_REPLAY_OUTPUT) {
      queueReplay(frame.payload);
      return;
    }
    /// Any non-replay frame is an ordering boundary. The frozen replay must be
    /// visible before a following gap, live byte, or exit state.
    flushReplay();
    if (frame.kind === KIND_OUTPUT) onEvent({ type: "live", bytes: frame.payload });
    else if (frame.kind === KIND_GAP) {
      const droppedFrames = decodeGapCount(frame.payload);
      report("output_gap", { connectionAttempt, droppedFrames });
      onEvent({ type: "gap", droppedFrames });
    } else if (frame.kind === KIND_EOF) {
      report("terminal_eof", { connectionAttempt });
      onEvent({ type: "eof" });
    } else if (frame.kind === KIND_ERROR) {
      report("server_frame_error", {
        connectionAttempt,
        errorBytes: frame.payload.byteLength,
      });
      source.close();
    }
  };

  connect();
  await firstConnection;

  return {
    async input(bytes) {
      if (detached || !authenticated || socket === undefined || socket.readyState !== 1) {
        throw new Error("Terminal is not connected.");
      }
      const target = socket;
      inputReceipts.assertCapacity(Math.ceil(bytes.byteLength / MAX_INPUT_FRAME_BYTES));
      const pending: Promise<void>[] = [];
      onEvent({ type: "inputDelivery", state: "sending" });
      try {
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_INPUT_FRAME_BYTES) {
          const inputSequence = sequence++;
          pending.push(inputReceipts.expect(inputSequence));
          target.send(encodeFrame(
            session.id,
            session.runtime_epoch,
            inputSequence,
            KIND_INPUT,
            bytes.slice(offset, offset + MAX_INPUT_FRAME_BYTES),
          ));
        }
        await Promise.all(pending);
        onEvent({ type: "inputDelivery", state: "confirmed" });
      } catch (cause: unknown) {
        /// Browser WebSocket implementations can throw before delivering `close`.
        /// Enter the same bounded reconnect path immediately so presentation cannot
        /// remain permanently disconnected behind a socket that is already unusable.
        inputReceipts.clear();
        await Promise.allSettled(pending);
        onEvent({ type: "inputDelivery", state: "uncertain" });
        report("input_send_failed", {
          connectionAttempt,
          inputBytes: bytes.byteLength,
          causeType: cause instanceof Error ? cause.name : typeof cause,
        });
        handleClosed(target, "inputSendFailed");
        target.close();
        throw cause;
      }
    },
    reconnect() {
      if (detached) return Promise.reject(new Error("Terminal is detached."));
      report("forced_reconnect_started", {
        connectionAttempt,
        authenticated,
        successfulConnections,
        reconnectWaiters: reconnectWaiters.size + 1,
      });
      const waiting = new Promise<void>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timeout: setTimeout(() => {
            reconnectWaiters.delete(waiter);
            report("forced_reconnect_timeout", {
              connectionAttempt,
              reconnectWaiters: reconnectWaiters.size,
            });
            reject(new Error("Terminal did not reconnect."));
          }, FORCE_RECONNECT_TIMEOUT_MS),
        };
        reconnectWaiters.add(waiter);
      });
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const stale = socket;
      inputReceipts.clear();
      socket = undefined;
      authenticated = false;
      clearConnectionTimer();
      clearAuthenticationTimer();
      clearStabilityTimer();
      discardReplay();
      onEvent({ type: "state", state: "connectionLost" });
      stale?.close();
      connect();
      return waiting;
    },
    async detach() {
      if (detached) return;
      report("attachment_detached", {
        connectionAttempt,
        authenticated,
        successfulConnections,
        reconnectWaiters: reconnectWaiters.size,
      });
      detached = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      clearConnectionTimer();
      clearAuthenticationTimer();
      clearStabilityTimer();
      discardReplay();
      settleReconnectWaiters(new Error("Terminal is detached."));
      socket?.close();
      inputReceipts.clear();
      socket = undefined;
    },
  };
}


function authenticationBytes(token: string): Uint8Array {
  const magic = new TextEncoder().encode(FRAME_MAGIC);
  const credential = new TextEncoder().encode(token);
  const bytes = new Uint8Array(magic.byteLength + credential.byteLength);
  bytes.set(magic, 0);
  bytes.set(credential, magic.byteLength);
  return bytes;
}
