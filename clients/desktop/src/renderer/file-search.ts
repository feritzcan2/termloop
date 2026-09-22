import type { WorkspaceDirectoryResult, WorkspaceFileEntryDto } from "@termloop/contract/current";

export type FileSearchSnapshot = {
  query: string;
  status: "idle" | "searching" | "ready";
  entries: readonly WorkspaceFileEntryDto[];
  total: number;
  page: number;
  pages: number;
  directories: number;
  incomplete: boolean;
  unreadable: boolean;
};

const SEARCH_LIMITS = { cacheBytes: 32 * 1024 * 1024, results: 200, milliseconds: 8_000, debounce: 180 };
// Match the daemon's bounded file observation capacity without flooding its queue.
const CONCURRENT_DIRECTORIES = 2;
const normalize = (value: string) => value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
type IndexedFile = { entry: WorkspaceFileEntryDto; path: string };

/** Traverse the whole workspace using bounded directory pages. Only the cache
 * and visible result page are capped; reaching either never cuts off the scan. */
export class FileSearch {
  private snapshot: FileSearchSnapshot = { query: "", status: "idle", entries: [], total: 0, page: 0, pages: 0, directories: 0, incomplete: false, unreadable: false };
  private listeners = new Set<() => void>();
  private index: IndexedFile[] = [];
  private matches: WorkspaceFileEntryDto[] = [];
  private cacheComplete = true;
  private generation = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort = new AbortController();
  private readonly limits: typeof SEARCH_LIMITS;

  constructor(private readonly list: (path: string, afterName?: string) => Promise<WorkspaceDirectoryResult>, limits: Partial<typeof SEARCH_LIMITS> = {}) {
    this.limits = { ...SEARCH_LIMITS, ...limits };
  }
  getSnapshot = (): FileSearchSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  start(): void { this.active = true; }
  dispose(): void {
    this.active = false; this.generation++; clearTimeout(this.timer); this.abort.abort();
    this.index = []; this.matches = [];
  }
  private publish(update: Partial<FileSearchSnapshot>): void {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private publishMatches(update: Partial<FileSearchSnapshot> = {}): void {
    const pages = Math.ceil(this.matches.length / this.limits.results);
    const page = Math.max(0, Math.min(update.page ?? this.snapshot.page, pages - 1));
    this.publish({ ...update, page, pages, total: this.matches.length,
      entries: this.matches.slice(page * this.limits.results, (page + 1) * this.limits.results) });
  }
  setPage(page: number): void { this.publishMatches({ page }); }
  private terms(): string[] { return normalize(this.snapshot.query.trim()).split(/\s+/u); }
  setQuery(query: string): void {
    if (!this.active || query === this.snapshot.query) return;
    this.publish({ query, page: 0 });
    if (!this.cacheComplete) { this.refresh(); return; }
    // Clearing the input hides results, but keeps the index and any ongoing
    // crawl. Typing the next filename must not start again at the root.
    if (!query.trim()) { this.matches = []; this.publishMatches(); return; }
    const terms = this.terms();
    this.matches = this.index.filter((item) => terms.every((term) => item.path.includes(term))).map((item) => item.entry);
    this.publishMatches();
    if (this.snapshot.status === "idle") this.schedule();
  }
  refresh(): void {
    this.generation++; clearTimeout(this.timer); this.abort.abort(); this.abort = new AbortController();
    this.index = []; this.matches = []; this.cacheComplete = true;
    this.publishMatches({ status: "idle", page: 0, directories: 0, incomplete: false, unreadable: false });
    if (this.active && this.snapshot.query.trim()) this.schedule();
  }
  private schedule(): void {
    this.publish({ status: "searching" });
    const generation = this.generation;
    this.timer = setTimeout(() => { void this.scan(generation); }, this.limits.debounce);
  }
  private async scan(generation: number): Promise<void> {
    const current = () => this.active && generation === this.generation;
    const signal = this.abort.signal;
    const queue = [""];
    const encoder = new TextEncoder();
    let bytes = 0;
    let directories = 0;
    let incomplete = false;
    let unreadable = false;
    let publishedAt = 0;
    const pending = new Set<Promise<void>>();
    let pump: () => void;
    const scanDirectory = async (path: string): Promise<void> => {
      let afterName: string | undefined;
      do {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        let listing: WorkspaceDirectoryResult;
        try {
          listing = await Promise.race([
            afterName ? this.list(path, afterName) : this.list(path),
            new Promise<never>((_resolve, reject) => {
              cancel = () => reject(new Error("File search cancelled"));
              signal.addEventListener("abort", cancel, { once: true });
              timeout = setTimeout(() => reject(new Error("Directory listing timed out")), this.limits.milliseconds);
            }),
          ]);
        } catch {
          if (!current()) return;
          unreadable = true;
          break;
        } finally { clearTimeout(timeout); signal.removeEventListener("abort", cancel); }
        if (!current()) return;
        incomplete ||= Boolean(listing.omitted || (listing.truncated && !listing.next_name));
        const terms = this.terms();
        for (const entry of listing.entries) {
          if (entry.kind === "directory") { queue.push(entry.path); continue; }
          const normalizedPath = normalize(entry.path);
          if (this.snapshot.query.trim() && terms.every((term) => normalizedPath.includes(term))) this.matches.push(entry);
          if (this.cacheComplete) {
            bytes += encoder.encode(entry.path).length * 2 + encoder.encode(entry.name).length;
            if (bytes > this.limits.cacheBytes) {
              // Keep scanning for this query. A later query gets a fresh scan
              // instead of being filtered against a silently partial index.
              this.cacheComplete = false; this.index = [];
            } else this.index.push({ entry, path: normalizedPath });
          }
        }
        if (Date.now() - publishedAt >= 100) {
          this.publishMatches({ directories, incomplete, unreadable }); publishedAt = Date.now();
        }
        if (listing.next_name && listing.next_name === afterName) { incomplete = true; break; }
        afterName = listing.next_name;
        pump();
      } while (afterName && current());
      directories++;
    };
    await new Promise<void>((resolve) => {
      pump = () => {
        if (!current()) { resolve(); return; }
        while (queue.length && pending.size < CONCURRENT_DIRECTORIES) {
          const work = scanDirectory(queue.shift()!).finally(() => { pending.delete(work); pump(); });
          pending.add(work);
        }
        if (!pending.size) resolve();
      };
      pump();
    });
    if (current()) this.publishMatches({ status: "ready", directories, incomplete, unreadable });
  }
}
