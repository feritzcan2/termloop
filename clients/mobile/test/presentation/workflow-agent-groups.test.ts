import type { SessionDto } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";
import { fixtureTasks } from "../../src/fixtures/mobile-overview";
import { fixtureWorkflowProgress } from "../../src/fixtures/workflow-progress";
import type { AgentCluster, AgentRow } from "../../src/presentation/attention-overview";
import { workflowAgentClusters, workflowAgentMemberships, workflowAgentSegments } from "../../src/presentation/workflow-agent-groups";

const fixture = fixtureWorkflowProgress(1_700_000_000_000);
const { execution } = fixture;
const sessions = fixture.sessions.map((session, index): SessionDto => ({ ...session, name: index === 0 ? execution.workflowName : index === 1 ? "Claude" : "Codex" }));
const memberships = (runs = [execution], values = sessions) => workflowAgentMemberships(runs, values, fixtureTasks, execution.projectId);

describe("workflow identity in mobile Agents", () => {
  it("labels Taskless workflow members as Project checkout", () => {
    const groups = memberships([{ ...execution, taskId: null }]);
    expect(groups.size).toBe(3);
    expect(groups.get(sessions[0]!.id)?.group.taskTitle).toBe("Project checkout");
  });
  it("names the lead and reviewers from exact assigned roles without renaming stored Sessions", () => {
    const groups = memberships();
    expect([...groups.values()].map((item) => item.displayName)).toEqual(["Implementer · Codex", "Reviewer · Claude", "Reviewer · Codex"]);
    expect(groups.get(sessions[0]!.id)?.group).toMatchObject({ executionId: execution.id, name: execution.workflowName, status: "Running", taskTitle: fixtureTasks[0]!.title });
    expect(groups.get(sessions[0]!.id)?.group).toBe(groups.get(sessions[1]!.id)?.group);
    expect(sessions[0]!.name).toBe(execution.workflowName);
  });

  it("does not claim similarly named agents or ordinary Ask-To helpers sharing the lead and worktree", () => {
    const extra = { ...sessions[1]!, id: "unrelated", name: execution.workflowName, ask_to_source_session_id: sessions[0]!.id };
    expect(memberships([execution], [...sessions, extra]).has(extra.id)).toBe(false);
  });

  it("excludes archived, missing, non-Agent, and cross-project descriptors and snapshots", () => {
    expect(memberships([execution], []).size).toBe(0);
    const invalid = sessions.map((session, index): SessionDto => index === 0 ? { ...session, archived_at_epoch_ms: 9 } : index === 1 ? { ...session, project_id: "other" } : { ...session, kind: "Terminal" });
    expect(memberships([execution], invalid).size).toBe(0);
    expect(memberships([{ ...execution, projectId: "other" }]).size).toBe(0);
    expect(workflowAgentMemberships([execution], sessions, [{ ...fixtureTasks[0]!, project_id: "other" }], execution.projectId).get(sessions[0]!.id)?.group.taskTitle).toBeUndefined();
  });

  it.each([
    ["approved", "Approved", "done"], ["completed", "Completed", "done"],
    ["reviewLimitReached", "Review limit reached", "attention"], ["changesRequested", "Changes requested", "attention"],
  ] as const)("keeps completed %s groups identifiable without claiming every result is approved", (completionOutcome, status, tone) => {
    const groups = memberships([{ ...execution, status: "completed", phase: "completed", completionOutcome }]);
    expect(groups.size).toBe(3);
    expect(groups.get(sessions[0]!.id)?.group).toMatchObject({ status, tone });
  });

  it("keeps custom names and changes Advisor to Reviewer only after actual assignment", () => {
    const run = { ...execution, participants: execution.participants.slice(0, 1) };
    expect(memberships([run]).get(sessions[1]!.id)?.displayName).toBe("Advisor · Claude");
    const custom = sessions.map((session) => ({ ...session, name: "Security expert" }));
    expect(memberships([execution], custom).get(sessions[1]!.id)?.displayName).toBe("Reviewer · Security expert");
    expect(memberships([{ ...execution, currentStepIndex: 4 }]).get(sessions[0]!.id)?.displayName).toBe("Fixer · Codex");
  });

  it("prefers the most recently updated execution when an exact participant is reused", () => {
    const newer = { ...execution, id: "newer", status: "paused" as const, updatedAtEpochMs: execution.updatedAtEpochMs + 1 };
    const runs = [newer, execution];
    expect(memberships(runs).get(sessions[0]!.id)?.group).toMatchObject({ executionId: "newer", status: "Paused", tone: "blocked" });
    expect(runs[0]).toBe(newer);
  });

  it("combines an execution's independent roots once without mutation or absorbing unrelated/manual groups", () => {
    const cluster = (id: string): AgentCluster => ({ key: id, manualGroup: undefined, groups: [{ source: { sessionId: id } as AgentRow, helpers: [] }] });
    const roots = sessions.map((session) => cluster(session.id));
    const ordinary = cluster("ordinary");
    const manual = { ...roots[1]!, manualGroup: { name: "Custom", sessionIds: [sessions[1]!.id] } };
    const mixed = { ...roots[2]!, groups: [{ source: roots[2]!.groups[0]!.source, helpers: [{ sessionId: "helper" } as AgentRow] }] };
    const input = [roots[0]!, ordinary, roots[1]!, roots[2]!];
    const before = structuredClone(input);
    const result = workflowAgentClusters(input, memberships());
    expect(result.map((value) => value.key)).toEqual([roots[0]!.key, "ordinary"]);
    expect(result[0]!.groups).toEqual(roots.flatMap((value) => value.groups));
    expect(input).toEqual(before);
    expect(workflowAgentClusters([roots[0]!, manual, mixed], memberships())).toEqual([roots[0]!, manual, mixed]);
    const splitMemberships = new Map(memberships());
    const member = splitMemberships.get(sessions[1]!.id)!;
    splitMemberships.set(sessions[1]!.id, { ...member, group: { ...member.group, executionId: "other-run" } });
    expect(workflowAgentClusters(roots.slice(0, 2), splitMemberships)).toEqual(roots.slice(0, 2));
  });

  it("segments in place without absorbing unrelated helpers or joining different manual roots", () => {
    const rows = [sessions[0]!.id, "ordinary", sessions[1]!.id, sessions[2]!.id].map((sessionId) => ({ sessionId }) as AgentRow);
    const segments = workflowAgentSegments(rows, memberships());
    expect(segments.map((segment) => [segment.group?.executionId, segment.rows.map((row) => row.sessionId)]))
      .toEqual([[execution.id, [sessions[0]!.id]], [undefined, ["ordinary"]], [execution.id, [sessions[1]!.id, sessions[2]!.id]]]);
    expect(segments.flatMap((segment) => segment.rows)).toEqual(rows);
    expect(workflowAgentSegments(rows, new Map())).toEqual([{ group: undefined, rows }]);
  });
});
