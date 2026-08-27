import type { TaskWorktreeProvisioningFailureKind } from "@termloop/contract/current";
import {
  basename,
  taskCheckedOutBranch,
  taskHasWorktreeChanges,
  taskJiraIssueKey,
  taskWorktreeInlineAction,
  type BranchCommitSummary,
  type GitHostProjection,
  type Task,
} from "./model.js";
import { strongerTone, type RowTone } from "./row-tone.js";
import type { AgentAttention } from "./session-presentation.js";

/// Which tones a Task surface can actually produce. The narrowed aliases are what
/// keep `app.css` honest: a tone with no rule cannot reach an element whose type
/// excludes it, so every rule that exists is reachable. The vocabulary itself is
/// shared with Session rows — see `row-tone.ts`.
export type TaskStageTone = Extract<RowTone, "quiet" | "busy" | "blocked">;
export type TaskSignalTone = Extract<RowTone, "quiet" | "attention" | "review" | "done">;

/// Structural position of a Task: what exists, not what an agent is doing.
/// Keeping agent liveness out of the stage prevents a Task's structural state
/// from changing when an attached agent's status changes.
export type TaskStageId =
  | "deleting"
  | "closed"
  | "planning"
  | "branchOnly"
  | "provisioning"
  | "provisioningFailed"
  | "repair"
  | "observing"
  | "unavailable"
  | "ready";

/// Tone, flag, and headline are fixed per stage, so they live keyed by the stage
/// id rather than being retyped at each return site. Only the note varies with
/// Task data. `flag: undefined` means the stage is the unremarkable norm and
/// would only cost the title width by labelling itself.
const stagePresentation: Record<TaskStageId, {
  tone: TaskStageTone;
  flag: string | undefined;
  headline: string;
}> = {
  deleting: { tone: "busy", flag: "Deleting", headline: "Deleting this Task and its worktree." },
  closed: { tone: "quiet", flag: undefined, headline: "Closed. Its current state is kept." },
  planning: { tone: "quiet", flag: undefined, headline: "No branch yet. Bind one or create a worktree to start." },
  branchOnly: { tone: "quiet", flag: undefined, headline: "A branch is bound. Create a worktree to run agents here." },
  provisioning: { tone: "busy", flag: "Creating", headline: "Creating the worktree." },
  provisioningFailed: { tone: "blocked", flag: "Failed", headline: "Worktree creation failed." },
  repair: { tone: "blocked", flag: "Needs repair", headline: "The worktree link is stale or moved." },
  observing: { tone: "busy", flag: "Checking", headline: "Checking this worktree before launch." },
  unavailable: { tone: "blocked", flag: "Unavailable", headline: "Agents cannot start here." },
  ready: { tone: "quiet", flag: undefined, headline: "Ready to run agents." },
};

export type TaskStage = {
  id: TaskStageId;
  tone: TaskStageTone;
  flag: string | undefined;
  /// One plain sentence: the stage headline plus its note when it has one. Used
  /// for the accessible name and the row tooltip.
  summary: string;
  /// Rendered inline for stages a user cannot act on without an explanation.
  note: string | undefined;
};

function stageOf(id: TaskStageId, note?: string): TaskStage {
  const { tone, flag, headline } = stagePresentation[id];
  return { id, tone, flag, summary: note ? `${headline} ${note}` : headline, note };
}

const provisioningFailureNotes: Record<TaskWorktreeProvisioningFailureKind, string> = {
  gitUnavailable: "Git is not available on this machine.",
  unsupportedGit: "The installed Git is too old to create worktrees.",
  permissionDenied: "TermLoop cannot write to the destination folder.",
  repositoryUnavailable: "The repository could not be opened.",
  branchConflict: "Another checkout already has this branch.",
  pathConflict: "The destination is already in use — or its parent folder does not exist yet.",
  worktreeLocked: "Git reports this worktree as locked.",
  timeout: "Worktree creation timed out.",
  outputLimit: "Git produced more output than TermLoop reads.",
  recoveryAttention: "An interrupted attempt needs an exact retry.",
  operationFailed: "Git refused to create the worktree.",
};

