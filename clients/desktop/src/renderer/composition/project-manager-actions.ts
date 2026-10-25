import type {
  ProjectEnvironmentDto,
  ProjectManagerEnvironmentSetParams,
  ProjectManagerProbeCreateParams,
  ProjectManagerTaskCreateParams,
  ProjectManagerTaskTrackingSetParams,
  ProjectManagerTicketSaveParams,
  SprintState,
} from "@termloop/contract/current";

import type { SourceDesktopApi } from "../transport/desktop-api.js";
import type { ProjectManagerProjectActions } from "../ui/ProjectManagerWorkspace.js";

type ProjectManagerActionInputs = {
  /// The source API that owns a Project.
  readonly api: (projectId: string) => SourceDesktopApi;
  /// Maps a control failure to the error the UI shows.
  readonly guard: <T>(operation: Promise<T>) => Promise<T>;
  /// Refreshes the Task projection after a command that changes Tasks.
  readonly refresh: () => Promise<void>;
};

/** Every Project Manager command, addressed by Project. */
export function createProjectManagerActions({ api, guard, refresh }: ProjectManagerActionInputs): ProjectManagerProjectActions {
  return {
    loadBoard: (projectId: string) => guard(api(projectId).projectManagerBoardGet(projectId)),
    createSprint: (projectId: string, name: string, state?: SprintState) =>
      guard(api(projectId).projectManagerSprintCreate({ projectId, name, ...(state ? { state } : {}) })),
    updateSprint: (projectId: string, sprintId: string, name: string, state: SprintState) =>
      guard(api(projectId).projectManagerSprintUpdate({ sprintId, name, state })),
    deleteSprint: (projectId: string, sprintId: string) =>
      guard(api(projectId).projectManagerSprintDelete(sprintId)),
    setTracking: (projectId: string, params: ProjectManagerTaskTrackingSetParams) =>
      guard(api(projectId).projectManagerTaskTrackingSet(params)),
    createTask: async (projectId: string, params: Omit<ProjectManagerTaskCreateParams, "projectId">) => {
      const result = await guard(api(projectId).projectManagerTaskCreate({ projectId, ...params }));
      await refresh();
      return result;
    },
    searchJira: (projectId: string, query: string) =>
      guard(api(projectId).projectManagerJiraSearch({ projectId, query })),
    saveTicket: async (projectId: string, params: ProjectManagerTicketSaveParams) => {
      const result = await guard(api(projectId).projectManagerTicketSave(params));
      await refresh();
      return result;
    },
    loadTicketVersions: (projectId: string, taskId: string) =>
      guard(api(projectId).projectManagerTicketVersions(taskId)),
    restoreTicket: async (projectId: string, taskId: string, number: number, expectedVersion: number | null) => {
      const result = await guard(api(projectId).projectManagerTicketRestore({ taskId, number, expectedVersion }));
      await refresh();
      return result;
    },
    requestCheck: (projectId: string, taskIds: string[] | null) =>
      guard(api(projectId).projectManagerCheckRequest({ projectId, taskIds })),
    refreshFacts: (projectId: string) =>
      guard(api(projectId).projectManagerFactsRefresh(projectId)),
    setEnvironment: (projectId: string, params: ProjectManagerEnvironmentSetParams) =>
      guard(api(projectId).projectManagerEnvironmentSet(params)),
    setEnvironments: (projectId: string, environments: ProjectEnvironmentDto[]) =>
      guard(api(projectId).projectManagerEnvironmentsSet({ projectId, environments })),
    readJiraIssue: (projectId: string, taskId: string) =>
      guard(api(projectId).projectManagerJiraIssueRead({ projectId, taskId })),
    pushJiraIssue: (projectId: string, taskId: string, expectedTicketVersion: number, expectedJiraUpdated: string) =>
      guard(api(projectId).projectManagerJiraIssuePush({ projectId, taskId, expectedTicketVersion, expectedJiraUpdated })),
    moveJiraSprint: (projectId: string, taskId: string, sprintId: string | null) =>
      guard(api(projectId).projectManagerJiraSprintMove({ projectId, taskId, sprintId })),
    acceptProposal: async (projectId: string, taskId: string, expectedVersion: number | null) => {
      const result = await guard(api(projectId).projectManagerProposalAccept({ taskId, expectedVersion }));
      await refresh();
      return result;
    },
    dismissProposal: (projectId: string, taskId: string) =>
      guard(api(projectId).projectManagerProposalDismiss(taskId)),
    createProbe: (projectId: string, params: Omit<ProjectManagerProbeCreateParams, "projectId">) =>
      guard(api(projectId).projectManagerProbeCreate({ projectId, ...params })),
    approveProbe: (projectId: string, probeId: string) =>
      guard(api(projectId).projectManagerProbeApprove(probeId)),
    deleteProbe: (projectId: string, probeId: string) =>
      guard(api(projectId).projectManagerProbeDelete(probeId)),
  };
}
