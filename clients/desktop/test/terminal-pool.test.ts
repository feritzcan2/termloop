import { describe, expect, it } from "vitest";
import type { Session } from "../src/renderer/model.js";
import type { AttachmentEvent } from "../src/renderer/transport/terminal-port.js";
import {
  TerminalPool,
  type TerminalAttachmentLike,
} from "../src/renderer/terminal/terminal-pool.js";
import type {
  TerminalBufferProbe,
  TerminalSurface,
} from "../src/renderer/terminal/surface.js";
import { KIND_OUTPUT, KIND_REPLAY_OUTPUT } from "../src/utility/terminal-frame.js";

class FakeSurface implements TerminalSurface {
  mounted = false;
  disposed = false;
  markers: string[] = [];
  visibility: boolean[] = [];
  appearanceThemes: Array<"dark" | "light"> = [];
  probeValue: TerminalBufferProbe = { lines: 1, cursorX: 0, cursorY: 0, text: "", bufferType: "normal", mouseTrackingMode: "none" };
  constructor(private readonly initialResize?: { callback(rows: number, cols: number): void; rows: number; cols: number }) {}
  mount(): void {
    this.mounted = true;
    this.initialResize?.callback(this.initialResize.rows, this.initialResize.cols);
  }
  unmount(): void { this.mounted = false; }
  write(data: Uint8Array, callback: () => void): void {
    this.probeValue.lines += new TextDecoder().decode(data).split("\n").length - 1;
    this.probeValue.cursorX += data.byteLength;
    this.probeValue.text += new TextDecoder().decode(data);
    callback();
  }
  writeln(message: string): void { this.markers.push(message); this.probeValue.lines += 1; this.probeValue.text += `${message}\n`; }
  focus(): void {}
  setVisible(visible: boolean): void { this.visibility.push(visible); }
  setAppearanceTheme(theme: "dark" | "light"): void { this.appearanceThemes.push(theme); }
  probe(): TerminalBufferProbe { return { ...this.probeValue }; }
  dispose(): void { this.disposed = true; this.mounted = false; }
}

