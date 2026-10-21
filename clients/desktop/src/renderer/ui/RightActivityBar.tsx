import type { RightSidebarView } from "../files-sidebar-preference.js";
import { Icon, type IconName } from "./Icon.js";

const ITEMS: readonly { view: RightSidebarView; label: string; short: string; icon: IconName }[] = [
  { view: "files", label: "Files", short: "Files", icon: "folder" },
  { view: "sourceControl", label: "Source Control", short: "Git", icon: "branch" },
  { view: "steward", label: "Steward", short: "Steward", icon: "sparkles" },
];

/// Always visible at the window's right edge, like Orca's activity bar.
/// Choosing the open view closes the sidebar; choosing another switches it.
export function RightActivityBar({ open, view, select }: { open: boolean; view: RightSidebarView; select(view: RightSidebarView): void }) {
  return <nav className="files-activity-bar" aria-label="Right sidebar">
    {ITEMS.map((item) => {
      const selected = open && view === item.view;
      return <button key={item.view} type="button" aria-label={`${item.label} sidebar`} aria-pressed={selected}
        className={selected ? "selected" : undefined} title={selected ? `Hide ${item.label}` : `Show ${item.label}`}
        onClick={() => select(item.view)}
      ><Icon name={item.icon} /><span>{item.short}</span></button>;
    })}
  </nav>;
}
