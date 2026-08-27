import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import type { ProjectWorktreeSummary } from "../model.js";
import { taskChangeLabel } from "../task-presentation.js";

/// The Project checkout's own place in the sidebar. It holds the Project name,
/// states how many uncommitted changes that checkout carries, and is the drop
/// target that moves an Agent out of a Task worktree and back into the Project
/// checkout.
///
/// Both facts used to hang off the Tasks view's loose-Agent header. They were
/// never about that list: the changes belong to the Project checkout and the
/// drop target names a destination, not a rail. Here they stay reachable from
/// every view instead of only the one that happened to host them.
export function ProjectCheckoutHeader({ changes, children }: {
  /// Absent while no Project is selected: there is no checkout to review.
  changes?: { summary: ProjectWorktreeSummary | undefined; open(): void } | undefined;
  children: ReactNode;
}) {
  const drop = useDroppable({ id: "project:checkout", data: { kind: "project" } });
  return (
    <section
      ref={drop.setNodeRef}
      className={`project-switcher${drop.isOver ? " session-drop-target" : ""}`}
      aria-labelledby="project-label"
      data-session-drop-target="project-root"
    >
      <div className="project-switcher-head">
        <span id="project-label" className="project-label">Project</span>
        {changes ? projectChangeSummary(changes.summary, changes.open) : null}
      </div>
      {children}
    </section>
  );
}

export function projectChangeSummary(
  summary: ProjectWorktreeSummary | undefined,
  openChanges: () => void,
): ReactNode {
  const label = summary && summary.change_count > 0
    ? taskChangeLabel(summary.change_count)
    : "Changes";
  const reviewLabel = summary && summary.change_count > 0 ? label : "changes";
  const branch = summary?.checked_out_branch ? ` on ${summary.checked_out_branch}` : " in the Project checkout";
  return (
    <button
      type="button"
      className="project-change-summary"
      title={`Review ${reviewLabel}${branch}`}
      aria-label={`Review ${reviewLabel}${branch}`}
      onClick={openChanges}
    >{label}</button>
  );
}