class FakeAttachment implements TerminalAttachmentLike {
  listener: ((event: AttachmentEvent) => void) | undefined;
  disposed = false;
  acknowledged = 0;
  replayAcknowledged = 0;
  resizes: Array<{ rows: number; cols: number }> = [];
  focuses = 0;
  inputs: string[] = [];
  acceptInput = true;
  operations: string[] = [];
  onEvent(listener: (event: AttachmentEvent) => void): () => void {
    this.operations.push("listen");
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  input(data: string): boolean {
    if (!this.acceptInput) return false;
    this.inputs.push(data);
    return true;
  }
  resize(rows: number, cols: number): void {
    this.operations.push("resize");
    this.resizes.push({ rows, cols });
  }
  focus(): void { this.focuses += 1; }
  acknowledge(bytes: number, startupReplay: boolean): void {
    this.acknowledged += bytes;
    if (startupReplay) this.replayAcknowledged += bytes;
  }
  dispose(): void { this.disposed = true; this.listener = undefined; }
  emit(event: AttachmentEvent): void { this.listener?.(event); }
}

function session(id: string, projectId = "project-a"): Session {
  return {
    id,
    project_id: projectId,
    name: null,
    kind: "Terminal",
    lifecycle_state: "running",
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    process: {
      program: "/bin/sh",
      args: [],
      cwd: `/tmp/${projectId}`,
      agent_id: null,
      template_ref: null,
      template_version: null,
    },
  };
}

function agentSession(id: string, projectId = "project-a"): Session {
  return {
    ...session(id, projectId),
    kind: "Agent",
    process: {
      program: "claude",
      args: [],
      cwd: `/tmp/${projectId}`,
      agent_id: "claude",
      template_ref: "builtin.agent.interactive",
      template_version: 4,
    },
  };
}

describe("TerminalPool", () => {
  it("applies appearance changes to existing and newly created surfaces", async () => {
    const surfaces: FakeSurface[] = [];
    const pool = new TerminalPool(() => {
      const surface = new FakeSurface();
      surfaces.push(surface);
      return surface;
    }, async () => new FakeAttachment());
    pool.reconcile([session("one"), session("two")]);
    pool.setAppearanceTheme("light");

    await pool.mount("one", {} as HTMLElement);
    expect(surfaces[0]?.appearanceThemes).toEqual(["light"]);

    pool.setAppearanceTheme("dark");
    expect(surfaces[0]?.appearanceThemes).toEqual(["light", "dark"]);
    await pool.mount("two", {} as HTMLElement);
    expect(surfaces[1]?.appearanceThemes).toEqual(["dark"]);
  });

  it("discards a superseded attachment even when its promise resolves last", async () => {
    const pending: Array<{ attachment: FakeAttachment; resolve(value: FakeAttachment): void }> = [];
    const value = session("003e4567-e89b-12d3-a456-426614174000");
    const pool = new TerminalPool(
      () => new FakeSurface(),
      () => new Promise<FakeAttachment>((resolve) => {
        pending.push({ attachment: new FakeAttachment(), resolve });
      }),
    );
    pool.reconcile([value]);

    const firstMount = pool.mount(value.id, {} as HTMLElement);
    expect(pending).toHaveLength(1);
    pool.reconnectAttachments();
    expect(pending).toHaveLength(2);

    pending[1]!.resolve(pending[1]!.attachment);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[0]!.resolve(pending[0]!.attachment);
    await firstMount;
    await pool.submitInput(value.id, "new attachment");

    expect(pending[0]!.attachment.disposed).toBe(true);
    expect(pending[0]!.attachment.inputs).toEqual([]);
    expect(pending[1]!.attachment.disposed).toBe(false);
    expect(pending[1]!.attachment.inputs).toEqual(["new attachment"]);
  });

  it("claims resize ownership on focus and publishes ownership changes", async () => {
    const attachment = new FakeAttachment();
    const value = session("013e4567-e89b-12d3-a456-426614174000");
    const pool = new TerminalPool(() => new FakeSurface(), async () => attachment);
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);

    const revisions: number[] = [];
    const unsubscribe = pool.subscribeResizeOwnership(() => revisions.push(pool.resizeOwnershipRevision()));
    attachment.emit({ type: "resizeOwnership", active: false });
    expect(pool.resizeOwnership(value.id)).toBe(false);
    pool.focus(value.id);
    expect(attachment.focuses).toBe(1);
    attachment.emit({ type: "resizeOwnership", active: true });
    expect(pool.resizeOwnership(value.id)).toBe(true);
    expect(revisions).toEqual([1, 2]);
    unsubscribe();
  });

  it("binds an image paste intent to the exact mounted Session", async () => {
    const value = agentSession("013e4567-e89b-42d3-a456-426614174001");
    const pasted: string[] = [];
    let triggerImagePaste!: () => void;
    const pool = new TerminalPool(
      (_onInput, _onResize, onImagePaste) => {
        triggerImagePaste = onImagePaste;
        return new FakeSurface();
      },
      async () => new FakeAttachment(),
      false,
      (sessionId) => pasted.push(sessionId),
    );
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);

    triggerImagePaste();

    expect(pasted).toEqual([value.id]);
  });

  it("forwards a fit that occurs before the asynchronous attachment is ready", async () => {
    const attachment = new FakeAttachment();
    const value = session("023e4567-e89b-12d3-a456-426614174000");
    const pool = new TerminalPool(
      (_onInput, onResize) => new FakeSurface({ callback: onResize, rows: 61, cols: 154 }),
      async () => attachment,
    );
    pool.reconcile([value]);

    await pool.mount(value.id, {} as HTMLElement);

    expect(attachment.resizes).toEqual([{ rows: 61, cols: 154 }]);
    expect(attachment.operations.slice(0, 2)).toEqual(["resize", "listen"]);
  });

  it("waits for an asynchronous initial surface measurement before attaching", async () => {
    const attachment = new FakeAttachment();
    const value = session("023e4567-e89b-12d3-a456-426614174010");
    let finishMount!: () => void;
    let attachCalls = 0;
    const pool = new TerminalPool(
      (_onInput, onResize) => ({
        mount: () => new Promise<void>((resolve) => {
          finishMount = () => {
            onResize(47, 132);
            resolve();
          };
        }),
        unmount: () => {},
        write: (_data, callback) => callback(),
        writeln: () => {},
        focus: () => {},
        probe: () => undefined,
        dispose: () => {},
      }),
      async () => {
        attachCalls += 1;
        return attachment;
      },
    );
    pool.reconcile([value]);

    const mounted = pool.mount(value.id, {} as HTMLElement);
    await Promise.resolve();
    expect(attachCalls).toBe(0);

    finishMount();
    await mounted;

    expect(attachCalls).toBe(1);
    expect(attachment.resizes).toEqual([{ rows: 47, cols: 132 }]);
    expect(attachment.operations.slice(0, 2)).toEqual(["resize", "listen"]);
  });

