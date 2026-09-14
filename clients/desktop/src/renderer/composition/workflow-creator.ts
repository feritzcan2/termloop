import type { SessionDto, WorkflowTemplateDraft } from "@termloop/contract/current";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import type { SourceDesktopApi } from "../transport/desktop-api.js";
import { resumeImproverOrLaunchFresh } from "./improver-resume.js";

export type WorkflowCreatorTarget = {
  workflowId: string | null;
  taskId: string | null;
  draft: WorkflowTemplateDraft | null;
};

export async function openWorkflowCreator(
  api: SourceDesktopApi,
  sessions: readonly SessionDto[],
  projectId: string,
  target: WorkflowCreatorTarget,
  selection: QuickActionAgentSelection,
  retire: (sessionId: string) => Promise<void>,
  options?: { fresh?: boolean },
): Promise<SessionDto> {
  return resumeImproverOrLaunchFresh(api, sessions, projectId,
    { targetKind: "workflowDraft", targetId: target.workflowId }, undefined,
    async () => {
      const params = { projectId, ...target, ...selection, templateRef: "builtin.builder.workflow" as const };
      const preview = await api.workflowCreatorPreview(params);
      return api.workflowCreatorLaunch({ ...params, launchTicket: preview.launch_ticket });
    }, options?.fresh ? { requested: true, retire: (previous) => retire(previous.id) } : undefined);
}
