import { agentName, basename, sessionIsImprover, sessionLabel, type AgentStatus, type Session } from "./model.js";
import type { RowTone } from "./row-tone.js";

export { sessionIsImprover } from "./model.js";

/// Row composition for a Session, the peer of `task-presentation.ts`.
///
/// `model.ts` answers "what does the projection say"; this module answers "what
/// does the row say". It is the single home for the words a Session row shows, so
/// the spine hue, the visible state word, the tooltip, and the accessible name can
/// no longer disagree the way four independent label functions did.

/// What a Session row is currently reporting. Lifecycle outranks live agent
/// status, because a Session that stopped is not described by whatever its agent
/// last claimed. Two ids share the word "Exited" on purpose: the process going
/// away and the agent saying it went away are different observations that read
/// identically to the user.
export type SessionStateId =
  | "resuming"
  | "retryable"
  | "resumeFailed"
  | "stale"
  | "processExited"
  | "awaitingInput"
  | "review"
  | "working"
  | "compacting"
  | "failed"
  | "interrupted"
  | "agentExited"
  | "idle"
  | "unobserved"
  | "live"
  | "submittingPrompt"
  | "promptUnattributed"
  | "promptStalled"
  | "promptBlocked"
  | "promptFailed"
  | "promptRequiresResubmit";

export type SessionState = {
  id: SessionStateId;
  tone: RowTone;
  /// The word the row prints. `undefined` means this is the unremarkable norm and
  /// the row stays silent — a resting agent labelling itself "idle" on every row
  /// spends the reader's attention without telling them anything, and the presence
  /// dot already carries the distinction between resting and unobservable.
  label: string | undefined;
  /// One plain sentence, for the accessible name and the tooltip. Never a contract
  /// enum: the shipped row printed `idle`, `interrupted`, and `unknown` verbatim.
  summary: string;
};

const sessionStatePresentation: Record<SessionStateId, Omit<SessionState, "id">> = {
  resuming: { tone: "busy", label: "Resuming", summary: "Resuming its existing conversation." },
  retryable: { tone: "blocked", label: "Retry available", summary: "Its conversation could not resume, and a retry is available." },
  resumeFailed: { tone: "blocked", label: "Resume failed", summary: "Its conversation could not resume." },
  stale: { tone: "quiet", label: "Stale", summary: "Its terminal needs reopening." },
  processExited: { tone: "blocked", label: "Exited", summary: "Its process exited." },
  awaitingInput: { tone: "attention", label: "Needs input", summary: "Waiting for your input." },
  review: { tone: "review", label: "Needs review", summary: "Ready for you to review." },
  working: { tone: "working", label: "Working", summary: "Working now." },
  /// Its own work, not TermLoop's, so it keeps the `working` hue rather than the
  /// `busy` one. It is named separately because it takes minutes and answers the
  /// question a silent "Working" row cannot: why nothing is happening.
  compacting: { tone: "working", label: "Compacting", summary: "Summarizing its conversation to free up context." },
  failed: { tone: "blocked", label: "Failed", summary: "Its last turn failed." },
  interrupted: { tone: "interrupted", label: "Interrupted", summary: "Its last turn was interrupted." },
  agentExited: { tone: "blocked", label: "Exited", summary: "The agent reported that it exited." },
  idle: { tone: "quiet", label: undefined, summary: "Idle." },
  unobserved: { tone: "quiet", label: undefined, summary: "No agent status has been observed." },
  live: { tone: "quiet", label: undefined, summary: "Running." },
  submittingPrompt: { tone: "busy", label: "Submitting prompt", summary: "TermLoop is writing and submitting the generated prompt." },
  promptUnattributed: { tone: "attention", label: "Verify prompt", summary: "A submission occurred after keyboard input, so TermLoop could not confirm that it submitted this prompt." },
  promptStalled: { tone: "attention", label: "Prompt unconfirmed", summary: "TermLoop submitted the prompt but did not receive provider confirmation." },
  promptBlocked: { tone: "attention", label: "Prompt paused", summary: "TermLoop wrote the prompt but paused before submitting it; review the terminal before pressing Enter." },
  promptFailed: { tone: "blocked", label: "Prompt failed", summary: "TermLoop could not verify prompt delivery; review the terminal before resubmitting." },
  promptRequiresResubmit: { tone: "blocked", label: "Resubmit prompt", summary: "The runtime changed before delivery was confirmed; resubmit the prompt explicitly." },
};

