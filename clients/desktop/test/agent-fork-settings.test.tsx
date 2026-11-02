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
const toggle = () => host.querySelector<HTMLButtonElement>('button[role="switch"]')!;

describe("Agent fork settings", () => {
  it("shows the daemon's fork prompt and saves the opt-out to that computer", async () => {
    const actions: AgentForkSettingsActions = {
      get: vi.fn(async () => ({ systemPromptEnabled: true, systemPrompt: PROMPT })),
      set: vi.fn(async (_profileId, params) => ({ ...params, systemPrompt: PROMPT })),
    };
    await render(actions);
    expect(actions.get).toHaveBeenCalledWith("local");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('pre[aria-label="Fork system prompt"]')?.textContent).toBe(PROMPT);

    await act(async () => toggle().click());
    expect(actions.set).toHaveBeenCalledWith("local", { systemPromptEnabled: false });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("restores the previous value when saving fails", async () => {
    const actions: AgentForkSettingsActions = {
      get: vi.fn(async () => ({ systemPromptEnabled: true, systemPrompt: PROMPT })),
      set: vi.fn(async () => { throw new Error("daemon offline"); }),
    };
    await render(actions);
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("daemon offline");
  });
});
