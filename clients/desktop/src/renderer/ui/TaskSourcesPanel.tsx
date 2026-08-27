import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  AgentCapabilityDto,
  ProjectTaskAutomationGetResult,
  TaskSourceCandidateDto,
  TaskSourceCandidateImportParams,
  TaskSourceCandidateImportResult,
  TaskSourceCandidateListResult,
  TaskSourceCandidateMutationParams,
  TaskSourceCandidateMutationResult,
  TaskSourceBoardDto,
  TaskSourceBoardListParams,
  TaskSourceBoardListResult,
  TaskSourceCreateParams,
  TaskSourceCredentialsSetParams,
  TaskSourceCredentialsSetResult,
  TaskSourceDeleteParams,
  TaskSourceDeleteResult,
  TaskSourceDto,
  TaskSourceListResult,
  TaskSourceMutationResult,
  TaskSourceRefreshParams,
  TaskSourceRefreshResult,
  TaskSourceStoredBoardListParams,
  TaskSourceStatusDto,
  TaskSourceStatusListParams,
  TaskSourceStatusListResult,
  TaskSourceStoredStatusListParams,
  TaskSourceUpdateParams,
} from "@termloop/contract/current";
import {
  TASK_SOURCE_DEFAULT_REFRESH_SECONDS,
  TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
  TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX,
  TASK_SOURCE_JQL_MAX_CHARACTERS,
  TASK_SOURCE_NAME_MAX_CHARACTERS,
  TASK_SOURCE_REFRESH_OPTIONS,
  applyBoardChange,
  candidateActions,
  candidateCounts,
  candidateStateLabel,
  credentialStateLabel,
  deriveSourceName,
  emptyTaskSourceDraft,
  filterCandidates,
  filterSummaryParts,
  failureReasonCopy,
  intakeLabel,
  isStaleExpectationMessage,
  mergeBoardOptions,
  normalizeJiraBoardLookup,
  normalizeJiraSiteInput,
  normalizeSiteBaseUrl,
  orderCandidates,
  reconcileStatusSelection,
  refreshIntervalLabel,
  relativeTime,
  runTaskSourceSetup,
  sameSelection,
  scopeLabel,
  setupFailureCopy,
  sourceHealth,
  staleStatusNotice,
  taskSourceCredentialsError,
  taskSourceDraftError,
  taskSourceDraftFrom,
  type CandidateFilter,
  type TaskSourceDraft,
} from "../task-sources.js";
import {
  agentLabel,
  DEFAULT_TASK_WORKTREE_PREFIX,
  projectTaskAutomationChanged,
  projectTaskAutomationDraftFrom,
  projectTaskAutomationError,
  taskAutomationSummary,
  taskCreationIntent,
  type ProjectTaskAutomationDraft,
  type TaskImportChoice,
} from "../project-task-automation.js";
import { controlErrorMessage } from "../control-error.js";
import { Icon } from "./Icon.js";
import { WorktreeAgentChoice, type ProjectTaskAutomationActions } from "./ProjectTaskAutomation.js";
import { SourceIntakeSettings } from "./task-sources/SourceIntakeSettings.js";

/// Named generated operations the panel may raise. Composition binds them to
/// the selected Project's connection source; the panel never sees a transport.
export type TaskSourceActions = ProjectTaskAutomationActions & {
  list(projectId: string): Promise<TaskSourceListResult>;
  listBoards(params: TaskSourceBoardListParams): Promise<TaskSourceBoardListResult>;
  listStoredBoards(params: TaskSourceStoredBoardListParams): Promise<TaskSourceBoardListResult>;
  listStatuses(params: TaskSourceStatusListParams): Promise<TaskSourceStatusListResult>;
  listStoredStatuses(params: TaskSourceStoredStatusListParams): Promise<TaskSourceStatusListResult>;
  create(params: TaskSourceCreateParams): Promise<TaskSourceMutationResult>;
  update(params: TaskSourceUpdateParams): Promise<TaskSourceMutationResult>;
  setCredentials(params: TaskSourceCredentialsSetParams): Promise<TaskSourceCredentialsSetResult>;
  delete(params: TaskSourceDeleteParams): Promise<TaskSourceDeleteResult>;
  refresh(params: TaskSourceRefreshParams): Promise<TaskSourceRefreshResult>;
  listCandidates(sourceId: string): Promise<TaskSourceCandidateListResult>;
  importCandidate(params: TaskSourceCandidateImportParams): Promise<TaskSourceCandidateImportResult>;
  ignoreCandidate(params: TaskSourceCandidateMutationParams): Promise<TaskSourceCandidateMutationResult>;
  unignoreCandidate(params: TaskSourceCandidateMutationParams): Promise<TaskSourceCandidateMutationResult>;
};

export type TaskSourcesPanelProps = {
  projectId: string;
  projectName: string;
  /// Bumped by composition when the daemon invalidates the `taskSource` topic.
  refreshToken: number;
  actions: TaskSourceActions;
  agentCapabilities: readonly AgentCapabilityDto[];
  /// Routes an imported candidate to the ordinary Task detail path.
  openTask(taskId: string): void;
  openExternal(url: string): Promise<void>;
  close(): void;
  now?: () => number;
};

type Editor = { kind: "create" } | { kind: "edit"; sourceId: string };

type Notice = { tone: "info" | "error"; text: string };

