import { useCallback } from "react";
import type { ProjectManagerBoardResult } from "@termloop/contract/current";

import {
  useProjectManagerBoard,
  type ProjectManagerProjectActions,
  type ProjectManagerWorkspaceActions,
} from "./ProjectManagerWorkspace.js";

type ProjectManagerShellActions = Pick<
  ProjectManagerWorkspaceActions,
  "openTaskSources" | "openExternal"
>;

/// The Project Manager commands of one Project, with the Shell's own
/// navigation.
export function bindProjectManagerActions(
  pm: ProjectManagerProjectActions,
  projectId: string,
  shell: ProjectManagerShellActions,
): ProjectManagerWorkspaceActions {
  return {
    ...shell,
    loadBoard: () => pm.loadBoard(projectId),
    createSprint: (name, state) => pm.createSprint(projectId, name, state),
    updateSprint: (sprintId, name, state) => pm.updateSprint(projectId, sprintId, name, state),
    deleteSprint: (sprintId) => pm.deleteSprint(projectId, sprintId),
    setTracking: (params) => pm.setTracking(projectId, params),
    createTask: (params) => pm.createTask(projectId, params),
    searchJira: (query) => pm.searchJira(projectId, query),
    saveTicket: (params) => pm.saveTicket(projectId, params),
    loadTicketVersions: (taskId) => pm.loadTicketVersions(projectId, taskId),
    restoreTicket: (taskId, number, expectedVersion) => pm.restoreTicket(projectId, taskId, number, expectedVersion),
    requestCheck: (taskIds) => pm.requestCheck(projectId, taskIds),
    refreshFacts: () => pm.refreshFacts(projectId),
    setEnvironment: (params) => pm.setEnvironment(projectId, params),
    setEnvironments: (environments) => pm.setEnvironments(projectId, environments),
    acceptProposal: (taskId, expectedVersion) => pm.acceptProposal(projectId, taskId, expectedVersion),
    dismissProposal: (taskId) => pm.dismissProposal(projectId, taskId),
    createProbe: (params) => pm.createProbe(projectId, params),
    approveProbe: (probeId) => pm.approveProbe(projectId, probeId),
    deleteProbe: (probeId) => pm.deleteProbe(projectId, probeId),
  };
}

/// The selected Project's board and the commands that replace it with their
/// result. Each command answers with the failure to show, if any.
export function useProjectManagerCommands(
  actions: ProjectManagerWorkspaceActions | undefined,
  reloadKey: unknown,
) {
  const board = useProjectManagerBoard(actions?.loadBoard, reloadKey);
  const setTracking = useCallback(
    (params: Parameters<ProjectManagerWorkspaceActions["setTracking"]>[0]) =>
      actions ? board.apply(() => actions.setTracking(params)) : Promise.resolve(undefined),
    [actions, board.apply],
  );
  const saveTicket = useCallback(
    (params: Parameters<ProjectManagerWorkspaceActions["saveTicket"]>[0]) =>
      actions
        ? board.apply(async () => (await actions.saveTicket(params)).board)
        : Promise.resolve(undefined),
    [actions, board.apply],
  );
  const restoreTicket = useCallback(
    (taskId: string, number: number, expectedVersion: number | null) =>
      actions
        ? board.apply(async () => (await actions.restoreTicket(taskId, number, expectedVersion)).board)
        : Promise.resolve(undefined),
    [actions, board.apply],
  );
  const boardCommand = useCallback(
    (operation: (actions: ProjectManagerWorkspaceActions) => Promise<ProjectManagerBoardResult>) =>
      actions ? board.apply(() => operation(actions)) : Promise.resolve(undefined),
    [actions, board.apply],
  );
  /// Starts a delivery check and takes the board that now shows it running.
  const requestCheck = useCallback(
    (taskIds: string[] | null) => boardCommand(async (bound) => {
      const result = await bound.requestCheck(taskIds);
      if (result.status === "alreadyRunning") throw new Error("A running delivery check already covers these Tasks.");
      return bound.loadBoard();
    }),
    [boardCommand],
  );
  return { board, setTracking, saveTicket, restoreTicket, boardCommand, requestCheck };
}
