import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { AgentStatus, CompanionMessageDto, CompanionProposalDecision } from "@termloop/contract/current";
import {
  companionMessageBadge,
  currentStewardInteraction,
  type CompanionBadgeTone,
} from "./companion-chat.js";

/**
 * Ambient Steward presence. Every face is derived from an observed signal, so a
 * disabled or dead assistant can never render as a working one. This module owns
 * presentation only: it renders props and raises intents.
 */
export type StewardPetState = "idle" | "thinking" | "working" | "asking" | "alert" | "asleep" | "gone";

export type StewardPetSignal = {
  /** Steward configuration is enabled and saved. */
  enabled: boolean;
  /** The current executor Session is running. */
  executorRunning: boolean;
  /** The same structured provider status rendered by the Session sidebar. */
  executorStatus: AgentStatus | null;
  /** Disposable PTY telemetry retained for consumers, but not used to infer a face. */
  lastActivityAtEpochMs: number | null;
  /** Label of the control command currently in flight, or null. */
  activeCommandLabel: string | null;
  /** A Steward proposal is waiting for an explicit full-control user action. */
  pendingProposal: boolean;
  /** A problem report or unexpected Session exit is unread. */
  problem: boolean;
};

/** Keeps a byte observation live across the host's one-second presence refresh. */
export const STEWARD_PET_ACTIVITY_WINDOW_MS = 2_500;

/** First run: the Steward has never been turned on and no Playbook exists yet,
    so the pet routes every interaction to Playbook creation instead of
    offering an enable switch — a Steward without a Playbook has nothing to
    run, and the sidebar must not open a side door around that gate. */
export function stewardPetRoutesToPlaybookSetup(
  enabled: boolean,
  playbookMissing: boolean,
): boolean {
  return !enabled && playbookMissing;
}

export function stewardPetState(signal: StewardPetSignal, nowEpochMs: number): StewardPetState {
  if (!signal.enabled) return "asleep";
  if (!signal.executorRunning) return "gone";
  if (signal.problem) return "alert";
  if (signal.activeCommandLabel) return "working";
  if (signal.executorStatus === "working") return "thinking";
  if (signal.executorStatus === "awaitingInput") return "asking";
  const activityAt = signal.lastActivityAtEpochMs;
  if (signal.executorStatus === null || signal.executorStatus === "unknown") {
    if (activityAt !== null && nowEpochMs >= activityAt && nowEpochMs - activityAt <= STEWARD_PET_ACTIVITY_WINDOW_MS) {
      return "thinking";
    }
  }
  if (signal.pendingProposal) return "asking";
  return "idle";
}

/**
 * Telemetry the daemon does not project yet. Until it does these stay inert, so
 * the pet simply never claims to be thinking or working rather than guessing.
 */
export type StewardPetTelemetry = {
  lastActivityAtEpochMs: number | null;
  activeCommandLabel: string | null;
  pendingProposal: boolean;
};

export const STEWARD_PET_NO_TELEMETRY: StewardPetTelemetry = {
  lastActivityAtEpochMs: null,
  activeCommandLabel: null,
  pendingProposal: false,
};

/** Resolves the observable half of the signal from projections the client already holds. */
export function stewardPetSignal(
  steward: { enabled: boolean; executorSessionId: string | null } | null,
  sessions: readonly { id: string; lifecycle_state: string }[],
  reports: readonly { kind: string }[],
  telemetry: StewardPetTelemetry = STEWARD_PET_NO_TELEMETRY,
  agentStatuses: readonly { sessionId: string; status: AgentStatus }[] = [],
): StewardPetSignal {
  const executorSessionId = steward?.executorSessionId ?? null;
  const executor = executorSessionId ? sessions.find((session) => session.id === executorSessionId) : undefined;
  const executorStatus = executorSessionId
    ? agentStatuses.find((status) => status.sessionId === executorSessionId)?.status ?? null
    : null;
  return {
    enabled: steward?.enabled ?? false,
    executorRunning: executor?.lifecycle_state === "running",
    executorStatus,
    problem: reports.some((report) => report.kind === "problem"),
    lastActivityAtEpochMs: telemetry.lastActivityAtEpochMs,
    activeCommandLabel: telemetry.activeCommandLabel,
    pendingProposal: telemetry.pendingProposal,
  };
}

