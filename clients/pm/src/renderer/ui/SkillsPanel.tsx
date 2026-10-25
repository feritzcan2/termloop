import { useState } from "react";
import type { PmSkill, PmSkillDraft, PmSkillsReadResult, PmTicket, PmDataTier } from "@termloop/pm-contract/pm";
import { Icon } from "./icons.js";
import { relativeTime } from "./format.js";
import { EvidenceList } from "./ProposalCard.js";
import { proposalKindLabel } from "./proposal-change.js";

export type SkillsPanelProps = {
  skills: PmSkillsReadResult | undefined;
  tier: PmDataTier;
  tickets: PmTicket[];
  now: number;
  canCreate: boolean;
  onSetEnabled(skillId: string, enabled: boolean): void;
  onRun(skillId: string): void;
  onCreate(): void;
  onDryRun(draftId: string): void;
  onDiscard(draftId: string): void;
  /** Resolves true once installed. */
  onInstall(draftId: string, approvedTools: string[]): Promise<boolean>;
  onOpenLink(url: string): void;
};

const OUTCOMES: Record<NonNullable<PmSkill["lastOutcome"]>, string> = {
  reported: "reported",
  failed: "failed",
  abandoned: "timed out",
  skipped: "nothing new",
};

function triggerText(skill: PmSkill["manifest"]): string {
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

/**
 * The right sidebar's "Skills" view: each installed skill as a tick, its
 * last run, pending suggestions and runs today, and the drafts the skill
 * creator proposed, each reviewed before it is installed.
 */
export function SkillsPanel(props: SkillsPanelProps) {
  const skills = props.skills?.skills ?? [];
  const drafts = props.skills?.drafts ?? [];
  return (
    <div className="skills-panel">
      <div className="right-sidebar-tools">
        <span className="count-badge" title="Skills">{skills.length}</span>
        <span className="sp" />
        <button type="button" className="view-action" disabled={!props.canCreate} onClick={props.onCreate}>
          <Icon name="plus" />Create a skill
        </button>
      </div>
      {props.skills === undefined ? (
        <p className="hint pad">Loading skills…</p>
      ) : skills.length === 0 && drafts.length === 0 ? (
        <div className="empty-state pad">
          <p>No skills yet.</p>
          <p className="hint">The skill creator looks at what this project has and offers skills that suggest ticket changes for you to review.</p>
        </div>
      ) : (
        <ul className="skill-list" aria-label="Skills">
          {skills.map((skill) => <SkillRow key={skill.id} skill={skill} now={props.now} onSetEnabled={props.onSetEnabled} onRun={props.onRun} />)}
        </ul>
      )}
      {props.tier === "tickets" && <p className="hint pad">Skills that read GitHub pull requests appear once a repository is connected.</p>}
      {props.tier === "code" && <p className="hint pad">Deployment skills appear once an environment is listed.</p>}
      {drafts.map((draft) => (
        <DraftCard
          key={draft.id}
          draft={draft}
          tickets={props.tickets}
          now={props.now}
          onDryRun={() => props.onDryRun(draft.id)}
          onDiscard={() => props.onDiscard(draft.id)}
          onInstall={(tools) => props.onInstall(draft.id, tools)}
          onOpenLink={props.onOpenLink}
        />
      ))}
    </div>
  );
}

function SkillRow({ skill, now, onSetEnabled, onRun }: { skill: PmSkill; now: number; onSetEnabled(id: string, enabled: boolean): void; onRun(id: string): void }) {
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
        <button type="button" className="btn sm" disabled={skill.running} onClick={() => onRun(skill.id)}>{skill.running ? "Running…" : "Run now"}</button>
      </div>
      {skill.pausedReason && <p className="hint bad" role="status">Paused: {skill.pausedReason}</p>}
    </li>
  );
}

function DraftCard(props: {
  draft: PmSkillDraft;
  tickets: PmTicket[];
  now: number;
  onDryRun(): void;
  onDiscard(): void;
  onInstall(tools: string[]): Promise<boolean>;
  onOpenLink(url: string): void;
}) {
  const { draft } = props;
  const [approved, setApproved] = useState<string[]>([]);
  const [installing, setInstalling] = useState(false);
  const dryRunDone = draft.dryRunState === "completed";
  const allApproved = draft.firstUseTools.every((tool) => approved.includes(tool));
  const ticketLabel = (id: string) => props.tickets.find((ticket) => ticket.id === id)?.title ?? "a ticket";
  const toggle = (tool: string, on: boolean) => setApproved(on ? [...approved, tool] : approved.filter((item) => item !== tool));
  const install = async () => {
    setInstalling(true);
    await props.onInstall(approved);
    setInstalling(false);
  };
  return (
    <section className="draft-card skill-draft" aria-label={`Skill draft ${draft.manifest.name}`}>
      <div className="draft-head">
        <span className="sec-label">{draft.origin === "revision" ? "Skill revision" : draft.origin === "import" ? "Imported skill" : "Skill draft"}</span>
        <span className="meta">{relativeTime(draft.createdAtEpochMs, props.now)}</span>
      </div>
      <h3 className="skill-name">{draft.manifest.name}</h3>
      <p className="draft-summary">{draft.whatItWillDo}</p>
      {draft.changelog && <p className="hint">What changed: {draft.changelog}</p>}
      <p className="hint">{triggerText(draft.manifest)}</p>
      {draft.neededTools.filter((tool) => !tool.available).map((tool) => (
        <div key={tool.name} className="needed-tool">
          <b>Missing: {tool.name}</b>
          {tool.steps && <p className="hint">{tool.steps}</p>}
        </div>
      ))}
      {draft.firstUseTools.length > 0 && (
        <fieldset className="tool-approvals">
          <legend>Approve each tool this skill uses for the first time</legend>
          {draft.firstUseTools.map((tool) => (
            <label key={tool}>
              <input type="checkbox" checked={approved.includes(tool)} onChange={(event) => toggle(tool, event.target.checked)} />
              <code>{tool}</code>
            </label>
          ))}
        </fieldset>
      )}
      <div className="dry-run">
        <b>Dry run</b>
        <span className="hint">
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
      <div className="draft-actions">
        <button type="button" className="btn sm" onClick={props.onDiscard}>Discard</button>
        <span className="sp" />
        <button type="button" className="btn sm" disabled={draft.dryRunState === "running"} onClick={props.onDryRun}>{dryRunDone || draft.dryRunState === "failed" ? "Dry run again" : "Dry run"}</button>
        <button
          type="button"
          className="btn sm pri"
          disabled={!dryRunDone || !allApproved || installing}
          title={!dryRunDone ? "Run a dry run first" : !allApproved ? "Approve each new tool first" : undefined}
          onClick={() => void install()}
        >
          Install
        </button>
      </div>
    </section>
  );
}
