import type {
  CompanionMessageDto, CompanionProposalDecision, PlaybookDto, PlaybookRuntimeResult,
} from "@termloop/contract/current";

/* The Steward chat's presentation model. The transcript is an append-only list
   of typed messages; this module derives what each message means *now* — which
   proposal is still being asked, which was answered, which the conversation
   simply moved past — and folds repeated Steward updates about one Task,
   Session, or finding into a single topic card. Everything here is derived
   from the generated transcript projection alone; no provider or tracker
   fields exist, so nothing here may pretend to know them. */

export type CompanionProposalOutcome = "pending" | "approved" | "declined" | "superseded";

/** Core's rule for the one Steward question still on the table: the newest
    Steward suggestion or proposal that arrived after the newest user-authored
    message. Steward status messages — reply, update, attention, problem,
    action — never answer a question, so they never clear it; only the user's
    next message or a newer Steward question does. */
export function currentStewardInteraction(
  messages: readonly CompanionMessageDto[],
): CompanionMessageDto | null {
  let newestUserSequence = 0;
  for (const message of messages) {
    if (message.author === "user" && message.sequence > newestUserSequence) {
      newestUserSequence = message.sequence;
    }
  }
  let interaction: CompanionMessageDto | null = null;
  for (const message of messages) {
    if (message.author !== "steward" || message.sequence <= newestUserSequence) continue;
    if (message.kind !== "suggestion" && message.kind !== "proposal") continue;
    if (interaction === null || message.sequence > interaction.sequence) interaction = message;
  }
  return interaction;
}

/** What has happened to one Steward proposal since it was asked. It stays
    pending across later Steward status messages — a background Playbook
    update must not silently retire an approval request. The first later
    decisive message settles it: a user approval or decline receipt resolves
    it, any other user message means the conversation moved past it, and a
    newer Steward suggestion or proposal replaces it. */
export function companionProposalOutcome(
  messages: readonly CompanionMessageDto[],
  proposal: CompanionMessageDto,
): CompanionProposalOutcome {
  const later = messages
    .filter((message) => message.sequence > proposal.sequence)
    .sort((left, right) => left.sequence - right.sequence);
  for (const message of later) {
    if (message.author === "user") {
      if (message.kind === "approval") return "approved";
      if (message.kind === "decline") return "declined";
      return "superseded";
    }
    if (message.kind === "suggestion" || message.kind === "proposal") return "superseded";
  }
  return "pending";
}

/** Accepting a suggestion writes an ordinary user reply, so acceptance cannot
    be told apart from a typed answer. The only fact derivable without guessing
    is replacement: a newer Steward suggestion or proposal exists, so this one
    is no longer the question being offered. Steward status messages never
    replace it. */
export function companionSuggestionReplaced(
  messages: readonly CompanionMessageDto[],
  suggestion: CompanionMessageDto,
): boolean {
  return messages.some((message) => message.sequence > suggestion.sequence
    && message.author === "steward"
    && (message.kind === "suggestion" || message.kind === "proposal"));
}

export type CompanionSuggestionOutcome = "available" | "accepted" | "superseded";

const LEGACY_SUGGESTION_ACCEPTANCE = "Accepted. Proceed with this suggestion.";

function isSuggestionAcceptance(message: CompanionMessageDto): boolean {
  return message.author === "user" && (message.kind === "acceptance"
    || (message.kind === "reply" && message.content.trim() === LEGACY_SUGGESTION_ACCEPTANCE));
}

/** A typed acceptance receipt makes successful suggestion adoption visible.
    Any other user response closes the suggestion without pretending it was
    accepted; later Steward questions replace it. Status messages do neither. */
export function companionSuggestionOutcome(
  messages: readonly CompanionMessageDto[],
  suggestion: CompanionMessageDto,
): CompanionSuggestionOutcome {
  const later = messages
    .filter((message) => message.sequence > suggestion.sequence)
    .sort((left, right) => left.sequence - right.sequence);
  for (const message of later) {
    if (message.author === "user") {
      return isSuggestionAcceptance(message) ? "accepted" : "superseded";
    }
    if (message.kind === "suggestion" || message.kind === "proposal") return "superseded";
  }
  return "available";
}

export type CompanionBadgeTone = "pending" | "approved" | "declined" | "superseded" | "info" | "done" | "attention" | "problem";
export type CompanionCardBadge = { label: string; tone: CompanionBadgeTone };

/** The typed state chip on one message card. Status kinds carry a plain state
    chip: an update states movement and asks nothing, attention means the
    user's own action is needed, problem means required evidence or access is
    unavailable. Only the proposal still awaiting an answer may say "Approval
    requested"; a resolved one says what the user decided, and one the
    conversation moved past says so instead of keeping a stale demand on
    screen. User approval/decline receipts carry the matching chip so the
    decision stays visible as a receipt, not as prose alone. */