export type StewardPetFace = { eyes: string; mouth: string };

const FACES: Record<StewardPetState, StewardPetFace> = {
  idle: { eyes: "●●", mouth: "–" },
  thinking: { eyes: "◐◐", mouth: "·" },
  working: { eyes: "▪▪", mouth: "–" },
  asking: { eyes: "⊙⊙", mouth: "o" },
  alert: { eyes: "××", mouth: "~" },
  asleep: { eyes: "‾‾", mouth: "–" },
  gone: { eyes: "╌╌", mouth: " " },
};

export function stewardPetFace(state: StewardPetState): StewardPetFace {
  return FACES[state];
}

export const STEWARD_PET_THINKING_EYES = ["◐◐", "◓◓", "◑◑", "◒◒"] as const;
export const STEWARD_PET_BLINK_EYES = "‾‾";

export function stewardPetTicker(state: StewardPetState, activeCommandLabel: string | null): string {
  if (state === "working") return activeCommandLabel ?? "working";
  if (state === "thinking") return "thinking";
  if (state === "asking") return "waiting for you";
  if (state === "alert") return "needs attention";
  if (state === "gone") return "needs restart";
  if (state === "asleep") return "disabled";
  return "";
}

export function stewardPetStatusLabel(state: StewardPetState): string {
  if (state === "idle") return "Ready";
  if (state === "thinking") return "Thinking";
  if (state === "working") return "Working";
  if (state === "asking") return "Waiting for you";
  if (state === "alert") return "Needs attention";
  if (state === "asleep") return "Disabled";
  return "Stopped";
}

export type StewardPetUtteranceKind = CompanionMessageDto["kind"];

/** A resolved reference the bubble can hand back to composition. */
export type StewardPetReference = { label: string; detail: string };

export type StewardPetInteraction = {
  id: string;
  kind: "suggestion" | "proposal";
  text: string;
  badgeLabel: string;
  badgeTone: CompanionBadgeTone;
};

export type StewardPetUtterance = {
  id: string;
  kind: StewardPetUtteranceKind;
  text: string;
  sourceLabel?: string | null;
  badgeLabel?: string | null;
  badgeTone?: CompanionBadgeTone | null;
  /** The one still-actionable Steward question, even when a later status
      message is the notification's headline. */
  interaction?: StewardPetInteraction | null;
  reference?: StewardPetReference | null;
};

type StewardPetTranscriptMessage = CompanionMessageDto;

function newestStewardPetTranscriptMessage(
  messages: readonly StewardPetTranscriptMessage[],
): StewardPetTranscriptMessage | undefined {
  return messages.reduce<StewardPetTranscriptMessage | undefined>(
    (current, message) => current === undefined || message.sequence > current.sequence ? message : current,
    undefined,
  );
}

/**
 * Surfaces only the newest chat fact. A later user reply closes the old
 * Steward bubble instead of letting an earlier message reappear.
 */
export function stewardPetUtteranceFromMessages(
  messages: readonly StewardPetTranscriptMessage[],
): StewardPetUtterance | null {
  const newest = newestStewardPetTranscriptMessage(messages);
  if (!newest) return null;
  const badge = companionMessageBadge(messages, newest);
  // An ordinary user reply is conversation demand, not a notification. Typed
  // decision receipts are kept briefly so a Pet action visibly completes.
  if (newest.author === "user" && badge === null) return null;
  const currentInteraction = currentStewardInteraction(messages);
  const interaction = currentInteraction ? (() => {
    const interactionBadge = companionMessageBadge(messages, currentInteraction);
    if (!interactionBadge || (currentInteraction.kind !== "suggestion" && currentInteraction.kind !== "proposal")) return null;
    return {
      id: currentInteraction.id,
      kind: currentInteraction.kind,
      text: currentInteraction.content,
      badgeLabel: interactionBadge.label,
      badgeTone: interactionBadge.tone,
    } satisfies StewardPetInteraction;
  })() : null;
  return {
    id: newest.id,
    kind: newest.kind,
    text: newest.content,
    sourceLabel: newest.kind === "reply" ? null : newest.kind,
    badgeLabel: badge?.label ?? null,
    badgeTone: badge?.tone ?? null,
    interaction,
  };
}

