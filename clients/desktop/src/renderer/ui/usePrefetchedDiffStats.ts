import { useEffect, useRef, useState } from "react";
import { parseDiff } from "react-diff-view";
import type { CachedDiff } from "../change-source.js";
import { diffStats, type DiffStats } from "../diff-review.js";
import type { ChangeEntry } from "./ChangeFileTree.js";

/// Files read ahead per listing; a larger change set counts only its first ones.
export const MAX_PREFETCHED_STATS = 200;
const CONCURRENT_READS = 3;

/// Added/removed line counts for every listed file, read in the background
/// so the file tree shows them before a file is opened. Only the counts are
/// kept; read patches are dropped and stay out of the bounded diff cache.
/// `scope` names the listing (source and observation); a new scope starts over.
export function usePrefetchedDiffStats({ scope, entries, readDiff, cachedDiff }: {
  scope: string | undefined;
  entries: readonly ChangeEntry[];
  readDiff(entryId: string): Promise<CachedDiff>;
  cachedDiff(entryId: string): CachedDiff | undefined;
}): ReadonlyMap<string, DiffStats> {
  const [counted, setCounted] = useState<{ scope: string | undefined; stats: ReadonlyMap<string, DiffStats> }>(
    () => ({ scope, stats: new Map() }),
  );
  const reads = useRef({ readDiff, cachedDiff });
  reads.current = { readDiff, cachedDiff };
  const requested = useRef<{ scope: string | undefined; ids: Set<string> }>({ scope, ids: new Set() });

  useEffect(() => {
    if (!scope) return;
    if (requested.current.scope !== scope) requested.current = { scope, ids: new Set() };
    const ids = requested.current.ids;
    const queue = entries
      .filter((entry) => entry.render_state !== "notShown")
      .slice(0, MAX_PREFETCHED_STATS)
      .map((entry) => entry.entry_id)
      .filter((id) => !ids.has(id));
    if (!queue.length) return;
    for (const id of queue) ids.add(id);
    let active = true;
    let stopped = false;
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined && active && !stopped; id = queue.shift()) {
        let stats: DiffStats | undefined;
        try {
          const diff = reads.current.cachedDiff(id) ?? await reads.current.readDiff(id);
          if (diff.state === "patch" && diff.patch) {
            const file = parseDiff(diff.patch)[0];
            if (file) stats = diffStats(file.hunks);
          }
        } catch {
          // A failed read usually means the listing went stale; stop reading
          // ahead and leave the rest uncounted until the next listing.
          stopped = true;
        }
        if (!active || stopped) {
          ids.delete(id);
          break;
        }
        if (stats) {
          const value = stats;
          setCounted((current) => {
            const base = current.scope === scope ? current.stats : new Map<string, DiffStats>();
            return { scope, stats: new Map(base).set(id, value) };
          });
        }
      }
    };
    void Promise.all(Array.from({ length: CONCURRENT_READS }, worker)).then(() => {
      if (stopped) for (const id of queue) ids.delete(id);
    });
    return () => {
      active = false;
      for (const id of queue) ids.delete(id);
    };
  }, [entries, scope]);

  return counted.scope === scope ? counted.stats : EMPTY;
}

const EMPTY: ReadonlyMap<string, DiffStats> = new Map();
