import type { ReactNode } from "react";

/// Keeps a peer workspace rail mounted while another peer is visible. The
/// daemon projection continues to update the hidden tree, so returning to it
/// reveals the latest in-memory state without replaying the rail's first mount.
export function WorkspaceRailCache({ visible, children }: {
  visible: boolean;
  children: ReactNode;
}) {
  return <div className="workspace-rail-cache" hidden={!visible}>{children}</div>;
}
