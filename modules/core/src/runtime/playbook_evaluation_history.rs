use crate::{CoreError, CoreRuntime, required_string, store_error};
use serde_json::{Value, json};
use termloop_domain::{
    CompanionMessageAuthor, CompanionMessageKind, PlaybookEvaluationOutcome as Outcome,
    PlaybookEvaluationRecord, PlaybookStepEvaluator, PlaybookStepProgress, PlaybookStepVerdict,
};

/// A Task's timeline returns at most this many newest entries. Every source
/// is already bounded; this keeps one read and its rendering small no matter
/// how long the Task has been running.
pub const PLAYBOOK_TASK_TIMELINE_MAX: usize = 100;
/// A Steward update can be long; the timeline shows its opening.
const PLAYBOOK_TASK_TIMELINE_STEWARD_MAX_BYTES: usize = 2000;

impl CoreRuntime {
    pub(crate) fn playbook_evaluation_history(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let mut entries = self
            .store
            .playbook_evaluations()
            .iter()
            .filter(|record| record.project_id == project_id)
            .collect::<Vec<_>>();
        entries.sort_by(|a, b| (b.started_at_epoch_ms, &b.id).cmp(&(a.started_at_epoch_ms, &a.id)));
        Ok(
            json!({"entries": entries, "retentionLimit": termloop_domain::PLAYBOOK_EVALUATIONS_PER_PROJECT_MAX, "stateRevision": self.store.revision()}),
        )
    }

