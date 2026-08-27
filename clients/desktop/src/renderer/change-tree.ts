export type ChangeTreeNode<T> = ChangeTreeFolder<T> | ChangeTreeFile<T>;

export type ChangeTreeFolder<T> = {
  kind: "folder";
  name: string;
  path: string;
  children: readonly ChangeTreeNode<T>[];
};

export type ChangeTreeFile<T> = {
  kind: "file";
  name: string;
  entry: T;
};

type ChangeTreeEntry = {
  entry_id: string;
  display_path: string;
};

export type ChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "unmerged" | "untracked";

export function changeKindSymbol(kind: ChangeKind): string {
  return {
    modified: "M",
    added: "+",
    deleted: "−",
    renamed: "R",
    copied: "C",
    unmerged: "!",
    untracked: "+",
  }[kind];
}

export function changeKindLabel(kind: ChangeKind): string {
  return {
    modified: "Modified",
    added: "Added",
    deleted: "Deleted",
    renamed: "Renamed",
    copied: "Copied",
    unmerged: "Unmerged",
    untracked: "Untracked",
  }[kind];
}

type MutableFolder<T extends ChangeTreeEntry> = {
  name: string;
  path: string;
  folders: Map<string, MutableFolder<T>>;
  files: ChangeTreeFile<T>[];
};

export function buildChangeTree<T extends ChangeTreeEntry>(entries: readonly T[]): readonly ChangeTreeNode<T>[] {
  const root = mutableFolder<T>("", "");
  for (const entry of entries) {
    const segments = entry.display_path.split("/");
    const fileName = segments.pop() || entry.display_path;
    let folder = root;
    for (const name of segments) {
      const path = folder.path ? `${folder.path}/${name}` : name;
      let child = folder.folders.get(name);
      if (!child) {
        child = mutableFolder(name, path);
        folder.folders.set(name, child);
      }
      folder = child;
    }
    folder.files.push({ kind: "file", name: fileName, entry });
  }
  return freezeChildren(root);
}

export function visibleChangeTreeEntries<T>(
  nodes: readonly ChangeTreeNode<T>[],
  collapsedPaths: ReadonlySet<string>,
  sectionId: string,
): T[] {
  const visible: T[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      visible.push(node.entry);
    } else if (!collapsedPaths.has(changeTreeFolderId(sectionId, node.path))) {
      visible.push(...visibleChangeTreeEntries(node.children, collapsedPaths, sectionId));
    }
  }
  return visible;
}

export function changeTreeFolderId(sectionId: string, path: string): string {
  return `${sectionId}\u0000${path}`;
}

function mutableFolder<T extends ChangeTreeEntry>(name: string, path: string): MutableFolder<T> {
  return { name, path, folders: new Map(), files: [] };
}

function freezeChildren<T extends ChangeTreeEntry>(folder: MutableFolder<T>): readonly ChangeTreeNode<T>[] {
  const folders: ChangeTreeFolder<T>[] = [...folder.folders.values()]
    .sort((left, right) => compareNames(left.name, right.name))
    .map((child) => ({
      kind: "folder",
      name: child.name,
      path: child.path,
      children: freezeChildren(child),
    }));
  const files = [...folder.files].sort((left, right) => {
    const byName = compareNames(left.name, right.name);
    return byName || compareNames(left.entry.entry_id, right.entry.entry_id);
  });
  return [...folders, ...files];
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
