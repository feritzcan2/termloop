pub const PLAYBOOK_EVALUATIONS_PER_PROJECT_MAX: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookEvaluationOutcome {
    InProgress,
    Passed,
    Waiting,
    Blocked,
    Failed,
    Interrupted,
    /// The evaluator observed the step's send-back condition and the Task
    /// returned to an earlier step.
    Rewound,
}

/// Bounded, user-visible receipts for Playbook evaluators, independent of temporary Sessions.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookEvaluationRecord {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub task_title: String,
    pub milestone_id: String,
    pub milestone_title: String,
    /// The Task Agent this evaluator was forked from. `None` for a fresh
    /// evaluator started because the Task had no Agent to fork.
    pub source_session_id: Option<String>,
    pub source_name: Option<String>,
    pub session_id: String,
    pub agent_id: String,
    pub model: String,
    pub permission: String,
    pub started_at_epoch_ms: u64,
    pub finished_at_epoch_ms: Option<u64>,
    pub outcome: PlaybookEvaluationOutcome,
    pub evidence: String,
    /// The Task Agent's own unverified report about this step, as it stood
    /// when the check started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_report: Option<PlaybookEvaluationAgentReport>,
    /// The evaluator's per-criterion findings behind its verdict.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub criteria: Vec<PlaybookCriterionCheck>,
    /// The pull request the step passed with, when it follows one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_number: Option<u64>,
    /// The earlier step a `Rewound` check sent the Task back to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewound_to: Option<PlaybookEvaluationStepRef>,
}

pub const PLAYBOOK_CRITERIA_MAX: usize = 12;
pub const PLAYBOOK_CRITERION_MAX_BYTES: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookAgentReportStatus {
    Reached,
    Blocked,
}

/// What the Task Agent claimed, kept beside the check that weighed it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookEvaluationAgentReport {
    pub status: PlaybookAgentReportStatus,
    pub evidence: String,
    pub reported_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookCriterionStatus {
    Met,
    Unmet,
    Unknown,
}

/// One completion criterion the evaluator checked, and what it found.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookCriterionCheck {
    pub criterion: String,
    pub status: PlaybookCriterionStatus,
    pub evidence: String,
}

/// A step named by id and by the title it had when recorded.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookEvaluationStepRef {
    pub milestone_id: String,
    pub title: String,
}

impl PlaybookEvaluationAgentReport {
    pub fn is_valid(&self) -> bool {
        !self.evidence.trim().is_empty()
            && self.evidence.len() <= crate::PLAYBOOK_EVIDENCE_MAX_BYTES
    }
}

impl PlaybookCriterionCheck {
    pub fn is_valid(&self) -> bool {
        !self.criterion.trim().is_empty()
            && self.criterion.len() <= PLAYBOOK_CRITERION_MAX_BYTES
            && !self.evidence.trim().is_empty()
            && self.evidence.len() <= crate::PLAYBOOK_EVIDENCE_MAX_BYTES
    }
}

/// Every criterion is well formed and the list stays bounded.
pub fn playbook_criteria_are_valid(criteria: &[PlaybookCriterionCheck]) -> bool {
    criteria.len() <= PLAYBOOK_CRITERIA_MAX && criteria.iter().all(PlaybookCriterionCheck::is_valid)
}

impl PlaybookEvaluationStepRef {
    pub fn is_valid(&self) -> bool {
        !self.milestone_id.trim().is_empty()
            && self.milestone_id.len() <= 128
            && !self.title.trim().is_empty()
            && self.title.len() <= 4096
    }
}

impl PlaybookEvaluationRecord {
    /// The fields a check sets when it finishes, applied to a running copy.
    pub fn finished_with(&self, finished: &Self) -> Self {
        Self {
            outcome: finished.outcome,
            evidence: finished.evidence.clone(),
            finished_at_epoch_ms: finished.finished_at_epoch_ms,
            criteria: finished.criteria.clone(),
            pull_request_number: finished.pull_request_number,
            rewound_to: finished.rewound_to.clone(),
            ..self.clone()
        }
    }

