import type { CompanionProposedActionDto } from "@termloop/contract/current";

const ACTION_TITLES: Readonly<Record<string, string>> = {
  taskClose: "Close task",
  taskReopen: "Reopen task",
  taskDelete: "Delete task",
  taskCreate: "Create task",
  taskRename: "Rename task",
  taskUpdateBrief: "Update task brief",
  taskSetJiraUrl: "Link Jira issue",
  taskAgentStart: "Start task agent",
  agentMessageSend: "Message agent",
  stewardSystemPromptUpdate: "Update Steward instructions",
};

export type StewardProposedActionView = Readonly<{ title: string; evidence: readonly string[] }>;

/** The fixed title and evidence for a Steward proposal or suggestion's typed
    action. Null for `other`, a missing action, or a kind this build does not
    know, so the bubble shows only the Steward's own text. */
export function stewardProposedActionView(
  action: CompanionProposedActionDto | undefined,
): StewardProposedActionView | null {
  const title = action ? ACTION_TITLES[action.kind] : undefined;
  return title ? { title, evidence: action?.evidence ?? [] } : null;
}
