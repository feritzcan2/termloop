import { describe, expect, it, vi } from "vitest";
import { createSessionRename } from "../src/renderer/composition/session-rename.js";
import type { Session } from "../src/renderer/model.js";
import { ProjectionStore } from "../src/renderer/state/projection-store.js";

const session: Session = {
  id: "session-1", project_id: "project-1", name: "Old name", kind: "Agent",
  lifecycle_state: "running", runtime_epoch: 1, archived_at_epoch_ms: null,
  resume_failure_reason: null, retryable: false, closable: false, forkable: false,
  ask_to_source_session_id: null, run_configuration_id: null,
  process: {
    program: "codex", args: [], cwd: "/project", agent_id: "codex",
    template_ref: "builtin.agent.interactive", template_version: 1,
  },
};

function setup(
  renameSession: (sessionId: string, name: string | null) => Promise<Session>,
  refreshProjection = vi.fn(async () => {}),
) {
  const store = new ProjectionStore();
  store.upsertSession(session);
  const rename = createSessionRename({
    renameSession,
    upsertSession: (value) => store.upsertSession(value),
    refreshProjection,
    setMessage: (message) => store.setMessage(message),
  });
  return { rename, store, refreshProjection };
}

describe("Session rename completion", () => {
  it("lets the dialog close after the save response while the projection refresh is still pending", async () => {
    let save!: (session: Session) => void;
    let refresh!: () => void;
    const renameSession = vi.fn(() => new Promise<Session>((resolve) => { save = resolve; }));
    const { rename, store } = setup(
      renameSession,
      vi.fn(() => new Promise<void>((resolve) => { refresh = resolve; })),
    );
    const closeDialog = vi.fn();
    const pending = rename(session.id, "midas").then((failure) => {
      if (!failure) closeDialog();
      return failure;
    });

    await Promise.resolve();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(store.getSnapshot().sessions[0]?.name).toBe("Old name");

    save({ ...session, name: "midas" });
    await vi.waitFor(() => expect(closeDialog).toHaveBeenCalledOnce());
    expect(store.getSnapshot().sessions[0]?.name).toBe("midas");
    expect(renameSession).toHaveBeenCalledWith(session.id, "midas");
    await expect(pending).resolves.toBeUndefined();
    refresh();
  });

  it.each(["Normalized name", null])("applies the authoritative saved name %s", async (name) => {
    const { rename, store } = setup(async () => ({ ...session, name }));
    await expect(rename(session.id, name === null ? null : "  Normalized name  ")).resolves.toBeUndefined();
    expect(store.getSnapshot().sessions[0]?.name).toBe(name);
  });

  it("returns save errors to the dialog without changing the name or refreshing", async () => {
    const { rename, store, refreshProjection } = setup(async () => { throw new Error("save rejected"); });
    await expect(rename(session.id, "midas")).resolves.toBe("save rejected");
    expect(store.getSnapshot().sessions[0]?.name).toBe("Old name");
    expect(refreshProjection).not.toHaveBeenCalled();
  });

  it("reports a later refresh failure without turning the successful save into a dialog error", async () => {
    let fail!: (error: Error) => void;
    const { rename, store } = setup(
      async () => ({ ...session, name: "midas" }),
      vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; })),
    );

    await expect(rename(session.id, "midas")).resolves.toBeUndefined();
    fail(new Error("remote unavailable"));
    await vi.waitFor(() => expect(store.getSnapshot().message).toBe(
      "Session renamed, but its latest state could not be refreshed: remote unavailable",
    ));
    expect(store.getSnapshot().sessions[0]?.name).toBe("midas");
  });
});
