import type { WorkspaceFileReadResult, WorkspaceFileWriteResult } from "@termloop/contract/current";

export type FileEditorIo = {
  read(path: string): Promise<WorkspaceFileReadResult>;
  write(path: string, content: string, expectedVersion: string): Promise<WorkspaceFileWriteResult>;
};

export type FileEditorTab = {
  path: string;
  status: "loading" | "ready" | "unavailable";
  /// The last content and version known to be on disk.
  saved?: { content: string; version: string } | undefined;
  /// The draft differs from `saved.content`.
  dirty: boolean;
  saving: boolean;
  /// The disk moved past `saved`; `version` is null when it can no longer be compared.
  conflict?: { version: string | null } | undefined;
  message?: string | undefined;
};

export type FileEditorSnapshot = { tabs: readonly FileEditorTab[]; active: string | undefined };

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function fileEditorMessage(state: WorkspaceFileReadResult["state"]): string {
  switch (state) {
    case "text": return "This file cannot be edited.";
    case "binary": return "Binary files and text that is not UTF-8 cannot be opened in the editor.";
    case "tooLarge": return "This file exceeds the editor limit of 256 KiB or 20,000 lines.";
    case "symlink": return "Symbolic links are shown without opening their targets.";
    case "unsupported": return "Only regular text files can be opened in the editor.";
  }
}

/** Open editor tabs for one Project or Task root. File content stays in memory;
 * every save is a compare-and-swap against the version the tab last read.
 * Drafts live outside the snapshot so typing publishes only dirty-state flips. */
export class FileEditor {
  private snapshot: FileEditorSnapshot = { tabs: [], active: undefined };
  private listeners = new Set<() => void>();
  private active = true;
  private drafts = new Map<string, string>();
  // Per-path request counters drop late reads after a newer read, reload or close.
  private requests = new Map<string, number>();

  constructor(private readonly io: FileEditorIo) {}
  getSnapshot = (): FileEditorSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  dispose(): void { this.active = false; this.requests.clear(); }
  dirty(): boolean { return this.snapshot.tabs.some((tab) => tab.dirty); }
  tab(path: string): FileEditorTab | undefined { return this.snapshot.tabs.find((tab) => tab.path === path); }
  draft(path: string): string { return this.drafts.get(path) ?? this.tab(path)?.saved?.content ?? ""; }

  private publish(update: Partial<FileEditorSnapshot>): void {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private update(path: string, change: (tab: FileEditorTab) => FileEditorTab): void {
    if (!this.tab(path)) return;
    this.publish({ tabs: this.snapshot.tabs.map((tab) => tab.path === path ? change(tab) : tab) });
  }
  private request(path: string): () => boolean {
    const id = (this.requests.get(path) ?? 0) + 1;
    this.requests.set(path, id);
    return () => this.active && this.requests.get(path) === id && this.tab(path) !== undefined;
  }

  open(path: string): void {
    if (this.tab(path)) { this.activate(path); return; }
    this.publish({ tabs: [...this.snapshot.tabs, { path, status: "loading", dirty: false, saving: false }], active: path });
    void this.load(path, false);
  }

  activate(path: string): void {
    if (!this.tab(path) || this.snapshot.active === path) return;
    this.publish({ active: path });
    this.revalidate(path);
  }

  /// Picks up edits made outside the editor while this tab has none of its own.
  revalidate(path: string): void {
    const tab = this.tab(path);
    if (tab?.status === "ready" && !tab.dirty && !tab.saving) void this.load(path, true);
  }

  reload(path: string): void { void this.load(path, false); }

  private async load(path: string, quiet: boolean): Promise<void> {
    const current = this.request(path);
    if (!quiet) this.update(path, (tab) => ({ ...tab, status: tab.saved ? tab.status : "loading", message: undefined }));
    try {
      const result = await this.io.read(path);
      if (!current()) return;
      const tab = this.tab(path)!;
      if (quiet && (tab.dirty || tab.saved?.version === result.version)) return;
      this.drafts.delete(path);
      if (result.state === "text" && result.version) {
        const saved = { content: result.content ?? "", version: result.version };
        this.update(path, (tab) => ({ ...tab, status: "ready", saved, dirty: false, conflict: undefined, message: undefined }));
      } else {
        this.update(path, (tab) => ({ ...tab, status: "unavailable", saved: undefined, dirty: false, conflict: undefined, message: fileEditorMessage(result.state) }));
      }
    } catch (error) {
      if (!current() || quiet) return;
      this.update(path, (tab) => tab.saved ? { ...tab, message: errorMessage(error, "The file could not be reloaded.") }
        : { ...tab, status: "unavailable", message: errorMessage(error, "The file could not be opened. Try again.") });
    }
  }

  edit(path: string, draft: string): void {
    const tab = this.tab(path);
    if (tab?.status !== "ready" || !tab.saved) return;
    this.drafts.set(path, draft);
    const dirty = draft !== tab.saved.content;
    if (dirty !== tab.dirty) this.update(path, (current) => ({ ...current, dirty }));
  }

  /// `overwrite` replaces a conflicting disk version the user has seen.
  async save(path: string, overwrite = false): Promise<void> {
    const tab = this.tab(path);
    if (tab?.status !== "ready" || !tab.saved || tab.saving) return;
    const expected = overwrite ? tab.conflict?.version : tab.saved.version;
    if (!expected || (!overwrite && !tab.dirty)) return;
    const content = this.draft(path);
    const current = this.request(path);
    this.update(path, (tab) => ({ ...tab, saving: true, message: undefined }));
    try {
      const result = await this.io.write(path, content, expected);
      if (!current()) return;
      if (result.state === "written" && result.version) {
        const saved = { content, version: result.version };
        // Typing during the write keeps the tab dirty against what was written.
        this.update(path, (tab) => ({ ...tab, saving: false, saved, dirty: this.draft(path) !== content, conflict: undefined }));
      } else {
        this.update(path, (tab) => ({ ...tab, saving: false, conflict: { version: result.version } }));
      }
    } catch (error) {
      if (!current()) return;
      this.update(path, (tab) => ({ ...tab, saving: false, message: errorMessage(error, "The file could not be saved. Try again.") }));
    }
  }

  close(path: string): void {
    const index = this.snapshot.tabs.findIndex((tab) => tab.path === path);
    if (index < 0) return;
    this.requests.delete(path);
    this.drafts.delete(path);
    const tabs = this.snapshot.tabs.filter((tab) => tab.path !== path);
    const active = this.snapshot.active === path ? tabs[Math.min(index, tabs.length - 1)]?.path : this.snapshot.active;
    this.publish({ tabs, active });
  }
}
