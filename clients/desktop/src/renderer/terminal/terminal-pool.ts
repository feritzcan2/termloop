import { sessionKeepsTerminalSurface, type Session } from "../model.js";
import {
  KIND_ACK,
  KIND_EOF,
  KIND_ERROR,
  KIND_GAP,
  KIND_OUTPUT,
  KIND_REPLAY_OUTPUT,
} from "../../utility/terminal-frame.js";
import type { AttachmentEvent } from "../transport/terminal-port.js";
import type { TerminalBufferProbe, TerminalSurface, TerminalSurfaceFactory } from "./surface.js";
import { connectionProfileIdOf } from "../../connection-scope.js";

export type TerminalAttachmentLike = {
  onEvent(listener: (event: AttachmentEvent) => void): () => void;
  input(data: string | Uint8Array): boolean;
  resize(rows: number, cols: number): void;
  focus(): void;
  acknowledge(bytes: number, startupReplay: boolean): void;
  dispose(): void;
};
type AttachmentFactory = (session: Session) => Promise<TerminalAttachmentLike>;
type Entry = {
  session: Session;
  surface: TerminalSurface | undefined;
  attachment: TerminalAttachmentLike | undefined;
  attaching: Promise<void> | undefined;
  dimensions: { rows: number; cols: number } | undefined;
  mounted: boolean;
  resizeOwner: boolean | undefined;
  measurement: { started: number; resolve(value: number): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> } | undefined;
};

const decoder = new TextDecoder();

/// The daemon refuses an attach whose Session is no longer running. When that
/// happens moments after a launch, the process simply exited first.
export function sessionStoppedDuringAttach(error: unknown): boolean {
  return String(error).includes("sessionNotRunning");
}

function sessionHasAttachableTerminal(session: Session): boolean {
  // Core projects the exact provisional runtime epoch while an Agent resumes,
  // allowing the user to see and answer provider startup prompts before
  // structured readiness. A failed resume publishes its failure only after
  // that PTY has been reaped, so the existing surface then preserves whatever
  // startup output it already rendered without attaching to a missing runtime.
  return session.lifecycle_state === "running"
    || (session.kind === "Agent"
      && session.lifecycle_state === "resuming")
    || (session.kind === "Agent"
      && session.lifecycle_state === "exited");
}

export class TerminalPool {
  readonly #entries = new Map<string, Entry>();
  readonly #resizeOwnershipListeners = new Set<() => void>();
  #resizeOwnershipRevision = 0;
  #visible = true;

  constructor(
    private readonly surfaceFactory: TerminalSurfaceFactory,
    private readonly attachmentFactory: AttachmentFactory,
    private readonly diagnosticsEnabled = false,
  ) {}

