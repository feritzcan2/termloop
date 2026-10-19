import { useCallback, useEffect, useState } from "react";

/// Overlay visibility is reported as leases: a consumer reports `true` once
/// when its overlay opens and `false` exactly once when that same overlay
/// closes or unmounts. Several consumers share one reporter, so a closed
/// consumer must stay silent; otherwise a newly mounted sibling would clear
/// another sibling's open dialog and let the native terminal cover it.
export function useOverlayLease(visible: boolean, report: (visible: boolean) => void): void {
  useEffect(() => {
    if (!visible) return;
    report(true);
    return () => report(false);
  }, [report, visible]);
}

/// Counts the leases reported by every consumer sharing `report`; the overlay
/// is open while at least one lease is held.
export function useOverlayLeaseCount(): [open: boolean, report: (visible: boolean) => void] {
  const [count, setCount] = useState(0);
  const report = useCallback((visible: boolean) => {
    setCount((current) => Math.max(0, current + (visible ? 1 : -1)));
  }, []);
  return [count > 0, report];
}
