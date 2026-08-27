import { describe, expect, it } from "vitest";
import type { Session, Task } from "../src/renderer/model.js";
import {
  buildChangeReviewMessage,
  changeReviewLine,
  reviewMessageByteLength,
  taskReviewAgentSessions,
  terminalReviewSubmission,
} from "../src/renderer/changes-review.js";

function task(): Task {
  return {
    id: "task-1",
    project_id: "project-1",
    title: "Review task",
    brief: null,
    jira_url: null,
    archived_at_epoch_ms: null,
    status: "open",
    branch: { repository_root: "/repo", name: "feature/review" },
    worktree: { path: "/repo-review" },
    worktree_presence: {
      observation_sequence: 1,
      observed_at_epoch_ms: 1,
      attached_sessions: [
        { session_id: "agent-1", kind: "Agent" },
        { session_id: "terminal-1", kind: "Terminal" },
      ],
      total_count: 2,
      terminal_count: 1,
      agent_count: 1,
      truncated: false,
    },
    rank: 0,
    created_at_epoch_ms: 1,
    updated_at_epoch_ms: 1,
  };
}

function session(id: string, kind: Session["kind"], lifecycle: Session["lifecycle_state"] = "running"): Session {
  return {
    id,
    project_id: "project-1",
    name: null,
    kind,
    lifecycle_state: lifecycle,
    runtime_epoch: 1,
    archived_at_epoch_ms: null,
    resume_failure_reason: null,
    retryable: false,
    closable: false,
    forkable: false,
    ask_to_source_session_id: null,
    run_configuration_id: null,
    process: {
      program: "/bin/sh",
      args: [],
      cwd: "/repo-review",
      agent_id: kind === "Agent" ? "codex" : null,
      template_ref: null,
      template_version: null,
    },
  };
}

describe("Changes review notes", () => {
  it("offers only running Agent Sessions currently projected in the Task worktree", () => {
    const sessions = [
      session("agent-1", "Agent"),
      session("terminal-1", "Terminal"),
      session("agent-2", "Agent"),
      session("agent-3", "Agent", "exited"),
    ];
    expect(taskReviewAgentSessions(task(), sessions).map((value) => value.id)).toEqual(["agent-1"]);
  });

  it("builds the exact visible message without patch bytes and marks lossy paths", () => {
    const message = buildChangeReviewMessage("Review\nTask", [
      {
        key: "local:one",
        sourceLabel: "Local changes · staged",
        displayPath: "src/unsafe\u001b[31m.ts",
        pathEncoding: "lossy",
        changeKey: "I42",
        lineSide: "new",
        lineNumber: 42,
        body: "Please rename this.\nKeep the public API.",
      },
    ]);
    expect(message).toContain("Review notes — Review Task");
    expect(message).toContain("src/unsafe�[31m.ts:42 (new) · lossy display path");
    expect(message).toContain("Please rename this.\nKeep the public API.");
    expect(message).not.toContain("diff --git");
    expect(reviewMessageByteLength(message)).toBe(new TextEncoder().encode(message).byteLength);
  });

  it("binds insert, delete, and context comments to the displayed side and line", () => {
    expect(changeReviewLine({ type: "insert", content: "+new", lineNumber: 8, isInsert: true }, "new"))
      .toEqual({ changeKey: "I8", lineSide: "new", lineNumber: 8 });
    expect(changeReviewLine({ type: "delete", content: "-old", lineNumber: 5, isDelete: true }, "old"))
      .toEqual({ changeKey: "D5", lineSide: "old", lineNumber: 5 });
    const context = { type: "normal", content: " same", oldLineNumber: 12, newLineNumber: 13, isNormal: true } as const;
    expect(changeReviewLine(context, "old")).toEqual({ changeKey: "N12", lineSide: "old", lineNumber: 12 });
    expect(changeReviewLine(context, "new")).toEqual({ changeKey: "N12", lineSide: "new", lineNumber: 13 });
  });

  it("uses one bracketed paste followed by a single submit and strips terminal controls", () => {
    const submission = terminalReviewSubmission("first\u001b[201~\nsecond\u0000");
    expect(submission).toBe("\u001b[200~first�[201~\nsecond�\u001b[201~\r");
    expect(submission.match(/\u001b\[201~/g)).toHaveLength(1);
  });
});
