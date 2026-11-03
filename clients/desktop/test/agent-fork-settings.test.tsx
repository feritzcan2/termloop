// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import { AgentForkSettings, type AgentForkSettingsActions } from "../src/renderer/ui/AgentForkSettings.js";

const local: ConnectionProfileSummary = {
  id: "local", name: "MacBook Pro", transport: "local", scope: "local",
  endpoint: "", enabled: true, persistence: "local", state: "connected",
};
const PROMPT = "This Session is a fork.\n\n- Source Session ID: `{{source_session_id}}`";
const ACTIVE = "The source Agent was still working when this fork started.";
const RESTART = "TermLoop restarted while you were working.";
const SETTINGS = { systemPrompt: PROMPT, activeSourcePrompt: ACTIVE, restartContinuePrompt: RESTART };
const CURRENT = { systemPromptEnabled: true, autoContinueInterruptedEnabled: false, ...SETTINGS };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(actions: AgentForkSettingsActions) {
  await act(async () => root.render(<AgentForkSettings actions={actions} listProfiles={async () => [local]} />));
  await act(async () => {});
}
const toggle = () => host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')[0]!;
const restartToggle = () => host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')[1]!;

describe("Agent fork settings", () => {
  it("shows the daemon's fork prompt and saves the opt-out to that computer", async () => {
    const actions: AgentForkSettingsActions = {
      get: vi.fn(async () => CURRENT),
      set: vi.fn(async (_profileId, params) => ({ ...CURRENT, ...params })),
    };
    await render(actions);
    expect(actions.get).toHaveBeenCalledWith("local");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('pre[aria-label="Fork system prompt"]')?.textContent).toBe(PROMPT);
    expect(host.querySelector('pre[aria-label="Fork active source prompt"]')?.textContent).toBe(ACTIVE);

    await act(async () => toggle().click());
    expect(actions.set).toHaveBeenCalledWith("local", { systemPromptEnabled: false });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("shows the restart prompt and opts in to auto-continue without touching forks", async () => {
    const actions: AgentForkSettingsActions = {
      get: vi.fn(async () => CURRENT),
      set: vi.fn(async (_profileId, params) => ({ ...CURRENT, ...params })),
    };
    await render(actions);
    expect(restartToggle().getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector('pre[aria-label="Restart continuation prompt"]')?.textContent).toBe(RESTART);

    await act(async () => restartToggle().click());
    expect(actions.set).toHaveBeenCalledWith("local", { autoContinueInterruptedEnabled: true });
    expect(restartToggle().getAttribute("aria-checked")).toBe("true");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });

  it("restores the previous value when saving fails", async () => {
    const actions: AgentForkSettingsActions = {
      get: vi.fn(async () => CURRENT),
      set: vi.fn(async () => { throw new Error("daemon offline"); }),
    };
    await render(actions);
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("daemon offline");
  });
});
