import { useEffect, useMemo, useRef, useState } from "react";
import type { CachedDiff } from "../change-source.js";
import { changesReviewEntryKeys, persistableChangesReviewKey, readChangesReviewed, writeChangesReviewed } from "../changes-reviewed-memory.js";
import { changesReviewFingerprint, visitReviewEntries } from "../changes-review-fingerprints.js";
import type { ChangeEntry } from "./ChangeFileTree.js";

type ReviewObservation = {
  active: boolean;
  busy: boolean;
  fingerprint(entryId: string): Promise<string | null | undefined>;
};

export function useChangesReviewed({ owner, scope, observationId, entries, loading, truncated, readDiff, cachedDiff }: {
  owner: string;
  scope: string | undefined;
  observationId: string | undefined;
  entries: readonly ChangeEntry[];
  loading: boolean;
  truncated: boolean;
  readDiff(entryId: string): Promise<CachedDiff>;
  cachedDiff(entryId: string): CachedDiff | undefined;
}) {
  const [saved, setSaved] = useState(() => readChangesReviewed(owner));
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const [reviewedEntryIds, setReviewedEntryIds] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const reads = useRef({ readDiff, cachedDiff, scope, observationId });
  reads.current = { readDiff, cachedDiff, scope, observationId };
  const session = useRef<ReviewObservation | undefined>(undefined);
  const keys = useMemo(() => changesReviewEntryKeys(scope, observationId, entries), [scope, observationId, entries]);
  useEffect(() => { writeChangesReviewed(owner, saved); }, [owner, saved]);

  useEffect(() => {
    setReviewedEntryIds(new Set());
    setNotice(undefined);
    setBusy(false);
    if (loading || !scope || !observationId) return;
    const readCurrentDiff = reads.current.readDiff;
    const fingerprints = new Map<string, Promise<string | null | undefined>>();
    const observation: ReviewObservation = {
      active: true,
      busy: false,
      fingerprint(entryId) {
        const existing = fingerprints.get(entryId);
        if (existing) return existing;
        const pending = (async () => {
          try {
            if (!observation.active) return undefined;
            const cached = reads.current.scope === scope && reads.current.observationId === observationId
              ? reads.current.cachedDiff(entryId) : undefined;
            const diff = cached ?? await readCurrentDiff(entryId);
            if (!observation.active) return undefined;
            const fingerprint = await changesReviewFingerprint(diff);
            return observation.active ? fingerprint : undefined;
          } catch {
            return undefined;
          }
        })();
        fingerprints.set(entryId, pending);
        return pending;
      },
    };
    session.current = observation;
    const previous = savedRef.current;
    const candidates = [...keys.keys()].filter((id) => previous.has(keys.get(id)!));
    // A disappeared file must not regain a stale mark if it later reappears.
    // A truncated list does not prove the absence of entries beyond its limit.
    if (!truncated) {
      const present = new Set(keys.values());
      setSaved((current) => {
        const absent = [...current.keys()].filter((key) => key.startsWith(`${scope}\u0000`) && !present.has(key));
        if (!absent.length) return current;
        const next = new Map(current);
        for (const key of absent) next.delete(key);
        return next;
      });
    }
    observation.busy = candidates.length > 0;
    setBusy(observation.busy);
    const verified = new Set<string>();
    const invalid = new Set<string>();
    let failed = false;
    void visitReviewEntries(candidates, async (id) => {
      const fingerprint = await observation.fingerprint(id);
      if (!observation.active) return;
      const key = keys.get(id)!;
      if (fingerprint && fingerprint === previous.get(key)) {
        verified.add(id);
      } else {
        if (fingerprint === undefined) failed = true;
        else invalid.add(key);
      }
    }, () => observation.active).finally(() => {
      if (!observation.active) return;
      setReviewedEntryIds(verified);
      if (invalid.size) setSaved((current) => {
        const next = new Map(current);
        for (const key of invalid) next.delete(key);
        return next;
      });
      if (failed) setNotice("Some review marks could not be checked. Refresh to try again.");
      observation.busy = false;
      setBusy(false);
    });
    return () => { observation.active = false; session.current = undefined; };
  }, [keys, loading, observationId, scope, truncated]);

  const setReviewed = async (entryIds: readonly string[], reviewed: boolean) => {
    const observation = session.current;
    if (!observation?.active || observation.busy) return;
    if (!reviewed) {
      setReviewedEntryIds((current) => new Set([...current].filter((id) => !entryIds.includes(id))));
      setSaved((current) => {
        const next = new Map(current);
        for (const id of entryIds) { const key = keys.get(id); if (key) next.delete(key); }
        return next;
      });
      return;
    }
    observation.busy = true;
    setBusy(true);
    setNotice(undefined);
    const marked = new Set<string>();
    const captured = new Map<string, string>();
    let warning: string | undefined;
    await visitReviewEntries(entryIds.filter((id) => keys.has(id) && !reviewedEntryIds.has(id)), async (id) => {
      const fingerprint = await observation.fingerprint(id);
      if (!observation.active) return;
      if (fingerprint === undefined) {
        warning = "Some files could not be marked reviewed. Refresh to try again.";
        return;
      }
      marked.add(id);
      const key = keys.get(id)!;
      if (fingerprint && persistableChangesReviewKey(key)) captured.set(key, fingerprint);
      else warning ??= "Review marks for files without readable, identifiable diffs last until the next refresh.";
    }, () => observation.active);
    if (!observation.active) return;
    setReviewedEntryIds((current) => new Set([...current, ...marked]));
    if (captured.size) setSaved((current) => new Map([...current, ...captured]));
    setNotice(warning);
    observation.busy = false;
    setBusy(false);
  };

  return { reviewedEntryIds, busy: loading || busy, notice, setReviewed };
}
