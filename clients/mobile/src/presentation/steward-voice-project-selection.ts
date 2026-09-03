import type { MobileOverview } from "@/application/ports";
import type { VoicePhase } from "@/presentation/steward-voice-presentation";

export interface VoiceProjectScope {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly overview: MobileOverview | undefined;
}

export interface VoiceProjectTarget {
  readonly id: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly overview: MobileOverview;
}

export function enabledVoiceTargets(scopes: readonly VoiceProjectScope[]): VoiceProjectTarget[] {
  return scopes.flatMap((scope) => {
    if (scope.overview === undefined) return [];
    const overview = scope.overview;
    const enabledProjectIds = new Set(overview.stewardEnabledProjectIds);
    return overview.projects
      .filter((project) => enabledProjectIds.has(project.id))
      .map((project) => ({
        id: voiceTargetId(scope.connectionId, project.id),
        connectionId: scope.connectionId,
        connectionName: scope.connectionName,
        projectId: project.id,
        projectName: project.name,
        overview,
      }));
  });
}

export function canSwitchVoiceProject(phase: VoicePhase): boolean {
  return phase === "ready" || phase === "error";
}

export function switchableVoiceTarget(
  targets: readonly VoiceProjectTarget[],
  currentTargetId: string | undefined,
  requestedTargetId: string,
  phase: VoicePhase,
) {
  if (!canSwitchVoiceProject(phase) || requestedTargetId === currentTargetId) return undefined;
  return targets.find((target) => target.id === requestedTargetId);
}

export function voiceTargetId(connectionId: string, projectId: string): string {
  return `${connectionId}\u0000${projectId}`;
}
