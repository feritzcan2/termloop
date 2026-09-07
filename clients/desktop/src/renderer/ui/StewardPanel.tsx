import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AgentCapabilityDto, AssistantPromptContextDto, CompanionMessageDto, CompanionTranscriptAppendResult,
  CompanionProposalDecision, CompanionProposalRespondResult, CompanionSuggestionAcceptResult,
  CompanionTranscriptClearResult,
  CompanionTranscriptListResult, StewardAgentId, StewardConfigurationDto,
  StewardConfigurationGetResult, StewardConfigurationSetResult, RoutineConfigurationCreateParams,
  RoutineConfigurationDeleteResult, RoutineConfigurationDto, RoutineConfigurationListResult,
  RoutineConfigurationMutationResult, RoutineConfigurationUpdateParams, RoutineHealthDto,
  RoutineReportDto, RoutineRuntimeListResult,
  RoutineRunNowResult,
  PlaybookDto, PlaybookGetResult, PlaybookMilestoneDto, PlaybookRuntimeResult, PlaybookUpdateParams,
  AssistantPromptImproverTarget,
} from "@termloop/contract/current";
import { assistantInitialView, defaultAssistantLaunchSelection, requestPlaybookBuilderSetup, routineIntervalLabel, type AssistantSelection, type AssistantView } from "./AssistantRail.js";
import { Icon } from "./Icon.js";
import { QUICK_ACTION_AGENT_MODELS, QUICK_ACTION_AGENT_PERMISSIONS, QUICK_ACTION_AGENT_REASONING, type QuickActionReasoning } from "../quick-action-memory.js";
import { ConfigurationVersions, PromptImproveButton, promptImprovementActionLabel, usePromptImprovement, type PromptImprovement } from "./PromptImprovement.js";
import { assistantInstructionsEditableSuffix } from "../prompt-settings.js";
import { routineDisplayStatus, statusExplanation } from "./assistant-status.js";
import { CompanionTopicCard, currentStewardInteraction, groupCompanionTopics } from "./companion-chat.js";

export { assistantInstructionsEditableSuffix };

type AssistantReasoning = QuickActionReasoning;
type AssistantPermission = StewardConfigurationDto["permission"];

export type StewardPanelProps = {
  projectId: string; projectName: string; selection: AssistantSelection; refreshToken: number;
  agentCapabilities: readonly AgentCapabilityDto[]; close(): void; openTerminal(sessionId: string): void;
  playbookBuilderSessionId?: string | undefined;
  openTermLoopInstructions(): void;
  renderTerminal(sessionId: string): ReactNode;
  getConfiguration(): Promise<StewardConfigurationGetResult>;
  setConfiguration(agentId: StewardAgentId, model: string, permission: AssistantPermission, reasoning: AssistantReasoning, enabled: boolean, systemPrompt: string, expectedRevision: number): Promise<StewardConfigurationSetResult>;
  listTranscript(beforeSequence?: number): Promise<CompanionTranscriptListResult>;
  appendMessage(content: string): Promise<CompanionTranscriptAppendResult>;
  respondToProposal(proposalMessageId: string, decision: CompanionProposalDecision): Promise<CompanionProposalRespondResult>;
  acceptSuggestion(suggestionMessageId: string): Promise<CompanionSuggestionAcceptResult>;
  clearTranscript(expectedRevision: number): Promise<CompanionTranscriptClearResult>;
  listRoutines(): Promise<RoutineConfigurationListResult>;
  createRoutine(params: RoutineConfigurationCreateParams): Promise<RoutineConfigurationMutationResult>;
  updateRoutine(params: RoutineConfigurationUpdateParams): Promise<RoutineConfigurationMutationResult>;
  updateRoutineContext(routineId: string, contextMarkdown: string, expectedContextRevision: number, expectedRevision: number): Promise<RoutineConfigurationMutationResult>;
  deleteRoutine(routineId: string, expectedRevision: number): Promise<RoutineConfigurationDeleteResult>;
  listRoutineRuntime(): Promise<RoutineRuntimeListResult>;
  runRoutineNow(routineId: string): Promise<RoutineRunNowResult>;
  getPlaybook(): Promise<PlaybookGetResult>;
  getPlaybookRuntime(): Promise<PlaybookRuntimeResult>;
  /// Improve-with-agent for editable prompts and the Playbook on this panel. Absent
  /// when the composition root has not wired it, which leaves the editors
  /// exactly as they were.
  promptImprovement?: PromptImprovement | undefined;
  setupPromptImprovement(target: AssistantPromptImproverTarget): void;
};

/** The daemon's own words for a lost compare-and-set race. */
export function isRevisionConflict(cause: unknown): boolean {
  return String(cause instanceof Error ? cause.message : cause).includes("state revision changed");
}

/** What the sidebar or board says when a change is refused: the daemon's own sentence
    when it named a rule the user can act on, and a plain retry line when all it
    reported was that a write did not land. A bare "constraint violation" tells
    the user nothing, so it is not repeated at them.

    The transport's own wrapper is stripped first. "Error invoking remote method
    'termloop:routine-configuration-delete'" names an Electron IPC channel, not
    anything the user can act on, and burying the real sentence behind it makes
    a plain rule read like a crash. */
export function assistantRefusalMessage(cause: unknown): string {
  const said = String(cause instanceof Error ? cause.message : cause)
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
    .trim();
  return said === "" || said.startsWith("store failed")
    ? "The change didn't apply. Try again."
    : said;
}

/** How many times a write may re-cite the revision before giving up. The
    revision is global, so a Routine finishing or the Steward
    writing moves it — none of which has anything to do with the change being
    made. One retry loses that race often enough to surface as a failure the
    user cannot act on, and each extra attempt costs one read. */
const REVISION_ATTEMPTS = 4;

