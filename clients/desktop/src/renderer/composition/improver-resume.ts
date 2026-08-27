import type {
  AssistantPromptImproverTarget,
  DeletedSessionDto,
  ImproverSessionTargetDto,
  RunConfigurationImproverTarget,
  SessionDto,
  SettingsImproverTarget,
} from "@termloop/contract/current";
import { isLiveSession } from "../model.js";
import { retryAgentSession, type SessionResumeApi } from "./session-resume.js";

export type ImproverResumeApi = SessionResumeApi & {
  sessionListDeleted(projectId: string): Promise<DeletedSessionDto[]>;
  sessionRestoreDeleted(sessionId: string): Promise<SessionDto>;
};

export type LegacyImproverIdentity = {
  templateRef: string;
  sessionName: string;
  targetNameIsUnique: boolean;
};

type LegacyImproverIdentitySource = LegacyImproverIdentity
  | (() => Promise<LegacyImproverIdentity | undefined>);

export function assistantImproverSessionTarget(
  target: AssistantPromptImproverTarget,
): ImproverSessionTargetDto {
  return { targetKind: target.surface, targetId: target.ownerId };
}

export function runImproverSessionTarget(
  target: RunConfigurationImproverTarget,
): ImproverSessionTargetDto {
  return target.configurationId
    ? { targetKind: "runConfiguration", targetId: target.configurationId }
    : { targetKind: "newRunConfiguration", targetId: target.newKind };
}

export function settingsImproverSessionTarget(
  target: SettingsImproverTarget,
): ImproverSessionTargetDto {
  const targetKind = target.kind === "skill"
    ? "settingsSkill"
    : target.kind === "prompt"
      ? "settingsPrompt"
      : "settingsMcpTool";
  return {
    targetKind,
    targetId: target.kind === "prompt" ? target.path : target.id,
  };
}

function sameTarget(
  candidate: ImproverSessionTargetDto | null | undefined,
  target: ImproverSessionTargetDto,
): boolean {
  return candidate?.targetKind === target.targetKind
    && candidate.targetId === target.targetId;
}

/** Finds the newest current Session for one exact improver target. The durable
    target wins. The name/template fallback exists only for Sessions created by
    older builds and is allowed when the target name itself is unambiguous. */
export function previousImproverSession(
  sessions: readonly SessionDto[],
  projectId: string,
  target: ImproverSessionTargetDto,
  legacy?: LegacyImproverIdentity,
): SessionDto | undefined {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (!session) continue;
    if (session.project_id === projectId && sameTarget(session.improver_target, target)) return session;
  }
  if (!legacy?.targetNameIsUnique) return undefined;
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (!session) continue;
    if (session.project_id === projectId
      && session.improver_target == null
      && session.process.template_ref === legacy.templateRef
      && session.name === legacy.sessionName) return session;
  }
  return undefined;
}

function previousDeletedImproverSession(
  deleted: readonly DeletedSessionDto[],
  projectId: string,
  target: ImproverSessionTargetDto,
  legacy?: LegacyImproverIdentity,
): DeletedSessionDto | undefined {
  const newest = (candidates: readonly DeletedSessionDto[]) => [...candidates].sort(
    (left, right) => right.deleted_at_epoch_ms - left.deleted_at_epoch_ms,
  )[0];
  const exact = newest(deleted.filter((item) =>
    item.session.project_id === projectId && sameTarget(item.session.improver_target, target)
  ));
  if (exact) return exact;
  if (!legacy?.targetNameIsUnique) return undefined;
  return newest(deleted.filter((item) => {
    const session = item.session;
    return session.project_id === projectId
      && session.improver_target == null
      && session.process.template_ref === legacy.templateRef
      && session.name === legacy.sessionName;
  }));
}

/** Reuses a live improver or performs the normal inspected Session resume.
    Closing an improver moves it to Deleted, so reopening first restores that
    exact descriptor. A known conversation never degrades silently to a fresh
    launch; the user must choose Start fresh when recovery is impossible. */
export async function resumePreviousImprover(
  api: ImproverResumeApi,
  sessions: readonly SessionDto[],
  projectId: string,
  target: ImproverSessionTargetDto,
  legacy?: LegacyImproverIdentitySource,
): Promise<SessionDto | undefined> {
  let resolvedLegacy: LegacyImproverIdentity | undefined;
  let previous = previousImproverSession(sessions, projectId, target);
  if (!previous && legacy) {
    resolvedLegacy = typeof legacy === "function" ? await legacy() : legacy;
    previous = previousImproverSession(sessions, projectId, target, resolvedLegacy);
  }
  if (!previous) {
    const deleted = previousDeletedImproverSession(
      await api.sessionListDeleted(projectId),
      projectId,
      target,
      resolvedLegacy,
    );
    if (!deleted) return undefined;
    if (deleted.restore_blocker) {
      throw new Error(`The previous improver cannot be restored: ${deleted.restore_blocker}. Use Start fresh to replace it.`);
    }
    previous = await api.sessionRestoreDeleted(deleted.session.id);
  }
  if (isLiveSession(previous)) return previous;
  if (!previous.retryable) {
    throw new Error("The previous improver cannot be resumed. Use Start fresh to replace it.");
  }
  const resumed = await retryAgentSession(api, previous.id);
  if (!isLiveSession(resumed)) {
    throw new Error("The previous improver did not resume. Use Start fresh to replace it.");
  }
  return resumed;
}

/** Makes resume-first an invariant of every improver entry point. Callers may
    customize a fresh launch, but cannot use those launch settings to bypass a
    resumable Session. A fresh Session is created only when no exact target is
    known or the user explicitly asked for a fresh start — the one intent
    allowed to override resume-first, and it must retire the previous current
    Session so a target never has two live improvers. */
export async function resumeImproverOrLaunchFresh(
  api: ImproverResumeApi,
  sessions: readonly SessionDto[],
  projectId: string,
  target: ImproverSessionTargetDto,
  legacy: LegacyImproverIdentitySource | undefined,
  launchFresh: () => Promise<SessionDto>,
  fresh?: { requested: boolean; retire: (previous: SessionDto) => Promise<void> },
): Promise<SessionDto> {
  if (fresh?.requested) {
    let previous = previousImproverSession(sessions, projectId, target);
    if (!previous && legacy) {
      const resolvedLegacy = typeof legacy === "function" ? await legacy() : legacy;
      previous = previousImproverSession(sessions, projectId, target, resolvedLegacy);
    }
    if (previous) await fresh.retire(previous);
    return launchFresh();
  }
  const previous = await resumePreviousImprover(api, sessions, projectId, target, legacy);
  return previous ?? launchFresh();
}