/// Exported so a future surface renders the same sentence rather than the raw
/// enum. The map is total over the generated union, so a new contract member
/// fails the desktop type check instead of reaching a user as an identifier.
///
/// The lookup is still guarded: a daemon running ahead of this client can put a
/// kind on the wire that this build has never heard of, and a missing sentence
/// would leave a blocked Task with a bare `FAILED` and no explanation. An
/// unrecognized kind degrades to the generic refusal rather than to nothing.
export function provisioningFailureNote(kind: TaskWorktreeProvisioningFailureKind | undefined): string {
  return (kind ? provisioningFailureNotes[kind] as string | undefined : undefined)
    ?? provisioningFailureNotes.operationFailed;
}

export function provisioningFailureKinds(): TaskWorktreeProvisioningFailureKind[] {
  return Object.keys(provisioningFailureNotes) as TaskWorktreeProvisioningFailureKind[];
}

/// Why a present worktree cannot host a launch. Only reached when health exists
/// and is neither launch-ready nor a repairable path/registration fault. These
/// are five independent enums rather than one union, so exhaustiveness is not
/// expressible; the final sentence is an honest fallback, not a silent hole.
///
/// An interrupted folder deletion is checked before health because health can
/// only describe what the checkout looks like now. A half-removed folder is
/// indistinguishable from an ordinary unhealthy one, and reporting it as
/// unproven hides both the cause and the one action that finishes it.
function unavailableNote(task: Task): string {
  const disposal = task.worktree_stale_resolution;
  if (disposal?.mode === "discardDirectory"
    && disposal.status === "failed"
    && disposal.failure?.kind === "recoveryAttention") {
    return "A folder deletion was interrupted, so this checkout is partly removed. Delete the Task again to finish it.";
  }
  const health = task.worktree_health;
  if (!health) return "TermLoop has not observed this worktree yet.";
  if (health.head_state === "mismatch") return "The checkout HEAD does not match its registration.";
  if (health.head_state === "missing") return "The checkout has no resolvable HEAD.";
  if (health.path_state === "replaced") return "Another filesystem entry now sits at this path.";
  if (health.index_lock_state === "present") return "Git is holding the index lock in this checkout.";
  if (health.worktree_lock_state === "present") return "This worktree is locked.";
  return "TermLoop cannot prove this checkout is safe to launch in.";
}

export function taskStage(task: Task, deleting: boolean, provisioningInFlight = false): TaskStage {
  if (deleting) return stageOf("deleting");
  if (provisioningInFlight) return stageOf("provisioning");
  if (task.status === "closed") return stageOf("closed");
  const provisioning = task.worktree_provisioning;
  if (provisioning?.status === "running") return stageOf("provisioning");
  if (provisioning?.status === "failed") {
    return stageOf("provisioningFailed", provisioningFailureNote(provisioning.failure?.kind));
  }
  if (!task.worktree) return stageOf(task.branch ? "branchOnly" : "planning");
  const action = taskWorktreeInlineAction(task);
  if (action === "repair") return stageOf("repair", "Its registered folder no longer matches this Task.");
  if (action === "unavailable" && !task.worktree_health) {
    const disposal = task.worktree_stale_resolution;
    if (disposal?.mode !== "discardDirectory"
      || disposal.status !== "failed"
      || disposal.failure?.kind !== "recoveryAttention") {
      return stageOf("observing");
    }
  }
  if (action === "unavailable") return stageOf("unavailable", unavailableNote(task));
  return stageOf("ready");
}

/// The spine colour for a whole Task row: its structural stage, or the agents
/// running inside it, whichever is louder. The spine is an expanded-state
/// detail; collapsed Tasks intentionally show only their title.
export function taskRowTone(stage: TaskStage, attention: AgentAttention | undefined): RowTone {
  return attention ? strongerTone(stage.tone, attention.tone) : stage.tone;
}

/// At most one structural next step per Task, so a row can carry exactly one
/// accent. A healthy Task offers none: its launchers are already the affordance,
/// and nagging a settled row would spend the colour budget that blocked rows
/// need.
///
/// `optional` steps move a Task forward but are never owed — a Task legitimately
/// lives without a worktree, so offering one must not look like an unmet
/// obligation. `recovery` steps are the only ones a Task is actually stuck
/// without, and they get the filled accent.
export type TaskNextStepKind = "createWorktree" | "retryWorktree" | "repairWorktree";

