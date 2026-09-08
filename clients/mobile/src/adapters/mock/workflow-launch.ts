import type { WorkflowLaunchPort } from "../../application/workflow-launch-port";
import { fixtureSessions, fixtureTasks } from "../../fixtures/mobile-overview";

// A visible development preview only; no agents are started on a Mac.
export function createMockWorkflowLaunch(): WorkflowLaunchPort {
  return {
    async start(connectionId, params, configuration) {
      if (connectionId !== "connection-local-mac") throw new Error("mock connection not found");
      const task = fixtureTasks.find((item) => item.id === params.taskId && item.project_id === configuration.projectId);
      if (!task || !params.goal.trim()) throw new Error("Choose a Task and enter a workflow goal.");
      const session = fixtureSessions.find((item) => task.worktree_presence?.attached_sessions.some((attached) => attached.session_id === item.id));
      if (!session) throw new Error("This mock Task has no demo agent. Use the mobile Task to preview launch.");
      return { ...session };
    },
  };
}
