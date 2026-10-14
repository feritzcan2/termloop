import { useState } from "react";

import type { TaskSourceDto } from "@termloop/contract/current";

/** Chooses how TermLoop names the managed worktree branch of a Task imported
    from this source. Existing Task branches never change. */
export function SourceBranchNamingSettings({ source, busy, save }: {
  source: TaskSourceDto;
  busy: boolean;
  save(branchNaming: TaskSourceDto["branchNaming"]): void;
}) {
  const [branchNaming, setBranchNaming] = useState(source.branchNaming);
  const issueKey = branchNaming === "issueKey";

  return <section className="task-source-intake-settings" aria-label="Task branch naming">
    <div className="task-source-intake-settings-head">
      <span>Task branches</span>
      <strong>{issueKey ? "Jira issue key" : "Task title"}</strong>
    </div>
    <div className="task-source-intake-settings-controls">
      <label htmlFor={`task-source-branch-naming-${source.id}`}>Name new worktree branches after</label>
      <select
        id={`task-source-branch-naming-${source.id}`}
        value={branchNaming}
        disabled={busy}
        onChange={(event) => setBranchNaming(event.target.value as TaskSourceDto["branchNaming"])}
      >
        <option value="title">Task title</option>
        <option value="issueKey">Jira issue key</option>
      </select>
      <button
        type="button"
        className="primary-button"
        disabled={busy || branchNaming === source.branchNaming}
        onClick={() => save(branchNaming)}
      >{busy ? "Saving…" : "Save branches"}</button>
    </div>
    <p>{issueKey
      ? "A Task imported from this source gets a branch named exactly after its issue, such as PROJ-123, in a PROJ-123_worktree folder. Pull requests from that branch and from PROJ-123-MASTER style branches show on the Task."
      : "A Task imported from this source gets a branch named after its title, such as feature/fix-login-1a2b3c4d."}
      {" "}Existing Task branches keep their names.</p>
  </section>;
}
