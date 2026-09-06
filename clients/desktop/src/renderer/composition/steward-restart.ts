import type { DesktopApi } from "../transport/desktop-api.js";
import { sessionDismissCommand, type Session } from "../model.js";

export type StewardRestartApi = Pick<
  DesktopApi,
  "sessionClose" | "sessionTerminate" | "stewardConfigurationGet" | "stewardConfigurationSet"
>;

async function retireStewardSession(
  api: Pick<DesktopApi, "sessionClose" | "sessionTerminate">,
  sessionId: string,
  sessions: readonly Session[],
): Promise<void> {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const command = session ? sessionDismissCommand(session) : "terminate";
  if (command === "close") {
    await api.sessionClose(sessionId);
    return;
  }
  if (command !== "terminate") throw new Error("This Steward Session cannot be restarted yet.");
  const outcome = await api.sessionTerminate(sessionId);
  if (!outcome.ok) throw new Error(outcome.message);
}

/** Restart the Steward's exact Session, then let its supervisor relaunch it. */
export async function restartStewardSession(
  api: StewardRestartApi,
  projectId: string,
  sessions: readonly Session[] = [],
): Promise<string> {
  let snapshot = await api.stewardConfigurationGet(projectId);
  let steward = snapshot.configuration;
  if (!steward) throw new Error("The Project Steward is not configured.");
  if (!steward.enabled) throw new Error("Enable the Project Steward before restarting it.");

  if (steward.executorSessionId) {
    await retireStewardSession(api, steward.executorSessionId, sessions);
    snapshot = await api.stewardConfigurationGet(projectId);
    steward = snapshot.configuration;
    if (!steward) throw new Error("The Project Steward was removed while it was restarting.");
    if (!steward.enabled) throw new Error("The Project Steward was disabled while it was restarting.");
  }

  await api.stewardConfigurationSet({
    projectId,
    agentId: steward.agentId,
    model: steward.model,
    permission: steward.permission,
    reasoning: steward.reasoning,
    systemPrompt: steward.systemPrompt,
    enabled: true,
    expectedRevision: snapshot.stateRevision,
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const relaunched = await api.stewardConfigurationGet(projectId);
    const nextSessionId = relaunched.configuration?.executorSessionId;
    if (nextSessionId) return nextSessionId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Project Steward did not start a replacement Session.");
}