function stateOf(id: SessionStateId): SessionState {
  return { id, ...sessionStatePresentation[id] };
}

/// An interruption remains the daemon's exact last-turn result. Once the user
/// has inspected that Session and navigated away, presentation alone treats the
/// acknowledged observation as resting. A newer observation has a different
/// timestamp and therefore remains visible until it is inspected in turn.
export function presentedAgentStatus(
  status: AgentStatus,
  acknowledgedInterruptedSessionObservations: ReadonlyMap<string, number>,
): AgentStatus {
  return status.status === "interrupted"
    && acknowledgedInterruptedSessionObservations.get(status.sessionId) === status.observedAtEpochMs
    ? { ...status, status: "idle" }
    : status;
}

/// A Session's own status is only live while its lifecycle is running. A status
/// observed just before the process stopped must not keep describing the row, so
/// the recovery states below shadow it entirely.
export function agentStatusIsLive(session: Session): boolean {
  return session.lifecycle_state === "running";
}

export type GeneratedInputDeliveryLabel =
  | "Submitting prompt" | "Verify prompt" | "Prompt unconfirmed" | "Prompt paused"
  | "Press Enter" | "Review prompt" | "Resolve agent prompt" | "Waiting to submit"
  | "Prompt failed" | "Resubmit prompt";

type GeneratedInputDeliveryState = Omit<SessionState, "label"> & {
  label: GeneratedInputDeliveryLabel;
};

export type GeneratedInputDeliveryPresentation = Readonly<{
  state: GeneratedInputDeliveryState;
  detail: string;
  nextAction: string;
}>;

function generatedInputDeliveryState(
  id: SessionStateId,
  label: GeneratedInputDeliveryLabel,
): GeneratedInputDeliveryState {
  return { ...stateOf(id), label };
}

function generatedInputFailureDetail(
  failure: NonNullable<AgentStatus["generatedInputDelivery"]>["failure"],
): string {
  switch (failure) {
    case "terminalUnavailable": return "terminal unavailable";
    case "pasteWriteFailed": return "prompt paste failed";
    case "outputDidNotSettle": return "terminal did not settle";
    case "userInputInterleaved": return "terminal input changed";
    case "providerAckMissing": return "provider did not confirm";
    case "composerUnavailable": return "agent composer unavailable";
    case "composerNotReady": return "Codex composer did not become ready";
    case "runtimeEpochChanged": return "terminal restarted";
    case "terminalClosed": return "terminal closed";
    case "submitWriteFailed": return "Enter write failed";
    case "assistantUnavailable": return "Project Steward unavailable";
    case null: return "prompt submission paused";
  }
}

function unavailableComposerDetail(
  cancelCause: NonNullable<AgentStatus["generatedInputDelivery"]>["cancelCause"],
): string {
  switch (cancelCause) {
    case "permissionRequested": return "agent requested permission";
    case "notification": return "agent notification requested attention";
    case "providerAwaitingInput": return "agent is waiting for input";
    case "providerBusy": return "agent had not returned to an available composer";
    case null: return "agent composer unavailable";
  }
}

/** One generated-delivery explanation shared by ordinary Session rows and the
    persistent Steward/Worker rail. Keeping the enum-to-language mapping here
    prevents an assistant card from collapsing an exact failure back to Idle. */