/** The exact pending user line the Steward is currently responding to. */
export function stewardPetPendingUserMessage(
  messages: readonly StewardPetTranscriptMessage[],
): string | null {
  const newest = newestStewardPetTranscriptMessage(messages);
  return newest?.author === "user" ? newest.content : null;
}

/** Returns the latest relevant line when the user explicitly opens the
    notification card, including a resolved receipt or historical status. */
export function latestStewardPetUtterance(
  messages: readonly StewardPetTranscriptMessage[],
): StewardPetUtterance | null {
  const current = stewardPetUtteranceFromMessages(messages);
  if (current) return current;
  const newestSteward = newestStewardPetTranscriptMessage(
    messages.filter((message) => message.author === "steward"),
  );
  if (!newestSteward) return null;
  const badge = companionMessageBadge(messages, newestSteward);
  return {
    id: newestSteward.id,
    kind: newestSteward.kind,
    text: newestSteward.content,
    sourceLabel: newestSteward.kind === "reply" ? null : newestSteward.kind,
    badgeLabel: badge?.label ?? null,
    badgeTone: badge?.tone ?? null,
    interaction: null,
  };
}

/** Anything waiting on the user stays until answered; ordinary notification
    speech expires. */
export function stewardPetBubbleHolds(kind: StewardPetUtteranceKind): boolean {
  return kind === "proposal" || kind === "suggestion" || kind === "problem" || kind === "attention";
}

export function stewardPetUtteranceHolds(utterance: StewardPetUtterance): boolean {
  return Boolean(utterance.interaction) || stewardPetBubbleHolds(utterance.kind);
}

export function stewardPetBubbleDismissMs(kind: StewardPetUtteranceKind): number | null {
  if (stewardPetBubbleHolds(kind)) return null;
  return kind === "update" || kind === "acceptance" || kind === "approval" || kind === "decline"
    ? 5_000
    : 7_000;
}

/**
 * Muted keeps the face honest but the bubble closed, and terminal typing defers
 * anything that is not already waiting on the user.
 */
export function stewardPetSpeaks(
  utterance: StewardPetUtterance | null,
  options: { muted: boolean; userBusy: boolean },
): boolean {
  if (!utterance) return false;
  if (options.muted) return false;
  if (options.userBusy && !stewardPetUtteranceHolds(utterance)) return false;
  return true;
}

export type StewardPetCorner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight";
export type StewardPetPosition = { x: number; y: number };

export function stewardPetGazeOffset(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const centerX = bounds.left + bounds.width / 2;
  const centerY = bounds.top + bounds.height / 2;
  return {
    x: clamp((point.x - centerX) / 180) * 2,
    y: clamp((point.y - centerY) / 180) * 1.5,
  };
}

export function stewardPetClampPosition(
  position: StewardPetPosition,
  bounds: { width: number; height: number },
  pet: { width: number; height: number },
): StewardPetPosition {
  return {
    x: Math.max(0, Math.min(position.x, Math.max(0, bounds.width - pet.width))),
    y: Math.max(0, Math.min(position.y, Math.max(0, bounds.height - pet.height))),
  };
}

export function stewardPetNearestCorner(
  point: { x: number; y: number },
  bounds: { width: number; height: number },
): StewardPetCorner {
  const right = point.x > bounds.width / 2;
  const bottom = point.y > bounds.height / 2;
  if (bottom) return right ? "bottomRight" : "bottomLeft";
  return right ? "topRight" : "topLeft";
}

export function stewardPetBubblePlacement(corner: StewardPetCorner): "above" | "below" {
  return corner === "topLeft" || corner === "topRight" ? "below" : "above";
}

export function stewardPetBubbleAlignment(corner: StewardPetCorner): "left" | "right" {
  return corner === "bottomRight" || corner === "topRight" ? "right" : "left";
}

