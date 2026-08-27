import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeletedSessionDto, SessionHistoryEntryDto, SessionHistoryListResult, SessionHistoryPreviewResult } from "@termloop/contract/current";
import type { Session } from "../model.js";
import { basename, isLiveSession, sessionIsImprover, sessionLabel } from "../model.js";
import { isAssistantSession } from "./AssistantRail.js";
import { deletedRetentionLabel } from "./DeletedRail.js";
import { Icon } from "./Icon.js";

export type HistoryRailProps = {
  projectId: string | undefined;
  projectPath: string | undefined;
  projectBranch: string | null | undefined;
  currentCwd: string | undefined;
  sessions: readonly Session[];
  archivedSessions: readonly Session[];
  deletedSessions: readonly DeletedSessionDto[];
  favoriteSessionIds: ReadonlySet<string>;
  termLoopHistoryLoading: boolean;
  selectedSessionId: string | undefined;
  disabled: boolean;
  load(projectId: string, force?: boolean, fillCache?: boolean): Promise<SessionHistoryListResult>;
  loadTermLoopPreview(projectId: string, sessionId: string): Promise<SessionHistoryPreviewResult>;
  resumeExternal(projectId: string, historyHandle: string): Promise<string | undefined>;
  selectSession(sessionId: string): void;
  resumeSession(sessionId: string): void;
  restoreArchivedSession(sessionId: string): void;
  deleteArchivedSession(sessionId: string): void;
  restoreDeletedSession(sessionId: string): void;
};

const HISTORY_PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1_000;

type HistorySourceFilter = "all" | "termloop" | "claude" | "codex";
type HistoryStateFilter = "all" | "favorited" | "inactive" | "archived" | "deleted";
type HistoryTimeFilter = "all" | "today" | "7d" | "30d";
type HistoryLocationFilter = "all" | "project" | "branch" | "cwd";
type HistoryRelationship = "ask-to" | "fork";
type TermLoopPreviewState =
  | { state: "loading" }
  | { state: "waiting" }
  | { state: "ready"; result: SessionHistoryPreviewResult }
  | { state: "failed" };

export function inactiveHistorySessions(sessions: readonly Session[]): Session[] {
  return sessions
    .filter((session) => session.kind === "Agent"
      && !isLiveSession(session)
      && !isAssistantSession(session)
      && !sessionIsImprover(session)
      && session.run_configuration_id === null);
}

function historyRelationship(session: Session): HistoryRelationship | undefined {
  if (session.ask_to_source_session_id !== null) return "ask-to";
  if (session.fork_source_session_id !== null) return "fork";
  return undefined;
}

function HistorySessionTitle(props: { session: Session; title: string }) {
  const relationship = historyRelationship(props.session);
  return <span className="history-title-line">
    <strong>{props.title}</strong>
    {relationship ? <span className={`history-relationship-label ${relationship}`}>{relationship === "ask-to" ? "ASK-TO" : "FORK"}</span> : null}
  </span>;
}

function historyDate(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(epochMs);
}

function issueTotal(result: SessionHistoryListResult | undefined): number {
  if (!result) return 0;
  return result.issues.discovery_unavailable
    + result.issues.source_unreadable
    + result.issues.source_unrecognized;
}

function providerIcon(provider: string): "claude" | "codex" | "agent" {
  return provider === "claude" ? "claude" : provider === "codex" ? "codex" : "agent";
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string | undefined): boolean {
  return right !== undefined && comparablePath(left) === comparablePath(right);
}

function externalTimeMatches(epochMs: number, filter: HistoryTimeFilter, now = Date.now()): boolean {
  if (filter === "all") return true;
  if (filter === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return epochMs >= start.getTime();
  }
  return epochMs >= now - (filter === "7d" ? 7 : 30) * DAY_MS;
}

function validHistoryResult(result: SessionHistoryListResult): boolean {
  return Array.isArray(result.entries)
    && typeof result.issues?.discovery_unavailable === "number"
    && typeof result.issues.source_unreadable === "number"
    && typeof result.issues.source_unrecognized === "number"
    && typeof result.cache_filled === "boolean";
}

