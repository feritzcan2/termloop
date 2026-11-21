import type {
  TaskBranchCommitChangeListResult,
  TaskBranchCommitDiffResult,
  TaskBranchCommitListResult,
  TaskBranchCommitPreImageResult,
} from "@termloop/contract/current";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WorktreeChangesPort } from "@/application/ports";

/// The daemon's id for the whole branch range against its base.
export const ALL_BRANCH_CHANGES_ID = "all";

export type BranchChanges = {
  commits: TaskBranchCommitListResult | undefined;
  commitsLoading: boolean;
  commitsError: string | undefined;
  selectedCommitId: string;
  selectCommit(commitId: string): void;
  changes: TaskBranchCommitChangeListResult | undefined;
  changesLoading: boolean;
  changesError: string | undefined;
  selectedEntryId: string | undefined;
  selectEntry(entryId: string | undefined): void;
  diff: TaskBranchCommitDiffResult | undefined;
  diffLoading: boolean;
  diffError: string | undefined;
  fullFile: boolean;
  setFullFile(value: boolean): void;
  preImage: TaskBranchCommitPreImageResult | undefined;
  preImageLoading: boolean;
  preImageError: string | undefined;
  reload(): Promise<void>;
};

/// Committed history of one Task branch, read as one observation. Every file
/// list, patch, and old-side read is addressed by that observation, so a later
/// commit on the Mac never silently changes what the reviewer is looking at;
/// a refresh starts a new observation instead. File lists load only while
/// `active`, because the phone usually opens Changes for uncommitted work.
export function useBranchChanges(
  port: WorktreeChangesPort,
  connectionId: string,
  taskId: string,
  active: boolean,
): BranchChanges {
  const sequence = useRef(0);
  const [commits, setCommits] = useState<TaskBranchCommitListResult | undefined>();
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsError, setCommitsError] = useState<string | undefined>();
  const [selectedCommitId, setSelectedCommitId] = useState(ALL_BRANCH_CHANGES_ID);
  const [changes, setChanges] = useState<TaskBranchCommitChangeListResult | undefined>();
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string | undefined>();
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [diff, setDiff] = useState<TaskBranchCommitDiffResult | undefined>();
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | undefined>();
  const [fullFile, setFullFile] = useState(false);
  const [preImage, setPreImage] = useState<TaskBranchCommitPreImageResult | undefined>();
  const [preImageLoading, setPreImageLoading] = useState(false);
  const [preImageError, setPreImageError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setCommitsLoading(true);
    setCommitsError(undefined);
    try {
      const next = await port.listBranchCommits(connectionId, taskId);
      if (current !== sequence.current) return;
      setCommits(next);
      setSelectedCommitId(ALL_BRANCH_CHANGES_ID);
      setSelectedEntryId(undefined);
    } catch (cause) {
      if (current !== sequence.current) return;
      setCommitsError(messageOf(cause, "This branch's commits could not be read."));
    } finally {
      if (current === sequence.current) setCommitsLoading(false);
    }
  }, [connectionId, port, taskId]);

  useEffect(() => {
    void reload();
    return () => { sequence.current += 1; };
  }, [reload]);

  const observationId = commits?.observation_id;
  const hasCommits = (commits?.commits.length ?? 0) > 0;
  useEffect(() => {
    setChanges(undefined);
    setChangesError(undefined);
    setSelectedEntryId(undefined);
    if (!active || observationId === undefined || !hasCommits) {
      setChangesLoading(false);
      return;
    }
    let current = true;
    setChangesLoading(true);
    port.listCommitChanges(connectionId, taskId, observationId, selectedCommitId).then((next) => {
      if (!current) return;
      setChanges(next);
      setChangesLoading(false);
    }).catch((cause) => {
      if (!current) return;
      setChangesError(messageOf(cause, "This commit's files could not be read."));
      setChangesLoading(false);
    });
    return () => { current = false; };
  }, [active, connectionId, hasCommits, observationId, port, selectedCommitId, taskId]);

  const selectedEntry = changes?.entries.find((entry) => entry.entry_id === selectedEntryId);
  useEffect(() => {
    setDiff(undefined);
    setDiffError(undefined);
    setFullFile(false);
    if (changes === undefined || selectedEntry === undefined) {
      setDiffLoading(false);
      return;
    }
    if (selectedEntry.render_state !== "available") {
      setDiff({
        task_id: taskId,
        observation_id: changes.observation_id,
        commit_id: changes.commit_id,
        entry_id: selectedEntry.entry_id,
        state: "notShown",
        patch: null,
      });
      setDiffLoading(false);
      return;
    }
    let current = true;
    setDiffLoading(true);
    port.diffCommit(connectionId, taskId, changes.observation_id, changes.commit_id, selectedEntry.entry_id).then((next) => {
      if (!current) return;
      setDiff(next);
      setDiffLoading(false);
    }).catch((cause) => {
      if (!current) return;
      setDiffError(messageOf(cause, "This patch could not be read."));
      setDiffLoading(false);
    });
    return () => { current = false; };
  }, [changes, connectionId, port, selectedEntry, taskId]);

  useEffect(() => {
    setPreImage(undefined);
    setPreImageError(undefined);
    if (!fullFile || changes === undefined || selectedEntry === undefined) {
      setPreImageLoading(false);
      return;
    }
    let current = true;
    setPreImageLoading(true);
    port.preImageCommit(connectionId, taskId, changes.observation_id, changes.commit_id, selectedEntry.entry_id).then((next) => {
      if (!current) return;
      setPreImage(next);
      setPreImageLoading(false);
    }).catch((cause) => {
      if (!current) return;
      setPreImageError(messageOf(cause, "The full file could not be read."));
      setPreImageLoading(false);
    });
    return () => { current = false; };
  }, [changes, connectionId, fullFile, port, selectedEntry, taskId]);

  const matches = <T extends { entry_id: string; commit_id: string; observation_id: string }>(value: T | undefined) => (
    value !== undefined && value.entry_id === selectedEntryId
    && value.commit_id === changes?.commit_id && value.observation_id === changes?.observation_id ? value : undefined
  );

  return {
    commits,
    commitsLoading,
    commitsError,
    selectedCommitId,
    selectCommit: setSelectedCommitId,
    changes: changes?.commit_id === selectedCommitId ? changes : undefined,
    changesLoading,
    changesError,
    selectedEntryId,
    selectEntry: setSelectedEntryId,
    diff: matches(diff),
    diffLoading,
    diffError,
    fullFile,
    setFullFile,
    preImage: matches(preImage),
    preImageLoading,
    preImageError,
    reload,
  };
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}
