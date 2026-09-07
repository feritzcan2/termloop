import type { TerminalPresentation, TerminalPresentationPort } from "../terminal-presentation.js";
import { TerminalWriteBatcher } from "./output-batcher.js";
import { TerminalOutputTail, continueReplay } from "./replay-continuity.js";
import { TerminalReplayBuffer } from "./replay-buffer.js";
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
import type { AppearanceTheme } from "../appearance-theme.js";

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
  presentation: TerminalPresentation;
  tail: TerminalOutputTail;
  batcher?: TerminalWriteBatcher;
  replay?: TerminalReplayBuffer;
  removeErrorListener?: (() => void) | undefined;
  readRevision: number;
  surface: TerminalSurface | undefined;
  attachment: TerminalAttachmentLike | undefined;
  attaching: Promise<void> | undefined;
  dimensions: { rows: number; cols: number } | undefined;
  mounted: boolean;
  mountToken: object | undefined;
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
  readonly #presentationListeners = new Set<() => void>();
  readonly presentationPort: TerminalPresentationPort = {
    subscribe: (listener) => { this.#presentationListeners.add(listener); return () => this.#presentationListeners.delete(listener); },
    snapshot: (id) => this.#entries.get(id)?.presentation,
    read: (id, enabled) => { void this.#read(id, enabled); },
    recover: (id) => { void this.#recover(id); },
  };

  #present(entry: Entry, patch: Partial<TerminalPresentation>): void {
    if (Object.entries(patch).every(([key, value]) => entry.presentation[key as keyof TerminalPresentation] === value)) return;
    entry.presentation = { ...entry.presentation, ...patch };
    for (const listener of this.#presentationListeners) listener();
  }

  async #read(id: string, enabled: boolean): Promise<void> {
    const entry = this.#entries.get(id);
    if (!entry?.surface) return;
    const revision = ++entry.readRevision;
    if (!enabled) {
      this.#present(entry, { reading: undefined, unread: false });
      entry.surface.setVisible?.(this.#visible && entry.presentation.reading === undefined);
      entry.surface.scrollToBottom?.();
      return;
    }
    entry.batcher?.flush();
    try {
      const text = await entry.surface.readText?.() ?? entry.surface.probe()?.text ?? "";
      if (revision !== entry.readRevision || !entry.mounted) return;
      this.#present(entry, { reading: text, unread: false });
      entry.surface.setVisible?.(false);
    } catch { this.#present(entry, { notice: "The reading view could not be captured." }); }
  }

  async #recover(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    const container = entry?.surface?.container?.();
    if (!entry || !container) return;
    this.#disposeRuntime(entry);
    entry.tail.clear();
    this.#present(entry, { phase: "connecting", reading: undefined, notice: "Reopening the available recent output." });
    await this.mount(id, container);
  }

  readonly #resizeOwnershipListeners = new Set<() => void>();
  #resizeOwnershipRevision = 0;
  #visible = true;
  #appearanceTheme: AppearanceTheme = "dark";

  constructor(
    private readonly surfaceFactory: TerminalSurfaceFactory,
    private readonly attachmentFactory: AttachmentFactory,
    private readonly diagnosticsEnabled = false,
    private readonly onImagePaste: (sessionId: string) => void = () => {},
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
        if (runtimeChanged) { entry.tail.clear(); this.#present(entry, { phase: "connecting", notice: "Terminal runtime changed.", reading: undefined }); }
        if (runtimeChanged && entry.mounted) {
          entry.mountToken = undefined;
          entry.surface?.unmount();
          entry.mounted = false;
        } else if (sessionHasAttachableTerminal(next) && entry.mounted) {
          void this.#ensureAttachment(entry);
        }
        if (lifecycleChanged && entry.mounted) {
          entry.surface?.setVisible?.(this.#visible && entry.presentation.reading === undefined);
        }
      }
    }
    for (const session of retained.values()) {
      if (!this.#entries.has(session.id)) {
        this.#entries.set(session.id, {
          session,
          presentation: { phase: "connecting" },
          tail: new TerminalOutputTail(),
          readRevision: 0,
          surface: undefined,
          attachment: undefined,
          attaching: undefined,
          dimensions: undefined,
          mounted: false,
          mountToken: undefined,
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
        () => this.onImagePaste(entry.session.id),
      );
      entry.surface.setAppearanceTheme?.(this.#appearanceTheme);
      const surface = entry.surface;
      entry.batcher = new TerminalWriteBatcher((bytes, done) => surface.write(bytes, done));
      entry.removeErrorListener = surface.onError?.(() => this.#present(entry, { phase: "failed", notice: "Terminal display stopped. Reopen the view to recover." }));
      entry.replay = new TerminalReplayBuffer((bytes, complete) => {
        const previous = entry.tail.snapshot();
        const continuation = continueReplay(previous, bytes);
        if (!complete) this.#present(entry, { notice: "Recent output is incomplete. Waiting for live output." });
        if (previous.length && !bytes.length) this.#present(entry, { notice: "Connection restored. Output produced while disconnected may be unavailable." });
        if (!continuation.continuous && bytes.length) {
          entry.tail.clear();
          surface.write(new Uint8Array([27, 99]), () => {});
          this.#present(entry, { notice: "Earlier output could not be matched. Showing available recent output." });
        }
        const ready = () => { if (entry.presentation.phase !== "failed") this.#present(entry, { phase: "live", progress: undefined }); };
        if (continuation.bytes.length) this.#write(entry, continuation.bytes, ready);
        else ready();
      }, (progress) => this.#present(entry, { phase: "replaying", progress }));
    }
    const mountToken = {};
    entry.mounted = true;
    entry.mountToken = mountToken;
    const surface = entry.surface;
    const mounting = surface.mount(container, true);
    if (mounting) await mounting;
    if (!entry.mounted || entry.mountToken !== mountToken || entry.surface !== surface) return;
    entry.surface.setVisible?.(this.#visible && entry.presentation.reading === undefined);
    if (sessionHasAttachableTerminal(entry.session)) {
      await this.#ensureAttachment(entry);
    }
  }

  unmount(sessionId: string): void {
    const entry = this.#entries.get(sessionId);
    if (!entry?.surface || !entry.mounted) return;
    entry.mountToken = undefined;
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
        entry.surface?.setVisible?.(visible && entry.presentation.reading === undefined);
      }
    }
  }

  setAppearanceTheme(theme: AppearanceTheme): void {
    if (this.#appearanceTheme === theme) return;
    this.#appearanceTheme = theme;
    for (const entry of this.#entries.values()) entry.surface?.setAppearanceTheme?.(theme);
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
        // MessagePort preserves send order. Put the real pane grid ahead of
        // onEvent(), which opens output credit and startup replay, so a TUI
        // cannot paint its first frame at the daemon's placeholder PTY size.
        if (entry.dimensions) attachment.resize(entry.dimensions.rows, entry.dimensions.cols);
        attachment.onEvent((event) => this.#handleEvent(entry, attachment, event));
      })
      .catch((error) => {
        // A process that ends between the attach request and its validation —
        // a run whose command fails at once, a shell the user just exited — is
        // reporting its own outcome, not a broken connection. The Session row
        // already states that it stopped, so a red transport error would only
        // obscure it. Every other failure stays visible.
        if (sessionStoppedDuringAttach(error)) return;
        this.#present(entry, { phase: "failed", notice: `Terminal connection failed: ${String(error)}` });
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
    if (!entry.surface || entry.attachment !== attachment) return;
    if (event.type === "inputDelivery") {
      this.#present(entry, { input: event.state, ...(event.state === "uncertain" ? { notice: "Input delivery unconfirmed. Check the terminal before sending again." } : {}) });
      return;
    }
    if (event.type === "gap") {
      entry.tail.clear();
      this.#present(entry, { notice: "Some output was skipped while this client was catching up." });
      return;
    }
    if (event.type === "inputRejected") {
      this.#present(entry, { notice: event.message, input: "uncertain" });
      return;
    }
    if (event.type === "state") {
      entry.batcher?.flush();
      if (event.state !== "connected") entry.replay?.cancel();
      this.#present(entry, { phase: event.state === "connected" || event.state === "connecting" ? "connecting" : "reconnecting", progress: undefined });
      return;
    }
    const bytes = new Uint8Array(event.data);
    if (event.kind === KIND_ACK) { entry.replay?.begin(bytes); return; }
    if (event.kind === KIND_REPLAY_OUTPUT && entry.replay?.accept(bytes)) {
      // Staging is separately bounded to 1 MiB. Release transport credit now so
      // a replay larger than the renderer credit window can finish atomically.
      attachment.acknowledge(bytes.length, true);
      return;
    }
    if (event.kind === KIND_OUTPUT || event.kind === KIND_REPLAY_OUTPUT) {
      entry.replay?.flush();
      this.#write(entry, bytes, () => attachment.acknowledge(bytes.length, event.kind === KIND_REPLAY_OUTPUT));
      this.#present(entry, { phase: "live", progress: undefined });
    } else if (event.kind === KIND_GAP) {
      if (!entry.replay?.accept()) entry.tail.clear();
      this.#present(entry, { notice: "Some earlier output is unavailable." });
    } else if (event.kind === KIND_EOF) {
      entry.replay?.accept();
      entry.replay?.flush();
      entry.batcher?.flush();
      this.#present(entry, { phase: "exited", progress: undefined });
    } else if (event.kind === KIND_ERROR) {
      this.#present(entry, { phase: "failed", notice: decoder.decode(event.data) });
    }
  }

  #write(entry: Entry, bytes: Uint8Array, done: () => void): void {
    entry.tail.append(bytes);
    if (entry.presentation.reading !== undefined) this.#present(entry, { unread: true });
    entry.batcher?.push(bytes, () => {
      done();
      const measurement = entry.measurement;
      if (!measurement) return;
      entry.measurement = undefined;
      clearTimeout(measurement.timeout);
      requestAnimationFrame(() => requestAnimationFrame(() => measurement.resolve(performance.now() - measurement.started)));
    });
  }

  #disposeRuntime(entry: Entry): void {
    if (entry.measurement) {
      clearTimeout(entry.measurement.timeout);
      entry.measurement.reject(new Error("terminal disposed during latency measurement"));
      entry.measurement = undefined;
    }
    this.#detachAttachment(entry);
    entry.removeErrorListener?.();
    entry.removeErrorListener = undefined;
    entry.surface?.dispose();
    entry.surface = undefined;
    entry.dimensions = undefined;
    entry.mountToken = undefined;
    entry.mounted = false;
  }

  #detachAttachment(entry: Entry): void {
    entry.batcher?.flush();
    entry.replay?.cancel();
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
