import type { SourceDesktopApi } from "../transport/desktop-api.js";
import type { Session } from "../model.js";
import type { StewardPanelProps } from "../ui/StewardPanel.js";
import {
  AssistantReadCoordinator,
  type AssistantReadIdentity,
} from "./assistant-read-coordinator.js";
import { restartStewardSession, restartWorkerSession } from "./worker-restart.js";

type AssistantActionInputs = {
  readonly api: SourceDesktopApi;
  readonly coordinator: AssistantReadCoordinator;
  readonly identity: AssistantReadIdentity;
  readonly projectId: string;
  readonly promptImprovement: StewardPanelProps["promptImprovement"];
  readonly sessions: () => readonly Session[];
};

/** Wires every assistant surface to one Project/computer read owner. */
export function createAssistantActions({
  api,
  coordinator,
  identity,
  projectId,
  promptImprovement,
  sessions,
}: AssistantActionInputs) {
  return {
    getConfiguration: () => coordinator.read(
      identity,
      "steward.configurationGet",
      () => api.stewardConfigurationGet(projectId),
    ),
    // Presence reflects live PTY activity and deliberately bypasses the durable
    // projection cache used by the mounted assistant surfaces.
    getPresence: () => api.stewardConfigurationGet(projectId),
    setConfiguration: coordinator.wrapMutation(identity, (
      agentId: "claude" | "codex",
      model: string,
      permission: "default" | "acceptEdits" | "plan" | "bypassPermissions",
      reasoning: "default" | "low" | "medium" | "high" | "xhigh" | "max",
      enabled: boolean,
      systemPrompt: string,
      expectedRevision: number,
    ) => api.stewardConfigurationSet({
      projectId,
      agentId,
      model,
      permission,
      reasoning,
      enabled,
      systemPrompt,
      expectedRevision,
    })),
    deleteConfiguration: coordinator.wrapMutation(identity, (expectedRevision: number) =>
      api.stewardConfigurationDelete({ projectId, expectedRevision })),
    listTranscript: (beforeSequence?: number) => coordinator.read(
      identity,
      `companion.transcriptList:${beforeSequence ?? "latest"}`,
      () => api.companionTranscriptList({
        projectId,
        limit: 100,
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
      }),
    ),
    appendMessage: coordinator.wrapMutation(identity, (content: string) =>
      api.companionTranscriptAppend({ projectId, content })),
    respondToProposal: coordinator.wrapMutation(identity, (
      proposalMessageId: string,
      decision: "approve" | "decline",
    ) => api.companionProposalRespond({ projectId, proposalMessageId, decision })),
    acceptSuggestion: coordinator.wrapMutation(identity, (suggestionMessageId: string) =>
      api.companionSuggestionAccept({ projectId, suggestionMessageId })),
    clearTranscript: coordinator.wrapMutation(identity, (expectedRevision: number) =>
      api.companionTranscriptClear({ projectId, expectedRevision })),
    listWorkers: () => coordinator.read(
      identity,
      "worker.configurationList",
      () => api.workerConfigurationList({ projectId }),
    ),
    createWorker: coordinator.wrapMutation(identity, api.workerConfigurationCreate),
    updateWorker: coordinator.wrapMutation(identity, api.workerConfigurationUpdate),
    deleteWorker: coordinator.wrapMutation(identity, (workerId: string, expectedRevision: number) =>
      api.workerConfigurationDelete({ workerId, expectedRevision })),
    listRoutines: () => coordinator.read(
      identity,
      "routine.configurationList",
      () => api.routineConfigurationList({ projectId }),
    ),
    createRoutine: coordinator.wrapMutation(identity, api.routineConfigurationCreate),
    updateRoutine: coordinator.wrapMutation(identity, api.routineConfigurationUpdate),
    updateRoutineContext: coordinator.wrapMutation(identity, (
      routineId: string,
      contextMarkdown: string,
      expectedContextRevision: number,
      expectedRevision: number,
    ) => api.routineContextUpdate({
      routineId,
      contextMarkdown,
      expectedContextRevision,
      expectedRevision,
    })),
    deleteRoutine: coordinator.wrapMutation(identity, (routineId: string, expectedRevision: number) =>
      api.routineConfigurationDelete({ routineId, expectedRevision })),
    listRoutineRuntime: () => coordinator.read(
      identity,
      "routine.runtimeList",
      () => api.routineRuntimeList({ projectId }),
    ),
    runRoutineNow: coordinator.wrapMutation(identity, (routineId: string, taskId?: string) =>
      api.routineRunNow({ routineId, ...(taskId ? { taskId } : {}) })),
    getPlaybook: () => coordinator.read(
      identity,
      "playbook.get",
      () => api.playbookGet(projectId),
    ),
    getPlaybookRuntime: () => coordinator.read(
      identity,
      "playbook.runtime",
      () => api.playbookRuntime(projectId),
    ),
    setPlaybookTaskPosition: coordinator.wrapMutation(identity, api.playbookTaskPositionSet),
    updatePlaybook: coordinator.wrapMutation(identity, api.playbookUpdate),
    promptImprovement,
    restartSteward: coordinator.wrapMutation(identity, () =>
      restartStewardSession(api, projectId, sessions())),
    restartWorker: coordinator.wrapMutation(identity, (workerId: string) =>
      restartWorkerSession(api, projectId, workerId, sessions())),
  };
}