/** The store revision a write cites can move for reasons the user never caused:
    enabling the Steward launches its Session, and the daemon's own write lands
    between two of our calls. The intent has not changed — only the ticket — so
    a lost race is answered by reading the current revision and trying again.
    Anything else is a real failure and is left to the caller. This matters most
    in a chain like adopting a template, where stopping halfway would leave
    provisioned Routines with no document. */
export async function withCurrentRevision<T>(
  cited: number,
  readRevision: () => Promise<number>,
  attempt: (expectedRevision: number) => Promise<T>,
): Promise<T> {
  let expectedRevision = cited;
  for (let remaining = REVISION_ATTEMPTS - 1; ; remaining -= 1) {
    try {
      return await attempt(expectedRevision);
    } catch (cause) {
      if (remaining === 0 || !isRevisionConflict(cause)) throw cause;
      expectedRevision = await readRevision();
    }
  }
}

/** Retires the Routine behind a question the board no longer asks.

    Deleting it is one write: the daemon takes the Routine's remaining pipeline
    steps with it and does not refuse one that is still on or mid-run. What is
    left to handle is a lost revision race, retried against the current one, and
    a refusal, which comes back as words instead of escaping as an unhandled
    call. */
export async function retireStepRoutine(
  routineId: string,
  citedRevision: number,
  deps: {
    currentRevision(): Promise<number>;
    deleteRoutine(routineId: string, expectedRevision: number): Promise<RoutineConfigurationDeleteResult>;
  },
): Promise<{ stateRevision: number } | { error: string }> {
  try {
    const result = await withCurrentRevision(citedRevision, deps.currentRevision, (expectedRevision) =>
      deps.deleteRoutine(routineId, expectedRevision));
    return { stateRevision: result.stateRevision };
  } catch (cause) {
    return { error: assistantRefusalMessage(cause) };
  }
}

export function stewardPanelIdentity(projectId: string, selection: AssistantSelection = { kind: "steward" }): string {
  if (selection.kind === "steward") return `${projectId}:steward`;
  return `${projectId}:routine:${selection.routineId}`;
}
export function assistantTerminalSessionId(
  selection: AssistantSelection,
  steward: StewardConfigurationGetResult["configuration"],
): string | null {
  if (selection.kind === "steward") return steward?.executorSessionId ?? null;
  return null;
}
export function mergeCompanionMessages(current: readonly CompanionMessageDto[], incoming: readonly CompanionMessageDto[]): CompanionMessageDto[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => right.sequence - left.sequence);
}
/* Both mirror Core's answered-interaction rule: the newest Steward suggestion
   or proposal after the newest user-authored message. Steward status messages
   (reply, update, attention, problem, action) never clear an open question, so
   ProposalRespond still accepts a proposal that later status updates buried. */
export function pendingCompanionProposalId(messages: readonly CompanionMessageDto[]): string | null {
  const interaction = currentStewardInteraction(messages);
  return interaction?.kind === "proposal" ? interaction.id : null;
}
export function actionableCompanionSuggestionId(messages: readonly CompanionMessageDto[]): string | null {
  const interaction = currentStewardInteraction(messages);
  return interaction?.kind === "suggestion" ? interaction.id : null;
}

export type PlaybookOnboardingCta = { action: "setup" } | { action: "open" } | null;

export function playbookOnboardingCta(
  playbook: PlaybookDto | null,
  builderSessionId: string | undefined,
): PlaybookOnboardingCta {
  if (playbook !== null && playbook.milestones.length > 0) return null;
  return builderSessionId ? { action: "open" } : { action: "setup" };
}
export function upsertRoutineConfiguration(current: readonly RoutineConfigurationDto[], incoming: RoutineConfigurationDto): RoutineConfigurationDto[] {
  const existing = current.find((candidate) => candidate.id === incoming.id);
  if (existing && (existing.generation > incoming.generation || (existing.generation === incoming.generation && existing.updatedAtEpochMs > incoming.updatedAtEpochMs))) return [...current];
  return existing ? current.map((candidate) => candidate.id === incoming.id ? incoming : candidate) : [...current, incoming];
}
export function routineInstructionsUpdateParams(
  routine: RoutineConfigurationDto,
  instructions: string,
  expectedRevision: number,
): RoutineConfigurationUpdateParams {
  return {
    routineId: routine.id,
    triggerMode: routine.triggerMode,
    name: routine.name,
    instructions,
    whileWaiting: routine.whileWaiting,
    enabled: routine.enabled,
    scheduleIntervalSeconds: routine.scheduleIntervalSeconds,
    expectedRevision,
  };
}
export function routineStewardInstructionsUpdateParams(
  routine: RoutineConfigurationDto,
  stewardInstructions: string,
  expectedRevision: number,
): RoutineConfigurationUpdateParams {
  return {
    ...routineInstructionsUpdateParams(routine, routine.instructions, expectedRevision),
    whileWaiting: { ...routine.whileWaiting, instructions: stewardInstructions },
  };
}
export function routineActionHandlingUpdateParams(
  routine: RoutineConfigurationDto,
  actionHandling: RoutineConfigurationDto["whileWaiting"]["mode"],
  expectedRevision: number,
): RoutineConfigurationUpdateParams {
  return {
    ...routineInstructionsUpdateParams(routine, routine.instructions, expectedRevision),
    whileWaiting: { ...routine.whileWaiting, mode: actionHandling },
  };
}
export function playbookRoutineRetryDelaySeconds(
  playbook: PlaybookDto | null,
  routineId: string,
): number | undefined {
  return playbookRoutineStep(playbook, routineId)?.retryDelaySeconds;
}

export function playbookRoutineCompletionEvidence(
  playbook: PlaybookDto | null,
  routineId: string,
): string | undefined {
  return playbookRoutineStep(playbook, routineId)?.completeWhen;
}