export function generatedInputDeliveryPresentation(
  delivery: AgentStatus["generatedInputDelivery"],
): GeneratedInputDeliveryPresentation | undefined {
  if (!delivery) return undefined;
  switch (delivery.state) {
    case "writingPaste": return delivery.pasteReceipted ? {
      state: generatedInputDeliveryState("submittingPrompt", "Submitting prompt"),
      detail: "generated prompt delivery",
      nextAction: "Wait for provider confirmation.",
    } : {
      state: generatedInputDeliveryState("submittingPrompt", "Waiting to submit"),
      detail: "waiting for the agent composer",
      nextAction: "Wait for the agent startup and composer readiness checks.",
    };
    case "awaitingProviderAck": return {
      state: generatedInputDeliveryState("submittingPrompt", "Submitting prompt"),
      detail: "generated prompt delivery",
      nextAction: "Wait for provider confirmation.",
    };
    case "confirmed": return undefined;
    case "confirmedUnattributed": return {
      state: generatedInputDeliveryState("promptUnattributed", "Verify prompt"),
      detail: "submission could not be attributed",
      nextAction: "Open its Terminal and verify the prompt.",
    };
    case "stalled": return {
      state: generatedInputDeliveryState("promptStalled", "Prompt unconfirmed"),
      detail: delivery.failure === "providerAckMissing" && delivery.submitAttempts === 2
        ? "provider did not confirm after 2 Enter attempts"
        : generatedInputFailureDetail(delivery.failure),
      nextAction: "Open its Terminal and verify whether the prompt ran.",
    };
    case "blocked": {
      const blocked = generatedInputDeliveryState("promptBlocked", "Prompt paused");
      if (delivery.failure === "outputDidNotSettle") {
        return {
          state: {
            ...blocked,
            label: "Press Enter",
            summary: "TermLoop wrote the prompt but the terminal did not settle; review it and press Enter to submit.",
          },
          detail: generatedInputFailureDetail(delivery.failure),
          nextAction: "Open its Terminal and press Enter after reviewing the prompt.",
        };
      }
      if (delivery.failure === "userInputInterleaved") {
        return {
          state: {
            ...blocked,
            label: "Review prompt",
            summary: "Terminal input changed while TermLoop was preparing the submission; review the composer and submit it manually.",
          },
          detail: generatedInputFailureDetail(delivery.failure),
          nextAction: "Open its Terminal and submit the reviewed prompt manually.",
        };
      }
      if (delivery.failure === "composerUnavailable") {
        const providerWasBusy = delivery.cancelCause === "providerBusy";
        return delivery.pasteReceipted
          ? {
              state: {
                ...blocked,
                label: "Resolve agent prompt",
                summary: providerWasBusy
                  ? "The provider changed state while this prompt was being delivered. Review the composer before continuing."
                  : "The agent requested other input while this prompt was being delivered. Resolve it, then review the composer.",
              },
              detail: unavailableComposerDetail(delivery.cancelCause),
              nextAction: providerWasBusy
                ? "Open its Terminal and review the composer."
                : "Open its Terminal, resolve the request, and review the composer.",
            }
          : {
              state: {
                ...blocked,
                label: "Waiting to submit",
                summary: providerWasBusy
                  ? "The provider had not returned to an available composer, so TermLoop kept this prompt queued. It will submit after the provider becomes ready."
                  : "The agent requested other input before TermLoop could paste this prompt. Resolve it; TermLoop will submit when the composer is ready.",
              },
              detail: unavailableComposerDetail(delivery.cancelCause),
              nextAction: providerWasBusy
                ? "Wait for the provider to become ready."
                : "Open its Terminal and resolve the agent request.",
            };
      }
      if (delivery.failure === "composerNotReady") {
        return {
          state: {
            ...blocked,
            label: "Waiting to submit",
            summary: "TermLoop did not paste the prompt because Codex did not expose a ready composer within 20 seconds.",
          },
          detail: generatedInputFailureDetail(delivery.failure),
          nextAction: "Wait for Codex startup to finish, then run the action again.",
        };
      }
      return {
        state: blocked,
        detail: generatedInputFailureDetail(delivery.failure),
        nextAction: "Open its Terminal and review the prompt.",
      };
    }
    case "failed": return {
      state: generatedInputDeliveryState("promptFailed", "Prompt failed"),
      detail: generatedInputFailureDetail(delivery.failure),
      nextAction: "Open its Terminal and resubmit the prompt explicitly.",
    };
    case "requiresUserResubmit": return {
      state: generatedInputDeliveryState("promptRequiresResubmit", "Resubmit prompt"),
      detail: generatedInputFailureDetail(delivery.failure),
      nextAction: "Open its Terminal and resubmit the prompt explicitly.",
    };
  }
}

