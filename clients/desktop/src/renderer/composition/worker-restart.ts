import type { DesktopApi } from "../transport/desktop-api.js";

export type WorkerRestartApi = Pick<
  DesktopApi,
  "sessionTerminate" | "workerConfigurationList" | "workerConfigurationUpdate"
>;

export type StewardRestartApi = Pick<
  DesktopApi,
  "sessionTerminate" | "stewardConfigurationGet" | "stewardConfigurationSet"
>;

/** Restart the Steward's exact Session, then launch its current configuration. */
export async function restartStewardSession(
  api: StewardRestartApi,
  projectId: string,
): Promise<string> {
  let snapshot = await api.stewardConfigurationGet(projectId);
  let steward = snapshot.configuration;
  if (!steward) throw new Error("The Project Steward is not configured.");
  if (!steward.enabled) throw new Error("Enable the Project Steward before restarting it.");

  if (steward.executorSessionId) {
    const outcome = await api.sessionTerminate(steward.executorSessionId);
    if (!outcome.ok) throw new Error(outcome.message);
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
  // Steward launch is intentionally supervisor-driven, unlike the synchronous
  // Worker launch command. Wait only for the bounded UI operation; the
  // supervisor remains the process owner.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const relaunched = await api.stewardConfigurationGet(projectId);
    const nextSessionId = relaunched.configuration?.executorSessionId;
    if (nextSessionId) return nextSessionId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The Project Steward did not start a replacement Session.");
}

/** Restart the Worker's exact Session, then launch its current configuration. */
export async function restartWorkerSession(
  api: WorkerRestartApi,
  projectId: string,
  workerId: string,
): Promise<string> {
  let snapshot = await api.workerConfigurationList({ projectId });
  let worker = snapshot.configurations.find((candidate) => candidate.id === workerId);
  if (!worker) throw new Error("The Worker is no longer available.");
  if (!worker.enabled) throw new Error("Enable the Worker before restarting it.");

  if (worker.executorSessionId) {
    const outcome = await api.sessionTerminate(worker.executorSessionId);
    if (!outcome.ok) throw new Error(outcome.message);
    // Termination clears the durable Session pointer. Read the current Worker
    // and CAS revision instead of restoring the renderer's older snapshot.
    snapshot = await api.workerConfigurationList({ projectId });
    worker = snapshot.configurations.find((candidate) => candidate.id === workerId);
    if (!worker) throw new Error("The Worker was removed while it was restarting.");
    if (!worker.enabled) throw new Error("The Worker was disabled while it was restarting.");
  }

  await api.workerConfigurationUpdate({
    workerId: worker.id,
    name: worker.name,
    agentId: worker.agentId,
    model: worker.model,
    permission: worker.permission,
    reasoning: worker.reasoning,
    enabled: true,
    pingIntervalSeconds: worker.pingIntervalSeconds,
    workerPrompt: worker.workerPrompt,
    systemPrompt: worker.systemPrompt,
    expectedRevision: snapshot.stateRevision,
  });
  const relaunched = await api.workerConfigurationList({ projectId });
  const nextSessionId = relaunched.configurations.find((candidate) => candidate.id === workerId)?.executorSessionId;
  if (!nextSessionId) throw new Error("The Worker did not start a replacement Session.");
  return nextSessionId;
}
