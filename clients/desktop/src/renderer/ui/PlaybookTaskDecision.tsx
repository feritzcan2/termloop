import { useEffect, useRef, useState } from "react";
import type {
  CompanionMessageDto, CompanionProposalDecision, CompanionProposalRespondResult,
  CompanionSuggestionAcceptResult, CompanionTranscriptListResult, RoutineConfigurationDto,
} from "@termloop/contract/current";
import { currentStewardInteraction } from "./companion-chat.js";
import "./playbook-task-decision.css";

/** The one Steward question Core still accepts an answer for, with every Task
    it covers. Core keeps a single open interaction per Project, so a Steward
    that batches several Playbook findings asks once for all of their Tasks;
    each covered Task row shows that same decision. */
export type PlaybookTaskDecision = Readonly<{
  taskIds: readonly string[];
  kind: "proposal" | "suggestion";
  message: CompanionMessageDto;
}>;

/** Maps a pending Playbook finding to the Tasks Core recorded for it. */
export type RoutineFindingTasks = (findingId: string) => readonly string[];

export function routineFindingTasks(routines: readonly RoutineConfigurationDto[]): RoutineFindingTasks {
  const byFinding = new Map(routines.flatMap((routine) => routine.pendingRoutineFindings
    .map((finding) => [finding.id, finding.relatedTaskIds] as const)));
  return (findingId) => byFinding.get(findingId) ?? [];
}

export function pendingPlaybookTaskDecision(
  messages: readonly CompanionMessageDto[],
  findingTasks: RoutineFindingTasks = () => [],
): PlaybookTaskDecision | null {
  const interaction = currentStewardInteraction(messages);
  if (!interaction || (interaction.kind !== "proposal" && interaction.kind !== "suggestion")) return null;
  const refs = interaction.refs;
  const findingIds = [...(refs?.routineFindingId ? [refs.routineFindingId] : []), ...(refs?.routineFindingIds ?? [])];
  const taskIds = [...new Set([
    ...(refs?.taskId ? [refs.taskId] : []),
    ...findingIds.flatMap(findingTasks),
  ])];
  if (taskIds.length === 0) return null;
  return { taskIds, kind: interaction.kind, message: interaction };
}

export type PlaybookTaskDecisionActions = Readonly<{
  listTranscript(): Promise<CompanionTranscriptListResult>;
  respondToProposal(proposalMessageId: string, decision: CompanionProposalDecision): Promise<CompanionProposalRespondResult>;
  acceptSuggestion(suggestionMessageId: string): Promise<CompanionSuggestionAcceptResult>;
}>;

export type PlaybookTaskDecisionHandle = Readonly<{
  decision: PlaybookTaskDecision;
  respond(decision: CompanionProposalDecision): Promise<void>;
  accept(): Promise<void>;
}>;

/** Reads the Steward transcript on the same coalesced projection token the
    rail already follows, and settles locally after an answer so the rows do
    not keep offering a decision Core has already recorded. */
export function usePlaybookTaskDecision(
  projectId: string,
  refreshToken: number,
  actions: PlaybookTaskDecisionActions | undefined,
  routines: readonly RoutineConfigurationDto[] = [],
): PlaybookTaskDecisionHandle | null {
  const [messages, setMessages] = useState<readonly CompanionMessageDto[] | null>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const enabled = actions !== undefined;
  useEffect(() => {
    setMessages(null);
    const loader = actionsRef.current;
    if (!loader) return;
    let current = true;
    void loader.listTranscript()
      .then((transcript) => { if (current) setMessages(transcript.messages); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [enabled, projectId, refreshToken]);
  const decision = messages ? pendingPlaybookTaskDecision(messages, routineFindingTasks(routines)) : null;
  if (!actions || !decision) return null;
  return {
    decision,
    respond: async (answer) => {
      await actions.respondToProposal(decision.message.id, answer);
      setMessages(null);
    },
    accept: async () => {
      await actions.acceptSuggestion(decision.message.id);
      setMessages(null);
    },
  };
}

function summaryLine(content: string): string {
  const line = content.split("\n").map((value) => value.trim()).find((value) => value.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** A compact approval strip under a Task row. Approving needs the full text
    open first, so a sidebar click can never approve a proposal unread. */
export function PlaybookTaskDecisionStrip(props: {
  taskTitle: string;
  handle: PlaybookTaskDecisionHandle;
  disabled?: boolean | undefined;
  openSteward(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { decision } = props.handle;
  const proposal = decision.kind === "proposal";
  useEffect(() => { setExpanded(false); setError(undefined); }, [decision.message.id]);
  const run = async (action: () => Promise<void>) => {
    if (busy || props.disabled) return;
    setBusy(true); setError(undefined);
    try { await action(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const label = proposal ? "Needs your approval" : "Steward suggestion";
  const otherTasks = decision.taskIds.length - 1;
  const shared = otherTasks > 0
    ? `One ${proposal ? "approval" : "acceptance"} answers this for this Task and ${otherTasks} other${otherTasks === 1 ? "" : "s"}.`
    : null;
  return <div className={`playbook-task-decision ${decision.kind}`} role="group"
    aria-label={`${label} for ${props.taskTitle}`} aria-busy={busy}>
    <button type="button" className="playbook-task-decision-head" aria-expanded={expanded}
      title={expanded ? "Hide the Steward's message" : "Read the Steward's message before deciding"}
      onClick={() => setExpanded(!expanded)}>
      <span className="playbook-task-decision-flag">{label}</span>
      {otherTasks > 0 ? <span className="playbook-task-decision-shared">{decision.taskIds.length} Tasks</span> : null}
      {expanded ? null : <span className="playbook-task-decision-summary">{summaryLine(decision.message.content)}</span>}
    </button>
    {expanded ? <>
      <p className="playbook-task-decision-content">{decision.message.content}</p>
      {shared ? <p className="playbook-task-decision-scope">{shared}</p> : null}
      {error ? <p role="alert" className="playbook-task-decision-error">{error}</p> : null}
      <footer>
        <button type="button" className="link" onClick={props.openSteward}>Open Steward</button>
        <span>
          {proposal ? <>
            <button type="button" disabled={busy || props.disabled}
              onClick={() => void run(() => props.handle.respond("decline"))}>Decline</button>
            <button type="button" className="primary" disabled={busy || props.disabled}
              onClick={() => void run(() => props.handle.respond("approve"))}>Approve</button>
          </> : <button type="button" className="primary" disabled={busy || props.disabled}
            onClick={() => void run(() => props.handle.accept())}>Accept suggestion</button>}
        </span>
      </footer>
    </> : null}
  </div>;
}
