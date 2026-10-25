//! Skill commands: the built-in skills, drafts from the skill creator and
//! their dry runs, installs with explicit tool approval, runs, feedback,
//! and the creator's discovery cache.

use rusqlite::{Connection, params};

use super::check_id;
use crate::delivery::risks::DAY_MS;
use crate::skill::{
    BuiltinSkill, DryRunState, FeedbackOutcome, NewSkillDraft, PROJECT_SKILL_DRAFTS_MAX,
    PROJECT_SKILLS_MAX, SKILL_DRAFT_SAMPLES_MAX, SKILL_FEEDBACK_KEPT, SKILL_RUN_DEADLINE_MS,
    SKILL_RUN_SUMMARY_MAX_CHARS, SKILL_RUNS_KEPT, Skill, SkillDraft, SkillEvent, SkillFeedback,
    SkillManifest, SkillRun, SkillRunOutcome, SkillRunTrigger, SkillSample, bounded_line,
    evidence_sources, valid_evidence,
};
use crate::store::{
    SkillRecord, ToolApproval, approved_tools_ever, builtin_skill_record, draft_by_id, json_column,
    last_completed_skill_run, last_skill_run, launched_runs_since, project_checks, project_drafts,
    project_skill_records, run_by_id, running_skill_runs, skill_feedback, skill_is_running,
    skill_manifest, skill_proposal_count, skill_record, skill_runs, to_json,
};
use crate::validation::valid_label;
use crate::{DeliveryCheckOutcome, PmError, PmStore, ProbeStatus, TicketProposal};

/// The bound of the creator's cached discovery report.
pub const SKILL_DISCOVERY_MAX_BYTES: usize = 64 * 1024;
/// After this many failed runs in a row a skill pauses until re-enabled.
pub const SKILL_PAUSE_AFTER_FAILURES: u32 = 3;
/// A failed skill waits this long before it is due again, doubling with
/// each further failure in a row.
pub const SKILL_RETRY_AFTER_MS: u64 = 15 * 60_000;
/// Suggestions one inbox read returns at most.
pub const SKILL_SUGGESTIONS_READ_MAX: usize = 200;
const PAUSE_DETAIL_MAX_CHARS: usize = 200;

fn require_skill(connection: &Connection, skill_id: &str) -> Result<SkillRecord, PmError> {
    check_id(skill_id, "skillId")?;
    skill_record(connection, skill_id)?.ok_or(PmError::NotFound)
}

fn require_draft(connection: &Connection, draft_id: &str) -> Result<SkillDraft, PmError> {
    check_id(draft_id, "draftId")?;
    draft_by_id(connection, draft_id)?.ok_or(PmError::NotFound)
}

fn require_run(connection: &Connection, run_id: &str) -> Result<SkillRun, PmError> {
    check_id(run_id, "runId")?;
    run_by_id(connection, run_id)?.ok_or(PmError::NotFound)
}

/// The start of the UTC day `now` falls in.
fn day_start(now: u64) -> u64 {
    now - now % DAY_MS
}

/// The skill as the PM sees it: its manifest and derived run state. The
/// built-in Deployment control reports its delivery checks and proposed
/// probes, which are its runs and suggestions.
fn skill_view(connection: &Connection, record: SkillRecord, now: u64) -> Result<Skill, PmError> {
    let manifest = skill_manifest(
        connection,
        &record.id,
        record.version,
        record.builtin.is_some(),
    )?;
    let mut skill = Skill {
        id: record.id,
        project_id: record.project_id,
        builtin: record.builtin,
        enabled: record.enabled,
        version: record.version,
        manifest,
        last_run_at_epoch_ms: None,
        last_outcome: None,
        running: false,
        pending_suggestion_count: 0,
        runs_today: 0,
        consecutive_failures: record.consecutive_failures,
        paused_reason: record.paused_reason,
        next_attempt_at_epoch_ms: record.next_attempt_at_epoch_ms,
        created_at_epoch_ms: record.created_at_epoch_ms,
    };
    match skill.builtin {
        Some(BuiltinSkill::DeploymentControl) => {
            let checks = project_checks(connection, &skill.project_id)?;
            if let Some(last) = checks.iter().max_by_key(|check| check.started_at_epoch_ms) {
                skill.last_run_at_epoch_ms = Some(last.started_at_epoch_ms);
                skill.running = last.is_running();
                skill.last_outcome = last.outcome.map(|outcome| match outcome {
                    DeliveryCheckOutcome::Reported => SkillRunOutcome::Reported,
                    DeliveryCheckOutcome::Failed => SkillRunOutcome::Failed,
                    DeliveryCheckOutcome::Abandoned => SkillRunOutcome::Abandoned,
                });
            }
            skill.runs_today = checks
                .iter()
                .filter(|check| check.started_at_epoch_ms >= day_start(now))
                .count() as u32;
            skill.pending_suggestion_count =
                crate::store::project_probes(connection, &skill.project_id)?
                    .iter()
                    .filter(|probe| probe.status == ProbeStatus::Proposed)
                    .count() as u32;
        }
        None => {
            if let Some(last) = last_skill_run(connection, &skill.id)? {
                skill.last_run_at_epoch_ms = Some(last.started_at_epoch_ms);
                skill.last_outcome = last.outcome;
            }
            skill.running = skill_is_running(connection, &skill.id)?;
            skill.runs_today = launched_runs_since(connection, &skill.id, day_start(now))?;
            skill.pending_suggestion_count = skill_proposal_count(connection, &skill.id)?;
        }
    }
    Ok(skill)
}