  reconcile(sessions: readonly Session[]): void {
    const retained = new Map(sessions
      .filter(sessionKeepsTerminalSurface)
      .map((session) => [session.id, session]));
    for (const [id, entry] of this.#entries) {
      const next = retained.get(id);
      if (!next) {
        this.#disposeEntry(entry);
        this.#entries.delete(id);
      } else {
        const lifecycleChanged = next.lifecycle_state !== entry.session.lifecycle_state;
        const runtimeChanged = next.runtime_epoch !== entry.session.runtime_epoch;
        entry.session = next;
        if (runtimeChanged || (lifecycleChanged && next.lifecycle_state !== "running")) {
          // A process lifecycle change may retire an attachment, but the
          // user-owned terminal surface and its scrollback remain until the
          // Session descriptor itself is explicitly closed.
          this.#detachAttachment(entry);
        }
        if (runtimeChanged && entry.mounted) {
          entry.surface?.unmount();
          entry.mounted = false;
        } else if (sessionHasAttachableTerminal(next) && entry.mounted) {
          void this.#ensureAttachment(entry);
        }
        if (lifecycleChanged && entry.mounted) {
          entry.surface?.setVisible?.(this.#visible);
        }
      }
    }
    for (const session of retained.values()) {
      if (!this.#entries.has(session.id)) {
        this.#entries.set(session.id, {
          session,
          surface: undefined,
          attachment: undefined,
          attaching: undefined,
          dimensions: undefined,
          mounted: false,
          resizeOwner: undefined,
          measurement: undefined,
        });
      }
    }
  }

  async mount(sessionId: string, container: HTMLElement): Promise<void> {
    const entry = this.#entries.get(sessionId);
    if (!entry) throw new Error("session is not in terminal pool");
    if (!entry.surface) {
      entry.surface = this.surfaceFactory(
        (data) => entry.attachment?.input(data),
        (rows, cols) => {
          entry.dimensions = { rows, cols };
          entry.attachment?.resize(rows, cols);
        },
      );
    }
    entry.mounted = true;
    entry.surface.mount(container, true);
    entry.surface.setVisible?.(this.#visible);
    if (sessionHasAttachableTerminal(entry.session)) {
      await this.#ensureAttachment(entry);
    }
  }

  unmount(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    if (!entry?.surface || !entry.mounted) return;
    entry.mounted = false;
    entry.surface.unmount();
  }

  focus(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    entry?.attachment?.focus();
    entry?.surface?.focus();
  }

  subscribeResizeOwnership = (listener: () => void): (() => void) => {
    this.#resizeOwnershipListeners.add(listener);
    return () => this.#resizeOwnershipListeners.delete(listener);
  };

  resizeOwnershipRevision = (): number => this.#resizeOwnershipRevision;

  resizeOwnership(sessionId: string): boolean | undefined {
    return this.#entries.get(sessionId)?.resizeOwner;
  }

  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    for (const entry of this.#entries.values()) {
      if (entry.mounted) {
        entry.surface?.setVisible?.(visible);
      }
    }
  }

  async submitInput(sessionId: string, data: string): Promise<void> {
    const entry = this.#entries.get(sessionId);
    if (!entry || entry.session.lifecycle_state !== "running") {
      throw new Error("target Session is no longer running");
    }
    if (!entry.surface || !entry.mounted) {
      throw new Error("target Session is not mounted");
    }
    const runtimeEpoch = entry.session.runtime_epoch;
    await this.#ensureAttachment(entry);
    if (entry.session.runtime_epoch !== runtimeEpoch || !entry.attachment) {
      throw new Error("target Session changed before input could be delivered");
    }
    if (!entry.attachment.input(data)) {
      throw new Error("terminal input queue rejected the review notes");
    }
  }

  probe(sessionId: string): TerminalBufferProbe | undefined {
    return this.#entries.get(sessionId)?.surface?.probe();
  }

  async diagnosticText(sessionId: string): Promise<string | undefined> {
    if (!this.diagnosticsEnabled) throw new Error("terminal diagnostics are disabled");
    const surface = this.#entries.get(sessionId)?.surface;
    if (!surface) return undefined;
    return surface.diagnosticText ? surface.diagnosticText() : surface.probe()?.text;
  }

  state(sessionId: string): "live" | "warm" | "cold" | undefined {
    const entry = this.#entries.get(sessionId);
    if (!entry) return undefined;
    if (entry.mounted) return "live";
    return entry.surface ? "warm" : "cold";
  }

  async measureEcho(sessionId: string): Promise<number> {
    if (!this.diagnosticsEnabled) throw new Error("terminal diagnostics are disabled");
    const entry = this.#entries.get(sessionId);
    if (!entry?.attachment || !entry.surface || !entry.mounted) throw new Error("terminal is not ready for latency measurement");
    if (entry.measurement) throw new Error("terminal latency measurement is already running");
    const result = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (entry.measurement?.timeout === timeout) entry.measurement = undefined;
        reject(new Error("terminal echo measurement timed out"));
      }, 5_000);
      entry.measurement = { started: performance.now(), resolve, reject, timeout };
    });
    entry.attachment.input("x");
    return result;
  }

  clearInputLine(sessionId: string): void {
    if (!this.diagnosticsEnabled) throw new Error("terminal diagnostics are disabled");
    this.#entries.get(sessionId)?.attachment?.input("\u0015");
  }

  dispose(): void {
    for (const entry of this.#entries.values()) this.#disposeEntry(entry);
    this.#entries.clear();
  }

  reconnectAttachments(profileId?: string): void {
    for (const entry of this.#entries.values()) {
      if (profileId && connectionProfileIdOf(entry.session) !== profileId) continue;
      this.#detachAttachment(entry);
      if (entry.surface && sessionHasAttachableTerminal(entry.session)) {
        void this.#ensureAttachment(entry);
      }
    }
  }

  async #ensureAttachment(entry: Entry): Promise<void> {
    if (!sessionHasAttachableTerminal(entry.session)) return;
    if (entry.attachment || entry.attaching) return entry.attaching;
    const surface = entry.surface;
    const runtimeEpoch = entry.session.runtime_epoch;
    const pending = this.attachmentFactory(entry.session)
      .then((attachment) => {
        if (
          entry.attaching !== pending
          || entry.surface !== surface
          || entry.session.runtime_epoch !== runtimeEpoch
          || !sessionHasAttachableTerminal(entry.session)
        ) {
          attachment.dispose();
          return;
        }
        entry.attachment = attachment;
        attachment.onEvent((event) => this.#handleEvent(entry, attachment, event));
        if (entry.dimensions) attachment.resize(entry.dimensions.rows, entry.dimensions.cols);
      })
      .catch((error) => {
        // A process that ends between the attach request and its validation —
        // a run whose command fails at once, a shell the user just exited — is
        // reporting its own outcome, not a broken connection. The Session row
        // already states that it stopped, so a red transport error would only
        // obscure it. Every other failure stays visible.
        if (sessionStoppedDuringAttach(error)) return;
        entry.surface?.writeln(`\u001b[31m[terminal connection failed: ${String(error)}]\u001b[0m`);
      })
      .finally(() => {
        if (entry.attaching === pending) entry.attaching = undefined;
      });
    entry.attaching = pending;
    return pending;
  }

  #handleEvent(entry: Entry, attachment: TerminalAttachmentLike, event: AttachmentEvent): void {
    if (event.type === "resizeOwnership") {
      if (entry.resizeOwner !== event.active) {
        entry.resizeOwner = event.active;
        this.#resizeOwnershipRevision += 1;
        for (const listener of this.#resizeOwnershipListeners) listener();
      }
      return;
    }
    if (!entry.surface) return;
    if (event.type === "gap") {
      entry.surface.writeln("\u001b[33m[output gap — client was slow]\u001b[0m");
      return;
    }
    if (event.type === "inputRejected") {
      entry.surface.writeln(`\u001b[31m[${event.message}]\u001b[0m`);
      return;
    }
    if (event.type === "state") {
      // Transport state belongs to connection chrome, not the PTY byte
      // stream. Writing retry attempts into the terminal permanently polluted
      // scrollback and produced one red line for every reconnect backoff tick.
      return;
    }
    if (event.kind === KIND_OUTPUT || event.kind === KIND_REPLAY_OUTPUT) {
      const bytes = new Uint8Array(event.data);
      entry.surface.write(bytes, () => {
        attachment.acknowledge(bytes.byteLength, event.kind === KIND_REPLAY_OUTPUT);
        const measurement = entry.measurement;
        if (!measurement) return;
        entry.measurement = undefined;
        clearTimeout(measurement.timeout);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          measurement.resolve(performance.now() - measurement.started);
        }));
      });
    } else if (event.kind === KIND_GAP) {
      entry.surface.writeln("\u001b[33m[daemon output gap]\u001b[0m");
    } else if (event.kind === KIND_EOF) {
      if (entry.session.kind !== "Agent") entry.surface.writeln("\u001b[90m[process exited]\u001b[0m");
    } else if (event.kind === KIND_ERROR) {
      entry.surface.writeln(`\u001b[31m[${decoder.decode(event.data)}]\u001b[0m`);
    } else if (event.kind === KIND_ACK) {
      // Attachment is live; no terminal text is needed.
    }
  }

  #disposeRuntime(entry: Entry): void {
    if (entry.measurement) {
      clearTimeout(entry.measurement.timeout);
      entry.measurement.reject(new Error("terminal disposed during latency measurement"));
      entry.measurement = undefined;
    }
    this.#detachAttachment(entry);
    entry.surface?.dispose();
    entry.surface = undefined;
    entry.dimensions = undefined;
    entry.mounted = false;
  }

  #detachAttachment(entry: Entry): void {
    entry.attachment?.dispose();
    entry.attachment = undefined;
    entry.attaching = undefined;
    if (entry.resizeOwner !== undefined) {
      entry.resizeOwner = undefined;
      this.#resizeOwnershipRevision += 1;
      for (const listener of this.#resizeOwnershipListeners) listener();
    }
  }

  #disposeEntry(entry: Entry): void {
    this.#disposeRuntime(entry);
  }
}