export function sessionState(session: Session, status: AgentStatus | undefined, reviewReady: boolean): SessionState {
  if (session.lifecycle_state === "resuming") return stateOf("resuming");
  if (session.lifecycle_state === "resumeFailed") return stateOf(session.retryable ? "retryable" : "resumeFailed");
  if (session.lifecycle_state === "stale") return stateOf("stale");
  if (session.lifecycle_state === "exited") return stateOf("processExited");
  if (!status) return stateOf("live");
  const delivery = generatedInputDeliveryPresentation(status.generatedInputDelivery);
  if (delivery) return delivery.state;
  switch (status.status) {
    case "awaitingInput": return stateOf("awaitingInput");
    /// Per F2-16 the client-local review flag is only valid while the structured
    /// status is idle. The shipped row checked it ahead of every status, so an
    /// agent that resumed working still claimed to need review.
    case "idle": return stateOf(reviewReady ? "review" : "idle");
    case "working": return stateOf("working");
    case "compacting": return stateOf("compacting");
    case "failed": return stateOf("failed");
    case "interrupted": return stateOf("interrupted");
    case "exited": return stateOf("agentExited");
    case "unknown": return stateOf("unobserved");
  }
}

/// Shared rail ordering for live Agents. A lower value means the Agent should
/// appear sooner: user action first, then interruption, active work, and rest.
/// Keeping this beside `sessionState` makes every Session surface rank the same
/// projected state instead of reinterpreting raw provider statuses.
export function agentActivityPriority(
  session: Session,
  status: AgentStatus | undefined,
  reviewReady: boolean,
): number {
  const state = sessionState(session, status, reviewReady);
  if (state.id === "awaitingInput") return 0;
  if (state.id === "review") return 1;
  if (state.id === "failed" || state.id === "interrupted") return 2;
  if (state.id === "working" || state.id === "compacting" || state.id === "resuming") return 3;
  return 4;
}

/// The loudest projected state in one visual Agent group. Ask-To helpers and
/// forked Agents travel with their source, so both rails must rank the group
/// from the same member-level fact.
export function agentGroupActivityPriority(
  members: readonly Session[],
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
): number {
  return Math.min(...members.map((session) => agentActivityPriority(
    session,
    statusesById.get(session.id),
    reviewReadySessionIds.has(session.id),
  )));
}

export const AGENT_RECENT_ACTIVITY_WINDOW_MS = 10 * 60 * 1_000;

/// The live observation is the freshest daemon-owned activity signal. A
/// structured plan is durable; callers may additionally compare the returned
/// value with their bounded client-local memory after an app restart.
export function agentLastKnownActivityAtEpochMs(status: AgentStatus | undefined): number {
  return Math.max(status?.observedAtEpochMs ?? 0, status?.plan?.updatedAtEpochMs ?? 0);
}

/// A currently working/resuming Agent remains active even when its last status
/// observation is older than the display window. The timestamp measures the
/// last observed activity for resting/interrupted Agents; it is not a timeout
/// for work that is still in progress.
export function agentActivityIsOlder(
  session: Session,
  status: AgentStatus | undefined,
  nowEpochMs: number,
  rememberedActivityAtEpochMs = 0,
): boolean {
  if (
    session.lifecycle_state === "resuming"
    || status?.status === "working"
    || status?.status === "compacting"
  ) return false;
  /// A missing/unknown observation is not evidence of inactivity. It is most
  /// often the short window between launch and the first provider status.
  if (!status || status.status === "unknown") return false;
  const observedAtEpochMs = Math.max(
    agentLastKnownActivityAtEpochMs(status),
    rememberedActivityAtEpochMs,
  );
  return observedAtEpochMs === undefined
    || (nowEpochMs >= observedAtEpochMs
      && nowEpochMs - observedAtEpochMs > AGENT_RECENT_ACTIVITY_WINDOW_MS);
}

