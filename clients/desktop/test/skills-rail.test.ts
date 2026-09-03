// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SkillCatalogResult } from "@termloop/contract/current";
import { SkillsRail } from "../src/renderer/ui/SkillsRail.js";

const catalog: SkillCatalogResult = {
  skills: [
    {
      id: "a".repeat(64),
      name: "shared-review",
      description: "Review changes for both agents.",
      agents: ["claude", "codex"],
      scopes: ["user"],
      origins: ["shared"],
      locations: [{
        path: "/home/.agents/skills/shared-review",
        scope: "user",
        origin: "shared",
        agents: ["claude", "codex"],
        source: "User shared skills",
        availability: "folder",
      }],
      agentStates: [
        { agent: "claude", present: true, managed: false, targetPath: null },
        { agent: "codex", present: true, managed: false, targetPath: null },
      ],
      manageable: true,
    },
    {
      id: "b".repeat(64),
      name: "release",
      description: "Ship the selected project.",
      agents: ["codex"],
      scopes: ["project"],
      origins: ["personal"],
      locations: [{
        path: "/project/.codex/skills/release",
        scope: "project",
        origin: "personal",
        agents: ["codex"],
        source: "Project Codex skills",
        availability: "folder",
      }],
      agentStates: [
        { agent: "claude", present: false, managed: false, targetPath: null },
        { agent: "codex", present: true, managed: true, targetPath: null },
      ],
      manageable: true,
    },
  ],
  warnings: [],
  projectIncluded: true,
  projectName: "TermLoop",
  providerSnapshotIncluded: false,
  managerAvailable: true,
};

