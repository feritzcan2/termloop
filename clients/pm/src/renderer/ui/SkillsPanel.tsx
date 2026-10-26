import { useState } from "react";
import type {
  PmDataTier, PmSkill, PmSkillDraft, PmSkillManifest, PmSkillSetup, PmSkillsReadResult, PmTicket, PmToolsReadResult,
} from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import { relativeTime, timeUntil } from "./format.js";
import { EvidenceList, LineDiff } from "./ProposalCard.js";
import { proposalKindLabel } from "./proposal-change.js";
import { EnvironmentSetupDialog } from "./EnvironmentSetupDialog.js";
import { ToolsChecklist } from "./ToolsChecklist.js";

export type SkillsPanelProps = {
  skills: PmSkillsReadResult | undefined;
  tools: PmToolsReadResult | undefined;
  /** Reads the tools checklist; `refresh` checks the machine again. */
  onReadTools(refresh: boolean): Promise<void>;
  tier: PmDataTier;
  tickets: PmTicket[];
  now: number;
  canCreate: boolean;
  onSetEnabled(skillId: string, enabled: boolean): void;
  onRun(skillId: string): void;
  /** Opens the skill's SKILL.md in the stage. */
  onOpenFile(skillId: string): void;
  onCreate(): void;
  /** Starts the skill creator to propose a revision of an installed skill. */
  onRevise(skillId: string): void;
  /** A listed skill's Set up: each skill has its own setup. */
  onSetUp(kind: PmSkillSetup): void;
  onDryRun(draftId: string): void;
  onDiscard(draftId: string): void;
  /** Resolves true once installed; `channels` are the ticked Slack channel ids. */
  onInstall(draftId: string, approvedTools: string[], channels: string[]): Promise<boolean>;
  onOpenLink(url: string): void;
  /** Resolves true once applied: the ticked environments are listed and Deployment control is on. */
  onApplyEnvironments(environments: string[], probeIds: string[]): Promise<boolean>;
  onDiscardEnvironments(): void;
};

const OUTCOMES: Record<NonNullable<PmSkill["lastOutcome"]>, string> = {
  reported: "reported",
  failed: "failed",
  abandoned: "timed out",
  skipped: "nothing new",
};

export function triggerText(skill: PmSkillManifest): string {
  switch (skill.trigger.kind) {
    case "manual": return "Manual";
    case "schedule": return `Every ${skill.trigger.everyMinutes} min`;
    case "event": return {
      jiraPulled: "After each Jira pull",
      deployChanged: "When a deployment changes",
      boardChanged: "When the board changes",
    }[skill.trigger.event];
  }
}

/** The skills always listed, greyed out until the PM sets them up. */
const KNOWN_SKILLS: { kind: PmSkillSetup; name: string; description: string; matches(skill: Pick<PmSkill, "builtin" | "manifest">): boolean }[] = [
  {
    kind: "deploymentControl",
    name: "Deployment control",
    description: "Finds out which environments run each ticket's change: it runs the approved probes and starts a delivery check when a ticket's deployment is unknown or changed.",
    matches: (skill) => skill.builtin === "deploymentControl",
  },
  {
    kind: "bugOwnerFinder",
    name: "Bug owner finder",
    description: "Suggests who should own a new bug from code history, pull requests, and similar tickets.",
    matches: (skill) => skill.builtin === null && skill.manifest.prefilter === "bugTickets",
  },
  {
    kind: "slackTracker",
    name: "Slack tracker",
    description: "Reads the Slack channels you pick and suggests ticket updates from messages that name tickets.",
    matches: (skill) => skill.builtin === null && skill.manifest.prefilter === "slackMentions",
  },
];

/**
 * The right sidebar's "Skills" view: each installed skill as a tick, its
 * last run, pending suggestions and runs today, and the drafts the skill
 * creator proposed, each reviewed before it is installed.
 */