/// The presence dot's tooltip, and the only place the status *source* is stated.
/// Provenance belongs in a tooltip rather than in row copy or an accessible name,
/// and `tests/e2e/f1/agent-status.mjs` asserts this exact `<state> · <source>`
/// shape — including the `Idle` and `Ready for review` wording — so the strings
/// here are an acceptance contract, not free presentation choices.
export function agentStatusTooltip(status: AgentStatus, reviewReady: boolean): string {
  if (reviewReady) return `Ready for review · ${status.source}`;
  const label = status.status === "awaitingInput"
    ? "Awaiting input"
    : `${status.status.slice(0, 1).toUpperCase()}${status.status.slice(1)}`;
  return `${label} · ${status.source}`;
}

/// The loudest live agent in a set, or `undefined` when every one of them is
/// resting. Used by a collapsed Task row and a collapsed Session group, which ask
/// the same question about their own set of Sessions.
///
/// This derivation was `taskAttention` in `task-presentation.ts`. It never read a
/// Task, and keeping one copy is what stops the Task and Session surfaces from
/// drifting apart on what "the loudest agent" means.
export type AgentAttentionTone = Extract<RowTone, "attention" | "review" | "working">;

export type AgentAttention = {
  sessionId: string;
  label: string;
  /// Which agent the label is about, so the reader never has to expand a
  /// collapsed group to find out who is waiting.
  agent: string;
  tone: AgentAttentionTone;
};

/// F2-16's exact priority: waiting for input, then review needed, then working.
const attentionLabels: Record<AgentAttentionTone, string> = {
  attention: "Needs input",
  review: "Needs review",
  working: "Working",
};

function attentionOf(session: Session, tone: AgentAttentionTone): AgentAttention {
  return { sessionId: session.id, label: attentionLabels[tone], agent: agentName(session), tone };
}

export function agentAttention(
  sessions: readonly Session[],
  statusesById: ReadonlyMap<string, AgentStatus>,
  reviewReadySessionIds: ReadonlySet<string>,
): AgentAttention | undefined {
  let review: Session | undefined;
  let working: Session | undefined;
  for (const session of sessions) {
    if (session.kind !== "Agent" || !agentStatusIsLive(session)) continue;
    const status = statusesById.get(session.id);
    if (status?.status === "awaitingInput") return attentionOf(session, "attention");
    if (status?.status === "idle" && reviewReadySessionIds.has(session.id)) review ??= session;
    else if (status?.status === "working") working ??= session;
  }
  if (review) return attentionOf(review, "review");
  if (working) return attentionOf(working, "working");
  return undefined;
}

/// What is driving this Session: which agent, or which program a terminal runs.
/// Deliberately module-private — the row asks `sessionProvenance` instead, so the
/// de-duplication against the row title cannot be skipped at a call site.
function sessionRunner(session: Session): string {
  return session.kind === "Agent" ? agentName(session) : basename(session.process.program);
}

/// The two provenance tokens the state line prints after the state word, with
/// anything the identity zone already said removed.
///
/// An unnamed agent Session is titled "Codex" and an unnamed terminal is titled
/// by its own folder, so printing either again spends the row's narrowest line on
/// a word the reader took in one line above — and at the 190 px minimum width that
/// duplicate is what pushes the token the reader actually needs into an ellipsis.
export function sessionProvenance(session: Session, folder: string): {
  runner: string | undefined;
  folder: string | undefined;
} {
  const label = sessionLabel(session);
  const runner = sessionRunner(session);
  return {
    runner: runner === label ? undefined : runner,
    folder: folder && folder !== label ? folder : undefined,
  };
}

/// One sentence describing the whole row, in the order the visual design ranks
/// it: who it is, how it relates to another Session, what it is doing, what is
/// driving it, and where it runs.
export function sessionRowAccessibleName(options: {
  session: Session;
  state: SessionState;
  relationship: string | undefined;
}): string {
  const { session, state, relationship } = options;
  const label = sessionLabel(session);
  const parts = [label];
  if (relationship) parts.push(relationship);
  parts.push(state.summary);
  /// An unnamed agent Session is already called "Claude", so naming its runner
  /// again would only make the row longer to listen to. A run's runner is the
  /// shell that started it, which is never what the listener asked about.
  if (sessionIsImprover(session)) parts.push("improver");
  const runner = sessionRunner(session);
  if (runner !== label && !session.run_configuration_id) parts.push(runner);
  parts.push(session.process.cwd);
  return parts.join(", ");
}