type Props = {
  signal: StewardPetSignal;
  nowEpochMs: number;
  utterance: StewardPetUtterance | null;
  thinkingMessage: string | null;
  unread: boolean;
  /** An unanswered suggestion or proposal remains reachable after its latest
      notification card has been dismissed. */
  actionable: boolean;
  inlineOpen: boolean;
  muted: boolean;
  /** The user is typing into a terminal, so nothing non-urgent should interrupt. */
  userBusy: boolean;
  /** Renders as a footer status chip instead of a draggable ambient widget. */
  compact?: boolean;
  setEnabled?(enabled: boolean): Promise<void>;
  togglePending?: boolean;
  /** No Playbook exists yet, so first-run interactions route to its creation. */
  playbookMissing?: boolean;
  openPlaybookSetup?(): void;
  corner: StewardPetCorner;
  position: StewardPetPosition | null;
  openWorklog(): void;
  respondToProposal(proposalMessageId: string, decision: CompanionProposalDecision): Promise<void>;
  acceptSuggestion(suggestionMessageId: string): Promise<void>;
  dismissUtterance(utteranceId: string): void;
  openReference(utteranceId: string): void;
  setInlineOpen(open: boolean): void;
  markUtteranceSeen(utteranceId: string): void;
  moveTo(position: StewardPetPosition, corner: StewardPetCorner): void;
  toggleMuted(): void;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function StewardPet(props: Props) {
  const routeToPlaybookSetup = props.openPlaybookSetup !== undefined
    && stewardPetRoutesToPlaybookSetup(props.signal.enabled, props.playbookMissing ?? false);
  const state = stewardPetState(props.signal, props.nowEpochMs);
  const face = stewardPetFace(state);
  const ticker = stewardPetTicker(state, props.signal.activeCommandLabel);
  const speaking = stewardPetSpeaks(props.utterance, { muted: props.muted, userBusy: props.userBusy });
  const thinking = state === "thinking";
  const thinkingKey = props.thinkingMessage ?? "thinking";
  const [dismissedThinkingKey, setDismissedThinkingKey] = useState<string>();
  const thinkingOpen = thinking && !props.muted && dismissedThinkingKey !== thinkingKey;
  const bubbleOpen = thinkingOpen || props.inlineOpen || speaking;
  const utterance = thinking ? null : props.utterance;
  const [frame, setFrame] = useState(0);
  const [blinking, setBlinking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const draggedRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!thinking) setDismissedThinkingKey(undefined);
  }, [thinking]);

  useEffect(() => {
    if (!bubbleOpen) return;
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    const OwnerNode = ownerDocument?.defaultView?.Node;
    if (!root || !ownerDocument || !OwnerNode) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof OwnerNode && root.contains(target)) return;
      props.setInlineOpen(false);
      if (thinking) setDismissedThinkingKey(thinkingKey);
      else if (utterance) props.dismissUtterance(utterance.id);
    };
    ownerDocument.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => ownerDocument.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [bubbleOpen, thinking, thinkingKey, utterance?.id]);

  useEffect(() => {
    if (state !== "thinking" || prefersReducedMotion()) return;
    const handle = window.setInterval(() => setFrame((value) => value + 1), 170);
    return () => window.clearInterval(handle);
  }, [state]);

  useEffect(() => {
    if (state !== "idle") {
      setGaze((current) => current.x === 0 && current.y === 0 ? current : { x: 0, y: 0 });
      return;
    }
    const root = rootRef.current;
    const ownerDocument = root?.ownerDocument;
    if (!root || !ownerDocument) return;
    const handlePointerMove = (event: PointerEvent) => {
      setGaze(stewardPetGazeOffset(event, root.getBoundingClientRect()));
    };
    ownerDocument.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => ownerDocument.removeEventListener("pointermove", handlePointerMove);
  }, [state]);

  useEffect(() => {
    if (state !== "idle" || prefersReducedMotion()) return;
    const handle = window.setInterval(() => {
      setBlinking(true);
      window.setTimeout(() => setBlinking(false), 130);
    }, 4_200);
    return () => window.clearInterval(handle);
  }, [state]);

  useEffect(() => {
    if (!speaking || props.inlineOpen || !utterance) return;
    const timeout = stewardPetUtteranceHolds(utterance)
      ? null
      : stewardPetBubbleDismissMs(utterance.kind);
    if (timeout === null) return;
    const handle = window.setTimeout(() => props.dismissUtterance(utterance.id), timeout);
    return () => window.clearTimeout(handle);
  }, [speaking, props.inlineOpen, utterance?.id, utterance?.kind, utterance?.interaction?.id]);

  const runNotificationAction = async (action: () => Promise<void>) => {
    if (acting) return;
    setActing(true);
    setActionError(undefined);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(false);
    }
  };

  const eyes = state === "thinking" && !prefersReducedMotion()
    ? STEWARD_PET_THINKING_EYES[frame % STEWARD_PET_THINKING_EYES.length]
    : state === "idle" && blinking ? STEWARD_PET_BLINK_EYES : face.eyes;
  const eyeStyle = state === "idle" && !blinking
    ? { transform: `translate(${gaze.x}px, ${gaze.y}px)` }
    : undefined;

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const root = rootRef.current;
    const host = root?.offsetParent as HTMLElement | null;
    if (!root || !host) return;
    const rootBounds = root.getBoundingClientRect();
    draggedRef.current = false;
    draggingRef.current = true;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    dragOffsetRef.current = {
      x: event.clientX - rootBounds.left,
      y: event.clientY - rootBounds.top,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current) return;
    const distance = Math.abs(event.clientX - dragStartRef.current.x)
      + Math.abs(event.clientY - dragStartRef.current.y);
    if (!draggedRef.current && distance <= 3) return;
    draggedRef.current = true;
    const root = rootRef.current;
    const host = root?.offsetParent as HTMLElement | null;
    if (!root || !host) return;
    const bounds = host.getBoundingClientRect();
    const rootBounds = root.getBoundingClientRect();
    const position = stewardPetClampPosition(
      {
        x: event.clientX - bounds.left - dragOffsetRef.current.x,
        y: event.clientY - bounds.top - dragOffsetRef.current.y,
      },
      { width: bounds.width, height: bounds.height },
      { width: rootBounds.width, height: rootBounds.height },
    );
    props.moveTo(position, stewardPetNearestCorner(
      { x: position.x + rootBounds.width / 2, y: position.y + rootBounds.height / 2 },
      { width: bounds.width, height: bounds.height },
    ));
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const interaction = utterance?.interaction ?? null;
  const interactionIsHeadline = Boolean(interaction && interaction.id === utterance?.id);
  const notificationHolds = Boolean(utterance && stewardPetUtteranceHolds(utterance));
  const viewLabel = interaction ? "View" : utterance?.kind === "attention" || utterance?.kind === "problem" ? "Open" : "View all";
  const bubble = bubbleOpen ? (
    <div className={`steward-pet-bubble ${stewardPetBubblePlacement(props.corner)} ${stewardPetBubbleAlignment(props.corner)}`}
      data-unread={!thinking && props.unread ? "true" : undefined}
      data-thinking={thinking ? "true" : undefined}
      data-kind={utterance?.kind}
      role={notificationHolds ? "alertdialog" : "dialog"}
      aria-label="Steward notification"
      aria-live={notificationHolds ? "assertive" : "polite"}
      onPointerDown={() => { if (utterance) props.markUtteranceSeen(utterance.id); }}
      onFocusCapture={() => { if (utterance) props.markUtteranceSeen(utterance.id); }}>
      <div className="steward-pet-bubble-head">
        <span>Steward notification</span>
        {thinking ? <span className="steward-pet-bubble-source">thinking</span>
          : utterance?.badgeLabel && utterance.badgeTone
            ? <span className={`steward-pet-badge tone-${utterance.badgeTone}`}>{utterance.badgeLabel}</span>
            : utterance?.sourceLabel ? <span className="steward-pet-bubble-source">{utterance.sourceLabel}</span> : null}
      </div>
      {thinking ? <>
        <p className="steward-pet-thinking-status">Thinking…</p>
        {props.thinkingMessage ? <div className="steward-pet-thinking-context">
          <span>You</span>
          <div>{props.thinkingMessage}</div>
        </div> : null}
      </> : utterance ? <p>{utterance.text}</p> : <p className="steward-pet-empty">No new Steward notifications.</p>}
      {interaction && !interactionIsHeadline ? <div className="steward-pet-open-question">
        <span className={`steward-pet-badge tone-${interaction.badgeTone}`}>{interaction.badgeLabel}</span>
        <p>{interaction.text}</p>
      </div> : null}
      {utterance?.reference ? (
        <button type="button" className="steward-pet-reference" onClick={() => props.openReference(utterance.id)}>
          <span aria-hidden="true">◆</span>
          <span><strong>{utterance.reference.label}</strong><small>{utterance.reference.detail}</small></span>
        </button>
      ) : null}
      {actionError ? <small className="steward-pet-action-error">{actionError}</small> : null}
      {!thinking ? <div className="steward-pet-bubble-actions">
        {interaction?.kind === "suggestion" ? <button type="button" className="steward-pet-primary-action"
          disabled={acting} onClick={() => void runNotificationAction(() => props.acceptSuggestion(interaction.id))}>
          {acting ? "Accepting…" : "Accept"}
        </button> : null}
        {interaction?.kind === "proposal" ? <>
          <button type="button" className="steward-pet-primary-action" disabled={acting}
            onClick={() => void runNotificationAction(() => props.respondToProposal(interaction.id, "approve"))}>
            {acting ? "Applying…" : "Approve"}
          </button>
          <button type="button" className="steward-pet-secondary-action" disabled={acting}
            onClick={() => void runNotificationAction(() => props.respondToProposal(interaction.id, "decline"))}>Not now</button>
        </> : null}
        <button type="button" className="steward-pet-dismiss" onClick={() => {
          props.setInlineOpen(false);
          if (utterance) props.dismissUtterance(utterance.id);
        }}>Close</button>
        <button type="button" className="steward-pet-more" onClick={props.openWorklog}>{viewLabel}</button>
      </div> : null}
    </div>
  ) : null;

  const positionStyle = props.position ? {
    left: `${props.position.x}px`,
    top: `${props.position.y}px`,
    right: "auto",
    bottom: "auto",
  } satisfies CSSProperties : undefined;

  return (
    <div ref={rootRef} className={`steward-pet ${props.corner}${props.compact ? " compact" : ""}${dragging ? " dragging" : ""}${props.muted ? " muted" : ""}`}
      data-steward-pet-state={state} style={positionStyle}>
      {bubble}
      <button type="button" className="steward-pet-body"
        aria-label={`Steward — ${stewardPetStatusLabel(state)}${props.actionable ? "; action waiting" : props.unread ? "; new notification" : ""}`}
        title={stewardPetStatusLabel(state)}
        onPointerDown={props.compact ? undefined : beginDrag}
        onPointerMove={props.compact ? undefined : moveDrag}
        onPointerUp={props.compact ? undefined : endDrag}
        onPointerCancel={props.compact ? undefined : endDrag}
        onClick={() => {
          if (draggedRef.current) return;
          if (routeToPlaybookSetup) {
            props.openPlaybookSetup?.();
            return;
          }
          props.setInlineOpen(!props.inlineOpen);
          if (utterance) props.markUtteranceSeen(utterance.id);
        }}
        onContextMenu={(event) => { event.preventDefault(); props.toggleMuted(); }}>
        <span className="steward-pet-zzz" aria-hidden="true">z</span>
        <span className="steward-pet-face" aria-hidden="true">
          <span className="steward-pet-eyes" style={eyeStyle}>{eyes}</span>
          <span className="steward-pet-mouth">{face.mouth}</span>
        </span>
        {props.actionable || props.unread ? <span className={`steward-pet-notification-mark${props.actionable ? " actionable" : ""}`}
          aria-hidden="true">{props.actionable ? "!" : ""}</span> : null}
      </button>
      <span className={`steward-pet-meta${props.compact ? " compact" : ""}`}>
        <span className="steward-pet-name">Steward</span>
        {props.compact && props.setEnabled ? <button
          type="button"
          role="switch"
          aria-label="Steward on/off"
          aria-checked={props.signal.enabled}
          className={`steward-pet-toggle ${props.signal.enabled ? "on" : "off"}${routeToPlaybookSetup ? " locked" : ""}`}
          disabled={props.togglePending || routeToPlaybookSetup}
          title={routeToPlaybookSetup
            ? "The Steward turns on once its Playbook exists — click the Steward to create it"
            : undefined}
          onClick={() => void props.setEnabled?.(!props.signal.enabled)}
        >
          <span className="steward-pet-toggle-track" aria-hidden="true"><i /></span>
          <span>{props.signal.enabled ? "ON" : "OFF"}</span>
        </button> : ticker ? <span className="steward-pet-ticker">{ticker}</span> : null}
      </span>
    </div>
  );
}
