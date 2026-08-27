import type { SessionDto, SessionRelocationPreviewDto } from "@termloop/contract/current";
import { retryAgentSession, type SessionResumeApi } from "./session-resume.js";

export type SessionRelocationApi = SessionResumeApi & {
  sessionPreviewRelocateAgent(
    sessionId: string,
    taskId: string,
    mode: "resume" | "fresh",
  ): Promise<SessionRelocationPreviewDto>;
  sessionRelocateAgent(
    sessionId: string,
    taskId: string,
    operationId: string,
    relocationTicket: string,
  ): Promise<SessionDto>;
  sessionPreviewRelocateAgentToProject(
    sessionId: string,
    projectId: string,
  ): Promise<SessionRelocationPreviewDto>;
  sessionRelocateAgentToProject(
    sessionId: string,
    projectId: string,
    operationId: string,
    relocationTicket: string,
  ): Promise<SessionDto>;
};

type ApprovedRelocation = {
  operationId: string;
  relocationTicket: string;
  manifestDigest: string;
};

type TaskRelocation = ApprovedRelocation & {
  sessionId: string;
  taskId: string;
  mode: "resume" | "fresh";
};

type ProjectRelocation = ApprovedRelocation & {
  sessionId: string;
  projectId: string;
};

const relocationChains = new WeakMap<object, Map<string, Promise<SessionDto>>>();

/**
 * A Codex TUI can time out before reaching its App Server while a provider-owned
 * pre-start network request is stalled. The failed relocation has already
 * rolled back and reaped its target runtime, so restore the exact source
 * conversation, resolve the same relocation manifest again, and consume it
 * once. No other failure class receives an automatic retry.
 */
export function relocateAgentToTaskWithStartupRetry(
  api: SessionRelocationApi,
  request: TaskRelocation,
): Promise<SessionDto> {
  return coalesceRelocation(api, request.sessionId, async () => {
    const first = await api.sessionRelocateAgent(
      request.sessionId,
      request.taskId,
      request.operationId,
      request.relocationTicket,
    );
    if (!isRetryableStartupTimeout(first)) return first;

    const restored = await retryAgentSession(api, request.sessionId);
    if (requiresProviderHistoryRepair(restored)) return restored;
    if (restored.lifecycle_state !== "running") return relocationRecoveryFailure(restored);
    const preview = await api.sessionPreviewRelocateAgent(
      request.sessionId,
      request.taskId,
      request.mode,
    );
    const ticket = approvedRetryTicket(preview, request.manifestDigest);
    const retried = await api.sessionRelocateAgent(
      request.sessionId,
      request.taskId,
      crypto.randomUUID(),
      ticket,
    );
    return retryOutcome(retried);
  });
}

export function relocateAgentToProjectWithStartupRetry(
  api: SessionRelocationApi,
  request: ProjectRelocation,
): Promise<SessionDto> {
  return coalesceRelocation(api, request.sessionId, async () => {
    const first = await api.sessionRelocateAgentToProject(
      request.sessionId,
      request.projectId,
      request.operationId,
      request.relocationTicket,
    );
    if (!isRetryableStartupTimeout(first)) return first;

    const restored = await retryAgentSession(api, request.sessionId);
    if (requiresProviderHistoryRepair(restored)) return restored;
    if (restored.lifecycle_state !== "running") return relocationRecoveryFailure(restored);
    const preview = await api.sessionPreviewRelocateAgentToProject(
      request.sessionId,
      request.projectId,
    );
    const ticket = approvedRetryTicket(preview, request.manifestDigest);
    const retried = await api.sessionRelocateAgentToProject(
      request.sessionId,
      request.projectId,
      crypto.randomUUID(),
      ticket,
    );
    return retryOutcome(retried);
  });
}

function isRetryableStartupTimeout(session: SessionDto): boolean {
  return session.lifecycle_state === "resumeFailed"
    && session.resume_failure_reason === "startupTimedOut"
    && session.retryable;
}

function requiresProviderHistoryRepair(session: SessionDto): boolean {
  return session.lifecycle_state === "resumeFailed"
    && session.resume_failure_reason === "providerHistoryDamaged";
}

function relocationRecoveryFailure(session: SessionDto): never {
  throw new Error(
    `The move timed out and the source Agent could not be restored (${session.resume_failure_reason ?? session.lifecycle_state}).`,
  );
}

function retryOutcome(session: SessionDto): SessionDto {
  if (isRetryableStartupTimeout(session)) {
    throw new Error("The move timed out again after one automatic retry. The Agent is back at its source; try again when the provider connection is stable.");
  }
  return session;
}

function approvedRetryTicket(
  preview: SessionRelocationPreviewDto,
  approvedManifestDigest: string,
): string {
  if (!preview.can_relocate || !preview.relocation_ticket || !preview.manifest) {
    throw new Error("The move timed out, and its target is no longer ready. Review it and try again.");
  }
  if (preview.manifest.digest !== approvedManifestDigest) {
    throw new Error("The move changed while retrying. Review the updated launch and try again.");
  }
  return preview.relocation_ticket;
}

function coalesceRelocation(
  api: object,
  sessionId: string,
  run: () => Promise<SessionDto>,
): Promise<SessionDto> {
  let apiChains = relocationChains.get(api);
  if (!apiChains) {
    apiChains = new Map();
    relocationChains.set(api, apiChains);
  }
  const existing = apiChains.get(sessionId);
  if (existing) return existing;

  const chain = run().finally(() => {
    if (apiChains?.get(sessionId) === chain) apiChains.delete(sessionId);
  });
  apiChains.set(sessionId, chain);
  return chain;
}