fn insert_version(
    connection: &Connection,
    skill_id: &str,
    version: u32,
    manifest: &SkillManifest,
    approvals: &[ToolApproval],
    changelog: Option<&str>,
    now: u64,
) -> Result<(), PmError> {
    connection.execute(
        "INSERT INTO skill_versions (skill_id, version, manifest_json, approvals_json, \
             changelog, recorded_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            skill_id,
            version,
            to_json(manifest)?,
            to_json(&approvals)?,
            changelog,
            now
        ],
    )?;
    Ok(())
}

/// Records the PM's verdict on a skill's suggestion, keeping the newest
/// [`SKILL_FEEDBACK_KEPT`] per skill. An assistant proposal records none.
pub(super) fn record_feedback(
    connection: &Connection,
    proposal: &TicketProposal,
    outcome: FeedbackOutcome,
    reason: Option<&str>,
    now: u64,
) -> Result<(), PmError> {
    let (Some(skill_id), Some(version)) = (&proposal.skill_id, proposal.skill_version) else {
        return Ok(());
    };
    if skill_record(connection, skill_id)?.is_none() {
        return Ok(());
    }
    let key = crate::skill::evidence_key(
        &proposal.ticket_id,
        proposal.change.kind(),
        &proposal.evidence,
    );
    connection.execute(
        "INSERT INTO skill_feedback (skill_id, version, ticket_id, kind, outcome, evidence_key, \
             sources_json, reason, recorded_at_epoch_ms) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            skill_id,
            version,
            proposal.ticket_id,
            proposal.change.kind(),
            outcome.as_str(),
            key,
            to_json(&evidence_sources(&proposal.evidence))?,
            reason,
            now
        ],
    )?;
    connection.execute(
        "DELETE FROM skill_feedback WHERE skill_id = ?1 AND id NOT IN \
             (SELECT id FROM skill_feedback WHERE skill_id = ?1 ORDER BY id DESC LIMIT ?2)",
        params![skill_id, SKILL_FEEDBACK_KEPT],
    )?;
    Ok(())
}

