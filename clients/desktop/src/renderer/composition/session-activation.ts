import { connectionProfileIdOf } from "../../connection-scope.js";
import type { Session } from "../model.js";

export type SessionActivationContext = {
  projectId: string;
  connectionProfileId: string;
};

export type SessionActivationRefresh =
  | { kind: "project" }
  | { kind: "task"; taskId: string };

type SessionActivationPorts = {
  upsertSession(session: Session): void;
  reconcileTerminals(): void;
  refreshProject(context: SessionActivationContext): Promise<void>;
  refreshTasks(context: SessionActivationContext, taskIds: readonly string[]): Promise<void>;
  selectProject(projectId: string): void;
  selectSession(projectId: string, sessionId: string): void;
  focusSession(sessionId: string): void;
};

/// A completed launch is already durable. Activation only installs its client
/// projection and reveals its terminal after the required projections settle.
export function createSessionActivation(ports: SessionActivationPorts) {
  return async (session: Session, refresh: SessionActivationRefresh = { kind: "project" }): Promise<void> => {
    const context = {
      projectId: session.project_id,
      connectionProfileId: connectionProfileIdOf(session),
    };
    ports.upsertSession(session);
    ports.reconcileTerminals();
    if (refresh.kind === "task") {
      await ports.refreshTasks(context, [refresh.taskId]);
    } else {
      await ports.refreshProject(context);
    }
    ports.selectProject(context.projectId);
    ports.selectSession(context.projectId, session.id);
    ports.focusSession(session.id);
  };
}
