import type { AgentLaunchPreviewResult, SessionDto } from "@termloop/contract/current";

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