/// Closes a run inside a transaction and updates what its outcome means
/// for the skill or draft: a failure counts toward the pause, a report or a
/// skip resets the count, and a dry run marks its draft.
pub(super) fn close_run(
    connection: &Connection,
    run: &SkillRun,
    outcome: SkillRunOutcome,
    summary: Option<&str>,
    now: u64,
) -> Result<(), PmError> {
    connection.execute(
        "UPDATE skill_runs SET finished_at_epoch_ms = ?2, outcome = ?3, summary = ?4 \
         WHERE id = ?1 AND finished_at_epoch_ms IS NULL",
        params![run.id, now, outcome.as_str(), summary],
    )?;
    if let Some(draft_id) = &run.draft_id {
        let state = if outcome == SkillRunOutcome::Reported {
            DryRunState::Completed
        } else {
            DryRunState::Failed
        };
        connection.execute(
            "UPDATE skill_drafts SET dry_run_state = ?2, dry_run_at_epoch_ms = ?3 WHERE id = ?1",
            params![draft_id, state.as_str(), now],
        )?;
    }
    if let Some(skill_id) = &run.skill_id {
        match outcome {
            SkillRunOutcome::Reported | SkillRunOutcome::Skipped => {
                connection.execute(
                    "UPDATE skills SET consecutive_failures = 0, next_attempt_at_epoch_ms = NULL \
                     WHERE id = ?1",
                    [skill_id],
                )?;
            }
            SkillRunOutcome::Failed | SkillRunOutcome::Abandoned => {
                // The retry wait doubles with each failure in a row, up to 256x.
                let failures: u32 = connection.query_row(
                    "UPDATE skills SET consecutive_failures = consecutive_failures + 1, \
                         next_attempt_at_epoch_ms = ?2 + (?3 << min(consecutive_failures, 8)) \
                     WHERE id = ?1 RETURNING consecutive_failures",
                    params![skill_id, now, SKILL_RETRY_AFTER_MS],
                    |row| row.get(0),
                )?;
                if failures >= SKILL_PAUSE_AFTER_FAILURES {
                    let last = summary.map_or_else(
                        || outcome_words(outcome).to_owned(),
                        |summary| bounded_line(summary, PAUSE_DETAIL_MAX_CHARS),
                    );
                    let stop = if last.ends_with(['.', '!', '?']) {
                        ""
                    } else {
                        "."
                    };
                    connection.execute(
                        "UPDATE skills SET enabled = 0, paused_reason = ?2 \
                         WHERE id = ?1 AND paused_reason IS NULL",
                        params![
                            skill_id,
                            format!(
                                "Paused after {failures} failed runs in a row. Last run: {last}{stop} \
                                 Turn it on to try again."
                            )
                        ],
                    )?;
                }
            }
        }
        connection.execute(
            "DELETE FROM skill_runs WHERE skill_id = ?1 AND finished_at_epoch_ms IS NOT NULL \
                 AND id NOT IN (SELECT id FROM skill_runs WHERE skill_id = ?1 \
                     ORDER BY started_at_epoch_ms DESC, id LIMIT ?2)",
            params![skill_id, SKILL_RUNS_KEPT],
        )?;
    }
    Ok(())
}

fn outcome_words(outcome: SkillRunOutcome) -> &'static str {
    match outcome {
        SkillRunOutcome::Abandoned => "it took too long and was stopped",
        _ => "it failed",
    }
}

