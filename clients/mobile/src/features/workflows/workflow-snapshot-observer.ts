import type { WorkflowConfigurationListResult } from "@termloop/contract/current";

/** One foreground reader: event bursts queue one follow-up, never cancel a
 * response already in flight. The fallback read repairs missed invalidations. */
export function observeWorkflowSnapshots(options: {
  read(): Promise<WorkflowConfigurationListResult>;
  subscribe(invalidate: () => void): () => void;
  minimumRevision(): number;
  publish(snapshot: WorkflowConfigurationListResult, checkedAt: number): void;
  loading(value: boolean): void;
  failed(error: string): void;
}) {
  let stopped = false;
  let reading = false;
  let queued = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (stopped) return;
    if (reading) { queued = true; return; }
    reading = true;
    options.loading(true);
    try {
      const snapshot = await options.read();
      if (!stopped) {
        if (snapshot.stateRevision >= options.minimumRevision()) options.publish(snapshot, Date.now());
        else options.failed("The Mac returned older workflow progress. Keeping the last confirmed snapshot.");
      }
    } catch (cause) {
      if (!stopped) options.failed(cause instanceof Error ? cause.message : String(cause));
    } finally {
      reading = false;
      if (!stopped) {
        options.loading(false);
        if (queued) { queued = false; void refresh(); }
      }
    }
  };
  const unsubscribe = options.subscribe(() => {
    if (stopped || debounce !== undefined) return;
    debounce = setTimeout(() => { debounce = undefined; void refresh(); }, 200);
  });
  const fallback = setInterval(() => { void refresh(); }, 30_000);
  void refresh();
  return {
    refresh: () => { void refresh(); },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clearInterval(fallback);
      if (debounce !== undefined) clearTimeout(debounce);
    },
  };
}
