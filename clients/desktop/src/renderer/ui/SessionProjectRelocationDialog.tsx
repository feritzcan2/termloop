import { useEffect, useRef, useState } from "react";
import type { SessionRelocationPreviewDto } from "@termloop/contract/current";
import type { Project, Session } from "../model.js";
import { sessionLabel } from "../model.js";

export function SessionProjectRelocationDialog({ session, project, close, preview, relocate, repairProviderHistory }: {
  session: Session;
  project: Project;
  close(): void;
  preview(sessionId: string, projectId: string): Promise<SessionRelocationPreviewDto>;
  relocate(
    sessionId: string,
    projectId: string,
    operationId: string,
    relocationTicket: string,
    manifestDigest: string,
  ): Promise<boolean>;
  repairProviderHistory(): void;
}) {
  const [result, setResult] = useState<SessionRelocationPreviewDto>();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();
  const previewRef = useRef(preview);
  previewRef.current = preview;

  useEffect(() => {
    let current = true;
    setResult(undefined);
    void previewRef.current(session.id, project.id)
      .then((value) => { if (current) setResult(value); })
      .catch((cause) => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [project.id, session.id]);

  const submit = async () => {
    if (!result?.can_relocate || !result.relocation_ticket || !result.manifest || moving) return;
    setMoving(true);
    setError(undefined);
    try {
      const requiresRepair = await relocate(
        session.id,
        project.id,
        crypto.randomUUID(),
        result.relocation_ticket,
        result.manifest.digest,
      );
      close();
      if (requiresRepair) repairProviderHistory();
    } catch (cause) {
      setError(errorMessage(cause));
      setResult(undefined);
    } finally {
      setMoving(false);
    }
  };

  const unavailable = result && !result.can_relocate;

  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
    <button className="dialog-backdrop" type="button" aria-label={moving ? "Hide move to Active Agents" : "Cancel moving to Active Agents"} onClick={close} />
    <section className="dialog-card inline-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-relocation-title" aria-describedby="project-relocation-message" aria-busy={!result || moving}>
      <div className="dialog-body">
        <h2 id="project-relocation-title">Move {sessionLabel(session)} to Active Agents?</h2>
        <p id="project-relocation-message">The Agent will stop here and continue in the Project checkout.</p>
        {unavailable ? <p className="form-error" role="status">This Agent cannot be moved right now.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {moving ? <p role="status">The move continues in the background. You can hide this dialog.</p> : null}
      </div>
      <footer className="dialog-actions">
        <button className="secondary-button" type="button" onClick={close}>{moving ? "Hide" : error ? "Close" : "No"}</button>
        {!error ? <button className="primary-button" type="button" disabled={!result?.can_relocate || !result.relocation_ticket || !result.manifest || moving} onClick={() => void submit()}>{moving ? "Moving…" : result ? "Yes" : "Checking…"}</button> : null}
      </footer>
    </section>
  </div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