impl PmStore {
    /// Adds the built-in skills a project qualifies for: Deployment control
    /// once deploy tracking is on, enabled. A skill the PM already has
    /// keeps the PM's choice.
    pub fn ensure_builtin_skills(&mut self, project_id: &str) -> Result<(), PmError> {
        check_id(project_id, "projectId")?;
        if !self.deploy_tracking_enabled(project_id)? {
            return Ok(());
        }
        let builtin = BuiltinSkill::DeploymentControl;
        if builtin_skill_record(self.connection(), project_id, builtin)?.is_some() {
            return Ok(());
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            if builtin_skill_record(transaction, project_id, builtin)?.is_some() {
                return Ok(());
            }
            transaction.execute(
                "INSERT INTO skills (id, project_id, builtin, enabled, version, \
                     created_at_epoch_ms) VALUES (?1, ?2, ?3, 1, 1, ?4)",
                params![id, project_id, builtin.as_str(), now],
            )?;
            insert_version(transaction, &id, 1, &builtin.manifest(), &[], None, now)
        })
    }

    /// Whether the built-in Deployment control may start delivery checks
    /// on its own: deploy tracking is on and the PM has not turned it off.
    pub fn deployment_control_enabled(&mut self, project_id: &str) -> Result<bool, PmError> {
        self.ensure_builtin_skills(project_id)?;
        Ok(builtin_skill_record(
            self.connection(),
            project_id,
            BuiltinSkill::DeploymentControl,
        )?
        .is_some_and(|record| record.enabled))
    }

    pub fn skills(&self, project_id: &str) -> Result<Vec<Skill>, PmError> {
        check_id(project_id, "projectId")?;
        let now = self.now();
        project_skill_records(self.connection(), project_id)?
            .into_iter()
            .map(|record| skill_view(self.connection(), record, now))
            .collect()
    }

    pub fn skill(&self, skill_id: &str) -> Result<Option<Skill>, PmError> {
        check_id(skill_id, "skillId")?;
        skill_record(self.connection(), skill_id)?
            .map(|record| skill_view(self.connection(), record, self.now()))
            .transpose()
    }

    /// Turns a skill on or off. Turning it on clears a pause and its
    /// failure count.
    pub fn set_skill_enabled(&mut self, skill_id: &str, enabled: bool) -> Result<Skill, PmError> {
        let now = self.now();
        self.write(|transaction| {
            require_skill(transaction, skill_id)?;
            if enabled {
                transaction.execute(
                    "UPDATE skills SET enabled = 1, paused_reason = NULL, \
                         consecutive_failures = 0, next_attempt_at_epoch_ms = NULL WHERE id = ?1",
                    [skill_id],
                )?;
            } else {
                transaction.execute("UPDATE skills SET enabled = 0 WHERE id = ?1", [skill_id])?;
            }
            skill_view(transaction, require_skill(transaction, skill_id)?, now)
        })
    }

    pub fn submit_skill_draft(&mut self, new: NewSkillDraft) -> Result<SkillDraft, PmError> {
        if let Some(field) = new.invalid_field() {
            return Err(PmError::Invalid(field));
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            if let Some(base) = &new.base_skill_id {
                let record = require_skill(transaction, base)?;
                if record.project_id != new.project_id || record.builtin.is_some() {
                    return Err(PmError::Invalid("baseSkillId"));
                }
            }
            let count: usize = transaction.query_row(
                "SELECT COUNT(*) FROM skill_drafts WHERE project_id = ?1",
                [&new.project_id],
                |row| row.get(0),
            )?;
            if count >= PROJECT_SKILL_DRAFTS_MAX {
                return Err(PmError::Constraint("too many skill drafts"));
            }
            transaction.execute(
                "INSERT INTO skill_drafts (id, project_id, origin, base_skill_id, manifest_json, \
                     what_it_will_do, needed_tools_json, changelog, dry_run_state, samples_json, \
                     created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'none', '[]', ?9)",
                params![
                    id,
                    new.project_id,
                    new.origin.as_str(),
                    new.base_skill_id,
                    to_json(&new.manifest)?,
                    new.what_it_will_do,
                    to_json(&new.needed_tools)?,
                    new.changelog,
                    now
                ],
            )?;
            require_draft(transaction, &id)
        })
    }

    pub fn skill_drafts(&self, project_id: &str) -> Result<Vec<SkillDraft>, PmError> {
        check_id(project_id, "projectId")?;
        project_drafts(self.connection(), project_id)
    }

    pub fn skill_draft(&self, draft_id: &str) -> Result<Option<SkillDraft>, PmError> {
        check_id(draft_id, "draftId")?;
        draft_by_id(self.connection(), draft_id)
    }

    pub fn discard_skill_draft(&mut self, draft_id: &str) -> Result<SkillDraft, PmError> {
        self.write(|transaction| {
            let draft = require_draft(transaction, draft_id)?;
            transaction.execute("DELETE FROM skill_drafts WHERE id = ?1", [draft_id])?;
            Ok(draft)
        })
    }

    /// Installs a draft after its dry run completed. Every tool the draft
    /// uses for the first time must be in `approved_tools`, the PM's ticks;
    /// the approvals are recorded in the new manifest version. `channels`,
    /// when given, are the Slack channels the PM ticked of the proposed
    /// ones. A revision becomes the next version of its skill; any other
    /// draft a new, enabled skill. The draft is then removed.
    pub fn install_skill_draft(
        &mut self,
        draft_id: &str,
        approved_tools: &[String],
        channels: Option<&[String]>,
    ) -> Result<Skill, PmError> {
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let draft = require_draft(transaction, draft_id)?;
            if draft.dry_run_state != DryRunState::Completed {
                return Err(PmError::Constraint(
                    "the draft needs a completed dry run first",
                ));
            }
            if !draft
                .first_use_tools
                .iter()
                .all(|tool| approved_tools.contains(tool))
            {
                return Err(PmError::Constraint(
                    "every tool used for the first time needs its own approval",
                ));
            }
            let mut manifest = draft.manifest.clone();
            if let Some(channels) = channels {
                if !channels
                    .iter()
                    .all(|channel| manifest.reads_channel(channel))
                {
                    return Err(PmError::Invalid("channels"));
                }
                manifest
                    .channels
                    .retain(|channel| channels.contains(&channel.id));
                if manifest.invalid_field().is_some() {
                    return Err(PmError::Invalid("channels"));
                }
            }
            let approvals: Vec<ToolApproval> = draft
                .first_use_tools
                .iter()
                .map(|tool| ToolApproval {
                    tool: tool.clone(),
                    approved_at_epoch_ms: now,
                })
                .collect();
            let skill_id = match &draft.base_skill_id {
                Some(base) => {
                    let record = require_skill(transaction, base)?;
                    let version = record.version + 1;
                    insert_version(
                        transaction,
                        base,
                        version,
                        &manifest,
                        &approvals,
                        draft.changelog.as_deref(),
                        now,
                    )?;
                    transaction.execute(
                        "UPDATE skills SET version = ?2 WHERE id = ?1",
                        params![base, version],
                    )?;
                    base.clone()
                }
                None => {
                    let count: usize = transaction.query_row(
                        "SELECT COUNT(*) FROM skills WHERE project_id = ?1",
                        [&draft.project_id],
                        |row| row.get(0),
                    )?;
                    if count >= PROJECT_SKILLS_MAX {
                        return Err(PmError::Constraint("too many skills"));
                    }
                    transaction.execute(
                        "INSERT INTO skills (id, project_id, enabled, version, \
                             created_at_epoch_ms) VALUES (?1, ?2, 1, 1, ?3)",
                        params![id, draft.project_id, now],
                    )?;
                    insert_version(
                        transaction,
                        &id,
                        1,
                        &manifest,
                        &approvals,
                        draft.changelog.as_deref(),
                        now,
                    )?;
                    id.clone()
                }
            };
            transaction.execute("DELETE FROM skill_drafts WHERE id = ?1", [draft_id])?;
            skill_view(transaction, require_skill(transaction, &skill_id)?, now)
        })
    }

    /// Records a run of an enabled skill that the prefilter let through;
    /// one running run per skill.
    pub fn start_skill_run(
        &mut self,
        skill_id: &str,
        trigger: SkillRunTrigger,
        items: u32,
    ) -> Result<SkillRun, PmError> {
        if trigger == SkillRunTrigger::DryRun {
            return Err(PmError::Invalid("trigger"));
        }
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let record = require_skill(transaction, skill_id)?;
            if record.builtin.is_some() {
                return Err(PmError::Constraint(
                    "a built-in skill runs without an agent",
                ));
            }
            if !record.enabled && trigger != SkillRunTrigger::Manual {
                return Err(PmError::Constraint("the skill is off"));
            }
            if skill_is_running(transaction, skill_id)? {
                return Err(PmError::Constraint("the skill is already running"));
            }
            transaction.execute(
                "INSERT INTO skill_runs (id, project_id, skill_id, version, trigger, items, \
                     started_at_epoch_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    record.project_id,
                    skill_id,
                    record.version,
                    trigger.as_str(),
                    items,
                    now
                ],
            )?;
            transaction.execute(
                "UPDATE skills SET event_pending_at_epoch_ms = NULL WHERE id = ?1",
                [skill_id],
            )?;
            require_run(transaction, &id)
        })
    }

    /// Records that the prefilter found nothing new: a closed, skipped run
    /// that launched no agent.
    pub fn record_skipped_skill_run(
        &mut self,
        skill_id: &str,
        trigger: SkillRunTrigger,
    ) -> Result<SkillRun, PmError> {
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let record = require_skill(transaction, skill_id)?;
            transaction.execute(
                "INSERT INTO skill_runs (id, project_id, skill_id, version, trigger, items, \
                     started_at_epoch_ms, finished_at_epoch_ms, outcome) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6, 'skipped')",
                params![
                    id,
                    record.project_id,
                    skill_id,
                    record.version,
                    trigger.as_str(),
                    now
                ],
            )?;
            transaction.execute(
                "UPDATE skills SET event_pending_at_epoch_ms = NULL, consecutive_failures = 0, \
                     next_attempt_at_epoch_ms = NULL WHERE id = ?1",
                [skill_id],
            )?;
            require_run(transaction, &id)
        })
    }

    /// Starts a draft's dry run; its samples replace earlier ones.
    pub fn start_dry_run(&mut self, draft_id: &str, items: u32) -> Result<SkillRun, PmError> {
        let id = self.new_id();
        let now = self.now();
        self.write(|transaction| {
            let draft = require_draft(transaction, draft_id)?;
            if draft.dry_run_state == DryRunState::Running {
                return Err(PmError::Constraint("the dry run is already running"));
            }
            transaction.execute(
                "INSERT INTO skill_runs (id, project_id, draft_id, trigger, items, \
                     started_at_epoch_ms) VALUES (?1, ?2, ?3, 'dryRun', ?4, ?5)",
                params![id, draft.project_id, draft_id, items, now],
            )?;
            transaction.execute(
                "UPDATE skill_drafts SET dry_run_state = 'running', dry_run_at_epoch_ms = ?2, \
                     samples_json = '[]' WHERE id = ?1",
                params![draft_id, now],
            )?;
            require_run(transaction, &id)
        })
    }

    /// Keeps one suggestion of a running dry run as a sample; never a
    /// proposal.
    pub fn record_dry_run_sample(
        &mut self,
        run_id: &str,
        sample: SkillSample,
    ) -> Result<(), PmError> {
        if !sample.change.is_valid() {
            return Err(PmError::Invalid(sample.change.parameter()));
        }
        if !crate::valid_proposal_summary(&sample.summary) {
            return Err(PmError::Invalid("summary"));
        }
        if !valid_evidence(&sample.evidence) {
            return Err(PmError::Invalid("evidence"));
        }
        self.write(|transaction| {
            let run = require_run(transaction, run_id)?;
            let (Some(draft_id), true) = (&run.draft_id, run.is_running()) else {
                return Err(PmError::Constraint("not a running dry run"));
            };
            let mut draft = require_draft(transaction, draft_id)?;
            let ticket = super::require_ticket(transaction, &sample.ticket_id)?;
            if ticket.project_id != draft.project_id {
                return Err(PmError::NotFound);
            }
            if draft.samples.len() >= SKILL_DRAFT_SAMPLES_MAX {
                return Err(PmError::Constraint("the dry run has enough samples"));
            }
            draft.samples.push(sample);
            transaction.execute(
                "UPDATE skill_drafts SET samples_json = ?2 WHERE id = ?1",
                params![draft_id, to_json(&draft.samples)?],
            )?;
            Ok(())
        })
    }

    /// Closes a running run. A run already closed is refused.
    pub fn finish_skill_run(
        &mut self,
        run_id: &str,
        outcome: SkillRunOutcome,
        summary: Option<&str>,
    ) -> Result<SkillRun, PmError> {
        if outcome == SkillRunOutcome::Skipped {
            return Err(PmError::Invalid("outcome"));
        }
        if summary.is_some_and(|text| !valid_label(text, SKILL_RUN_SUMMARY_MAX_CHARS)) {
            return Err(PmError::Invalid("summary"));
        }
        let now = self.now();
        self.write(|transaction| {
            let run = require_run(transaction, run_id)?;
            if !run.is_running() {
                return Err(PmError::Constraint("the run is already closed"));
            }
            close_run(transaction, &run, outcome, summary, now)?;
            require_run(transaction, run_id)
        })
    }

    /// Abandons running runs started before `now - deadline`; at startup
    /// with `u64::MAX`, every running run of an earlier daemon.
    pub fn abandon_stale_skill_runs(&mut self, now: u64) -> Result<Vec<SkillRun>, PmError> {
        let at = self.now();
        self.write(|transaction| {
            let mut abandoned = Vec::new();
            for run in running_skill_runs(transaction)? {
                if run
                    .started_at_epoch_ms
                    .saturating_add(SKILL_RUN_DEADLINE_MS)
                    <= now
                {
                    close_run(transaction, &run, SkillRunOutcome::Abandoned, None, at)?;
                    abandoned.push(require_run(transaction, &run.id)?);
                }
            }
            Ok(abandoned)
        })
    }

    pub fn skill_run(&self, run_id: &str) -> Result<Option<SkillRun>, PmError> {
        check_id(run_id, "runId")?;
        run_by_id(self.connection(), run_id)
    }

    /// A skill's runs, newest first.
    pub fn skill_runs(&self, skill_id: &str) -> Result<Vec<SkillRun>, PmError> {
        check_id(skill_id, "skillId")?;
        skill_runs(self.connection(), skill_id)
    }

    /// The PM's verdicts on a skill's suggestions, newest first.
    pub fn skill_feedback(&self, skill_id: &str) -> Result<Vec<SkillFeedback>, PmError> {
        check_id(skill_id, "skillId")?;
        require_skill(self.connection(), skill_id)?;
        skill_feedback(self.connection(), skill_id)
    }

    /// Notes an event for every enabled skill of the project waiting for
    /// it; the scheduler runs them on its next tick, so a burst of events
    /// starts one run.
    pub fn note_skill_event(
        &mut self,
        project_id: &str,
        event: SkillEvent,
    ) -> Result<u32, PmError> {
        check_id(project_id, "projectId")?;
        let now = self.now();
        self.write(|transaction| {
            let mut noted = 0;
            for record in project_skill_records(transaction, project_id)? {
                if !record.enabled || record.builtin.is_some() {
                    continue;
                }
                let manifest = skill_manifest(transaction, &record.id, record.version, false)?;
                if manifest.waits_for(event) && record.event_pending_at_epoch_ms.is_none() {
                    transaction.execute(
                        "UPDATE skills SET event_pending_at_epoch_ms = ?2 WHERE id = ?1",
                        params![record.id, now],
                    )?;
                    noted += 1;
                }
            }
            Ok(noted)
        })
    }

    /// The project's enabled skills due to run now, with why: an event
    /// noted since the last run, or a schedule whose interval has passed
    /// since the last run started. A running skill, a built-in one, and a
    /// skill backing off after a failure are not due.
    pub fn due_skills(
        &self,
        project_id: &str,
        now: u64,
    ) -> Result<Vec<(String, SkillRunTrigger)>, PmError> {
        check_id(project_id, "projectId")?;
        let connection = self.connection();
        let mut due = Vec::new();
        for record in project_skill_records(connection, project_id)? {
            if !record.enabled
                || record.builtin.is_some()
                || record.next_attempt_at_epoch_ms.is_some_and(|at| at > now)
            {
                continue;
            }
            if skill_is_running(connection, &record.id)? {
                continue;
            }
            if record.event_pending_at_epoch_ms.is_some() {
                due.push((record.id, SkillRunTrigger::Event));
                continue;
            }
            let manifest = skill_manifest(connection, &record.id, record.version, false)?;
            if let Some(minutes) = manifest.schedule_minutes() {
                let last = last_skill_run(connection, &record.id)?
                    .map_or(record.created_at_epoch_ms, |run| run.started_at_epoch_ms);
                if last.saturating_add(u64::from(minutes) * 60_000) <= now {
                    due.push((record.id, SkillRunTrigger::Schedule));
                }
            }
        }
        Ok(due)
    }

    /// Where a skill's next run starts reading: the start of its last run
    /// that reported or found nothing new; `None` before the first.
    pub fn skill_watermark(&self, skill_id: &str) -> Result<Option<u64>, PmError> {
        check_id(skill_id, "skillId")?;
        Ok(last_completed_skill_run(self.connection(), skill_id)?
            .map(|run| run.started_at_epoch_ms))
    }

    /// The tools any version of the skill approved.
    pub fn skill_approved_tools(&self, skill_id: &str) -> Result<Vec<String>, PmError> {
        check_id(skill_id, "skillId")?;
        approved_tools_ever(self.connection(), skill_id)
    }

    /// The creator's cached discovery report, with the sources fingerprint
    /// it was made for and when.
    pub fn skill_discovery(
        &self,
        project_id: &str,
    ) -> Result<Option<(serde_json::Value, String, u64)>, PmError> {
        check_id(project_id, "projectId")?;
        use rusqlite::OptionalExtension;
        Ok(self
            .connection()
            .query_row(
                "SELECT discovery_json, sources_key, refreshed_at_epoch_ms \
                 FROM skill_discovery_cache WHERE project_id = ?1",
                [project_id],
                |row| Ok((json_column(row, 0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?)
    }

    /// Replaces the cached discovery report. It holds no secret: the daemon
    /// redacts before it caches.
    pub fn cache_skill_discovery(
        &mut self,
        project_id: &str,
        discovery: &serde_json::Value,
        sources_key: &str,
    ) -> Result<(), PmError> {
        check_id(project_id, "projectId")?;
        let json = to_json(discovery)?;
        if json.len() > SKILL_DISCOVERY_MAX_BYTES {
            return Err(PmError::Invalid("discovery"));
        }
        if !valid_label(sources_key, 128) {
            return Err(PmError::Invalid("sourcesKey"));
        }
        let now = self.now();
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO skill_discovery_cache (project_id, discovery_json, sources_key, \
                     refreshed_at_epoch_ms) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT (project_id) DO UPDATE SET discovery_json = excluded.discovery_json, \
                     sources_key = excluded.sources_key, \
                     refreshed_at_epoch_ms = excluded.refreshed_at_epoch_ms",
                params![project_id, json, sources_key, now],
            )?;
            Ok(())
        })
    }
}