    pub fn is_valid(&self) -> bool {
        let bounded = |text: &str, max| !text.trim().is_empty() && text.chars().count() <= max;
        bounded(&self.id, 128)
            && [&self.project_id, &self.task_id, &self.session_id]
                .iter()
                .all(|id| bounded(id, 64))
            && match (&self.source_session_id, &self.source_name) {
                (Some(id), Some(name)) => bounded(id, 64) && bounded(name, 4096),
                (None, None) => true,
                _ => false,
            }
            && bounded(&self.milestone_id, 128)
            && [&self.task_title, &self.milestone_title]
                .iter()
                .all(|text| bounded(text, 4096))
            && matches!(self.agent_id.as_str(), "codex" | "claude")
            && bounded(&self.model, 80)
            && matches!(
                self.permission.as_str(),
                "default" | "plan" | "acceptEdits" | "bypassPermissions"
            )
            && self.evidence.len() <= crate::PLAYBOOK_EVIDENCE_MAX_BYTES
            && self
                .agent_report
                .as_ref()
                .is_none_or(PlaybookEvaluationAgentReport::is_valid)
            && playbook_criteria_are_valid(&self.criteria)
            && self.pull_request_number.is_none_or(|number| number > 0)
            // Only a send-back names where it sent the Task.
            && match &self.rewound_to {
                None => true,
                Some(step) => {
                    self.outcome == PlaybookEvaluationOutcome::Rewound && step.is_valid()
                }
            }
            && match self.outcome {
                PlaybookEvaluationOutcome::InProgress => {
                    self.finished_at_epoch_ms.is_none()
                        && self.evidence.is_empty()
                        && self.criteria.is_empty()
                        && self.pull_request_number.is_none()
                }
                _ => {
                    self.finished_at_epoch_ms
                        .is_some_and(|time| time >= self.started_at_epoch_ms)
                        && !self.evidence.trim().is_empty()
                }
            }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running() -> PlaybookEvaluationRecord {
        PlaybookEvaluationRecord {
            id: "check-1".into(),
            project_id: "project-1".into(),
            task_id: "task-1".into(),
            task_title: "Task".into(),
            milestone_id: "review".into(),
            milestone_title: "Review".into(),
            source_session_id: None,
            source_name: None,
            session_id: "session-1".into(),
            agent_id: "claude".into(),
            model: "default".into(),
            permission: "default".into(),
            started_at_epoch_ms: 10,
            finished_at_epoch_ms: None,
            outcome: PlaybookEvaluationOutcome::InProgress,
            evidence: String::new(),
            agent_report: Some(PlaybookEvaluationAgentReport {
                status: PlaybookAgentReportStatus::Reached,
                evidence: "Opened PR #4.".into(),
                reported_at_epoch_ms: 5,
            }),
            criteria: vec![],
            pull_request_number: None,
            rewound_to: None,
        }
    }

    fn criterion(status: PlaybookCriterionStatus) -> PlaybookCriterionCheck {
        PlaybookCriterionCheck {
            criterion: "Tests pass".into(),
            status,
            evidence: "CI run 42 green.".into(),
        }
    }

    #[test]
    fn a_running_check_carries_its_agent_report_but_no_findings() {
        assert!(running().is_valid());
        let mut early = running();
        early.criteria = vec![criterion(PlaybookCriterionStatus::Met)];
        assert!(!early.is_valid());
    }

    #[test]
    fn a_finished_check_bounds_its_criteria() {
        let mut finished = running();
        finished.outcome = PlaybookEvaluationOutcome::Passed;
        finished.finished_at_epoch_ms = Some(20);
        finished.evidence = "Merged.".into();
        finished.criteria = vec![criterion(PlaybookCriterionStatus::Met); PLAYBOOK_CRITERIA_MAX];
        finished.pull_request_number = Some(4);
        assert!(finished.is_valid());
        finished
            .criteria
            .push(criterion(PlaybookCriterionStatus::Unknown));
        assert!(!finished.is_valid());
        finished.criteria = vec![PlaybookCriterionCheck {
            criterion: "x".repeat(PLAYBOOK_CRITERION_MAX_BYTES + 1),
            ..criterion(PlaybookCriterionStatus::Unmet)
        }];
        assert!(!finished.is_valid());
    }

    #[test]
    fn only_a_send_back_names_its_target_step() {
        let target = PlaybookEvaluationStepRef {
            milestone_id: "build".into(),
            title: "Build".into(),
        };
        let mut finished = running();
        finished.finished_at_epoch_ms = Some(20);
        finished.evidence = "New PR #5 opened.".into();
        finished.rewound_to = Some(target);
        finished.outcome = PlaybookEvaluationOutcome::Waiting;
        assert!(!finished.is_valid());
        finished.outcome = PlaybookEvaluationOutcome::Rewound;
        assert!(finished.is_valid());
    }

    #[test]
    fn finishing_changes_only_the_result_fields() {
        let start = running();
        let mut reported = start.clone();
        reported.outcome = PlaybookEvaluationOutcome::Passed;
        reported.finished_at_epoch_ms = Some(30);
        reported.evidence = "Done.".into();
        reported.criteria = vec![criterion(PlaybookCriterionStatus::Met)];
        reported.agent_report = None;
        reported.task_title = "Renamed".into();
        let applied = start.finished_with(&reported);
        assert_eq!(applied.agent_report, start.agent_report);
        assert_eq!(applied.task_title, "Task");
        assert_eq!(applied.criteria, reported.criteria);
    }
}
