import type { CompanionMessageDto, CompanionProposedActionDto } from "@termloop/contract/current";
import "./proposed-action.css";

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

/** The fixed title for a Steward proposal or suggestion's typed action. Null
    for `other`, a missing action, or a kind this build does not know, so the
    caller falls back to the Steward's own text. */
export function proposedActionTitle(action: CompanionProposedActionDto | undefined): string | null {
  return action ? ACTION_TITLES[action.kind] ?? null : null;
}

/** One line for compact surfaces: the fixed title and its evidence, or the
    Steward's text when the message names no known action. */
export function proposedActionLine(message: Pick<CompanionMessageDto, "action" | "content">): string {
  const title = proposedActionTitle(message.action);
  if (!title) return message.content;
  return [title, ...(message.action?.evidence ?? [])].join(" · ");
}

/** The typed decision: a fixed title and short evidence chips. Renders
    nothing when the message names no known action. */
export function ProposedActionSummary(props: { action: CompanionProposedActionDto | undefined }) {
  const title = proposedActionTitle(props.action);
  if (!title) return null;
  const evidence = props.action?.evidence ?? [];
  return <div className="proposed-action">
    <strong className="proposed-action-title">{title}</strong>
    {evidence.length > 0 ? <ul className="proposed-action-evidence" aria-label="Evidence">
      {evidence.map((item, index) => <li key={index}>{item}</li>)}
    </ul> : null}
  </div>;
}
