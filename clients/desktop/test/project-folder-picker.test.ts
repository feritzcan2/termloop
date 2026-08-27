// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryBrowseResult } from "@termloop/contract/current";
import type { ConnectionProfileSummary } from "../src/connection-profile-types.js";
import { collapseFolderTrail, folderQuickJumps, folderTrail } from "../src/renderer/ui/project-dialogs/folder-path.js";
import { ProjectDetailsDialog, ProjectDialog } from "../src/renderer/ui/project-dialogs/project-dialogs.js";

const tree: Record<string, DirectoryBrowseResult> = {
  "/Users/dev": {
    path: "/Users/dev",
    parentPath: "/Users",
    entries: [
      { name: "Downloads", path: "/Users/dev/Downloads", kind: "directory" },
      { name: "Projects", path: "/Users/dev/Projects", kind: "directory" },
    ],
  },
  "/Users/dev/Projects": {
    path: "/Users/dev/Projects",
    parentPath: "/Users/dev",
    entries: [
      { name: "nucleus", path: "/Users/dev/Projects/nucleus", kind: "directory" },
      { name: "termloop-next", path: "/Users/dev/Projects/termloop-next", kind: "directory" },
    ],
  },
};

async function browse(path: string): Promise<DirectoryBrowseResult> {
  const found = tree[path];
  if (!found) throw new Error(`${path} does not exist`);
  return found;
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"]')];
}

function rowNames(container: HTMLElement): string[] {
  return rows(container).map((row) => row.querySelector(".folder-row-name")?.textContent ?? "");
}

function selectedPath(container: HTMLElement): string {
  return container.querySelector(".folder-selection-copy small")?.textContent ?? "";
}

function input(container: HTMLElement, selector: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(selector);
  if (!found) throw new Error(`no input matching ${selector}`);
  return found;
}

function selectionTitle(container: HTMLElement): string {
  return container.querySelector(".folder-selection-copy strong")?.textContent ?? "";
}

