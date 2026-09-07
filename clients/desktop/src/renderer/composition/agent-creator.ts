import type { SessionDto } from "@termloop/contract/current";
import type { QuickActionAgentSelection } from "../quick-action-memory.js";
import type { SourceDesktopApi } from "../transport/desktop-api.js";
import { resumeImproverOrLaunchFresh } from "./improver-resume.js";

export async function openAgentCreator(
  api: SourceDesktopApi,
  sessions: readonly SessionDto[],
  projectId: string,
  selection: QuickActionAgentSelection,
  retire: (sessionId: string) => Promise<void>,
  options?: { fresh?: boolean },
): Promise<SessionDto> {
  return resumeImproverOrLaunchFresh(
    api, sessions, projectId, { targetKind: "agentCreator", targetId: null }, undefined,
    async () => {
      const params = { projectId, ...selection, templateRef: "builtin.builder.agent" as const };
      const preview = await api.agentCreatorPreview(params);
      return api.agentCreatorLaunch({ ...params, launchTicket: preview.launch_ticket });
    },
    options?.fresh ? { requested: true, retire: (previous) => retire(previous.id) } : undefined,
  );
}
