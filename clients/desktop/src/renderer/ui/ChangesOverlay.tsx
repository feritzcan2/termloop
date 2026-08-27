import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Decoration, Diff, Hunk, parseDiff, type ChangeData, type FileData, type HunkData } from "react-diff-view";
import "react-diff-view/style/index.css";
import type {
  TaskBranchCommitChangeListResult,
  TaskBranchCommitDiffResult,
  TaskBranchCommitListResult,
  TaskWorktreeChangeListResult,
  TaskWorktreeDiffResult,
  TaskWorktreePreImageResult,
  ProjectWorktreeChangeListResult,
  ProjectWorktreeDiffResult,
  ProjectWorktreePreImageResult,
  GitHostPullRequestChangeListResult,
  GitHostPullRequestDiffResult,
  GitHostPullRequestIdentityDto,
} from "@termloop/contract/current";
import { sessionLabel, type GitHostProjection, type Session } from "../model.js";
import {
  buildChangeTree,
  changeTreeFolderId,
  visibleChangeTreeEntries,
} from "../change-tree.js";
import { Icon } from "./Icon.js";
import {
  ChangeBadge,
  ChangeSection,
  type ChangeEntry,
  type ChangeTreeSection,
} from "./ChangeFileTree.js";
import {
  ALL_BRANCH_CHANGES_ID,
  cacheDiff,
  cacheLruEntry,
  cachePreImage,
  currentPullRequestSource,
  pullRequestIdentity,
  pullRequestKey,
  sameSource,
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
  MAX_CHANGE_REVIEW_NOTE_CHARS,
  buildChangeReviewMessage,
  changeReviewLine,
  reviewMessageByteLength,
  type ChangeReviewNote,
} from "../changes-review.js";
import {
  fullFileStatusMessage,
  fullFileView,
  gapBefore,
  preImageRefusal,
  type FullFileView,
} from "../changes-full-file.js";

type LocalChangeListResult = TaskWorktreeChangeListResult | ProjectWorktreeChangeListResult;
type LocalDiffResult = TaskWorktreeDiffResult | ProjectWorktreeDiffResult;
type LocalPreImageResult = TaskWorktreePreImageResult | ProjectWorktreePreImageResult;
type DiffResult = LocalDiffResult | TaskBranchCommitDiffResult | GitHostPullRequestDiffResult;
type ChangeReviewDraft = Omit<ChangeReviewNote, "body">;

export type ChangesSubject = {
  id: string;
  title: string;
  branchName?: string | undefined;
  kind: "task" | "project";
  hasWorktree: boolean;
  hasBranch: boolean;
};

export type ChangesOverlayProps = {
  subject: ChangesSubject;
  initialSource: ChangesOpenSource;
  close(): void;
  list(subjectId: string): Promise<LocalChangeListResult>;
  diff(subjectId: string, observationId: string, entryId: string): Promise<LocalDiffResult>;
  preImage(subjectId: string, observationId: string, entryId: string): Promise<LocalPreImageResult>;
  listCommits(taskId: string): Promise<TaskBranchCommitListResult>;
  listCommitChanges(taskId: string, observationId: string, commitId: string): Promise<TaskBranchCommitChangeListResult>;
  commitDiff(taskId: string, observationId: string, commitId: string, entryId: string): Promise<TaskBranchCommitDiffResult>;
  gitHostProjection: GitHostProjection | undefined;
  listPullRequestChanges(taskId: string, expectedFreshnessGeneration: number, pullRequest: GitHostPullRequestIdentityDto): Promise<GitHostPullRequestChangeListResult>;
  pullRequestDiff(taskId: string, observationId: string, entryId: string): Promise<GitHostPullRequestDiffResult>;
  agentSessions: readonly Session[];
  sendReviewNotes(taskId: string, sessionId: string, message: string): Promise<string | undefined>;
};

