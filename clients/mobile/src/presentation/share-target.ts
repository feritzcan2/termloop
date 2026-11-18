import type { ProjectDto, TaskDto } from "@termloop/contract/current";

import type { ConnectionAvailability } from "../application/ports";
import { launchBlockedReason } from "./agent-launch-presentation";
import { connectionPresentation } from "./connection-presentation";

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

export interface ShareMac {
  readonly connectionId: string;
  readonly name: string;
  /// ready: its Projects are listed; loading: a read is still on its way;
  /// unavailable: offline, revoked, or unreadable, so nothing can start there.
  readonly state: "ready" | "loading" | "unavailable";
  readonly targets: readonly ShareProjectTarget[];
}

/// Every paired Mac, not only the selected one: a screenshot can go to any
/// Project the phone can currently reach. Reachable Macs come first and keep
/// their pairing order; a Mac that cannot take a launch stays visible but inert.
export function shareMacs(
  connections: readonly { id: string; name: string; availability: ConnectionAvailability }[],
  snapshots: ReadonlyMap<string, { load: string; overview: { projects: readonly ProjectDto[]; tasks: readonly TaskDto[] } | undefined }>,
): ShareMac[] {
  const rank = { ready: 0, loading: 1, unavailable: 2 } as const;
  return connections
    .map((connection): ShareMac => {
      const snapshot = snapshots.get(connection.id);
      const reachable = connectionPresentation(connection.availability).block === undefined;
      /// Only a Mac that is online right now is worth waiting for; one still
      /// reconnecting or whose read failed is listed as unreachable instead of
      /// holding a spinner above the Macs that can take the screenshot.
      const state = !reachable ? "unavailable"
        : snapshot?.overview !== undefined ? "ready"
          : connection.availability === "online" && snapshot?.load !== "failed" ? "loading" : "unavailable";
      return {
        connectionId: connection.id,
        name: connection.name,
        state,
        targets: state === "ready" ? shareTargets(snapshot!.overview!.projects, snapshot!.overview!.tasks) : [],
      };
    })
    .map((mac, index) => ({ mac, index }))
    .sort((left, right) => rank[left.mac.state] - rank[right.mac.state] || left.index - right.index)
    .map(({ mac }) => mac);
}
