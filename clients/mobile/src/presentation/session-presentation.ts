import type { AgentStatusDto, SessionDto } from "@termloop/contract/current";

import { agentName, basename, sessionLabel } from "./dto-readers";
import type { RowTone } from "./tone";

/// Row composition for a Session. A literal port of the desktop's
/// `renderer/session-presentation.ts`, for the reason stated in `tone.ts`: the two
/// clients cannot share a package, so the same Session fact must be spelled the
/// same way by two copies, and a parity test is what holds them together.
///
/// `reviewReady` is client-local state derived only from a working-to-idle status
/// transition observed while the app is running. A cold-start idle snapshot does
/// not establish that transition, so reopening the app cannot make every resting
/// agent demand attention.

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
  | "live";

export type SessionState = {
  id: SessionStateId;
  tone: RowTone;
  /// The word the row prints. `undefined` means this is the unremarkable norm and
  /// the row stays silent — a resting agent labelling itself "idle" on every row
  /// spends the reader's attention without telling them anything.
  label: string | undefined;
  /// One plain sentence, for the accessible name. Never a contract enum.
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
  compacting: { tone: "working", label: "Compacting", summary: "Summarizing its conversation to free up context." },
  failed: { tone: "blocked", label: "Failed", summary: "Its last turn failed." },
  interrupted: { tone: "interrupted", label: "Interrupted", summary: "Its last turn was interrupted." },
  agentExited: { tone: "blocked", label: "Exited", summary: "The agent reported that it exited." },
  idle: { tone: "quiet", label: undefined, summary: "Idle." },
  unobserved: { tone: "quiet", label: undefined, summary: "No agent status has been observed." },
  live: { tone: "quiet", label: undefined, summary: "Running." },
};

function stateOf(id: SessionStateId): SessionState {
  return { id, ...sessionStatePresentation[id] };
}

/// A Session's own status is only live while its lifecycle is running. A status
/// observed just before the process stopped must not keep describing the row, so
/// the recovery states below shadow it entirely.
export function agentStatusIsLive(session: SessionDto): boolean {
  return session.lifecycle_state === "running";
}

export function sessionState(
  session: SessionDto,
  status: AgentStatusDto | undefined,
  reviewReady: boolean,
): SessionState {
  if (session.lifecycle_state === "resuming") return stateOf("resuming");
  if (session.lifecycle_state === "resumeFailed") return stateOf(session.retryable ? "retryable" : "resumeFailed");
  if (session.lifecycle_state === "stale") return stateOf("stale");
  if (session.lifecycle_state === "exited") return stateOf("processExited");
  if (!status) return stateOf("live");
  switch (status.status) {
    case "awaitingInput": return stateOf("awaitingInput");
    /// The client-local review flag is only valid while the structured status is
    /// idle; checked ahead of the status, an agent that resumed working would
    /// still claim to need review.
    case "idle": return stateOf(reviewReady ? "review" : "idle");
    case "working": return stateOf("working");
    case "compacting": return stateOf("compacting");
    case "failed": return stateOf("failed");
    case "interrupted": return stateOf("interrupted");
    case "exited": return stateOf("agentExited");
    case "unknown": return stateOf("unobserved");
  }
}

/// The loudest live agent in a set, or `undefined` when every one of them is
/// resting. Asked by a Task row and by the Project selector about their own sets.
export type AgentAttentionTone = Extract<RowTone, "attention" | "review" | "working">;

export type AgentAttention = {
  sessionId: string;
  label: string;
  /// Which agent the label is about, so the reader never has to open a row to
  /// find out who is waiting.
  agent: string;
  tone: AgentAttentionTone;
};

/// Waiting for input, then review needed, then working.
const attentionLabels: Record<AgentAttentionTone, string> = {
  attention: "Needs input",
  review: "Needs review",
  working: "Working",
};

function attentionOf(session: SessionDto, tone: AgentAttentionTone): AgentAttention {
  return { sessionId: session.id, label: attentionLabels[tone], agent: agentName(session), tone };
}

export function agentAttention(
  sessions: readonly SessionDto[],
  statusesById: ReadonlyMap<string, AgentStatusDto>,
  reviewReadySessionIds: ReadonlySet<string>,
): AgentAttention | undefined {
  let review: SessionDto | undefined;
  let working: SessionDto | undefined;
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
function sessionRunner(session: SessionDto): string {
  return session.kind === "Agent" ? agentName(session) : basename(session.process.program);
}

/// The two provenance tokens a row's state line prints, with anything the identity
/// line already said removed. An unnamed agent Session is titled "Codex" and an
/// unnamed terminal is titled by its own folder, so printing either again spends
/// the row's narrowest line on a word the reader took in one line above.
export function sessionProvenance(session: SessionDto, folder: string): {
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

/// One sentence describing the whole row, in the order the design ranks it: who it
/// is, how it relates to another Session, what it is doing, what is driving it,
/// and where it runs.
export function sessionRowAccessibleName(options: {
  session: SessionDto;
  state: SessionState;
  relationship: string | undefined;
}): string {
  const { session, state, relationship } = options;
  const label = sessionLabel(session);
  const parts = [label];
  if (relationship) parts.push(relationship);
  parts.push(state.summary);
  const runner = sessionRunner(session);
  if (runner !== label) parts.push(runner);
  parts.push(session.process.cwd);
  return parts.join(", ");
}

/// An Ask-To helper is the one Session relation the projection carries, and it is
/// a bounded live fact rather than Session parentage. The row states it so a
/// helper conversation is not mistaken for an ordinary Agent the user started.
export function sessionRelationship(
  session: SessionDto,
  sessionsById: ReadonlyMap<string, SessionDto>,
): string | undefined {
  const sourceId = session.ask_to_source_session_id;
  if (!sourceId) return undefined;
  const source = sessionsById.get(sourceId);
  return source ? `helping ${sessionLabel(source)}` : "helper session";
}
