import { useEffect, useRef, useState } from "react";
import type { Task } from "../../model.js";
import { Icon } from "../Icon.js";

export function BindBranchDialog({ task, initialRepositoryPath, close, bind }: { task: Task; initialRepositoryPath: string; close(): void; bind(taskId: string, repositoryPath: string, branchName: string): Promise<string | undefined> }) {
  const [repositoryPath, setRepositoryPath] = useState(initialRepositoryPath);
  const [branchName, setBranchName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const branchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { requestAnimationFrame(() => branchRef.current?.focus()); }, []);
  const submit = async () => {
    if (!repositoryPath.trim()) { setError("Enter a repository path."); return; }
    if (!branchName.trim()) { setError("Enter an existing branch name."); return; }
    setBusy(true); setError(undefined);
    const failure = await bind(task.id, repositoryPath.trim(), branchName.trim());
    if (failure) { setError(failure); setBusy(false); } else close();
  };
  return <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}><button className="dialog-backdrop" aria-label="Cancel binding branch" onClick={close} /><section className="dialog-card task-dialog" role="dialog" aria-modal="true" aria-labelledby="bind-branch-title"><header className="dialog-header"><div><span className="dialog-eyebrow">Task branch</span><h2 id="bind-branch-title">Use an existing branch for “{task.title}”</h2></div><button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button></header><div className="dialog-body"><label htmlFor="branch-repository-path">Repository path</label><input id="branch-repository-path" value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} /><label htmlFor="branch-name">Existing branch</label><input ref={branchRef} id="branch-name" value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="feature/api" /><p className="field-help">This links the branch to the Task only. It does not create a branch or worktree.</p>{error ? <p className="form-error" role="alert">{error}</p> : null}</div><footer className="dialog-actions"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => void submit()}>{busy ? "Linking…" : "Use branch"}</button></footer></section></div>;
}
