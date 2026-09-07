import type {
  ErrorCode,
  PlaybookDto,
  PlaybookGetResult,
  PlaybookMilestoneDto,
  PlaybookMilestoneDraftDto,
  PlaybookPipelineDraftDto,
  PlaybookUpdateParams,
  PlaybookUpdateResult,
} from "@termloop/contract/current";

/* The Playbook is the user's one advisory delivery-policy document per
   Project. Since the sidebar rail became the one place the pipeline is seen
   and minimally adjusted, this module holds the React-free policy: editor
   shapes, validation, templates, and the exact atomic Save translation. The
   heavy editing itself belongs to the Playbook Builder agent, not to a form. */

/** Structural mirror of the desktop bridge's typed-call result; ui/ cannot
    import transport, so the shape is declared here and satisfied by it. */
export type PlaybookUpdateOutcome =
  | { ok: true; result: PlaybookUpdateResult }
  | { ok: false; code: ErrorCode | undefined; message: string };

export const PLAYBOOK_MILESTONES_MAX = 24;
export const PLAYBOOK_ENTRY_ID_MAX_BYTES = 64;
export const PLAYBOOK_TITLE_MAX_BYTES = 120;
export const PLAYBOOK_CHECK_INSTRUCTIONS_MAX_BYTES = 9216;
export const PLAYBOOK_APPROVER_MAX_BYTES = 120;
export const PLAYBOOK_PIPELINE_NAME_MAX_BYTES = 120;
export const PLAYBOOK_SAVED_PIPELINES_MAX = 16;
export const PLAYBOOK_RETRY_DELAY_MIN_SECONDS = 60;
export const PLAYBOOK_RETRY_DELAY_MAX_SECONDS = 86400;
export const PLAYBOOK_DEFAULT_RETRY_DELAY_SECONDS = 600;

/** The recheck delays offered in place; any other stored value is kept and
    shown alongside them. */
export const PLAYBOOK_RETRY_CHOICES_SECONDS = [300, 600, 1800, 3600, 14_400, 86_400];

export function playbookRetryChoiceLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}

/** The recheck values a step's inline select offers: the standard choices,
    plus the stored value when it is not one of them — an existing policy is
    shown, never silently rounded to the nearest offer. */
export function playbookRetryChoices(retryDelaySeconds: number): number[] {
  return PLAYBOOK_RETRY_CHOICES_SECONDS.includes(retryDelaySeconds)
    ? PLAYBOOK_RETRY_CHOICES_SECONDS
    : [...PLAYBOOK_RETRY_CHOICES_SECONDS, retryDelaySeconds].sort((left, right) => left - right);
}

