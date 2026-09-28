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
}

/// Bounded, user-visible receipts for Playbook forks, independent of temporary Sessions.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaybookEvaluationRecord {
    pub id: String,
    pub project_id: String,
    pub task_id: String,
    pub task_title: String,
    pub milestone_id: String,
    pub milestone_title: String,
    pub source_session_id: String,
    pub source_name: String,
    pub session_id: String,
    pub agent_id: String,
    pub model: String,
    pub permission: String,
    pub started_at_epoch_ms: u64,
    pub finished_at_epoch_ms: Option<u64>,
    pub outcome: PlaybookEvaluationOutcome,
    pub evidence: String,
}

impl PlaybookEvaluationRecord {
    pub fn is_valid(&self) -> bool {
        let bounded = |text: &str, max| !text.trim().is_empty() && text.chars().count() <= max;
        bounded(&self.id, 128)
            && [
                &self.project_id,
                &self.task_id,
                &self.source_session_id,
                &self.session_id,
            ]
            .iter()
            .all(|id| bounded(id, 64))
            && bounded(&self.milestone_id, 128)
            && [&self.task_title, &self.milestone_title, &self.source_name]
                .iter()
                .all(|text| bounded(text, 4096))
            && matches!(self.agent_id.as_str(), "codex" | "claude")
            && bounded(&self.model, 80)
            && matches!(
                self.permission.as_str(),
                "default" | "plan" | "acceptEdits" | "bypassPermissions"
            )
            && self.evidence.len() <= crate::PLAYBOOK_EVIDENCE_MAX_BYTES
            && match self.outcome {
                PlaybookEvaluationOutcome::InProgress => {
                    self.finished_at_epoch_ms.is_none() && self.evidence.is_empty()
                }
                _ => {
                    self.finished_at_epoch_ms
                        .is_some_and(|time| time >= self.started_at_epoch_ms)
                        && !self.evidence.trim().is_empty()
                }
            }
    }
}