  it("does not attach after an asynchronous mount was superseded", async () => {
    const value = session("023e4567-e89b-12d3-a456-426614174011");
    let finishMount!: () => void;
    let attachCalls = 0;
    const pool = new TerminalPool(
      () => ({
        mount: () => new Promise<void>((resolve) => { finishMount = resolve; }),
        unmount: () => {},
        write: (_data, callback) => callback(),
        writeln: () => {},
        focus: () => {},
        probe: () => undefined,
        dispose: () => {},
      }),
      async () => {
        attachCalls += 1;
        return new FakeAttachment();
      },
    );
    pool.reconcile([value]);

    const mounted = pool.mount(value.id, {} as HTMLElement);
    await Promise.resolve();
    pool.unmount(value.id);
    finishMount();
    await mounted;

    expect(attachCalls).toBe(0);
  });

  it("submits bounded programmatic input only to a mounted running Session", async () => {
    const attachment = new FakeAttachment();
    const value = session("023e4567-e89b-12d3-a456-426614174001");
    const pool = new TerminalPool(() => new FakeSurface(), async () => attachment);
    pool.reconcile([value]);

    await expect(pool.submitInput(value.id, "review")).rejects.toThrow("not mounted");
    await pool.mount(value.id, {} as HTMLElement);
    await pool.submitInput(value.id, "review");

    expect(attachment.inputs).toEqual(["review"]);
  });

