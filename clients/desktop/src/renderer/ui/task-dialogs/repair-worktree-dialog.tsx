import { useState } from "react";
import type { TaskRepairWorktreeParams, TaskWorktreeRepairPreviewDto } from "@termloop/contract/current";
import type { Task } from "../../model.js";
import { Icon } from "../Icon.js";

export function RepairWorktreeDialog({ task, close, inspect, repair }: {
  task: Task;
  close(): void;
  inspect(taskId: string, candidatePath: string): Promise<TaskWorktreeRepairPreviewDto>;
  repair(params: TaskRepairWorktreeParams): Promise<string | undefined>;
}) {
  const [candidatePath, setCandidatePath] = useState("");
  const [preview, setPreview] = useState<TaskWorktreeRepairPreviewDto>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const runInspection = async () => {
    if (!candidatePath.trim()) { setError("Choose the moved worktree folder."); return; }
    setBusy(true); setError(undefined); setPreview(undefined);
    try { setPreview(await inspect(task.id, candidatePath.trim())); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!preview?.managed_worktree_operation_id || preview.decision !== "allowed") return;
    setBusy(true); setError(undefined);
    const failure = await repair({ operationId: globalThis.crypto.randomUUID(), taskId: task.id, candidatePath: preview.candidate_path, expectedManagedWorktreeOperationId: preview.managed_worktree_operation_id, expectedWorktreeGeneration: preview.worktree_generation });
    if (failure) { setError(failure); setBusy(false); } else close();
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}><button className="dialog-backdrop" aria-label="Cancel worktree repair" onClick={close} /><section className="dialog-card task-dialog" role="dialog" aria-modal="true" aria-labelledby="repair-worktree-title"><header className="dialog-header"><div><span className="dialog-eyebrow">Worktree repair</span><h2 id="repair-worktree-title">Inspect repair for “{task.title}”</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header><div className="dialog-body"><p className="field-help">TermLoop will inspect only the exact folder you choose. It will not scan, move, adopt, or delete content.</p><p className="field-help">Current registered path: {preview?.current_path ?? task.worktree?.path ?? "unknown"}</p><label htmlFor="repair-candidate-path">Moved worktree path</label><input id="repair-candidate-path" value={candidatePath} onChange={(event) => { setCandidatePath(event.target.value); setPreview(undefined); }} />{preview?.attached_session_ids.length ? <p className="form-error" role="alert">Attached Sessions: {preview.attached_session_ids.join(", ")}</p> : null}{preview ? <p className={preview.decision === "allowed" ? "field-help" : "form-error"} role="status">{preview.decision === "allowed" ? "Exact administrative links match. Repair is ready." : `${preview.decision}: ${preview.blockers.join(", ")}`}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}</div><footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="secondary-button" disabled={busy || !candidatePath.trim()} onClick={() => void runInspection()}>{busy ? "Inspecting…" : "Inspect repair"}</button><button className="primary-button" disabled={busy || preview?.decision !== "allowed"} onClick={() => void submit()}>{busy ? "Repairing…" : "Repair worktree"}</button></footer></section></div>;
}