export function companionMessageBadge(
  messages: readonly CompanionMessageDto[],
  message: CompanionMessageDto,
): CompanionCardBadge | null {
  if (message.kind === "approval") return { label: "Approved", tone: "approved" };
  if (message.kind === "decline") return { label: "Declined", tone: "declined" };
  if (isSuggestionAcceptance(message)) return { label: "Accepted", tone: "approved" };
  if (message.author === "user" || message.kind === "reply") return null;
  if (message.kind === "update") return { label: "Update", tone: "info" };
  if (message.kind === "attention") return { label: "Needs you", tone: "attention" };
  if (message.kind === "problem") return { label: "Evidence problem", tone: "problem" };
  if (message.kind === "action") return { label: "Completed", tone: "done" };
  if (message.kind === "suggestion") {
    const outcome = companionSuggestionOutcome(messages, message);
    if (outcome === "accepted") return { label: "Accepted", tone: "approved" };
    if (outcome === "superseded") return { label: "Suggestion · superseded", tone: "superseded" };
    return { label: "Suggestion", tone: "info" };
  }
  const outcome = companionProposalOutcome(messages, message);
  if (outcome === "pending") return { label: "Approval requested", tone: "pending" };
  if (outcome === "approved") return { label: "Approved", tone: "approved" };
  if (outcome === "declined") return { label: "Declined", tone: "declined" };
  return { label: "Superseded", tone: "superseded" };
}

export type CompanionTopicItem = {
  message: CompanionMessageDto;
  /** How many exact repeats of this wording were folded into this item. */
  repeatCount: number;
};
export type CompanionTopicGroup = { id: string; items: CompanionTopicItem[] };

function sharedCompanionRef(left: CompanionMessageDto, right: CompanionMessageDto): boolean {
  const leftFindingIds = new Set([
    ...(left.refs?.routineFindingId ? [left.refs.routineFindingId] : []),
    ...(left.refs?.routineFindingIds ?? []),
  ]);
  const rightFindingIds = [
    ...(right.refs?.routineFindingId ? [right.refs.routineFindingId] : []),
    ...(right.refs?.routineFindingIds ?? []),
  ];
  return Boolean(
    (left.refs?.taskId && left.refs.taskId === right.refs?.taskId)
    || (left.refs?.sessionId && left.refs.sessionId === right.refs?.sessionId)
    || rightFindingIds.some((findingId) => leftFindingIds.has(findingId)),
  );
}

function repeatedCompanionWording(left: CompanionMessageDto, right: CompanionMessageDto): boolean {
  return left.kind === right.kind && left.content.trim() === right.content.trim();
}

/** Folds the newest-first transcript into topic groups: consecutive Steward
    messages about the same Task, Session, or finding become one card, and an
    exact repeat of the adjacent wording becomes a count instead of another
    bubble. User messages never fold — a question or a decision receipt keeps
    its own place in the conversation. */
export function groupCompanionTopics(messages: readonly CompanionMessageDto[]): CompanionTopicGroup[] {
  const groups: CompanionTopicGroup[] = [];
  for (const message of messages) {
    const group = groups.at(-1);
    const adjacent = group?.items.at(-1)?.message;
    const linked = group !== undefined && adjacent !== undefined
      && adjacent.author === "steward" && message.author === "steward"
      && (sharedCompanionRef(adjacent, message) || repeatedCompanionWording(adjacent, message));
    if (!linked) {
      groups.push({ id: message.id, items: [{ message, repeatCount: 1 }] });
      continue;
    }
    const last = group.items.at(-1);
    if (last && repeatedCompanionWording(last.message, message)) {
      last.repeatCount += 1;
    } else {
      group.items.push({ message, repeatCount: 1 });
    }
  }
  return groups;
}

function repeatNote(repeatCount: number): string | null {
  return repeatCount > 1 ? `Repeated ${repeatCount}× · duplicates hidden` : null;
}

/** One conversation card: the newest update about a topic in full, its earlier
    updates behind a disclosure instead of a bubble per Steward wake. A pending
    proposal or acceptable suggestion stays pending across later Steward status
    messages, so when a newer same-topic update outranks it the open question
    is hoisted out of the history and keeps its controls visible beneath the
    newest update rather than disappearing into the disclosure. */