function type(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("Project folder path helpers", () => {
  it("keeps each platform's root and separator in the trail", () => {
    expect(folderTrail("/Users/dev/Projects")).toEqual([
      { name: "/", path: "/" },
      { name: "Users", path: "/Users" },
      { name: "dev", path: "/Users/dev" },
      { name: "Projects", path: "/Users/dev/Projects" },
    ]);
    expect(folderTrail("C:\\Users\\dev")).toEqual([
      { name: "C:\\", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "dev", path: "C:\\Users\\dev" },
    ]);
    expect(folderTrail("\\\\build\\share\\repos")).toEqual([
      { name: "\\\\build\\share", path: "\\\\build\\share" },
      { name: "repos", path: "\\\\build\\share\\repos" },
    ]);
  });

  it("collapses only the middle of a deep trail", () => {
    const trail = folderTrail("/a/b/c/d/e");
    expect(collapseFolderTrail(trail, 4)).toEqual([
      { name: "/", path: "/" },
      "ellipsis",
      { name: "c", path: "/a/b/c" },
      { name: "d", path: "/a/b/c/d" },
      { name: "e", path: "/a/b/c/d/e" },
    ]);
    expect(collapseFolderTrail(folderTrail("/a/b"), 4)).toEqual(folderTrail("/a/b"));
  });

  it("offers the default root and existing Project parents once each", () => {
    expect(folderQuickJumps("/Users/dev", ["/Users/dev/Projects", "/Users/dev/Projects", "/work"], "/work")).toEqual([
      { name: "dev", path: "/Users/dev" },
      { name: "Projects", path: "/Users/dev/Projects" },
    ]);
  });
});

describe("Add Project dialog", () => {
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

  const render = async (
    createProject = vi.fn(async () => undefined),
    extra: { pickLocalFolder?: (defaultPath?: string) => Promise<string | null>; profiles?: ConnectionProfileSummary[] } = {},
  ) => {
    await act(async () => root.render(createElement(ProjectDialog, {
      open: true,
      close: vi.fn(),
      projects: [],
      listProfiles: async () => extra.profiles ?? [],
      defaultProjectsRoot: async () => ({ path: "/Users/dev" }),
      browseDirectory: async (_profileId: string, path: string) => browse(path),
      createProject,
      ...(extra.pickLocalFolder ? { pickLocalFolder: extra.pickLocalFolder } : {}),
    })));
    await act(async () => undefined);
    return createProject;
  };

  it("selects a folder on one click without leaving the folder on screen", async () => {
    await render();
    expect(rowNames(container)).toEqual(["Downloads", "Projects"]);
    // Nothing is chosen for the user: the starting folder must not become an
    // accidental Project just because the dialog opened there.
    expect(selectionTitle(container)).toBe("No folder chosen yet");
    expect(container.querySelector<HTMLButtonElement>(".primary-button")?.disabled).toBe(true);

    await act(async () => rows(container)[1]?.click());
    expect(selectedPath(container)).toBe("/Users/dev/Projects");
    expect(rowNames(container)).toEqual(["Downloads", "Projects"]);
    expect(input(container, "#project-name").value).toBe("Projects");
    expect(container.querySelector<HTMLButtonElement>(".primary-button")?.textContent).toBe("Add Projects");
  });

  it("opens a folder from its chevron and keeps it selected", async () => {
    await render();
    const open = rows(container)[1]?.querySelector<HTMLButtonElement>(".folder-row-open");
    await act(async () => open?.click());

    expect(rowNames(container)).toEqual(["nucleus", "termloop-next"]);
    expect(selectedPath(container)).toBe("/Users/dev/Projects");
    expect(container.querySelector(".folder-selection-tag")?.textContent).toBe("open folder");
  });

  it("walks back to the parent with the folder just left highlighted", async () => {
    await render();
    await act(async () => rows(container)[1]?.querySelector<HTMLButtonElement>(".folder-row-open")?.click());
    const up = container.querySelector<HTMLButtonElement>('button[aria-label="Parent folder"]');
    await act(async () => up?.click());

    expect(rowNames(container)).toEqual(["Downloads", "Projects"]);
    expect(rows(container)[1]?.getAttribute("aria-selected")).toBe("true");
    expect(selectedPath(container)).toBe("/Users/dev/Projects");
  });

  it("filters the current folder and moves the highlight with the arrow keys", async () => {
    await render();
    await act(async () => rows(container)[1]?.querySelector<HTMLButtonElement>(".folder-row-open")?.click());

    const filter = input(container, 'input[aria-label="Filter folders"]');
    await act(async () => type(filter, "term"));
    expect(rowNames(container)).toEqual(["termloop-next"]);
    expect(container.querySelector(".folder-filter-count")?.textContent).toBe("1/2");

    await act(async () => press(filter, "ArrowDown"));
    expect(selectedPath(container)).toBe("/Users/dev/Projects/termloop-next");

    await act(async () => press(filter, "Escape"));
    expect(rowNames(container)).toEqual(["nucleus", "termloop-next"]);
  });

  it("submits the highlighted folder with the name it filled in", async () => {
    const createProject = await render();
    await act(async () => rows(container)[1]?.querySelector<HTMLButtonElement>(".folder-row-open")?.click());
    await act(async () => rows(container)[1]?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".dialog-actions .primary-button")?.click());

    expect(createProject).toHaveBeenCalledWith("local", "termloop-next", "/Users/dev/Projects/termloop-next");
  });

  it("has no OS panel button until one is wired in", async () => {
    await render();
    expect(container.querySelector(".folder-browse-button")).toBeNull();
  });

  it("reveals a natively picked folder among its siblings", async () => {
    const pickLocalFolder = vi.fn(async () => "/Users/dev/Projects/termloop-next");
    const createProject = await render(vi.fn(async () => undefined), { pickLocalFolder });

    await act(async () => container.querySelector<HTMLButtonElement>(".folder-browse-button")?.click());
    // The OS panel opens on whatever folder is already on screen.
    expect(pickLocalFolder).toHaveBeenCalledWith("/Users/dev");
    expect(rowNames(container)).toEqual(["nucleus", "termloop-next"]);
    expect(rows(container)[1]?.getAttribute("aria-selected")).toBe("true");
    expect(selectedPath(container)).toBe("/Users/dev/Projects/termloop-next");

    await act(async () => container.querySelector<HTMLButtonElement>(".primary-button")?.click());
    expect(createProject).toHaveBeenCalledWith("local", "termloop-next", "/Users/dev/Projects/termloop-next");
  });

  it("keeps the current choice when the OS panel is cancelled", async () => {
    await render(vi.fn(async () => undefined), { pickLocalFolder: async () => null });
    await act(async () => rows(container)[1]?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".folder-browse-button")?.click());

    expect(selectedPath(container)).toBe("/Users/dev/Projects");
    expect(rowNames(container)).toEqual(["Downloads", "Projects"]);
  });

  it("withdraws the OS panel on a remote computer it cannot see", async () => {
    const profiles: ConnectionProfileSummary[] = [
      { id: "local", name: "This Mac", transport: "local", scope: "local", endpoint: "", enabled: true, persistence: "local" },
      { id: "build", name: "Build box", transport: "ssh", scope: "full", endpoint: "ssh://build", enabled: true, persistence: "encrypted" },
    ];
    await render(vi.fn(async () => undefined), { pickLocalFolder: async () => null, profiles });
    expect(container.querySelector(".folder-browse-button")).not.toBeNull();

    const computer = container.querySelector<HTMLSelectElement>("#project-computer");
    if (!computer) throw new Error("no computer select");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(computer, "build");
      computer.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.querySelector(".folder-browse-button")).toBeNull();
  });

  it("stops following the folder once a name is typed", async () => {
    await render();
    const name = input(container, "#project-name");
    await act(async () => type(name, "Payments"));
    await act(async () => rows(container)[1]?.click());

    expect(input(container, "#project-name").value).toBe("Payments");
    // The confirm button names what will be added, which is the typed name and
    // no longer the folder it was going to be called after.
    expect(container.querySelector<HTMLButtonElement>(".primary-button")?.textContent).toBe("Add Payments");
  });

  it("puts the name field first so a short window cannot scroll it away", async () => {
    const profiles: ConnectionProfileSummary[] = [
      { id: "local", name: "This Mac", transport: "local", scope: "local", endpoint: "", enabled: true, persistence: "local" },
      { id: "build", name: "Build box", transport: "ssh", scope: "full", endpoint: "ssh://build", enabled: true, persistence: "encrypted" },
    ];
    await render(vi.fn(async () => undefined), { profiles });

    const fields = [...container.querySelectorAll(".project-dialog-body > .project-field")];
    expect(fields[0]?.querySelector("input")?.id).toBe("project-name");
    expect(fields[1]?.querySelector(".folder-picker")).not.toBeNull();
    // The connection picker rides along with the Folder label instead of owning
    // a third labelled field above the name.
    expect(container.querySelector(".project-field-aside #project-computer")).not.toBeNull();
  });
});

