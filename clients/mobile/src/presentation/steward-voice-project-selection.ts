import type { MobileOverview } from "@/application/ports";
import type { VoicePhase } from "@/presentation/steward-voice-presentation";

export function enabledVoiceProjects(
  overview: MobileOverview | undefined,
): MobileOverview["projects"] {
  if (overview === undefined) return [];
  const enabledProjectIds = new Set(overview.stewardEnabledProjectIds);
  return overview.projects.filter((project) => enabledProjectIds.has(project.id));
}

export function canSwitchVoiceProject(phase: VoicePhase): boolean {
  return ["ready", "thinking", "reconnecting", "offline", "error"].includes(phase);
}

export function switchableVoiceProject(
  projects: MobileOverview["projects"],
  currentProjectId: string | undefined,
  requestedProjectId: string,
  phase: VoicePhase,
) {
  if (!canSwitchVoiceProject(phase) || requestedProjectId === currentProjectId) return undefined;
  return projects.find((project) => project.id === requestedProjectId);
}
