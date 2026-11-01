import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  GitHostPullRequestSummaryDto,
  TaskBranchCommitListResult,
} from "@termloop/contract/current";
import type { GitHostProjection } from "../model.js";
import type { LocalChangeListResult } from "../changes-local-recovery.js";
import {
  ALL_BRANCH_CHANGES_ID,
  pullRequestIdentity,
  pullRequestKey,
  sameSource,
  type ChangesSource,
} from "../change-source.js";
import { scopeHasCommits, type ChangesBranchScope } from "../changes-branch-scope.js";
import { Icon } from "./Icon.js";

export function ChangesBranchPicker({ scopes, selected, select, disabled }: {
  scopes: readonly ChangesBranchScope[];
  selected: ChangesBranchScope | undefined;
  select(key: string): void;
  disabled: boolean;
}) {
  if (!selected) return null;
  if (scopes.length < 2) {
    return (
      <div className="changes-branch-scope">
        <span className="changes-branch-scope-label">Branch</span>
        <span className="changes-branch-current static"><BranchName scope={selected} /></span>
      </div>
    );
  }
  return (
    <div className="changes-branch-scope">
      <span className="changes-branch-scope-label">Branch</span>
      <Menu
        label={`Branch ${selected.name}`}
        className="changes-branch-current"
        disabled={disabled}
        trigger={<><BranchName scope={selected} /><span className="changes-branch-more">{scopes.length - 1} more</span></>}
      >
        {(close) => scopes.map((scope) => (
          <button
            key={scope.key}
            type="button"
            role="menuitemradio"
            aria-checked={scope.key === selected.key}
            className={`changes-branch-option${scope.key === selected.key ? " selected" : ""}`}
            onClick={() => { close(); select(scope.key); }}
          >
            <BranchName scope={scope} />
            {scope.pullRequests.length ? (
              <span className="changes-branch-option-prs">
                {scope.pullRequests.map((pullRequest) => (
                  <PullRequestChip key={pullRequestKey(pullRequestIdentity(pullRequest))} pullRequest={pullRequest} />
                ))}
              </span>
            ) : null}
            {!scopeHasCommits(scope) ? <small>No local branch · changes come from its pull requests</small> : null}
          </button>
        ))}
      </Menu>
    </div>
  );
}

function BranchName({ scope }: { scope: ChangesBranchScope }) {
  const tag = scope.checkedOut ? "worktree"
    : scope.role === "heldByOtherTask" ? "other Task"
      : !scopeHasCommits(scope) ? "PR only" : undefined;
  return (
    <span className="changes-branch-name">
      <Icon name="branch" />
      <strong>{scope.name}</strong>
      {tag ? <span className={`changes-branch-tag ${scope.checkedOut ? "worktree" : ""}`}>{tag}</span> : null}
    </span>
  );
}

function PullRequestChip({ pullRequest }: { pullRequest: GitHostPullRequestSummaryDto }) {
  return (
    <span className={`changes-pr-chip ${pullRequest.state}`} title={pullRequest.title}>
      #{pullRequest.number} → {pullRequest.base_branch} · {pullRequest.state}
    </span>
  );
}

