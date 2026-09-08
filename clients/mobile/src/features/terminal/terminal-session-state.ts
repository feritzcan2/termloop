import type { TerminalEvent } from "../../application/ports";
import { mobileDiagnostics } from "../../platform/mobile-diagnostics";
import {
  detachTerminalBuffer, emptyTerminalBuffer, reduceTerminalEvent, withTerminalScreen,
  type TerminalBuffer,
} from "../../presentation/terminal-buffer";
import { TerminalScreenProjection } from "../../presentation/terminal-screen";
import { appendTerminalOutputTail, continueTerminalReplay } from "./terminal-continuity";
import { projectTerminalOutput, TerminalEventQueue } from "./terminal-event-queue";

/// The cache owns parsing, while a visible route owns only its network attachment.
/// Leaving during a cooperative yield therefore finishes already received output
/// without keeping a socket or a React screen alive.
export class TerminalSessionState {
  buffer = emptyTerminalBuffer();
  outputTail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  projection = new TerminalScreenProjection();
  private attached = false;
  private disposed = false;
  private failed = false;
  private generation = 0;
  private reconcilingReplay = true;
  private readonly listeners = new Set<(buffer: TerminalBuffer) => void>();
  private readonly failureListeners = new Set<() => void>();
  private readonly decoder = new TextDecoder();
  private queue = this.createQueue();

  constructor(
    private readonly connectionId: string,
    private readonly sessionId: string,
    private readonly projectOutput = projectTerminalOutput,
  ) {}

  subscribe(listener: (buffer: TerminalBuffer) => void, onFailure: () => void): () => void {
    this.listeners.add(listener);
    this.failureListeners.add(onFailure);
    return () => {
      this.listeners.delete(listener);
      this.failureListeners.delete(onFailure);
    };
  }

  whenIdle(): Promise<void> { return this.queue.whenIdle(); }

  begin(): void {
    if (this.disposed) return;
    if (this.failed) {
      this.failed = false;
      this.projection = new TerminalScreenProjection();
      this.outputTail = new Uint8Array(0);
      this.queue = this.createQueue();
    }
    this.attached = true;
    this.push({ type: "reset" });
    this.push({ type: "state", state: "connecting" });
  }

  push(event: TerminalEvent): void {
    if (!this.disposed && !this.failed) this.queue.push(event);
  }

  detach(): void {
    this.attached = false;
    this.publish(detachTerminalBuffer(this.buffer));
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.queue.dispose();
    this.listeners.clear();
    this.failureListeners.clear();
  }

  private createQueue(): TerminalEventQueue {
    const generation = ++this.generation;
    return new TerminalEventQueue((event) => this.consume(event, generation), () => {
      if (this.disposed || generation !== this.generation) return;
      this.generation += 1;
      this.failed = true;
      mobileDiagnostics.report("terminal", "processing_failed", {
        connectionId: this.connectionId, sessionId: this.sessionId,
      });
      this.publish({ ...this.buffer, stream: "reconnecting", ready: false });
      for (const listener of this.failureListeners) listener();
    });
  }

  private publish(buffer: TerminalBuffer): void {
    this.buffer = this.attached ? buffer : detachTerminalBuffer(buffer);
    for (const listener of this.listeners) listener(this.buffer);
  }

  private async consume(event: TerminalEvent, generation: number): Promise<void> {
    const active = () => !this.disposed && generation === this.generation;
    if (!active()) return;
    if (event.type === "reset") {
      this.reconcilingReplay = true;
      return;
    }
    let effectiveEvent = event;
    let base = this.buffer;
    if (event.type === "replay" && this.reconcilingReplay) {
      const continuation = continueTerminalReplay(this.outputTail, event.bytes);
      this.reconcilingReplay = false;
      if (!continuation.continuous) {
        this.projection = new TerminalScreenProjection();
        this.outputTail = new Uint8Array(0);
        base = {
          ...emptyTerminalBuffer(),
          stream: this.buffer.stream,
          nextLineId: this.buffer.nextLineId,
          ...(this.buffer.outputRevision === undefined ? {} : {
            continuityNotice: "Earlier output could not be matched. Showing the available recent output.",
          }),
        };
      }
      effectiveEvent = { type: "replay", bytes: continuation.bytes };
    } else if (event.type === "live") {
      this.reconcilingReplay = false;
    }
    const bytes = effectiveEvent.type === "replay" || effectiveEvent.type === "live"
      ? effectiveEvent.bytes : undefined;
    const started = performance.now();
    const screen = bytes === undefined ? undefined
      : await this.projectOutput(this.projection, bytes, active);
    if (!active()) return;
    if (effectiveEvent.type === "replay") mobileDiagnostics.report("terminal", "replay_projected", {
      connectionId: this.connectionId, sessionId: this.sessionId,
      bytes: effectiveEvent.bytes.byteLength, durationMs: performance.now() - started,
    });
    if (bytes !== undefined) this.outputTail = appendTerminalOutputTail(this.outputTail, bytes);
    const next = reduceTerminalEvent(base, effectiveEvent, {
      decode: (value) => this.decoder.decode(value), screenActive: screen !== undefined,
    });
    this.publish(bytes === undefined ? next : withTerminalScreen(next, screen));
  }
}