export function CompanionTopicCard(props: {
  group: CompanionTopicGroup;
  messages: readonly CompanionMessageDto[];
  pendingProposalId: string | null;
  actionableSuggestionId: string | null;
  busy: boolean;
  respond(proposalMessageId: string, decision: CompanionProposalDecision): void;
  acceptSuggestion(suggestionMessageId: string): void;
}) {
  const newest = props.group.items[0];
  if (!newest) return null;
  const actionable = (item: CompanionTopicItem) =>
    item.message.id === props.pendingProposalId || item.message.id === props.actionableSuggestionId;
  const hoisted = props.group.items.find((item) => item !== newest && actionable(item));
  const badge = companionMessageBadge(props.messages, newest.message);
  const earlier = props.group.items.slice(1).filter((item) => item !== hoisted);
  const note = repeatNote(newest.repeatCount);
  const controls = (item: CompanionTopicItem) => <>
    {item.message.id === props.pendingProposalId ? <div className="ap-msg-actions" aria-label="Proposal actions">
      <button type="button" className="ap-btn primary" disabled={props.busy} onClick={() => props.respond(item.message.id, "approve")}>Approve</button>
      <button type="button" className="ap-btn" disabled={props.busy} onClick={() => props.respond(item.message.id, "decline")}>Not now</button>
    </div> : null}
    {item.message.id === props.actionableSuggestionId ? <div className="ap-msg-actions" aria-label="Suggestion actions">
      <button type="button" className="ap-btn primary" disabled={props.busy} onClick={() => props.acceptSuggestion(item.message.id)}>Accept suggestion</button>
    </div> : null}
  </>;
  return <article className={`ap-msg ${newest.message.author} kind-${newest.message.kind}${actionable(newest) || hoisted ? " pending" : ""}${badge?.tone === "superseded" ? " superseded" : ""}`}>
    <header className="ap-msg-header">
      <span className="ap-msg-author">{newest.message.author === "user" ? "You" : "Steward"}</span>
      {badge ? <span className={`ap-msg-kind tone-${badge.tone}`}>{badge.label}</span> : null}
    </header>
    <p>{newest.message.content}</p>
    {note ? <small className="ap-msg-repeat">{note}</small> : null}
    {controls(newest)}
    {hoisted ? <div className="ap-msg-open-question">
      {(() => {
        const hoistedBadge = companionMessageBadge(props.messages, hoisted.message);
        return hoistedBadge ? <span className={`ap-msg-kind tone-${hoistedBadge.tone}`}>{hoistedBadge.label}</span> : null;
      })()}
      <p>{hoisted.message.content}</p>
      {controls(hoisted)}
    </div> : null}
    {earlier.length > 0 ? <details className="ap-topic-history">
      <summary>{earlier.length === 1 ? "1 earlier update" : `${earlier.length} earlier updates`}</summary>
      {earlier.map((item) => {
        const itemBadge = companionMessageBadge(props.messages, item.message);
        const itemNote = repeatNote(item.repeatCount);
        return <div key={item.message.id} className="ap-topic-history-item">
          {itemBadge ? <span className={`ap-msg-kind tone-${itemBadge.tone}`}>{itemBadge.label}</span> : null}
          <p>{item.message.content}</p>
          {itemNote ? <small className="ap-msg-repeat">{itemNote}</small> : null}
        </div>;
      })}
    </details> : null}
  </article>;
}

export type PlaybookStateStep = { milestoneId: string; title: string; waitingCount: number };
export type PlaybookStateSummary = {
  pipelineName: string;
  steps: PlaybookStateStep[];
  doneCount: number;
  processing: boolean;
  nextAttemptAtEpochMs: number | null;
};

/** The Playbook's current position, straight from the generated Playbook and
    runtime projections rather than from chat prose. Chat bubbles narrate; this
    strip states where Tasks actually stand, so a stale or repeated message can
    be checked against it at a glance. Null when no pipeline is configured. */
export function playbookStateSummary(
  playbook: PlaybookDto | null,
  runtime: PlaybookRuntimeResult | null,
): PlaybookStateSummary | null {
  if (!playbook || playbook.milestones.length === 0) return null;
  const byMilestone = new Map((runtime?.steps ?? []).map((step) => [step.milestoneId, step]));
  const nextAttempts = (runtime?.steps ?? [])
    .map((step) => step.nextAttemptAtEpochMs)
    .filter((value): value is number => value !== null);
  return {
    pipelineName: playbook.activePipelineName,
    steps: playbook.milestones.map((milestone) => ({
      milestoneId: milestone.id,
      title: milestone.title,
      waitingCount: byMilestone.get(milestone.id)?.waitingTaskIds.length ?? 0,
    })),
    doneCount: runtime?.doneTaskIds.length ?? 0,
    processing: Boolean(runtime?.processingTaskId),
    nextAttemptAtEpochMs: nextAttempts.length ? Math.min(...nextAttempts) : null,
  };
}

export function PlaybookStateStrip(props: { summary: PlaybookStateSummary }) {
  return <div className="ap-playbook-strip" aria-label="Current Playbook state">
    <span className="ap-playbook-name">{props.summary.pipelineName}</span>
    {props.summary.steps.map((step) => <span key={step.milestoneId}
      className={`ap-playbook-step${step.waitingCount > 0 ? " waiting" : ""}`}
      title={step.waitingCount > 0 ? `${step.waitingCount} waiting at ${step.title}` : step.title}>
      {step.title}{step.waitingCount > 0 ? ` · ${step.waitingCount}` : ""}
    </span>)}
    <span className="ap-playbook-done">Done · {props.summary.doneCount}</span>
    {props.summary.processing ? <span className="ap-playbook-processing">Steward is handling a step now</span> : null}
    {props.summary.nextAttemptAtEpochMs !== null
      ? <span className="ap-playbook-next">Next check {new Date(props.summary.nextAttemptAtEpochMs).toLocaleTimeString()}</span>
      : null}
  </div>;
}
