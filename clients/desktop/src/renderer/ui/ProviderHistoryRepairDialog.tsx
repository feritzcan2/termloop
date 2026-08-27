import { useState } from "react";
import type { Session } from "../model.js";
import { sessionLabel } from "../model.js";
import { Icon } from "./Icon.js";

export function ProviderHistoryRepairDialog({ session, repair, close }: {
  session: Session;
  repair(sessionId: string): Promise<string | undefined>;
  close(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stopsAgent = session.lifecycle_state !== "exited";
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const failure = await repair(session.id);
      if (failure) setError(failure);
      else close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && !busy && close()}>
      <button className="dialog-backdrop" type="button" aria-label="Cancel provider history repair" disabled={busy} onClick={close} />
      <section className="dialog-card inline-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="provider-history-repair-title" aria-describedby="provider-history-repair-message" aria-busy={busy}>
        <header className="dialog-header">
          <div>
            <span className="dialog-eyebrow danger-eyebrow">Provider history repair</span>
            <h2 id="provider-history-repair-title">Repair {sessionLabel(session)} history?</h2>
          </div>
          <button className="icon-button quiet" type="button" aria-label="Close dialog" disabled={busy} onClick={close}><Icon name="close" /></button>
        </header>
        <div className="dialog-body">
          <p id="provider-history-repair-message" className="confirm-copy">
            {stopsAgent ? "TermLoop will stop this Agent first. " : ""}
            It will create an exact private backup, repair only the known duplicate restart ordinals, then verify the conversation with a fresh Codex runtime.
          </p>
          <p className="field-help">If the file does not match that exact damage pattern, TermLoop refuses the repair and leaves it unchanged. The provider conversation text is not removed.</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={close}>Cancel</button>
          <button className="danger-button" type="button" disabled={busy} onClick={() => void submit()}>{busy ? "Repairing…" : stopsAgent ? "Stop & Repair" : "Repair"}</button>
        </footer>
      </section>
    </div>
  );
}