export function SkillsPanel(props: SkillsPanelProps) {
  const skills = props.skills?.skills ?? [];
  const drafts = props.skills?.drafts ?? [];
  const proposal = props.skills?.environmentProposal ?? null;
  const [reviewing, setReviewing] = useState(false);
  // The built-in Deployment control shows as a Set up row until it is on.
  const shown = skills.filter((skill) => skill.builtin === null || skill.enabled);
  const row = (skill: PmSkill) => (
    <SkillRow key={skill.id} skill={skill} now={props.now} onSetEnabled={props.onSetEnabled} onRun={props.onRun} onRevise={props.onRevise} onOpenFile={props.onOpenFile} />
  );
  return (
    <div className="skills-panel">
      <div className="right-sidebar-tools">
        <span className="meta">{skills.filter((skill) => skill.enabled).length} on</span>
        <span className="sp" />
        <button type="button" className="view-action" disabled={!props.canCreate} onClick={props.onCreate}>
          <Icon name="plus" />Create a skill
        </button>
      </div>
      {props.skills === undefined ? (
        <p className="hint pad">Loading skills…</p>
      ) : (
        <ul className="skill-list" aria-label="Skills">
          {KNOWN_SKILLS.map((known) => {
            const set = shown.filter((skill) => known.matches(skill));
            if (set.length > 0) return set.map(row);
            const draft = drafts.find((draft) => draft.baseSkillId === null && known.matches({ builtin: null, manifest: draft.manifest }));
            const review = known.kind === "deploymentControl"
              ? proposal && (() => setReviewing(true))
              : draft && (() => document.getElementById(draftAnchor(draft.id))?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
            return <SetupRow key={known.kind} {...known} onReview={review || undefined} onSetUp={() => props.onSetUp(known.kind)} />;
          })}
          {shown.filter((skill) => !KNOWN_SKILLS.some((known) => known.matches(skill))).map(row)}
        </ul>
      )}
      {props.tier === "tickets" && <p className="hint pad">Skills that read GitHub pull requests appear once a repository is connected.</p>}
      <ToolsChecklist tools={props.tools} now={props.now} onRead={props.onReadTools} />
      {proposal && reviewing && (
        <EnvironmentSetupDialog
          key={proposal.createdAtEpochMs}
          proposal={proposal}
          now={props.now}
          onApply={props.onApplyEnvironments}
          onDiscard={props.onDiscardEnvironments}
          onClose={() => setReviewing(false)}
        />
      )}
      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          base={skills.find((skill) => skill.id === draft.baseSkillId)}
          tickets={props.tickets}
          now={props.now}
          onDryRun={() => props.onDryRun(draft.id)}
          onDiscard={() => props.onDiscard(draft.id)}
          onInstall={(tools, channels) => props.onInstall(draft.id, tools, channels)}
          onOpenLink={props.onOpenLink}
        />
      ))}
    </div>
  );
}

function draftAnchor(draftId: string): string {
  return `skill-draft-${draftId}`;
}

/** A known skill that is not set up: greyed out, with its own Set up, or Review once its setup proposed something. */
function SetupRow(props: { name: string; description: string; onReview: (() => void) | undefined; onSetUp(): void }) {
  return (
    <li className="skill-row off setup">
      <span className="skill-tick">
        <span className={`skill-state ${props.onReview ? "ready" : ""}`} aria-hidden="true" />
        <span className="skill-name">{props.name}</span>
      </span>
      <p className="skill-description">{props.description}</p>
      <div className="skill-meta">
        {props.onReview ? <span className="chip ready">Ready to review</span> : <span>Not set up</span>}
        <span className="sp" />
        {props.onReview
          ? <button type="button" className="btn sm pri" onClick={props.onReview}>Review</button>
          : <button type="button" className="btn sm pri" onClick={props.onSetUp}>Set up</button>}
      </div>
    </li>
  );
}

