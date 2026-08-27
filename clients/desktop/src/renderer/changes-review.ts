import type { Session, Task } from "./model.js";
import { getChangeKey, type ChangeData } from "react-diff-view";

export const MAX_CHANGE_REVIEW_NOTES = 32;
export const MAX_CHANGE_REVIEW_NOTE_CHARS = 1_000;
export const MAX_CHANGE_REVIEW_MESSAGE_BYTES = 64 * 1024;

export type ChangeReviewNote = {
  key: string;
  sourceLabel: string;
  displayPath: string;
  pathEncoding: "utf8" | "lossy";
  changeKey: string;
  lineSide: "old" | "new";
  lineNumber: number;
  body: string;
};

export type ChangeReviewLine = Pick<ChangeReviewNote, "changeKey" | "lineSide" | "lineNumber">;

export function taskReviewAgentSessions(task: Task, sessions: readonly Session[]): Session[] {
  const attached = new Set(
    task.worktree_presence?.attached_sessions
      .filter((session) => session.kind === "Agent")
      .map((session) => session.session_id) ?? [],
  );
  return sessions.filter((session) =>
    attached.has(session.id)
    && session.project_id === task.project_id
    && session.kind === "Agent"
    && session.lifecycle_state === "running"
    && session.process.agent_id !== null
  );
}

export function buildChangeReviewMessage(taskTitle: string, notes: readonly ChangeReviewNote[]): string {
  const sections = notes.map((note) => {
    const path = singleLine(note.displayPath);
    const encoding = note.pathEncoding === "lossy" ? " · lossy display path" : "";
    return `## ${path}:${note.lineNumber} (${note.lineSide})${encoding}\nSource: ${singleLine(note.sourceLabel)}\n\n${safeUserText(note.body).trim()}`;
  });
  return `Review notes — ${singleLine(taskTitle)}\n\n${sections.join("\n\n")}`;
}

export function reviewMessageByteLength(message: string): number {
  return new TextEncoder().encode(message).byteLength;
}

export function terminalReviewSubmission(message: string): string {
  return `\u001b[200~${safeUserText(message)}\u001b[201~\r`;
}

export function changeReviewLine(change: ChangeData, side: "old" | "new"): ChangeReviewLine {
  const lineNumber = change.type === "normal"
    ? side === "old" ? change.oldLineNumber : change.newLineNumber
    : change.lineNumber;
  return { changeKey: getChangeKey(change), lineSide: side, lineNumber };
}

function singleLine(value: string): string {
  return safeUserText(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeUserText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}
