import type { AgentStatusDto } from "@termloop/contract/current";
import { describe, expect, it } from "vitest";
import { acknowledgeSnapshotInterruption, presentedOverviewSnapshot } from "../src/features/overview/overview-presentation";
import { emptyOverviewSnapshot, snapshotWhileBackgrounded, snapshotWhileUnavailable } from "../src/features/overview/overview-resilience";
import { fixtureProjects, fixtureTasks } from "../src/fixtures/mobile-overview";
import { fixtureWorkflowProgress } from "../src/fixtures/workflow-progress";
import { reconcileAcknowledgedInterruptions, reconcileReviewReadySessions, statusMap } from "../src/presentation/agent-review-policy";
import { buildProjectOverview } from "../src/presentation/attention-overview";
import { presentedAgentStatus } from "../src/presentation/session-presentation";
import { workflowExecutionView } from "../src/presentation/workflow-execution";

const interrupted: AgentStatusDto = { sessionId: "workflow-context", status: "interrupted", source: "hook", observedAtEpochMs: 10 };
const acknowledgements = new Map([[interrupted.sessionId, interrupted.observedAtEpochMs]]);

function snapshot() {
  const fixture = fixtureWorkflowProgress();
  return {
    ...emptyOverviewSnapshot(),
    overview: {
      projects: fixtureProjects, tasks: fixtureTasks, sessions: fixture.sessions,
      agentStatuses: fixture.statuses.map((status) => status.sessionId === interrupted.sessionId ? interrupted : status),
      stewardEnabledProjectIds: [], stewardExecutorSessionIds: {}, agentGroupsByProject: {},
    },
  };
}

describe("mobile interruption acknowledgement", () => {
  it("clears only the inspected observation without changing the daemon DTO", () => {
    const raw = snapshot();
    const acknowledged = acknowledgeSnapshotInterruption(raw, interrupted.sessionId, 10);
    expect(acknowledged.acknowledgedInterruptedSessionObservations).toEqual(acknowledgements);
    expect(acknowledged.overview).toBe(raw.overview);
    expect(raw.acknowledgedInterruptedSessionObservations.size).toBe(0);
    const presented = presentedOverviewSnapshot(acknowledged);
    expect(presented.overview?.agentStatuses.find((status) => status.sessionId === interrupted.sessionId)?.status).toBe("idle");
    expect(raw.overview.agentStatuses).toContain(interrupted);
    expect(acknowledgeSnapshotInterruption(acknowledged, interrupted.sessionId, 10)).toBe(acknowledged);
  });

  it("ignores a stale navigation acknowledgement and an unknown session", () => {
    const raw = snapshot();
    expect(acknowledgeSnapshotInterruption(raw, interrupted.sessionId, 9)).toBe(raw);
    expect(acknowledgeSnapshotInterruption(raw, "missing", 10)).toBe(raw);
    expect(presentedAgentStatus({ ...interrupted, observedAtEpochMs: 11 }, acknowledgements).status).toBe("interrupted");
  });

  it.each(["working", "compacting", "awaitingInput", "failed", "exited", "idle", "unknown"] as const)("never dismisses %s", (status) => {
    const observation = { ...interrupted, status };
    expect(presentedAgentStatus(observation, acknowledgements)).toBe(observation);
    const raw = snapshot();
    raw.overview.agentStatuses = [observation];
    expect(acknowledgeSnapshotInterruption(raw, observation.sessionId, 10)).toBe(raw);
  });

  it("keeps acknowledgement across identical refreshes but prunes newer, removed, or resumed observations", () => {
    expect(reconcileAcknowledgedInterruptions(acknowledgements, [{ ...interrupted }])).toEqual(acknowledgements);
    expect(reconcileAcknowledgedInterruptions(acknowledgements, [{ ...interrupted, observedAtEpochMs: 11 }]).size).toBe(0);
    expect(reconcileAcknowledgedInterruptions(acknowledgements, [{ ...interrupted, status: "working" }]).size).toBe(0);
    expect(reconcileAcknowledgedInterruptions(acknowledgements, []).size).toBe(0);
  });

  it("retains acknowledgement offline and backgrounded, clearing it on revoked access", () => {
    const acknowledged = acknowledgeSnapshotInterruption(snapshot(), interrupted.sessionId, 10);
    expect(snapshotWhileUnavailable("offline", acknowledged).acknowledgedInterruptedSessionObservations).toEqual(acknowledgements);
    expect(snapshotWhileBackgrounded(acknowledged).acknowledgedInterruptedSessionObservations).toEqual(acknowledgements);
    expect(snapshotWhileUnavailable("revoked", acknowledged).acknowledgedInterruptedSessionObservations.size).toBe(0);
  });

  it("clears the same workflow helper in both Agents and Task workflow detail without recording an outcome", () => {
    const { execution } = fixtureWorkflowProgress();
    const raw = snapshot();
    const before = workflowExecutionView(execution, raw.overview.sessions, raw.overview.agentStatuses);
    expect(before.attentionAgents.map((agent) => agent.id)).toContain(interrupted.sessionId);
    const presented = presentedOverviewSnapshot(acknowledgeSnapshotInterruption(raw, interrupted.sessionId, 10)).overview!;
    const project = buildProjectOverview(presented, execution.projectId);
    expect(project.agents.find((agent) => agent.sessionId === interrupted.sessionId)?.tone).toBe("quiet");
    const after = workflowExecutionView(execution, presented.sessions, presented.agentStatuses);
    expect(after.attentionAgents.map((agent) => agent.id)).not.toContain(interrupted.sessionId);
    expect(after.rows[2]?.agent?.status).toBe("Idle");
    expect(after.rows.map((row) => row.state)).toEqual(before.rows.map((row) => row.state));
    expect(after.done).toBe(before.done);
  });

  it("does not turn the acknowledged interruption into Needs review or affect another Mac", () => {
    const macA = snapshot(), macB = snapshot();
    const presentedA = presentedOverviewSnapshot(acknowledgeSnapshotInterruption(macA, interrupted.sessionId, 10));
    expect(presentedA.reviewReadySessionIds.size).toBe(0);
    expect(reconcileReviewReadySessions(new Set(), statusMap([{ ...interrupted, status: "working" }]), macA.overview.agentStatuses).size).toBe(0);
    expect(presentedOverviewSnapshot(macB)).toBe(macB);
    expect(macB.overview.agentStatuses).toContain(interrupted);
  });
});