function SkillRow({ skill, now, onSetEnabled, onRun, onRevise, onOpenFile }: {
  skill: PmSkill;
  now: number;
  onSetEnabled(id: string, enabled: boolean): void;
  onRun(id: string): void;
  onRevise(id: string): void;
  onOpenFile(id: string): void;
}) {
  const last = skill.lastRunAtEpochMs === null
    ? "Never run"
    : `${relativeTime(skill.lastRunAtEpochMs, now)}${skill.lastOutcome ? ` · ${OUTCOMES[skill.lastOutcome]}` : ""}`;
  return (
    <li className={`skill-row ${skill.enabled ? "" : "off"}`}>
      <label className="skill-tick">
        <input type="checkbox" checked={skill.enabled} onChange={(event) => onSetEnabled(skill.id, event.target.checked)} aria-label={`${skill.manifest.name} enabled`} />
        <span className="skill-name">{skill.manifest.name}</span>
      </label>
      <p className="skill-description">{skill.manifest.description}</p>
      <div className="skill-meta">
        <span>{triggerText(skill.manifest)}</span>
        <span>{last}</span>
        {skill.pendingSuggestionCount > 0 && <span className="chip warn">{skill.pendingSuggestionCount} pending</span>}
        <span title="Runs today">{skill.runsToday} today</span>
        <span className="sp" />
        <button type="button" className="link skill-file-link" aria-label={`${skill.manifest.name} SKILL.md`} onClick={() => onOpenFile(skill.id)}>SKILL.md</button>
        {skill.builtin === null && !skill.revisionReason && (
          <button type="button" className="btn sm ghost" onClick={() => onRevise(skill.id)}>Revise</button>
        )}
        <button type="button" className="btn sm" disabled={skill.running} onClick={() => onRun(skill.id)}>{skill.running ? "Running…" : "Run now"}</button>
      </div>
      {skill.pausedReason
        ? <p className="hint bad" role="status">{skill.pausedReason}</p>
        : skill.nextAttemptAtEpochMs !== null && skill.nextAttemptAtEpochMs > now && (
          <p className="hint" role="status">The last run failed; it tries again {timeUntil(skill.nextAttemptAtEpochMs, now)}.</p>
        )}
      {skill.revisionReason && (
        <div className="revision-offer" role="status">
          <p>{skill.revisionReason} The skill creator can propose a better version for you to compare.</p>
          <button type="button" className="btn sm pri" onClick={() => onRevise(skill.id)}>Revise</button>
        </div>
      )}
    </li>
  );
}

function toggled(list: string[], item: string, on: boolean): string[] {
  return on ? [...list, item] : list.filter((other) => other !== item);
}

/** A PM tool by name; one of the agent's own tools with its server. */
function ToolName(props: { tool: string }) {
  const own = /^mcp__(.+?)__(.+)$/.exec(props.tool);
  if (!own) return <code>{props.tool}</code>;
  return <span>Your agent's <code>{own[2]}</code> <span className="hint">({own[1]}, read-only)</span></span>;
}

/** A manifest as plain lines, so two versions compare line by line. */
export function manifestLines(manifest: PmSkillManifest): string {
  return [
    `Name: ${manifest.name}`,
    `Description: ${manifest.description}`,
    `Runs: ${triggerText(manifest)}`,
    `Reads: ${manifest.sources.join(", ")}`,
    `Prefilter: ${manifest.prefilter}`,
    ...manifest.approvedTools.map((tool) => `Tool: ${tool}`),
    ...manifest.agentTools.map((tool) => `Agent tool: ${tool}`),
    ...manifest.channels.map((channel) => `Channel: #${channel.name}`),
    "Instructions:",
    manifest.instructions,
  ].join("\n");
}

