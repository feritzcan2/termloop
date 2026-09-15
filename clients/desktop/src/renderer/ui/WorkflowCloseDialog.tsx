import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.js";

export type WorkflowCloseTarget = { projectId: string; executionId: string; name: string; agentCount: number };

export function WorkflowCloseDialog({ target, submit, close }: {
  target: WorkflowCloseTarget;
  submit(projectId: string, executionId: string): Promise<string | undefined>;
  close(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const invoker = document.activeElement;
    cancelButton.current?.focus();
    return () => { if (invoker instanceof HTMLElement && invoker.isConnected) invoker.focus(); };
  }, []);
  const confirm = async () => {
    if (pending.current) return;
    dialog.current?.focus();
    pending.current = true; setBusy(true); setError(undefined);
    try {
      const failure = await submit(target.projectId, target.executionId);
      if (failure) setError(failure);
      else close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { pending.current = false; setBusy(false); }
  };
  return <div className="dialog-layer" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !pending.current) close();
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('section button:not(:disabled)')];
    const next = event.shiftKey ? buttons.at(-1) : buttons[0];
    const focused = event.currentTarget.ownerDocument.activeElement;
    if (!buttons.length || !buttons.includes(focused as HTMLButtonElement) || focused === (event.shiftKey ? buttons[0] : buttons.at(-1))) {
      event.preventDefault(); next?.focus();
    }
  }}>
    <button className="dialog-backdrop" type="button" tabIndex={-1} aria-label="Cancel closing workflow" disabled={busy} onClick={close} />
    <section ref={dialog} tabIndex={-1} className="dialog-card inline-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="workflow-close-title" aria-describedby="workflow-close-message" aria-busy={busy}>
      <header className="dialog-header">
        <div><span className="dialog-eyebrow">Close workflow</span><h2 id="workflow-close-title">Close {target.name}?</h2></div>
        <button className="icon-button quiet" type="button" disabled={busy} aria-label="Close dialog" onClick={close}><Icon name="close" /></button>
      </header>
      <div className="dialog-body">
        <p className="confirm-copy" id="workflow-close-message">Stop any running agents and close all {target.agentCount} agents in this workflow, including members shown elsewhere in the Agents list. This ends the workflow run.</p>
        <p className="field-help">Your saved template, Task and files are kept. Individual agent conversations can be restored from Deleted for 30 days.</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <footer className="dialog-actions">
        <button className="secondary-button" type="button" ref={cancelButton} disabled={busy} onClick={close}>Keep open</button>
        <button className="danger-button" type="button" disabled={busy} onClick={() => void confirm()}>{busy ? "Closing agents…" : error ? "Retry close" : "Close all agents"}</button>
      </footer>
    </section>
  </div>;
}