  it("sends no bytes after a runtime change or bounded input rejection", async () => {
    const firstAttachment = new FakeAttachment();
    const secondAttachment = new FakeAttachment();
    secondAttachment.acceptInput = false;
    const value = session("023e4567-e89b-12d3-a456-426614174002");
    let attachment = firstAttachment;
    const pool = new TerminalPool(() => new FakeSurface(), async () => attachment);
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);

    pool.reconcile([{ ...value, runtime_epoch: 2 }]);
    await expect(pool.submitInput(value.id, "stale")).rejects.toThrow("not mounted");
    expect(firstAttachment.inputs).toEqual([]);

    attachment = secondAttachment;
    await pool.mount(value.id, {} as HTMLElement);
    await expect(pool.submitInput(value.id, "too much")).rejects.toThrow("queue rejected");
    expect(secondAttachment.inputs).toEqual([]);
  });

  it("reconciles incrementally and preserves a warm terminal across Project switches", async () => {
    const surfaces = new Map<string, FakeSurface>();
    const attachments = new Map<string, FakeAttachment>();
    let activeId = "";
    const pool = new TerminalPool(
      () => {
        const surface = new FakeSurface();
        surfaces.set(activeId, surface);
        return surface;
      },
      async (value) => {
        const attachment = new FakeAttachment();
        attachments.set(value.id, attachment);
        return attachment;
      },
    );
    const first = session("123e4567-e89b-12d3-a456-426614174000", "project-a");
    const second = session("223e4567-e89b-12d3-a456-426614174000", "project-b");
    pool.reconcile([first, second]);
    activeId = first.id;
    await pool.mount(first.id, {} as HTMLElement);
    const output = new TextEncoder().encode("one\ntwo\n");
    attachments.get(first.id)!.emit({ type: "frame", kind: KIND_OUTPUT, data: output.buffer });
    const before = pool.probe(first.id);
    pool.unmount(first.id);
    activeId = second.id;
    await pool.mount(second.id, {} as HTMLElement);
    pool.unmount(second.id);
    activeId = first.id;
    await pool.mount(first.id, {} as HTMLElement);

    expect(pool.probe(first.id)).toEqual(before);
    expect(pool.state(first.id)).toBe("live");
    expect(surfaces.size).toBe(2);
    expect(attachments.get(first.id)!.acknowledged).toBe(output.byteLength);
    expect(attachments.get(first.id)!.replayAcknowledged).toBe(0);

    attachments.get(first.id)!.emit({ type: "frame", kind: KIND_REPLAY_OUTPUT, data: output.buffer });
    expect(attachments.get(first.id)!.replayAcknowledged).toBe(output.byteLength);
  });

  it("reconnects attachments only for the gateway source that changed", async () => {
    const attachments = new Map<string, FakeAttachment[]>();
    const pool = new TerminalPool(
      () => new FakeSurface(),
      async (value) => {
        const attachment = new FakeAttachment();
        attachments.set(value.id, [...attachments.get(value.id) ?? [], attachment]);
        return attachment;
      },
    );
    const local = { ...session("local-session"), connectionProfileId: "local" };
    const remoteProfileId = "123e4567-e89b-42d3-a456-426614174000";
    const remote = { ...session("remote-session"), connectionProfileId: remoteProfileId };
    pool.reconcile([local, remote]);
    await Promise.all([
      pool.mount(local.id, {} as HTMLElement),
      pool.mount(remote.id, {} as HTMLElement),
    ]);

    pool.reconnectAttachments(remoteProfileId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(attachments.get(local.id)).toHaveLength(1);
    expect(attachments.get(local.id)?.[0]?.disposed).toBe(false);
    expect(attachments.get(remote.id)).toHaveLength(2);
    expect(attachments.get(remote.id)?.[0]?.disposed).toBe(true);
    expect(attachments.get(remote.id)?.[1]?.disposed).toBe(false);
  });

  it("keeps transport reconnect attempts out of terminal scrollback", async () => {
    const surface = new FakeSurface();
    const attachment = new FakeAttachment();
    const value = session("223e4567-e89b-12d3-a456-426614174099");
    const pool = new TerminalPool(() => surface, async () => attachment);
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);

    attachment.emit({ type: "state", state: "connected" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      attachment.emit({ type: "state", state: "connecting" });
      attachment.emit({ type: "state", state: "connectionLost" });
    }
    attachment.emit({ type: "state", state: "gatewayProcessLost" });

    expect(surface.markers).toEqual([]);
    expect(surface.probeValue.text).toBe("");
  });

  it("keeps an opened Agent surface visible across resume failure without attaching a missing runtime", async () => {
    const surfaces: FakeSurface[] = [];
    const attachments: FakeAttachment[] = [];
    const pool = new TerminalPool(
      () => {
        const surface = new FakeSurface();
        surfaces.push(surface);
        return surface;
      },
      async () => {
        const attachment = new FakeAttachment();
        attachments.push(attachment);
        return attachment;
      },
    );
    const running = agentSession("323e4567-e89b-12d3-a456-426614174099");
    pool.reconcile([running]);
    await pool.mount(running.id, {} as HTMLElement);
    const output = new TextEncoder().encode("last visible agent output\n");
    attachments[0]!.emit({ type: "frame", kind: KIND_OUTPUT, data: output.buffer });

    pool.reconcile([{
      ...running,
      lifecycle_state: "resumeFailed",
      resume_failure_reason: "startupTimedOut",
      retryable: true,
      closable: true,
    }]);

    expect(pool.state(running.id)).toBe("live");
    expect(pool.probe(running.id)?.text).toContain("last visible agent output");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.disposed).toBe(false);
    expect(surfaces[0]!.visibility.at(-1)).toBe(true);
    expect(attachments[0]!.disposed).toBe(true);
    expect(attachments).toHaveLength(1);

    pool.reconcile([{ ...running, runtime_epoch: 2 }]);
    await pool.mount(running.id, {} as HTMLElement);

    expect(surfaces).toHaveLength(1);
    expect(pool.probe(running.id)?.text).toContain("last visible agent output");
    expect(attachments).toHaveLength(2);
    expect(surfaces[0]!.visibility.at(-1)).toBe(true);
  });

  it("attaches the provisional Agent runtime so a resume startup prompt stays visible and interactive", async () => {
    const attachments: FakeAttachment[] = [];
    let sendInput: ((data: string | Uint8Array) => void) | undefined;
    const pool = new TerminalPool(
      (onInput) => {
        sendInput = onInput;
        return new FakeSurface();
      },
      async () => {
        const attachment = new FakeAttachment();
        attachments.push(attachment);
        return attachment;
      },
    );
    const failed = {
      ...agentSession("383e4567-e89b-12d3-a456-426614174099"),
      lifecycle_state: "resumeFailed" as const,
      resume_failure_reason: "startupTimedOut" as const,
      retryable: true,
      closable: true,
    };
    pool.reconcile([failed]);
    await pool.mount(failed.id, {} as HTMLElement);
    expect(attachments).toHaveLength(0);

    const resuming = {
      ...failed,
      lifecycle_state: "resuming" as const,
      runtime_epoch: 2,
      resume_failure_reason: null,
      retryable: false,
      closable: false,
    };
    pool.reconcile([resuming]);
    await pool.mount(resuming.id, {} as HTMLElement);

    const prompt = new TextEncoder().encode("Trust this worktree? [y/N]");
    attachments[0]!.emit({ type: "frame", kind: KIND_OUTPUT, data: prompt.buffer });
    sendInput?.("y\r");

    expect(pool.probe(resuming.id)?.text).toContain("Trust this worktree?");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.inputs).toEqual(["y\r"]);
  });

  it("keeps a newly mounted stopped Agent attached as a real terminal", async () => {
    const surface = new FakeSurface();
    const attachment = new FakeAttachment();
    let sendInput: ((data: string | Uint8Array) => void) | undefined;
    const pool = new TerminalPool((onInput) => {
      sendInput = onInput;
      return surface;
    }, async () => attachment);
    const stopped = {
      ...agentSession("423e4567-e89b-12d3-a456-426614174099"),
      lifecycle_state: "exited" as const,
      retryable: true,
      closable: true,
    };
    pool.reconcile([stopped]);

    await pool.mount(stopped.id, {} as HTMLElement);

    expect(pool.state(stopped.id)).toBe("live");
    expect(surface.mounted).toBe(true);
    expect(surface.visibility).toEqual([true]);
    expect(attachment.disposed).toBe(false);
    sendInput?.("echo still-interactive\n");
    expect(attachment.inputs).toEqual(["echo still-interactive\n"]);
  });

  it("keeps every opened terminal warm until its descriptor is explicitly removed", async () => {
    const surfaces: FakeSurface[] = [];
    const pool = new TerminalPool(
      () => {
        const surface = new FakeSurface();
        surfaces.push(surface);
        return surface;
      },
      async () => new FakeAttachment(),
    );
    const sessions = Array.from({ length: 6 }, (_, index) =>
      session(`${String(index + 1).padStart(8, "0")}-e89b-12d3-a456-426614174000`),
    );
    pool.reconcile(sessions);
    for (const value of sessions) {
      await pool.mount(value.id, {} as HTMLElement);
      pool.unmount(value.id);
    }
    expect(pool.state(sessions[0]!.id)).toBe("warm");
    await pool.mount(sessions[0]!.id, {} as HTMLElement);
    expect(surfaces).toHaveLength(sessions.length);
    expect(surfaces[0]!.disposed).toBe(false);
  });

  it("preserves an ordinary terminal and its scrollback when the process exits", async () => {
    const surface = new FakeSurface();
    const attachment = new FakeAttachment();
    const pool = new TerminalPool(() => surface, async () => attachment);
    const running = session("523e4567-e89b-12d3-a456-426614174099");
    pool.reconcile([running]);
    await pool.mount(running.id, {} as HTMLElement);
    const output = new TextEncoder().encode("dev server ready\n");
    attachment.emit({ type: "frame", kind: KIND_OUTPUT, data: output.buffer });

    pool.reconcile([{
      ...running,
      lifecycle_state: "exited",
      closable: true,
    }]);

    expect(pool.state(running.id)).toBe("live");
    expect(pool.probe(running.id)?.text).toContain("dev server ready");
    expect(surface.disposed).toBe(false);
    expect(attachment.disposed).toBe(true);

    pool.reconcile([]);
    expect(pool.state(running.id)).toBeUndefined();
    expect(surface.disposed).toBe(true);
  });

  /// A run whose command fails exits within milliseconds of launching, so the
  /// attach it triggered is validated after the process is already gone. That
  /// is the run reporting its own outcome — its Session row states the exit —
  /// and painting a red transport error over it hides what actually happened.
  it("stays quiet when the process exits before its attach is validated", async () => {
    const surface = new FakeSurface();
    const value = session("023e4567-e89b-12d3-a456-42661417400a");
    const pool = new TerminalPool(
      () => surface,
      async () => { throw new Error("Error invoking remote method 'termloop:terminal-attach': Error: sessionNotRunning"); },
    );
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(surface.probeValue.text).not.toContain("terminal connection failed");
  });

  it("still reports a genuine transport failure", async () => {
    const surface = new FakeSurface();
    const value = session("023e4567-e89b-12d3-a456-42661417400b");
    const pool = new TerminalPool(
      () => surface,
      async () => { throw new Error("socket closed"); },
    );
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(surface.probeValue.text).toContain("terminal connection failed");
    expect(surface.probeValue.text).toContain("socket closed");
  });

  it("hides mounted native-capable surfaces while chrome overlays are open", async () => {
    const surfaces: FakeSurface[] = [];
    const pool = new TerminalPool(() => {
      const surface = new FakeSurface();
      surfaces.push(surface);
      return surface;
    }, async () => new FakeAttachment());
    const value = session("323e4567-e89b-12d3-a456-426614174000");
    pool.reconcile([value]);
    await pool.mount(value.id, {} as HTMLElement);
    pool.setVisible(false);
    pool.setVisible(true);
    expect(surfaces[0]!.visibility).toEqual([true, false, true]);
  });
});
