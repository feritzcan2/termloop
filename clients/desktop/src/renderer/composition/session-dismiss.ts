import type { Session } from "../model.js";
import { sessionDismissCommand } from "../model.js";
import type { DesktopApi } from "../transport/desktop-api.js";

type SessionDismissApi = Pick<DesktopApi, "sessionClose" | "sessionTerminate">;

/// A rail close is one user intent even though the control contract separates
/// termination from descriptor retirement. Core retains Agent descriptors in
/// Deleted for 30 days; Terminal descriptors keep their existing hard-close
/// behavior.
export async function dismissSessionDescriptor(
  api: SessionDismissApi,
  session: Session,
): Promise<void> {
  const command = sessionDismissCommand(session);
  if (!command) return;
  if (command === "terminate") {
    const outcome = await api.sessionTerminate(session.id);
    if (!outcome.ok) throw new Error(outcome.message);
  }
  await api.sessionClose(session.id);
}
