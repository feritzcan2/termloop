import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentCapabilityDto,
  RemoteBranchDto,
  TaskSourceCandidateDto,
  TaskSourceDto,
  WorkflowConfigurationDto,
  ProjectTaskAutomationConfigurationDto,
} from "@termloop/contract/current";
import { SCOPE_KIND_LABEL, candidateActions, isStaleExpectationMessage, orderCandidates } from "../task-sources.js";
import { taskCreationIntent, type TaskImportChoice } from "../project-task-automation.js";
import { initialTaskImportChoice, rememberTaskImportChoice } from "../task-import-memory.js";
import { controlErrorMessage } from "../control-error.js";
import { CandidateImportOptions, type TaskSourceActions } from "./TaskSourcesPanel.js";
import { sortRemoteBranches } from "./worktree-path-suggestion.js";

/// The Task Source reads and the one import command Quick Action needs. They are
/// the same named operations the Task Settings review queue raises.
export type QuickActionJiraImportActions = Pick<TaskSourceActions,
  "list" | "listCandidates" | "importCandidate" | "refresh" | "listProjectBranches" | "getProjectAutomation">;

type Entry = { source: TaskSourceDto; candidate: TaskSourceCandidateDto };

/// A source's own scope, shown as the chips the source editor uses: who the
/// issues belong to, the boards, the statuses, and any extra JQL.
function SourceScopeChips({ source, selectedStatuses, toggleStatus }: {
  source: TaskSourceDto;
  selectedStatuses: ReadonlySet<string>;
  toggleStatus(name: string): void;
}) {
  return <div className="quick-action-jira-source">
    <strong>{source.name}</strong>
    <div className="task-source-chips" role="list" aria-label={`${source.name} scope`}>
      <span role="listitem" className="task-source-chip quick-action-jira-chip"><span>{SCOPE_KIND_LABEL[source.scopeKind]}</span></span>
      {source.boards.map((board) => <span key={`board:${board.id}`} role="listitem" className="task-source-chip quick-action-jira-chip" title={`Board ${board.name}`}><span>{board.name}</span></span>)}
      {source.statuses.map((status) => <span key={`status:${status.id}`} role="listitem" className="quick-action-jira-chip-item"><button
        type="button"
        className={`task-source-chip quick-action-jira-chip status${selectedStatuses.has(status.name) ? " selected" : ""}`}
        aria-pressed={selectedStatuses.has(status.name)}
        title={`Show only ${status.name}`}
        onClick={() => toggleStatus(status.name)}
      ><span>{status.name}</span></button></span>)}
      {source.jql ? <span role="listitem" className="task-source-chip quick-action-jira-chip" title={source.jql}><span>JQL</span></span> : null}
    </div>
  </div>;
}