export function ChangesOverlay({
  subject,
  initialSource,
  close,
  list,
  diff,
  preImage,
  listCommits,
  listCommitChanges,
  commitDiff,
  gitHostProjection,
  listPullRequestChanges,
  pullRequestDiff,
  agentSessions,
  sendReviewNotes,
}: ChangesOverlayProps) {
  const overlayRef = useRef<HTMLElement>(null);
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
  const [preImages, setPreImages] = useState<ReadonlyMap<string, CachedPreImage>>(new Map());
  const [loadingPreImage, setLoadingPreImage] = useState(false);
  const [preImageError, setPreImageError] = useState<string>();
  const [reviewNotes, setReviewNotes] = useState<ReadonlyMap<string, ChangeReviewNote>>(new Map());
  const [reviewedEntryKeys, setReviewedEntryKeys] = useState<ReadonlySet<string>>(new Set());
  const [reviewDraft, setReviewDraft] = useState<ChangeReviewDraft>();
  const [targetSessionId, setTargetSessionId] = useState<string>();
  const [sendingReview, setSendingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const hasWorktree = subject.hasWorktree;
  const hasBranch = subject.hasBranch;
  const clearPullRequestArtifacts = useCallback(() => {
    setPullRequestChanges((current) => withoutKeyPrefix(current, "pullRequest:"));
    setDiffs((current) => withoutKeyPrefix(current, "pullRequest:"));
    setReviewedEntryKeys((current) => new Set([...current].filter((key) => !key.startsWith("pullRequest:"))));
    setReviewNotes((current) => withoutKeyPrefix(current, "pullRequest:"));
    setReviewDraft((current) => current?.key.startsWith("pullRequest:") ? undefined : current);
  }, []);

  const refresh = useCallback(async () => {
    setLoadingSources(true);
    setError(undefined);
    setDiffs(new Map());
    setPreImages(new Map());
    setPreImageError(undefined);
    setCommitChanges(new Map());
    setPullRequestChanges(new Map());
    setReviewedEntryKeys(new Set());
    const [localResult, commitResult] = await Promise.allSettled([
      hasWorktree ? list(subject.id) : Promise.resolve(undefined),
      hasBranch ? listCommits(subject.id) : Promise.resolve(undefined),
    ]);
    const nextLocal = localResult.status === "fulfilled" ? localResult.value : undefined;
    const nextCommits = commitResult.status === "fulfilled" ? commitResult.value : undefined;
    setLocalChanges(nextLocal);
    setCommitList(nextCommits);
    const preferred = refreshedInitialSelection(initialSource, nextLocal, nextCommits, gitHostProjectionRef.current);
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
  }, [hasBranch, hasWorktree, initialSource, list, listCommits, subject.id]);

  useEffect(() => { void refresh(); }, [refresh]);

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
  }, [commitChanges, commitList, listCommitChanges, selectedSource, subject.id]);

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
  }, [listPullRequestChanges, pullRequestChanges, selectedPullRequestIsCurrent, selectedSource, selectedSourceKey, subject.id]);

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
  const reviewScopeKey = currentObservationId ? `${selectedSourceKey}\u0000${currentObservationId}` : undefined;
  const reviewedEntryIds = useMemo(() => new Set(currentEntries
    .filter((entry) => reviewScopeKey && reviewedEntryKeys.has(reviewedEntryKey(reviewScopeKey, entry.entry_id)))
    .map((entry) => entry.entry_id)), [currentEntries, reviewScopeKey, reviewedEntryKeys]);
  const changeTreeSections = useMemo<readonly ChangeTreeSection[]>(() => {
    const pending = currentEntries.filter((entry) => !reviewedEntryIds.has(entry.entry_id));
    const reviewed = currentEntries.filter((entry) => reviewedEntryIds.has(entry.entry_id));
    if (selectedSource.kind !== "local") {
      return [
        { id: "files", title: "Files to review", nodes: buildChangeTree(pending), entryCount: pending.length },
        { id: "reviewed", title: "Reviewed", nodes: buildChangeTree(reviewed), entryCount: reviewed.length },
      ];
    }
    const staged = pending.filter((entry) => "side" in entry && entry.side === "staged");
    const unstaged = pending.filter((entry) => "side" in entry && entry.side === "unstaged");
    const untracked = pending.filter((entry) => "side" in entry && entry.side === "untracked");
    return [
      { id: "staged", title: "Staged", nodes: buildChangeTree(staged), entryCount: staged.length },
      { id: "unstaged", title: "Working tree", nodes: buildChangeTree(unstaged), entryCount: unstaged.length },
      { id: "untracked", title: "Untracked", nodes: buildChangeTree(untracked), entryCount: untracked.length },
      { id: "reviewed", title: "Reviewed", nodes: buildChangeTree(reviewed), entryCount: reviewed.length },
    ];
  }, [currentEntries, reviewedEntryIds, selectedSource.kind]);
  const visibleEntries = useMemo(
    () => changeTreeSections.flatMap((section) => collapsedFolders.has(changeTreeFolderId(section.id, ""))
      ? []
      : visibleChangeTreeEntries(section.nodes, collapsedFolders, section.id)),
    [changeTreeSections, collapsedFolders],
  );

  useEffect(() => {
    setSelectedId((current) => visibleEntries.some((entry) => entry.entry_id === current)
      ? current
      : visibleEntries[0]?.entry_id);
  }, [selectedSourceKey, visibleEntries]);

  useEffect(() => { setCollapsedFolders(new Set([changeTreeFolderId("reviewed", "")])); }, [selectedSourceKey]);

  const selected = currentEntries.find((entry) => entry.entry_id === selectedId);
  const diffKey = selectedId ? `${selectedSourceKey}:${selectedId}` : undefined;
  useEffect(() => {
    if (!selected || !diffKey || selected.render_state === "notShown" || diffs.has(diffKey)) {
      setLoadingDiff(false);
      return;
    }
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
      .then((result) => {
        if (!active) return;
        setDiffs((current) => cacheDiff(current, diffKey, result));
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure, "The diff became stale. Refresh and try again."));
      })
      .finally(() => { if (active) setLoadingDiff(false); });
    return () => { active = false; };
  }, [commitDiff, commitList?.observation_id, currentPullRequestChanges?.observation_id, diff, diffKey, diffs, localChanges?.observation_id, pullRequestDiff, selected, selectedSource, subject.id]);

  const selectedDiff = diffKey
    && (selectedSource.kind !== "pullRequest" || selectedPullRequestIsCurrent)
    ? diffs.get(diffKey)
    : undefined;
  useEffect(() => {
    if (!diffKey || !selectedDiff) return;
    setDiffs((current) => touchLruEntry(current, diffKey));
  }, [diffKey, selectedDiff]);
  const parsed = useMemo(() => parsePatch(selectedDiff), [selectedDiff]);
  // Full-file mode needs the old-side blob, which only the worktree source can
  // supply today. Other sources keep the change-focused view and say why, from
  // this one string so the control and the status line cannot drift.
  const fullFileUnsupportedReason = selectedSource.kind === "local"
    ? undefined
    : "The whole file is only available for local worktree changes.";
  const fullFileSupported = fullFileUnsupportedReason === undefined;
  const selectedPreImage = fullFileSupported && diffKey ? preImages.get(diffKey) : undefined;

  useEffect(() => {
    if (!fullFile || !fullFileSupported || !diffKey || !parsed) return;
    if (preImages.has(diffKey)) return;
    const observationId = localChanges?.observation_id;
    const entryId = selected?.entry_id;
    if (!observationId || !entryId) return;
    let active = true;
    setLoadingPreImage(true);
    setPreImageError(undefined);
    void preImage(subject.id, observationId, entryId)
      .then((result) => {
        if (!active) return;
        setPreImages((current) => cachePreImage(current, diffKey, result));
      })
      .catch((failure) => {
        if (active) setPreImageError(errorMessage(failure, "The full file could not be read."));
      })
      .finally(() => { if (active) setLoadingPreImage(false); });
    return () => { active = false; };
  }, [diffKey, fullFile, fullFileSupported, localChanges?.observation_id, parsed, preImage, preImages, selected?.entry_id, subject.id]);

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

  const renderedHunks = fullFileState?.state === "fullFile" || fullFileState?.state === "alreadyComplete"
    ? fullFileState.hunks
    : parsed?.hunks;
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
  const selectedReviewPrefix = selected ? `${selectedSourceKey}:${selected.entry_id}:` : undefined;
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

  const openLineReview = (change: ChangeData, side: "old" | "new") => {
    if (!selected || !selectedReviewPrefix) return;
    const line = changeReviewLine(change, side);
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
            ? "All changes"
            : `Commit ${selectedCommit?.short_oid ?? selectedSource.commitId.slice(0, 8)}`
          : `${selectedSource.pullRequest.provider === "azureDevOps" ? "Azure PR" : "PR"} #${selectedSource.pullRequest.number}`,
      displayPath: selected.display_path,
      pathEncoding: selected.path_encoding,
      ...line,
    });
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
  const setEntryReviewed = (entryId: string, reviewed: boolean) => {
    if (!reviewScopeKey) return;
    setReviewedEntryKeys((current) => {
      const next = new Set(current);
      const key = reviewedEntryKey(reviewScopeKey, entryId);
      if (reviewed) next.add(key);
      else next.delete(key);
      return next;
    });
    if (reviewed && selectedId === entryId) {
      setSelectedId(currentEntries.find((entry) => entry.entry_id !== entryId && !reviewedEntryIds.has(entry.entry_id))?.entry_id);
    }
  };
  const allReviewed = currentEntries.length > 0 && reviewedEntryIds.size === currentEntries.length;
  const toggleAllReviewed = () => {
    if (!reviewScopeKey) return;
    setReviewedEntryKeys((current) => {
      const next = new Set(current);
      for (const entry of currentEntries) {
        const key = reviewedEntryKey(reviewScopeKey, entry.entry_id);
        if (allReviewed) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  };

  return (
    <section
      ref={overlayRef}
      className="changes-overlay"
      aria-label={`Changes for ${subject.title}`}
      aria-modal="true"
      aria-keyshortcuts="ArrowUp ArrowDown Escape"
      role="dialog"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !isTextEntryTarget(event.target)) {
          event.preventDefault();
          moveSelection(event.key === "ArrowUp" ? -1 : 1);
        } else if (event.key === "Tab") {
          trapDialogFocus(event);
        }
      }}
    >
      <header className="changes-header">
        <div>
          <span className="dialog-eyebrow">{subject.kind === "project" ? "Project Git" : "Task Git"}</span>
          <h1>Changes · {subject.title}</h1>
          <p>{subject.branchName ?? "No branch"} · {sourceLabel(selectedSource, selectedCommit?.short_oid, selectedCommit?.subject)}</p>
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
          <button className="secondary-button" disabled={loadingSources} onClick={() => void refresh()}><Icon name="reopen" />Refresh</button>
          <button className="icon-button quiet" aria-label="Close changes" title="Close changes" onClick={close}><Icon name="close" /></button>
        </div>
      </header>
      <div className="changes-context">
        <SourcePicker
          localChanges={localChanges}
          commitList={commitList}
          gitHostProjection={gitHostProjection}
          selected={selectedSource}
          select={setSelectedSource}
        />
        {error ? <div className="changes-error" role="alert">{error}</div> : null}
      </div>
      <div className="changes-body">
        <aside className="changes-files" aria-label="Changed files">
          {currentEntries.length > 0 && reviewScopeKey ? <div className="changes-file-review-progress" aria-live="polite">
            <span><strong>{reviewedEntryIds.size}/{currentEntries.length}</strong> reviewed</span>
            <button type="button" onClick={toggleAllReviewed}>{allReviewed ? "Clear reviewed" : "Mark all reviewed"}</button>
          </div> : null}
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
              selectedId={selectedId}
              select={setSelectedId}
              toggleFolder={toggleFolder}
              setReviewed={setEntryReviewed}
            />
          ))}
          {currentListTruncated ? <p className="changes-warning">File list truncated at the safe limit.</p> : null}
        </aside>
        <main className="changes-diff" aria-label="Selected file diff">
          {selected ? <div className="changes-file-heading"><ChangeBadge entry={selected} /><strong>{selected.display_path}</strong>{selected.path_encoding === "lossy" ? <span title="The exact path is represented by an opaque identifier.">lossy display</span> : null}</div> : null}
          <div className="changes-diff-content">
            {loadingDiff ? <p className="changes-placeholder">Loading diff…</p> : null}
            {!selected && !loadingSources && loadingSourceKey !== selectedSourceKey ? <p className="changes-placeholder">Select a changed file.</p> : null}
            {selectedDiff?.state === "binary" ? <DiffState title="Binary change" detail="Binary content is not sent over the control channel." /> : null}
            {selected?.render_state === "notShown" ? <DiffState title="Content not shown" detail={"side" in selected && selected.kind === "unmerged" ? "Unmerged changes are outside the read-only viewer." : "This content is outside the read-only viewer."} /> : null}
            {selectedDiff?.state === "notShown" ? <DiffState title="Content not shown" detail="This change is outside the read-only viewer." /> : null}
            {selectedDiff?.state === "truncated" ? <DiffState title="Diff too large" detail="The patch exceeded the 256 KiB or 20,000-line safety limit." /> : null}
            {selectedDiff?.state === "nonUtf8" ? <DiffState title="Non-UTF-8 diff" detail="The patch cannot be rendered without corrupting its bytes." /> : null}
            {selectedDiff?.state === "unavailable" ? <DiffState title="Diff unavailable" detail={selectedDiff.reason ? `The provider reported ${selectedDiff.reason}. Refresh and try again.` : "Refresh and try again."} /> : null}
            {selectedDiff?.state === "patch" && !parsed ? <DiffState title="Diff unavailable" detail="The bounded Git patch could not be parsed safely." /> : null}
            {fullFileStatus ? (
              <p className="changes-full-file-status" role="status" aria-live="polite">{fullFileStatus}</p>
            ) : null}
            {parsed && renderedHunks ? (
              <RenderedDiff
                file={parsed}
                hunks={renderedHunks}
                hiddenLines={fullFile ? undefined : hiddenLineCount}
                viewType={viewType}
                notes={currentReviewNotes}
                draft={reviewDraft?.key.startsWith(selectedReviewPrefix ?? "\u0000") ? reviewDraft : undefined}
                openLineReview={openLineReview}
                editLineReview={setReviewDraft}
                updateLineReview={updateReviewNote}
                removeLineReview={removeReviewNote}
              />
            ) : null}
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

