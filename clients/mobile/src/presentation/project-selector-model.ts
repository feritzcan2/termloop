import type { ConnectionProfile } from "../application/ports";
import type { LocatedProjectSummary } from "./attention-overview";

export interface ProjectSelectorGroup {
  readonly connection: ConnectionProfile;
  readonly projects: readonly LocatedProjectSummary[];
}

/// Every saved Mac owns one selector section even when it is offline or has no
/// cached Project projection. Flattening only Projects made a paired computer
/// disappear precisely when its connection needed to be visible.
export function projectSelectorGroups(
  connections: readonly ConnectionProfile[],
  projects: readonly LocatedProjectSummary[],
): readonly ProjectSelectorGroup[] {
  return connections.map((connection) => ({
    connection,
    projects: projects.filter((project) => project.connection.id === connection.id),
  }));
}
