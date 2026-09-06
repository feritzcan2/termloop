//! Pure Project Companion transcript values.

pub const COMPANION_MESSAGE_MAX_BYTES: usize = 48 * 1024;
pub const COMPANION_TRANSCRIPT_SOFT_BYTES: usize = 40 * 1024 * 1024;
pub const COMPANION_TRANSCRIPT_HARD_BYTES: usize = 50 * 1024 * 1024;
pub const COMPANION_TRANSCRIPT_HARD_MESSAGES: usize = 10_000;
pub const COMPANION_TRANSCRIPT_SOFT_MESSAGES: usize = 8_000;
pub const TRACKER_NAME_MAX_BYTES: usize = 80;
pub const STEWARD_SYSTEM_PROMPT_MAX_BYTES: usize = 16 * 1024;
// Legacy Playbook snapshots stored an 8 KiB verification prompt and a separate
// applicability condition. The current completion rule combines both, so keep
// enough room to migrate every formerly valid single-step rule without loss.
pub const TRACKER_PROMPT_MAX_BYTES: usize = 9 * 1024;
pub const TRACKER_SCHEDULE_MIN_SECONDS: u64 = 60;
pub const TRACKER_SCHEDULE_MAX_SECONDS: u64 = 24 * 60 * 60;
pub const TRACKER_REPORT_MAX_BYTES: usize = 48 * 1024;
pub const TRACKER_REPORT_SOURCE_REFS_MAX: usize = 16;
pub const TRACKER_REPORT_SOURCE_REF_MAX_BYTES: usize = 512;
pub const TRACKER_REPORTS_PER_PROJECT_MAX: usize = 128;
pub const ROUTINE_CONTEXT_MAX_BYTES: usize = 32 * 1024;
pub const ROUTINE_RECENT_SOURCE_KEYS_MAX: usize = 128;
pub const ROUTINE_SOURCE_KEY_MAX_BYTES: usize = 256;
pub const ROUTINE_RELATED_TASKS_MAX: usize = 16;
pub const ROUTINE_PENDING_FINDINGS_MAX: usize = 16;
pub const ROUTINE_FINDING_SUMMARY_MAX_BYTES: usize = 4 * 1024;
pub const ROUTINE_FINDING_EVIDENCE_MAX_BYTES: usize = 2 * 1024;

