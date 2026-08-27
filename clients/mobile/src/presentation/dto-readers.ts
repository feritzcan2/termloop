import type { SessionDto, TaskDto } from "@termloop/contract/current";

/// Pure readers over the generated projection DTOs, ported from the desktop's
/// `renderer/model.ts`. They answer "what does the projection say"; the
/// `*-presentation` modules answer "what does the row say".
///
/// Nothing here performs I/O, normalizes a real path, or compares paths for
/// identity — path identity is a `platform`/`core` concern and the client only
/// ever displays what the daemon already decided.

export function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

/// Terminating a Session keeps its descriptor so it can be resumed or cleared, so
/// a count of what is live has to ask liveness rather than count records.
export function isLiveSession(session: SessionDto): boolean {
  return session.lifecycle_state === "running" || session.lifecycle_state === "resuming";
}

/// Persistent assistants have their own product surface on desktop. They are not
/// ordinary Active Agents, even though their daemon-owned processes are projected as
/// Agent Sessions on the shared wire.
export function isAssistantSession(session: SessionDto): boolean {
  const template = session.process.template_ref;
  return template === "builtin.assistant.activation"
    || template === "builtin.steward.executor"
    || template === "builtin.worker.executor";
}

export function agentName(session: SessionDto): string {
  const id = session.process.agent_id;
  return id ? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}` : "Agent";
}

export function sessionLabel(session: SessionDto): string {
  const name = session.name?.trim();
  if (name) return name;
  if (session.kind === "Agent") return agentName(session);
  return basename(session.process.cwd) || "Terminal";
}

/// A path narrowed to what identifies it, keeping the tail. Worktree folder names run to
/// sixty characters and a head-truncated one is unreadable — every candidate starts with
/// the same prefix, so the distinguishing half is the part a leading ellipsis must keep.
export function shortenPath(value: string, segments = 2): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= segments) return value;
  return `…/${parts.slice(-segments).join("/")}`;
}

/// A single name narrowed from the middle, for a folder that is one very long segment.
/// Truncating the end alone would hide the suffix that tells two worktrees apart.
export function ellipsizeMiddle(value: string, max = 34): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function taskJiraIssueKey(jiraUrl: string): string {
  return jiraUrl.slice(jiraUrl.lastIndexOf("/") + 1);
}

/// A checkout sitting on a different local branch than the Task's own branch is
/// launchable but easy to mistake for the Task branch.
export function taskCheckedOutBranch(task: TaskDto): string | undefined {
  const checkedOutBranch = task.worktree_health?.checked_out_branch ?? undefined;
  return checkedOutBranch && checkedOutBranch !== task.branch?.name ? checkedOutBranch : undefined;
}

export function taskHasWorktreeChanges(task: TaskDto): boolean {
  const health = task.worktree_health;
  return health?.staged_state === "changed"
    || health?.tracked_state === "changed"
    || health?.untracked_state === "present";
}

export type TaskWorktreeInlineAction = "create" | "launch" | "repair" | "unavailable";

export function taskWorktreeInlineAction(task: TaskDto): TaskWorktreeInlineAction {
  if (!task.worktree) return "create";
  const health = task.worktree_health;
  if (health?.launch_ready) return "launch";
  if (health?.path_state === "absent" || health?.registration_state === "mismatch") return "repair";
  return "unavailable";
}

/// Which Task a Session is running inside, taken from the Task's own presence
/// projection rather than inferred from a path prefix. Presence is the daemon's
/// answer to the same question and the client has no business re-deriving it.
export function taskIdBySessionId(tasks: readonly TaskDto[]): Map<string, string> {
  const bySession = new Map<string, string>();
  for (const task of tasks) {
    for (const attached of task.worktree_presence?.attached_sessions ?? []) {
      bySession.set(attached.session_id, task.id);
    }
  }
  return bySession;
}