function TermLoopConversationPreview(props: { preview: TermLoopPreviewState | undefined }) {
  if (!props.preview || props.preview.state === "loading" || props.preview.state === "waiting") return <p role="status">Loading conversation preview…</p>;
  if (props.preview.state === "failed" || props.preview.result.status === "unavailable") {
    return <p>Conversation preview is unavailable in the local provider history.</p>;
  }
  const result = props.preview.result;
  return <>
    <span className="history-meta">{result.model ?? result.provider}{result.updated_at_epoch_ms === null ? "" : ` · ${historyDate(result.updated_at_epoch_ms)}`}</span>
    {result.preview_messages.map((message, index) => <p key={`${message.role}-${index}`}><b>{message.role === "user" ? "You" : result.provider}</b>{message.text}</p>)}
    {result.preview_messages.length === 0 ? <p>No conversation messages are available.</p> : null}
  </>;
}

export function HistoryRail(props: HistoryRailProps) {
  const [loaded, setLoaded] = useState<{ projectId: string; result: SessionHistoryListResult }>();
  const [loadingProjectId, setLoadingProjectId] = useState<string>();
  const [fillingProjectId, setFillingProjectId] = useState<string>();
  const [failure, setFailure] = useState<{ projectId: string; message: string }>();
  const [importingHandle, setImportingHandle] = useState<string>();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<HistorySourceFilter>("all");
  const [stateFilter, setStateFilter] = useState<HistoryStateFilter>("all");
  const [timeFilter, setTimeFilter] = useState<HistoryTimeFilter>("all");
  const [locationFilter, setLocationFilter] = useState<HistoryLocationFilter>("all");
  const [expandedRowKey, setExpandedRowKey] = useState<string>();
  const [expandedPreviewSessionId, setExpandedPreviewSessionId] = useState<string>();
  const [termLoopPreviews, setTermLoopPreviews] = useState<ReadonlyMap<string, TermLoopPreviewState>>(() => new Map());
  const [visibleExternalCount, setVisibleExternalCount] = useState(HISTORY_PAGE_SIZE);
  const loadGenerationRef = useRef(0);
  const initialLoadProjectRef = useRef<string | undefined>(undefined);
  const inactive = useMemo(() => inactiveHistorySessions(props.sessions), [props.sessions]);
  const archived = useMemo(() => inactiveHistorySessions(props.archivedSessions), [props.archivedSessions]);
  const deleted = useMemo(() => props.deletedSessions.filter((item) => (
    inactiveHistorySessions([item.session]).length === 1
  )), [props.deletedSessions]);
  const result = loaded && loaded.projectId === props.projectId ? loaded.result : undefined;
  const failureMessage = failure && failure.projectId === props.projectId ? failure.message : undefined;
  const loading = loadingProjectId === props.projectId;
  const filling = fillingProjectId === props.projectId;

  const reload = useCallback(async (force = false) => {
    const generation = ++loadGenerationRef.current;
    setVisibleExternalCount(HISTORY_PAGE_SIZE);
    if (!props.projectId) {
      setLoaded(undefined);
      setFailure(undefined);
      setLoadingProjectId(undefined);
      setFillingProjectId(undefined);
      return;
    }
    const projectId = props.projectId;
    setLoadingProjectId(projectId);
    setFillingProjectId(undefined);
    setFailure(undefined);
    let recent: SessionHistoryListResult;
    try {
      recent = await props.load(projectId, force, false);
      if (!validHistoryResult(recent)) throw new Error("Session history response is invalid.");
      if (loadGenerationRef.current !== generation) return;
      setLoaded({ projectId, result: recent });
    } catch (error) {
      if (loadGenerationRef.current === generation) {
        setFailure({ projectId, message: error instanceof Error ? error.message : "Session history is unavailable." });
      }
      return;
    } finally {
      if (loadGenerationRef.current === generation) {
        setLoadingProjectId((current) => current === projectId ? undefined : current);
      }
    }
    if (loadGenerationRef.current !== generation) return;
    setFillingProjectId(projectId);
    try {
      const filled = await props.load(projectId, false, true);
      if (!validHistoryResult(filled) || !filled.cache_filled) {
        throw new Error("Older session history could not be cached.");
      }
      if (loadGenerationRef.current === generation) setLoaded({ projectId, result: filled });
    } catch (error) {
      if (loadGenerationRef.current === generation) {
        setFailure({ projectId, message: error instanceof Error ? error.message : "Older session history is unavailable." });
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setFillingProjectId((current) => current === projectId ? undefined : current);
      }
    }
  }, [props.load, props.projectId]);

  useEffect(() => {
    if (initialLoadProjectRef.current === props.projectId) return;
    initialLoadProjectRef.current = props.projectId;
    void reload(false);
  }, [props.projectId, reload]);

  useEffect(() => setVisibleExternalCount(HISTORY_PAGE_SIZE), [props.projectId, query, sourceFilter, stateFilter, timeFilter, locationFilter]);
  useEffect(() => {
    setExpandedRowKey(undefined);
    setExpandedPreviewSessionId(undefined);
  }, [props.projectId, query, sourceFilter, stateFilter, timeFilter, locationFilter]);
  useEffect(() => setTermLoopPreviews(new Map()), [props.projectId]);

  useEffect(() => {
    if ((locationFilter === "branch" && (!props.projectBranch || sourceFilter === "termloop"))
      || (locationFilter === "cwd" && !props.currentCwd)
      || (locationFilter === "project" && !props.projectPath)) {
      setLocationFilter("all");
    }
  }, [locationFilter, props.currentCwd, props.projectBranch, props.projectPath, sourceFilter]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtersActive = Boolean(normalizedQuery)
    || sourceFilter !== "all"
    || stateFilter !== "all"
    || timeFilter !== "all"
    || locationFilter !== "all";
  const showTermLoop = sourceFilter === "all" || sourceFilter === "termloop";
  const showExternal = sourceFilter !== "termloop";
  const matchesTermLoopSession = (session: Session, timestamp: number | undefined) => {
    const relationship = historyRelationship(session);
    const matchesQuery = !normalizedQuery
      || sessionLabel(session).toLowerCase().includes(normalizedQuery)
      || session.process.cwd.toLowerCase().includes(normalizedQuery)
      || session.process.agent_id?.toLowerCase().includes(normalizedQuery)
      || session.lifecycle_state.toLowerCase().includes(normalizedQuery)
      || relationship?.includes(normalizedQuery);
    const matchesLocation = locationFilter === "all"
      || (locationFilter === "project" && samePath(session.process.cwd, props.projectPath))
      || (locationFilter === "cwd" && samePath(session.process.cwd, props.currentCwd));
    const matchesTime = timeFilter === "all"
      || (timestamp !== undefined && externalTimeMatches(timestamp, timeFilter));
    const matchesFavorite = stateFilter !== "favorited" || props.favoriteSessionIds.has(session.id);
    return matchesQuery && matchesTime && matchesLocation && matchesFavorite;
  };
  const visibleInactive = showTermLoop && (stateFilter === "all" || stateFilter === "favorited" || stateFilter === "inactive")
    ? inactive.filter((session) => matchesTermLoopSession(session, undefined))
    : [];
  const visibleArchived = showTermLoop && (stateFilter === "all" || stateFilter === "favorited" || stateFilter === "archived")
    ? archived.filter((session) => matchesTermLoopSession(session, session.archived_at_epoch_ms ?? undefined))
    : [];
  const visibleDeleted = showTermLoop && (stateFilter === "all" || stateFilter === "favorited" || stateFilter === "deleted")
    ? deleted.filter((item) => matchesTermLoopSession(item.session, item.deleted_at_epoch_ms))
    : [];
  const matchingExternal = showExternal ? (result?.entries ?? []).filter((entry) => {
    const matchesSource = sourceFilter === "all" || entry.provider === sourceFilter;
    const matchesQuery = !normalizedQuery
      || entry.title.toLowerCase().includes(normalizedQuery)
      || entry.cwd.toLowerCase().includes(normalizedQuery)
      || entry.model?.toLowerCase().includes(normalizedQuery)
      || entry.branch?.toLowerCase().includes(normalizedQuery)
      || entry.preview_messages.some((message) => message.text.toLowerCase().includes(normalizedQuery));
    const matchesLocation = locationFilter === "all"
      || (locationFilter === "project" && samePath(entry.cwd, props.projectPath))
      || (locationFilter === "branch" && Boolean(props.projectBranch) && entry.branch === props.projectBranch)
      || (locationFilter === "cwd" && samePath(entry.cwd, props.currentCwd));
    return matchesSource
      && matchesQuery
      && externalTimeMatches(entry.updated_at_epoch_ms, timeFilter)
      && matchesLocation;
  }) : [];
  const external = matchingExternal.slice(0, visibleExternalCount);
  const cachedMore = external.length < matchingExternal.length;
  const termLoopTotal = visibleInactive.length + visibleArchived.length + visibleDeleted.length;
  const total = termLoopTotal + matchingExternal.length;
  const issues = issueTotal(result);
  const toggleExpanded = (rowKey: string) => {
    setExpandedRowKey((current) => current === rowKey ? undefined : rowKey);
    setExpandedPreviewSessionId(undefined);
  };
  const previewCacheKey = (sessionId: string) => `${props.projectId ?? ""}:${sessionId}`;
  const expandedPreviewKey = expandedPreviewSessionId ? previewCacheKey(expandedPreviewSessionId) : undefined;
  const expandedPreview = expandedPreviewKey ? termLoopPreviews.get(expandedPreviewKey) : undefined;
  useEffect(() => {
    if (!expandedPreviewSessionId || !expandedPreviewKey || !props.projectId) return;
    if (expandedPreview?.state === "loading"
      || expandedPreview?.state === "ready"
      || expandedPreview?.state === "failed"
      || (expandedPreview?.state === "waiting" && filling)) return;
    const projectId = props.projectId;
    const sessionId = expandedPreviewSessionId;
    const key = expandedPreviewKey;
    setTermLoopPreviews((current) => new Map(current).set(key, { state: "loading" }));
    void props.loadTermLoopPreview(projectId, sessionId).then((preview) => {
      setTermLoopPreviews((current) => new Map(current).set(
        key,
        preview.status === "unavailable" && filling
          ? { state: "waiting" }
          : { state: "ready", result: preview },
      ));
    }).catch(() => {
      setTermLoopPreviews((current) => new Map(current).set(key, { state: "failed" }));
    });
  }, [expandedPreview, expandedPreviewKey, expandedPreviewSessionId, filling, props.loadTermLoopPreview, props.projectId]);
  const clickTermLoopRow = (sessionId: string, rowKey: string, select: boolean) => {
    if (expandedRowKey === rowKey) {
      setExpandedRowKey(undefined);
      setExpandedPreviewSessionId(undefined);
      return;
    }
    setExpandedRowKey(rowKey);
    setExpandedPreviewSessionId(sessionId);
    const key = previewCacheKey(sessionId);
    setTermLoopPreviews((current) => {
      const cached = current.get(key);
      if (!cached || cached.state === "loading" || (cached.state === "ready" && cached.result.status === "available")) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    if (select) props.selectSession(sessionId);
  };

  const importAndResume = async (entry: SessionHistoryEntryDto) => {
    if (!props.projectId || importingHandle) return;
    setImportingHandle(entry.history_handle);
    setFailure(undefined);
    try {
      const importFailure = await props.resumeExternal(props.projectId, entry.history_handle);
      if (importFailure) setFailure({ projectId: props.projectId, message: importFailure });
      else await reload(true);
    } catch (error) {
      setFailure({ projectId: props.projectId, message: error instanceof Error ? error.message : "Could not import this conversation." });
    } finally {
      setImportingHandle(undefined);
    }
  };

  return (
    <nav className="history-rail" aria-label="Session History">
      <header className="history-heading">
        <span className="rail-glyph" aria-hidden="true"><Icon name="history" /></span>
        <h2>Session History</h2>
        <span className="count-badge">{total}</span>
        <button type="button" className="history-refresh" title="Refresh Session History" aria-label="Refresh Session History" disabled={loading || filling || props.disabled} onClick={() => void reload(true)}><Icon name="restart" /></button>
      </header>
      <div className="history-search">
        <Icon name="search" />
        <input type="search" value={query} aria-label="Search Session History" placeholder="Search history" spellCheck={false} onChange={(event) => setQuery(event.currentTarget.value)} />
      </div>
      <div className="history-filters">
        <select aria-label="Filter Session History by source" value={sourceFilter} onChange={(event) => {
          const next = event.currentTarget.value as HistorySourceFilter;
          setSourceFilter(next);
          if (next !== "termloop") setStateFilter("all");
        }}>
          <option value="all">All sources</option>
          <option value="termloop">TermLoop</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <select aria-label="Filter Session History by time" value={timeFilter} onChange={(event) => setTimeFilter(event.currentTarget.value as HistoryTimeFilter)}>
          <option value="all">Any time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <select className="history-state-filter" aria-label="Filter Session History by state" value={stateFilter} onChange={(event) => {
          const next = event.currentTarget.value as HistoryStateFilter;
          setStateFilter(next);
          if (next !== "all") setSourceFilter("termloop");
        }}>
          <option value="all">Any state</option>
          <option value="favorited">Favorited</option>
          <option value="inactive">Inactive</option>
          <option value="archived">Archived</option>
          <option value="deleted">Deleted</option>
        </select>
        <select className="history-location-filter" aria-label="Filter Session History by location" value={locationFilter} onChange={(event) => setLocationFilter(event.currentTarget.value as HistoryLocationFilter)}>
          <option value="all">Any location</option>
          <option value="project" disabled={!props.projectPath}>This project root</option>
          <option value="branch" disabled={!props.projectBranch || sourceFilter === "termloop"}>{props.projectBranch ? `Branch · ${props.projectBranch}` : "Current branch unavailable"}</option>
          <option value="cwd" disabled={!props.currentCwd}>{props.currentCwd ? `Folder · ${basename(props.currentCwd)}` : "Current folder unavailable"}</option>
        </select>
      </div>
      {failureMessage ? <p className="history-notice error" role="alert">{failureMessage}</p> : null}
      {showExternal && issues > 0 ? <p className="history-notice">{issues} local history file{issues === 1 ? "" : "s"} could not be read.</p> : null}
      {showTermLoop ? <section className="history-section" aria-labelledby="termloop-history-label">
        <div className="rail-subhead" id="termloop-history-label"><span>TermLoop</span><span>{termLoopTotal}</span></div>
        <div className="history-list">
          {visibleInactive.map((session) => {
            const retryable = session.retryable;
            const title = sessionLabel(session);
            const rowKey = `inactive:${session.id}`;
            const expanded = expandedRowKey === rowKey;
            const preview = termLoopPreviews.get(previewCacheKey(session.id));
            return <article key={session.id} className={`history-row${expanded ? " expanded" : ""}${props.selectedSessionId === session.id ? " selected" : ""}`}>
              <button type="button" className="history-row-main" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} onClick={() => clickTermLoopRow(session.id, rowKey, true)}>
                <span className={`history-provider ${session.process.agent_id ?? "agent"}`} aria-hidden="true"><Icon name={providerIcon(session.process.agent_id ?? "")} /></span>
                <span className="history-copy"><HistorySessionTitle session={session} title={title} /><small>{basename(session.process.cwd)} · {session.lifecycle_state === "resumeFailed" ? "resume failed" : session.lifecycle_state}</small></span>
                <span className="history-disclosure" aria-hidden="true"><Icon name="chevronDown" /></span>
              </button>
              <button type="button" className="history-action" disabled={props.disabled} onClick={() => retryable ? props.resumeSession(session.id) : props.selectSession(session.id)}>{retryable ? "Resume" : "Open"}</button>
              {expanded ? <div className="history-detail history-preview">
                <TermLoopConversationPreview preview={preview} />
              </div> : null}
            </article>;
          })}
          {visibleArchived.map((session) => {
            const rowKey = `archived:${session.id}`;
            const expanded = expandedRowKey === rowKey;
            const title = sessionLabel(session);
            const preview = termLoopPreviews.get(previewCacheKey(session.id));
            return <article key={`archived-${session.id}`} className={`history-row archived${expanded ? " expanded" : ""}`}>
              <button type="button" className="history-row-main" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} onClick={() => clickTermLoopRow(session.id, rowKey, false)}>
                <span className={`history-provider ${session.process.agent_id ?? "agent"}`} aria-hidden="true"><Icon name={providerIcon(session.process.agent_id ?? "")} /></span>
                <span className="history-copy"><HistorySessionTitle session={session} title={title} /><small>{basename(session.process.cwd)} · archived</small></span>
                <span className="history-disclosure" aria-hidden="true"><Icon name="chevronDown" /></span>
              </button>
              <span className="history-row-actions">
                <button type="button" className="history-action" disabled={props.disabled} onClick={() => props.restoreArchivedSession(session.id)}>Restore</button>
                <button type="button" className="history-action destructive" title="Move this archived Agent to Deleted" aria-label={`Delete archived Agent ${title}`} disabled={props.disabled} onClick={() => props.deleteArchivedSession(session.id)}>Delete</button>
              </span>
              {expanded ? <div className="history-detail history-preview">
                <TermLoopConversationPreview preview={preview} />
              </div> : null}
            </article>;
          })}
          {visibleDeleted.map((item) => {
            const blocker = item.restore_blocker === "sourceUnavailable"
              ? "Source folder unavailable"
              : item.restore_blocker === "taskArchived" ? "Task is archived" : undefined;
            const rowKey = `deleted:${item.session.id}`;
            const expanded = expandedRowKey === rowKey;
            const title = sessionLabel(item.session);
            const preview = termLoopPreviews.get(previewCacheKey(item.session.id));
            return <article key={`deleted-${item.session.id}`} className={`history-row deleted${expanded ? " expanded" : ""}`}>
              <button type="button" className="history-row-main" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${title}`} onClick={() => clickTermLoopRow(item.session.id, rowKey, false)}>
                <span className={`history-provider ${item.session.process.agent_id ?? "agent"}`} aria-hidden="true"><Icon name={providerIcon(item.session.process.agent_id ?? "")} /></span>
                <span className="history-copy">
                  <HistorySessionTitle session={item.session} title={title} />
                  <small>{basename(item.session.process.cwd)} · deleted · {blocker ?? deletedRetentionLabel(item.purge_at_epoch_ms)}</small>
                </span>
                <span className="history-disclosure" aria-hidden="true"><Icon name="chevronDown" /></span>
              </button>
              <button type="button" className="history-action" title={blocker} disabled={props.disabled || Boolean(blocker)} onClick={() => props.restoreDeletedSession(item.session.id)}>Restore</button>
              {expanded ? <div className="history-detail history-preview">
                <TermLoopConversationPreview preview={preview} />
              </div> : null}
            </article>;
          })}
          {props.termLoopHistoryLoading && termLoopTotal === 0 ? <p className="history-empty" role="status">Loading TermLoop history…</p> : null}
          {!props.termLoopHistoryLoading && termLoopTotal === 0 ? <p className="history-empty">{filtersActive ? "No matching TermLoop Sessions." : "No inactive TermLoop Agents."}</p> : null}
        </div>
      </section> : null}
      {showExternal ? <section className="history-section" aria-labelledby="external-history-label">
        <div className="rail-subhead" id="external-history-label"><span>Claude &amp; Codex</span><span>{matchingExternal.length}</span></div>
        <div className="history-list">
          {external.map((entry) => {
            const rowKey = `external:${entry.history_handle}`;
            const expanded = expandedRowKey === rowKey;
            return <article key={entry.history_handle} className={`history-row external${expanded ? " expanded" : ""}`}>
              <button type="button" className="history-row-main" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.title}`} onClick={() => toggleExpanded(rowKey)}>
                <span className={`history-provider ${entry.provider}`} aria-hidden="true"><Icon name={providerIcon(entry.provider)} /></span>
                <span className="history-copy">
                  <strong title={entry.title}>{entry.title}</strong>
                  <small>{basename(entry.cwd)}{entry.branch ? ` · ${entry.branch}` : ""}</small>
                </span>
                <span className="history-disclosure" aria-hidden="true"><Icon name="chevronDown" /></span>
              </button>
              <button type="button" className="history-import" disabled={props.disabled || Boolean(importingHandle)} onClick={() => void importAndResume(entry)}>{importingHandle === entry.history_handle ? "Importing…" : "Import & Resume"}</button>
              {expanded ? <div className="history-detail history-preview">
                <span className="history-meta">{entry.model ?? entry.provider} · {historyDate(entry.updated_at_epoch_ms)}{entry.project_match === "related" ? " · worktree" : ""}</span>
                {entry.preview_messages.slice(-2).map((message, index) => <p key={`${message.role}-${index}`}><b>{message.role === "user" ? "You" : entry.provider}</b>{message.text}</p>)}
                {entry.preview_messages.length === 0 ? <p>No conversation preview is available.</p> : null}
              </div> : null}
            </article>;
          })}
          {loading && !result ? <p className="history-empty" role="status">Scanning local Claude and Codex history…</p> : null}
          {cachedMore ? <button type="button" className="history-more" onClick={() => setVisibleExternalCount((count) => count + HISTORY_PAGE_SIZE)}>Show 20 older</button> : null}
          {filling && !cachedMore ? <p className="history-empty" role="status">Caching older conversations…</p> : null}
          {!loading && !filling && matchingExternal.length === 0 ? <p className="history-empty">{filtersActive ? "No matching external conversations." : "No matching Claude or Codex conversations found."}</p> : null}
        </div>
      </section> : null}
      {showExternal && result?.cache_filled && result.truncated ? <p className="history-notice">Older provider conversations are outside this 100-item cache.</p> : null}
    </nav>
  );
}
