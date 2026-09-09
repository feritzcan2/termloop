import type { SessionDto, TaskDto, TaskWorktreeChangeEntryDto } from "@termloop/contract/current";

export const MAX_REVIEW_NOTES = 32;
export const MAX_REVIEW_NOTE_CHARS = 1_000;
export const MAX_REVIEW_MESSAGE_BYTES = 64 * 1024;

export type ReviewLine = { lineSide: "old" | "new"; lineNumber: number };
export type ReviewNote = ReviewLine & {
  key: string;
  observationId: string;
  entryId: string;
  displayPath: string;
  pathEncoding: TaskWorktreeChangeEntryDto["path_encoding"];
  side: TaskWorktreeChangeEntryDto["side"];
  body: string;
};

export function reviewLineKey(line: ReviewLine): string {
  return `${line.lineSide}:${line.lineNumber}`;
}

export function diffReviewLine(change: {
  type: "normal" | "insert" | "delete";
  oldLineNumber?: number | undefined;
  newLineNumber?: number | undefined;
  lineNumber?: number | undefined;
}): ReviewLine | undefined {
  const lineSide = change.type === "delete" ? "old" : "new";
  const lineNumber = change.type === "normal" ? change.newLineNumber : change.lineNumber;
  return lineNumber !== undefined && Number.isInteger(lineNumber) && lineNumber > 0
    ? { lineSide, lineNumber }
    : undefined;
}

export function createReviewNote(observationId: string, entry: TaskWorktreeChangeEntryDto, line: ReviewLine): ReviewNote {
  return {
    ...line,
    key: JSON.stringify([observationId, entry.entry_id, line.lineSide, line.lineNumber]),
    observationId, entryId: entry.entry_id, displayPath: entry.display_path,
    pathEncoding: entry.path_encoding, side: entry.side, body: "",
  };
}

export function updateReviewNotes(notes: readonly ReviewNote[], note: ReviewNote, body: string): readonly ReviewNote[] {
  const value = body.slice(0, MAX_REVIEW_NOTE_CHARS);
  if (!value.trim()) return notes.filter((current) => current.key !== note.key);
  const exists = notes.some((current) => current.key === note.key);
  if (!exists && notes.length >= MAX_REVIEW_NOTES) return notes;
  const updated = { ...note, body: value };
  return exists ? notes.map((current) => current.key === note.key ? updated : current) : [...notes, updated];
}

export function taskReviewAgents(task: TaskDto, sessions: readonly SessionDto[]): SessionDto[] {
  const attached = new Set(task.worktree_presence?.attached_sessions
    .filter((session) => session.kind === "Agent").map((session) => session.session_id) ?? []);
  return sessions.filter((session) => attached.has(session.id)
    && session.project_id === task.project_id && session.kind === "Agent"
    && session.lifecycle_state === "running" && session.process.agent_id !== null);
}

export function buildReviewMessage(taskTitle: string, notes: readonly ReviewNote[]): string {
  const sections = notes.map((note) => {
    const encoding = note.pathEncoding === "lossy" ? " · lossy display path" : "";
    return `## ${singleLine(note.displayPath)}:${note.lineNumber} (${note.lineSide})${encoding}\nSource: Local changes · ${note.side}\nSnapshot: ${singleLine(note.observationId)}\n\n${safeReviewText(note.body).trim()}`;
  });
  return `Review notes — ${singleLine(taskTitle)}\n\n${sections.join("\n\n")}`;
}

export function reviewMessageBytes(message: string): number {
  return new TextEncoder().encode(message).byteLength;
}

export function reviewPasteBytes(message: string): Uint8Array {
  return new TextEncoder().encode(`\u001b[200~${safeReviewText(message)}\u001b[201~`);
}

function singleLine(value: string): string {
  return safeReviewText(value).replace(/\s+/g, " ").trim();
}

function safeReviewText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}