function SourcePicker({ localChanges, commitList, gitHostProjection, selected, select }: {
  localChanges: LocalChangeListResult | undefined;
  commitList: TaskBranchCommitListResult | undefined;
  gitHostProjection: GitHostProjection | undefined;
  selected: ChangesSource;
  select(source: ChangesSource): void;
}) {
  if (!localChanges && !commitList?.commits.length && !gitHostProjection?.matches.length) return null;
  return (
    <nav className="changes-sources" aria-label="Change source">
      {localChanges ? (
        <button type="button" className={selected.kind === "local" ? "selected" : ""} onClick={() => select({ kind: "local" })}>
          <strong>Local changes</strong>
          <small>{localChanges.entries.length} {localChanges.entries.length === 1 ? "file" : "files"}</small>
        </button>
      ) : null}
      {commitList?.commits.length ? (
        <button
          type="button"
          className={selected.kind === "commit" && selected.commitId === ALL_BRANCH_CHANGES_ID ? "selected" : ""}
          onClick={() => select({ kind: "commit", commitId: ALL_BRANCH_CHANGES_ID })}
        >
          <strong>Branch changes</strong>
          <small>{commitList.commits.length}{commitList.truncated ? "+" : ""} {commitList.commits.length === 1 && !commitList.truncated ? "commit" : "commits"}</small>
        </button>
      ) : null}
      {commitList?.commits.map((commit, index) => (
        <button key={commit.commit_id} type="button" className={selected.kind === "commit" && selected.commitId === commit.commit_id ? "selected" : ""} onClick={() => select({ kind: "commit", commitId: commit.commit_id })}>
          <strong>Commit {index + 1}</strong>
          <small>{commit.short_oid} · {commit.subject || "No subject"}</small>
        </button>
      ))}
      {commitList?.truncated ? <span className="changes-warning">Newest 50 commits shown</span> : null}
      {gitHostProjection?.matches.map((pullRequest) => {
        const source: ChangesSource = {
          kind: "pullRequest",
          pullRequest: pullRequestIdentity(pullRequest),
          freshnessGeneration: gitHostProjection.freshness_generation,
        };
        return (
          <button
            key={pullRequestKey(source.pullRequest)}
            type="button"
            className={sameSource(selected, source) ? "selected" : ""}
            onClick={() => select(source)}
          >
            <strong>{pullRequest.provider === "azureDevOps" ? "Azure PR" : "PR"} #{pullRequest.number}</strong>
            <small>{pullRequest.title}</small>
          </button>
        );
      })}
    </nav>
  );
}

