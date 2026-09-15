import type { Session, WorkflowExecution } from "../model.js";
import { sessionDismissCommand, sessionLabel } from "../model.js";
import { sessionDismissErrorMessage } from "../control-error.js";
import type { DesktopApi } from "../transport/desktop-api.js";
import { dismissSessionDescriptor } from "./session-dismiss.js";

type WorkflowCloseApi = Pick<DesktopApi,
  "workflowConfigurationList" | "workflowExecutionCancel" | "sessionList" | "sessionTerminate" | "sessionClose"
>;

function members(execution: WorkflowExecution, sessions: readonly Session[]): Session[] {
  const ids = new Set([execution.coordinatorSessionId, ...execution.participants.map((participant) => participant.sessionId)]);
  const result: Session[] = [];
  for (const id of ids) {
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) continue;
    if (session.project_id !== execution.projectId || session.kind !== "Agent") {
      throw new Error("The workflow's agent membership changed. Refresh before closing it.");
    }
    if (session.archived_at_epoch_ms === null) result.push(session);
  }
  return result;
}

/** Keep the run until all its exact current Agents are closed, so partial
 * failures remain grouped and retryable. Closing the lead first also retires
 * its delegation endpoint. Re-read afterwards to include helpers admitted
 * while the lead was stopping; never infer membership from a name or cwd. */
export async function closeWorkflowAgents(
  api: WorkflowCloseApi,
  projectId: string,
  executionId: string,
  dismiss: (session: Session) => Promise<void> = (session) => dismissSessionDescriptor(api, session),
): Promise<void> {
  const read = async () => {
    const [workflows, sessions] = await Promise.all([
      api.workflowConfigurationList({ projectId }), api.sessionList(),
    ]);
    const execution = workflows.executions.find((candidate) => candidate.id === executionId);
    if (execution && execution.projectId !== projectId) throw new Error("The workflow belongs to another Project.");
    return { execution, sessions, revision: workflows.stateRevision };
  };
  const dismissChecked = async (session: Session) => {
    if (!sessionDismissCommand(session)) throw new Error(`${sessionLabel(session)} cannot be closed yet. Try again when its current operation finishes.`);
    await dismiss(session);
  };
  const initial = await read();
  if (!initial.execution) throw new Error("This workflow run is no longer available. Refresh the Agents list.");
  const initialMembers = members(initial.execution, initial.sessions);
  const lead = initialMembers.find((session) => session.id === initial.execution!.coordinatorSessionId);
  if (lead) await dismissChecked(lead);

  const current = await read();
  if (!current.execution || current.execution.coordinatorSessionId !== initial.execution.coordinatorSessionId) {
    throw new Error("The workflow changed while closing. Refresh and check its remaining agents.");
  }
  const remaining = members(current.execution, current.sessions);
  if (remaining.some((session) => session.id === current.execution!.coordinatorSessionId)) {
    throw new Error("The lead agent was reopened while closing. Try Close all again.");
  }
  const results = await Promise.allSettled(remaining.map(dismissChecked));
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`${sessionLabel(remaining[index]!)}: ${sessionDismissErrorMessage(result.reason)}`] : []);
  if (failures.length) throw new Error(`Some agents could not be closed. Already closed conversations are in Deleted. Retry to close the remaining agents. ${failures.join("; ")}`);

  // Refresh the CAS revision after Session mutations. Keep the execution if
  // another client restored a member or changed the run in the meantime.
  const final = await read();
  if (!final.execution) return;
  if (members(final.execution, final.sessions).length) {
    throw new Error("The workflow has new or reopened agents. Try Close all again.");
  }
  await api.workflowExecutionCancel({ executionId, expectedRevision: final.revision });
}
