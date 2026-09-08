import { connectionProfileIdOf } from "../../connection-scope.js";
import type { Session } from "../model.js";

export type SessionActivationContext = {
  projectId: string;
  connectionProfileId: string;
};

export type SessionActivationRefresh =
  | { kind: "project" }
  | { kind: "task"; taskId: string };

export type SessionActivationIntent = {
  id: number;
  navigationRevision: number;
};

type SessionActivationPorts = {
  upsertSession(session: Session): void;
  reconcileTerminals(): void;
  refreshProject(context: SessionActivationContext): Promise<void>;
  refreshTasks(context: SessionActivationContext, taskIds: readonly string[]): Promise<void>;
  navigationRevision(): number;
  hasProject(projectId: string): boolean;
  hasSession(sessionId: string): boolean;
  reportRefreshFailure(error: unknown): void;
  selectProject(projectId: string): void;
  selectSession(projectId: string, sessionId: string): void;
  focusSession(sessionId: string): void;
};

/// A completed launch is already durable. Activation only installs its client
/// projection and reveals its terminal after the required projections settle.
export function createSessionActivation(ports: SessionActivationPorts) {
  let latestIntentId = 0;
  const capture = (): SessionActivationIntent => ({
    id: ++latestIntentId,
    navigationRevision: ports.navigationRevision(),
  });
  const activate = async (
    intent: SessionActivationIntent,
    session: Session,
    refresh: SessionActivationRefresh = { kind: "project" },
  ): Promise<void> => {
    const context = {
      projectId: session.project_id,
      connectionProfileId: connectionProfileIdOf(session),
    };
    ports.upsertSession(session);
    ports.reconcileTerminals();
    try {
      if (refresh.kind === "task") {
        await ports.refreshTasks(context, [refresh.taskId]);
      } else {
        await ports.refreshProject(context);
      }
    } catch (error) {
      // The launch response proves the Session committed. Keep that fact
      // visible even if a failed source refresh rebuilt the projection without it.
      if (!ports.hasSession(session.id)) {
        ports.upsertSession(session);
        ports.reconcileTerminals();
      }
      ports.reportRefreshFailure(error);
    }
    if (
      intent.id !== latestIntentId
      || ports.navigationRevision() !== intent.navigationRevision
      || !ports.hasProject(context.projectId)
      || !ports.hasSession(session.id)
    ) return;
    ports.selectProject(context.projectId);
    ports.selectSession(context.projectId, session.id);
    ports.focusSession(session.id);
  };
  return { capture, activate };
}