export function ChangesSourcePicker({ scope, localChanges, commitList, gitHostProjection, selected, select }: {
  scope: ChangesBranchScope | undefined;
  localChanges: LocalChangeListResult | undefined;
  commitList: TaskBranchCommitListResult | undefined;
  gitHostProjection: GitHostProjection | undefined;
  selected: ChangesSource;
  select(source: ChangesSource): void;
}) {
  const showLocal = localChanges !== undefined && (!scope || scope.checkedOut);
  const commits = !scope || scopeHasCommits(scope) ? commitList?.commits ?? [] : [];
  const pullRequests = scope ? scope.pullRequests : gitHostProjection?.matches ?? [];
  if (!showLocal && !commits.length && !pullRequests.length) return null;
  const selectedCommitIndex = selected.kind === "commit" && selected.commitId !== ALL_BRANCH_CHANGES_ID
    ? commits.findIndex((commit) => commit.commit_id === selected.commitId)
    : -1;
  const selectedCommit = selectedCommitIndex >= 0 ? commits[selectedCommitIndex] : undefined;
  return (
    <nav className="changes-sources" aria-label="Change source">
      {showLocal ? (
        <button type="button" className={selected.kind === "local" ? "selected" : ""} onClick={() => select({ kind: "local" })}>
          <strong>Local changes</strong>
          <small>{localChanges.entries.length} {localChanges.entries.length === 1 ? "file" : "files"}</small>
        </button>
      ) : null}
      {commits.length && commitList ? (
        <button
          type="button"
          className={selected.kind === "commit" && selected.commitId === ALL_BRANCH_CHANGES_ID ? "selected" : ""}
          onClick={() => select({ kind: "commit", commitId: ALL_BRANCH_CHANGES_ID })}
        >
          <strong>All branch changes</strong>
          <small>
            {commits.length}{commitList.truncated ? "+" : ""} {commits.length === 1 && !commitList.truncated ? "commit" : "commits"}
            {commitList.base_ref
              ? ` · base ${commitList.base_ref}`
              : commitList.base_oid
                ? ` · base ${commitList.base_oid.slice(0, 12)}`
                : ""}
          </small>
        </button>
      ) : null}
      {commits.length ? (
        <Menu
          label="Select a commit"
          className={`changes-commit-menu-trigger${selectedCommit ? " selected" : ""}`}
          trigger={selectedCommit ? (
            <>
              <strong>Commit {selectedCommitIndex + 1} of {commits.length}</strong>
              <small>{selectedCommit.short_oid} · {selectedCommit.subject || "No subject"}</small>
            </>
          ) : (
            <>
              <strong>Commits</strong>
              <small>{commits.length}{commitList?.truncated ? "+" : ""} · choose one</small>
            </>
          )}
        >
          {(close) => <>
            {commits.map((commit, index) => (
              <button
                key={commit.commit_id}
                type="button"
                role="menuitemradio"
                aria-checked={commit.commit_id === selectedCommit?.commit_id}
                className={`changes-commit-option${commit.commit_id === selectedCommit?.commit_id ? " selected" : ""}`}
                onClick={() => { close(); select({ kind: "commit", commitId: commit.commit_id }); }}
              >
                <span>{index + 1}</span>
                <code>{commit.short_oid}</code>
                <span>{commit.subject || "No subject"}</span>
              </button>
            ))}
            {commitList?.truncated ? <p className="changes-warning">Newest 50 commits shown</p> : null}
          </>}
        </Menu>
      ) : null}
      {gitHostProjection ? pullRequests.map((pullRequest) => {
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
            <strong>
              {pullRequest.provider === "azureDevOps" ? "Azure PR" : "PR"} #{pullRequest.number}
              <span className={`changes-pr-state ${pullRequest.state}`}>{pullRequest.state}</span>
            </strong>
            <small>→ {pullRequest.base_branch} · {pullRequest.title}</small>
          </button>
        );
      }) : null}
    </nav>
  );
}

/**
 * A disclosure menu kept inside the dialog: Escape closes the menu without
 * reaching the overlay's own Escape handler, and an outside press dismisses it.
 */
function Menu({ label, className, trigger, disabled, children }: {
  label: string;
  className: string;
  trigger: ReactNode;
  disabled?: boolean;
  children(close: () => void): ReactNode;
}) {
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const open = position !== undefined;
  const setOpen = (next: boolean) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setPosition(next && rect ? { top: rect.bottom + 4, left: rect.left } : undefined);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // The popover is fixed to where the trigger was; a resize would strand it.
    const closeOnResize = () => setPosition(undefined);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return (
    <div
      ref={rootRef}
      className="changes-menu"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger}
        <Icon name="chevronDown" className="changes-menu-caret" aria-hidden="true" />
      </button>
      {position ? <div className="changes-menu-popover" role="menu" aria-label={label} style={{ top: position.top, left: position.left }}>{children(close)}</div> : null}
    </div>
  );
}
