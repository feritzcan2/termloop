import { createHash, timingSafeEqual } from "node:crypto";

// Watch clients cannot open WebSockets (watchOS policy blocks low-level
// networking for third-party apps), so the gateway exposes a small plain-HTTPS
// facade for them. These helpers keep that facade's logic pure and testable.

export const WATCH_PAIR_TTL_MS = 10 * 60 * 1000;
export const WATCH_PATCH_ENTRY_LIMIT = 100;

/// Same visible-name rule Core uses for Quick Actions. Array spreading counts
/// Unicode code points, so emoji and other supplementary characters are not
/// split while applying the 80-character Session name bound.
export function promptSessionName(prompt) {
  if (typeof prompt !== "string") return null;
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const name = [...firstLine].slice(0, 80).join("");
  return name.length > 0 ? name : null;
}

export function hashPairCode(code) {
  return createHash("sha256").update(String(code)).digest("hex");
}

export function validatePairCode(stored, code, now = Date.now()) {
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return false;
  if (typeof stored?.codeHash !== "string" || !Number.isFinite(stored?.expiresAtEpochMs)) return false;
  if (now > stored.expiresAtEpochMs) return false;
  const left = Buffer.from(hashPairCode(code));
  const right = Buffer.from(stored.codeHash);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parseWatchTarget(value) {
  const match = /^(task|project):([A-Za-z0-9-]{1,64})$/.exec(value ?? "");
  return match ? { scope: match[1], id: match[2] } : null;
}

export function watchFileOf(entry) {
  return {
    entryId: entry.entry_id,
    path: entry.display_path,
    kind: entry.kind,
    side: entry.side,
  };
}

export function watchTaskWorktreeOf(task, changeList) {
  return {
    id: `task:${task.id}`,
    name: task.title,
    branch: task.branch?.name ?? null,
    path: task.worktree?.path ?? null,
    truncated: changeList.truncated === true,
    files: changeList.entries.map(watchFileOf),
  };
}

export function watchProjectWorktreeOf(project, changeList) {
  return {
    id: `project:${project.id}`,
    name: project.name,
    branch: null,
    path: project.folder_path,
    truncated: changeList.truncated === true,
    files: changeList.entries.map(watchFileOf),
  };
}

export function patchTextOf(diff) {
  switch (diff?.state) {
    case "patch":
      return diff.patch ?? "";
    case "truncated":
      return diff.patch ? `${diff.patch}\n… (truncated by TermLoop)` : "… (truncated by TermLoop)";
    case "binary":
      return "(binary file)";
    case "nonUtf8":
      return "(non-UTF-8 content not shown)";
    default:
      return "(diff not shown)";
  }
}

export function watchSessionOf(session, statusesBySession) {
  const status = statusesBySession.get(session.id);
  return {
    id: session.id,
    runtimeEpoch: session.runtime_epoch,
    name: typeof session.name === "string" && session.name.trim() ? session.name.trim() : agentLabel(session),
    agent: agentLabel(session),
    projectId: session.project_id,
    cwd: typeof session.process?.cwd === "string" ? session.process.cwd : null,
    status: status ?? "unknown",
  };
}

export function watchTaskOf(task, projectName) {
  return {
    id: task.id,
    title: task.title,
    projectId: task.project_id,
    projectName: projectName ?? null,
    branch: task.branch?.name ?? null,
    hasWorktree: task.worktree != null,
  };
}

export function watchChatMessageOf(message) {
  return {
    id: message.id,
    sequence: message.sequence,
    author: message.author,
    kind: message.kind,
    content: message.content,
    atEpochMs: message.createdAtEpochMs,
  };
}

function agentLabel(session) {
  if (session.process?.agent_id === "claude") return "Claude";
  if (session.process?.agent_id === "codex") return "Codex";
  return "Agent";
}