export function playbookRelativeMinutes(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** A station on the board before it is complete: every step names the Routine
    that checks it, and `null` is the honest "not picked yet" the wire type
    cannot express. */
export type PlaybookMilestoneDraft = Omit<PlaybookMilestoneDto, "routineId"> & {
  routineId: string | null;
};

export type PlaybookPipelineEditorDraft = {
  name: string;
  milestones: PlaybookMilestoneDraft[];
};

export type PlaybookDraft = {
  /** Which of the Project's pipelines the board is showing. */
  activePipelineName: string;
  milestones: PlaybookMilestoneDraft[];
  /** The Project's other pipelines, kept whole. Switching parks the active one
      here rather than discarding it, so every path stays reachable. */
  savedPipelines: PlaybookPipelineEditorDraft[];
};

const ENTRY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Mirrors Rust `char::is_control`: C0 controls, DEL, and C1 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function requiredTextIssues(value: string, maxBytes: number, field: string): string[] {
  const issues: string[] = [];
  if (!value.trim()) issues.push(`${field} is required.`);
  if (utf8ByteLength(value) > maxBytes) issues.push(`${field} is too long (max ${maxBytes} bytes).`);
  if (CONTROL_CHARACTERS.test(value)) issues.push(`${field} must be a single line without control characters.`);
  return issues;
}

function multilineInstructionIssues(value: string, field: string, required: boolean): string[] {
  const issues: string[] = [];
  if (required && !value.trim()) issues.push(`${field} is required.`);
  if (utf8ByteLength(value) > PLAYBOOK_CHECK_INSTRUCTIONS_MAX_BYTES) {
    issues.push(`${field} is too long (max ${PLAYBOOK_CHECK_INSTRUCTIONS_MAX_BYTES} bytes).`);
  }
  if (!required && value !== "" && !value.trim()) issues.push(`${field} cannot be only whitespace.`);
  if (CONTROL_CHARACTERS_EXCEPT_NEWLINE.test(value)) {
    issues.push(`${field} allows line breaks but no other control characters.`);
  }
  return issues;
}

function entryIdIssues(id: string): string[] {
  return ENTRY_ID_PATTERN.test(id) ? [] : ["ID must be 1–64 letters, digits, - or _."];
}

export type PlaybookMilestoneFieldIssues = Readonly<{
  id: readonly string[];
  title: readonly string[];
  completeWhen: readonly string[];
  retry: readonly string[];
  gate: readonly string[];
  approver: readonly string[];
  instructions: readonly string[];
}>;

export function playbookMilestoneFieldIssues(
  milestone: PlaybookMilestoneDraft,
): PlaybookMilestoneFieldIssues {
  const retry: string[] = [];
  // A step with no Routine is not a mistake: saving provisions one for it.
  if (milestone.retryDelaySeconds < PLAYBOOK_RETRY_DELAY_MIN_SECONDS
    || milestone.retryDelaySeconds > PLAYBOOK_RETRY_DELAY_MAX_SECONDS) {
    retry.push("Check again between 1 minute and 24 hours.");
  }
  const gate: string[] = [];
  let approver: string[] = [];
  const instructions = multilineInstructionIssues(
    milestone.whileWaiting.instructions,
    "While-waiting instructions",
    milestone.whileWaiting.mode !== "off",
  );
  if (milestone.gate === "human") {
    if (milestone.approver === null) approver = ["A human gate names its approver."];
    else approver = requiredTextIssues(milestone.approver, PLAYBOOK_APPROVER_MAX_BYTES, "Approver");
  } else if (milestone.approver !== null) {
    gate.push("An automatic milestone cannot have an approver.");
  }
  return {
    id: entryIdIssues(milestone.id),
    title: requiredTextIssues(milestone.title, PLAYBOOK_TITLE_MAX_BYTES, "Title"),
    completeWhen: multilineInstructionIssues(milestone.completeWhen, "Completion rule", true),
    retry,
    gate,
    approver,
    instructions,
  };
}

export function playbookMilestoneIssues(milestone: PlaybookMilestoneDraft): string[] {
  const issues = playbookMilestoneFieldIssues(milestone);
  return [
    ...issues.id,
    ...issues.title,
    ...issues.completeWhen,
    ...issues.retry,
    ...issues.gate,
    ...issues.approver,
    ...issues.instructions,
  ];
}

export function playbookDraftIssues(draft: PlaybookDraft): string[] {
  const issues: string[] = [];
  const pipelines = [
    { name: draft.activePipelineName, milestones: draft.milestones },
    ...draft.savedPipelines,
  ];
  if (draft.savedPipelines.length > PLAYBOOK_SAVED_PIPELINES_MAX) {
    issues.push(`Keep at most ${PLAYBOOK_SAVED_PIPELINES_MAX} other pipelines.`);
  }
  const names = pipelines.map((pipeline) => pipeline.name);
  if (new Set(names).size !== names.length) issues.push("Every pipeline needs a unique name.");
  for (const pipeline of pipelines) {
    issues.push(...requiredTextIssues(
      pipeline.name,
      PLAYBOOK_PIPELINE_NAME_MAX_BYTES,
      "Pipeline name",
    ));
    if (pipeline.milestones.length > PLAYBOOK_MILESTONES_MAX) {
      issues.push(`At most ${PLAYBOOK_MILESTONES_MAX} milestones in ${pipeline.name || "a pipeline"}.`);
    }
    if (new Set(pipeline.milestones.map((milestone) => milestone.id)).size !== pipeline.milestones.length) {
      issues.push("Milestone IDs must be unique.");
    }
  }
  return issues;
}

export function playbookDraftIsValid(draft: PlaybookDraft): boolean {
  return playbookDraftIssues(draft).length === 0
    && playbookAllMilestones(draft)
      .every((milestone) => playbookMilestoneIssues(milestone).length === 0);
}

/** Copies the saved flat document into independently editable local state. */
export function playbookDraftFromDto(playbook: PlaybookDto | null): PlaybookDraft {
  const milestoneDraft = (milestone: PlaybookMilestoneDto): PlaybookMilestoneDraft => ({ ...milestone });
  return {
    activePipelineName: playbook?.activePipelineName ?? "",
    milestones: playbook?.milestones.map(milestoneDraft) ?? [],
    savedPipelines: playbook?.savedPipelines.map((pipeline) => ({
      ...pipeline,
      milestones: pipeline.milestones.map(milestoneDraft),
    })) ?? [],
  };
}

/** Every stage the Project holds, in whichever pipeline. The rail shows one
    pipeline at a time; the Routines behind all of them stay alive. */
export function playbookAllMilestones(draft: PlaybookDraft): PlaybookMilestoneDraft[] {
  return [
    ...draft.milestones,
    ...draft.savedPipelines.flatMap((pipeline) => pipeline.milestones),
  ];
}

/** Parks the active pipeline and brings a kept one out. Nothing is lost:
    the two simply change places, and a pipeline with no stages is not worth
    keeping a slot for. */
export function switchToSavedPipeline(draft: PlaybookDraft, name: string): PlaybookDraft | undefined {
  const target = draft.savedPipelines.find((pipeline) => pipeline.name === name);
  if (!target) return undefined;
  return {
    ...draft,
    activePipelineName: target.name,
    milestones: target.milestones.map((milestone) => ({ ...milestone })),
    savedPipelines: [
      ...draft.savedPipelines.filter((pipeline) => pipeline.name !== name),
      ...parkedPipeline(draft),
    ],
  };
}

/** Whether the board is already running this template.

    A pipeline is either the one in use or one of the kept ones, so a board
    running this template has nowhere to be parked; switching to what is already
    on screen is not an operation. The name alone does not settle it. A board
    left empty — every stage removed — still
    carries the name it was given, and that is precisely the board a user
    rebuilds by adopting the template again. */
export function boardAlreadyRuns(draft: PlaybookDraft, template: PlaybookTemplate): boolean {
  return draft.activePipelineName === template.name && draft.milestones.length > 0;
}

/** Puts a template on the board, parking whatever was there. A pipeline the
    Project already keeps under that name is switched to instead — adopting it
    twice would only mint a second set of Routines for the same stages. */
export function adoptTemplateInto(
  draft: PlaybookDraft,
  template: PlaybookTemplate,
): PlaybookDraft | undefined {
  if (boardAlreadyRuns(draft, template)) return undefined;
  const switched = switchToSavedPipeline(draft, template.name);
  if (switched) return switched;
  const filled = playbookTemplateDraft(template);
  return {
    ...draft,
    activePipelineName: template.name,
    milestones: filled.milestones,
    savedPipelines: [
      ...draft.savedPipelines.filter((pipeline) => pipeline.name !== template.name),
      ...parkedPipeline(draft),
    ],
  };
}

function parkedPipeline(draft: PlaybookDraft): PlaybookPipelineEditorDraft[] {
  if (draft.milestones.length === 0 || draft.activePipelineName.trim() === "") return [];
  return [{ name: draft.activePipelineName, milestones: draft.milestones.map((milestone) => ({ ...milestone })) }];
}

/** Moves the station at `from` to insertion slot `to`; slots `from` and
    `from + 1` are the station's own edges, so both are no-ops. */
export function moveMilestoneToSlot(draft: PlaybookDraft, from: number, to: number): PlaybookDraft {
  if (from < 0 || from >= draft.milestones.length || to === from || to === from + 1) return draft;
  const milestones = [...draft.milestones];
  const [station] = milestones.splice(from, 1);
  if (!station) return draft;
  milestones.splice(Math.max(0, Math.min(to > from ? to - 1 : to, milestones.length)), 0, station);
  return { ...draft, milestones };
}

export function removeMilestoneAt(draft: PlaybookDraft, index: number): PlaybookDraft {
  return { ...draft, milestones: draft.milestones.filter((_, at) => at !== index) };
}

export function changeMilestoneRetryAt(
  draft: PlaybookDraft,
  index: number,
  retryDelaySeconds: number,
): PlaybookDraft {
  return {
    ...draft,
    milestones: draft.milestones.map((milestone, at) =>
      at === index ? { ...milestone, retryDelaySeconds } : milestone),
  };
}

/** The delivery path behind the one template a Project can start from. A
    Project with no saved Playbook is offered this rather than given it:
    adopting a template installs one completion Routine per stage and writes
    the document atomically. Merely seeing the offer writes nothing. */
function templateMilestone(
  id: string,
  title: string,
  completeWhen: string,
  retryDelaySeconds = PLAYBOOK_DEFAULT_RETRY_DELAY_SECONDS,
  approver: string | null = null,
  whileWaiting: PlaybookMilestoneDto["whileWaiting"] = { mode: "off", instructions: "" },
): PlaybookMilestoneDraft {
  return {
    id,
    title,
    gate: approver === null ? "automatic" : "human",
    routineId: null,
    retryDelaySeconds,
    completeWhen,
    whileWaiting,
    approver,
  };
}

export const PLAYBOOK_STARTER: PlaybookDraft = {
  activePipelineName: "Ship to production",
  savedPipelines: [],
  milestones: [
    templateMilestone("agent-working", "Agent is working", "An agent is running in the Task's worktree."),
    templateMilestone("pr-opened", "Pull request opened", "A pull request exists for the Task branch."),
    templateMilestone("ci-green", "Required CI checks passed", "Required checks pass on the Task branch head."),
    templateMilestone(
      "review-approved",
      "Review approved",
      "The pull request carries an approving review from the named person.",
      1800,
      "you",
    ),
    templateMilestone("deployed", "Deployed to production", "The deployed commit matches the Task branch head.", 3600),
  ],
};

export function playbookStarterDraft(): PlaybookDraft {
  return {
    activePipelineName: PLAYBOOK_STARTER.activePipelineName,
    milestones: PLAYBOOK_STARTER.milestones.map((milestone) => ({ ...milestone })),
    savedPipelines: [],
  };
}

/** A two-branch path: the work is reviewed and merged on dev, then goes out to
    master as its own reviewed pull request and is watched after it lands.
    `RELEASE-APPROVER` is a placeholder — a Project names its own release
    reviewer in that stage's configuration. */
export const PLAYBOOK_DEV_TO_PRODUCTION: PlaybookDraft = {
  activePipelineName: "Dev PR to production",
  savedPipelines: [],
  milestones: [
    templateMilestone("code-finished", "Code implementation completed", "The agent has stopped working and the Task branch carries its commits."),
    templateMilestone("dev-pr-opened", "Development pull request opened", "A pull request from the Task branch into dev exists."),
    templateMilestone(
      "dev-pr-approved",
      "Development pull request approved",
      "The dev pull request carries your own approving review.",
      1800,
      "you",
    ),
    templateMilestone(
      "review-requested",
      "Review requested",
      "A visible message asks REVIEWER to review this Task's development pull request.",
      1800,
      null,
      {
        mode: "ask",
        instructions: "When the development pull request exists and no request is visible, offer to have the existing Task Agent send one concise request to REVIEWER through an available Project communication tool. Do not choose a different recipient or destination silently.",
      },
    ),
    templateMilestone("dev-pr-merged", "Development pull request merged", "The dev pull request is merged, not just approved."),
    templateMilestone("master-pr-opened", "Master pull request opened", "A pull request from dev into master exists and contains this Task's commits."),
    templateMilestone("master-pr-sent", "Master review requested from RELEASE-APPROVER", "The master pull request requests a review from RELEASE-APPROVER.", 1800),
    templateMilestone("master-pr-merged", "Master pull request merged", "The master pull request is merged."),
    templateMilestone("master-deployed", "Deployed to production", "The commit running in production contains this Task's change.", 3600),
    // The last stage can become incomplete by finding an error, so it keeps
    // looking for a while rather than deciding early.
    templateMilestone("logs-clean", "Post-deployment logs remain clean", "No new error relating to this feature has appeared in the production logs since the deploy.", 3600),
  ],
};

export function playbookDevToProductionDraft(): PlaybookDraft {
  return {
    activePipelineName: PLAYBOOK_DEV_TO_PRODUCTION.activePipelineName,
    milestones: PLAYBOOK_DEV_TO_PRODUCTION.milestones.map((milestone) => ({ ...milestone })),
    savedPipelines: [],
  };
}

export type PlaybookTemplate = {
  id: string;
  /** Also the name of the Worker adopting it opens, so the sidebar says which
      pipeline the Worker runs. */
  name: string;
  summary: string;
  draft(): PlaybookDraft;
};

/** What a Project can start from. Each entry is one real delivery path; a
    further template is one entry here, not a new mechanism. */
export const PLAYBOOK_TEMPLATES: readonly PlaybookTemplate[] = [
  {
    id: "ship-to-production",
    name: "Ship to production",
    summary: "An agent picks the Task up, opens a PR, CI passes, someone signs it off, and it reaches production.",
    draft: playbookStarterDraft,
  },
  {
    id: "dev-pr-to-production",
    name: "Dev PR to production",
    summary:
      "A development PR you approve, a visible request to REVIEWER, then a master PR for RELEASE-APPROVER, followed by a production log check.",
    draft: playbookDevToProductionDraft,
  },
];

/** Adds the check policy a template owns to its local draft. No Worker or
    Routine is created here; Core materializes the whole Playbook atomically. */
export function playbookTemplateDraft(
  template: PlaybookTemplate,
): PlaybookDraft {
  const draft = template.draft();
  return {
    ...draft,
    milestones: draft.milestones.map((milestone) => ({
      ...milestone,
      workerId: null,
    })),
  };
}

export type PlaybookSaveDecision =
  | { kind: "conflict" }
  | { kind: "proceed"; params: PlaybookUpdateParams };

/** Internal Routine ids never cross the mutation boundary. The user edits
    check intent; Core owns identity reuse, replacement, and cleanup. */
export function playbookMilestonesForWire(
  milestones: readonly PlaybookMilestoneDraft[],
): PlaybookMilestoneDraftDto[] {
  return milestones.map(({ routineId: _routineId, ...milestone }) => milestone);
}

function playbookPipelinesForWire(
  pipelines: readonly PlaybookPipelineEditorDraft[],
): PlaybookPipelineDraftDto[] {
  return pipelines.map((pipeline) => ({
    name: pipeline.name,
    milestones: playbookMilestonesForWire(pipeline.milestones),
  }));
}

/** The document CAS comes from the revision the draft was edited against; the
    global store CAS is refreshed from the just-read snapshot so unrelated
    mutations elsewhere cannot invalidate an honest Playbook save. */
export function resolvePlaybookSave(
  projectId: string,
  draft: PlaybookDraft,
  basePlaybookRevision: number,
  latest: PlaybookGetResult,
): PlaybookSaveDecision {
  if ((latest.playbook?.revision ?? 0) !== basePlaybookRevision) return { kind: "conflict" };
  return {
    kind: "proceed",
    params: {
      projectId,
      activePipelineName: draft.activePipelineName,
      milestones: playbookMilestonesForWire(draft.milestones),
      savedPipelines: playbookPipelinesForWire(draft.savedPipelines),
      expectedPlaybookRevision: basePlaybookRevision,
      expectedRevision: latest.stateRevision,
    },
  };
}

/** A refused document comes back named only by the field the daemon rejected —
    "playbook" on its own — which tells the user nothing they can act on. A bare
    token is turned into what it means; anything that already reads as a
    sentence is the daemon's own words and is passed through unchanged. */
export function playbookRefusalMessage(message: string): string {
  const said = message.trim();
  return /\s/.test(said) || said === ""
    ? said || "The daemon refused this playbook."
    : "The daemon refused this playbook. Each pipeline needs its own name, and every stage needs a completion Routine.";
}

export function truncatePlaybookLabel(value: string, maxCharacters = 24): string {
  const characters = [...value];
  return characters.length <= maxCharacters ? value : `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export function playbookStationApproverCaption(milestone: Pick<PlaybookMilestoneDraft, "gate" | "approver">): string | undefined {
  if (milestone.gate === "automatic") return undefined;
  return milestone.approver === null ? "needs an approver" : `waits on ${truncatePlaybookLabel(milestone.approver, 18)}`;
}