export type TaskNextStep = {
  kind: TaskNextStepKind;
  label: string;
  emphasis: "optional" | "recovery";
};

const nextStepPresentation: Record<TaskNextStepKind, Omit<TaskNextStep, "kind">> = {
  createWorktree: { label: "Create worktree", emphasis: "optional" },
  retryWorktree: { label: "Retry worktree", emphasis: "recovery" },
  repairWorktree: { label: "Repair worktree", emphasis: "recovery" },
};

const stageNextStep: Partial<Record<TaskStageId, TaskNextStepKind>> = {
  planning: "createWorktree",
  branchOnly: "createWorktree",
  provisioningFailed: "retryWorktree",
  repair: "repairWorktree",
};

export function taskNextStep(stage: TaskStage): TaskNextStep | undefined {
  const kind = stageNextStep[stage.id];
  return kind ? { kind, ...nextStepPresentation[kind] } : undefined;
}

/// The row's single action button. A row spends at most one accent on "do this
/// now", ranked by how stuck the user actually is: a recovery step means the
/// Task cannot proceed at all; an agent waiting on input or review means a
/// person is the blocker; an optional step merely moves the Task forward. A
/// working agent is progress, not a request, so it never earns the button — its
/// dot already says so. A deleting Task offers nothing.
export type TaskAction =
  | { kind: "nextStep"; nextStep: TaskNextStep }
  | { kind: "agent"; attention: AgentAttention };

export function taskPrimaryAction(
  stage: TaskStage,
  attention: AgentAttention | undefined,
): TaskAction | undefined {
  if (stage.id === "deleting") return undefined;
  const nextStep = taskNextStep(stage);
  if (nextStep?.emphasis === "recovery") return { kind: "nextStep", nextStep };
  if (attention && attention.tone !== "working") return { kind: "agent", attention };
  return nextStep ? { kind: "nextStep", nextStep } : undefined;
}

/// A checkout sitting on a different local branch than the Task's own branch is
/// launchable but easy to mistake for the Task branch, so it reads as a warning
/// rather than as another neutral identity token.
export type TaskDivergence = { branch: string; text: string; title: string };

export function taskDivergence(task: Task): TaskDivergence | undefined {
  const branch = taskCheckedOutBranch(task);
  if (!branch) return undefined;
  return {
    branch,
    text: `on ${branch}`,
    title: `This checkout currently has ${branch} checked out, not the Task branch ${task.branch?.name ?? "(unbound)"}.`,
  };
}

export function taskChangeCount(task: Task): number | undefined {
  if (!taskHasWorktreeChanges(task)) return undefined;
  const count = task.worktree_health?.change_count ?? 0;
  return count > 0 ? count : undefined;
}

export function taskChangeLabel(count: number): string {
  return `${count} ${count === 1 ? "change" : "changes"}`;
}

export function taskChangedFileLabel(count: number): string {
  return `${count} changed ${count === 1 ? "file" : "files"}`;
}

export type TaskIntegration = {
  tone: TaskSignalTone;
  label: string;
  title: string;
  action: "commits" | "pullRequest" | undefined;
  /// The exact pull request a `pullRequest` action opens. Resolved here, beside
  /// the label that describes it, so the two can never point at different PRs.
  pullRequest: GitHostProjection["matches"][number] | undefined;
};

type IntegrationVerdict = Omit<TaskIntegration, "pullRequest">;

