import { describe, expect, it } from "vitest";
import {
  buildChangeTree,
  changeKindLabel,
  changeKindSymbol,
  changeTreeFolderId,
  visibleChangeTreeEntries,
} from "../src/renderer/change-tree.js";

type Entry = { entry_id: string; display_path: string };

describe("change tree", () => {
  const entries: Entry[] = [
    { entry_id: "root", display_path: "README.md" },
    { entry_id: "ui", display_path: "clients/desktop/src/ui.tsx" },
    { entry_id: "app", display_path: "clients/desktop/src/app.tsx" },
    { entry_id: "core", display_path: "modules/core/src/lib.rs" },
  ];

  it("groups paths into deterministic folder-first nodes", () => {
    const tree = buildChangeTree(entries);
    expect(tree.map((node) => node.name)).toEqual(["clients", "modules", "README.md"]);
    const clients = tree[0];
    expect(clients?.kind).toBe("folder");
    if (clients?.kind !== "folder") return;
    const desktop = clients.children[0];
    expect(desktop?.kind).toBe("folder");
    if (desktop?.kind !== "folder") return;
    const src = desktop.children[0];
    expect(src?.kind).toBe("folder");
    if (src?.kind !== "folder") return;
    expect(src.children.map((node) => node.name)).toEqual(["app.tsx", "ui.tsx"]);
  });

  it("omits files below collapsed folders from keyboard navigation", () => {
    const tree = buildChangeTree(entries);
    const collapsed = new Set([changeTreeFolderId("files", "clients")]);
    expect(visibleChangeTreeEntries(tree, collapsed, "files").map((entry) => entry.entry_id))
      .toEqual(["core", "root"]);
  });

  it("keeps display collisions as independently selectable opaque entries", () => {
    const tree = buildChangeTree([
      { entry_id: "exact-1", display_path: "raw-�.txt" },
      { entry_id: "exact-2", display_path: "raw-�.txt" },
    ]);
    expect(visibleChangeTreeEntries(tree, new Set(), "files").map((entry) => entry.entry_id))
      .toEqual(["exact-1", "exact-2"]);
  });

  it("joins single-folder chains into one row keyed by the deepest folder", () => {
    const tree = buildChangeTree(entries, { compact: true });
    expect(tree.map((node) => node.name)).toEqual(["clients/desktop/src", "modules/core/src", "README.md"]);
    const clients = tree[0];
    if (clients?.kind !== "folder") throw new Error("expected a folder");
    expect(clients.path).toBe("clients/desktop/src");
    expect(clients.children.map((node) => node.name)).toEqual(["app.tsx", "ui.tsx"]);
    const collapsed = new Set([changeTreeFolderId("files", "clients/desktop/src")]);
    expect(visibleChangeTreeEntries(tree, collapsed, "files").map((entry) => entry.entry_id)).toEqual(["core", "root"]);
  });

  it("stops joining where a folder holds files or several folders", () => {
    const tree = buildChangeTree([
      { entry_id: "a", display_path: "svc/src/a.cs" },
      { entry_id: "b", display_path: "svc/test/b.cs" },
      { entry_id: "c", display_path: "svc/readme.md" },
    ], { compact: true });
    const svc = tree[0];
    if (svc?.kind !== "folder") throw new Error("expected a folder");
    expect(svc.name).toBe("svc");
    expect(svc.children.map((node) => node.name)).toEqual(["src", "test", "readme.md"]);
  });

  it("uses explicit, color-independent file status symbols", () => {
    expect(changeKindSymbol("added")).toBe("+");
    expect(changeKindSymbol("deleted")).toBe("−");
    expect(changeKindSymbol("unmerged")).toBe("!");
    expect(changeKindLabel("renamed")).toBe("Renamed");
    expect(changeKindLabel("modified")).toBe("Modified");
  });
});
