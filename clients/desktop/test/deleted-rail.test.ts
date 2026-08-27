// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { DeletedSessionDto } from "@termloop/contract/current";
import { DeletedRail, deletedRetentionLabel } from "../src/renderer/ui/DeletedRail.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function deleted(overrides: Partial<DeletedSessionDto> = {}): DeletedSessionDto {
  const now = Date.now();
  return {
    session: {
      id: "deleted-agent",
      project_id: "project-1",
      name: "Closed Codex",
      kind: "Agent",
      lifecycle_state: "exited",
      runtime_epoch: 3,
      archived_at_epoch_ms: null,
      resume_failure_reason: null,
      retryable: true,
      closable: true,
      forkable: true,
      ask_to_source_session_id: null,
      run_configuration_id: null,
      process: {
        program: "codex",
        args: [],
        cwd: "/project",
        agent_id: "codex",
        template_ref: "builtin.agent.interactive",
        template_version: 1,
      },
    },
    deleted_at_epoch_ms: now,
    purge_at_epoch_ms: now + 30 * DAY_MS,
    source_available: true,
    restore_blocker: null,
    ...overrides,
  };
}

async function renderDeleted(items: readonly DeletedSessionDto[], restore = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(DeletedRail, {
    sessions: items,
    loading: false,
    disabled: false,
    restore,
  })));
  return {
    container,
    restore,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

describe("Deleted Agent rail", () => {
  it("sits as its own timed recycle-bin section and restores from a visible action", async () => {
    const view = await renderDeleted([deleted()]);
    expect(view.container.textContent).toContain("Deleted");
    expect(view.container.querySelector('[data-rail="deleted"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Expand Deleted Agents"]')).not.toBeNull();
    await act(async () => view.container.querySelector<HTMLButtonElement>(".rail-toggle")!.click());
    expect(view.container.textContent).toContain("30d left");
    const restore = view.container.querySelector<HTMLButtonElement>(
      '[aria-label="Restore deleted Agent Closed Codex"]',
    );
    expect(restore?.disabled).toBe(false);
    await act(async () => restore!.click());
    expect(view.restore).toHaveBeenCalledWith("deleted-agent");
    await view.dispose();
  });

  it("keeps the record visible but blocks restore when source files are gone", async () => {
    const view = await renderDeleted([deleted({
      source_available: false,
      restore_blocker: "sourceUnavailable",
    })]);
    await act(async () => view.container.querySelector<HTMLButtonElement>(".rail-toggle")!.click());
    expect(view.container.textContent).toContain("Source folder is no longer available");
    expect(view.container.querySelector<HTMLButtonElement>(".deleted-restore")?.disabled).toBe(true);
    await view.dispose();
  });

  it("rounds retention up to whole remaining days", () => {
    expect(deletedRetentionLabel(100 + 30 * DAY_MS, 100)).toBe("30d left");
    expect(deletedRetentionLabel(100 + 1, 100)).toBe("1d left");
  });
});