describe("Edit Project dialog", () => {
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

  const render = async (
    folderPath: string,
    updateProject = vi.fn(async () => undefined),
  ) => {
    await act(async () => root.render(createElement(ProjectDetailsDialog, {
      project: { id: "p1", name: "TermLoop", folder_path: folderPath, connectionProfileId: "local" },
      projects: [],
      close: vi.fn(),
      actions: { defaultRoot: async () => ({ path: "/Users/dev" }), browse },
      defaultProjectsRoot: async () => ({ path: "/Users/dev" }),
      updateProject,
    })));
    await act(async () => undefined);
    return updateProject;
  };

  it("opens on the Project's own folder", async () => {
    await render("/Users/dev/Projects");
    expect(rowNames(container)).toEqual(["nucleus", "termloop-next"]);
    expect(selectedPath(container)).toBe("/Users/dev/Projects");
    expect(container.querySelector(".quiet-text-button")).toBeNull();
  });

  it("falls back to the default root without silently repointing the Project", async () => {
    const updateProject = await render("/Volumes/gone");
    expect(container.querySelector(".folder-picker-error")?.textContent)
      .toContain("/Volumes/gone could not be opened");
    expect(rowNames(container)).toEqual(["Downloads", "Projects"]);
    expect(selectedPath(container)).toBe("/Volumes/gone");

    await act(async () => container.querySelector<HTMLButtonElement>(".dialog-actions .primary-button")?.click());
    expect(updateProject).toHaveBeenCalledWith("p1", "TermLoop", "/Volumes/gone");
  });

  it("offers an undo once the folder moves", async () => {
    await render("/Users/dev/Projects");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Parent folder"]')?.click());
    await act(async () => rows(container)[0]?.click());
    expect(selectedPath(container)).toBe("/Users/dev/Downloads");

    const undo = container.querySelector<HTMLButtonElement>(".quiet-text-button");
    expect(undo?.textContent).toBe("Undo folder change");
    await act(async () => undo?.click());
    expect(selectedPath(container)).toBe("/Users/dev/Projects");
  });

  it("is the repository facts only: Task defaults are not a Project setting", async () => {
    await render("/Users/dev/Projects");
    // The dialog lost its tab strip along with the Task automation page: those
    // defaults now live on the Task settings page, next to Task Sources.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('form[aria-label="New Task automation"]')).toBeNull();
    expect(container.querySelector("#project-task-automation-worktree")).toBeNull();
    expect(container.textContent).not.toContain("Task automation");
  });
});