/// Unchanged policy from the shipped rail: a local base comparison outranks a
/// provider claim, and provider-merged plus unmerged local commits is an
/// attention state rather than a success. Only the labels are shortened, and the
/// leading check glyph is dropped because tone already carries "settled".
function integrationVerdict(
  projection: GitHostProjection | undefined,
  branchCommitSummary: BranchCommitSummary | undefined,
): IntegrationVerdict | undefined {
  const completeProjection = projection?.freshness === "fresh"
    && !projection.truncated
    && !projection.candidate_truncated;
  const merged = completeProjection
    ? projection.matches.filter((pullRequest) => pullRequest.state === "merged")
    : [];
  const everyMatchMerged = merged.length > 0 && merged.length === projection!.matches.length;
  const notInBase = branchCommitSummary?.not_in_base;

  if (completeProjection && projection.matches.length > 0 && !everyMatchMerged) {
    if (projection.matches.length > 1) {
      return {
        tone: "quiet",
        label: `${projection.matches.length} PRs`,
        title: `${projection.matches.length} matching pull requests are shown separately by head and base branch.`,
        action: undefined,
      };
    }
    return pullRequestVerdict(projection.matches[0]!);
  }

  if (notInBase?.freshness === "fresh" && notInBase.count !== null) {
    if (notInBase.count > 0) {
      const providerDetail = everyMatchMerged
        ? " The provider reports the pull request as merged, but these branch commits are not reachable from the local base."
        : "";
      return {
        tone: "attention",
        label: `${notInBase.count} unmerged`,
        title: `${notInBase.count} ${notInBase.count === 1 ? "commit is" : "commits are"} reachable from the Task branch but absent from the local base ${notInBase.base_ref ?? "ref"}.${providerDetail}`,
        action: "commits",
      };
    }
    if (everyMatchMerged) return mergedVerdict(merged.length, true);
    return {
      tone: "done",
      label: "In base",
      title: `No commits reachable from the Task branch are absent from the local base ${notInBase.base_ref ?? "ref"}.`,
      action: branchCommitSummary?.count ? "commits" : undefined,
    };
  }

  if (everyMatchMerged) return mergedVerdict(merged.length, false);
  if (!projection) {
    return branchCommitSummary ? {
      tone: "quiet",
      label: "Merge unknown",
      title: `The local base comparison is unavailable${notInBase?.reason ? `: ${notInBase.reason}` : ""}.`,
      action: undefined,
    } : undefined;
  }

  /// Every remaining "unknown" case has the same label and differs only in why
  /// the projection could not settle it, plus whether mixed states make it an
  /// attention rather than a merely-quiet unknown.
  const unsettled = projection.freshness !== "fresh" || projection.truncated || projection.candidate_truncated
    ? `The pull request projection is incomplete${projection.reason ? `: ${projection.reason}` : ""}, and the local base comparison is unavailable.`
    : projection.matches.length === 0
      ? "No matching pull request was found and the local base comparison is unavailable."
      : projection.matches.length > 1
        ? "Matching pull requests have mixed states and the local base comparison is unavailable."
        : undefined;
  if (unsettled !== undefined) {
    return {
      tone: projection.matches.length > 1 ? "attention" : "quiet",
      label: "Merge unknown",
      title: unsettled,
      action: undefined,
    };
  }

  return pullRequestVerdict(projection.matches[0]!);
}

function pullRequestVerdict(pullRequest: GitHostProjection["matches"][number]): IntegrationVerdict {
  if (pullRequest.state === "closed") {
    return { tone: "attention", label: "Not merged", title: "The provider reports the pull request as closed, not merged.", action: "pullRequest" };
  }
  if (pullRequest.state === "draft") {
    return { tone: "quiet", label: "Draft", title: "The pull request is still a draft.", action: "pullRequest" };
  }
  if (pullRequest.checks === "failing") {
    return { tone: "attention", label: "Checks failing", title: "The pull request is open and at least one reported check is failing.", action: "pullRequest" };
  }
  if (pullRequest.review === "changesRequested") {
    return { tone: "attention", label: "Changes requested", title: "The pull request is open and changes have been requested.", action: "pullRequest" };
  }
  if (pullRequest.mergeability === "conflicting") {
    return { tone: "attention", label: "Conflicts", title: "The pull request is open and the provider reports merge conflicts.", action: "pullRequest" };
  }
  if (pullRequest.checks === "passing" && pullRequest.review === "approved" && pullRequest.mergeability === "mergeable") {
    return { tone: "review", label: "Ready to merge", title: "Reported checks pass, review is approved, and the pull request is mergeable.", action: "pullRequest" };
  }
  if (pullRequest.checks === "pending") {
    return { tone: "quiet", label: "Checks pending", title: "The pull request is open and reported checks are still pending.", action: "pullRequest" };
  }
  return { tone: "quiet", label: "Open", title: "The pull request is open and has not been reported as merged.", action: "pullRequest" };
}

