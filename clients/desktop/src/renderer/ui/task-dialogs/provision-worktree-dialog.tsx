import { useEffect, useRef, useState } from "react";
import type { LocalBranchDto, ProjectLocalBranchListResult, TaskProvisionWorktreeParams } from "@termloop/contract/current";
import type { Task } from "../../model.js";
import { Icon } from "../Icon.js";
import {
  initialWorktreeDestination,
  localBranchesForTaskBinding,
  selectedWorktreeParent,
  updateWorktreeDestinationBranch,
  worktreePathParent,
} from "../worktree-path-suggestion.js";

export function ProvisionWorktreeDialog({ task, projectId, repositoryPath, rememberedParentPath, rememberParentPath, rememberedBaseRef, rememberBaseRef, listBranches, close, provision }: {
  task: Task;
  projectId: string | undefined;
  repositoryPath: string;
  rememberedParentPath: string | undefined;
  rememberParentPath(parentPath: string): void;
  rememberedBaseRef: string | undefined;
  rememberBaseRef(baseRef: string): void;
  listBranches(projectId: string): Promise<ProjectLocalBranchListResult>;
  close(): void;
  provision(params: TaskProvisionWorktreeParams): Promise<string | undefined>;
}) {
  const initialBranchName = task.branch?.name ?? "";
  const initialParentPath = rememberedParentPath?.trim() || worktreePathParent(repositoryPath);
  const [destinationParentPath, setDestinationParentPath] = useState(initialParentPath);
  const [destinationPath, setDestinationPath] = useState(() => initialWorktreeDestination(repositoryPath, initialBranchName, rememberedParentPath));
  const [localBranches, setLocalBranches] = useState<readonly LocalBranchDto[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string>();
  const [branchesTruncated, setBranchesTruncated] = useState(false);
  const [existingBranchName, setExistingBranchName] = useState(initialBranchName);
  const [createdBranchName, setCreatedBranchName] = useState("");
  const [branchMode, setBranchMode] = useState<"existing" | "create">("existing");
  const [baseRef, setBaseRef] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const branchRef = useRef<HTMLInputElement>(null);
  const existingBranchRef = useRef<HTMLSelectElement>(null);
  const destinationRef = useRef<HTMLInputElement>(null);
  const branchName = branchMode === "existing" ? existingBranchName : createdBranchName;
  const previousBranchNameRef = useRef(branchName);

  useEffect(() => {
    requestAnimationFrame(() => (task.branch ? destinationRef : existingBranchRef).current?.focus());
  }, [task.branch]);
  useEffect(() => {
    let current = true;
    if (!projectId) {
      setBranchesLoading(false);
      setBranchesError("Select a Project before loading local branches.");
      return () => { current = false; };
    }
    setBranchesLoading(true);
    setBranchesError(undefined);
    void listBranches(projectId).then((result) => {
      if (!current) return;
      const branchSelection = localBranchesForTaskBinding(
        result.branches,
        task.branch?.name,
        result.truncated,
      );
      const sortedBranches = branchSelection.branches;
      setLocalBranches(sortedBranches);
      setBranchesTruncated(result.truncated);
      setBaseRef((selected) => {
        if (sortedBranches.some((branch) => branch.exact_ref === selected)) return selected;
        const remembered = sortedBranches.find((branch) => branch.exact_ref === rememberedBaseRef);
        if (remembered) return remembered.exact_ref;
        return sortedBranches[0]?.exact_ref ?? "";
      });
      setExistingBranchName((selected) => {
        const requiredBranch = task.branch?.name;
        if (requiredBranch) return requiredBranch;
        return sortedBranches.some((branch) => branch.name === selected)
          ? selected
          : sortedBranches[0]?.name ?? "";
      });
      if (branchSelection.requiredBranchMissing) {
        setBranchesError("The Task branch is no longer available in this repository.");
      }
      setBranchesLoading(false);
    }).catch((loadError: unknown) => {
      if (!current) return;
      setBranchesLoading(false);
      setBranchesError(loadError instanceof Error ? loadError.message : "Local branches could not be loaded.");
    });
    return () => { current = false; };
  }, [listBranches, projectId, rememberedBaseRef, task.branch]);
  useEffect(() => {
    const previousBranchName = previousBranchNameRef.current;
    setDestinationPath((currentPath) => updateWorktreeDestinationBranch(
      currentPath,
      destinationParentPath,
      previousBranchName,
      branchName,
    ));
    previousBranchNameRef.current = branchName;
  }, [branchName, destinationParentPath]);

  const submit = async () => {
    if (!repositoryPath.trim()) { setError("The selected Project does not have a repository path."); return; }
    if (branchesLoading) { setError("Wait for local branches to load."); return; }
    if (branchesError) { setError(branchesError); return; }
    if (localBranches.length === 0) { setError("This repository has no local branches to select."); return; }
    if (!destinationPath.trim()) { setError("Enter a new worktree path."); return; }
    if (!branchName.trim()) { setError("Enter a branch name."); return; }
    if (branchMode === "existing" && !localBranches.some((branch) => branch.name === branchName)) {
      setError("Select an existing local branch.");
      return;
    }
    if (branchMode === "create" && !localBranches.some((branch) => branch.exact_ref === baseRef)) {
      setError("Select an exact local base ref.");
      return;
    }
    const selectedParentPath = selectedWorktreeParent(destinationPath, branchName);
    if (selectedParentPath) rememberParentPath(selectedParentPath);
    setBusy(true); setError(undefined);
    const failure = await provision({
      operationId: globalThis.crypto.randomUUID(),
      taskId: task.id,
      repositoryPath: repositoryPath.trim(),
      destinationPath: destinationPath.trim(),
      branchName: branchName.trim(),
      branchMode,
      ...(branchMode === "create" ? { baseRef: baseRef.trim() } : {}),
    });
    if (failure) { setError(failure); setBusy(false); } else close();
  };
  const changeDestinationPath = (nextPath: string) => {
    setDestinationPath(nextPath);
    const nextParentPath = selectedWorktreeParent(nextPath, branchName);
    if (!nextParentPath) return;
    setDestinationParentPath(nextParentPath);
    rememberParentPath(nextParentPath);
  };
  const changeBranchMode = (nextMode: "existing" | "create") => {
    setBranchMode(nextMode);
    setError(undefined);
    requestAnimationFrame(() => (nextMode === "create" ? branchRef : existingBranchRef).current?.focus());
  };
  const branchPlaceholder = branchesLoading
    ? "Loading local branches…"
    : branchesError
      ? "Local branches unavailable"
      : "No local branches";
  const selectionUnavailable = branchesLoading || Boolean(branchesError) || localBranches.length === 0;
  const canSubmit = !busy
    && !selectionUnavailable
    && Boolean(destinationPath.trim())
    && Boolean(branchName.trim())
    && (branchMode === "existing" || Boolean(baseRef));
  return (
    <div className="dialog-layer" onKeyDown={(event) => event.key === "Escape" && close()}>
      <button className="dialog-backdrop" aria-label="Cancel creating worktree" onClick={close} />
      <section className="dialog-card task-dialog" role="dialog" aria-modal="true" aria-labelledby="provision-worktree-title">
        <header className="dialog-header">
          <div><span className="dialog-eyebrow">Task worktree</span><h2 id="provision-worktree-title">Create worktree for “{task.title}”</h2></div>
          <button className="icon-button quiet" aria-label="Close dialog" onClick={close}><Icon name="close" /></button>
        </header>
        <div className="dialog-body">
          <label htmlFor="worktree-branch-mode">Branch</label>
          <select id="worktree-branch-mode" value={branchMode} disabled={Boolean(task.branch)} onChange={(event) => changeBranchMode(event.target.value as "existing" | "create")}>
            <option value="existing">Use an existing branch</option>
            <option value="create">Create a new branch</option>
          </select>

          <label htmlFor="worktree-branch-name">Branch name</label>
          {branchMode === "existing" ? (
            <select ref={existingBranchRef} id="worktree-branch-name" value={existingBranchName} disabled={selectionUnavailable || Boolean(task.branch)} onChange={(event) => { setExistingBranchName(event.target.value); setError(undefined); }}>
              {selectionUnavailable ? <option value="">{branchPlaceholder}</option> : null}
              {localBranches.map((branch) => <option key={branch.exact_ref} value={branch.name}>{branch.name}</option>)}
            </select>
          ) : (
            <input ref={branchRef} id="worktree-branch-name" value={createdBranchName} onChange={(event) => { setCreatedBranchName(event.target.value); setError(undefined); }} />
          )}

          <label htmlFor="worktree-destination-path">New worktree path</label>
          <input ref={destinationRef} id="worktree-destination-path" value={destinationPath} onChange={(event) => changeDestinationPath(event.target.value)} />

          {branchMode === "create" ? (
            <>
              <label htmlFor="worktree-base-ref">Base branch</label>
              <select id="worktree-base-ref" value={baseRef} disabled={selectionUnavailable} onChange={(event) => { setBaseRef(event.target.value); rememberBaseRef(event.target.value); setError(undefined); }}>
                {selectionUnavailable ? <option value="">{branchPlaceholder}</option> : null}
                {localBranches.map((branch) => <option key={branch.exact_ref} value={branch.exact_ref}>{branch.exact_ref}</option>)}
              </select>
            </>
          ) : null}

          <p className="field-help">TermLoop creates this folder new; an existing folder is never adopted or overwritten.</p>
          {branchesTruncated ? <p className="field-help" role="status">Only the first 512 representable local branches are shown.</p> : null}
          {branchesError ? <p className="form-error" role="alert">{branchesError}</p> : null}
          {!branchesLoading && !branchesError && localBranches.length === 0 ? <p className="field-help" role="status">This repository has no local branches.</p> : null}
          {task.worktree_provisioning?.status === "failed" ? <p className="field-help" role="status">Previous provisioning failed: {task.worktree_provisioning.failure?.kind ?? "operationFailed"}. Review these values to retry safely.</p> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={close}>Cancel</button>
          <button className="primary-button" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Creating…" : "Create worktree"}</button>
        </footer>
      </section>
    </div>
  );
}
