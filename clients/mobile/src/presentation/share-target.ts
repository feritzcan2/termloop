import type { ProjectDto, TaskDto } from "@termloop/contract/current";

import { launchBlockedReason } from "./agent-launch-presentation";

/// Where a shared screenshot can start an agent: a Project itself, or one of its
/// open Tasks whose worktree the Mac has already proven launch-ready. Tasks the
/// launch screen would refuse are left out instead of offered and then blocked.
export interface ShareProjectTarget {
  readonly project: ProjectDto;
  readonly tasks: readonly TaskDto[];
}

export function shareTargets(projects: readonly ProjectDto[], tasks: readonly TaskDto[]): ShareProjectTarget[] {
  return [...projects]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((project) => ({
      project,
      tasks: tasks
        .filter((task) => task.project_id === project.id && task.archived_at_epoch_ms === null && launchBlockedReason(task) === undefined)
        .sort((left, right) => left.title.localeCompare(right.title)),
    }));
}

/// The launch route's existing target encoding: a Task id, or a Project prefixed.
export function shareLaunchTarget(selection: { projectId: string; taskId?: string | undefined }): string {
  return selection.taskId ?? `project:${selection.projectId}`;
}

/// A shared screenshot is sent on its own only once the Agent is waiting at its
/// prompt; while it is still starting, working, or unknown, typing into it could
/// interleave with its startup output or be swallowed.
export function sharedImageReadyToSend(canSend: boolean, agentStatus: string | undefined): boolean {
  return canSend && (agentStatus === "idle" || agentStatus === "awaitingInput");
}
