import { useEffect, useState } from "react";
import type {
  CompanionMessageDto,
  CompanionProposalDecision,
  CompanionProposalRespondResult,
  CompanionSuggestionAcceptResult,
  CompanionTranscriptListResult,
  PlaybookGetResult,
  StewardConfigurationGetResult,
  RoutineRuntimeListResult,
} from "@termloop/contract/current";
import type { AgentStatus, Session } from "../model.js";
import {
  StewardPet,
  latestStewardPetUtterance,
  stewardPetPendingUserMessage,
  stewardPetSignal,
  stewardPetUtteranceFromMessages,
  STEWARD_PET_NO_TELEMETRY,
  type StewardPetCorner,
  type StewardPetPosition,
  type StewardPetTelemetry,
  type StewardPetUtterance,
} from "./StewardPet.js";

/**
 * Loads the projections the pet reads and holds its client-local placement.
 * The pet itself stays purely presentational; this host owns nothing durable.
 */
type Props = {
  projectId: string;
  refreshToken: number;
  sessions: readonly Session[];
  agentStatuses: readonly AgentStatus[];
  /** Optional test/presentation override for the projected daemon presence. */
  telemetry?: StewardPetTelemetry;
  utterance?: StewardPetUtterance | null;
  compact?: boolean;
  setEnabled?(enabled: boolean): Promise<void>;
  userBusy: boolean;
  getSteward(): Promise<StewardConfigurationGetResult>;
  /** Uncached narrow poll; PTY presence has no durable invalidation edge. */
  getPresence?(): Promise<StewardConfigurationGetResult>;
  /** When present, a disabled Steward with no Playbook routes the pet to
      Playbook creation instead of offering the enable switch. */
  getPlaybook?(): Promise<PlaybookGetResult>;
  openPlaybookSetup?(): void;
  listTranscript(): Promise<CompanionTranscriptListResult>;
  respondToProposal(proposalMessageId: string, decision: CompanionProposalDecision): Promise<CompanionProposalRespondResult>;
  acceptSuggestion(suggestionMessageId: string): Promise<CompanionSuggestionAcceptResult>;
  listRuntime(): Promise<RoutineRuntimeListResult>;
  openSteward(): void;
  dismissUtterance(utteranceId: string): void;
  openReference(utteranceId: string): void;
};

function mergePetMessages(
  current: readonly CompanionMessageDto[],
  incoming: readonly CompanionMessageDto[],
): CompanionMessageDto[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => right.sequence - left.sequence);
}