function playbookRoutineStep(
  playbook: PlaybookDto | null,
  routineId: string,
): PlaybookMilestoneDto | undefined {
  const active = playbook?.milestones.find((milestone) => milestone.routineId === routineId);
  if (active) return active;
  for (const pipeline of playbook?.savedPipelines ?? []) {
    const kept = pipeline.milestones.find((milestone) => milestone.routineId === routineId);
    if (kept) return kept;
  }
  return undefined;
}
type AssistantAvailability = "proven" | "unavailable" | "unknown";
export function capabilityMark(value: AssistantAvailability): "✓" | "✕" | "?" { return value === "proven" ? "✓" : value === "unavailable" ? "✕" : "?"; }
export function capabilityCopy(value: AssistantAvailability, agentId: StewardAgentId): string {
  if (value === "proven") return "CLI available · uses your signed-in terminal subscription";
  if (value === "unavailable") return "Agent unavailable";
  if (agentId === "claude") return "Sign in with the Claude CLI subscription, then restart to recheck";
  return "Codex CLI availability could not be confirmed";
}
export function stewardReplyAvailabilityCopy(enabled: boolean, capability: AssistantAvailability): string | undefined {
  return enabled ? undefined : capability === "proven" ? "Messages are saved, but the Steward replies only when enabled and saved." : "Messages are saved, but no agent will reply until an available CLI shows green and the Steward is enabled and saved.";
}
export function companionSupervisorCopy(value: StewardConfigurationGetResult["supervisorAvailability"]): string {
  return value === "available" ? "Companion online" : value === "starting" ? "Companion starting…" : "Companion unavailable";
}
export function routineProblemRecoveryCopy(): string {
  return "Fixed it? Restart the Project Steward from the sidebar.";
}
export function routineTimeCopy(value: number | null): string {
  return value === null ? "Never" : new Date(value).toLocaleString();
}
/* Assistants are configured from the sidebar (agent choice, on/off, add and
   remove); the panel keeps only the surfaces the sidebar cannot host. */
