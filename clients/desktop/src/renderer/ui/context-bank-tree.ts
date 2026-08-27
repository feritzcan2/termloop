import type { ContextBankCatalogItemDto, ContextBankSiblingConflictDto } from "@termloop/contract/current";

export type ContextBankTreeNode =
  | {
    kind: "folder";
    id: string;
    label: string;
    depth: number;
    children: ContextBankTreeNode[];
  }
  | {
    kind: "file";
    id: string;
    depth: number;
    file: ContextBankCatalogItemDto;
  }
  | {
    kind: "conflict";
    id: string;
    depth: number;
    conflict: ContextBankSiblingConflictDto;
  };

type Directory = {
  children: Map<string, Directory>;
  files: ContextBankCatalogItemDto[];
  conflicts: ContextBankSiblingConflictDto[];
};

function directory(): Directory {
  return { children: new Map(), files: [], conflicts: [] };
}

export function buildContextBankTree(
  files: readonly ContextBankCatalogItemDto[],
  conflicts: readonly ContextBankSiblingConflictDto[],
  projectName: string,
): ContextBankTreeNode[] {
  if (!files.length) return [];

  const root = directory();
  for (const file of files) {
    const parts = file.relativePath.split("/").filter(Boolean);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      let child = current.children.get(part);
      if (!child) {
        child = directory();
        current.children.set(part, child);
      }
      current = child;
    }
    current.files.push(file);
  }
  for (const conflict of conflicts) {
    const parts = conflict.directoryPath === "." ? [] : conflict.directoryPath.split("/").filter(Boolean);
    let current = root;
    for (const part of parts) {
      let child = current.children.get(part);
      if (!child) {
        child = directory();
        current.children.set(part, child);
      }
      current = child;
    }
    current.conflicts.push(conflict);
  }

  return [{
    kind: "folder",
    id: "/",
    label: projectName,
    depth: 0,
    children: convertDirectory(root, "", 1),
  }];
}

function convertDirectory(source: Directory, parentId: string, depth: number): ContextBankTreeNode[] {
  const nodes: ContextBankTreeNode[] = [];
  const folders = [...source.children.entries()].sort(([left], [right]) => left.localeCompare(right, "en-US"));

  for (const [name, child] of folders) {
    let label = name;
    let current = child;
    while (!current.files.length && !current.conflicts.length && current.children.size === 1) {
      const [nextName, nextChild] = current.children.entries().next().value as [string, Directory];
      label += `/${nextName}`;
      current = nextChild;
    }
    const id = parentId ? `${parentId}/${label}` : label;
    nodes.push({
      kind: "folder",
      id,
      label,
      depth,
      children: convertDirectory(current, id, depth + 1),
    });
  }

  const files = [...source.files].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en-US"));
  for (const file of files) nodes.push({ kind: "file", id: file.id, depth, file });
  for (const conflict of source.conflicts) {
    nodes.push({ kind: "conflict", id: conflict.id, depth, conflict });
  }
  return nodes;
}
