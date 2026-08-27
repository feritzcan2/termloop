import { isLiveSession, type Session } from "../model.js";
import { providerHistoryRepairErrorMessage } from "../control-error.js";
import type { SourceDesktopApi } from "../transport/desktop-api.js";
import { retryAgentSession, type SessionResumeApi } from "./session-resume.js";

type ProviderHistoryRepairApi = Pick<
  SourceDesktopApi,
  "sessionTerminate" | "sessionRepairProviderHistory"
>;

type ProviderHistoryRepairOutcome = { failure?: string; success?: string };

const fixes = new Map<string, Promise<ProviderHistoryRepairOutcome>>();

export async function executeProviderHistoryRepair(
  api: ProviderHistoryRepairApi,
  session: Session,
): Promise<ProviderHistoryRepairOutcome> {
  if (isLiveSession(session)) {
    const terminated = await api.sessionTerminate(session.id);
    if (!terminated.ok) return { failure: terminated.message };
  }
  const outcome = await api.sessionRepairProviderHistory(session.id);
  if (!outcome.ok) return { failure: providerHistoryRepairErrorMessage(outcome) };
  if (outcome.result.outcome === "alreadyHealthy") {
    return { success: "The provider history is healthy. You can retry the conversation now." };
  }
  const records = outcome.result.repairedRecords;
  return {
    success: `Provider history repaired (${records} record${records === 1 ? "" : "s"}). An exact backup was retained.`,
  };
}

/// Fix is the row-level recovery action: perform the acknowledged, bounded
/// provider-history repair and consume a freshly previewed resume manifest only
/// after that repair succeeds. Repeated clicks share the same in-flight chain.
export function fixProviderHistoryAndRetry(
  api: ProviderHistoryRepairApi & SessionResumeApi,
  session: Session,
): Promise<ProviderHistoryRepairOutcome> {
  const existing = fixes.get(session.id);
  if (existing) return existing;

  const fix = (async () => {
    const outcome = await executeProviderHistoryRepair(api, session);
    if (outcome.failure) return outcome;
    await retryAgentSession(api, session.id);
    return outcome;
  })().finally(() => {
    if (fixes.get(session.id) === fix) fixes.delete(session.id);
  });
  fixes.set(session.id, fix);
  return fix;
}