/// Imports one waiting Jira issue of the Project's enabled sources as a Task,
/// with the same confirmation, remembered choice, and stale-revision retry as
/// the Task Settings review queue.
export function QuickActionJiraImport({ projectId, actions, agentCapabilities, workflows = [], imported }: {
  projectId: string;
  actions: QuickActionJiraImportActions;
  agentCapabilities: readonly AgentCapabilityDto[];
  workflows?: readonly WorkflowConfigurationDto[] | undefined;
  imported(taskId: string): void;
}) {
  const [sources, setSources] = useState<TaskSourceDto[]>([]);
  const [entries, setEntries] = useState<Entry[]>();
  const [stateRevision, setStateRevision] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const [automation, setAutomation] = useState<ProjectTaskAutomationConfigurationDto>();
  const [baseBranches, setBaseBranches] = useState<readonly RemoteBranchDto[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branchesError, setBranchesError] = useState<string>();
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<{ externalId: string; choice: TaskImportChoice }>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const listed = await actions.list(projectId);
      const enabled = listed.sources.filter((source) => source.enabled);
      const lists = await Promise.all(enabled.map(async (source) => ({ source, result: await actions.listCandidates(source.id) })));
      if (!alive.current) return;
      setStateRevision(listed.stateRevision);
      setSources(enabled);
      setEntries(lists.flatMap(({ source, result }) => orderCandidates(result.candidates)
        .filter((candidate) => candidateActions(candidate).import)
        .map((candidate) => ({ source, candidate }))));
      setLoadError(undefined);
    } catch (cause) {
      if (alive.current) setLoadError(controlErrorMessage(cause));
    }
  }, [actions, projectId]);

  // The composer keys this panel by Project, so a Project switch remounts it.
  useEffect(() => {
    void load();
    void actions.getProjectAutomation(projectId)
      .then((result) => { if (alive.current) setAutomation(result.configuration); })
      .catch(() => { if (alive.current) setAutomation(undefined); });
    void actions.listProjectBranches(projectId)
      .then((result) => { if (alive.current) { setBaseBranches(sortRemoteBranches(result.base_branches)); setBranchesError(undefined); } })
      .catch((cause) => { if (alive.current) setBranchesError(controlErrorMessage(cause)); })
      .finally(() => { if (alive.current) setBranchesLoading(false); });
  }, [actions, load, projectId]);

  const visible = useMemo(() => (entries ?? [])
    .filter(({ candidate }) => selectedStatuses.size === 0 || selectedStatuses.has(candidate.statusName)), [entries, selectedStatuses]);
  const toggleStatus = (name: string) => setSelectedStatuses((current) => {
    const next = new Set(current);
    if (!next.delete(name)) next.add(name);
    return next;
  });

  const refresh = async () => {
    if (busy || !entries) return;
    setBusy("refresh");
    setError(undefined);
    try {
      const listed = await actions.list(projectId);
      await Promise.all(listed.sources.filter((source) => source.enabled)
        .map((source) => actions.refresh({ sourceId: source.id, expectedGeneration: source.generation })));
      await load();
    } catch (cause) {
      if (alive.current) setError(controlErrorMessage(cause));
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  const importEntry = async ({ source, candidate }: Entry, choice: TaskImportChoice) => {
    if (busy) return;
    setBusy(`import:${candidate.externalId}`);
    setError(undefined);
    const params = (expectedRevision: number) => ({
      sourceId: source.id,
      externalId: candidate.externalId,
      expectedGeneration: source.generation,
      expectedObservationSequence: candidate.observationSequence,
      expectedRevision,
      ...taskCreationIntent(choice),
    });
    try {
      rememberTaskImportChoice(projectId, choice);
      // The state revision is global, so one stale rejection is retried against
      // a fresh revision; the generation and observation proofs still hold.
      let result;
      try {
        result = await actions.importCandidate(params(stateRevision));
      } catch (cause) {
        if (!isStaleExpectationMessage(controlErrorMessage(cause))) throw cause;
        const current = await actions.list(projectId);
        result = await actions.importCandidate(params(current.stateRevision));
      }
      imported(result.task.id);
    } catch (cause) {
      if (!alive.current) return;
      setError(controlErrorMessage(cause));
      await load();
    } finally {
      if (alive.current) setBusy(undefined);
    }
  };

  return <section className="quick-action-jira" aria-label="Import Jira issue">
    <div className="quick-action-jira-scope">
      <div className="quick-action-jira-sources">
        {sources.map((source) => <SourceScopeChips key={source.id} source={source} selectedStatuses={selectedStatuses} toggleStatus={toggleStatus} />)}
      </div>
      <button type="button" className="secondary-button" disabled={busy !== undefined || !entries} onClick={() => void refresh()}>{busy === "refresh" ? "Refreshing…" : "Refresh"}</button>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loadError ? <p className="form-error" role="alert">Jira issues could not be loaded: {loadError} <button type="button" className="secondary-button" onClick={() => void load()}>Retry</button></p>
      : !entries ? <p className="quick-action-jira-empty" role="status">Loading Jira issues…</p>
        : visible.length === 0 ? <p className="quick-action-jira-empty" role="status">{entries.length === 0 ? "No Jira issue is waiting to be imported." : "No waiting Jira issue matches."}</p>
          : <ul className="quick-action-jira-list">
            {visible.map((entry) => {
              const { candidate } = entry;
              const choice = confirming?.externalId === candidate.externalId ? confirming.choice : undefined;
              return <li key={`${entry.source.id}:${candidate.externalId}`} className="task-candidate-row" data-candidate-key={candidate.key}>
                <div className="task-candidate-main">
                  <div className="task-candidate-title"><code>{candidate.key}</code><strong>{candidate.summary}</strong></div>
                  <small>{[candidate.issueTypeName, candidate.statusName, candidate.assigneeDisplay ?? "Unassigned", candidate.epicKey ? `Epic ${candidate.epicKey}${candidate.epicSummary ? ` · ${candidate.epicSummary}` : ""}` : null, entry.source.name].filter(Boolean).join(" · ")}</small>
                </div>
                <div className="task-candidate-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy !== undefined || choice !== undefined}
                    aria-expanded={choice !== undefined}
                    onClick={() => setConfirming({ externalId: candidate.externalId, choice: initialTaskImportChoice(projectId, automation, baseBranches[0]?.exact_ref) })}
                  >Import as Task</button>
                </div>
                {choice ? <CandidateImportOptions
                  workflows={workflows}
                  candidateKey={candidate.key}
                  choice={choice}
                  busy={busy !== undefined}
                  importing={busy === `import:${candidate.externalId}`}
                  agentCapabilities={agentCapabilities}
                  baseBranches={baseBranches}
                  branchesLoading={branchesLoading}
                  branchesError={branchesError}
                  change={(next) => {
                    rememberTaskImportChoice(projectId, next);
                    setConfirming({ externalId: candidate.externalId, choice: next });
                  }}
                  confirm={() => void importEntry(entry, choice)}
                  cancel={() => setConfirming(undefined)}
                /> : null}
              </li>;
            })}
          </ul>}
  </section>;
}
