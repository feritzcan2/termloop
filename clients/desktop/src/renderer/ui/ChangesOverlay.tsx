import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { parseDiff, type FileData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type {
  TaskBranchCommitChangeListResult,
  TaskBranchCommitDiffResult,
  TaskBranchCommitPreImageResult,
  TaskBranchCommitListResult,
  GitHostPullRequestChangeListResult,
  GitHostPullRequestDiffResult,
  GitHostPullRequestIdentityDto,
  TaskBranchSetDto,
} from "@termloop/contract/current";
import { sessionLabel, type GitHostProjection, type Session } from "../model.js";
import { changesReviewOwner, changesReviewScope } from "../changes-reviewed-memory.js";
import { useChangesReviewed } from "./useChangesReviewed.js";
import {
  localChangeKey,
  recoverLocalChange,
  type LocalChangeListResult,
  type LocalDiffResult,
  type LocalPreImageResult,
  type RecoveredLocalChange,
} from "../changes-local-recovery.js";
import {
  buildChangeTree,
  changeTreeFolderId,
  visibleChangeTreeEntries,
} from "../change-tree.js";
import { Icon } from "./Icon.js";
import { ChangesFilesResizeHandle, useChangesFilesWidth } from "./ChangesFilesResizeHandle.js";
import {
  ChangeBadge,
  ChangeSection,
  type ChangeEntry,
  type ChangeTreeSection,
} from "./ChangeFileTree.js";
import { editableChangePath, type ChangesEditing } from "./ChangesFileEditor.js";
import { ChangesDiffEditor, type ChangeNavigator, type ChangePosition } from "./ChangesDiffEditor.js";
import { changeBlockCount, diffStats, hideWhitespaceChanges, targetChangeBlock, type DiffStats } from "../diff-review.js";
import { DiffSummary, REVIEW_KEYS, ReviewShortcuts, nextPendingEntry } from "./ChangesReviewAids.js";
import { type ChangeReviewDraft } from "./ChangesLineReview.js";
import { DiffState, RenderedDiff } from "./ChangesRenderedDiff.js";
import { isTextEntryTarget, trapDialogFocus } from "./changes-dialog-keys.js";
import { ChangesBranchPicker, ChangesSourcePicker } from "./ChangesSourcePicker.js";
import {
  changesBranchScopes,
  initialScopeKey,
  scopeAllowsSource,
  scopeDefaultSource,
  scopeHasCommits,
} from "../changes-branch-scope.js";
import {
  ALL_BRANCH_CHANGES_ID,
  cacheDiff,
  cacheLruEntry,
  cachePreImage,
  currentPullRequestSource,
  pullRequestIdentity,
  pullRequestKey,
  sourceKey,
  touchLruEntry,
  type CachedDiff,
  type CachedPreImage,
  type ChangesOpenSource,
  type ChangesSource,
} from "../change-source.js";
import {
  MAX_CHANGE_REVIEW_MESSAGE_BYTES,
  MAX_CHANGE_REVIEW_NOTES,
  buildChangeReviewMessage,
  changeReviewLine,
  reviewMessageByteLength,
  type ChangeReviewLine,
  type ChangeReviewNote,
} from "../changes-review.js";
import {
  fullFileStatusMessage,
  fullFileView,
  preImageRefusal,
  type FullFileView,
} from "../changes-full-file.js";

type DiffResult = LocalDiffResult | TaskBranchCommitDiffResult | GitHostPullRequestDiffResult;

export type ChangesSubject = {
  id: string;
  title: string;
  branchName?: string | undefined;
  kind: "task" | "project";
  hasWorktree: boolean;
  hasBranch: boolean;
  /** The daemon's Task branch set; the view scopes its sources to one branch. */
  branches?: TaskBranchSetDto | undefined;
};

export type ChangesOverlayProps = {
  subject: ChangesSubject;
  connectionProfileId?: string | undefined;
  initialSource: ChangesOpenSource;
  close(): void;
  list(subjectId: string): Promise<LocalChangeListResult>;
  diff(subjectId: string, observationId: string, entryId: string): Promise<LocalDiffResult>;
  preImage(subjectId: string, observationId: string, entryId: string): Promise<LocalPreImageResult>;
  listCommits(taskId: string, branchId?: string): Promise<TaskBranchCommitListResult>;
  listCommitChanges(taskId: string, observationId: string, commitId: string): Promise<TaskBranchCommitChangeListResult>;
  commitDiff(taskId: string, observationId: string, commitId: string, entryId: string): Promise<TaskBranchCommitDiffResult>;
  commitPreImage(taskId: string, observationId: string, commitId: string, entryId: string): Promise<TaskBranchCommitPreImageResult>;
  gitHostProjection: GitHostProjection | undefined;
  listPullRequestChanges(taskId: string, expectedFreshnessGeneration: number, pullRequest: GitHostPullRequestIdentityDto): Promise<GitHostPullRequestChangeListResult>;
  pullRequestDiff(taskId: string, observationId: string, entryId: string): Promise<GitHostPullRequestDiffResult>;
  agentSessions: readonly Session[];
  sendReviewNotes(taskId: string, sessionId: string, message: string): Promise<string | undefined>;
  editing?: ChangesEditing | undefined;
  /** The window draws its controls over the content's top-left corner (macOS inset traffic lights). */
  windowControlsInset?: boolean | undefined;
};

export function ChangesOverlay({
  subject,
  connectionProfileId,
  initialSource,
  close,
  list,
  diff,
  preImage,
  listCommits,
  listCommitChanges,
  commitDiff,
  commitPreImage,
  gitHostProjection,
  listPullRequestChanges,
  pullRequestDiff,
  agentSessions,
  sendReviewNotes,
  editing,
  windowControlsInset = false,
}: ChangesOverlayProps) {
  const overlayRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const filesWidth = useChangesFilesWidth(bodyRef);
  const [filesResizing, setFilesResizing] = useState(false);
  // Composition rebuilds these adapters on unrelated projection renders. Keep
  // effects keyed to the change source while still invoking the newest adapter.
  const readsRef = useRef({ list, diff, preImage, listCommits, listCommitChanges, commitDiff, commitPreImage, listPullRequestChanges, pullRequestDiff });
  readsRef.current = { list, diff, preImage, listCommits, listCommitChanges, commitDiff, commitPreImage, listPullRequestChanges, pullRequestDiff };
  const initialSourceRef = useRef(initialSource);
  initialSourceRef.current = initialSource;
  const initialSourceKey = initialSource.kind === "pullRequest"
    ? `pullRequest:${pullRequestKey(initialSource.pullRequest)}:${initialSource.freshnessGeneration}`
    : initialSource.kind === "commits"
      ? `commits:${initialSource.branchId ?? "primary"}`
      : initialSource.kind;
  const gitHostProjectionRef = useRef(gitHostProjection);
  gitHostProjectionRef.current = gitHostProjection;
  const [localChanges, setLocalChanges] = useState<LocalChangeListResult>();
  const [commitList, setCommitList] = useState<TaskBranchCommitListResult>();
  const [commitChanges, setCommitChanges] = useState<ReadonlyMap<string, TaskBranchCommitChangeListResult>>(new Map());
  const [pullRequestChanges, setPullRequestChanges] = useState<ReadonlyMap<string, GitHostPullRequestChangeListResult>>(new Map());
  const [selectedSource, setSelectedSource] = useState<ChangesSource>(() => initialSelection(initialSource));
  const [selectedId, setSelectedId] = useState<string>();
  const [diffs, setDiffs] = useState<ReadonlyMap<string, CachedDiff>>(new Map());
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingSourceKey, setLoadingSourceKey] = useState<string>();
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string>();
  const [viewType, setViewType] = useState<"unified" | "split">("unified");
  const [fullFile, setFullFile] = useState(false);
  const [hideWhitespace, setHideWhitespace] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Focus mode fills the whole window, covering the sidebars and tab strip.
  const [focusMode, setFocusMode] = useState(false);
  const navigatorRef = useRef<ChangeNavigator | undefined>(undefined);
  const [preImages, setPreImages] = useState<ReadonlyMap<string, CachedPreImage>>(new Map());
  const [loadingPreImage, setLoadingPreImage] = useState(false);
  const [preImageError, setPreImageError] = useState<string>();
  // The change whose editable diff came out empty or never finished; it is
  // shown as the read-only patch until the entry is listed again.
  const [editFallback, setEditFallback] = useState<{ key: string; reason: string }>();
  const [reviewNotes, setReviewNotes] = useState<ReadonlyMap<string, ChangeReviewNote>>(new Map());
  const [reviewDraft, setReviewDraft] = useState<ChangeReviewDraft>();
  const [targetSessionId, setTargetSessionId] = useState<string>();
  const [sendingReview, setSendingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const hasWorktree = subject.hasWorktree;
  const hasBranch = subject.hasBranch;
  const branchScopes = useMemo(() => subject.kind === "task"
    ? changesBranchScopes({
        branches: subject.branches,
        primaryBranchName: subject.branchName,
        hasWorktree,
        pullRequests: gitHostProjection?.matches,
      })
    : [], [gitHostProjection?.matches, hasWorktree, subject.branchName, subject.branches, subject.kind]);
  const [initialBranchScopeKey] = useState(() => initialScopeKey(branchScopes, initialSource, subject.branches));
  const [branchScopeKey, setBranchScopeKey] = useState(initialBranchScopeKey);
  const branchScope = branchScopes.find((scope) => scope.key === branchScopeKey) ?? branchScopes[0];
  const branchScopeRef = useRef(branchScope);
  branchScopeRef.current = branchScope;
  const clearPullRequestArtifacts = useCallback(() => {
    setPullRequestChanges((current) => withoutKeyPrefix(current, "pullRequest:"));
    setDiffs((current) => withoutKeyPrefix(current, "pullRequest:"));
    setReviewNotes((current) => withoutKeyPrefix(current, "pullRequest:"));
    setReviewDraft((current) => current?.key.startsWith("pullRequest:") ? undefined : current);
  }, []);
  const applyRecoveredLocalChange = useCallback((recovered: RecoveredLocalChange) => {
    const key = localChangeKey(recovered.changes.observation_id, recovered.entry.entry_id);
    setLocalChanges(recovered.changes);
    setSelectedId(recovered.entry.entry_id);
    setDiffs((current) => cacheDiff(withoutKeyPrefix(current, "local:"), key, recovered.diff));
    setPreImages((current) => recovered.preImage
      ? cachePreImage(withoutKeyPrefix(current, "local:"), key, recovered.preImage)
      : withoutKeyPrefix(current, "local:"));
    setError(undefined);
    setPreImageError(undefined);
  }, []);

  const refresh = useCallback(async () => {
    const { list, listCommits } = readsRef.current;
    const initialSource = initialSourceRef.current;
    const scope = branchScopeRef.current;
    const loadCommits = hasBranch && (!scope || scopeHasCommits(scope));
    const commitBranchId = scope
      ? scope.branchId
      : initialSource.kind === "commits" ? initialSource.branchId : undefined;
    setLoadingSources(true);
    setError(undefined);
    setDiffs(new Map());
    setPreImages(new Map());
    setPreImageError(undefined);
    setCommitChanges(new Map());
    setPullRequestChanges(new Map());
    const [localResult, commitResult] = await Promise.allSettled([
      hasWorktree ? list(subject.id) : Promise.resolve(undefined),
      loadCommits ? listCommits(subject.id, commitBranchId) : Promise.resolve(undefined),
    ]);
    const nextLocal = localResult.status === "fulfilled" ? localResult.value : undefined;
    const nextCommits = commitResult.status === "fulfilled" ? commitResult.value : undefined;
    setLocalChanges(nextLocal);
    setCommitList(nextCommits);
    // The source the view was opened for wins only on its own branch; another
    // branch opens on that branch's most relevant source.
    const opened = refreshedInitialSelection(initialSource, nextLocal, nextCommits, gitHostProjectionRef.current);
    const preferred = scope && (scope.key !== initialBranchScopeKey || !scopeAllowsSource(scope, opened))
      ? scopeDefaultSource(scope, Boolean(nextLocal?.entries.length), nextCommits, gitHostProjectionRef.current?.freshness_generation)
      : opened;
    setSelectedSource(preferred);
    if (initialSource.kind === "local" && localResult.status === "rejected") {
      setError(errorMessage(localResult.reason, "Local changes could not be loaded."));
    } else if (initialSource.kind === "commits" && commitResult.status === "rejected") {
      setError(errorMessage(commitResult.reason, "Commits could not be loaded."));
    } else if (initialSource.kind !== "pullRequest" && !nextLocal && !nextCommits) {
      const failure = localResult.status === "rejected" ? localResult.reason
        : commitResult.status === "rejected" ? commitResult.reason : undefined;
      setError(errorMessage(failure, "Git changes could not be loaded."));
    }
    setLoadingSources(false);
  }, [branchScope?.key, hasBranch, hasWorktree, initialBranchScopeKey, initialSourceKey, subject.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Selecting a file in the Source Control panel targets it here; apply that
  // once per request so later refreshes keep the reader's own selection.
  const initialEntry = initialSource.kind === "local" ? initialSource.entry : undefined;
  const initialEntryKey = initialEntry ? `${initialEntry.side}:${initialEntry.path}` : undefined;
  const appliedEntryKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialEntryKey || appliedEntryKey.current === initialEntryKey || !localChanges) return;
    const entry = localChanges.entries.find((candidate) => `${candidate.side}:${candidate.display_path}` === initialEntryKey);
    if (!entry) return;
    appliedEntryKey.current = initialEntryKey;
    setSelectedSource({ kind: "local" });
    setSelectedId(entry.entry_id);
  }, [initialEntryKey, localChanges]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    overlayRef.current?.focus({ preventScroll: true });
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (selectedSource.kind !== "commit" || !commitList || commitChanges.has(selectedSource.commitId)) return;
    const { listCommitChanges } = readsRef.current;
    let active = true;
    setLoadingSourceKey(sourceKey(selectedSource));
    setError(undefined);
    void listCommitChanges(subject.id, commitList.observation_id, selectedSource.commitId)
      .then((result) => {
        if (!active) return;
        setCommitChanges((current) => new Map(current).set(selectedSource.commitId, result));
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure, "Committed files became stale. Refresh and try again."));
      })
      .finally(() => { if (active) setLoadingSourceKey(undefined); });
    return () => { active = false; };
  }, [commitChanges, commitList, selectedSource, subject.id]);

  const selectedSourceKey = sourceKey(selectedSource);
  const selectedPullRequestIsCurrent = currentPullRequestSource(selectedSource, gitHostProjection);
  const gitHostProjectionFingerprint = useMemo(() => gitHostProjection
    ? `${gitHostProjection.freshness_generation}:${gitHostProjection.matches
      .map((match) => pullRequestKey(pullRequestIdentity(match)))
      .sort()
      .join(",")}`
    : "none", [gitHostProjection]);
  const previousGitHostProjectionFingerprint = useRef(gitHostProjectionFingerprint);
  const currentPullRequestSourcePrefixes = useMemo(() => (
    gitHostProjection?.matches.map((match) => sourceKey({
      kind: "pullRequest",
      pullRequest: pullRequestIdentity(match),
      freshnessGeneration: gitHostProjection.freshness_generation,
    })) ?? []
  ), [gitHostProjection]);

  useEffect(() => {
    if (previousGitHostProjectionFingerprint.current === gitHostProjectionFingerprint) return;
    previousGitHostProjectionFingerprint.current = gitHostProjectionFingerprint;
    clearPullRequestArtifacts();
  }, [clearPullRequestArtifacts, gitHostProjectionFingerprint]);

  useEffect(() => {
    if (selectedSource.kind !== "pullRequest" || selectedPullRequestIsCurrent) return;
    clearPullRequestArtifacts();
    setSelectedId(undefined);
    setLoadingSourceKey(undefined);
    setLoadingDiff(false);
    setError("The pull request projection changed. Select the current pull request source again.");
  }, [clearPullRequestArtifacts, selectedPullRequestIsCurrent, selectedSource.kind]);

  useEffect(() => {
    if (selectedSource.kind !== "pullRequest" || !selectedPullRequestIsCurrent) return;
    const key = selectedSourceKey;
    if (pullRequestChanges.has(key)) return;
    const { listPullRequestChanges } = readsRef.current;
    let active = true;
    setLoadingSourceKey(key);
    setError(undefined);
    void listPullRequestChanges(
      subject.id,
      selectedSource.freshnessGeneration,
      selectedSource.pullRequest,
    )
      .then((result) => {
        if (!active) return;
        setPullRequestChanges((current) => cacheLruEntry(current, key, result, 16));
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure, "Pull request files could not be loaded."));
      })
      .finally(() => { if (active) setLoadingSourceKey(undefined); });
    return () => { active = false; };
  }, [pullRequestChanges, selectedPullRequestIsCurrent, selectedSource, selectedSourceKey, subject.id]);

  const currentCommitChanges = selectedSource.kind === "commit"
    ? commitChanges.get(selectedSource.commitId)
    : undefined;
  const currentPullRequestChanges = selectedSource.kind === "pullRequest" && selectedPullRequestIsCurrent
    ? pullRequestChanges.get(selectedSourceKey)
    : undefined;
  const currentEntries: readonly ChangeEntry[] = useMemo(
    () => selectedSource.kind === "local"
      ? localChanges?.entries ?? []
      : selectedSource.kind === "commit"
        ? currentCommitChanges?.entries ?? []
        : currentPullRequestChanges?.entries ?? [],
    [currentCommitChanges?.entries, currentPullRequestChanges?.entries, localChanges?.entries, selectedSource.kind],
  );
  const currentObservationId = selectedSource.kind === "local"
    ? localChanges?.observation_id
    : selectedSource.kind === "commit"
      ? currentCommitChanges?.observation_id
      : currentPullRequestChanges?.observation_id ?? undefined;
  const reviewScopeKey = changesReviewScope(selectedSource, localChanges, commitList, subject.branchName);
  const { reviewedEntryIds, busy: reviewing, notice: reviewNotice, setReviewed } = useChangesReviewed({
    owner: changesReviewOwner(subject, connectionProfileId),
    scope: reviewScopeKey,
    observationId: currentObservationId,
    entries: currentEntries,
    loading: loadingSources || loadingSourceKey === selectedSourceKey,
    truncated: (selectedSource.kind === "local" ? localChanges?.truncated
      : selectedSource.kind === "commit" ? currentCommitChanges?.truncated : currentPullRequestChanges?.truncated) ?? true,
    readDiff: (entryId) => selectedSource.kind === "local"
      ? readsRef.current.diff(subject.id, currentObservationId!, entryId)
      : selectedSource.kind === "commit"
        ? readsRef.current.commitDiff(subject.id, currentObservationId!, selectedSource.commitId, entryId)
        : readsRef.current.pullRequestDiff(subject.id, currentObservationId!, entryId),
    cachedDiff: (entryId) => diffs.get(selectedSource.kind === "local"
      ? localChangeKey(currentObservationId, entryId) : `${selectedSourceKey}:${entryId}`),
  });
  const changeTreeSections = useMemo<readonly ChangeTreeSection[]>(() => {
    const pending = currentEntries.filter((entry) => !reviewedEntryIds.has(entry.entry_id));
    const reviewed = currentEntries.filter((entry) => reviewedEntryIds.has(entry.entry_id));
    if (selectedSource.kind !== "local") {
      return [
        { id: "files", title: "Files to review", nodes: compactTree(pending), entryCount: pending.length },
        { id: "reviewed", title: "Reviewed", nodes: compactTree(reviewed), entryCount: reviewed.length },
      ];
    }
    const staged = pending.filter((entry) => "side" in entry && entry.side === "staged");
    const unstaged = pending.filter((entry) => "side" in entry && entry.side === "unstaged");
    const untracked = pending.filter((entry) => "side" in entry && entry.side === "untracked");
    return [
      { id: "staged", title: "Staged", nodes: compactTree(staged), entryCount: staged.length },
      { id: "unstaged", title: "Working tree", nodes: compactTree(unstaged), entryCount: unstaged.length },
      { id: "untracked", title: "Untracked", nodes: compactTree(untracked), entryCount: untracked.length },
      { id: "reviewed", title: "Reviewed", nodes: compactTree(reviewed), entryCount: reviewed.length },
    ];
  }, [currentEntries, reviewedEntryIds, selectedSource.kind]);
  const visibleEntries = useMemo(
    () => changeTreeSections.flatMap((section) => collapsedFolders.has(changeTreeFolderId(section.id, ""))
      ? []
      : visibleChangeTreeEntries(section.nodes, collapsedFolders, section.id)),
    [changeTreeSections, collapsedFolders],
  );

  useEffect(() => {
    if (reviewing) return;
    setSelectedId((current) => visibleEntries.some((entry) => entry.entry_id === current)
      ? current
      : visibleEntries[0]?.entry_id);
  }, [reviewing, selectedSourceKey, visibleEntries]);

  useEffect(() => { setCollapsedFolders(new Set([changeTreeFolderId("reviewed", "")])); }, [selectedSourceKey]);

  const selected = currentEntries.find((entry) => entry.entry_id === selectedId);
  const diffKey = selectedId ? selectedSource.kind === "local"
    ? localChangeKey(localChanges?.observation_id, selectedId)
    : `${selectedSourceKey}:${selectedId}` : undefined;
  useEffect(() => {
    if (loadingSources || reviewing || !selected || !diffKey || selected.render_state === "notShown" || diffs.has(diffKey)) {
      setLoadingDiff(false);
      return;
    }
    const { diff, commitDiff, pullRequestDiff } = readsRef.current;
    const observationId = selectedSource.kind === "local"
      ? localChanges?.observation_id
      : selectedSource.kind === "commit"
        ? commitList?.observation_id
        : currentPullRequestChanges?.observation_id;
    if (!observationId) return;
    let active = true;
    setLoadingDiff(true);
    setError(undefined);
    const request = selectedSource.kind === "local"
      ? diff(subject.id, observationId, selected.entry_id)
      : selectedSource.kind === "commit"
        ? commitDiff(subject.id, observationId, selectedSource.commitId, selected.entry_id)
        : pullRequestDiff(subject.id, observationId, selected.entry_id);
    void request
      .catch(async (failure) => {
        if (selectedSource.kind !== "local" || !localChanges || !("side" in selected)) throw failure;
        const recovered = await recoverLocalChange(failure, readsRef.current, subject.id, localChanges, selected, false, () => active);
        if (recovered) applyRecoveredLocalChange(recovered);
        return undefined;
      })
      .then((result) => {
        if (!active || !result) return;
        setDiffs((current) => cacheDiff(current, diffKey, result));
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure, "The diff became stale. Refresh and try again."));
      })
      .finally(() => { if (active) setLoadingDiff(false); });
    return () => { active = false; };
  }, [applyRecoveredLocalChange, commitList?.observation_id, currentPullRequestChanges?.observation_id, diffKey, diffs, loadingSources, reviewing, localChanges, selected, selectedSource, subject.id]);

  // Unstaged and untracked files are edited in their diff; staged changes
  // stay read-only because the working-tree file is not what they show.
  const editPath = selectedSource.kind === "local" && editing
    && selected && "side" in selected && selected.side !== "staged" && selected.render_state !== "notShown"
    ? editableChangePath(selected)
    : undefined;

  const selectedDiff = diffKey
    && (selectedSource.kind !== "pullRequest" || selectedPullRequestIsCurrent)
    ? diffs.get(diffKey)
    : undefined;
  useEffect(() => {
    if (!diffKey || !selectedDiff) return;
    setDiffs((current) => touchLruEntry(current, diffKey));
  }, [diffKey, selectedDiff]);
  const parsed = useMemo(() => parsePatch(selectedDiff), [selectedDiff]);
  // Full-file mode needs the old-side blob, which the worktree and the Task
  // branch can supply. A pull request keeps the change-focused view and says
  // why, from this one string so the control and the status line cannot drift.
  const fullFileUnsupportedReason = selectedSource.kind === "pullRequest"
    ? "The whole file is not available for pull request changes."
    : undefined;
  const fullFileSupported = fullFileUnsupportedReason === undefined;
  const selectedPreImage = fullFileSupported && diffKey ? preImages.get(diffKey) : undefined;
  // The editable diff compares against the pre-image; a refused pre-image
  // falls back to the read-only patch view.
  const editFallbackReason = editFallback && editFallback.key === diffKey ? editFallback.reason : undefined;
  const editOriginal = editPath === undefined || !selectedPreImage || editFallbackReason ? undefined
    : selectedPreImage.state === "absent" ? ""
      : selectedPreImage.state === "content" ? selectedPreImage.content ?? undefined : undefined;
  const editableDiff = editOriginal !== undefined;
  const awaitingEditableDiff = editPath !== undefined && !selectedPreImage && !preImageError;
  // A working-tree change that falls back to the read-only diff says why.
  const editRefusal = editPath === undefined || editableDiff || awaitingEditableDiff ? undefined
    : `Read-only here: ${editFallbackReason ?? preImageError ?? (selectedPreImage && preImageRefusal(selectedPreImage.state)) ?? "the original file could not be read."}`;

  useEffect(() => {
    if (loadingSources || !diffKey || (editPath === undefined && (!fullFile || !fullFileSupported || !parsed))) return;
    if (preImages.has(diffKey) || selectedSource.kind === "pullRequest") return;
    const { preImage, commitPreImage } = readsRef.current;
    const observationId = selectedSource.kind === "local" ? localChanges?.observation_id : commitList?.observation_id;
    const entryId = selected?.entry_id;
    if (!observationId || !entryId) return;
    let active = true;
    setLoadingPreImage(true);
    setPreImageError(undefined);
    const request: Promise<CachedPreImage> = selectedSource.kind === "local"
      ? preImage(subject.id, observationId, entryId)
      : commitPreImage(subject.id, observationId, selectedSource.commitId, entryId);
    void request
      .catch(async (failure) => {
        if (selectedSource.kind !== "local" || !localChanges || !selected || !("side" in selected)) throw failure;
        const recovered = await recoverLocalChange(failure, readsRef.current, subject.id, localChanges, selected, true, () => active);
        if (recovered) applyRecoveredLocalChange(recovered);
        return undefined;
      })
      .then((result) => {
        if (!active || !result) return;
        setPreImages((current) => cachePreImage(current, diffKey, result));
      })
      .catch((failure) => {
        if (active) setPreImageError(errorMessage(failure, "The full file could not be read."));
      })
      .finally(() => { if (active) setLoadingPreImage(false); });
    return () => { active = false; };
  }, [applyRecoveredLocalChange, commitList?.observation_id, diffKey, editPath, fullFile, fullFileSupported, loadingSources, localChanges, parsed, preImages, selected, selectedSource, subject.id]);

  const fullFileState: FullFileView | undefined = useMemo(() => {
    if (!fullFile || !parsed) return undefined;
    if (!selectedPreImage) return undefined;
    const refusal = preImageRefusal(selectedPreImage.state);
    if (refusal) return { state: "unavailable", reason: refusal };
    if (selectedPreImage.content === null) {
      return { state: "unavailable", reason: "The full file could not be read." };
    }
    return fullFileView(parsed.hunks, selectedPreImage.content);
  }, [fullFile, parsed, selectedPreImage]);

  const expandedHunks = fullFileState?.state === "fullFile" || fullFileState?.state === "alreadyComplete"
    ? fullFileState.hunks
    : parsed?.hunks;
  const renderedHunks = useMemo(
    () => hideWhitespace && expandedHunks ? hideWhitespaceChanges(expandedHunks) : expandedHunks,
    [expandedHunks, hideWhitespace],
  );
  const selectedStats = useMemo(() => renderedHunks ? diffStats(renderedHunks) : undefined, [renderedHunks]);
  const selectedBlockCount = useMemo(() => renderedHunks ? changeBlockCount(renderedHunks) : 0, [renderedHunks]);
  // Line counts for files whose patch this view has already read; the list
  // itself carries none, so a file shows its counts once it has been opened.
  // Each cached patch is parsed for its counts once, not on every LRU touch.
  const statsByDiff = useRef(new WeakMap<CachedDiff, DiffStats | null>());
  const entryStats = useMemo(() => {
    const stats = new Map<string, DiffStats>();
    for (const entry of currentEntries) {
      const cached = diffs.get(selectedSource.kind === "local"
        ? localChangeKey(currentObservationId, entry.entry_id)
        : `${selectedSourceKey}:${entry.entry_id}`);
      if (!cached) continue;
      let counted = statsByDiff.current.get(cached);
      if (counted === undefined) {
        const file = parsePatch(cached);
        counted = file ? diffStats(file.hunks) : null;
        statsByDiff.current.set(cached, counted);
      }
      if (counted) stats.set(entry.entry_id, counted);
    }
    return stats;
  }, [currentEntries, currentObservationId, diffs, selectedSource.kind, selectedSourceKey]);
  // `fullFileView` already counted this; reading it back keeps the total under the
  // diff and the status line from ever disagreeing.
  const hiddenLineCount = fullFileState?.state === "fullFile"
    ? fullFileState.revealedLines
    : fullFileState?.state === "alreadyComplete"
      ? 0
      : undefined;

  const fullFileStatus = fullFileStatusMessage({
    fullFile,
    unsupportedReason: fullFileUnsupportedReason,
    loading: loadingPreImage,
    error: preImageError,
    view: fullFileState,
  });
  const selectedCommit = selectedSource.kind === "commit"
    ? commitList?.commits.find((commit) => commit.commit_id === selectedSource.commitId)
    : undefined;
  const currentListTruncated = selectedSource.kind === "local"
    ? localChanges?.truncated
    : selectedSource.kind === "commit"
      ? currentCommitChanges?.truncated
      : currentPullRequestChanges?.truncated;
  // Editable diff comments name the file, not the observation, so they
  // survive the re-list that follows each save.
  const selectedReviewPrefix = !selected || !diffKey ? undefined
    : editableDiff && "side" in selected ? `localFile:${selected.side}:${selected.display_path}:` : `${diffKey}:`;
  const activeReviewNotes = useMemo(
    () => [...reviewNotes.values()].filter(
      (note) => note.body.trim().length > 0
        && (!note.key.startsWith("pullRequest:")
          || currentPullRequestSourcePrefixes.some((prefix) => note.key.startsWith(`${prefix}:`))),
    ),
    [currentPullRequestSourcePrefixes, reviewNotes],
  );
  const reviewMessage = useMemo(
    () => buildChangeReviewMessage(subject.title, activeReviewNotes),
    [activeReviewNotes, subject.title],
  );
  const reviewMessageBytes = reviewMessageByteLength(reviewMessage);
  const currentReviewNotes = useMemo(
    () => selectedReviewPrefix
      ? activeReviewNotes.filter((note) => note.key.startsWith(selectedReviewPrefix))
      : [],
    [activeReviewNotes, selectedReviewPrefix],
  );

  useEffect(() => { setReviewDraft(undefined); }, [selectedReviewPrefix]);

  useEffect(() => {
    setTargetSessionId((current) => {
      if (current && agentSessions.some((session) => session.id === current)) return current;
      return agentSessions.length === 1 ? agentSessions[0]?.id : undefined;
    });
  }, [agentSessions]);

  const openLineReview = (line: ChangeReviewLine) => {
    if (!selected || !selectedReviewPrefix) return;
    const key = `${selectedReviewPrefix}${line.changeKey}`;
    if (!reviewNotes.has(key) && reviewNotes.size >= MAX_CHANGE_REVIEW_NOTES) {
      setReviewError(`Only ${MAX_CHANGE_REVIEW_NOTES} line comments can be sent at once.`);
      return;
    }
    setReviewError(undefined);
    setReviewDraft({
      key,
      sourceLabel: selectedSource.kind === "local"
        ? `Local changes · ${"side" in selected ? selected.side : "file"}`
        : selectedSource.kind === "commit"
          ? selectedSource.commitId === ALL_BRANCH_CHANGES_ID
            ? `All changes on ${commitList?.branch_name ?? "branch"}`
            : `${commitList?.branch_name ?? "Branch"} · commit ${selectedCommit?.short_oid ?? selectedSource.commitId.slice(0, 8)}`
          : `${selectedSource.pullRequest.provider === "azureDevOps" ? "Azure PR" : "PR"} #${selectedSource.pullRequest.number}`,
      displayPath: selected.display_path,
      pathEncoding: selected.path_encoding,
      ...line,
    });
  };

  // A save moves the worktree past this observation: list it again so the
  // tree shows it, keeping the edited file selected under its new entry ID.
  // Its pre-image is the index or HEAD, which an edit does not change.
  const relistAfterSave = async () => {
    if (!selected || !("side" in selected)) return;
    const key = `${selected.side}:${selected.display_path}`;
    const preImage = diffKey ? preImages.get(diffKey) : undefined;
    try {
      const next = await readsRef.current.list(subject.id);
      const match = next.entries.find((candidate) => `${candidate.side}:${candidate.display_path}` === key);
      setDiffs((current) => withoutKeyPrefix(current, "local:"));
      setPreImages((current) => {
        const cleared = withoutKeyPrefix(current, "local:");
        return match && preImage ? cachePreImage(cleared, localChangeKey(next.observation_id, match.entry_id), preImage) : cleared;
      });
      setLocalChanges(next);
      if (match) setSelectedId(match.entry_id);
    } catch (failure) {
      setError(errorMessage(failure, "Local changes could not be loaded."));
    }
  };

  const updateReviewNote = (draft: ChangeReviewDraft, body: string) => {
    setReviewNotes((current) => {
      const next = new Map(current);
      if (body.trim().length === 0) {
        next.delete(draft.key);
        return next;
      }
      if (!next.has(draft.key) && next.size >= MAX_CHANGE_REVIEW_NOTES) return current;
      next.set(draft.key, { ...draft, body });
      return next;
    });
  };

  const removeReviewNote = (key: string) => {
    setReviewNotes((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
    setReviewDraft((current) => current?.key === key ? undefined : current);
  };

  const submitReview = async () => {
    if (!targetSessionId || activeReviewNotes.length === 0 || reviewMessageBytes > MAX_CHANGE_REVIEW_MESSAGE_BYTES) return;
    setSendingReview(true);
    setReviewError(undefined);
    let failure: string | undefined;
    try {
      failure = await sendReviewNotes(subject.id, targetSessionId, reviewMessage);
    } catch (error) {
      failure = errorMessage(error, "Review notes were not sent.");
    }
    setSendingReview(false);
    if (failure) {
      setReviewError(failure);
      return;
    }
    setReviewNotes(new Map());
    close();
  };

  const moveSelection = (offset: -1 | 1) => {
    if (visibleEntries.length === 0) return;
    const current = visibleEntries.findIndex((entry) => entry.entry_id === selectedId);
    const next = Math.min(Math.max((current < 0 ? 0 : current) + offset, 0), visibleEntries.length - 1);
    const nextId = visibleEntries[next]?.entry_id;
    if (!nextId) return;
    setSelectedId(nextId);
    requestAnimationFrame(() => {
      overlayRef.current
        ?.querySelector<HTMLButtonElement>(`[data-change-entry-id="${CSS.escape(nextId)}"]`)
        ?.focus({ preventScroll: true });
    });
  };
  const toggleFolder = (folderId: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };
  // Marking the open file reviewed moves on to the next file still to review.
  const setEntryReviewed = (entryId: string, reviewed: boolean) => {
    if (reviewed && entryId === selectedId) {
      const next = nextPendingEntry(visibleEntries, entryId, reviewedEntryIds);
      if (next) setSelectedId(next);
    }
    void setReviewed([entryId], reviewed);
  };
  const stepChange = (offset: -1 | 1) => {
    if (navigatorRef.current) {
      navigatorRef.current.step(offset);
      return;
    }
    const scroller = overlayRef.current?.querySelector<HTMLElement>(".changes-diff-scroll");
    if (!scroller) return;
    const rows = [...scroller.querySelectorAll<HTMLElement>("tr.diff-line")];
    const changed = (row: HTMLElement | undefined) => Boolean(row?.querySelector(".diff-code-insert, .diff-code-delete"));
    const tops = rows.filter((row, index) => changed(row) && !changed(rows[index - 1])).map((row) => row.offsetTop);
    const target = targetChangeBlock(tops, scroller.scrollTop + CHANGE_SCROLL_MARGIN, offset);
    if (target !== undefined) scroller.scrollTo({ top: tops[target]! - CHANGE_SCROLL_MARGIN, behavior: "smooth" });
  };
  const allReviewed = currentEntries.length > 0 && reviewedEntryIds.size === currentEntries.length;
  const reviewedShare = currentEntries.length ? reviewedEntryIds.size / currentEntries.length : 0;
  const diffSummary = ({ current, count }: ChangePosition) => <DiffSummary stats={selectedStats} current={current} count={count} />;
  const toggleAllReviewed = () => {
    void setReviewed(currentEntries.map((entry) => entry.entry_id), !allReviewed);
  };

  return (
    <section
      ref={overlayRef}
      className={`changes-overlay${focusMode ? " focus-mode" : ""}${focusMode && windowControlsInset ? " window-inset" : ""}`}
      aria-label={`Changes for ${subject.title}`}
      aria-modal="true"
      aria-keyshortcuts="ArrowUp ArrowDown J K N P R W F ? Escape"
      role="dialog"
      tabIndex={-1}
      onKeyDown={(event) => {
        // Monaco owns Escape (find, suggestions), Tab (indentation) and arrows while it has focus.
        if ((event.key === "Escape" || event.key === "Tab" || event.key === "ArrowUp" || event.key === "ArrowDown") && (event.target as Element).closest?.(".monaco-editor")) return;
        if (event.key === "Escape") {
          event.preventDefault();
          // Escape leaves focus mode before it closes the view.
          if (focusMode) setFocusMode(false);
          else close();
        } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !isTextEntryTarget(event.target)) {
          event.preventDefault();
          moveSelection(event.key === "ArrowUp" ? -1 : 1);
        } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !isTextEntryTarget(event.target) && !(event.target as Element).closest?.(".monaco-editor")) {
          const action = REVIEW_KEYS[event.key];
          if (!action) return;
          event.preventDefault();
          if (action === "nextFile" || action === "previousFile") moveSelection(action === "nextFile" ? 1 : -1);
          else if (action === "nextChange" || action === "previousChange") stepChange(action === "nextChange" ? 1 : -1);
          else if (action === "reviewed" && selectedId && reviewScopeKey && !reviewing) setEntryReviewed(selectedId, !reviewedEntryIds.has(selectedId));
          else if (action === "whitespace") setHideWhitespace((current) => !current);
          else if (action === "shortcuts") setShortcutsOpen((current) => !current);
          else if (action === "focus") setFocusMode((current) => !current);
        } else if (event.key === "Tab") {
          trapDialogFocus(event);
        }
      }}
    >
      <header className="changes-header">
        <div>
          <span className="dialog-eyebrow">{subject.kind === "project" ? "Project Git" : "Task Git"}</span>
          <h1>Changes · {subject.title}</h1>
          <p>{branchScope?.name ?? subject.branchName ?? "No branch"} · {sourceLabel(selectedSource, selectedCommit?.short_oid, selectedCommit?.subject)}</p>
        </div>
        <div className="changes-header-actions">
          <div className="changes-view-toggle" aria-label="Diff layout">
            <button className={viewType === "unified" ? "active" : ""} onClick={() => setViewType("unified")}>Unified</button>
            <button className={viewType === "split" ? "active" : ""} onClick={() => setViewType("split")}>Split</button>
          </div>
          <div className="changes-view-toggle" role="group" aria-label="Diff content">
            <button
              type="button"
              aria-pressed={!fullFile}
              className={fullFile ? "" : "active"}
              onClick={() => setFullFile(false)}
            >Change focus</button>
            <button
              type="button"
              aria-pressed={fullFile}
              className={fullFile ? "active" : ""}
              disabled={!fullFileSupported}
              title={fullFileUnsupportedReason ?? "Show the whole file around this change"}
              onClick={() => setFullFile(true)}
            >Full file</button>
          </div>
          <button
            type="button"
            className={`changes-whitespace-toggle${hideWhitespace ? " active" : ""}`}
            aria-pressed={hideWhitespace}
            title="Hide changes that only add, remove or re-indent whitespace (W)"
            onClick={() => setHideWhitespace((current) => !current)}
          >Hide whitespace</button>
          <button
            type="button"
            className="icon-button quiet changes-shortcuts-button"
            aria-label="Keyboard shortcuts"
            aria-expanded={shortcutsOpen}
            title="Keyboard shortcuts (?)"
            onClick={() => setShortcutsOpen((current) => !current)}
          >?</button>
          <button
            type="button"
            className={`icon-button quiet changes-focus-toggle${focusMode ? " active" : ""}`}
            aria-label="Focus mode"
            aria-pressed={focusMode}
            title={focusMode ? "Exit focus mode (F or Esc)" : "Focus mode: fill the window (F)"}
            onClick={() => setFocusMode((current) => !current)}
          ><Icon name={focusMode ? "unfocus" : "focus"} /></button>
          <button className="secondary-button" disabled={loadingSources} onClick={() => void refresh()}><Icon name="reopen" />Refresh</button>
          <button className="icon-button quiet" aria-label="Close changes" title="Close changes" onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      {shortcutsOpen ? <ReviewShortcuts close={() => setShortcutsOpen(false)} /> : null}
      <div className="changes-context">
        <ChangesBranchPicker
          scopes={branchScopes}
          selected={branchScope}
          select={setBranchScopeKey}
          disabled={loadingSources}
        />
        <ChangesSourcePicker
          scope={branchScope}
          localChanges={localChanges}
          commitList={commitList}
          gitHostProjection={gitHostProjection}
          selected={selectedSource}
          select={setSelectedSource}
        />
        {error ? <div className="changes-error" role="alert">{error}</div> : null}
      </div>
      <div
        ref={bodyRef}
        className={`changes-body${filesResizing ? " resizing" : ""}`}
        style={{ "--changes-files-width": `${filesWidth.width}px` } as CSSProperties}
      >
        <aside className="changes-files" aria-label="Changed files">
          {currentEntries.length > 0 && reviewScopeKey ? <div className="changes-file-review-progress" aria-live="polite">
            <span><strong>{reviewedEntryIds.size}/{currentEntries.length}</strong> reviewed</span>
            <span
              className={`changes-review-meter${allReviewed ? " complete" : ""}`}
              role="progressbar"
              aria-label="Files reviewed"
              aria-valuemin={0}
              aria-valuemax={currentEntries.length}
              aria-valuenow={reviewedEntryIds.size}
            ><span style={{ width: `${Math.round(reviewedShare * 100)}%` }} /></span>
            <button type="button" disabled={reviewing} onClick={toggleAllReviewed}>{reviewing ? "Checking…" : allReviewed ? "Clear reviewed" : "Mark all reviewed"}</button>
          </div> : null}
          {reviewNotice ? <p className="changes-warning" role="status">{reviewNotice}</p> : null}
          {loadingSources || loadingSourceKey === selectedSourceKey ? <p className="changes-placeholder">Loading changes…</p> : null}
          {!loadingSources && selectedSource.kind === "local" && localChanges?.entries.length === 0 ? <p className="changes-placeholder">This worktree is clean.</p> : null}
          {currentCommitChanges?.state === "notShown" ? <p className="changes-placeholder">Merge commit details are not shown in this read-only viewer.</p> : null}
          {currentPullRequestChanges?.state === "unavailable" ? <p className="changes-placeholder">Pull request changes unavailable{currentPullRequestChanges.reason ? ` · ${currentPullRequestChanges.reason}` : ""}.</p> : null}
          {changeTreeSections.map((section) => (
            <ChangeSection
              key={section.id}
              section={section}
              collapsedFolders={collapsedFolders}
              reviewedEntryIds={reviewedEntryIds}
              entryStats={entryStats}
              reviewDisabled={reviewing}
              selectedId={selectedId}
              select={setSelectedId}
              toggleFolder={toggleFolder}
              setReviewed={setEntryReviewed}
            />
          ))}
          {currentListTruncated ? <p className="changes-warning">File list truncated at the safe limit.</p> : null}
        </aside>
        <ChangesFilesResizeHandle width={filesWidth.width} body={bodyRef} resize={filesWidth.resize} reset={filesWidth.reset} draggingChanged={setFilesResizing} />
        <main className="changes-diff" aria-label="Selected file diff">
          {selected ? <div className="changes-file-heading"><ChangeBadge entry={selected} /><strong>{selected.display_path}</strong>{selected.path_encoding === "lossy" ? <span title="The exact path is represented by an opaque identifier.">lossy display</span> : null}
            {selectedStats && !editableDiff ? <span className="changes-file-heading-stats"><DiffSummary stats={selectedStats} current={undefined} count={selectedBlockCount} /></span> : null}
            {editableDiff ? <span className="changes-edit-hint">{editing?.readOnly ? "Read-only on this computer" : "Edit the right side · ⌘S saves"}</span> : null}</div> : null}
          <div className="changes-diff-content">
            {editableDiff && editing && editPath && selected && "side" in selected ? <ChangesDiffEditor
              key={`${selected.side}:${editPath}`}
              editing={editing}
              path={editPath}
              original={editOriginal}
              viewType={viewType}
              fullFile={fullFile}
              hideWhitespace={hideWhitespace}
              navigator={navigatorRef}
              summary={diffSummary}
              notes={currentReviewNotes}
              draft={reviewDraft?.key.startsWith(selectedReviewPrefix ?? "\u0000") ? reviewDraft : undefined}
              openLineReview={openLineReview}
              editLineReview={setReviewDraft}
              updateLineReview={updateReviewNote}
              removeLineReview={removeReviewNote}
              saved={() => void relistAfterSave()}
              expectsChanges={(parsed?.hunks.length ?? 0) > 0}
              diffFailed={(reason) => { if (diffKey) setEditFallback({ key: diffKey, reason }); }}
            /> : <>
            {loadingDiff || awaitingEditableDiff ? <p className="changes-placeholder">Loading diff…</p> : null}
            {!selected && !loadingSources && loadingSourceKey !== selectedSourceKey ? <p className="changes-placeholder">Select a changed file.</p> : null}
            {selectedDiff?.state === "binary" ? <DiffState title="Binary change" detail="Binary content is not sent over the control channel." /> : null}
            {selected?.render_state === "notShown" ? <DiffState title="Content not shown" detail={"side" in selected && selected.kind === "unmerged" ? "Unmerged changes are outside the read-only viewer." : "This content is outside the read-only viewer."} /> : null}
            {selectedDiff?.state === "notShown" ? <DiffState title="Content not shown" detail="This change is outside the read-only viewer." /> : null}
            {selectedDiff?.state === "truncated" ? <DiffState title="Diff too large" detail="The patch exceeded the 256 KiB or 20,000-line safety limit." /> : null}
            {selectedDiff?.state === "nonUtf8" ? <DiffState title="Non-UTF-8 diff" detail="The patch cannot be rendered without corrupting its bytes." /> : null}
            {selectedDiff?.state === "unavailable" ? <DiffState title="Diff unavailable" detail={selectedDiff.reason ? `The provider reported ${selectedDiff.reason}. Refresh and try again.` : "Refresh and try again."} /> : null}
            {selectedDiff?.state === "patch" && !parsed ? <DiffState title="Diff unavailable" detail="The bounded Git patch could not be parsed safely." /> : null}
            {fullFileStatus || editRefusal ? (
              <p className="changes-full-file-status" role="status" aria-live="polite">{fullFileStatus ?? editRefusal}</p>
            ) : null}
            {parsed && renderedHunks && !awaitingEditableDiff ? (
              <RenderedDiff
                file={parsed}
                path={selected?.display_path}
                hunks={renderedHunks}
                hiddenLines={fullFile ? undefined : hiddenLineCount}
                viewType={viewType}
                notes={currentReviewNotes}
                draft={reviewDraft?.key.startsWith(selectedReviewPrefix ?? "\u0000") ? reviewDraft : undefined}
                openLineReview={(change, side) => openLineReview(changeReviewLine(change, side))}
                editLineReview={setReviewDraft}
                updateLineReview={updateReviewNote}
                removeLineReview={removeReviewNote}
              />
            ) : null}
            </>}
          </div>
          <footer className="changes-review">
            <p className="changes-review-hint">Click <strong>+</strong> beside a diff line to add a comment.</p>
            <div className="changes-review-actions">
              <span>{activeReviewNotes.length} {activeReviewNotes.length === 1 ? "note" : "notes"}</span>
              <select
                aria-label="Agent to receive review notes"
                value={targetSessionId ?? ""}
                disabled={agentSessions.length === 0 || sendingReview}
                onChange={(event) => setTargetSessionId(event.currentTarget.value || undefined)}
              >
                <option value="">{agentSessions.length === 0 ? "No active agent" : "Choose agent"}</option>
                {agentSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {sessionLabel(session)}{agentSessions.length > 1 ? ` · ${session.id.slice(0, 6)}` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary-button"
                disabled={!targetSessionId || activeReviewNotes.length === 0 || reviewMessageBytes > MAX_CHANGE_REVIEW_MESSAGE_BYTES || sendingReview}
                onClick={() => void submitReview()}
              >{sendingReview ? "Sending…" : activeReviewNotes.length > 0 ? `Send all ${activeReviewNotes.length} notes` : "Send all notes"}</button>
            </div>
            {activeReviewNotes.length > 0 ? (
              <details className="changes-review-preview">
                <summary>Preview exact message · {reviewMessageBytes.toLocaleString()} bytes</summary>
                <pre>{reviewMessage}</pre>
              </details>
            ) : null}
            {reviewMessageBytes > MAX_CHANGE_REVIEW_MESSAGE_BYTES ? <p className="changes-review-error" role="alert">Review message exceeds the 64 KiB safety limit.</p> : null}
            {reviewError ? <p className="changes-review-error" role="alert">{reviewError}</p> : null}
          </footer>
        </main>
      </div>
    </section>
  );
}


function initialSelection(source: ChangesOpenSource): ChangesSource {
  if (source.kind === "local") return source;
  if (source.kind === "pullRequest") return source;
  return { kind: "local" };
}

function refreshedInitialSelection(
  source: ChangesOpenSource,
  localChanges: LocalChangeListResult | undefined,
  commitList: TaskBranchCommitListResult | undefined,
  gitHostProjection: GitHostProjection | undefined,
): ChangesSource {
  if (source.kind === "pullRequest") {
    const current = gitHostProjection?.matches.find(
      (match) => pullRequestKey(pullRequestIdentity(match)) === pullRequestKey(source.pullRequest),
    );
    return current
      ? {
          kind: "pullRequest",
          pullRequest: pullRequestIdentity(current),
          freshnessGeneration: gitHostProjection?.freshness_generation ?? source.freshnessGeneration,
        }
      : source;
  }
  if (source.kind === "commits" && commitList?.commits.length) {
    return { kind: "commit", commitId: ALL_BRANCH_CHANGES_ID };
  }
  if (localChanges) return { kind: "local" };
  if (commitList?.commits.length) return { kind: "commit", commitId: ALL_BRANCH_CHANGES_ID };
  return { kind: "local" };
}

function sourceLabel(source: ChangesSource, shortOid?: string, subject?: string): string {
  if (source.kind === "local") return "Local changes";
  if (source.kind === "commit") {
    return source.commitId === ALL_BRANCH_CHANGES_ID
      ? "Branch changes"
      : `${shortOid ?? "Commit"} · ${subject ?? ""}`;
  }
  return `${source.pullRequest.provider === "azureDevOps" ? "Azure PR" : "PR"} #${source.pullRequest.number}`;
}

function parsePatch(diff: DiffResult | undefined): FileData | undefined {
  if (diff?.state !== "patch" || !diff.patch) return undefined;
  try {
    return parseDiff(diff.patch)[0];
  } catch {
    return undefined;
  }
}

function withoutKeyPrefix<T>(
  current: ReadonlyMap<string, T>,
  prefix: string,
): ReadonlyMap<string, T> {
  if (![...current.keys()].some((key) => key.startsWith(prefix))) return current;
  return new Map([...current].filter(([key]) => !key.startsWith(prefix)));
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return `${fallback} ${error.message}`;
  return fallback;
}

/// Room left above a change block scrolled to, so its first line is not
/// flush against the top edge.
const CHANGE_SCROLL_MARGIN = 40;

const compactTree = (entries: readonly ChangeEntry[]) => buildChangeTree(entries, { compact: true });
