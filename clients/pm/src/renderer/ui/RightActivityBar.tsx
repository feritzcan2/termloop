import { Icon, type IconName } from "./icons.js";
import type { RightSidebarView } from "./types.js";

type Item = { view: RightSidebarView; label: string; short: string; icon: IconName };

const ITEMS: readonly Item[] = [
  { view: "steward", label: "Steward", short: "Steward", icon: "agent" },
  { view: "suggestions", label: "Suggestions", short: "Inbox", icon: "inbox" },
];

export function rightSidebarLabel(view: RightSidebarView): string {
  return ITEMS.find((item) => item.view === view)!.label;
}

/**
 * Always visible at the window's right edge: the helpers that sit beside the
 * stage. Choosing the open view closes the panel; choosing another switches
 * it. `badges` marks a view that has something waiting.
 */
export function RightActivityBar(props: { open: boolean; view: RightSidebarView; badges?: Partial<Record<RightSidebarView, number>>; onSelect(view: RightSidebarView): void }) {
  return (
    <nav className="activity-bar" aria-label="Right sidebar">
      {ITEMS.map((item) => {
        const selected = props.open && props.view === item.view;
        const badge = props.badges?.[item.view] ?? 0;
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
            {badge > 0 && <b className="activity-badge">{badge > 99 ? "99+" : badge}</b>}
          </button>
        );
      })}
    </nav>
  );
}