describe("Skills rail", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (overrides?: Partial<Parameters<typeof SkillsRail>[0]>) =>
    act(async () => root.render(createElement(SkillsRail, {
      load: async () => catalog,
      setDeployment: vi.fn(),
      openEditor: vi.fn(),
      ...overrides,
    })));

  it("puts project skills first and groups the library by folder", async () => {
    await render();
    await act(async () => undefined);

    const sectionTitles = [...container.querySelectorAll<HTMLElement>(".skill-section-title")];
    expect(sectionTitles.map((title) => title.textContent)).toEqual([
      "Project skillsTermLoop",
      "Personal library",
    ]);
    const project = container.querySelector(".skill-section.project");
    expect(project?.textContent).toContain("release");
    const folder = container.querySelector(".skill-folder");
    expect(folder?.querySelector(".skill-folder-head span")?.textContent).toBe("User shared skills");
    expect(folder?.textContent).toContain("shared-review");
  });

  it("shows same-named project skills as one row with expandable physical locations", async () => {
    const projectCopy = (
      id: string,
      source: string,
      path: string,
      agents: Array<"claude" | "codex">,
      origin: "shared" | "personal",
    ): SkillCatalogResult["skills"][number] => ({
      id,
      name: "timelogging",
      description: "Prepare and log the weekly timesheet.",
      agents,
      scopes: ["project"],
      origins: [origin],
      locations: [{ path, scope: "project", origin, agents, source, availability: "folder" }],
      agentStates: (["claude", "codex"] as const).map((agent) => ({
        agent,
        present: agents.includes(agent),
        managed: false,
        targetPath: null,
      })),
      manageable: true,
    });
    const duplicateCatalog: SkillCatalogResult = {
      ...catalog,
      skills: [
        projectCopy("c".repeat(64), "Project shared skills", "/project/.agents/skills/timelogging", ["claude", "codex"], "shared"),
        projectCopy("d".repeat(64), "Project Claude skills", "/project/.claude/skills/timelogging", ["claude"], "personal"),
        projectCopy("e".repeat(64), "Project Codex skills", "/project/.codex/skills/timelogging", ["codex"], "personal"),
      ],
    };
    const openEditor = vi.fn();
    await render({ load: async () => duplicateCatalog, openEditor });
    await act(async () => undefined);

    const project = container.querySelector<HTMLElement>(".skill-section.project");
    expect(project?.querySelector(".skill-section-head > strong")?.textContent).toBe("1");
    expect(project?.querySelectorAll(".skill-cluster-toggle")).toHaveLength(1);
    expect(project?.querySelector(".skill-cluster-toggle")?.textContent).toContain("timelogging");
    expect(project?.querySelectorAll(".skill-cluster-row .skill-chip.source")).toHaveLength(2);
    expect(project?.querySelector(".skill-cluster-locations")).toBeNull();

    const show = project?.querySelector<HTMLButtonElement>('[aria-label="Show 3 locations for timelogging"]');
    await act(async () => show?.click());

    const locations = [...(project?.querySelectorAll<HTMLElement>(".skill-location-row") ?? [])];
    expect(locations).toHaveLength(3);
    expect(locations.map((row) => row.querySelector(".skill-rail-open strong")?.textContent)).toEqual([
      "Project shared skills",
      "Project Claude skills",
      "Project Codex skills",
    ]);
    const codexLocation = locations.find((row) => row.textContent?.includes("Project Codex skills"));
    await act(async () => codexLocation?.querySelector<HTMLButtonElement>(".skill-rail-open")?.click());
    expect(openEditor).toHaveBeenCalledWith("e".repeat(64));
  });

  it("flags differing descriptions inside a same-named group", async () => {
    const conflicting: SkillCatalogResult = {
      ...catalog,
      skills: [
        catalog.skills[0]!,
        {
          ...catalog.skills[0]!,
          id: "f".repeat(64),
          description: "A different skill definition with the same name.",
          locations: [{
            ...catalog.skills[0]!.locations[0]!,
            path: "/home/.claude/skills/shared-review",
            source: "User Claude skills",
          }],
        },
      ],
    };
    await render({ load: async () => conflicting });
    await act(async () => undefined);

    expect(container.querySelector(".skill-cluster-toggle small")?.textContent)
      .toBe("2 entries share this name; open locations to compare.");
  });

  it("groups plugins and built-ins by their providing plugin", async () => {
    const pluginSkill = (id: string, name: string, source: string, path: string): SkillCatalogResult["skills"][number] => ({
      id,
      name,
      description: `${name} guidance.`,
      agents: ["claude"],
      scopes: ["user"],
      origins: ["plugin"],
      locations: [{ path, scope: "user", origin: "plugin", agents: ["claude"], source, availability: "folder" }],
      agentStates: [
        { agent: "claude", present: true, managed: false, targetPath: null },
        { agent: "codex", present: false, managed: false, targetPath: null },
      ],
      manageable: false,
    });
    const extended: SkillCatalogResult = {
      ...catalog,
      skills: [
        ...catalog.skills,
        pluginSkill("c".repeat(64), "api-routes", "Claude plugin · expo-tools", "/home/.claude/plugins/expo-tools/skills/api-routes"),
        pluginSkill("d".repeat(64), "design-report", "Claude plugin · artifact-templates", "/home/.claude/plugins/artifact-templates/skills/design-report"),
        pluginSkill("e".repeat(64), "dashboard", "Claude plugin · artifact-templates", "/home/.claude/plugins/artifact-templates/skills/dashboard"),
      ],
    };
    await render({ load: async () => extended });
    await act(async () => undefined);

    const provider = [...container.querySelectorAll<HTMLElement>(".skill-section")]
      .find((section) => section.getAttribute("aria-label") === "Plugins & built-ins");
    const folders = [...(provider?.querySelectorAll<HTMLElement>(".skill-folder") ?? [])];
    expect(folders.map((folder) => folder.querySelector(".skill-folder-head span")?.textContent)).toEqual([
      "Claude plugin · artifact-templates",
      "Claude plugin · expo-tools",
    ]);

    // Every plugin group starts collapsed, single-skill ones included.
    const templatesToggle = folders[0]?.querySelector<HTMLButtonElement>("button.skill-folder-head");
    expect(templatesToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(folders[0]?.querySelectorAll(".skill-rail-row")).toHaveLength(0);
    expect(folders[1]?.querySelector("button.skill-folder-head")?.getAttribute("aria-expanded")).toBe("false");
    expect(folders[1]?.querySelectorAll(".skill-rail-row")).toHaveLength(0);

    await act(async () => templatesToggle?.click());
    expect(templatesToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(folders[0]?.querySelectorAll(".skill-rail-row")).toHaveLength(2);
    expect(folders[0]?.textContent).toContain("dashboard");

    // The personal library keeps plain headers, never collapse toggles.
    const library = [...container.querySelectorAll<HTMLElement>(".skill-section")]
      .find((section) => section.getAttribute("aria-label") === "Personal library");
    expect(library?.querySelector("button.skill-folder-head")).toBeNull();
    expect(library?.textContent).toContain("shared-review");
  });

  it("opens the markdown editor when a skill row is clicked", async () => {
    const openEditor = vi.fn();
    await render({ openEditor });
    await act(async () => undefined);

    const row = [...container.querySelectorAll<HTMLButtonElement>(".skill-rail-open")]
      .find((button) => button.textContent?.includes("release"));
    await act(async () => row?.click());

    expect(openEditor).toHaveBeenCalledWith("b".repeat(64));
  });

  it("offers Improve with agent on a skill row", async () => {
    const improveSkill = vi.fn();
    await render({ improveSkill });
    await act(async () => undefined);

    const improve = container.querySelector<HTMLButtonElement>('[aria-label="Improve release with agent"]');
    await act(async () => improve?.click());
    expect(improveSkill).toHaveBeenCalledWith("b".repeat(64), "release");

    // A rail that cannot act offers no agent action either.
    await render({ improveSkill, disabled: true });
    await act(async () => undefined);
    expect(container.querySelector(".rail-row-improve")).toBeNull();
  });

  it("installs and removes through the agent chips", async () => {
    const setDeployment = vi.fn().mockResolvedValue(catalog);
    await render({ setDeployment });
    await act(async () => undefined);

    const install = container.querySelector<HTMLButtonElement>('[aria-label="Install release to Claude"]');
    await act(async () => install?.click());
    expect(setDeployment).toHaveBeenCalledWith("b".repeat(64), "claude", true);

    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove release from Codex"]');
    await act(async () => remove?.click());
    expect(setDeployment).toHaveBeenCalledWith("b".repeat(64), "codex", false);

    const sourceChips = [...container.querySelectorAll(".skill-chip.source")];
    expect(sourceChips).toHaveLength(2);
    expect(sourceChips.every((chip) => chip.tagName === "SPAN")).toBe(true);
  });

  it("reveals where a skill lives per agent through chip and row tooltips", async () => {
    await render();
    await act(async () => undefined);

    const claudeSource = [...container.querySelectorAll<HTMLElement>(".skill-chip.claude.source")]
      .find((chip) => chip.title.includes("/home/.agents/skills/shared-review"));
    expect(claudeSource?.title).toContain("Original copy in Claude");

    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove release from Codex"]');
    expect(remove?.title).toContain("/project/.codex/skills/release");

    const row = [...container.querySelectorAll<HTMLButtonElement>(".skill-rail-open")]
      .find((button) => button.textContent?.includes("shared-review"));
    expect(row?.title).toBe("/home/.agents/skills/shared-review");
  });

  it("disables actions when the manager is unavailable or the rail is disabled", async () => {
    await render({ load: async () => ({ ...catalog, managerAvailable: false }) });
    await act(async () => undefined);

    const chips = [...container.querySelectorAll<HTMLButtonElement>("button.skill-chip")];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((chip) => chip.disabled)).toBe(true);
    expect(container.querySelector(".skills-rail-note")?.textContent).toContain("Read only");

    await render({ disabled: true });
    await act(async () => undefined);
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".skill-rail-open")];
    expect(rows.every((row) => row.disabled)).toBe(true);
  });

  it("filters by search and keeps the project section visible", async () => {
    await render();
    await act(async () => undefined);

    const input = container.querySelector<HTMLInputElement>(".skills-search input");
    await act(async () => {
      if (!input) throw new Error("search input missing");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "shared-review");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sections = [...container.querySelectorAll<HTMLElement>(".skill-section")];
    expect(sections[0]?.textContent).toContain("No project skills match this search.");
    expect(sections[1]?.textContent).toContain("shared-review");
  });

  it("refreshes discovery in place", async () => {
    const load = vi.fn().mockResolvedValue(catalog);
    await render({ load });
    await act(async () => undefined);

    await act(async () => (container.querySelector('[aria-label="Refresh skills"]') as HTMLButtonElement).click());
    await act(async () => undefined);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shows connected remote computers on demand and creates missing skills", async () => {
    const remoteCatalog: SkillCatalogResult = {
      ...catalog,
      skills: [catalog.skills[0]!],
      projectIncluded: false,
      projectName: null,
    };
    const listRemoteComputers = vi.fn().mockResolvedValue([
      { profileId: "remote-a", name: "Studio Mac", writable: true },
      { profileId: "remote-b", name: "Build PC", writable: false },
    ]);
    const loadRemoteCatalog = vi.fn().mockResolvedValue(remoteCatalog);
    const createRemoteSkill = vi.fn().mockResolvedValue({
      ...remoteCatalog,
      skills: [...remoteCatalog.skills, catalog.skills[1]!],
    });
    await render({ listRemoteComputers, loadRemoteCatalog, createRemoteSkill });
    await act(async () => undefined);

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Show remote computers"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(toggle?.closest(".skills-remote-control")?.textContent).toContain("2 connected");
    expect(loadRemoteCatalog).not.toHaveBeenCalled();

    await act(async () => toggle?.click());
    await act(async () => undefined);

    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(loadRemoteCatalog).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[aria-label="Remote computers"]')?.textContent)
      .toContain("Studio MacEnabled");
    expect(container.querySelector('[title="shared-review is available on Studio Mac"]')).not.toBeNull();

    const create = container.querySelector<HTMLButtonElement>('[aria-label="Create release on Studio Mac"]');
    const readOnly = container.querySelector<HTMLButtonElement>('[aria-label="Create release on Build PC"]');
    expect(create?.disabled).toBe(false);
    expect(readOnly?.disabled).toBe(true);
    expect(readOnly?.title).toContain("read-only");

    await act(async () => create?.click());
    await act(async () => undefined);
    expect(createRemoteSkill).toHaveBeenCalledWith("remote-a", "b".repeat(64));
    expect(container.querySelector('[title="release is available on Studio Mac"]')).not.toBeNull();
  });

  it("omits the remote-computer switch when no remote computer is connected", async () => {
    await render({ listRemoteComputers: async () => [] });
    await act(async () => undefined);

    expect(container.querySelector('[aria-label="Show remote computers"]')).toBeNull();
  });

  it("remounts cleanly when the selected Project changes", async () => {
    const props = {
      load: async () => catalog,
      setDeployment: vi.fn(),
      openEditor: vi.fn(),
      listRemoteComputers: async () => [
        { profileId: "remote-a", name: "Studio Mac", writable: true },
      ],
      loadRemoteCatalog: async () => catalog,
    };
    await act(async () => root.render(createElement(SkillsRail, { key: "project-a", ...props })));
    await act(async () => undefined);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Show remote computers"]')?.click();
    });
    expect(container.querySelector('[aria-label="Show remote computers"]')?.getAttribute("aria-checked"))
      .toBe("true");

    await act(async () => root.render(createElement(SkillsRail, { key: "project-b", ...props })));
    await act(async () => undefined);

    expect(container.querySelector(".skills-rail")).not.toBeNull();
    expect(container.querySelector('[aria-label="Show remote computers"]')?.getAttribute("aria-checked"))
      .toBe("false");
  });
});