const fn initial_routine_context_revision() -> u64 {
    1
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanionMessageAuthor {
    User,
    Steward,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompanionMessageKind {
    #[default]
    Reply,
    /// A factual current-state or movement update that asks nothing of the user.
    Update,
    /// Current work needs the user's own action, not approval for a Steward action.
    Attention,
    /// Required evidence, access, or configuration could not be established.
    Problem,
    Suggestion,
    /// A user-authored receipt accepting the current Steward suggestion.
    Acceptance,
    Action,
    Proposal,
    Approval,
    Decline,
}

impl CompanionMessageKind {
    pub fn is_reply(&self) -> bool {
        *self == Self::Reply
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompanionMessageInputMode {
    #[default]
    Text,
    Voice,
}

impl CompanionMessageInputMode {
    pub fn is_text(&self) -> bool {
        *self == Self::Text
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessageRefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(
        default,
        alias = "actionCandidateId",
        skip_serializing_if = "Option::is_none"
    )]
    pub routine_finding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routine_finding_ids: Vec<String>,
}

impl CompanionMessageRefs {
    pub const ID_MAX_BYTES: usize = 256;

    pub fn references_routine_finding(&self, finding_id: &str) -> bool {
        self.routine_finding_id.as_deref() == Some(finding_id)
            || self
                .routine_finding_ids
                .iter()
                .any(|candidate| candidate == finding_id)
    }

    pub fn all_routine_finding_ids(&self) -> impl Iterator<Item = &str> {
        self.routine_finding_id
            .iter()
            .map(String::as_str)
            .chain(self.routine_finding_ids.iter().map(String::as_str))
    }

    pub fn is_valid(&self) -> bool {
        let values = [
            self.task_id.as_deref(),
            self.session_id.as_deref(),
            self.routine_finding_id.as_deref(),
        ];
        values
            .iter()
            .flatten()
            .all(|value| !value.trim().is_empty() && value.len() <= Self::ID_MAX_BYTES)
            && self.routine_finding_ids.len() <= ROUTINE_PENDING_FINDINGS_MAX
            && self
                .routine_finding_ids
                .iter()
                .enumerate()
                .all(|(index, value)| {
                    !value.trim().is_empty()
                        && value.len() <= Self::ID_MAX_BYTES
                        && self.routine_finding_id.as_ref() != Some(value)
                        && !self.routine_finding_ids[index + 1..].contains(value)
                })
            && (values.iter().any(Option::is_some) || !self.routine_finding_ids.is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StewardAgentId {
    Claude,
    Codex,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StewardConfiguration {
    pub project_id: String,
    pub agent_id: StewardAgentId,
    #[serde(default = "default_assistant_launch_option")]
    pub model: String,
    #[serde(default = "default_assistant_launch_option")]
    pub permission: String,
    #[serde(default = "default_assistant_launch_option")]
    pub reasoning: String,
    pub enabled: bool,
    /// One current Project-scoped role prompt. An empty migrated value means
    /// invocation's visible built-in default until the user saves it.
    #[serde(default)]
    pub system_prompt: String,
    pub executor_session_id: Option<String>,
    pub generation: u64,
    pub updated_at_epoch_ms: u64,
}

fn default_assistant_launch_option() -> String {
    "default".to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StewardConversationRef {
    pub project_id: String,
    pub resume_ref: crate::ResumeRef,
}

impl StewardConversationRef {
    pub fn is_valid(&self) -> bool {
        !self.project_id.trim().is_empty() && self.resume_ref.validate()
    }
}

/// How a Routine's runs are started. A scheduled Routine keeps its own cadence
/// and brings work in; an on-demand Routine runs only when a pipeline step asks
/// it to check one Task, so `schedule_interval_seconds` carries no cadence for
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RoutineTriggerMode {
    Schedule,
    OnDemand,
}

impl Default for RoutineTriggerMode {
    fn default() -> Self {
        Self::Schedule
    }
}

impl RoutineTriggerMode {
    pub const fn is_scheduled(self) -> bool {
        matches!(self, Self::Schedule)
    }
}

/// Whether a scheduled Routine's new factual findings should be reviewed by the
/// Steward. Verification never recommends or selects the resulting action.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutineActionHandling {
    #[default]
    Off,
    Ask,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRoutineFinding {
    pub id: String,
    #[serde(alias = "dedupeKey")]
    pub source_key: String,
    pub routine_generation: u64,
    pub summary: String,
    pub evidence: String,
    #[serde(default)]
    pub source_references: Vec<String>,
    #[serde(default)]
    pub related_task_ids: Vec<String>,
    pub created_at_epoch_ms: u64,
}

impl PendingRoutineFinding {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && self.id.len() <= CompanionMessageRefs::ID_MAX_BYTES
            && !self.source_key.trim().is_empty()
            && self.source_key.len() <= ROUTINE_SOURCE_KEY_MAX_BYTES
            && self.routine_generation > 0
            && !self.summary.trim().is_empty()
            && self.summary.len() <= ROUTINE_FINDING_SUMMARY_MAX_BYTES
            && !self.evidence.trim().is_empty()
            && self.evidence.len() <= ROUTINE_FINDING_EVIDENCE_MAX_BYTES
            && bounded_unique_values(
                &self.source_references,
                TRACKER_REPORT_SOURCE_REFS_MAX,
                TRACKER_REPORT_SOURCE_REF_MAX_BYTES,
            )
            && bounded_unique_values(
                &self.related_task_ids,
                ROUTINE_RELATED_TASKS_MAX,
                CompanionMessageRefs::ID_MAX_BYTES,
            )
            && self.created_at_epoch_ms > 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerConfiguration {
    pub id: String,
    pub project_id: String,
    #[serde(default)]
    pub trigger_mode: RoutineTriggerMode,
    pub name: String,
    /// User-visible instructions delivered to the Steward for every check.
    #[serde(default)]
    pub prompt: String,
    /// User-visible response guidance delivered only to the Steward when it
    /// reviews a new scheduled finding or a materially new waiting verdict
    /// from this Routine.
    #[serde(default)]
    pub steward_instructions: String,
    pub enabled: bool,
    pub schedule_interval_seconds: u64,
    pub generation: u64,
    /// One user-visible rolling Markdown context. This is replaced, never appended as history.
    #[serde(default)]
    pub context_markdown: String,
    #[serde(default = "initial_routine_context_revision")]
    pub context_revision: u64,
    /// Current bounded deduplication checkpoint, oldest to newest.
    #[serde(default)]
    pub recent_source_keys: Vec<String>,
    /// Current same-Project Task associations, not historical findings.
    #[serde(default)]
    pub related_task_ids: Vec<String>,
    /// Controls whether novel factual findings may wake the Steward.
    #[serde(default)]
    pub action_handling: RoutineActionHandling,
    /// Current unresolved factual findings awaiting Steward review. This is
    /// current work, not execution history.
    #[serde(default, alias = "pendingActionCandidates")]
    pub pending_routine_findings: Vec<PendingRoutineFinding>,
    /// The previous completed check's server-owned claim time used for overlap scans.
    #[serde(default)]
    pub last_check_started_at_epoch_ms: Option<u64>,
    /// Current last attempt only. This is overwritten, never appended as run history.
    #[serde(default)]
    pub last_attempt_at_epoch_ms: Option<u64>,
    pub last_successful_report_at_epoch_ms: Option<u64>,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackerReportKind {
    Success,
    Problem,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerReport {
    pub id: String,
    pub project_id: String,
    pub routine_id: String,
    pub check_id: String,
    pub generation: u64,
    pub kind: TrackerReportKind,
    pub message: String,
    pub source_references: Vec<String>,
    #[serde(default)]
    pub related_task_ids: Vec<String>,
    pub created_at_epoch_ms: u64,
}

impl TrackerReport {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.project_id.trim().is_empty()
            && !self.routine_id.trim().is_empty()
            && !self.check_id.trim().is_empty()
            && self.generation > 0
            && !self.message.trim().is_empty()
            && self.message.len() <= TRACKER_REPORT_MAX_BYTES
            && self.source_references.len() <= TRACKER_REPORT_SOURCE_REFS_MAX
            && bounded_unique_values(
                &self.related_task_ids,
                ROUTINE_RELATED_TASKS_MAX,
                crate::CompanionMessageRefs::ID_MAX_BYTES,
            )
            && self
                .source_references
                .iter()
                .enumerate()
                .all(|(index, reference)| {
                    !reference.trim().is_empty()
                        && reference.len() <= TRACKER_REPORT_SOURCE_REF_MAX_BYTES
                        && !self.source_references[index + 1..].contains(reference)
                })
    }
}

impl TrackerConfiguration {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.project_id.trim().is_empty()
            && !self.name.trim().is_empty()
            && self.name.len() <= TRACKER_NAME_MAX_BYTES
            && !self.prompt.trim().is_empty()
            && self.prompt.len() <= TRACKER_PROMPT_MAX_BYTES
            && self.steward_instructions.len() <= TRACKER_PROMPT_MAX_BYTES
            && self.context_markdown.len() <= ROUTINE_CONTEXT_MAX_BYTES
            && self.context_revision > 0
            && bounded_unique_values(
                &self.recent_source_keys,
                ROUTINE_RECENT_SOURCE_KEYS_MAX,
                ROUTINE_SOURCE_KEY_MAX_BYTES,
            )
            && bounded_unique_values(
                &self.related_task_ids,
                ROUTINE_RELATED_TASKS_MAX,
                crate::CompanionMessageRefs::ID_MAX_BYTES,
            )
            && self.pending_routine_findings.len() <= ROUTINE_PENDING_FINDINGS_MAX
            && self
                .pending_routine_findings
                .iter()
                .enumerate()
                .all(|(index, finding)| {
                    finding.is_valid()
                        && finding.routine_generation == self.generation
                        && !self.pending_routine_findings[index + 1..]
                            .iter()
                            .any(|other| {
                                other.id == finding.id || other.source_key == finding.source_key
                            })
                })
            && (self.action_handling != RoutineActionHandling::Off
                || self.pending_routine_findings.is_empty())
            && (TRACKER_SCHEDULE_MIN_SECONDS..=TRACKER_SCHEDULE_MAX_SECONDS)
                .contains(&self.schedule_interval_seconds)
            && self.generation > 0
    }
}

fn bounded_unique_values(values: &[String], max_items: usize, max_bytes: usize) -> bool {
    values.len() <= max_items
        && values.iter().enumerate().all(|(index, value)| {
            !value.trim().is_empty()
                && value.len() <= max_bytes
                && !values[index + 1..].contains(value)
        })
}

impl StewardConfiguration {
    pub fn is_valid(&self) -> bool {
        !self.project_id.trim().is_empty()
            && self.generation > 0
            && valid_assistant_launch_option(&self.model)
            && valid_assistant_permission(&self.permission)
            && valid_assistant_launch_option(&self.reasoning)
            && self.system_prompt.len() <= STEWARD_SYSTEM_PROMPT_MAX_BYTES
            && (self.system_prompt.is_empty() || !self.system_prompt.trim().is_empty())
    }
}

fn valid_assistant_launch_option(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
}

fn valid_assistant_permission(value: &str) -> bool {
    matches!(
        value,
        "default" | "acceptEdits" | "plan" | "bypassPermissions"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMessage {
    pub id: String,
    pub project_id: String,
    pub sequence: u64,
    pub author: CompanionMessageAuthor,
    #[serde(default, skip_serializing_if = "CompanionMessageKind::is_reply")]
    pub kind: CompanionMessageKind,
    #[serde(default, skip_serializing_if = "CompanionMessageInputMode::is_text")]
    pub input_mode: CompanionMessageInputMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refs: Option<CompanionMessageRefs>,
    pub content: String,
    pub created_at_epoch_ms: u64,
}

impl CompanionMessage {
    pub fn content_bytes(&self) -> usize {
        self.content.len()
    }

    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && !self.project_id.trim().is_empty()
            && self.sequence > 0
            && self
                .refs
                .as_ref()
                .is_none_or(CompanionMessageRefs::is_valid)
            && !self.content.trim().is_empty()
            && self.content_bytes() <= COMPANION_MESSAGE_MAX_BYTES
    }
}

pub fn companion_transcript_bytes<'a>(
    messages: impl IntoIterator<Item = &'a CompanionMessage>,
) -> usize {
    messages.into_iter().fold(0usize, |total, message| {
        total.saturating_add(message.content_bytes())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_quota_counts_exact_utf8_content_bytes() {
        let message = CompanionMessage {
            id: "message-1".into(),
            project_id: "project-1".into(),
            sequence: 1,
            author: CompanionMessageAuthor::User,
            kind: CompanionMessageKind::Reply,
            input_mode: CompanionMessageInputMode::Text,
            refs: None,
            content: "ş".into(),
            created_at_epoch_ms: 1,
        };
        assert!(message.is_valid());
        assert_eq!(message.content_bytes(), 2);
        assert_eq!(companion_transcript_bytes([&message]), 2);
    }

    #[test]
    fn empty_and_oversize_messages_are_invalid() {
        let mut message = CompanionMessage {
            id: "message-1".into(),
            project_id: "project-1".into(),
            sequence: 1,
            author: CompanionMessageAuthor::Steward,
            kind: CompanionMessageKind::Suggestion,
            input_mode: CompanionMessageInputMode::Text,
            refs: None,
            content: " ".into(),
            created_at_epoch_ms: 1,
        };
        assert!(!message.is_valid());
        message.content = "x".repeat(COMPANION_MESSAGE_MAX_BYTES + 1);
        assert!(!message.is_valid());
    }

    #[test]
    fn message_references_are_bounded_and_nonempty() {
        assert!(
            !CompanionMessageRefs {
                task_id: None,
                session_id: None,
                routine_finding_id: None,
                routine_finding_ids: vec![],
            }
            .is_valid()
        );
        assert!(
            !CompanionMessageRefs {
                task_id: Some(" ".into()),
                session_id: None,
                routine_finding_id: None,
                routine_finding_ids: vec![],
            }
            .is_valid()
        );
        assert!(
            CompanionMessageRefs {
                task_id: Some("task-1".into()),
                session_id: Some("session-1".into()),
                routine_finding_id: None,
                routine_finding_ids: vec![],
            }
            .is_valid()
        );
        assert!(
            CompanionMessageRefs {
                task_id: None,
                session_id: None,
                routine_finding_id: None,
                routine_finding_ids: vec!["finding-1".into(), "finding-2".into()],
            }
            .is_valid()
        );
        assert!(
            !CompanionMessageRefs {
                task_id: None,
                session_id: None,
                routine_finding_id: Some("finding-1".into()),
                routine_finding_ids: vec!["finding-1".into()],
            }
            .is_valid()
        );
    }

    #[test]
    fn tracker_configuration_is_bounded_current_state() {
        let mut configuration = TrackerConfiguration {
            id: "tracker-1".into(),
            project_id: "project-1".into(),
            trigger_mode: RoutineTriggerMode::Schedule,
            name: "Slack actions".into(),
            prompt: "Use the Slack connector to inspect #product and report to the Steward.".into(),
            steward_instructions: String::new(),
            enabled: false,
            schedule_interval_seconds: 300,
            generation: 1,
            context_markdown: String::new(),
            context_revision: 1,
            recent_source_keys: vec![],
            related_task_ids: vec![],
            action_handling: RoutineActionHandling::Off,
            pending_routine_findings: vec![],
            last_check_started_at_epoch_ms: None,
            last_attempt_at_epoch_ms: None,
            last_successful_report_at_epoch_ms: None,
            updated_at_epoch_ms: 1,
        };
        assert!(configuration.is_valid());
        configuration.action_handling = RoutineActionHandling::Ask;
        configuration.pending_routine_findings = vec![PendingRoutineFinding {
            id: "finding-1".into(),
            source_key: "slack:C123:review:42".into(),
            routine_generation: 1,
            summary: "No matching review request is visible.".into(),
            evidence: "The inspected channel contains no message for PR 42.".into(),
            source_references: vec!["slack://C123".into()],
            related_task_ids: vec![],
            created_at_epoch_ms: 1,
        }];
        assert!(configuration.is_valid());
        configuration.action_handling = RoutineActionHandling::Off;
        assert!(!configuration.is_valid());
        configuration.action_handling = RoutineActionHandling::Ask;
        configuration.prompt = "x".repeat(TRACKER_PROMPT_MAX_BYTES + 1);
        assert!(!configuration.is_valid());
    }

    #[test]
    fn on_demand_routine_may_hold_one_current_waiting_finding() {
        let configuration = TrackerConfiguration {
            id: "routine-step".into(),
            project_id: "project-1".into(),
            trigger_mode: RoutineTriggerMode::OnDemand,
            name: "PR ready".into(),
            prompt: "Inspect the pull request and report whether the stage passed.".into(),
            steward_instructions: "If it remains waiting, consider asking the owner for review."
                .into(),
            enabled: true,
            schedule_interval_seconds: 300,
            generation: 2,
            context_markdown: String::new(),
            context_revision: 1,
            recent_source_keys: vec!["ciPr:step-waiting:digest".into()],
            related_task_ids: vec![],
            action_handling: RoutineActionHandling::Ask,
            pending_routine_findings: vec![PendingRoutineFinding {
                id: "finding-1".into(),
                source_key: "ciPr:step-waiting:digest".into(),
                routine_generation: 2,
                summary: "Task is waiting at PR ready.".into(),
                evidence: "No approval is visible on the matching pull request.".into(),
                source_references: vec![],
                related_task_ids: vec!["task-1".into()],
                created_at_epoch_ms: 1,
            }],
            last_check_started_at_epoch_ms: Some(1),
            last_attempt_at_epoch_ms: Some(2),
            last_successful_report_at_epoch_ms: Some(2),
            updated_at_epoch_ms: 2,
        };
        assert!(configuration.is_valid());
    }

}