function mergedVerdict(mergedCount: number, inBase: boolean): IntegrationVerdict {
  const subject = mergedCount === 1 ? "the matching pull request" : "every matching pull request";
  return {
    tone: "done",
    label: "Merged",
    title: `The provider reports ${subject} as merged${inBase ? ", and no Task branch commits are absent from the local base" : ""}.`,
    action: "pullRequest",
  };
}

export function taskIntegration(
  projection: GitHostProjection | undefined,
  branchCommitSummary: BranchCommitSummary | undefined,
): TaskIntegration | undefined {
  const verdict = integrationVerdict(projection, branchCommitSummary);
  if (!verdict) return undefined;
  /// Appended once here rather than hand-interpolated into every verdict title,
  /// so a new verdict cannot forget it.
  const taskHistory = branchCommitSummary?.freshness === "fresh" && branchCommitSummary.count !== null
    ? ` Task history: ${branchCommitSummary.count} ${branchCommitSummary.count === 1 ? "commit" : "commits"}.`
    : "";
  return {
    ...verdict,
    title: `${verdict.title}${taskHistory}`,
    pullRequest: verdict.action === "pullRequest"
      ? projection?.matches.find((match) => match.state === "merged") ?? projection?.matches[0]
      : undefined,
  };
}

/// Local uncommitted work makes a provider "merged" claim misleading, so the
/// settled tone is downgraded rather than the fact being hidden. This is the one
/// home for that rule — the accessible name derives its wording from it too.
export function integrationTone(integration: TaskIntegration, hasLocalChanges: boolean): TaskSignalTone {
  return hasLocalChanges && integration.tone === "done" ? "attention" : integration.tone;
}

/// One sentence describing the whole row, in the same order the visual design
/// ranks it, so a screen reader is told what the Task wants before it is told
/// which branch it lives on. Every phrase is something the row actually shows —
/// no internal provisioning vocabulary, and nothing stated twice. A closed Task
/// therefore drops its derived counts and merge state the way its meta line
/// does, and a title that already carries the Jira key does not repeat it.
export function taskRowAccessibleName(options: {
  task: Task;
  stage: TaskStage;
  attention: AgentAttention | undefined;
  divergence: TaskDivergence | undefined;
  changeCount: number | undefined;
  integration: TaskIntegration | undefined;
  commitCount: number | null | undefined;
}): string {
  const { task, stage, attention, divergence, changeCount, integration, commitCount } = options;
  const quiet = task.status === "closed";
  const parts = [task.title, task.status, stage.summary];
  if (attention) parts.push(`${attention.label}, ${attention.agent}`);
  if (changeCount && !quiet) parts.push(taskChangedFileLabel(changeCount));
  if (integration && !quiet) {
    const downgraded = integrationTone(integration, Boolean(changeCount)) !== integration.tone;
    parts.push(downgraded ? `${integration.label}, local changes remain` : integration.label);
  }
  if (commitCount && !quiet) parts.push(`${commitCount} ${commitCount === 1 ? "Task commit" : "Task commits"}`);
  parts.push(task.branch ? `branch ${task.branch.name}` : "no branch");
  if (divergence && !quiet) parts.push(`checked out branch ${divergence.branch}`);
  parts.push(task.worktree ? "worktree attached" : "no worktree");
  if (task.worktree) parts.push(`worktree folder ${basename(task.worktree.path)}`);
  /// Only an operation that actually happened is worth naming. The retired
  /// "worktree provisioning idle" phrase said nothing on every healthy Task.
  if (task.worktree_provisioning) parts.push(`worktree provisioning ${task.worktree_provisioning.status}`);
  if (task.jira_url) {
    const key = taskJiraIssueKey(task.jira_url);
    if (!task.title.includes(key)) parts.push(`Jira ${key}`);
  }
  return parts.join(", ");
}
