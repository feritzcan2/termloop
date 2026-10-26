// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PmAgentCatalog, PmSettings, PmSources } from "@termloop/pm-contract/pm";
import { SettingsPage, type SettingsPageProps } from "../src/renderer/ui/SettingsPage.js";
import { render, typeInto } from "./render.js";

const sources: PmSources = {
  projectId: "project-1",
  jira: { siteUrl: "https://acme.atlassian.net", boardId: 3, accountEmail: "pm@acme.test", credentialHandle: "handle-1" },
  github: null,
  azureDevOps: null,
};

function props(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  const noop = () => undefined;
  return {
    projectName: "Shop", settings: undefined, catalog: undefined, sources, tracking: { jira: true, code: false, deploy: false, tier: "tickets" },
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

  it("saves an Azure DevOps repository as the code host", async () => {
    const onSaveSources = vi.fn(async () => true);
    const { container, unmount } = render(<SettingsPage {...props({ onSaveSources })} />);
    const host = container.querySelector<HTMLSelectElement>('select[aria-label="Code host"]')!;
    act(() => {
      host.value = "azureDevOps";
      host.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
    typeInto(input("e.g. contoso"), "contoso");
    typeInto(input("e.g. Parking"), "Parking");
    typeInto(input("e.g. shop"), "Nucleus");
    await act(async () => { container.querySelector("form")!.requestSubmit(); });
    expect(onSaveSources).toHaveBeenCalledWith(expect.anything(), { kind: "azureDevOps", organization: "contoso", project: "Parking", name: "Nucleus" });
    unmount();
  });

  it("shows a stored Azure DevOps repository", () => {
    const azure = { ...sources, azureDevOps: { organization: "contoso", project: "Parking", name: "Nucleus" } };
    const { container, unmount } = render(<SettingsPage {...props({ sources: azure })} />);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Code host"]')!.value).toBe("azureDevOps");
    expect(container.textContent).toContain("AZURE DEVOPS");
    expect(container.querySelector<HTMLInputElement>('input[placeholder="e.g. Parking"]')!.value).toBe("Parking");
    unmount();
  });

  it("picks a code folder through the native picker and can remove it", async () => {
    const onSetFolder = vi.fn();
    const onPickFolder = vi.fn(async () => "/work/shop");
    const empty = render(<SettingsPage {...props({ projectFolder: null, onPickFolder, onSetFolder })} />);
    const choose = [...empty.container.querySelectorAll("button")].find((button) => button.textContent === "Choose folder…")!;
    await act(async () => { choose.click(); });
    expect(onSetFolder).toHaveBeenCalledWith("/work/shop");
    empty.unmount();

    const set = render(<SettingsPage {...props({ projectFolder: "/work/shop", onPickFolder, onSetFolder })} />);
    expect(set.container.textContent).toContain("/work/shop");
    expect(set.container.textContent).toContain("READ ONLY");
    const remove = [...set.container.querySelectorAll("button")].find((button) => button.textContent === "Remove folder")!;
    act(() => { remove.click(); });
    expect(onSetFolder).toHaveBeenLastCalledWith(null);
    set.unmount();
  });

  it("explains deploy tracking instead of offering a switch", () => {
    const { container, unmount } = render(<SettingsPage {...props()} />);
    expect(container.textContent).toContain("Deploy tracking is on whenever this project has an environment or an approved probe");
    expect(container.querySelector('input[type="checkbox"][aria-label*="deploy" i]')).toBeNull();
    unmount();
  });

  it("offers the catalog's models and permissions as choices and saves the picked ones", () => {
    const catalog: PmAgentCatalog = {
      providers: [
        { id: "claude", label: "Claude", models: ["default", "opus", "sonnet", "haiku"], permissions: { assistant: ["default", "acceptEdits", "bypassPermissions"], check: ["bypassPermissions"] } },
        { id: "codex", label: "Codex", models: ["default", "gpt-5"], permissions: { assistant: ["default", "full-auto"], check: [] } },
      ],
    };
    const settings: PmSettings = { agentProvider: "claude", agentAccountId: null, agentModel: "default", checkModel: "haiku", assistantPermission: "default", checkPermission: "bypassPermissions" };
    const onSaveSettings = vi.fn();
    const { container, unmount } = render(<SettingsPage {...props({ settings, catalog, onSaveSettings })} />);
    const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    expect([...select("Agent model").options].map((option) => option.value)).toEqual(["default", "opus", "sonnet", "haiku"]);
    expect(select("Delivery check model").value).toBe("haiku");
    expect(container.querySelector('input[aria-label="Agent model"]')).toBeNull();
    act(() => {
      select("Agent model").value = "opus";
      select("Agent model").dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Save agent settings")!.click(); });
    expect(onSaveSettings).toHaveBeenCalledWith({ agentProvider: "claude", agentModel: "opus", checkModel: "haiku", assistantPermission: "default", checkPermission: "bypassPermissions" });
    unmount();
  });
});