    /// One Task's Playbook story, newest first: evaluator checks with what the
    /// Task Agent claimed, the verdicts TermLoop or the user decided without
    /// an evaluator, the Agent's current unanswered claim, and what the
    /// Steward did about this Task. A projection of bounded current state;
    /// nothing here is stored as Task history.
    pub(crate) fn playbook_task_timeline(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        let task_id = required_string(&params, "taskId")?;
        if !self
            .store
            .tasks()
            .iter()
            .any(|task| task.id == task_id && task.project_id == project_id)
        {
            return Err(CoreError::NotFound);
        }
        let playbook = self.store.playbook_for_project(&project_id);
        let title_of = |milestone_id: &str| -> Option<String> {
            let playbook = playbook?;
            playbook
                .milestones
                .iter()
                .chain(
                    playbook
                        .saved_pipelines
                        .iter()
                        .flat_map(|p| p.milestones.iter()),
                )
                .find(|milestone| milestone.id == milestone_id)
                .map(|milestone| milestone.title.clone())
        };
        let mut entries: Vec<(u64, Value)> = Vec::new();
        let evaluations = self
            .store
            .playbook_evaluations()
            .iter()
            .filter(|record| record.project_id == project_id && record.task_id == task_id)
            .collect::<Vec<_>>();
        for record in &evaluations {
            let at = record
                .finished_at_epoch_ms
                .unwrap_or(record.started_at_epoch_ms);
            entries.push((
                at,
                json!({
                    "kind": "evaluation",
                    "atEpochMs": at,
                    "milestoneId": record.milestone_id,
                    "milestoneTitle": record.milestone_title,
                    "evaluation": record,
                }),
            ));
        }
        // An evaluator's own answers are its receipts above; these are the
        // verdicts nobody ran an evaluator for.
        if let Some((_, answers)) = self.task_playbook_position(&task_id) {
            for answer in answers
                .iter()
                .filter(|answer| answer.evaluator != PlaybookStepEvaluator::Routine)
            {
                entries.push((
                    answer.decided_at_epoch_ms,
                    json!({
                        "kind": "decision",
                        "atEpochMs": answer.decided_at_epoch_ms,
                        "milestoneId": answer.milestone_id,
                        "milestoneTitle": title_of(&answer.milestone_id),
                        "decision": {
                            "verdict": answer.verdict,
                            "evaluator": answer.evaluator,
                            "evidence": answer.evidence,
                            "pullRequestNumber": answer.pull_request_number,
                        },
                    }),
                ));
            }
        }
        if let Some(report) = self.agent_step_report_for_timeline(&task_id) {
            let reported_at = report["reportedAtEpochMs"].as_u64().unwrap_or_default();
            // A claim a check already carried is shown inside that check.
            let carried = evaluations.iter().any(|record| {
                record
                    .agent_report
                    .as_ref()
                    .is_some_and(|carried| carried.reported_at_epoch_ms == reported_at)
            });
            if !carried {
                let milestone_id = report["milestoneId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                entries.push((
                    reported_at,
                    json!({
                        "kind": "agentReport",
                        "atEpochMs": reported_at,
                        "milestoneTitle": title_of(&milestone_id),
                        "milestoneId": milestone_id,
                        "agentReport": {
                            "sessionId": report["sessionId"],
                            "status": report["status"],
                            "evidence": report["evidence"],
                        },
                    }),
                ));
            }
        }
        for message in self.store.companion_messages().iter().filter(|message| {
            message.project_id == project_id
                && message.author == CompanionMessageAuthor::Steward
                && !matches!(message.kind, CompanionMessageKind::Reply)
                && message
                    .refs
                    .as_ref()
                    .is_some_and(|refs| refs.task_id.as_deref() == Some(task_id.as_str()))
        }) {
            entries.push((
                message.created_at_epoch_ms,
                json!({
                    "kind": "steward",
                    "atEpochMs": message.created_at_epoch_ms,
                    "milestoneId": null,
                    "milestoneTitle": null,
                    "steward": {
                        "messageId": message.id,
                        "messageKind": message.kind,
                        "content": crate::companion_integrations::steward::bounded_excerpt(
                            &message.content,
                            PLAYBOOK_TASK_TIMELINE_STEWARD_MAX_BYTES,
                        ),
                    },
                }),
            ));
        }
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        let truncated = entries.len() > PLAYBOOK_TASK_TIMELINE_MAX;
        entries.truncate(PLAYBOOK_TASK_TIMELINE_MAX);
        Ok(json!({
            "taskId": task_id,
            "entries": entries.into_iter().map(|(_, entry)| entry).collect::<Vec<_>>(),
            "truncated": truncated,
            "stateRevision": self.store.revision(),
        }))
    }

    pub(crate) fn completed_evaluation_record(
        &self,
        check_id: &str,
        answer: &PlaybookStepProgress,
    ) -> Option<PlaybookEvaluationRecord> {
        let mut record = self
            .store
            .playbook_evaluations()
            .iter()
            .find(|r| r.id == check_id && r.outcome == Outcome::InProgress)?
            .clone();
        record.outcome = match answer.verdict {
            PlaybookStepVerdict::Passed => Outcome::Passed,
            PlaybookStepVerdict::Waiting => Outcome::Waiting,
            PlaybookStepVerdict::Blocked => Outcome::Blocked,
        };
        record.finished_at_epoch_ms = Some(answer.decided_at_epoch_ms);
        record.evidence = answer.evidence.clone();
        record.pull_request_number = answer.pull_request_number;
        record.criteria = self
            .playbook_evaluation
            .evaluations
            .get(check_id)
            .map(|evaluation| evaluation.criteria.clone())
            .unwrap_or_default();
        Some(record)
    }

    pub(crate) fn interrupt_evaluation_record(
        &mut self,
        check_id: &str,
        outcome: Outcome,
        evidence: &str,
    ) -> Result<(), CoreError> {
        let Some(mut record) = self
            .store
            .playbook_evaluations()
            .iter()
            .find(|r| r.id == check_id && r.outcome == Outcome::InProgress)
            .cloned()
        else {
            return Ok(());
        };
        record.outcome = outcome;
        record.evidence = evidence.into();
        record.finished_at_epoch_ms =
            Some(termloop_platform::current_epoch_ms().max(record.started_at_epoch_ms));
        self.store
            .finish_playbook_evaluation(&self.write_authority, record)
            .map_err(store_error)
    }
}
