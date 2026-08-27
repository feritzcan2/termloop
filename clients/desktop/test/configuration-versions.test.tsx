// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigurationVersionDto, VersionedConfigurationTarget } from "@termloop/contract/current";
import { ConfigurationVersions } from "../src/renderer/ui/PromptImprovement.js";

const target: VersionedConfigurationTarget = { kind: "runConfiguration", targetId: "run-1" };

function version(sequence: number, sourceSessionId: string | null): ConfigurationVersionDto {
  return {
    id: `version-${sequence}`,
    target,
    sequence,
    content: JSON.stringify({ command: sequence === 1 ? "npm run dev" : "pnpm dev" }),
    summary: sequence === 1 ? "Initial configuration" : "Use the workspace package manager",
    sourceSessionId,
    createdAtEpochMs: sequence,
  };
}

describe("ConfigurationVersions", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows only a compact version paginator and switches existing versions", async () => {
    const restore = vi.fn(async () => undefined);
    const reload = vi.fn();
    await act(async () => root.render(createElement(ConfigurationVersions, {
      controller: {
        history: { target, activeVersionId: "version-2", versions: [version(1, null), version(2, "agent-session-1")], stateRevision: 2 },
        busy: false,
        error: undefined,
        restore,
      },
      reload,
    })));

    expect(host.textContent).toBe("‹v2›");
    expect(host.textContent).not.toContain("Initial configuration");
    expect(host.textContent).not.toContain("Use the workspace package manager");
    expect(host.querySelector('input[type="range"]')).toBeNull();

    const previous = host.querySelector<HTMLButtonElement>('button[aria-label="Previous version"]')!;
    const next = host.querySelector<HTMLButtonElement>('button[aria-label="Next version"]')!;
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    await act(async () => previous.click());
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ id: "version-1" }), reload);
  });
});
