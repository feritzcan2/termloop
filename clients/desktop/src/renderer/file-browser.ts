import type { WorkspaceDirectoryResult, WorkspaceFileEntryDto, WorkspaceFileSearchResult } from "@termloop/contract/current";
import { FileSearch } from "./file-search.js";
import { controlErrorIsServiceBusy, controlErrorMessage } from "./control-error.js";

export type FilesSubject = { projectId: string; taskId: string | null; title: string };
export type FilesReader = {
  list(path: string, afterName?: string): Promise<WorkspaceDirectoryResult>;
  search(query: string): Promise<WorkspaceFileSearchResult>;
};
export type DirectoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: WorkspaceDirectoryResult };
export type FileBrowserSnapshot = {
  directories: ReadonlyMap<string, DirectoryState>;
  expanded: ReadonlySet<string>;
  refreshing: boolean;
};

// The daemon answers "repository is unavailable" when its Git and file
// observations stay queued past their deadline, typically while a Project's
// first checkout summaries run. A listing waits through that instead of failing.
const busy = (error: unknown) => controlErrorIsServiceBusy(error) || /repository is unavailable/iu.test(controlErrorMessage(error));
export const FILE_LIST_RETRY_DELAYS_MS = [500, 1500, 3000];
const errorMessage = (error: unknown) => busy(error) ? "The daemon is still busy reading this project. Try Refresh."
  : error instanceof Error ? controlErrorMessage(error) : "Files could not be loaded. Try Refresh.";
const wait = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });

/** In-memory observation state. Generations isolate refresh and
 * unmount from late responses, including responses from a disconnected source. */
export class FileBrowser {
  readonly search: FileSearch;
  private snapshot: FileBrowserSnapshot = { directories: new Map(), expanded: new Set(), refreshing: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private pending = new Map<string, Promise<WorkspaceDirectoryResult | undefined>>();

  constructor(private readonly reader: FilesReader) { this.search = new FileSearch(reader.search); }
  getSnapshot = (): FileBrowserSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start(): void { this.active = true; this.search.start(); void this.refresh(); }
  dispose(): void { this.active = false; this.search.dispose(); this.generation++; this.pending.clear(); }

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
    const wanted = () => this.active && generation === this.generation && (path === "" || this.snapshot.expanded.has(path));
    const list = async (): Promise<WorkspaceDirectoryResult> => {
      for (const delay of FILE_LIST_RETRY_DELAYS_MS) {
        try { return await this.reader.list(path); } catch (error) {
          if (!busy(error)) throw error;
        }
        await wait(delay);
        if (!wanted()) throw new Error("superseded");
      }
      return this.reader.list(path);
    };
    const request = Promise.resolve().then(list).then((result) => {
      if (!wanted()) return undefined;
      this.directory(path, { status: "ready", result });
      return result;
    }).catch((error: unknown) => {
      if (wanted()) this.directory(path, { status: "error", message: errorMessage(error) });
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

  collapseAll(): void {
    if (this.snapshot.refreshing || !this.snapshot.expanded.size) return;
    const root = this.snapshot.directories.get("");
    this.publish({ expanded: new Set(), directories: new Map(root ? [["", root]] : []) });
  }

  async refresh(): Promise<void> {
    this.search.refresh();
    const generation = ++this.generation;
    this.pending.clear();
    this.publish({ directories: new Map(), refreshing: true });
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