/// The single Task page: the rule every new Task starts with, the Jira sources
/// that create Tasks, and the review queue of the selected source. Reads are
/// refetched on invalidation;
/// every write carries the revision/generation the page last saw, and a stale
/// expectation reloads instead of retrying blind. One mutation runs at a time.
export function TaskSourcesPanel(props: TaskSourcesPanelProps) {
  const now = props.now ?? Date.now;
  const [sources, setSources] = useState<TaskSourceDto[]>();
  const [stateRevision, setStateRevision] = useState(0);
  const [listError, setListError] = useState<string>();
  const [automation, setAutomation] = useState<ProjectTaskAutomationGetResult>();
  const [automationError, setAutomationError] = useState<string>();
  const [automationBusy, setAutomationBusy] = useState(false);
  /// One open import confirmation at a time: the explicit one-shot choice for
  /// exactly the candidate the user pressed, prefilled from the Project default.
  const [importChoice, setImportChoice] = useState<{ externalId: string; choice: TaskImportChoice }>();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [candidates, setCandidates] = useState<{ sourceId: string; result: TaskSourceCandidateListResult }>();
  const [candidateError, setCandidateError] = useState<string>();
  const [candidateFilter, setCandidateFilter] = useState<CandidateFilter>("actionable");
  const [editor, setEditor] = useState<Editor>();
  /// Delete is confirmed in place on the selected source, not by replacing the
  /// stage with a form, so the queue behind it stays readable.
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const result = await props.actions.list(props.projectId);
      if (!alive.current) return;
      setSources(result.sources);
      setStateRevision(result.stateRevision);
      setListError(undefined);
      setSelectedSourceId((current) => {
        if (current && result.sources.some((source) => source.id === current)) return current;
        return result.sources[0]?.id;
      });
    } catch (error) {
      if (!alive.current) return;
      setListError(controlErrorMessage(error));
    }
  }, [props.actions, props.projectId]);

  const loadAutomation = useCallback(async () => {
    try {
      const result = await props.actions.getProjectAutomation(props.projectId);
      if (!alive.current) return;
      setAutomation(result);
      setAutomationError(undefined);
    } catch (error) {
      if (!alive.current) return;
      setAutomationError(controlErrorMessage(error));
    }
  }, [props.actions, props.projectId]);

  /// Project defaults are edited as one launch profile. Keep the editor open
  /// after a rejected save so the user's model, reasoning, and prompt choices
  /// remain visible and recoverable.
  const saveAutomation = useCallback(async (draft: ProjectTaskAutomationDraft): Promise<boolean> => {
    if (!automation || automationBusy) return false;
    setAutomationBusy(true);
    try {
      const saved = await props.actions.setProjectAutomation({
        projectId: props.projectId,
        createWorktree: draft.createWorktree,
        worktreePrefix: draft.worktreePrefix,
        agentId: draft.agentId,
        model: draft.model,
        permission: draft.permission,
        reasoning: draft.reasoning,
        kickoffMessage: draft.kickoffMessage,
        expectedRevision: automation.stateRevision,
      });
      if (!alive.current) return false;
      setAutomation(saved);
      setAutomationError(undefined);
      return true;
    } catch (error) {
      if (!alive.current) return false;
      const message = controlErrorMessage(error);
      await loadAutomation();
      if (alive.current) setAutomationError(message);
      return false;
    } finally {
      if (alive.current) setAutomationBusy(false);
    }
  }, [automation, automationBusy, loadAutomation, props.actions, props.projectId]);

  const loadCandidates = useCallback(async (sourceId: string) => {
    try {
      const result = await props.actions.listCandidates(sourceId);
      if (!alive.current) return;
      setCandidates({ sourceId, result });
      setStateRevision((current) => Math.max(current, result.stateRevision));
      setCandidateError(undefined);
    } catch (error) {
      if (!alive.current) return;
      setCandidateError(controlErrorMessage(error));
    }
  }, [props.actions]);

  useEffect(() => { void loadSources(); }, [loadSources, props.refreshToken]);
  useEffect(() => { void loadAutomation(); }, [loadAutomation, props.refreshToken]);
  useEffect(() => {
    if (selectedSourceId) void loadCandidates(selectedSourceId);
    else setCandidates(undefined);
  }, [loadCandidates, selectedSourceId, props.refreshToken]);

  const selectedSource = sources?.find((source) => source.id === selectedSourceId);
  const visibleCandidates = useMemo(() => {
    if (!candidates || candidates.sourceId !== selectedSourceId) return [];
    return orderCandidates(filterCandidates(candidates.result.candidates, candidateFilter));
  }, [candidateFilter, candidates, selectedSourceId]);
  const counts = useMemo(
    () => candidateCounts(candidates && candidates.sourceId === selectedSourceId ? candidates.result.candidates : []),
    [candidates, selectedSourceId],
  );

  /// Runs one mutation at a time. A rejected expectation reloads the list so
  /// the next attempt carries the current revision; other errors stay visible.
  const mutate = useCallback(async (key: string, run: () => Promise<Notice | undefined>) => {
    if (busy) return;
    setBusy(key);
    setNotice(undefined);
    try {
      const result = await run();
      if (alive.current && result) setNotice(result);
    } catch (error) {
      const message = controlErrorMessage(error);
      if (alive.current) {
        setNotice({ tone: "error", text: isStaleExpectationMessage(message) ? `${message} The list was reloaded; try again.` : message });
      }
      if (isStaleExpectationMessage(message)) await loadSources();
    } finally {
      if (alive.current) setBusy(undefined);
    }
  }, [busy, loadSources]);

  const refreshSource = (source: TaskSourceDto) => mutate(`refresh:${source.id}`, async () => {
    const result = await props.actions.refresh({ sourceId: source.id, expectedGeneration: source.generation });
    await loadSources();
    await loadCandidates(source.id);
    return {
      tone: "info",
      text: `${source.name}: ${result.candidateCount} candidate${result.candidateCount === 1 ? "" : "s"}${result.truncated ? " (more in Jira than TermLoop reads at once — narrow the scope)" : ""}.`,
    };
  });

  const setEnabled = (source: TaskSourceDto, enabled: boolean) => mutate(`enable:${source.id}`, async () => {
    await props.actions.update(sourceUpdateParams(source, stateRevision, { enabled }));
    await loadSources();
    return undefined;
  });

  const saveSourceIntake = (
    source: TaskSourceDto,
    importPolicy: TaskSourceDto["importPolicy"],
    autoImportActiveTaskLimit: number,
  ) => mutate(`intake:${source.id}`, async () => {
    const mutation = await props.actions.update(sourceUpdateParams(source, stateRevision, {
      importPolicy,
      autoImportActiveTaskLimit,
    }));
    if (!mutation.source.enabled || mutation.source.credentialState !== "present") {
      await loadSources();
      return {
        tone: "info",
        text: `${source.name} automation saved. It will take effect after the source is enabled and connected.`,
      };
    }
    try {
      await props.actions.refresh({
        sourceId: mutation.source.id,
        expectedGeneration: mutation.source.generation,
      });
    } catch (error) {
      await loadSources();
      await loadCandidates(source.id);
      return {
        tone: "error",
        text: `${source.name} automation was saved, but refresh failed: ${controlErrorMessage(error)}`,
      };
    }
    await loadSources();
    await loadCandidates(source.id);
    return {
      tone: "info",
      text: importPolicy === "autoAdd"
        ? `${source.name} will keep up to ${autoImportActiveTaskLimit} active Tasks and was refreshed now.`
        : `${source.name} now waits in the review queue.`,
    };
  });

  function sourceUpdateParams(
    source: TaskSourceDto,
    expectedRevision: number,
    overrides: Partial<Pick<TaskSourceUpdateParams, "enabled" | "importPolicy" | "autoImportActiveTaskLimit">>,
  ): TaskSourceUpdateParams {
    return {
      sourceId: source.id,
      name: source.name,
      enabled: source.enabled,
      siteBaseUrl: source.siteBaseUrl,
      scopeKind: source.scopeKind,
      boards: source.boards,
      statuses: source.statuses,
      jql: source.jql,
      importPolicy: source.importPolicy,
      autoImportActiveTaskLimit: source.autoImportActiveTaskLimit,
      refreshIntervalSeconds: source.refreshIntervalSeconds,
      expectedGeneration: source.generation,
      expectedRevision,
      ...overrides,
    };
  }

  const deleteSource = (source: TaskSourceDto) => mutate(`delete:${source.id}`, async () => {
    await props.actions.delete({ sourceId: source.id, expectedGeneration: source.generation, expectedRevision: stateRevision });
    setDeleting(undefined);
    if (selectedSourceId === source.id) setSelectedSourceId(undefined);
    await loadSources();
    return { tone: "info", text: `${source.name} was removed. Tasks it added keep their Jira links.` };
  });

  const candidateParams = (candidate: TaskSourceCandidateDto, source: TaskSourceDto): TaskSourceCandidateMutationParams => ({
    sourceId: source.id,
    externalId: candidate.externalId,
    expectedGeneration: source.generation,
    expectedObservationSequence: candidate.observationSequence,
    expectedRevision: stateRevision,
  });

  const importCandidate = (candidate: TaskSourceCandidateDto, source: TaskSourceDto, choice: TaskImportChoice) =>
    mutate(`import:${candidate.externalId}`, async () => {
      // The confirmation showed a resolved choice, so the command carries that
      // exact selection rather than `inherit`: a Project default that moved
      // between the prompt and the confirm must not change this import.
      const result = await props.actions.importCandidate({
        ...candidateParams(candidate, source),
        ...taskCreationIntent(choice),
      });
      setImportChoice(undefined);
      await loadSources();
      await loadCandidates(source.id);
      return { tone: "info", text: `${candidate.key} is now Task “${result.task.title}”.` };
    });

  const ignoreCandidate = (candidate: TaskSourceCandidateDto, source: TaskSourceDto, ignore: boolean) => mutate(`ignore:${candidate.externalId}`, async () => {
    const params = candidateParams(candidate, source);
    await (ignore ? props.actions.ignoreCandidate(params) : props.actions.unignoreCandidate(params));
    await loadSources();
    await loadCandidates(source.id);
    return undefined;
  });

  const disabled = busy !== undefined;
  const editingSource = editor && editor.kind !== "create" ? sources?.find((source) => source.id === editor.sourceId) : undefined;

  return (
    <section className="stage-editor task-sources" aria-label="Tasks">
      <header className="stage-editor-head">
        <div className="stage-editor-title">
          <span>Tasks</span>
          <h2>{props.projectName}</h2>
        </div>
        <div className="stage-editor-actions">
          <button className="icon-button quiet" type="button" aria-label="Close Tasks" onClick={props.close}><Icon name="close" /></button>
        </div>
      </header>

      {notice ? <p className={notice.tone === "error" ? "settings-rail-error" : "task-sources-notice"} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p> : null}
      {listError ? <p className="settings-rail-error" role="alert">Task Sources could not be loaded: {listError} <button type="button" className="secondary-button" onClick={() => void loadSources()}>Retry</button></p> : null}

      <TaskDefaultsBar
        automation={automation}
        error={automationError}
        busy={automationBusy}
        agentCapabilities={props.agentCapabilities}
        save={saveAutomation}
        reload={() => void loadAutomation()}
      />

      {/* With no source there is nothing to pick between, so the rail stays
          away and the empty state owns the stage. */}
      <div className={`task-sources-layout${sources && sources.length === 0 ? " solo" : ""}`}>
        {sources && sources.length === 0 ? null : <aside className="task-source-rail" aria-label="Sources">
          <div className="task-source-rail-head">
            <span>Sources</span>
            {sources ? <b>{sources.length}</b> : null}
          </div>
          {sources && sources.length > 0 ? (
            <ul className="task-source-rail-list">
              {sources.map((source) => {
                const health = sourceHealth(source, now());
                const selected = source.id === selectedSourceId;
                return (
                  <li key={source.id} className={`task-source-rail-row${selected ? " selected" : ""}${source.enabled ? "" : " disabled"}`} data-source-id={source.id}>
                    <button
                      type="button"
                      className="task-source-rail-select"
                      aria-pressed={selected}
                      title={health.detail ? `${health.label} — ${health.detail}` : health.label}
                      onClick={() => { setSelectedSourceId(source.id); setEditor(undefined); }}
                    >
                      <i className={`task-source-dot tone-${health.tone}`} aria-hidden="true" />
                      <span className="task-source-rail-name">{source.name}</span>
                      <span className="task-source-rail-meta">{intakeLabel(source.importPolicy, source.autoImportActiveTaskLimit)}</span>
                      <span className="task-source-rail-count" data-waiting={source.candidateCount > 0 ? "true" : "false"}>
                        {source.candidateCount > 0 ? source.candidateCount : "—"}
                        <small>{source.candidateCount === 1 ? "issue" : "issues"}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="task-source-rail-empty">Loading…</p>}
          {sources && sources.length > 0 ? <div className="task-source-rail-foot">
            <button
              type="button"
              className="task-source-rail-action"
              disabled={disabled || editor?.kind === "create"}
              onClick={() => { setEditor({ kind: "create" }); setNotice(undefined); }}
            ><Icon name="add" /><span>Add Jira source</span></button>
          </div> : null}
        </aside>}

        <div className="task-source-detail">
        {editor?.kind === "create" ? (
          <ConnectForm
            key="create"
            busy={disabled}
            cancel={() => setEditor(undefined)}
            submit={async (draft, credentials) => {
              await mutate("create", async () => {
                const outcome = await runTaskSourceSetup({
                  create: () => props.actions.create({
                    projectId: props.projectId,
                    name: draft.name.trim(),
                    siteBaseUrl: normalizeSiteBaseUrl(draft.siteBaseUrl),
                    scopeKind: draft.scopeKind,
                    boards: draft.boards,
                    statuses: draft.statuses,
                    jql: draft.scopeKind === "jql" ? draft.jql.trim() : null,
                    importPolicy: draft.importPolicy,
                    autoImportActiveTaskLimit: draft.autoImportActiveTaskLimit,
                    refreshIntervalSeconds: draft.refreshIntervalSeconds,
                    expectedRevision: stateRevision,
                  }),
                  setCredentials: (source) => props.actions.setCredentials({
                    sourceId: source.id,
                    email: credentials.email.trim(),
                    apiToken: credentials.apiToken,
                    expectedGeneration: source.generation,
                  }),
                  refresh: (source) => props.actions.refresh({ sourceId: source.id, expectedGeneration: source.generation }),
                }, controlErrorMessage);
                if (outcome.ok || outcome.stage !== "create") {
                  setEditor(undefined);
                  setSelectedSourceId(outcome.source.id);
                }
                await loadSources();
                if (outcome.ok) {
                  await loadCandidates(outcome.source.id);
                  return {
                    tone: "info",
                    text: outcome.source.importPolicy === "autoAdd"
                      ? `${outcome.source.name} connected. New matching issues will be imported automatically.`
                      : `${outcome.source.name} connected: ${outcome.refresh.candidateCount} candidate${outcome.refresh.candidateCount === 1 ? "" : "s"} to review.`,
                  };
                }
                return { tone: "error", text: setupFailureCopy(outcome) };
              });
            }}
            listBoards={props.actions.listBoards}
            listStatuses={props.actions.listStatuses}
          />
        ) : editor?.kind === "edit" && editingSource ? (
          <SourceForm
            key={`edit:${editingSource.id}`}
            title={`Edit ${editingSource.name}`}
            source={editingSource}
            draft={taskSourceDraftFrom(editingSource)}
            busy={disabled}
            listBoards={props.actions.listStoredBoards}
            listStatuses={props.actions.listStoredStatuses}
            cancel={() => setEditor(undefined)}
            submit={async (draft, credentials) => {
              await mutate(`update:${editingSource.id}`, async () => {
                // Credentials are a field of the source, not a second form, so
                // they are stored first: the refresh below must run against the
                // account the user just entered.
                if (credentials) {
                  await props.actions.setCredentials({
                    sourceId: editingSource.id,
                    email: credentials.email.trim(),
                    apiToken: credentials.apiToken,
                    expectedGeneration: editingSource.generation,
                  });
                }
                const mutation = await props.actions.update({
                  sourceId: editingSource.id,
                  name: draft.name.trim(),
                  enabled: editingSource.enabled,
                  siteBaseUrl: normalizeSiteBaseUrl(draft.siteBaseUrl),
                  scopeKind: draft.scopeKind,
                  boards: draft.boards,
                  statuses: draft.statuses,
                  jql: draft.scopeKind === "jql" ? draft.jql.trim() : null,
                  importPolicy: draft.importPolicy,
                  autoImportActiveTaskLimit: draft.autoImportActiveTaskLimit,
                  refreshIntervalSeconds: draft.refreshIntervalSeconds,
                  expectedGeneration: editingSource.generation,
                  expectedRevision: stateRevision,
                });
                setEditor(undefined);
                let refresh: TaskSourceRefreshResult;
                try {
                  refresh = await props.actions.refresh({
                    sourceId: mutation.source.id,
                    expectedGeneration: mutation.source.generation,
                  });
                } catch (error) {
                  await loadSources();
                  await loadCandidates(mutation.source.id);
                  return { tone: "error", text: `${mutation.source.name} was saved, but refresh failed: ${controlErrorMessage(error)}` };
                }
                await loadSources();
                await loadCandidates(mutation.source.id);
                return refresh.refreshed
                  ? { tone: "info", text: `${mutation.source.name} saved and refreshed.` }
                  : { tone: "error", text: `${mutation.source.name} was saved, but Jira refresh failed: ${failureReasonCopy(refresh.failureReason ?? "providerUnavailable")}` };
              });
            }}
          />
        ) : null}

        {!editor && sources === undefined && !listError ? <p className="task-sources-empty">Loading Task Sources…</p> : null}
        {!editor && sources && sources.length === 0 ? (
          <div className="task-sources-empty">
            <strong>No Task Sources yet</strong>
            <span>Connect a Jira Cloud site, choose review or automatic import, then filter by assignee, boards, or JQL.</span>
            <button type="button" className="primary-button" disabled={disabled} onClick={() => { setEditor({ kind: "create" }); setNotice(undefined); }}><Icon name="add" />Add Jira source</button>
          </div>
        ) : null}

        {!editor && selectedSource ? (() => {
          const health = sourceHealth(selectedSource, now());
          const confirmingDelete = editor === undefined && deleting === selectedSource.id;
          return (
          <section className="task-source-detail-pane" aria-label={selectedSource.name}>
            <header className="task-source-detail-head">
              <div className="task-source-detail-title">
                <h3>{selectedSource.name}</h3>
                <span className={`task-source-health tone-${health.tone}`}>{health.label}</span>
              </div>
              <p className="task-source-detail-meta">
                {selectedSource.siteBaseUrl.replace(/^https:\/\//u, "")} · {scopeLabel(selectedSource)} · {intakeLabel(selectedSource.importPolicy, selectedSource.autoImportActiveTaskLimit)} · {refreshIntervalLabel(selectedSource.refreshIntervalSeconds)}
                {selectedSource.credentialState === "present" ? "" : ` · ${credentialStateLabel(selectedSource.credentialState)}`}
              </p>
              {health.detail && health.tone === "attention" ? <p className="task-source-failure">{health.detail}</p> : null}
              {confirmingDelete ? (
                <div className="task-source-confirm" role="group" aria-label={`Delete ${selectedSource.name}`}>
                  <span>Remove this source and its credentials? Tasks it added stay.</span>
                  <button type="button" className="danger-button" disabled={disabled} onClick={() => void deleteSource(selectedSource)}>{busy === `delete:${selectedSource.id}` ? "Deleting…" : "Delete source"}</button>
                  <button type="button" className="secondary-button" disabled={disabled} onClick={() => setDeleting(undefined)}>Keep</button>
                </div>
              ) : (
                <div className="task-source-detail-actions">
                  <button type="button" className="secondary-button" disabled={disabled || !selectedSource.enabled || selectedSource.credentialState === "none"} title={selectedSource.credentialState === "none" ? "Add credentials first" : "Refresh now"} onClick={() => void refreshSource(selectedSource)}>{busy === `refresh:${selectedSource.id}` ? "Refreshing…" : "Refresh"}</button>
                  <button type="button" className="secondary-button" disabled={disabled} onClick={() => { setEditor({ kind: "edit", sourceId: selectedSource.id }); setNotice(undefined); }}>{selectedSource.credentialState === "none" ? "Add credentials" : "Edit"}</button>
                  <button type="button" className="secondary-button" disabled={disabled} onClick={() => void setEnabled(selectedSource, !selectedSource.enabled)}>{selectedSource.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" className="icon-button quiet" aria-label={`Delete ${selectedSource.name}`} disabled={disabled} onClick={() => { setDeleting(selectedSource.id); setNotice(undefined); }}><Icon name="trash" /></button>
                </div>
              )}
            </header>

            <SourceIntakeSettings
              key={`${selectedSource.id}:${selectedSource.generation}`}
              source={selectedSource}
              busy={disabled}
              save={(importPolicy, activeTaskLimit) => void saveSourceIntake(selectedSource, importPolicy, activeTaskLimit)}
            />

            <div className="task-source-queue-bar">
              <span>
                Review queue
                {" · "}
                {candidates?.sourceId === selectedSource.id && candidates.result.lastSuccessfulAtEpochMs
                  ? `observed ${relativeTime(candidates.result.lastSuccessfulAtEpochMs, now())}`
                  : "not observed yet"}
                {selectedSource.truncated ? " · Jira returned more than TermLoop reads at once" : ""}
              </span>
              <div className="task-source-filter" role="tablist" aria-label="Candidate filter">
                <button type="button" role="tab" aria-selected={candidateFilter === "actionable"} className={candidateFilter === "actionable" ? "selected" : undefined} onClick={() => setCandidateFilter("actionable")}>Needs review ({counts.new + counts.changed + counts.possibleDuplicate})</button>
                <button type="button" role="tab" aria-selected={candidateFilter === "all"} className={candidateFilter === "all" ? "selected" : undefined} onClick={() => setCandidateFilter("all")}>All ({counts.new + counts.changed + counts.possibleDuplicate + counts.added + counts.ignored + counts.noLongerMatches})</button>
              </div>
            </div>
            {candidateError ? <p className="settings-rail-error" role="alert">Candidates could not be loaded: {candidateError} <button type="button" className="secondary-button" onClick={() => void loadCandidates(selectedSource.id)}>Retry</button></p> : null}
            {!candidateError && candidates?.sourceId !== selectedSource.id ? <p className="task-sources-empty">Loading candidates…</p> : null}
            {candidates?.sourceId === selectedSource.id && visibleCandidates.length === 0 && !candidateError ? (
              <p className="task-sources-empty">
                {candidates.result.candidates.length === 0
                  ? (selectedSource.lastSuccessfulAtEpochMs === null ? "Refresh the source to fetch its first candidates." : "Nothing in scope right now.")
                  : "Nothing needs review. Switch to All to see added and ignored issues."}
              </p>
            ) : null}
            {visibleCandidates.length > 0 ? (
              <ul className="task-candidate-list">
                {visibleCandidates.map((candidate) => {
                  const actions = candidateActions(candidate);
                  const rowBusy = busy === `import:${candidate.externalId}` || busy === `ignore:${candidate.externalId}`;
                  const confirming = importChoice?.externalId === candidate.externalId ? importChoice.choice : undefined;
                  return (
                    <li key={candidate.externalId} className={`task-candidate-row state-${candidate.state}`} data-candidate-key={candidate.key}>
                      <div className="task-candidate-main">
                        <div className="task-candidate-title">
                          <button type="button" className="task-candidate-key" title={candidate.url} onClick={() => void props.openExternal(candidate.url)}>{candidate.key}<Icon name="external" /></button>
                          <span className={`task-candidate-state state-${candidate.state}`}>{candidateStateLabel(candidate.state)}</span>
                          <strong>{candidate.summary}</strong>
                        </div>
                        <small>{candidate.statusName}{candidate.assigneeDisplay ? ` · ${candidate.assigneeDisplay}` : " · Unassigned"} · Jira updated {candidate.updatedAt.slice(0, 10)}</small>
                      </div>
                      <div className="task-candidate-actions">
                        {actions.openTask && candidate.taskId ? <button type="button" className="secondary-button" onClick={() => props.openTask(candidate.taskId!)}>Open Task</button> : null}
                        {actions.import ? <button
                          type="button"
                          className="primary-button"
                          disabled={disabled || confirming !== undefined}
                          aria-expanded={confirming !== undefined}
                          onClick={() => {
                            setNotice(undefined);
                            setImportChoice({
                              externalId: candidate.externalId,
                              choice: automation
                                ? projectTaskAutomationDraftFrom(automation.configuration)
                                : {
                                  createWorktree: false,
                                  worktreePrefix: DEFAULT_TASK_WORKTREE_PREFIX,
                                  agentId: null,
                                  model: null,
                                  permission: null,
                                  reasoning: null,
                                  kickoffMessage: null,
                                },
                            });
                          }}
                        >{busy === `import:${candidate.externalId}` ? "Importing…" : "Import as Task"}</button> : null}
                        {actions.ignore ? <button type="button" className="secondary-button" disabled={disabled} onClick={() => void ignoreCandidate(candidate, selectedSource, true)}>{rowBusy && busy?.startsWith("ignore:") ? "Ignoring…" : "Ignore"}</button> : null}
                        {actions.unignore ? <button type="button" className="secondary-button" disabled={disabled} onClick={() => void ignoreCandidate(candidate, selectedSource, false)}>Unignore</button> : null}
                        {candidate.state === "noLongerMatches" ? <span className="task-candidate-readonly">Left the scope</span> : null}
                      </div>
                      {confirming ? <CandidateImportOptions
                        candidateKey={candidate.key}
                        choice={confirming}
                        busy={disabled}
                        importing={busy === `import:${candidate.externalId}`}
                        defaultsLoaded={automation !== undefined}
                        agentCapabilities={props.agentCapabilities}
                        change={(choice) => setImportChoice({ externalId: candidate.externalId, choice })}
                        confirm={() => void importCandidate(candidate, selectedSource, confirming)}
                        cancel={() => setImportChoice(undefined)}
                      /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
          );
        })() : null}
        </div>
      </div>
    </section>
  );
}

/// What every new Task starts with, stated once above the sources that create
/// them. The complete launch profile opens in place when it is being changed.
function TaskDefaultsBar({ automation, error, busy, agentCapabilities, save, reload }: {
  automation: ProjectTaskAutomationGetResult | undefined;
  error: string | undefined;
  busy: boolean;
  agentCapabilities: readonly AgentCapabilityDto[];
  save(draft: ProjectTaskAutomationDraft): Promise<boolean>;
  reload(): void;
}) {
  const [open, setOpen] = useState(false);
  const savedDraft = automation ? projectTaskAutomationDraftFrom(automation.configuration) : undefined;
  const [editingDraft, setEditingDraft] = useState<ProjectTaskAutomationDraft>();
  useEffect(() => {
    if (!open && savedDraft) setEditingDraft(savedDraft);
  }, [automation, open]);
  const draft = open ? editingDraft ?? savedDraft : savedDraft;
  const validationError = editingDraft ? projectTaskAutomationError(editingDraft) : undefined;
  const changed = Boolean(
    editingDraft
      && automation
      && projectTaskAutomationChanged(editingDraft, automation.configuration),
  );
  return <section className="task-defaults-bar" aria-label="New Task defaults">
    <div className="task-defaults-line">
      <span>Every new Task starts with</span>
      <strong data-testid="project-task-automation-summary">{draft
        ? taskAutomationSummary(draft, agentLabel(agentCapabilities, draft.agentId))
        : error ? "Defaults unavailable" : "Loading…"}</strong>
      {draft
        ? <button type="button" className="secondary-button" aria-expanded={open} onClick={() => {
          if (open) {
            setEditingDraft(savedDraft);
            setOpen(false);
          } else {
            setEditingDraft(savedDraft);
            setOpen(true);
          }
        }}>{open ? "Cancel" : "Change"}</button>
        : error ? <button type="button" className="secondary-button" onClick={reload}>Retry</button> : null}
    </div>
    {open && draft ? <div className="task-defaults-edit">
      <WorktreeAgentChoice
        idPrefix="project-task-automation"
        value={draft}
        busy={busy}
        agentCapabilities={agentCapabilities}
        worktreeHint="Provision a managed worktree for every new Task."
        agentHint="Launch after the managed worktree becomes ready."
        change={setEditingDraft}
      />
      <p className="field-help">Applies to Create Task, the Project Assistant, and every automatic import. Importing from a review queue starts here and can be changed for that one Task.</p>
      {validationError ? <p className="form-error" role="alert">{validationError}</p> : null}
      <div className="task-defaults-actions">
        <button type="button" className="primary-button" disabled={busy || !changed || Boolean(validationError)} onClick={() => {
          if (!editingDraft || validationError) return;
          void save(editingDraft).then((saved) => {
            if (saved) setOpen(false);
          });
        }}>{busy ? "Saving…" : "Save defaults"}</button>
      </div>
    </div> : null}
    {error && draft ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}

type Credentials = { email: string; apiToken: string };
type BoardLoadState = { siteBaseUrl: string; boards: TaskSourceBoardDto[]; truncated: boolean };
type StatusLoadState = { key: string; statuses: TaskSourceStatusDto[] };

const selectedBoardKey = (boards: TaskSourceDraft["boards"]): string => boards
  .map((board) => board.id)
  .sort((left, right) => left.localeCompare(right))
  .join(",");

function mergedBoardLoad(
  current: BoardLoadState | undefined,
  siteBaseUrl: string,
  result: TaskSourceBoardListResult,
  exactLookup: boolean,
): BoardLoadState {
  const currentOptions = current?.siteBaseUrl === siteBaseUrl ? current.boards : [];
  return {
    siteBaseUrl,
    boards: mergeBoardOptions(currentOptions, result.boards),
    truncated: exactLookup ? (current?.truncated ?? false) : result.truncated,
  };
}

/// What the board step renders. Boards are the credential-proving discovery, so
/// loading them stays an explicit act; the statuses below follow automatically.
type BoardDiscovery = {
  loading: boolean;
  boards: TaskSourceBoardDto[] | undefined;
  truncated: boolean;
  error: string | undefined;
  emptyCopy: string;
  /// Shown when nothing has been discovered yet and nothing is loading.
  unloadedCopy: string | undefined;
  /// Non-undefined disables discovery and says which field is still missing.
  blockedReason: string | undefined;
  lookupValue: string;
  lookupChange(value: string): void;
  reload(): void;
  lookup(): void;
};

type StatusDiscovery = {
  loading: boolean;
  statuses: TaskSourceStatusDto[] | undefined;
  error: string | undefined;
  unloadedCopy: string | undefined;
  reload(): void;
};

/// One status discovery per (site, selected board set). Statuses exist only
/// inside the selected boards, so the list refetches itself when that set
/// changes rather than asking the user to press a load button again. Responses
/// are matched by ticket, so a quick second board change can never leave the
/// previous board's statuses on screen.
function useStatusDiscovery(input: {
  active: boolean;
  key: string;
  boardIds: readonly string[];
  load(boardIds: readonly string[]): Promise<TaskSourceStatusListResult>;
  reconcile(discovered: readonly TaskSourceStatusDto[]): void;
}): Omit<StatusDiscovery, "unloadedCopy"> {
  const { active, key } = input;
  const latest = useRef(input);
  useEffect(() => { latest.current = input; });
  const [loaded, setLoaded] = useState<StatusLoadState>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const ticket = useRef(0);

  useEffect(() => {
    if (!active) {
      ticket.current += 1;
      setLoaded(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    const mine = ticket.current + 1;
    ticket.current = mine;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const result = await latest.current.load(latest.current.boardIds);
        if (mine !== ticket.current) return;
        if (result.failureReason) {
          setLoaded(undefined);
          setError(failureReasonCopy(result.failureReason));
          return;
        }
        setLoaded({ key, statuses: result.statuses });
        latest.current.reconcile(result.statuses);
      } catch (failure) {
        if (mine !== ticket.current) return;
        setLoaded(undefined);
        setError(controlErrorMessage(failure));
      } finally {
        if (mine === ticket.current) setLoading(false);
      }
    })();
  }, [active, key, attempt]);

  return {
    statuses: loaded?.key === key ? loaded.statuses : undefined,
    loading,
    error,
    reload: () => setAttempt((current) => current + 1),
  };
}

function DiscoveryProgress({ rows, label }: { rows: number; label: string }) {
  return <div className="task-source-discovery-progress">
    <p role="status">{label}</p>
    <span aria-hidden="true">{Array.from({ length: rows }, (_, index) => <i key={index} />)}</span>
  </div>;
}

function StepError({ message, retry, busy }: { message: string; retry(): void; busy: boolean }) {
  return <p className="form-error task-source-step-error" role="alert">
    <span>{message}</span>
    <button type="button" className="secondary-button" disabled={busy} onClick={retry}>Try again</button>
  </p>;
}

/// Selected boards and statuses read as removable chips above their list, so the
/// current filter is scannable without scrolling a checkbox grid, and one click
/// removes an entry the user can no longer see in the list.
function SelectionChips({ label, items, unknownIds, busy, remove, clear }: {
  label: string;
  items: readonly { id: string; name: string }[];
  unknownIds?: ReadonlySet<string> | undefined;
  busy: boolean;
  remove(id: string): void;
  clear(): void;
}) {
  if (items.length === 0) return null;
  return <div className="task-source-chips" role="list" aria-label={label}>
    {items.map((item) => {
      const unknown = unknownIds?.has(item.id) ?? false;
      return <span
        key={item.id}
        role="listitem"
        className={`task-source-chip${unknown ? " unknown" : ""}`}
        data-chip-id={item.id}
        title={unknown ? `${item.name} is not in the list Jira last returned.` : item.name}
      >
        <span>{item.name}</span>
        <button type="button" className="task-source-chip-remove" aria-label={`Remove ${item.name}`} disabled={busy} onClick={() => remove(item.id)}><Icon name="close" /></button>
      </span>;
    })}
    {items.length > 1 ? <button type="button" className="task-source-chip-clear" disabled={busy} onClick={clear}>Clear all</button> : null}
  </div>;
}

function BoardStepBody({ busy, discovery, selected, change }: {
  busy: boolean;
  discovery: BoardDiscovery;
  selected: TaskSourceDraft["boards"];
  change(boards: TaskSourceDraft["boards"]): void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const boards = discovery.boards;
  const filteredBoards = boards?.filter((board) => normalizedQuery.length === 0
    || board.id.includes(normalizedQuery)
    || board.name.toLowerCase().includes(normalizedQuery)
    || board.locationName?.toLowerCase().includes(normalizedQuery));
  const unknownIds = boards
    ? new Set(selected.filter((item) => !boards.some((board) => board.id === item.id && board.name === item.name)).map((item) => item.id))
    : undefined;
  const atLimit = selected.length >= 10;
  return <>
    <SelectionChips
      label="Selected boards"
      items={selected}
      unknownIds={unknownIds}
      busy={busy}
      remove={(id) => change(selected.filter((board) => board.id !== id))}
      clear={() => change([])}
    />
    <div className="task-source-board-actions">
      <button
        type="button"
        className="secondary-button"
        disabled={busy || discovery.loading || discovery.blockedReason !== undefined}
        title={discovery.blockedReason}
        onClick={discovery.reload}
      >{discovery.loading ? "Loading boards…" : boards ? "Reload boards" : "Load boards"}</button>
      <input aria-label="Board URL or ID" value={discovery.lookupValue} spellCheck={false} inputMode="url" placeholder="Board URL or ID, e.g. 310" onChange={(event) => discovery.lookupChange(event.target.value)} />
      <button type="button" className="secondary-button" disabled={busy || discovery.loading || discovery.lookupValue.trim().length === 0} onClick={discovery.lookup}>Add board</button>
    </div>
    {discovery.loading && !boards ? <DiscoveryProgress rows={4} label="Reading the boards this account can see…" /> : null}
    {boards ? <>
      {boards.length > 8 ? <input className="task-source-option-search" aria-label="Search loaded boards" value={query} type="search" placeholder="Search loaded boards" onChange={(event) => setQuery(event.target.value)} /> : null}
      {boards.length > 0 ? <div className="task-source-board-options" role="group" aria-label="Boards">
        {filteredBoards?.map((board) => {
          const checked = selected.some((item) => item.id === board.id);
          return <label key={board.id} className={`task-source-board-option${checked ? " checked" : ""}`}>
            <input type="checkbox" value={board.id} checked={checked} disabled={busy || (!checked && atLimit)} onChange={(event) => {
              change(event.target.checked
                ? [...selected, { id: board.id, name: board.name }]
                : selected.filter((item) => item.id !== board.id));
            }} />
            <span>{board.name}{board.locationName ? ` — ${board.locationName}` : ""} <small>({board.kind})</small></span>
          </label>;
        })}
      </div> : null}
      {boards.length === 0 ? <p className="task-source-step-empty">{discovery.emptyCopy}</p> : null}
      {boards.length > 0 && filteredBoards?.length === 0 ? <p className="field-help">No loaded board matches “{query.trim()}”. Paste its board URL or ID above to add it directly.</p> : null}
      {discovery.truncated ? <p className="field-help">Showing the first 500 visible boards. Paste a missing board URL or ID above.</p> : null}
      {atLimit ? <p className="field-help">Ten boards is the maximum. Remove one to add another.</p> : null}
    </> : !discovery.loading && discovery.unloadedCopy ? <p className="field-help">{discovery.unloadedCopy}</p> : null}
    {discovery.error ? <StepError message={`Boards could not be loaded: ${discovery.error}`} retry={discovery.reload} busy={busy || discovery.loading} /> : null}
  </>;
}

function StatusStepBody({ busy, discovery, selected, staleNotice, lockedReason, change }: {
  busy: boolean;
  discovery: StatusDiscovery;
  selected: TaskSourceDraft["statuses"];
  staleNotice: string | undefined;
  lockedReason: string | undefined;
  change(statuses: TaskSourceDraft["statuses"]): void;
}) {
  const statuses = discovery.statuses;
  const unknownIds = statuses
    ? new Set(selected.filter((item) => !statuses.some((status) => status.id === item.id && status.name === item.name)).map((item) => item.id))
    : undefined;
  const atLimit = selected.length >= 100;
  if (lockedReason) {
    return <>
      <p className="task-source-step-locked">{lockedReason}</p>
      {staleNotice ? <p className="task-source-stale-notice" role="status">{staleNotice}</p> : null}
    </>;
  }
  return <>
    <SelectionChips
      label="Selected statuses"
      items={selected}
      unknownIds={unknownIds}
      busy={busy}
      remove={(id) => change(selected.filter((status) => status.id !== id))}
      clear={() => change([])}
    />
    {staleNotice ? <p className="task-source-stale-notice" role="status">{staleNotice}</p> : null}
    {discovery.loading ? <DiscoveryProgress rows={3} label="Reading the statuses of the selected boards…" /> : null}
    {!discovery.loading && statuses && statuses.length > 0 ? <div className="task-source-status-options" role="group" aria-label="Statuses">
      {statuses.map((status) => {
        const checked = selected.some((item) => item.id === status.id);
        return <label key={status.id} className={`task-source-status-option${checked ? " checked" : ""}`}>
          <input type="checkbox" value={status.id} checked={checked} disabled={busy || (!checked && atLimit)} onChange={(event) => {
            change(event.target.checked
              ? [...selected, status]
              : selected.filter((item) => item.id !== status.id));
          }} />
          <span>{status.name}</span>
        </label>;
      })}
    </div> : null}
    {!discovery.loading && statuses && statuses.length === 0 ? <p className="task-source-step-empty">The selected boards did not expose any workflow status.</p> : null}
    {!discovery.loading && !statuses && !discovery.error && discovery.unloadedCopy ? <p className="field-help">{discovery.unloadedCopy}</p> : null}
    {!discovery.loading && statuses && statuses.length > 0 && selected.length === 0 ? <p className="field-help">Nothing selected: an issue may hold any of these statuses.</p> : null}
    {discovery.error ? <StepError message={`Statuses could not be loaded: ${discovery.error}`} retry={discovery.reload} busy={busy || discovery.loading} /> : null}
  </>;
}

/// Scope is the filter a source always has, so it stays in the form's flow.
/// Boards and statuses only narrow it further, and fold away until they hold
/// something: an issue must match all three at once.
function IssueFilterFields({ idPrefix, busy, filters, boardDiscovery, statusDiscovery, staleNotice, changeScope, changeJql, changeBoards, changeStatuses }: {
  idPrefix: string;
  busy: boolean;
  filters: Pick<TaskSourceDraft, "scopeKind" | "boards" | "statuses" | "jql">;
  boardDiscovery: BoardDiscovery;
  statusDiscovery: StatusDiscovery;
  staleNotice: string | undefined;
  changeScope(scopeKind: TaskSourceDraft["scopeKind"]): void;
  changeJql(jql: string): void;
  changeBoards(boards: TaskSourceDraft["boards"]): void;
  changeStatuses(statuses: TaskSourceDraft["statuses"]): void;
}) {
  const narrowing = filterSummaryParts(filters).filter((part) => part.key !== "scope");
  return <>
    <label htmlFor={`${idPrefix}-scope`}>Which issues</label>
    <select id={`${idPrefix}-scope`} value={filters.scopeKind} disabled={busy} onChange={(event) => changeScope(event.target.value as TaskSourceDraft["scopeKind"])}>
      <option value="assignedToMe">Assigned to me</option>
      <option value="all">All issues on the site</option>
      <option value="jql">Advanced JQL</option>
    </select>
    {filters.scopeKind === "jql" ? <>
      <label htmlFor={`${idPrefix}-jql`}>JQL</label>
      <textarea id={`${idPrefix}-jql`} value={filters.jql} rows={3} maxLength={TASK_SOURCE_JQL_MAX_CHARACTERS} spellCheck={false} disabled={busy} placeholder='project = ACME AND statusCategory != Done ORDER BY updated DESC' onChange={(event) => changeJql(event.target.value)} />
    </> : null}
    <details className="task-source-narrow" open={filters.boards.length > 0 || filters.statuses.length > 0}>
      <summary>
        Narrow by board or status
        <small data-testid={`${idPrefix}-filter-summary`}>{narrowing.map((part) => part.value).join(" · ")}</small>
      </summary>
      <div className="task-source-narrow-body">
        <span className="task-source-narrow-title">Boards<small>Up to 10. Empty means any board on the site.</small></span>
        <BoardStepBody busy={busy} discovery={boardDiscovery} selected={filters.boards} change={changeBoards} />
        <span className="task-source-narrow-title">Statuses<small>Read from the selected boards.</small></span>
        <StatusStepBody
          busy={busy}
          discovery={statusDiscovery}
          selected={filters.statuses}
          staleNotice={staleNotice}
          lockedReason={filters.boards.length === 0 ? "Pick a board first — the status list comes from the boards selected above." : undefined}
          change={changeStatuses}
        />
      </div>
    </details>
  </>;
}

/// The source's own intake gate: what happens to an issue that matched the
/// filters. Worktree and agent are not here — they are the Project-wide rule
/// stated at the top of this page.
function IntakeFields({ idPrefix, value, activeTaskLimit, busy, change, changeActiveTaskLimit }: {
  idPrefix: string;
  value: TaskSourceDraft["importPolicy"];
  activeTaskLimit: number;
  busy: boolean;
  change(next: TaskSourceDraft["importPolicy"]): void;
  changeActiveTaskLimit(next: number): void;
}) {
  return <>
    <label htmlFor={`${idPrefix}-import-policy`}>When an issue matches</label>
    <select id={`${idPrefix}-import-policy`} value={value} disabled={busy} onChange={(event) => change(event.target.value as TaskSourceDraft["importPolicy"])}>
      <option value="review">Wait in the review queue</option>
      <option value="autoAdd">Create the Task automatically</option>
    </select>
    {value === "autoAdd" ? <div className="task-source-auto-import-limit">
      <label htmlFor={`${idPrefix}-auto-import-limit`}>Keep at most</label>
      <span>
        <input
          id={`${idPrefix}-auto-import-limit`}
          type="number"
          min={1}
          max={TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_MAX}
          step={1}
          value={activeTaskLimit}
          disabled={busy}
          onChange={(event) => changeActiveTaskLimit(Number(event.target.value))}
        />
        <strong>active Tasks</strong>
      </span>
      <p>When one closes, the next refresh can import another.</p>
    </div> : null}
  </>;
}

/// Importing is an explicit act, so the worktree and agent it will produce are
/// confirmed before the command runs. The options start at the Project default
/// and are sent as a resolved one-shot selection.
function CandidateImportOptions({ candidateKey, choice, busy, importing, defaultsLoaded, agentCapabilities, change, confirm, cancel }: {
  candidateKey: string;
  choice: TaskImportChoice;
  busy: boolean;
  importing: boolean;
  defaultsLoaded: boolean;
  agentCapabilities: readonly AgentCapabilityDto[];
  change(next: TaskImportChoice): void;
  confirm(): void;
  cancel(): void;
}) {
  const selectionError = projectTaskAutomationError(choice);
  // The wrapper owns the line break inside the candidate row: a max-width on the
  // flex item itself would clamp its basis and keep it on the row's first line.
  return <div className="task-candidate-import-line">
    <div className="task-candidate-import-options" role="group" aria-label={`Import ${candidateKey} as Task`}>
    <p className="field-help">
      {defaultsLoaded
        ? `Prefilled from Task settings. This choice applies to ${candidateKey} only.`
        : `Task settings could not be read, so nothing is preselected. This choice applies to ${candidateKey} only.`}
    </p>
    <WorktreeAgentChoice
      idPrefix="task-candidate-import"
      value={choice}
      busy={busy}
      agentCapabilities={agentCapabilities}
      worktreeHint="Provision a managed worktree for this Task."
      agentHint="Launch once the managed worktree is ready."
      change={change}
    />
    {selectionError ? <p className="form-error" role="alert">{selectionError}</p> : null}
    <div className="task-candidate-import-actions">
      <span data-testid="task-candidate-import-summary">{taskAutomationSummary(choice, agentLabel(agentCapabilities, choice.agentId))}</span>
      <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancel</button>
      <button type="button" className="primary-button" disabled={busy || Boolean(selectionError)} onClick={confirm}>{importing ? "Importing…" : "Create Task"}</button>
      </div>
    </div>
  </div>;
}

/// Connecting a source is four answers: where, who, which issues, and what
/// happens to a match. The name and the refresh interval have working defaults,
/// so they wait in Advanced instead of standing between the user and Connect.
function ConnectForm({ busy, cancel, submit, listBoards, listStatuses }: {
  busy: boolean;
  cancel(): void;
  submit(draft: TaskSourceDraft, credentials: Credentials): Promise<void>;
  listBoards(params: TaskSourceBoardListParams): Promise<TaskSourceBoardListResult>;
  listStatuses(params: TaskSourceStatusListParams): Promise<TaskSourceStatusListResult>;
}) {
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [importPolicy, setImportPolicy] = useState<TaskSourceDraft["importPolicy"]>(() => emptyTaskSourceDraft().importPolicy);
  const [autoImportActiveTaskLimit, setAutoImportActiveTaskLimit] = useState(
    TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT,
  );
  const [filters, setFilters] = useState<Pick<TaskSourceDraft, "scopeKind" | "boards" | "statuses" | "jql">>(() => {
    const { scopeKind, boards, statuses, jql } = emptyTaskSourceDraft();
    return { scopeKind, boards, statuses, jql };
  });
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(TASK_SOURCE_DEFAULT_REFRESH_SECONDS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardLoad, setBoardLoad] = useState<BoardLoadState>();
  const [boardError, setBoardError] = useState<string>();
  const [boardLookup, setBoardLookup] = useState("");
  const [staleNotice, setStaleNotice] = useState<string>();

  const site = normalizeJiraSiteInput(address);
  const siteBaseUrl = site.ok ? site.siteBaseUrl : "";
  const credentialsError = taskSourceCredentialsError(email, apiToken);
  const derivedName = site.ok ? deriveSourceName(site.tenant) : "";
  const visibleBoards = site.ok && boardLoad?.siteBaseUrl === siteBaseUrl ? boardLoad.boards : undefined;
  const boardKey = selectedBoardKey(filters.boards);

  const selectedStatuses = useRef(filters.statuses);
  useEffect(() => { selectedStatuses.current = filters.statuses; }, [filters.statuses]);
  const statusDiscovery = useStatusDiscovery({
    active: site.ok && credentialsError === undefined && filters.boards.length > 0,
    key: `${siteBaseUrl}|${boardKey}`,
    boardIds: filters.boards.map((board) => board.id),
    load: (boardIds) => listStatuses({ siteBaseUrl, email: email.trim(), apiToken, boardIds: [...boardIds] }),
    reconcile: (discovered) => {
      const { statuses, dropped } = reconcileStatusSelection(selectedStatuses.current, discovered);
      setStaleNotice(staleStatusNotice(dropped));
      if (dropped.length > 0) setFilters((current) => ({ ...current, statuses }));
    },
  });

  // A board or status discovered for one Jira tenant must never be submitted
  // for a newly pasted tenant, and a status must always come from the boards
  // currently selected. Both are gated by a visible error rather than a silent
  // rewrite of the selection.
  const unknownBoards = visibleBoards
    ? filters.boards.filter((selected) => !visibleBoards.some((board) => board.id === selected.id && board.name === selected.name))
    : [];
  const statusesCovered = filters.statuses.length === 0
    || (statusDiscovery.statuses !== undefined
      && filters.statuses.every((selected) => statusDiscovery.statuses!.some((status) => status.id === selected.id && status.name === selected.name)));
  const draft: TaskSourceDraft = {
    name: nameOverride.trim().length > 0 ? nameOverride : derivedName,
    siteBaseUrl,
    refreshIntervalSeconds,
    importPolicy,
    autoImportActiveTaskLimit,
    ...filters,
  };
  const error = !site.ok
    ? site.message
    : filters.boards.length > 0 && visibleBoards === undefined
      ? "Reload boards for this Jira site, then choose its board filters again."
      : unknownBoards.length > 0
        ? `${unknownBoards.map((board) => board.name).join(", ")} is not in the board list Jira returned. Remove it or add it again by URL.`
        : !statusesCovered
          ? statusDiscovery.loading
            ? "The statuses of the selected boards are still loading."
            : "Choose the status filter again from the statuses of the selected boards."
          : (taskSourceDraftError(draft) ?? credentialsError);
  const siteHint = !site.ok
    ? undefined
    : site.boardId
      ? `Board ${site.boardId} lives on ${siteBaseUrl}. Add it below, then combine it with the issue scope.`
    : site.kind === "issue"
      ? `Issue ${site.issueKey} lives on ${siteBaseUrl} — the whole site will be connected.`
      : site.kind === "path"
        ? `Connecting the site ${siteBaseUrl}.`
        : `Connecting ${siteBaseUrl}.`;
  const loadVisibleBoards = async (boardId: string | null) => {
    if (!site.ok) {
      setBoardError(site.message);
      return;
    }
    if (credentialsError) {
      setBoardError(credentialsError);
      return;
    }
    setBoardLoading(true);
    setBoardError(undefined);
    try {
      const result = await listBoards({ siteBaseUrl, email: email.trim(), apiToken, boardId });
      if (result.failureReason) {
        setBoardLoad(undefined);
        setBoardError(failureReasonCopy(result.failureReason));
        return;
      }
      setBoardLoad((current) => mergedBoardLoad(current, siteBaseUrl, result, boardId !== null));
      if (boardId && result.boards[0]) {
        setFilters((current) => current.boards.some((selected) => selected.id === result.boards[0]!.id)
          ? current
          : { ...current, boards: [...current.boards, { id: result.boards[0]!.id, name: result.boards[0]!.name }].slice(0, 10) });
      }
    } catch (failure) {
      setBoardLoad(undefined);
      setBoardError(controlErrorMessage(failure));
    } finally {
      setBoardLoading(false);
    }
  };

  return (
    <form
      className="task-source-form dialog-body"
      aria-label="Connect Jira"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (error || busy) return;
        void submit(draft, { email, apiToken }).then(() => setApiToken(""));
      }}
    >
      <h3>Connect Jira</h3>
      <label htmlFor="task-source-new-url">Jira site or issue link</label>
      <input id="task-source-new-url" value={address} spellCheck={false} inputMode="url" autoFocus placeholder="https://acme.atlassian.net/browse/ABC-123" onChange={(event) => {
        const value = event.target.value;
        setAddress(value);
        const parsed = normalizeJiraSiteInput(value);
        if (parsed.ok && parsed.boardId) setBoardLookup(value);
      }} />
      {siteHint ? <p className="field-help" data-testid="site-hint">{siteHint}</p> : <p className="field-help">Paste the site address or any issue link from your Jira Cloud. Only <code>https://&lt;site&gt;.atlassian.net</code> is accepted.</p>}
      <label htmlFor="task-source-new-email">Atlassian account email</label>
      <input id="task-source-new-email" value={email} type="email" autoComplete="off" spellCheck={false} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor="task-source-new-token">API token</label>
      <input id="task-source-new-token" value={apiToken} type="password" autoComplete="off" spellCheck={false} onChange={(event) => setApiToken(event.target.value)} />
      <p className="field-help">Stored in the daemon's secure storage and never shown again. TermLoop reads issues only.</p>
      <IssueFilterFields
        idPrefix="task-source-new"
        busy={busy}
        filters={filters}
        staleNotice={staleNotice}
        boardDiscovery={{
          loading: boardLoading,
          boards: visibleBoards,
          truncated: boardLoad?.truncated ?? false,
          error: boardError,
          emptyCopy: "No visible Jira Software board was found for this account.",
          unloadedCopy: "Load the boards this account can see to filter by board, or leave it empty for the whole site.",
          blockedReason: !site.ok
            ? "Enter the Jira site first."
            : credentialsError
              ? "Enter the account email and API token first."
              : undefined,
          lookupValue: boardLookup,
          lookupChange: (value) => { setBoardLookup(value); setBoardError(undefined); },
          reload: () => void loadVisibleBoards(null),
          lookup: () => {
            if (!site.ok) return setBoardError(site.message);
            const parsed = normalizeJiraBoardLookup(boardLookup, siteBaseUrl);
            if (!parsed.ok) return setBoardError(parsed.message);
            if (filters.boards.length >= 10 && !filters.boards.some((board) => board.id === parsed.boardId)) {
              return setBoardError("Remove a selected board before adding another; a source can use up to 10 boards.");
            }
            void loadVisibleBoards(parsed.boardId);
          },
        }}
        statusDiscovery={{
          ...statusDiscovery,
          unloadedCopy: credentialsError
            ? "Enter the account email and API token to read the statuses of the selected boards."
            : undefined,
        }}
        changeScope={(scopeKind) => setFilters((current) => ({ ...current, scopeKind }))}
        changeJql={(jql) => setFilters((current) => ({ ...current, jql }))}
        changeBoards={(boards) => {
          const next = applyBoardChange(boards, filters.statuses);
          setStaleNotice(next.notice);
          setFilters((current) => ({ ...current, boards: next.boards, statuses: next.statuses }));
        }}
        changeStatuses={(statuses) => { setStaleNotice(undefined); setFilters((current) => ({ ...current, statuses })); }}
      />
      <IntakeFields
        idPrefix="task-source-new"
        value={importPolicy}
        activeTaskLimit={autoImportActiveTaskLimit}
        busy={busy}
        change={setImportPolicy}
        changeActiveTaskLimit={setAutoImportActiveTaskLimit}
      />
      <details className="task-source-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
        <summary>Advanced{advancedOpen ? "" : ` · ${derivedName || "name from site"} · ${refreshIntervalLabel(refreshIntervalSeconds).toLowerCase()}`}</summary>
        <label htmlFor="task-source-new-name">Source name</label>
        <input id="task-source-new-name" value={nameOverride} maxLength={TASK_SOURCE_NAME_MAX_CHARACTERS} placeholder={derivedName || "Derived from the site"} onChange={(event) => setNameOverride(event.target.value)} />
        <label htmlFor="task-source-new-refresh">Refresh</label>
        <select id="task-source-new-refresh" value={String(refreshIntervalSeconds)} onChange={(event) => setRefreshIntervalSeconds(Number(event.target.value))}>
          {TASK_SOURCE_REFRESH_OPTIONS.map((option) => <option key={option.seconds} value={String(option.seconds)}>{option.label}</option>)}
        </select>
      </details>
      {touched && error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="task-source-form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || (touched && Boolean(error))}>{busy ? "Connecting…" : "Connect and refresh"}</button>
      </div>
    </form>
  );
}

/// Everything about one source in one form, credentials included: a stored
/// token cannot be shown, but replacing it is a field, not a separate surface.
function SourceForm({ title, source, draft: initial, busy, cancel, submit, listBoards, listStatuses }: {
  title: string;
  source: TaskSourceDto;
  draft: TaskSourceDraft;
  busy: boolean;
  cancel(): void;
  submit(draft: TaskSourceDraft, credentials: Credentials | undefined): Promise<void>;
  listBoards(params: TaskSourceStoredBoardListParams): Promise<TaskSourceBoardListResult>;
  listStatuses(params: TaskSourceStoredStatusListParams): Promise<TaskSourceStatusListResult>;
}) {
  const [draft, setDraft] = useState(initial);
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [touched, setTouched] = useState(false);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardLoad, setBoardLoad] = useState<BoardLoadState>();
  const [boardError, setBoardError] = useState<string>();
  const [boardLookup, setBoardLookup] = useState("");
  const [staleNotice, setStaleNotice] = useState<string>();
  const idPrefix = "task-source-edit";
  const siteBaseUrl = normalizeSiteBaseUrl(draft.siteBaseUrl);
  const visibleBoards = boardLoad?.siteBaseUrl === siteBaseUrl ? boardLoad.boards : undefined;
  const boardKey = selectedBoardKey(draft.boards);
  const credentialsMissing = source.credentialState === "none";

  const selectedStatuses = useRef(draft.statuses);
  useEffect(() => { selectedStatuses.current = draft.statuses; }, [draft.statuses]);
  const statusDiscovery = useStatusDiscovery({
    active: !credentialsMissing && siteBaseUrl === source.siteBaseUrl && draft.boards.length > 0,
    key: `${siteBaseUrl}|${boardKey}`,
    boardIds: draft.boards.map((board) => board.id),
    load: (boardIds) => listStatuses({
      sourceId: source.id,
      siteBaseUrl,
      expectedGeneration: source.generation,
      boardIds: [...boardIds],
    }),
    reconcile: (discovered) => {
      const { statuses, dropped } = reconcileStatusSelection(selectedStatuses.current, discovered);
      setStaleNotice(staleStatusNotice(dropped));
      if (dropped.length > 0) setDraft((current) => ({ ...current, statuses }));
    },
  });

  const loadVisibleBoards = useCallback(async (boardId: string | null, site: string, generation: number) => {
    setBoardLoading(true);
    setBoardError(undefined);
    try {
      const result = await listBoards({ sourceId: source.id, siteBaseUrl: site, expectedGeneration: generation, boardId });
      if (result.failureReason) {
        setBoardLoad(undefined);
        setBoardError(failureReasonCopy(result.failureReason));
        return;
      }
      setBoardLoad((current) => mergedBoardLoad(current, site, result, boardId !== null));
      if (boardId && result.boards[0]) {
        setDraft((current) => current.boards.some((selected) => selected.id === result.boards[0]!.id)
          ? current
          : { ...current, boards: [...current.boards, { id: result.boards[0]!.id, name: result.boards[0]!.name }].slice(0, 10) });
      }
    } catch (failure) {
      setBoardLoad(undefined);
      setBoardError(controlErrorMessage(failure));
    } finally {
      setBoardLoading(false);
    }
  }, [listBoards, source.id]);

  // Editing a source is the filter surface, so its boards are discovered once on
  // open with the stored credentials instead of behind a load button. A source
  // without credentials cannot discover anything, and says so.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (autoLoaded.current || credentialsMissing) return;
    autoLoaded.current = true;
    void loadVisibleBoards(null, source.siteBaseUrl, source.generation);
  }, [credentialsMissing, loadVisibleBoards, source.siteBaseUrl, source.generation]);

  const storedSite = source.siteBaseUrl === siteBaseUrl;
  const storedBoardsUntouched = storedSite && sameSelection(source.boards, draft.boards);
  const selectedBoardsAreVisible = visibleBoards !== undefined
    && draft.boards.every((selected) => visibleBoards.some((board) => board.id === selected.id && board.name === selected.name));
  const statusesCovered = draft.statuses.length === 0
    || (storedBoardsUntouched && sameSelection(source.statuses, draft.statuses))
    || (statusDiscovery.statuses !== undefined
      && draft.statuses.every((selected) => statusDiscovery.statuses!.some((status) => status.id === selected.id && status.name === selected.name)));
  const replacingCredentials = email.trim().length > 0 || apiToken.length > 0;
  const error = draft.boards.length > 0 && !storedBoardsUntouched && !selectedBoardsAreVisible
    ? "Load the boards visible to the stored account, then choose the board filters again."
    : !statusesCovered
      ? statusDiscovery.loading
        ? "The statuses of the selected boards are still loading."
        : "Choose the status filter again from the statuses of the selected boards."
      : (taskSourceDraftError(draft) ?? (replacingCredentials ? taskSourceCredentialsError(email, apiToken) : undefined));

  return (
    <form
      className="task-source-form dialog-body"
      aria-label={title}
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (error || busy) return;
        void submit(draft, replacingCredentials ? { email, apiToken } : undefined).then(() => setApiToken(""));
      }}
    >
      <h3>{title}</h3>
      <label htmlFor={`${idPrefix}-name`}>Name</label>
      <input id={`${idPrefix}-name`} value={draft.name} maxLength={TASK_SOURCE_NAME_MAX_CHARACTERS} autoFocus placeholder="Team board" onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      <label htmlFor={`${idPrefix}-site`}>Jira Cloud site</label>
      <input id={`${idPrefix}-site`} value={draft.siteBaseUrl} spellCheck={false} inputMode="url" placeholder="https://acme.atlassian.net" onChange={(event) => setDraft({ ...draft, siteBaseUrl: event.target.value })} />
      <label htmlFor={`${idPrefix}-email`}>Atlassian account email</label>
      <input id={`${idPrefix}-email`} value={email} type="email" autoComplete="off" spellCheck={false} placeholder={credentialsMissing ? "" : "Stored — leave blank to keep"} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor={`${idPrefix}-token`}>API token</label>
      <input id={`${idPrefix}-token`} value={apiToken} type="password" autoComplete="off" spellCheck={false} placeholder={credentialsMissing ? "" : "Stored — leave blank to keep"} onChange={(event) => setApiToken(event.target.value)} />
      <p className="field-help">{credentialsMissing
        ? "This source has no stored credentials, so it cannot read Jira. Enter an account to fix that."
        : `${credentialStateLabel(source.credentialState)}. Stored values are never shown; entering both replaces them.`}</p>
      <IssueFilterFields
        idPrefix={idPrefix}
        busy={busy}
        filters={draft}
        staleNotice={staleNotice}
        boardDiscovery={{
          loading: boardLoading,
          boards: visibleBoards,
          truncated: boardLoad?.truncated ?? false,
          error: boardError,
          emptyCopy: "No visible Jira Software board was found for the stored account.",
          unloadedCopy: credentialsMissing
            ? "Add credentials to this source to read the boards it can see."
            : draft.boards.length > 0
              ? `Current boards: ${draft.boards.map((board) => board.name).join(", ")}. Load boards to change them.`
              : "Load boards to filter by board, or leave it empty for the whole site.",
          blockedReason: credentialsMissing ? "This source has no stored credentials yet." : undefined,
          lookupValue: boardLookup,
          lookupChange: (value) => { setBoardLookup(value); setBoardError(undefined); },
          reload: () => void loadVisibleBoards(null, siteBaseUrl, source.generation),
          lookup: () => {
            const parsed = normalizeJiraBoardLookup(boardLookup, siteBaseUrl);
            if (!parsed.ok) return setBoardError(parsed.message);
            if (draft.boards.length >= 10 && !draft.boards.some((board) => board.id === parsed.boardId)) {
              return setBoardError("Remove a selected board before adding another; a source can use up to 10 boards.");
            }
            void loadVisibleBoards(parsed.boardId, siteBaseUrl, source.generation);
          },
        }}
        statusDiscovery={{
          ...statusDiscovery,
          unloadedCopy: credentialsMissing
            ? "Add credentials to this source to read the statuses of its boards."
            : !storedSite
              ? "Statuses are read from the stored Jira site. Save the new site first, then choose statuses."
              : draft.statuses.length > 0
                ? `Current statuses: ${draft.statuses.map((status) => status.name).join(", ")}.`
                : undefined,
        }}
        changeScope={(scopeKind) => setDraft((current) => ({ ...current, scopeKind }))}
        changeJql={(jql) => setDraft((current) => ({ ...current, jql }))}
        changeBoards={(boards) => {
          const next = applyBoardChange(boards, draft.statuses);
          setStaleNotice(next.notice);
          setDraft((current) => ({ ...current, boards: next.boards, statuses: next.statuses }));
        }}
        changeStatuses={(statuses) => { setStaleNotice(undefined); setDraft((current) => ({ ...current, statuses })); }}
      />
      <IntakeFields
        idPrefix={idPrefix}
        value={draft.importPolicy}
        activeTaskLimit={draft.autoImportActiveTaskLimit}
        busy={busy}
        change={(importPolicy) => setDraft((current) => ({ ...current, importPolicy }))}
        changeActiveTaskLimit={(autoImportActiveTaskLimit) => setDraft((current) => ({ ...current, autoImportActiveTaskLimit }))}
      />
      <label htmlFor={`${idPrefix}-refresh`}>Refresh</label>
      <select id={`${idPrefix}-refresh`} value={String(draft.refreshIntervalSeconds)} onChange={(event) => setDraft({ ...draft, refreshIntervalSeconds: Number(event.target.value) })}>
        {TASK_SOURCE_REFRESH_OPTIONS.some((option) => option.seconds === draft.refreshIntervalSeconds)
          ? null
          : <option value={String(draft.refreshIntervalSeconds)}>{refreshIntervalLabel(draft.refreshIntervalSeconds)}</option>}
        {TASK_SOURCE_REFRESH_OPTIONS.map((option) => <option key={option.seconds} value={String(option.seconds)}>{option.label}</option>)}
      </select>
      {touched && error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="task-source-form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="submit" className="primary-button" disabled={busy || (touched && Boolean(error))}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}
