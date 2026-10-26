import { Icon, type IconName } from "./icons.js";
import type { RightSidebarView } from "./types.js";

type Item = { view: RightSidebarView; label: string; short: string; icon: IconName };

const ITEMS: readonly Item[] = [
  { view: "sprints", label: "Sprints", short: "Sprints", icon: "flag" },
  { view: "epics", label: "Epics", short: "Epics", icon: "epic" },
  { view: "playbook", label: "Playbook", short: "Playbook", icon: "playbook" },
  { view: "suggestions", label: "Suggestions", short: "Inbox", icon: "inbox" },
  { view: "skills", label: "Skills", short: "Skills", icon: "skill" },
];

export function rightSidebarLabel(view: RightSidebarView): string {
  return ITEMS.find((item) => item.view === view)!.label;
}

/** The Jira item: it switches the stage, not the right panel; disabled without a Jira source. */
export type JiraActivity = StageActivity & { available: boolean };

/** A stage item's state: whether its view fills the stage, and how to toggle it. */
export type StageActivity = { active: boolean; onToggle(): void };

/** A stage item: it switches the stage, not the right panel. */
function stageButton(item: { label: string; short: string; icon: IconName; activity: StageActivity; disabled?: boolean; idleTitle?: string | undefined; className?: string }) {
  const { active, onToggle } = item.activity;
  return (
    <button
      type="button"
      aria-label={item.label}
      aria-pressed={active}
      className={[active ? "selected" : "", item.className ?? ""].join(" ").trim() || undefined}
      disabled={item.disabled}
      title={item.idleTitle ?? `${active ? "Hide" : "Show"} ${item.label}`}
      onClick={onToggle}
    >
      <Icon name={item.icon} /><span>{item.short}</span>
    </button>
  );
}

/**
 * Always visible at the window's right edge, like the TermLoop desktop
 * activity bar. Choosing the open view closes the panel; choosing another
 * switches it.
 */
export function RightActivityBar(props: { open: boolean; view: RightSidebarView; onSelect(view: RightSidebarView): void; jira?: JiraActivity; settings?: StageActivity }) {
  const { jira, settings } = props;
  const button = (item: Item) => {
    const selected = props.open && props.view === item.view;
    return (
      <button
        key={item.view}
        type="button"
        aria-label={`${item.label} sidebar`}
        aria-pressed={selected}
        className={selected ? "selected" : undefined}
        title={selected ? `Hide ${item.label}` : `Show ${item.label}`}
        onClick={() => props.onSelect(item.view)}
      >
        <Icon name={item.icon} /><span>{item.short}</span>
      </button>
    );
  };
  return (
    <nav className="activity-bar" aria-label="Right sidebar">
      {ITEMS.map((item) => button(item))}
      {jira && stageButton({ label: "Jira issues", short: "Jira", icon: "jira", activity: jira, disabled: !jira.available && !jira.active, idleTitle: jira.available ? undefined : "Connect Jira in Settings" })}
      {settings && stageButton({ label: "Settings", short: "Settings", icon: "gear", activity: settings, className: "bottom" })}
    </nav>
  );
}
