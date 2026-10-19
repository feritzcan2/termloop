import type { AgentLaunchPreviewResult, SessionDto } from "@termloop/contract/current";
import { isLiveSession } from "../model.js";

export type SessionResumeApi = {
  sessionPreviewResumeAgent(sessionId: string): Promise<AgentLaunchPreviewResult>;
  sessionResumeAgent(sessionId: string, launchTicket: string): Promise<SessionDto>;
};

const retries = new Map<string, Promise<SessionDto>>();

/// Retry is one explicit user action. The preview call remains the only way to
/// mint an execution ticket from invocation's resolved manifest; the desktop
/// immediately consumes that opaque ticket and never reconstructs launch data.
export function retryAgentSession(api: SessionResumeApi, sessionId: string): Promise<SessionDto> {
  const existing = retries.get(sessionId);
  if (existing) return existing;

  const retry = (async () => {
    const preview = await api.sessionPreviewResumeAgent(sessionId);
    if (!preview || typeof preview.launch_ticket !== "string" || !preview.manifest) {
      throw new Error("Resume preview returned an invalid manifest.");
    }
    return api.sessionResumeAgent(sessionId, preview.launch_ticket);
  })().finally(() => {
    if (retries.get(sessionId) === retry) retries.delete(sessionId);
  });
  retries.set(sessionId, retry);
  return retry;
}

export type DeletedSessionRestoreApi = SessionResumeApi & {
  sessionRestoreDeleted(sessionId: string): Promise<SessionDto>;
};

/// Deleted restore returns the descriptor as exited behind its output history.
/// A resumable Agent continues through the same inspected resume as Retry; a
/// resume failure is reported separately because the restore itself committed.
export async function restoreDeletedAgent(
  api: DeletedSessionRestoreApi,
  sessionId: string,
): Promise<{ session: SessionDto; resumeError?: unknown }> {
  const restored = await api.sessionRestoreDeleted(sessionId);
  if (isLiveSession(restored) || !restored.retryable) return { session: restored };
  try {
    return { session: await retryAgentSession(api, sessionId) };
  } catch (resumeError) {
    return { session: restored, resumeError };
  }
}
