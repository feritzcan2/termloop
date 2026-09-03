import type { SessionDto } from "@termloop/contract/current";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SelectedImage, TerminalAttachment, TerminalEvent } from "@/application/ports";
import { useMobileRuntime } from "@/composition/runtime-context";
import {
  detachTerminalBuffer,
  emptyTerminalBuffer,
  reduceTerminalEvent,
  terminalCapNotice,
  withTerminalScreen,
  type TerminalBuffer,
} from "@/presentation/terminal-buffer";
import { scrollSequence } from "@/presentation/terminal-scroll";
import { TerminalScreenProjection } from "@/presentation/terminal-screen";
import { attachedImageMessage } from "@/presentation/terminal-image-message";
import { useAppLifecycle } from "@/platform/app-lifecycle";
import {
  appendTerminalOutputTail,
  continueTerminalReplay,
  terminalContinuityCache,
  terminalContinuityKey,
} from "./terminal-continuity";

/// One attachment's lifetime, from the screen's point of view.
///
/// The interface deliberately has no resize member. "Mobile sends no resize in the
/// initial release" is a product decision, and encoding it in the type means it
/// cannot be undone by someone forgetting it — a resize call would not compile.
///
/// Detach is not termination. Leaving the screen stops this phone listening; the PTY
/// keeps running on the Mac, so nothing here may print or imply an exit.

/// The keys a phone keyboard cannot produce but an agent TUI needs.
export type TerminalKey = "escape" | "tab" | "interrupt" | "eof" | "up" | "down" | "left" | "right" | "enter";

const keyBytes: Record<TerminalKey, readonly number[]> = {
  escape: [0x1b],
  tab: [0x09],
  /// Ctrl-C and Ctrl-D are sent as the control codes themselves, not as a named
  /// command. The daemon owns the PTY; the phone is a keyboard.
  interrupt: [0x03],
  eof: [0x04],
  up: [0x1b, 0x5b, 0x41],
  down: [0x1b, 0x5b, 0x42],
  right: [0x1b, 0x5b, 0x43],
  left: [0x1b, 0x5b, 0x44],
  enter: [0x0d],
};

/// Text and its newline are two writes with a gap between them. An agent TUI that
/// reads a line and immediately redraws can otherwise consume the newline while the
/// pasted text is still arriving, and the turn is submitted half-written.
const SUBMIT_SETTLE_MS = 60;
const INITIAL_ATTACH_RETRY_MS = 1_000;
const MAX_ATTACH_RETRY_MS = 30_000;

export interface TerminalSession {
  readonly buffer: TerminalBuffer;
  /// Stated only once the bound has actually been reached.
  readonly capNotice: string | undefined;
  /// Input is refused unless the stream is live. A disabled composer is honest; one
  /// that accepts keystrokes into a lost connection is not.
  readonly canSend: boolean;
  readonly error: string | undefined;
  /// A failed image staging request does not invalidate an otherwise-live terminal
  /// attachment. Keep its error separate so the user can still type normally.
  readonly imageError: string | undefined;
  submit: (text: string) => void;
  /// Uploads a selected image to the Session's ignored runtime directory, then
  /// sends one normal terminal turn that names the image and includes the text.
  submitWithImage: (text: string, image: SelectedImage) => Promise<boolean>;
  /// iOS may suspend a terminal WebSocket while its native photo picker owns the
  /// foreground. Force a fresh attach when the picker returns rather than leaving
  /// the composer waiting for the old socket to notice that suspension.
  reconnect: () => void;
  sendKey: (key: TerminalKey) => void;
  /// Asks the running program to scroll its own history. Negative is backwards.
  ///
  /// This is the only way back past the current frame. The alternate screen has no
  /// scrollback: the program owns the grid and repaints it, so rows that left the frame
  /// were never held on the phone to scroll back to.
  scrollBack: (lines: number) => void;
}

