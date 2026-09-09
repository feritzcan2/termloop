import { describe, expect, it } from "vitest";
import {
  buildReviewMessage, createReviewNote, diffReviewLine, MAX_REVIEW_NOTES, MAX_REVIEW_NOTE_CHARS,
  reviewMessageBytes, reviewPasteBytes, taskReviewAgents, updateReviewNotes,
} from "../../src/presentation/change-review-notes";
import { fixtureSessions, fixtureTasks, fixtureTaskWorktreeChanges } from "../../src/fixtures/mobile-overview";

const entry = fixtureTaskWorktreeChanges.entries[0]!;
const note = createReviewNote("snapshot-a", entry, { lineSide: "new", lineNumber: 12 });

describe("mobile line feedback", () => {
  it("uses old numbers for removals and new numbers for insertions and context", () => {
    expect(diffReviewLine({ type: "delete", lineNumber: 20 })).toEqual({ lineSide: "old", lineNumber: 20 });
    expect(diffReviewLine({ type: "insert", lineNumber: 25 })).toEqual({ lineSide: "new", lineNumber: 25 });
    expect(diffReviewLine({ type: "normal", oldLineNumber: 21, newLineNumber: 26 })).toEqual({ lineSide: "new", lineNumber: 26 });
    expect(diffReviewLine({ type: "normal" })).toBeUndefined();
    expect(diffReviewLine({ type: "insert", lineNumber: 0 })).toBeUndefined();
  });

  it("keeps different observations, entries and sides distinct", () => {
    const variants = [note,
      createReviewNote("snapshot-b", entry, note),
      createReviewNote("snapshot-a", { ...entry, entry_id: "another-entry" }, note),
      createReviewNote("snapshot-a", entry, { lineSide: "old", lineNumber: 12 }),
    ];
    expect(new Set(variants.map((value) => value.key)).size).toBe(4);
  });

  it("updates one comment, removes blanks, and enforces the batch and text limits", () => {
    const notes = Array.from({ length: MAX_REVIEW_NOTES }, (_, index) => ({ ...note, key: String(index), body: "Keep" }));
    expect(updateReviewNotes(notes, note, "Extra")).toBe(notes);
    const changed = updateReviewNotes(notes, notes[0]!, "x".repeat(MAX_REVIEW_NOTE_CHARS + 1));
    expect(changed[0]!.body).toHaveLength(MAX_REVIEW_NOTE_CHARS);
    expect(changed.slice(1)).toEqual(notes.slice(1));
    expect(updateReviewNotes(changed, changed[0]!, " \n ")).toHaveLength(MAX_REVIEW_NOTES - 1);
    expect(updateReviewNotes([], note, "  ")).toEqual([]);
  });

  it("batches file, side, line and snapshot context into one safe multiline paste", () => {
    const message = buildReviewMessage("Task\r\nname", [
      { ...note, displayPath: "src/a\n.ts", body: "First\r\nline\u001b[201~\u0003" },
      { ...note, displayPath: "src/b.ts", side: "staged", lineSide: "old", pathEncoding: "lossy", body: "İkinci yorum" },
    ]);
    expect(message).toContain("Review notes — Task name");
    expect(message).toContain("## src/a .ts:12 (new)");
    expect(message).toContain("Source: Local changes · staged");
    expect(message).toContain("Snapshot: snapshot-a");
    expect(message).toContain("## src/b.ts:12 (old) · lossy display path");
    expect(message).toContain("First\nline�[201~�");
    const paste = new TextDecoder().decode(reviewPasteBytes(message));
    expect(paste).toBe(`\u001b[200~${message}\u001b[201~`);
    expect(reviewMessageBytes("🙂İ")).toBe(6);
  });

  it("only offers running Agents explicitly attached to this Task and Project", () => {
    const base = fixtureSessions.find((session) => session.kind === "Agent")!;
    const task = { ...fixtureTasks[0]!, project_id: base.project_id, worktree_presence: {
      ...fixtureTasks[0]!.worktree_presence!, attached_sessions: [
        { session_id: "valid", kind: "Agent" as const },
        { session_id: "exited", kind: "Agent" as const },
        { session_id: "foreign", kind: "Agent" as const },
        { session_id: "terminal", kind: "Terminal" as const },
        { session_id: "missing-agent", kind: "Agent" as const },
      ],
    } };
    const valid = { ...base, id: "valid", lifecycle_state: "running" as const };
    expect(taskReviewAgents(task, [valid,
      { ...valid, id: "exited", lifecycle_state: "exited" },
      { ...valid, id: "foreign", project_id: "other" },
      { ...valid, id: "terminal", kind: "Terminal" },
      { ...valid, id: "missing-agent", process: { ...valid.process, agent_id: null } },
      { ...valid, id: "unattached" },
    ])).toEqual([valid]);
    const { worktree_presence: _presence, ...withoutPresence } = task;
    expect(taskReviewAgents(withoutPresence, [valid])).toEqual([]);
  });
});
