import type { ControlReadPort } from "../../application/ports";

const INVALIDATION_COALESCE_MS = 120;

export function subscribeOverviewInvalidations(
  control: Pick<ControlReadPort, "subscribeInvalidations">,
  connectionId: string,
  refresh: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRevision: string | undefined;
  let disposed = false;
  const unsubscribe = control.subscribeInvalidations(connectionId, (event) => {
    if (disposed) return;
    const revision = `${event.stateRevision}:${event.observationSequence}`;
    if (lastRevision === revision) return;
    // A daemon restart may reset either counter. Reads remain authoritative,
    // so only exact redelivery is ignored within this subscription.
    lastRevision = revision;
    // The daemon can emit every 100 ms. Keep the first event's deadline so a
    // busy Agent cannot postpone the overview read until its output goes quiet.
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      refresh();
    }, INVALIDATION_COALESCE_MS);
  });
  return () => {
    disposed = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
