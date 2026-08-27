import { useCallback, useState } from "react";

/// Collapse state for a rail's named groups. Only the groups the user actually
/// toggled are remembered, so a rail can keep changing which groups start open
/// (a search result, a newly discovered plugin) without fighting stored state.
export function useRailGroups(): {
  collapsed(key: string, collapsedByDefault: boolean): boolean;
  toggle(key: string): void;
} {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);
  const collapsed = useCallback(
    (key: string, collapsedByDefault: boolean) => toggled.has(key) ? !collapsedByDefault : collapsedByDefault,
    [toggled],
  );
  return { collapsed, toggle };
}
