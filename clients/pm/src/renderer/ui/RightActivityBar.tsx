import { Icon, type IconName } from "./icons.js";
import type { RightSidebarView } from "./types.js";

type Item = { view: RightSidebarView; label: string; short: string; icon: IconName };

const ITEMS: readonly Item[] = [
  { view: "sprints", label: "Sprints", short: "Sprints", icon: "flag" },
  { view: "suggestions", label: "Suggestions", short: "Inbox", icon: "inbox" },
  { view: "skills", label: "Skills", short: "Skills", icon: "skill" },
];

/** Kept at the bottom of the bar, apart from the work views. */
const SETTINGS: Item = { view: "settings", label: "Settings", short: "Settings", icon: "gear" };

export function rightSidebarLabel(view: RightSidebarView): string {
  return [...ITEMS, SETTINGS].find((item) => item.view === view)!.label;
}

/** The Jira item: it switches the stage, not the right panel; disabled without a Jira source. */
export type JiraActivity = { available: boolean; active: boolean; onToggle(): void };

/**
 * Always visible at the window's right edge, like the TermLoop desktop
 * activity bar. Choosing the open view closes the panel; choosing another
 * switches it.
 */
export function RightActivityBar(props: { open: boolean; view: RightSidebarView; onSelect(view: RightSidebarView): void; jira?: JiraActivity }) {
  const jira = props.jira;
  const button = (item: Item, className?: string) => {
    const selected = props.open && props.view === item.view;
    return (
      <button
        key={item.view}
        type="button"
        aria-label={`${item.label} sidebar`}
        aria-pressed={selected}
        className={[selected ? "selected" : "", className ?? ""].join(" ").trim() || undefined}
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
      {jira && (
        <button
          type="button"
          aria-label="Jira issues"
          aria-pressed={jira.active}
          className={jira.active ? "selected" : undefined}
          disabled={!jira.available && !jira.active}
          title={!jira.available ? "Connect Jira in Settings" : jira.active ? "Hide Jira issues" : "Show Jira issues"}
          onClick={jira.onToggle}
        >
          <Icon name="jira" /><span>Jira</span>
        </button>
      )}
      {button(SETTINGS, "bottom")}
    </nav>
  );
}
