import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { projectShortcutLabel, type KeyboardPlatform } from "../command-surface.js";
import type { Project } from "../model.js";

export type ProjectMenuGroup = { profileId: string; name: string; projects: readonly Project[] };

export function ProjectMenuList(props: {
  /// Projects in the order Cmd+1…Cmd+9 uses; menu groups are slices of it.
  projects: readonly Project[];
  groups: readonly ProjectMenuGroup[];
  showGroups: boolean;
  selectedProjectId: string | undefined;
  platform: KeyboardPlatform;
  select(projectId: string): void;
  /// Raised when a Project is dropped onto another Project's slot.
  reorder(projectId: string, targetId: string): void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const dragEnd = (event: DragEndEvent) => {
    const over = event.over?.id;
    if (typeof over === "string" && over !== event.active.id) props.reorder(String(event.active.id), over);
  };
  const showConnectionProfile = props.projects.some((candidate) => candidate.connectionProfileId !== "local");
  return <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
    <SortableContext items={props.projects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
      <div className="project-menu-list">
        {props.groups.map((group) => (
          <div className="project-source-group" key={group.profileId}>
            {props.showGroups ? <div className="project-source-heading">{group.name}</div> : null}
            {group.projects.map((project) => <SortableProjectMenuItem
              key={project.id}
              project={project}
              selected={project.id === props.selectedProjectId}
              shortcut={projectShortcutLabel(props.projects.findIndex((candidate) => candidate.id === project.id), props.platform)}
              showConnectionProfile={showConnectionProfile}
              select={() => props.select(project.id)}
            />)}
          </div>
        ))}
      </div>
    </SortableContext>
  </DndContext>;
}

function SortableProjectMenuItem(props: {
  project: Project;
  selected: boolean;
  shortcut: string | undefined;
  showConnectionProfile: boolean;
  select(): void;
}) {
  const { project, selected } = props;
  const sortable = useSortable({ id: project.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  // Sortable attributes describe a drag handle; the explicit props after the
  // spread keep this an ordinary focusable menu item for the menu's own keys.
  return <button
    {...sortable.attributes}
    {...sortable.listeners}
    ref={sortable.setNodeRef}
    style={style}
    type="button"
    role="menuitem"
    tabIndex={0}
    aria-roledescription={undefined}
    aria-describedby={undefined}
    className={sortable.isDragging ? "dragging" : undefined}
    aria-current={selected ? "true" : undefined}
    data-connection-state={project.connectionState ?? "connected"}
    data-project-option-id={project.id}
    data-project-selected={selected ? "true" : undefined}
    title="Drag to reorder · Alt+↑/↓ moves"
    onClick={props.select}
  >
    <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
    <span className="project-menu-project-copy">
      <strong>{project.name}</strong>
      {props.showConnectionProfile
        ? <small>{project.connectionProfileName ?? "This computer"}{project.connectionState === "offline" ? " · Offline" : ""}</small>
        : null}
    </span>
    {props.shortcut ? <kbd className="project-shortcut-hint">{props.shortcut}</kbd> : <span aria-hidden="true" />}
    <span className="project-selected-mark" aria-hidden="true">{selected ? "✓" : ""}</span>
  </button>;
}
