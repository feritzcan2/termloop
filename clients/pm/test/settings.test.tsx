// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PmAgentCatalog, PmSettings, PmSources } from "@termloop/pm-contract/pm";
import { SettingsPage, type SettingsPageProps } from "../src/renderer/ui/SettingsPage.js";
import { playbook } from "./fixtures.js";
import { render, rerender, typeInto } from "./render.js";

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
    playbook: playbook(), tools: undefined, now: 0, onReadTools: async () => undefined, onSaveSources: vi.fn(async () => true), onClearToken: noop, onSaveSettings: noop,
    onSavePlaybook: vi.fn(async () => true), ...overrides,
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
    expect(onSaveSources).toHaveBeenCalledWith(expect.objectContaining({ token: "s3cret-token" }));
    expect(token.value).toBe("");
    expect(container.innerHTML).not.toContain("s3cret-token");
    unmount();
  });

  it("shows the code host found from the folder's remote and offers no host fields", () => {
    const azure = { ...sources, azureDevOps: { organization: "contoso", project: "Parking", name: "Nucleus" } };
    const { container, unmount } = render(<SettingsPage {...props({ projectFolder: "/work/nucleus", sources: azure })} />);
    expect(container.textContent).toContain("AZURE DEVOPS");
    expect(container.textContent).toContain("contoso/Parking/Nucleus");
    expect(container.querySelector('select[aria-label="Code host"]')).toBeNull();
    unmount();

    const none = render(<SettingsPage {...props({ projectFolder: "/work/plain" })} />);
    expect(none.container.textContent).toContain("NO CODE HOST");
    none.unmount();
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
    expect(set.container.textContent).toContain("Code repository");
    const remove = [...set.container.querySelectorAll("button")].find((button) => button.textContent === "Remove folder")!;
    act(() => { remove.click(); });
    expect(onSetFolder).toHaveBeenLastCalledWith(null);
    set.unmount();
  });

  it("edits the Playbook and saves it over the revision it was read at", async () => {
    const onSavePlaybook = vi.fn(async () => true);
    const { container, unmount } = render(<SettingsPage {...props({ playbook: playbook({ revision: 3 }), onSavePlaybook })} />);
    const section = container.querySelector<HTMLElement>('section.settings-section[aria-label="Playbook"]')!;
    expect(section.textContent).toContain("5 STEPS · 1 BY AN AGENT");
    const save = () => [...section.querySelectorAll("button")].find((button) => button.textContent === "Save Playbook")!;
    expect(save().disabled).toBe(true);
    const title = section.querySelector<HTMLInputElement>('input[aria-label="Step 4 title"]')!;
    typeInto(title, " ");
    expect(save().disabled).toBe(true);
    expect(section.textContent).toContain("Give every step a title.");
    typeInto(title, "On prod ");
    await act(async () => save().click());
    const [revision, steps] = onSavePlaybook.mock.calls[0] as unknown as [number, { id: string; title: string }[]];
    expect(revision).toBe(3);
    expect(steps.map((step) => step.title)).toEqual(["In progress", "In review", "Merged", "On prod", "Done"]);
    unmount();
  });

  it("keeps an edit in progress across board reads, and takes a newer revision", () => {
    const { container, root, unmount } = render(<SettingsPage {...props({ playbook: playbook({ revision: 3 }) })} />);
    const title = () => container.querySelector<HTMLInputElement>('input[aria-label="Step 4 title"]')!;
    typeInto(title(), "On prod");
    rerender(root, <SettingsPage {...props({ playbook: playbook({ revision: 3 }) })} />);
    expect(title().value).toBe("On prod");
    rerender(root, <SettingsPage {...props({ playbook: playbook({ revision: 4 }) })} />);
    expect(title().value).toBe("Live");
    unmount();
  });

  it("removes a step and keeps the rest in order", async () => {
    const onSavePlaybook = vi.fn(async () => true);
    const { container, unmount } = render(<SettingsPage {...props({ playbook: playbook(), onSavePlaybook })} />);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Remove step 2"]')!.click());
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Save Playbook")!.click());
    expect((onSavePlaybook.mock.calls[0] as unknown as [number, { id: string }[]])[1].map((step) => step.id)).toEqual(["started", "merged", "live", "done"]);
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