export function useTerminalSession(
  connectionId: string | undefined,
  session: SessionDto | undefined,
): TerminalSession {
  const runtime = useMobileRuntime();
  const lifecycle = useAppLifecycle();
  const [buffer, setBuffer] = useState<TerminalBuffer>(emptyTerminalBuffer);
  const [error, setError] = useState<string | undefined>(undefined);
  const [imageError, setImageError] = useState<string | undefined>(undefined);
  const [reconnectRevision, setReconnectRevision] = useState(0);
  const attachment = useRef<TerminalAttachment | undefined>(undefined);
  const bufferRef = useRef<TerminalBuffer>(buffer);
  const outputTail = useRef<Uint8Array<ArrayBufferLike>>(new Uint8Array(0));
  /// Held in a ref, not in the effect's closure, because a scroll gesture needs to ask
  /// it what the program said about mouse tracking long after the attach ran.
  const projection = useRef<TerminalScreenProjection | undefined>(undefined);
  const submitTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const encoder = useMemo(() => new TextEncoder(), []);

  const sessionId = session?.id;
  const runtimeEpoch = session?.runtime_epoch;

  useEffect(() => {
    if (!lifecycle.active
      || connectionId === undefined || sessionId === undefined || runtimeEpoch === undefined) return;
    const continuityKey = terminalContinuityKey(connectionId, sessionId, runtimeEpoch);
    const cached = terminalContinuityCache.get(continuityKey);
    let active = true;
    let reconcilingReplay = cached !== undefined;
    let attachRetry: ReturnType<typeof setTimeout> | undefined;
    let attachRetryDelay = INITIAL_ATTACH_RETRY_MS;
    let ownedAttachment: TerminalAttachment | undefined;
    /// A fresh decoder per attachment. Carrying one across attachments would let a
    /// half-decoded character from the previous stream corrupt the first line of the
    /// next one.
    const decoder = new TextDecoder();
    const decode = (bytes: Uint8Array) => decoder.decode(bytes);
    projection.current = cached?.projection ?? new TerminalScreenProjection();
    outputTail.current = cached?.outputTail ?? new Uint8Array(0);
    bufferRef.current = cached?.buffer ?? emptyTerminalBuffer();
    setBuffer(bufferRef.current);
    setError(undefined);
    setImageError(undefined);

    /// One state update per event, not two. The projector's verdict is known before the
    /// reducer runs, so committing the reduced buffer and the screen separately would
    /// only publish a half-updated frame and double the renders a redraw-heavy TUI
    /// costs.
    const onEvent = (event: TerminalEvent) => {
      if (!active) return;
      if (event.type === "state" && event.state === "connected") {
        /// A write can fail in the narrow window before the socket's close event.
        /// The adapter reconnects from that failure; once the new socket is proven
        /// connected, the old delivery error must not keep the composer disabled.
        setError(undefined);
      }
      if (event.type === "reset") {
        /// The next frozen replay decides whether this is a continuation. Clearing
        /// now would recreate the stale-screen bug whenever iOS briefly suspended a
        /// healthy socket or the user returned from another route.
        reconcilingReplay = true;
        return;
      }
      let effectiveEvent = event;
      if (event.type === "replay" && reconcilingReplay) {
        const continuation = continueTerminalReplay(outputTail.current, event.bytes);
        reconcilingReplay = false;
        if (!continuation.continuous) {
          projection.current = new TerminalScreenProjection();
          outputTail.current = new Uint8Array(0);
          bufferRef.current = {
            ...emptyTerminalBuffer(),
            nextLineId: bufferRef.current.nextLineId,
          };
        }
        effectiveEvent = { type: "replay", bytes: continuation.bytes };
      } else if (event.type === "live") {
        reconcilingReplay = false;
      }
      const outputBytes = effectiveEvent.type === "replay" || effectiveEvent.type === "live"
        ? effectiveEvent.bytes
        : undefined;
      if (outputBytes !== undefined) {
        outputTail.current = appendTerminalOutputTail(outputTail.current, outputBytes);
      }
      const screen = outputBytes === undefined ? undefined : projection.current?.write(outputBytes);
      setBuffer((current) => {
        /// A failed continuity proof reset the ref before React entered this updater.
        /// Use that baseline instead of the stale state captured by the renderer.
        const baseline = bufferRef.current === current ? current : bufferRef.current;
        const next = reduceTerminalEvent(baseline, effectiveEvent, { decode, screenActive: screen !== undefined });
        /// Only an output chunk carries a verdict. A gap or a state change says nothing
        /// about who owns the display and must not clear a live screen.
        const presented = outputBytes === undefined ? next : withTerminalScreen(next, screen);
        bufferRef.current = presented;
        terminalContinuityCache.put(continuityKey, {
          buffer: presented,
          projection: projection.current!,
          outputTail: outputTail.current,
        });
        return presented;
      });
    };

    /// The runtime epoch is passed through unchanged. It is a fencing identity, not a
    /// counter, so the client neither compares nor increments it — it hands back the
    /// exact value the projection gave and lets the daemon refuse a stale one.
    const attach = () => {
      if (!active) return;
      runtime.terminal.attach(
        connectionId,
        { id: sessionId, runtime_epoch: runtimeEpoch },
        onEvent,
      ).then(
        (value) => {
          if (active) {
            ownedAttachment = value;
            attachment.current = value;
            attachRetryDelay = INITIAL_ATTACH_RETRY_MS;
            setError(undefined);
            /// The port promise resolves only after authentication. Reaffirm that
            /// fact at the hook boundary: a retained route can batch its old
            /// `reconnecting` cleanup after the adapter's first connected event.
            onEvent({ type: "state", state: "connected" });
          } else void value.detach();
        },
        () => {
          if (!active) return;
          setBuffer((current) => reduceTerminalEvent(current, {
            type: "state", state: "connectionLost",
          }, { decode }));
          setError(undefined);
          attachRetry = setTimeout(attach, attachRetryDelay);
          attachRetryDelay = Math.min(MAX_ATTACH_RETRY_MS, attachRetryDelay * 2);
        },
      );
    };
    attach();

    return () => {
      active = false;
      for (const timer of submitTimers.current) clearTimeout(timer);
      submitTimers.current.clear();
      if (attachRetry !== undefined) clearTimeout(attachRetry);
      const retainedProjection = projection.current;
      const detached = detachTerminalBuffer(bufferRef.current);
      bufferRef.current = detached;
      if (retainedProjection !== undefined) {
        terminalContinuityCache.put(continuityKey, {
          buffer: detached,
          projection: retainedProjection,
          outputTail: outputTail.current,
        });
      }
      projection.current = undefined;
      const open = ownedAttachment;
      if (attachment.current === open) attachment.current = undefined;
      if (open) void open.detach();
      setBuffer(detached);
    };
  }, [
    runtime,
    connectionId,
    sessionId,
    runtimeEpoch,
    reconnectRevision,
    lifecycle.active,
    lifecycle.foregroundRevision,
  ]);

  const canSend = buffer.stream === "live" && error === undefined;

  const deliver = useCallback(async (open: TerminalAttachment, bytes: Uint8Array): Promise<boolean> => {
    try {
      await open.input(bytes);
      return true;
    } catch (cause: unknown) {
      if (attachment.current === open) {
        setError(cause instanceof Error ? cause.message : "That input could not be delivered.");
      }
      return false;
    }
  }, []);

  const sendKey = useCallback((key: TerminalKey) => {
    const open = attachment.current;
    if (!canSend || open === undefined) return;
    void deliver(open, new Uint8Array(keyBytes[key]));
  }, [canSend, deliver]);

  const reconnect = useCallback(() => {
    const open = attachment.current;
    if (open === undefined) {
      setReconnectRevision((revision) => revision + 1);
      return;
    }
    void open.reconnect().catch(() => {
      if (attachment.current === open) {
        setReconnectRevision((revision) => revision + 1);
      }
    });
  }, []);

  const submit = useCallback((text: string) => {
    const open = attachment.current;
    if (!canSend || open === undefined || text.length === 0) return;
    void deliver(open, encoder.encode(text)).then((delivered) => {
      if (!delivered || attachment.current !== open) return;
      const timer = setTimeout(() => {
        submitTimers.current.delete(timer);
        if (attachment.current === open) {
          void deliver(open, new Uint8Array(keyBytes.enter));
        }
      }, SUBMIT_SETTLE_MS);
      submitTimers.current.add(timer);
    });
  }, [canSend, deliver, encoder]);

  const submitWithImage = useCallback(async (text: string, image: SelectedImage): Promise<boolean> => {
    if (!canSend || attachment.current === undefined || connectionId === undefined || sessionId === undefined) return false;
    let reconnectStarted = false;
    try {
      setImageError(undefined);
      const attachmentPath = await runtime.images.upload(connectionId, sessionId, image);
      /// The native picker and the HTTPS upload both cross iOS networking paths that
      /// can leave the earlier WebSocket looking open while it no longer carries PTY
      /// bytes. Prove a newly authenticated terminal transport before sending the
      /// generated attachment message; readyState alone is not delivery evidence.
      const open = attachment.current;
      if (open === undefined) throw new Error("Terminal is reconnecting.");
      reconnectStarted = true;
      await open.reconnect();
      if (attachment.current !== open) return false;
      const message = attachedImageMessage(attachmentPath, text);
      const delivered = await deliver(open, encoder.encode(message));
      if (!delivered || attachment.current !== open) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          submitTimers.current.delete(timer);
          if (attachment.current === open) void deliver(open, new Uint8Array(keyBytes.enter));
          resolve();
        }, SUBMIT_SETTLE_MS);
        submitTimers.current.add(timer);
      });
      return attachment.current === open;
    } catch (cause: unknown) {
      /// Even a failed HTTP upload may have invalidated the old iOS socket. Start a
      /// bounded refresh so ordinary typing recovers without closing the app.
      if (!reconnectStarted) reconnect();
      setImageError(cause instanceof Error ? cause.message : "The image could not be delivered.");
      return false;
    }
  }, [canSend, connectionId, deliver, encoder, reconnect, runtime.images, sessionId]);

  const scrollBack = useCallback((lines: number) => {
    const open = attachment.current;
    const current = projection.current;
    if (!canSend || open === undefined || current === undefined || lines === 0) return;
    const sequence = scrollSequence(lines, current.mouseTracking, current.sgrMouseEncoding);
    void deliver(open, encoder.encode(sequence));
  }, [canSend, deliver, encoder]);

  return {
    buffer,
    capNotice: terminalCapNotice(buffer),
    canSend,
    error,
    imageError,
    submit,
    submitWithImage,
    reconnect,
    sendKey,
    scrollBack,
  };
}
