import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProviderHistoryRepairDialog } from "../src/renderer/ui/ProviderHistoryRepairDialog.js";
import type { Session } from "../src/renderer/model.js";

function damagedSession(lifecycleState: Session["lifecycle_state"]): Session {
  return {
    id: "session-1",
    project_id: "project-1",
    name: "Damaged Codex",
    kind: "Agent",
    process: {
      program: "codex",
      args: [],
      cwd: "/project",
      agent_id: "codex",
      template_ref: "builtin.agent.interactive",
      template_version: 1,
    },
    lifecycle_state: lifecycleState,
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: "providerHistoryDamaged",
    retryable: false,
    closable: true,
    forkable: false,
    ask_to_source_session_id: null,
    fork_source_session_id: null,
    improver_target: null,
    run_configuration_id: null,
  };
}

describe("provider history repair confirmation", () => {
  it("states the backup, narrow rewrite, verification, and running-Agent stop", () => {
    const markup = renderToStaticMarkup(createElement(ProviderHistoryRepairDialog, {
      session: damagedSession("running"),
      repair: vi.fn(),
      close: vi.fn(),
    }));
    expect(markup).toContain("exact private backup");
    expect(markup).toContain("known duplicate restart ordinals");
    expect(markup).toContain("fresh Codex runtime");
    expect(markup).toContain("Stop &amp; Repair");
  });

  it("does not claim an exited Agent must be stopped", () => {
    const markup = renderToStaticMarkup(createElement(ProviderHistoryRepairDialog, {
      session: damagedSession("exited"),
      repair: vi.fn(),
      close: vi.fn(),
    }));
    expect(markup).not.toContain("Stop &amp; Repair");
    expect(markup).toContain(">Repair<");
  });

  it("does not terminate a resume-failed Agent before repairing its retained Session", () => {
    const markup = renderToStaticMarkup(createElement(ProviderHistoryRepairDialog, {
      session: damagedSession("resumeFailed"),
      repair: vi.fn(),
      close: vi.fn(),
    }));
    expect(markup).not.toContain("Stop &amp; Repair");
    expect(markup).toContain(">Repair<");
  });
});