function DraftCard(props: {
  draft: PmSkillDraft;
  /** The installed skill a revision replaces. */
  base: PmSkill | undefined;
  tickets: PmTicket[];
  now: number;
  onDryRun(): void;
  onDiscard(): void;
  onInstall(tools: string[], channels: string[]): Promise<boolean>;
  onOpenLink(url: string): void;
}) {
  const { draft } = props;
  const [approved, setApproved] = useState<string[]>([]);
  const [channels, setChannels] = useState<string[]>(() => draft.manifest.channels.map((channel) => channel.id));
  const needsChannel = draft.manifest.channels.length > 0 && channels.length === 0;
  const [installing, setInstalling] = useState(false);
  const dryRunDone = draft.dryRunState === "completed";
  const allApproved = draft.firstUseTools.every((tool) => approved.includes(tool));
  const ticketLabel = (id: string) => props.tickets.find((ticket) => ticket.id === id)?.title ?? "a ticket";
  const blocked = !dryRunDone
    ? "Run a dry run first."
    : !allApproved ? "Approve each new tool first." : needsChannel ? "Tick at least one channel." : undefined;
  const install = async () => {
    setInstalling(true);
    await props.onInstall(approved, channels);
    setInstalling(false);
  };
  return (
    <section id={draftAnchor(draft.id)} className="draft-card skill-draft" aria-label={`Skill draft ${draft.manifest.name}`}>
      <div className="draft-head">
        <span className="sec-label">{draft.origin === "revision" ? "Skill revision" : draft.origin === "import" ? "Imported skill" : "Skill draft"}</span>
        <span className="meta">{relativeTime(draft.createdAtEpochMs, props.now)}</span>
      </div>
      <h3 className="skill-name">{draft.manifest.name}</h3>
      <p className="draft-summary">{draft.whatItWillDo}</p>
      {draft.changelog && <p className="hint">What changed: {draft.changelog}</p>}
      {props.base && (
        <LineDiff before={manifestLines(props.base.manifest)} after={manifestLines(draft.manifest)} label={`Changes from v${props.base.version}`} />
      )}
      <div className="skill-meta"><span className="chip">{triggerText(draft.manifest)}</span></div>
      {draft.neededTools.filter((tool) => !tool.available).map((tool) => (
        <div key={tool.name} className="needed-tool">
          <b>Missing: {tool.name}</b>
          {tool.steps && <p>{tool.steps}</p>}
        </div>
      ))}
      {draft.firstUseTools.length > 0 && (
        <fieldset className="tool-approvals">
          <legend>Approve each tool this skill uses for the first time</legend>
          {draft.firstUseTools.map((tool) => (
            <label key={tool}>
              <input type="checkbox" checked={approved.includes(tool)} onChange={(event) => setApproved(toggled(approved, tool, event.target.checked))} />
              <ToolName tool={tool} />
            </label>
          ))}
        </fieldset>
      )}
      {draft.manifest.channels.length > 0 && (
        <fieldset className="tool-approvals">
          <legend>Slack channels to follow</legend>
          {draft.manifest.channels.map((channel) => (
            <label key={channel.id}>
              <input
                type="checkbox"
                checked={channels.includes(channel.id)}
                onChange={(event) => setChannels(toggled(channels, channel.id, event.target.checked))}
              />
              #{channel.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className={`dry-run ${draft.dryRunState}`}>
        <span className="sec-label">Dry run</span>
        <span className="dry-run-state">
          {draft.dryRunState === "none" && "Not run yet: it runs over the last 3 days and changes nothing."}
          {draft.dryRunState === "running" && "Running…"}
          {draft.dryRunState === "failed" && "The dry run failed; try again."}
          {dryRunDone && `${draft.samples.length} sample suggestion(s).`}
        </span>
      </div>
      {draft.samples.length > 0 && (
        <ul className="samples" aria-label="Dry-run samples">
          {draft.samples.map((sample, index) => (
            <li key={index}>
              <span className="meta">{proposalKindLabel(sample.change)} · {ticketLabel(sample.ticketId)}</span>
              <p>{sample.summary}</p>
              <EvidenceList evidence={sample.evidence} onOpenLink={props.onOpenLink} />
            </li>
          ))}
        </ul>
      )}
      {blocked && <p className="hint install-hint">{blocked}</p>}
      <div className="draft-actions">
        <button type="button" className="btn sm ghost" onClick={props.onDiscard}>Discard</button>
        <span className="sp" />
        <button type="button" className="btn sm" disabled={draft.dryRunState === "running"} onClick={props.onDryRun}>{dryRunDone || draft.dryRunState === "failed" ? "Dry run again" : "Dry run"}</button>
        <button
          type="button"
          className="btn sm pri"
          disabled={blocked !== undefined || installing}
          onClick={() => void install()}
        >
          {props.base ? `Install as v${props.base.version + 1}` : "Install"}
        </button>
      </div>
    </section>
  );
}
