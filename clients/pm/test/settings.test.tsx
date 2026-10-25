// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PmSources } from "@termloop/pm-contract/pm";
import { SettingsPage, type SettingsPageProps } from "../src/renderer/ui/SettingsPage.js";
import { render, typeInto } from "./render.js";

const sources: PmSources = {
  projectId: "project-1",
  jira: { siteUrl: "https://acme.atlassian.net", boardId: 3, accountEmail: "pm@acme.test", credentialHandle: "handle-1" },
  github: null,
};

function props(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  const noop = () => undefined;
  return {
    projectName: "Shop", settings: undefined, sources, tracking: { jira: true, code: false, deploy: false, tier: "tickets" },
    environments: [], probes: [], now: 0, onSaveSources: vi.fn(async () => true), onClearToken: noop, onSaveSettings: noop,
    onSetEnvironments: noop, onCreateProbe: noop, onApproveProbe: noop, onRejectProbe: noop, onDeleteProbe: noop, ...overrides,
  };
}

describe("SettingsPage", () => {
  it("never echoes a stored or typed Jira token", async () => {
    const onSaveSources = vi.fn(async () => true);
    const { container, unmount } = render(<SettingsPage {...props({ onSaveSources })} />);
    const token = container.querySelector<HTMLInputElement>('input[aria-label="Jira API token"]')!;
    expect(token.type).toBe("password");
    expect(token.value).toBe("");
    expect(container.innerHTML).not.toContain("handle-1");

    typeInto(token, "s3cret-token");
    await act(async () => { container.querySelector("form")!.requestSubmit(); });
    expect(onSaveSources).toHaveBeenCalledWith(expect.objectContaining({ token: "s3cret-token" }), null);
    expect(token.value).toBe("");
    expect(container.innerHTML).not.toContain("s3cret-token");
    unmount();
  });

  it("explains deploy tracking instead of offering a switch", () => {
    const { container, unmount } = render(<SettingsPage {...props()} />);
    expect(container.textContent).toContain("Deploy tracking is on whenever this project has an environment or an approved probe");
    expect(container.querySelector('input[type="checkbox"][aria-label*="deploy" i]')).toBeNull();
    unmount();
  });
});
