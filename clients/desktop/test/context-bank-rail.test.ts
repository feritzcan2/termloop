// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextBankCatalogResult } from "@termloop/contract/current";
import { ContextBankRail } from "../src/renderer/ui/ContextBankRail.js";

const catalog: ContextBankCatalogResult = {
  projectName: "TermLoop",
  truncated: false,
  warnings: [],
  siblingConflicts: [{
    id: "d".repeat(64),
    directoryPath: "apps/server",
    fileIds: ["b".repeat(64), "c".repeat(64)],
  }],
  files: [
    {
      id: "a".repeat(64),
      relativePath: "AGENTS.md",
      kind: "agents",
      lineCount: 42,
      lineLimit: 200,
      overLimit: false,
      isSymlink: false,
      symlinkTargetPath: null,
    },
    {
      id: "b".repeat(64),
      relativePath: "apps/server/CLAUDE.md",
      kind: "claude",
      lineCount: 50,
      lineLimit: 100,
      overLimit: false,
      isSymlink: true,
      symlinkTargetPath: "apps/server/AGENTS.md",
    },
    {
      id: "c".repeat(64),
      relativePath: "apps/server/GEMINI.md",
      kind: "gemini",
      lineCount: 121,
      lineLimit: 100,
      overLimit: true,
      isSymlink: false,
      symlinkTargetPath: null,
    },
  ],
};

describe("Context Bank rail", () => {
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

  it("groups root and nested instruction files with capacity and integrity facts", async () => {
    await act(async () => root.render(createElement(ContextBankRail, {
      projectOpen: true,
      load: async () => catalog,
      selectedFileId: undefined,
      openFile: vi.fn(),
      resolveConflict: vi.fn(),
    })));
    await act(async () => undefined);

    const folders = [...container.querySelectorAll<HTMLElement>(".context-tree-folder-row")];
    expect(folders.map((folder) => folder.querySelector("span")?.textContent)).toEqual([
      "TermLoop",
      "apps/server",
    ]);
    expect(container.textContent).toContain("42/200");
    expect(container.querySelector(".context-tree-capacity.over-limit")?.textContent).toContain("121/100");
    expect(container.textContent).toContain("→ apps/server/AGENTS.md");
    expect(container.querySelector<HTMLElement>('[title="42 of 200 recommended lines"] i b')?.style.width).toBe("21%");
    expect(container.querySelector(".context-bank-warning")).toBeNull();
    expect(container.querySelector(".context-tree-conflict-row")?.textContent).toContain("Sibling instruction files differ");
  });

  it("opens the selected opaque file identity", async () => {
    const openFile = vi.fn();
    await act(async () => root.render(createElement(ContextBankRail, {
      projectOpen: true,
      load: async () => catalog,
      selectedFileId: "a".repeat(64),
      openFile,
      resolveConflict: vi.fn(),
    })));
    await act(async () => undefined);

    const selected = container.querySelector<HTMLButtonElement>('.context-tree-file[aria-current="true"]');
    await act(async () => selected?.click());
    expect(openFile).toHaveBeenCalledWith("a".repeat(64));
  });

  it("collapses the project tree while search keeps matching paths expanded", async () => {
    await act(async () => root.render(createElement(ContextBankRail, {
      projectOpen: true,
      load: async () => catalog,
      selectedFileId: undefined,
      openFile: vi.fn(),
      resolveConflict: vi.fn(),
    })));
    await act(async () => undefined);

    const rootFolder = container.querySelector<HTMLButtonElement>(".context-tree-folder-row.root");
    await act(async () => rootFolder?.click());
    expect(container.querySelector(".context-tree-file")).toBeNull();

    const search = container.querySelector<HTMLInputElement>('[aria-label="Search Context Bank"]');
    await act(async () => {
      if (!search) throw new Error("search missing");
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(search, "gemini");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".context-tree-file")?.textContent).toContain("GEMINI.md");
  });

  it("chooses a source file and resolves only the inline sibling conflict", async () => {
    const resolveConflict = vi.fn().mockResolvedValue({ ...catalog, siblingConflicts: [] });
    await act(async () => root.render(createElement(ContextBankRail, {
      projectOpen: true,
      load: async () => catalog,
      selectedFileId: undefined,
      openFile: vi.fn(),
      resolveConflict,
    })));
    await act(async () => undefined);

    await act(async () => container.querySelector<HTMLButtonElement>(".context-tree-conflict-row button")?.click());
    const gemini = [...container.querySelectorAll<HTMLButtonElement>(".context-conflict-sources button")]
      .find((button) => button.textContent?.includes("GEMINI.md"));
    await act(async () => gemini?.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".context-conflict-resolver .danger-button")?.click());

    expect(resolveConflict).toHaveBeenCalledWith("d".repeat(64), "c".repeat(64));
    expect(container.querySelector(".context-tree-conflict-row")).toBeNull();
  });

  it("does not scan without a selected Project", async () => {
    const load = vi.fn();
    await act(async () => root.render(createElement(ContextBankRail, {
      projectOpen: false,
      load,
      selectedFileId: undefined,
      openFile: vi.fn(),
      resolveConflict: vi.fn(),
    })));
    expect(load).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Open a Project");
  });
});
