import type { PresentationState } from "../state/presentation-store.js";

type ProjectSelection = Pick<PresentationState, "selectProject" | "selectedSessionByProject">;

export function selectProjectWithTerminalFocus(
  presentation: ProjectSelection,
  projectId: string,
  focusTerminal: (sessionId: string) => void,
): void {
  presentation.selectProject(projectId);
  const sessionId = presentation.selectedSessionByProject[projectId];
  if (sessionId) focusTerminal(sessionId);
}
