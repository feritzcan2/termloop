import { describe, expect, it } from "vitest";

import { createMockRuntime } from "../src/adapters/mock/mock-runtime";

describe("mock mobile Session actions", () => {
  it("records coordination, lifecycle, relocation, and dismissal intents", async () => {
    const runtime = createMockRuntime();
    const connectionId = "connection-local-mac";
    const sessionId = "session-claude";

    const forked = await runtime.sessionActions.fork(connectionId, sessionId);
    await runtime.sessionActions.retry(connectionId, sessionId);
    await runtime.sessionActions.restart(connectionId, sessionId);
    await runtime.sessionActions.askTo(connectionId, sessionId, "codex");
    await runtime.sessionActions.handoverTo(connectionId, sessionId, "session-reviewer");
    await runtime.sessionActions.rename(connectionId, sessionId, "Mobile menu");
    const preview = await runtime.sessionActions.previewRelocateToProject(
      connectionId,
      sessionId,
      "project-termloop-next",
    );
    await runtime.sessionActions.relocateToProject(
      connectionId,
      sessionId,
      "project-termloop-next",
      "operation-mobile",
      preview.relocation_ticket!,
    );
    await runtime.sessionActions.terminate(connectionId, sessionId);
    await runtime.sessionActions.close(connectionId, sessionId);

    expect(forked.fork_source_session_id).toBe(sessionId);
    expect(preview).toMatchObject({ can_relocate: true, target_cwd: "/Users/demo/Projects/termloop-next" });
    expect(runtime.inspection.sessionActions.map(({ action }) => action)).toEqual([
      "fork",
      "retry",
      "restart",
      "askTo",
      "handoverTo",
      "rename",
      "previewRelocateToProject",
      "relocateToProject",
      "terminate",
      "close",
    ]);
  });
});
