import type { RightSidebarView } from "../files-sidebar-preference.js";
import { Icon, type IconName } from "./Icon.js";

const ITEMS: readonly { view: RightSidebarView; label: string; short: string; icon: IconName }[] = [
  { view: "files", label: "Files", short: "Files", icon: "folder" },
  { view: "sourceControl", label: "Source Control", short: "Git", icon: "branch" },
  { view: "steward", label: "Steward", short: "Steward", icon: "sparkles" },
  { view: "agents", label: "Agents", short: "Agents", icon: "agent" },
  { view: "skills", label: "Skills", short: "Skills", icon: "star" },
  { view: "context", label: "Context", short: "Context", icon: "fileText" },
];

export function rightSidebarLabel(view: RightSidebarView): string {
  return ITEMS.find((item) => item.view === view)!.label;
}

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