function RenderedDiff({
  file,
  hunks,
  hiddenLines,
  viewType,
  notes,
  draft,
  openLineReview,
  editLineReview,
  updateLineReview,
  removeLineReview,
}: {
  file: FileData;
  hunks: HunkData[];
  hiddenLines: number | undefined;
  viewType: "unified" | "split";
  notes: readonly ChangeReviewNote[];
  draft: ChangeReviewDraft | undefined;
  openLineReview(change: ChangeData, side: "old" | "new"): void;
  editLineReview(draft: ChangeReviewDraft | undefined): void;
  updateLineReview(draft: ChangeReviewDraft, body: string): void;
  removeLineReview(key: string): void;
}) {
  const notesByChange = new Map(notes.map((note) => [note.changeKey, note]));
  const reviewTargets = new Map(
    notes.map((note) => [note.changeKey, changeReviewDraft(note)] as const),
  );
  if (draft) reviewTargets.set(draft.changeKey, draft);
  const widgets: Record<string, ReactNode> = {};
  for (const target of reviewTargets.values()) {
    const note = notesByChange.get(target.changeKey);
    widgets[target.changeKey] = (
      <LineReviewWidget
        key={target.key}
        draft={target}
        body={note?.body ?? ""}
        editing={draft?.key === target.key}
        edit={() => editLineReview(target)}
        change={(body) => updateLineReview(target, body)}
        close={() => editLineReview(undefined)}
        remove={() => removeLineReview(target.key)}
      />
    );
  }
  return (
    <div className="changes-diff-scroll">
      <Diff
        viewType={viewType}
        diffType={file.type}
        hunks={hunks}
        widgets={widgets}
        selectedChanges={[...reviewTargets.keys()]}
        renderGutter={({ change, side, renderDefault }) => {
          const commentable = change.type === "normal"
            || (change.type === "insert" && side === "new")
            || (change.type === "delete" && side === "old");
          if (!commentable) return renderDefault();
          return (
            <button
              type="button"
              className="changes-line-comment-trigger"
              aria-label={`Comment on ${side} line ${changeReviewLine(change, side).lineNumber}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openLineReview(change, side);
              }}
            ><span>{renderDefault()}</span><b aria-hidden="true">+</b></button>
          );
        }}
      >
        {(rendered) => rendered.flatMap((hunk, index) => {
          const gap = gapBefore(rendered, index, hunk);
          const body = <Hunk key={hunk.content} hunk={hunk} />;
          if (gap <= 0) return [body];
          return [
            <Decoration key={`gap-${hunk.content}`}>
              <span className="changes-diff-gap">{gap} hidden {gap === 1 ? "line" : "lines"}</span>
            </Decoration>,
            body,
          ];
        })}
      </Diff>
      {hiddenLines !== undefined && hiddenLines > 0 ? (
        <p className="changes-diff-gap-total">
          {hiddenLines} {hiddenLines === 1 ? "line" : "lines"} of this file are not in the patch.
        </p>
      ) : null}
    </div>
  );
}

function LineReviewWidget({ draft, body, editing, edit, change, close, remove }: {
  draft: ChangeReviewDraft;
  body: string;
  editing: boolean;
  edit(): void;
  change(body: string): void;
  close(): void;
  remove(): void;
}) {
  if (!editing) {
    return (
      <button type="button" className="changes-line-comment-summary" onClick={edit}>
        <strong>{draft.lineSide} line {draft.lineNumber}</strong><span>{body}</span>
      </button>
    );
  }
  return (
    <div className="changes-line-comment-editor">
      <label><span>{draft.lineSide} line {draft.lineNumber}</span>
        <textarea
          autoFocus
          value={body}
          maxLength={MAX_CHANGE_REVIEW_NOTE_CHARS}
          placeholder="Write a comment for this line…"
          onChange={(event) => change(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        />
      </label>
      <div>
        {body ? <button type="button" className="quiet-button" onClick={remove}>Delete</button> : null}
        <button type="button" className="secondary-button" onClick={close}>Done</button>
      </div>
    </div>
  );
}

function changeReviewDraft(note: ChangeReviewNote): ChangeReviewDraft {
  const { body: _body, ...draft } = note;
  return draft;
}

function DiffState({ title, detail }: { title: string; detail: string }) {
  return <div className="changes-diff-state"><Icon name="focus" /><h2>{title}</h2><p>{detail}</p></div>;
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute("hidden"));
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) {
    event.preventDefault();
    first.focus();
  }
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
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

function reviewedEntryKey(scopeKey: string, entryId: string): string {
  return `${scopeKey}\u0000${entryId}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return `${fallback} ${error.message}`;
  return fallback;
}
