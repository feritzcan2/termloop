import type { WorkspaceDirectoryResult, WorkspaceFileEntryDto, WorkspaceFileReadResult } from "@termloop/contract/current";
import { FileSearch } from "./file-search.js";

export type FilesSubject = { projectId: string; taskId: string | null; title: string };
export type FilesReader = {
  list(path: string, afterName?: string): Promise<WorkspaceDirectoryResult>;
  read(path: string): Promise<WorkspaceFileReadResult>;
};
export type DirectoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: WorkspaceDirectoryResult };
export type FilePreview =
  | { status: "empty" }
  | { status: "loading"; path: string }
  | { status: "error"; path: string; message: string }
  | { status: "ready"; path: string; result: WorkspaceFileReadResult };
export type FileBrowserSnapshot = {
  directories: ReadonlyMap<string, DirectoryState>;
  expanded: ReadonlySet<string>;
  preview: FilePreview;
  refreshing: boolean;
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Files could not be loaded. Try Refresh.";

/** In-memory observation state. Generations isolate refresh, selection and
 * unmount from late responses, including responses from a disconnected source. */
export class FileBrowser {
  readonly search: FileSearch;
  private snapshot: FileBrowserSnapshot = { directories: new Map(), expanded: new Set(), preview: { status: "empty" }, refreshing: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private selection = 0;
  private active = false;
  private pending = new Map<string, Promise<WorkspaceDirectoryResult | undefined>>();

  constructor(private readonly reader: FilesReader) { this.search = new FileSearch(reader.list); }
  getSnapshot = (): FileBrowserSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start(): void { this.active = true; this.search.start(); void this.refresh(); }
  dispose(): void { this.active = false; this.search.dispose(); this.generation++; this.selection++; this.pending.clear(); }
  clearPreview = (): void => { this.selection++; this.publish({ preview: { status: "empty" } }); };

  private publish(update: Partial<FileBrowserSnapshot>): void {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private directory(path: string, state: DirectoryState): void {
    const directories = new Map(this.snapshot.directories);
    directories.set(path, state);
    this.publish({ directories });
  }
  private load(path: string): Promise<WorkspaceDirectoryResult | undefined> {
    const existing = this.pending.get(path);
    if (existing) return existing;
    const generation = this.generation;
    this.directory(path, { status: "loading" });
    const request = Promise.resolve().then(() => this.reader.list(path)).then((result) => {
      if (!this.active || generation !== this.generation) return undefined;
      if (path !== "" && !this.snapshot.expanded.has(path)) return undefined;
      this.directory(path, { status: "ready", result });
      return result;
    }).catch((error: unknown) => {
      if (this.active && generation === this.generation && (path === "" || this.snapshot.expanded.has(path))) {
        this.directory(path, { status: "error", message: errorMessage(error) });
      }
      return undefined;
    }).finally(() => {
      if (generation === this.generation) this.pending.delete(path);
    });
    this.pending.set(path, request);
    return request;
  }

  toggle(path: string): void {
    if (this.snapshot.refreshing) return;
    const expanded = new Set(this.snapshot.expanded);
    if (expanded.has(path)) {
      const directories = new Map(this.snapshot.directories);
      // Closing a branch releases its cached listings; file content is never cached.
      for (const key of expanded) if (key === path || key.startsWith(`${path}/`)) expanded.delete(key);
      for (const key of directories.keys()) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
      this.publish({ expanded, directories });
    } else {
      expanded.add(path);
      this.publish({ expanded });
      void this.load(path);
    }
  }

  async select(path: string): Promise<void> {
    const selection = ++this.selection;
    const generation = this.generation;
    this.publish({ preview: { status: "loading", path } });
    try {
      const result = await this.reader.read(path);
      if (this.active && selection === this.selection && generation === this.generation) {
        this.publish({ preview: { status: "ready", path, result } });
      }
    } catch (error) {
      if (this.active && selection === this.selection && generation === this.generation) {
        this.publish({ preview: { status: "error", path, message: errorMessage(error) } });
      }
    }
  }

  async refresh(): Promise<void> {
    this.search.refresh();
    const generation = ++this.generation;
    const selection = ++this.selection;
    this.pending.clear();
    const selected = this.snapshot.preview.status === "empty" ? undefined : this.snapshot.preview.path;
    this.publish({ directories: new Map(), refreshing: true, preview: { status: "empty" } });
    const queue = [""];
    const found = new Set<string>();
    while (queue.length && this.active && generation === this.generation) {
      const path = queue.shift()!;
      const result = await this.load(path);
      if (!this.active || generation !== this.generation) return;
      for (const entry of result?.entries ?? []) {
        if (entry.kind === "directory" && this.snapshot.expanded.has(entry.path)) {
          found.add(entry.path);
          queue.push(entry.path);
        }
      }
    }
    if (!this.active || generation !== this.generation) return;
    this.publish({ expanded: found, refreshing: false });
    if (selected && selection === this.selection && this.snapshot.preview.status === "empty") await this.select(selected);
  }
}

export type FileTreeRow =
  | { kind: "entry"; entry: WorkspaceFileEntryDto; depth: number }
  | { kind: "message"; path: string; message: string; depth: number; error: boolean };

export function fileTreeRows(snapshot: Pick<FileBrowserSnapshot, "directories" | "expanded">): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const visit = (path: string, depth: number) => {
    const directory = snapshot.directories.get(path);
    if (!directory || directory.status === "loading") {
      rows.push({ kind: "message", path, depth, message: "Loading…", error: false });
    } else if (directory.status === "error") {
      rows.push({ kind: "message", path, depth, message: directory.message, error: true });
    } else {
      for (const entry of directory.result.entries) {
        rows.push({ kind: "entry", entry, depth });
        if (entry.kind === "directory" && snapshot.expanded.has(entry.path)) visit(entry.path, depth + 1);
      }
      if (directory.result.truncated) rows.push({ kind: "message", path, depth, message: "Some entries are omitted (listing limit or unsupported names).", error: false });
      else if (!directory.result.entries.length) rows.push({ kind: "message", path, depth, message: "Empty folder", error: false });
    }
  };
  visit("", 0);
  return rows;
}

export function filePreviewMessage(state: WorkspaceFileReadResult["state"]): string | undefined {
  switch (state) {
    case "text": return undefined;
    case "binary": return "Preview is unavailable for binary files or text that is not UTF-8.";
    case "tooLarge": return "This file exceeds the preview limit of 256 KiB or 20,000 lines.";
    case "symlink": return "Symbolic links are shown without opening their targets.";
    case "unsupported": return "Preview is available for regular text files only.";
  }
}