export function assistantTabs(
  kind: AssistantSelection["kind"],
  hasPlaybookBuilder = false,
  firstRunLocked = false,
): readonly (readonly [AssistantView, string])[] {
  /* Before the Steward exists there is nothing to chat with or configure —
     the Builder conversation is the whole panel. */
  if (kind === "steward" && firstRunLocked) {
    return hasPlaybookBuilder ? [["builder", "Builder"]] as const : [];
  }
  if (kind === "steward") return [
    ["chat", "Workspace"],
    ...(hasPlaybookBuilder ? [["builder", "Builder"]] as const : []),
    ["configuration", "Config"],
  ];
  return [["context", "Context"]];
}
export function StewardPanel(props: StewardPanelProps) {
  const [view, setView] = useState<AssistantView>(() => assistantInitialView(props.selection));
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string>();
  const [steward, setSteward] = useState<StewardConfigurationGetResult["configuration"]>(null);
  const [stewardPromptContext, setStewardPromptContext] = useState<AssistantPromptContextDto>();
  const [stewardRevision, setStewardRevision] = useState(0);
  const [messages, setMessages] = useState<CompanionMessageDto[]>([]); const [draft, setDraft] = useState("");
  const [routines, setRoutines] = useState<RoutineConfigurationDto[]>([]); const [routineRevision, setRoutineRevision] = useState(0);
  const [playbook, setPlaybook] = useState<PlaybookDto | null>(null);
  const [reports, setReports] = useState<RoutineReportDto[]>([]);
  const [routineHealth, setRoutineHealth] = useState<RoutineHealthDto[]>([]);
  const [busy, setBusy] = useState(false);
  const selectedRoutineId = props.selection.kind === "routine" ? props.selection.routineId : undefined;
  const selectedRoutine = selectedRoutineId ? routines.find((routine) => routine.id === selectedRoutineId) : undefined;
  const selectedRoutineHealth = selectedRoutineId ? routineHealth.find((health) => health.routineId === selectedRoutineId) : undefined;
  const sessionId = assistantTerminalSessionId(props.selection, steward);
  const openTerminalRef = useRef(props.openTerminal);
  useEffect(() => { openTerminalRef.current = props.openTerminal; }, [props.openTerminal]);
  // Provisioning a Playbook's step Routines issues several creates inside one
  // save, and each one advances the store revision the next must cite; React
  // state would still hold the revision this render closed over.
  const routineRevisionRef = useRef(routineRevision);
  useEffect(() => { routineRevisionRef.current = routineRevision; }, [routineRevision]);

  // Rounds overlap whenever the daemon answers slower than the projection
  // moves, and their answers can arrive out of order. Only the newest round may
  // write state, so a superseded answer cannot revert the panel or raise an
  // error over data that already loaded.
  const loadGeneration = useRef(0);
  const load = async () => {
    const generation = ++loadGeneration.current;
    try {
      const [configuration, transcript, routineList, runtime, playbookResult] = await Promise.all([
        props.getConfiguration(), props.listTranscript(), props.listRoutines(), props.listRoutineRuntime(), props.getPlaybook(),
      ]);
      if (generation !== loadGeneration.current) return;
      setSteward(configuration.configuration); setStewardPromptContext(configuration.promptContext); setStewardRevision(configuration.stateRevision);
      setMessages(transcript.messages);
      setRoutines(routineList.configurations); setRoutineRevision(routineList.stateRevision);
      setPlaybook(playbookResult.playbook);
      setReports(runtime.reports); setRoutineHealth(runtime.health); setLoading(false); setError(undefined);
    } catch (cause) {
      if (generation !== loadGeneration.current) return;
      setLoading(false); setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  useEffect(() => { void load(); }, [props.projectId, props.refreshToken]);
  useEffect(() => { setView(assistantInitialView(props.selection)); }, [props.selection.kind, props.selection.initialView,
    props.selection.kind === "routine" ? props.selection.routineId : "steward"]);
  const previousPlaybookBuilderSessionId = useRef(props.playbookBuilderSessionId);
  useEffect(() => {
    const previous = previousPlaybookBuilderSessionId.current;
    previousPlaybookBuilderSessionId.current = props.playbookBuilderSessionId;
    if (view === "builder" && previous && !props.playbookBuilderSessionId) setView("chat");
  }, [props.playbookBuilderSessionId, view]);
  useEffect(() => {
    const visibleSessionId = view === "builder" ? props.playbookBuilderSessionId : sessionId;
    const terminalVisible = view === "terminal" || view === "builder"
      || (props.selection.kind === "steward" && view === "chat");
    if (terminalVisible && visibleSessionId) openTerminalRef.current(visibleSessionId);
  }, [props.playbookBuilderSessionId, props.selection.kind, sessionId, view]);

  const run = async (action: () => Promise<void>) => { setBusy(true); setError(undefined); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const runSelectedRoutineNow = () => run(async () => {
    if (!selectedRoutine) return;
    await props.runRoutineNow(selectedRoutine.id);
    await load();
  });
  /* Mirrors the rail's first-run lock; while projections load, keep the normal
     tabs instead of flashing the locked layout at every configured Steward. */
  const stewardFirstRunLocked = !loading
    && props.selection.kind === "steward"
    && !(steward?.enabled ?? false)
    && (playbook === null || playbook.milestones.length === 0);
  useEffect(() => {
    if (stewardFirstRunLocked && view !== "builder") setView("builder");
  }, [stewardFirstRunLocked, view]);
  const tabs = assistantTabs(props.selection.kind, Boolean(props.playbookBuilderSessionId), stewardFirstRunLocked);

  const appendVisibleMessage = async (content: string) => {
    const result = await props.appendMessage(content);
    setMessages((value) => mergeCompanionMessages(value, [result.message]));
  };
  const respondToVisibleProposal = async (proposalMessageId: string, decision: CompanionProposalDecision) => {
    const result = await props.respondToProposal(proposalMessageId, decision);
    setMessages((value) => mergeCompanionMessages(value, [result.message]));
  };
  const acceptVisibleSuggestion = async (suggestionMessageId: string) => {
    const result = await props.acceptSuggestion(suggestionMessageId);
    setMessages((value) => mergeCompanionMessages(value, [result.message]));
  };
  const sendMessage = async () => {
    const content = draft.trim();
    if (!content) return;
    await appendVisibleMessage(content);
    setDraft("");
  };

  const pendingProposalId = pendingCompanionProposalId(messages);
  const actionableSuggestionId = actionableCompanionSuggestionId(messages);
  const onboarding = playbookOnboardingCta(playbook, props.playbookBuilderSessionId);
  const chat = <section className="ap-chat">
    <div className={`ap-approval-status${pendingProposalId ? " pending" : actionableSuggestionId ? " suggestion" : ""}`}>
      <span aria-hidden="true">{pendingProposalId ? "!" : actionableSuggestionId ? "→" : "✓"}</span>
      {pendingProposalId
        ? "Approval requested — use the buttons on its card below."
        : actionableSuggestionId
          ? "Suggestion available — accept it on its card below."
          : "No approval requested"}
    </div>
    {!playbook?.milestones.length && onboarding ? <div className="ap-playbook-onboarding">
      <div className="ap-playbook-onboarding-copy">
        <strong>No Playbook yet</strong>
        <p>A Playbook is the delivery pipeline the Steward walks this Project&apos;s Tasks through.
          Build it with an agent in a short guided conversation — nothing runs until you approve it.
          The Steward stays off until the Playbook exists.</p>
      </div>
      <button type="button" className="ap-btn primary"
        onClick={() => onboarding.action === "open"
          ? setView("builder")
          : requestPlaybookBuilderSetup(props.setupPromptImprovement)}>
        {onboarding.action === "open" ? "Open the Builder" : "Build pipeline with agent"}
      </button>
    </div> : null}
    <div className="ap-thread">
      {groupCompanionTopics(messages).map((group) => <CompanionTopicCard
        key={group.id}
        group={group}
        messages={messages}
        pendingProposalId={pendingProposalId}
        actionableSuggestionId={actionableSuggestionId}
        busy={busy}
        respond={(proposalMessageId, decision) => { void run(() => respondToVisibleProposal(proposalMessageId, decision)); }}
        acceptSuggestion={(suggestionMessageId) => { void run(() => acceptVisibleSuggestion(suggestionMessageId)); }}
      />)}
      {messages.length === 0 ? <div className="ap-thread-empty">
        <span className="ap-thread-face" aria-hidden="true">• •</span>
        <strong>Talk to your Steward</strong>
        <p>Ask about this Project&apos;s Tasks, running agents, and routines.</p>
        {onboarding ? <p className="ap-thread-empty-hint">
          New here? Start with the card above — an agent builds this Project&apos;s Playbook with you.
        </p> : null}
      </div> : null}
    </div>
    <div className="ap-composer">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (!busy && draft.trim()) void run(sendMessage);
        }}
        placeholder="Message the Steward…"
        aria-label="Message the Steward"
      />
      <button type="button" className="ap-btn primary" disabled={busy || !draft.trim()} onClick={() => run(sendMessage)}>Send</button>
    </div>
  </section>;

  const assistantEnabled = steward?.enabled === true;
  const terminal = sessionId ? props.renderTerminal(sessionId) : <Empty text={assistantEnabled
    ? "This assistant is restarting. Its terminal will appear automatically."
    : "Enable and save this assistant to start its persistent terminal."} />;
  const stewardWorkspace = <div className="ap-steward-workspace">
    <section className="ap-steward-split-pane">
      <header className="ap-steward-split-header">Chat</header>
      <div className="ap-steward-split-content">{chat}</div>
    </section>
    <section className="ap-steward-split-pane terminal">
      <header className="ap-steward-split-header">Terminal</header>
      <div className="ap-steward-split-content">{terminal}</div>
    </section>
  </div>;
  const selectedRoutineRetryDelaySeconds = selectedRoutine
    ? playbookRoutineRetryDelaySeconds(playbook, selectedRoutine.id)
    : undefined;
  const selectedRoutineCompletionEvidence = selectedRoutine
    ? playbookRoutineCompletionEvidence(playbook, selectedRoutine.id)
    : undefined;
  const context = selectedRoutine ? <RoutineContextEditor
    key={`${selectedRoutine.id}:${selectedRoutine.generation}:${selectedRoutine.contextRevision}`}
    routine={selectedRoutine}
    stepRetryDelaySeconds={selectedRoutineRetryDelaySeconds}
    completionEvidence={selectedRoutineCompletionEvidence}
    health={selectedRoutineHealth}
    reports={reports.filter((report) => report.routineId === selectedRoutine.id)}
    busy={busy}
    improvement={props.promptImprovement}
    setupImprovement={() => props.setupPromptImprovement({ surface: "routineInstructions", ownerId: selectedRoutine.id })}
    runNow={runSelectedRoutineNow}
    reload={() => run(async () => {
      const refreshed = await props.listRoutines();
      setRoutines(refreshed.configurations);
      setRoutineRevision(refreshed.stateRevision);
    })}
    save={(nextContext) => run(async () => {
      const result = await props.updateRoutineContext(
        selectedRoutine.id,
        nextContext,
        selectedRoutine.contextRevision,
        routineRevision,
      );
      setRoutines((current) => upsertRoutineConfiguration(current, result.configuration));
      setRoutineRevision(result.stateRevision);
    })}
    saveInstructions={(nextPrompt) => run(async () => {
      const result = await props.updateRoutine(routineInstructionsUpdateParams(
        selectedRoutine,
        nextPrompt,
        routineRevision,
      ));
      setRoutines((current) => upsertRoutineConfiguration(current, result.configuration));
      setRoutineRevision(result.stateRevision);
    })}
    saveStewardInstructions={(nextInstructions) => run(async () => {
      const result = await props.updateRoutine(routineStewardInstructionsUpdateParams(
        selectedRoutine,
        nextInstructions,
        routineRevision,
      ));
      setRoutines((current) => upsertRoutineConfiguration(current, result.configuration));
      setRoutineRevision(result.stateRevision);
    })}
    saveActionHandling={(actionHandling) => run(async () => {
      const result = await props.updateRoutine(routineActionHandlingUpdateParams(
        selectedRoutine,
        actionHandling,
        routineRevision,
      ));
      setRoutines((current) => upsertRoutineConfiguration(current, result.configuration));
      setRoutineRevision(result.stateRevision);
    })}
  /> : <Empty text="Routine not found." />;
  const stewardConfiguration = stewardPromptContext ? <section className="ap-config">
    <ConfigIntroduction role="Steward" />
    {steward ? <AssistantLaunchSettings role="Steward" agentId={steward.agentId} model={steward.model}
      permission={steward.permission} reasoning={steward.reasoning} busy={busy} save={(model, permission, reasoning) => run(async () => {
        const result = await props.setConfiguration(
          steward.agentId, model, permission, reasoning, steward.enabled, steward.systemPrompt, stewardRevision,
        );
        setSteward(result.configuration);
        setStewardRevision(result.stateRevision);
      })} /> : null}
    <StewardSystemPromptCard
    context={stewardPromptContext}
    busy={busy}
    improvement={props.promptImprovement}
    setupImprovement={() => props.setupPromptImprovement({ surface: "stewardInstructions", ownerId: null })}
    openTermLoopInstructions={props.openTermLoopInstructions}
    reload={() => run(async () => {
      const refreshed = await props.getConfiguration();
      setSteward(refreshed.configuration);
      setStewardPromptContext(refreshed.promptContext);
      setStewardRevision(refreshed.stateRevision);
    })}
    save={(nextPrompt) => run(async () => {
      const launch = steward
        ? { model: steward.model, permission: steward.permission, reasoning: steward.reasoning }
        : defaultAssistantLaunchSelection("codex");
      await props.setConfiguration(
        steward?.agentId ?? "codex",
        launch.model,
        launch.permission,
        launch.reasoning,
        steward?.enabled ?? false,
        nextPrompt,
        stewardRevision,
      );
      const refreshed = await props.getConfiguration();
      setSteward(refreshed.configuration);
      setStewardPromptContext(refreshed.promptContext);
      setStewardRevision(refreshed.stateRevision);
    })}
  />
    <WakePromptDetails context={stewardPromptContext} role="Steward" />
  </section> : <Empty text="Steward prompt context is unavailable." />;
  const playbookBuilderTerminal = props.playbookBuilderSessionId
    ? props.renderTerminal(props.playbookBuilderSessionId)
    : <Empty text="Start the Pipeline Builder from the sidebar editor." />;
  const headerAgentId = steward?.agentId ?? null;
  const headerTitle = props.selection.kind === "steward" ? "Project Steward"
    : selectedRoutine?.name ?? "Routine";
  const agentDisplayName = headerAgentId === "claude" ? "Claude" : headerAgentId === "codex" ? "Codex" : null;
  const headerSubtitle = props.selection.kind === "steward"
    ? (steward && agentDisplayName ? `${agentDisplayName} · Project coordinator` : "Not configured")
    : selectedRoutine ? `Project Steward · ${selectedRoutineRetryDelaySeconds === undefined
        ? "On demand"
        : `${routineIntervalLabel(selectedRoutineRetryDelaySeconds)} while waiting`}` : "Routine";

  return <section className="steward-panel workspace-assistant-panel" data-assistant={stewardPanelIdentity(props.projectId, props.selection)}>
    <header className="ap-header">
      <span className={`ap-avatar${headerAgentId ? ` agent-${headerAgentId}` : ""}`} aria-hidden="true"><Icon name={headerAgentId ?? "agent"} /></span>
      <div className="ap-heading">
        <span className="ap-eyebrow">{props.selection.kind === "routine" ? "Routine" : "Project assistant"}</span>
        <h1>{headerTitle}</h1>
        <p>{headerSubtitle}</p>
      </div>
      <button type="button" className="ap-close" aria-label="Close" onClick={props.close}><Icon name="close" /></button>
    </header>
    {tabs.length > 1 ? <nav className="ap-tabs">{tabs.map(([id, label]) => <button type="button"
      className={view === id ? "active" : ""}
      key={id} onClick={() => setView(id)}>{label}</button>)}</nav> : null}
    {error ? <p className="ap-error">{error}</p> : null}
    <div className={`ap-body${view === "terminal" || view === "builder" || (props.selection.kind === "steward" && view === "chat") ? " terminal-active" : ""}`}>{loading ? <Empty text="Loading…" />
      : props.selection.kind === "routine" ? context
      : view === "builder" ? playbookBuilderTerminal
      : view === "configuration" ? stewardConfiguration : stewardWorkspace}</div>
  </section>;
}

function Empty({ text }: { text: string }) { return <p className="ap-empty">{text}</p>; }

function ConfigIntroduction({ role }: { role: "Steward" }) {
  return <header className="ap-config-intro">
    <span>Visible prompt pipeline</span>
    <h2>{role} configuration</h2>
    <p>The exact TermLoop-delivered instructions are visible below. Activation and later wake messages travel separately through the terminal.</p>
  </header>;
}

function AssistantLaunchSettings(props: {
  role: "Steward";
  agentId: StewardAgentId;
  model: string;
  permission: AssistantPermission;
  reasoning: AssistantReasoning;
  busy: boolean;
  save(model: string, permission: AssistantPermission, reasoning: AssistantReasoning): Promise<void>;
}) {
  const [model, setModel] = useState(props.model);
  const [permission, setPermission] = useState<AssistantPermission>(props.permission);
  const [reasoning, setReasoning] = useState<AssistantReasoning>(props.reasoning);
  useEffect(() => {
    setModel(props.model);
    setPermission(props.permission);
    setReasoning(props.reasoning);
  }, [props.model, props.permission, props.reasoning]);
  const changed = model !== props.model || permission !== props.permission || reasoning !== props.reasoning;
  return <section className="ap-form ap-launch-settings">
    <div className="ap-editor">
      <div className="ap-editor-head"><label>{props.role} launch settings</label><small>{props.agentId}</small></div>
      <p className="ap-hint">The selected model, permission mode, and reasoning effort apply to every fresh launch and restart of this assistant.</p>
      <div className="ap-launch-fields">
        <label>Model<select aria-label={`${props.role} model`} value={model} onChange={(event) => setModel(event.target.value)}>
          {(QUICK_ACTION_AGENT_MODELS[props.agentId] ?? ["default"]).map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>Permission<select aria-label={`${props.role} permission`} value={permission}
          onChange={(event) => setPermission(event.target.value as AssistantPermission)}>
          {QUICK_ACTION_AGENT_PERMISSIONS.map((value) => <option key={value} value={value}>{permissionLabel(props.agentId, value)}</option>)}
        </select></label>
        <label>Reasoning<select aria-label={`${props.role} reasoning`} value={reasoning}
          onChange={(event) => setReasoning(event.target.value as AssistantReasoning)}>
          {QUICK_ACTION_AGENT_REASONING.map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
      <div className="ap-actions"><button type="button" className="ap-btn primary" disabled={props.busy || !changed}
        onClick={() => void props.save(model, permission, reasoning)}>Save &amp; restart {props.role}</button></div>
    </div>
  </section>;
}

function permissionLabel(agentId: StewardAgentId, permission: AssistantPermission): string {
  if (agentId === "claude" && permission === "bypassPermissions") return "auto";
  if (permission === "default") return "ask";
  if (permission === "acceptEdits") return "accept edits";
  if (permission === "bypassPermissions") return "bypass";
  return permission;
}

function WakePromptDetails(props: { context: AssistantPromptContextDto; role: "Steward" }) {
  return <section className="ap-prompt-projections" aria-label={`${props.role} delivered prompt context`}>
    <details className="ap-details" open>
      <summary>Initial activation · terminal input</summary>
      <p className="ap-hint">The small first user message sent after the provider-native instructions are installed.</p>
      <pre>{props.context.initialPrompt}</pre>
    </details>
    <details className="ap-details">
      <summary>Wake message · terminal input</summary>
      <p className="ap-hint">The ordinary message TermLoop writes when this persistent {props.role} is activated again.</p>
      <pre>{props.context.wakePrompt}</pre>
    </details>
  </section>;
}

export function RoutineContextEditor(props: {
  routine: RoutineConfigurationDto;
  stepRetryDelaySeconds?: number | undefined;
  completionEvidence?: string | undefined;
  health: RoutineHealthDto | undefined;
  reports: readonly RoutineReportDto[];
  busy: boolean;
  improvement?: PromptImprovement | undefined;
  setupImprovement(): void;
  runNow(): Promise<void>;
  save(contextMarkdown: string): Promise<void>;
  saveInstructions(instructions: string): Promise<void>;
  saveStewardInstructions(instructions: string): Promise<void>;
  saveActionHandling(actionHandling: RoutineConfigurationDto["whileWaiting"]["mode"]): Promise<void>;
  reload(): Promise<void>;
}) {
  const [context, setContext] = useState(props.routine.contextMarkdown);
  const [instructions, setInstructions] = useState(props.routine.instructions);
  const [stewardInstructions, setStewardInstructions] = useState(props.routine.whileWaiting.instructions);
  useEffect(() => { setInstructions(props.routine.instructions); }, [props.routine.instructions]);
  useEffect(() => { setStewardInstructions(props.routine.whileWaiting.instructions); }, [props.routine.whileWaiting.instructions]);
  const contextByteLength = new TextEncoder().encode(context).length;
  const instructionsByteLength = new TextEncoder().encode(instructions).length;
  const stewardInstructionsByteLength = new TextEncoder().encode(stewardInstructions).length;
  const improver = usePromptImprovement(
    props.improvement,
    { surface: "routineInstructions", ownerId: props.routine.id },
    { watch: true },
  );
  const status = routineDisplayStatus(props.routine, props.health);
  return <section className="ap-routine-context">
    <div className="ap-run-strip">
      <span className="ap-fact"><small>{props.routine.triggerMode === "onDemand" ? "Step cadence" : "Schedule"}</small>
        <strong>{props.routine.triggerMode === "onDemand"
          ? props.stepRetryDelaySeconds === undefined ? "On demand" : routineIntervalLabel(props.stepRetryDelaySeconds)
          : routineIntervalLabel(props.routine.scheduleIntervalSeconds)}</strong></span>
      <span className="ap-fact"><small>Last run</small><strong>{routineTimeCopy(props.health?.lastAttemptAtEpochMs ?? null)}</strong></span>
      <span className="ap-fact"><small>Next run</small><strong>{routineTimeCopy(props.health?.nextDueAtEpochMs ?? null)}</strong></span>
      <button type="button" className="ap-btn primary" disabled={props.busy || !props.routine.enabled || props.health?.state === "checking"} onClick={() => void props.runNow()}>Run now</button>
    </div>
    <div className={`ap-status-summary ${status.tone}`} title={statusExplanation(status)}>
      <span className={`ar-flag ${status.tone}`}>{status.label}</span>
      <span><strong>{status.reason}</strong><small>Next: {status.nextAction}</small></span>
    </div>
    <section className="ap-meta">
      {props.routine.pendingRoutineFindings.length ? <div className="ap-section ap-pending-findings">
        <span className="ap-label">Awaiting Steward review ({props.routine.pendingRoutineFindings.length})</span>
        <div className="ap-pending-finding-list">{props.routine.pendingRoutineFindings.map((finding) => <article key={finding.id}>
          <strong>{finding.summary}</strong>
          <small>Evidence · {finding.evidence}</small>
        </article>)}</div>
      </div> : null}
      <div className="ap-section">
        <span className="ap-label">Related Tasks</span>
        {props.routine.relatedTaskIds.length ? <ul>{props.routine.relatedTaskIds.map((taskId) => <li key={taskId}><code>{taskId}</code></li>)}</ul> : <p className="ap-hint">No related Tasks.</p>}
      </div>
      {props.stepRetryDelaySeconds !== undefined ? <div className="ap-section ap-completion-evidence">
        <span className="ap-label">When is this Playbook step complete?</span>
        <p>{props.completionEvidence?.trim() || "Use the verification instructions below to define how completion is proven."}</p>
        <small>This completion rule comes from the Playbook step. The Steward verifies it with the instructions below.</small>
      </div> : null}
      <details className="ap-details ap-instructions-details" open>
        <summary>What should the Steward verify?</summary>
        <div className="ap-instructions-editor">
          <ConfigurationVersions controller={improver} reload={props.reload} />
          <div className="ap-editor-head">
            <label htmlFor="routine-instructions">Describe the sources to inspect and the facts to report.</label>
            <small>{instructionsByteLength} / 9216 bytes</small>
          </div>
          <textarea id="routine-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)}
            aria-label="What the Steward should verify" spellCheck />
          <div className="ap-actions">
            <PromptImproveButton improvement={props.improvement} busy={props.busy || improver.busy}
              title="Start an agent that improves the Steward's evidence check and response policy together for you to approve"
              label={promptImprovementActionLabel("routineInstructions")}
              start={() => void improver.start()} setup={props.setupImprovement} />
            <button type="button" className="ap-btn primary"
              disabled={props.busy || !instructions.trim() || instructionsByteLength > 9216 || instructions === props.routine.instructions}
              onClick={() => void props.saveInstructions(instructions)}>Save verification instructions</button>
          </div>
        </div>
      </details>
      <details className="ap-details ap-instructions-details" open>
        <summary>What should the Steward consider doing?</summary>
        <div className="ap-instructions-editor">
          <div className="ap-editor-head">
            <label htmlFor="routine-steward-instructions">{props.routine.triggerMode === "onDemand"
              ? "Describe the response options when this step is still waiting."
              : "Describe the response options when the Steward finds something new."}</label>
            <small>{stewardInstructionsByteLength} / 9216 bytes</small>
          </div>
          <p className="ap-hint">These instructions tell the Steward how to advance the Task after verification. Repeated identical waiting evidence is ignored.</p>
          <textarea id="routine-steward-instructions" value={stewardInstructions}
            onChange={(event) => setStewardInstructions(event.target.value)}
            aria-label="What the Steward should consider doing" spellCheck />
          <div className="ap-actions">
            <button type="button" className="ap-btn primary"
              disabled={props.busy || stewardInstructionsByteLength > 9216 || stewardInstructions === props.routine.whileWaiting.instructions}
              onClick={() => void props.saveStewardInstructions(stewardInstructions)}>Save Steward instructions</button>
          </div>
        </div>
      </details>
      <div className="ap-section ap-action-settings">
        <div className="ap-action-settings-head">
          <span className="ap-label">How may the Steward handle an action?</span>
          <div className="pb-segmented" aria-label="Routine action handling">
            {(["off", "ask", "auto"] as const).map((mode) => <button key={mode} type="button"
              className={props.routine.whileWaiting.mode === mode ? "selected" : ""}
              disabled={props.busy} onClick={() => mode !== props.routine.whileWaiting.mode && void props.saveActionHandling(mode)}>
              {mode === "off" ? "Record only" : mode === "ask" ? "Ask me" : "Auto if allowed"}
            </button>)}
          </div>
        </div>
        <p className="ap-hint">{props.routine.whileWaiting.mode === "off"
          ? props.routine.triggerMode === "onDemand"
            ? "Keep the waiting evidence, but do not wake the Steward to decide an action."
            : "Keep the finding, but do not wake the Steward to decide an action."
          : props.routine.whileWaiting.mode === "ask"
            ? "The Steward decides whether a response is useful, then asks you before acting."
            : "The Steward may act only when the instructions above clearly authorize the exact response. Anything ambiguous still asks you first."}</p>
      </div>
      <details className="ap-details"><summary>Processed sources ({props.routine.recentSourceKeys.length})</summary>
        {props.routine.recentSourceKeys.length ? <ul>{props.routine.recentSourceKeys.map((sourceKey) => <li key={sourceKey}><code>{sourceKey}</code></li>)}</ul> : <p className="ap-hint">No processed sources.</p>}
      </details>
      {props.reports.some((report) => report.kind === "problem") ? <p className="ap-problem">{routineProblemRecoveryCopy()}</p> : null}
      <div className="ap-editor ap-routine-context-memory">
        <div className="ap-editor-head">
          <label htmlFor="routine-context-markdown">Routine memory</label>
          <small>Auto-managed · Revision {props.routine.contextRevision} · {contextByteLength} / 32768 bytes</small>
        </div>
        <p className="ap-hint">{props.routine.contextMarkdown
          ? "This current-state snapshot is the complete memory delivered with this Routine. The Steward refreshes it after successful runs; it is not a transcript or activity history."
          : "No context has been saved yet. The Steward fills this after a successful run; you can also add a starting snapshot here."}</p>
        <textarea id="routine-context-markdown" value={context} maxLength={32768}
          placeholder="No Routine memory yet."
          onChange={(event) => setContext(event.target.value)} aria-label="Routine next-run memory" spellCheck />
        <div className="ap-actions">
          <button type="button" className="ap-btn" disabled={props.busy || !props.routine.contextMarkdown}
            onClick={() => {
              if (!window.confirm("Clear this Routine's next-run memory?\n\nThe Session transcript and system-managed scan/dedupe state will not be deleted.")) return;
              void props.save("");
            }}>Clear memory</button>
          <button type="button" className="ap-btn primary" disabled={props.busy || contextByteLength > 32768 || context === props.routine.contextMarkdown} onClick={() => void props.save(context)}>Save memory</button>
        </div>
        <p className="ap-hint">Clearing affects only this Routine&apos;s visible memory. Session JSONL, processed source keys, scan boundaries, and related Task metadata remain intact.</p>
      </div>
    </section>
  </section>;
}

function instructionDeliveryLabel(delivery: AssistantPromptContextDto["instructionDelivery"]): string {
  return delivery === "codexDeveloperInstructions" ? "Codex developer instructions" : "Claude appended system prompt";
}

export function StewardSystemPromptCard(props: {
  context: AssistantPromptContextDto;
  busy: boolean;
  improvement?: PromptImprovement | undefined;
  setupImprovement(): void;
  openTermLoopInstructions(): void;
  save(prompt: string): Promise<void>;
  reload(): Promise<void>;
}) {
  const currentInstructions = assistantInstructionsEditableSuffix(
    props.context.instructionsPrompt,
    props.context.protectedPrompt,
  );
  const [instructions, setInstructions] = useState(currentInstructions ?? "");
  useEffect(() => { setInstructions(currentInstructions ?? ""); }, [currentInstructions]);
  const byteLength = new TextEncoder().encode(instructions).length;
  const unchanged = currentInstructions !== undefined && instructions.trim() === currentInstructions;
  const improver = usePromptImprovement(props.improvement, { surface: "stewardInstructions", ownerId: null });
  return <section className="ap-form">
    <ConfigurationVersions controller={improver} reload={props.reload} />
    <div className="ap-editor ap-composed-prompt ap-single-instructions-editor">
      <div className="ap-editor-head">
        <label htmlFor="steward-system-instructions">Your Steward instructions</label>
        <small>{instructionDeliveryLabel(props.context.instructionDelivery)}</small>
      </div>
      <p className="ap-hint">Add Project-specific behavior here. TermLoop&apos;s required runtime and safety instructions remain installed separately and cannot be changed from this field.</p>
      <textarea id="steward-system-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)}
        aria-label="Your Steward instructions" placeholder="Add Project-specific Steward behavior…" spellCheck />
      <div className="ap-editor-foot">
        <small>{byteLength} / 16384 bytes</small>
        {currentInstructions === undefined ? <span className="ap-problem">TermLoop could not separate the Project instructions from its protected runtime instructions.</span> : null}
      </div>
      <div className="ap-actions">
        <PromptImproveButton improvement={props.improvement} busy={props.busy || improver.busy}
          title="Start an agent that reads this Project and proposes Steward instructions for you to approve"
          label={promptImprovementActionLabel("stewardInstructions")}
          start={() => void improver.start()} setup={props.setupImprovement} />
        <button type="button" className="ap-btn" onClick={props.openTermLoopInstructions}>TermLoop instructions</button>
        <button type="button" className="ap-btn" disabled={props.busy || !instructions.trim()}
          onClick={() => setInstructions("")}>Reset Project instructions</button>
        <button type="button" className="ap-btn primary"
          disabled={props.busy || currentInstructions === undefined || byteLength > 16384 || unchanged}
          onClick={() => void props.save(instructions.trim())}>Save &amp; restart Steward</button>
      </div>
    </div>
  </section>;
}