export function StewardPetHost(props: Props) {
  const [steward, setSteward] = useState<StewardConfigurationGetResult["configuration"]>(null);
  // Absent until observed, so the pet never flashes the setup route while the
  // Playbook projection is still loading.
  const [playbookMissing, setPlaybookMissing] = useState(false);
  const [presence, setPresence] = useState<StewardPetTelemetry>(STEWARD_PET_NO_TELEMETRY);
  const [reports, setReports] = useState<RoutineRuntimeListResult["reports"]>([]);
  const [messages, setMessages] = useState<CompanionMessageDto[]>([]);
  const [dismissedUtteranceId, setDismissedUtteranceId] = useState<string>();
  const [inlineOpen, setInlineOpen] = useState(false);
  const [loadedProjectId, setLoadedProjectId] = useState<string>();
  const [corner, setCorner] = useState<StewardPetCorner>("bottomLeft");
  const [position, setPosition] = useState<StewardPetPosition | null>(null);
  const [muted, setMuted] = useState(false);
  const [nowEpochMs, setNowEpochMs] = useState(() => Date.now());
  const [seenUtteranceId, setSeenUtteranceId] = useState<string>();
  const [togglePending, setTogglePending] = useState(false);

  useEffect(() => {
    let current = true;
    void Promise.all([
      props.getSteward(),
      props.listTranscript(),
      props.listRuntime(),
      props.getPlaybook?.() ?? Promise.resolve(null),
    ])
      .then(([configuration, transcript, runtime, playbook]) => {
        if (!current) return;
        // Loading a Project is not a new Steward interruption. Keep its latest
        // line available on click without opening the chat automatically.
        const baselineUtteranceId = latestStewardPetUtterance(transcript.messages)?.id;
        setSteward(configuration.configuration);
        setPresence(configuration.presence);
        setPlaybookMissing(playbook !== null
          && (playbook.playbook === null || playbook.playbook.milestones.length === 0));
        setMessages(transcript.messages);
        setSeenUtteranceId(baselineUtteranceId);
        setDismissedUtteranceId(baselineUtteranceId);
        setInlineOpen(false);
        setReports(runtime.reports);
        setLoadedProjectId(props.projectId);
      })
      .catch(() => { if (current) setLoadedProjectId(undefined); });
    return () => { current = false; };
  }, [props.projectId]);

  // PTY output can invalidate the Steward projection many times per second.
  // Keep this narrow timer tied only to Project identity; depending on the
  // refresh token would continuously tear it down before its first tick.
  useEffect(() => {
    let current = true;
    let inFlight = false;
    let handle: number | undefined;
    const refreshPresence = () => {
      if (inFlight) return;
      inFlight = true;
      void (props.getPresence ?? props.getSteward)()
        .then((result) => {
          if (!current) return;
          setSteward(result.configuration);
          setPresence(result.presence);
          setNowEpochMs(Date.now());
        })
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };
    const stop = () => {
      if (handle === undefined) return;
      window.clearInterval(handle);
      handle = undefined;
    };
    const start = (refreshNow: boolean) => {
      if (document.visibilityState === "hidden" || handle !== undefined) return;
      if (refreshNow) refreshPresence();
      handle = window.setInterval(refreshPresence, 1_000);
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") stop();
      else start(true);
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    start(false);
    return () => {
      current = false;
      stop();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [props.projectId]);

  // Composition already coalesces the projection token and single-flights the
  // named reads, so this host does not add a second timing layer.
  useEffect(() => {
    let current = true;
    void Promise.all([
      props.listTranscript(),
      props.listRuntime(),
      props.getPlaybook?.() ?? Promise.resolve(null),
    ])
      .then(([transcript, runtime, playbook]) => {
        if (!current) return;
        setMessages(transcript.messages);
        setReports(runtime.reports);
        if (playbook !== null) {
          setPlaybookMissing(playbook.playbook === null
            || playbook.playbook.milestones.length === 0);
        }
      })
      .catch(() => undefined);
    return () => { current = false; };
  }, [props.projectId, props.refreshToken]);

  useEffect(() => {
    setDismissedUtteranceId(undefined);
    setSeenUtteranceId(undefined);
    setInlineOpen(false);
  }, [props.projectId]);

  // A Project with no Steward configured has no presence to render.
  if (loadedProjectId !== props.projectId || !steward) return null;

  const signal = stewardPetSignal(
    steward,
    props.sessions,
    reports,
    props.telemetry ?? presence,
    props.agentStatuses,
  );
  const ambientUtterance = stewardPetUtteranceFromMessages(messages);
  const latestStewardUtterance = latestStewardPetUtterance(messages);
  const thinkingMessage = stewardPetPendingUserMessage(messages);
  const candidateUtterance = props.utterance === undefined
    ? inlineOpen ? latestStewardUtterance : ambientUtterance
    : props.utterance;
  const utterance = !inlineOpen && candidateUtterance?.id === dismissedUtteranceId
    ? null
    : candidateUtterance;
  const setEnabled = async (enabled: boolean) => {
    if (!props.setEnabled || togglePending) return;
    setTogglePending(true);
    try {
      await props.setEnabled(enabled);
      setSteward((current) => current ? { ...current, enabled } : current);
    } finally {
      setTogglePending(false);
    }
  };

  return <StewardPet
    signal={signal}
    nowEpochMs={nowEpochMs}
    utterance={utterance}
    thinkingMessage={thinkingMessage}
    unread={Boolean(utterance && utterance.id !== seenUtteranceId)}
    actionable={Boolean(ambientUtterance?.interaction)}
    inlineOpen={inlineOpen}
    muted={muted}
    {...(props.compact ? { compact: true } : {})}
    {...(props.compact && props.setEnabled ? { setEnabled, togglePending } : {})}
    {...(props.openPlaybookSetup ? { playbookMissing, openPlaybookSetup: props.openPlaybookSetup } : {})}
    userBusy={props.userBusy}
    corner={corner}
    position={position}
    openWorklog={props.openSteward}
    respondToProposal={async (proposalMessageId, decision) => {
      const result = await props.respondToProposal(proposalMessageId, decision);
      setMessages((current) => mergePetMessages(current, [result.message]));
      setSeenUtteranceId(result.message.id);
      setDismissedUtteranceId(undefined);
    }}
    acceptSuggestion={async (suggestionMessageId) => {
      const result = await props.acceptSuggestion(suggestionMessageId);
      setMessages((current) => mergePetMessages(current, [result.message]));
      setSeenUtteranceId(result.message.id);
      setDismissedUtteranceId(undefined);
    }}
    dismissUtterance={(utteranceId) => {
      setSeenUtteranceId(utteranceId);
      setDismissedUtteranceId(utteranceId);
      props.dismissUtterance(utteranceId);
    }}
    openReference={props.openReference}
    setInlineOpen={setInlineOpen}
    markUtteranceSeen={setSeenUtteranceId}
    moveTo={(nextPosition, nextCorner) => {
      setPosition(nextPosition);
      setCorner(nextCorner);
    }}
    toggleMuted={() => setMuted((value) => !value)}
  />;
}
