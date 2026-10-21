import type { WorkspaceFileEntryDto, WorkspaceFileSearchResult } from "@termloop/contract/current";

export type FileSearchSnapshot = {
  query: string;
  status: "idle" | "searching" | "ready" | "error";
  entries: readonly WorkspaceFileEntryDto[];
  total: number;
  incomplete: boolean;
  unreadable: boolean;
  error?: string | undefined;
};

const SEARCH_DEBOUNCE_MS = 120;
const EMPTY = { entries: [], total: 0, incomplete: false, unreadable: false } as const;

/** Sends each settled query to the daemon's single workspace walk. Generations
 * drop late responses after a newer query, refresh, or disposal. */
export class FileSearch {
  private snapshot: FileSearchSnapshot = { query: "", status: "idle", ...EMPTY };
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly search: (query: string) => Promise<WorkspaceFileSearchResult>, private readonly debounce = SEARCH_DEBOUNCE_MS) {}
  getSnapshot = (): FileSearchSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start(): void { this.active = true; }
  dispose(): void { this.active = false; this.generation++; clearTimeout(this.timer); }
  private publish(update: Partial<FileSearchSnapshot>): void {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }
  setQuery(query: string): void {
    if (!this.active || query === this.snapshot.query) return;
    this.publish({ query });
    this.refresh();
  }
  refresh(): void {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    const query = this.snapshot.query.trim();
    if (!query) { this.publish({ status: "idle", ...EMPTY, error: undefined }); return; }
    this.publish({ status: "searching", error: undefined });
    this.timer = setTimeout(() => { void this.run(generation, query); }, this.debounce);
  }
  private async run(generation: number, query: string): Promise<void> {
    const current = () => this.active && generation === this.generation;
    try {
      const result = await this.search(query);
      if (!current()) return;
      this.publish({ status: "ready", entries: result.entries, total: result.total, incomplete: result.incomplete, unreadable: result.unreadable });
    } catch (error) {
      if (!current()) return;
      this.publish({ status: "error", ...EMPTY, error: error instanceof Error ? error.message : "File search failed. Try Refresh." });
    }
  }
}
