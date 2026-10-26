//! The Project Manager app's model and its own SQLite store: sprints,
//! tickets with immutable description versions, project sources, the
//! delivery Playbook, delivery facts and verdicts, and what is derived from
//! them.
//! It never reads or writes the developer daemon's `termloop-store` state.

pub mod agent;
mod board;
mod commands;
mod delivery;
mod digest;
mod epic;
mod error;
mod note;
pub mod playbook;
mod project;
mod proposal;
mod settings;
pub mod skill;
mod sources;
mod sprint;
mod store;
mod ticket;
mod validation;

#[cfg(test)]
mod tests;

pub use board::Board;
pub use commands::{
    AcceptedBreakdown, ChannelWatermark, CheckReport, ClosedSprint, DeletedSprint, FactRead,
    FactsObservation, JIRA_PULL_NEW_TICKETS_MAX, JiraChange, JiraIssueState, JiraObservation,
    JiraPullChanges, JiraPullOutcome, JiraSprintImportOutcome, JiraSprintImportRead,
    JiraSprintPull, JiraSprintRead, JiraWriteDiff, JiraWriteOutcome, JiraWriteTarget,
    MARKED_PASSED_EVIDENCE, NewTicket, ProposalOrigin, PullRequestsObservation,
    RecordedCheckReport, SKILL_DISCOVERY_MAX_BYTES, SKILL_PAUSE_AFTER_FAILURES,
    SKILL_RETRY_AFTER_MS, SKILL_SLACK_RETENTION_MS, TicketEdit, apply_jira_write,
    read_jira_issue_state, read_jira_sprint_import, read_jira_sprints, slack_ts_at, slack_ts_key,
};
pub use delivery::checks::{
    CHECK_DEADLINE_MS, CHECK_RETRY_AFTER_MS, DeliveryCheck, DeliveryCheckOutcome,
    DeliveryCheckReason, DueCheck, PROJECT_RUNNING_CHECKS_MAX, TICKET_FINISHED_CHECKS_MAX,
};
pub use delivery::facts::{
    FACTS_STALE_AFTER_MS, FactReadFailure, FactSource, JiraFact, JiraStatusCategory,
    PullRequestFact, PullRequestFactChecks, PullRequestFactReview, PullRequestFactState,
    PullRequestsFact, TICKET_PULL_REQUEST_FACTS_MAX, TicketDeliveryFacts, valid_commit,
};
pub use delivery::risks::{DeliveryRisk, DeliveryRiskKind, RiskInputs, delivery_risks};
pub use delivery::tracking::{DataTier, Tracking};
pub use delivery::{FactsSummary, TicketDelivery};
pub use digest::{DIGEST_ENTRIES_MAX, Digest, DigestEntry, DigestKind, DigestSource, digest};
pub use epic::{
    AssistantConversation, BREAKDOWN_TASKS_MAX, BreakdownTask, EPIC_DESCRIPTION_MAX_CHARS,
    EPIC_TITLE_MAX_CHARS, Epic, EpicBreakdown, EpicDraft, EpicEdit, PROJECT_BREAKDOWNS_MAX,
    PROJECT_EPICS_MAX, valid_epic_description, valid_epic_title,
};
pub use error::PmError;
pub use note::{
    NewTicketNote, TICKET_NOTE_LABEL_MAX_CHARS, TICKET_NOTE_MAX_CHARS, TICKET_NOTE_SOURCES_MAX,
    TICKET_NOTE_URL_MAX_BYTES, TICKET_NOTES_MAX, TicketNote, TicketNoteKind,
    valid_ticket_note_text, valid_ticket_note_url,
};
pub use project::{
    PROJECT_FOLDER_MAX_CHARS, PROJECT_NAME_MAX_CHARS, PROJECTS_MAX, Project, valid_project_folder,
    valid_project_name,
};
pub use proposal::{
    ASSIGNEE_SHORTLIST_MAX, AssigneeCandidate, JIRA_COMMENT_MAX_CHARS, PROPOSAL_SUMMARY_MAX_CHARS,
    ProposalChange, TICKET_JIRA_COMMENTS_MAX, TICKET_PROPOSALS_MAX, TicketProposal,
    valid_proposal_summary,
};
pub use settings::{PM_AGENT_PROVIDERS, PmSettings, SettingsEdit, valid_setting_value};
pub use sources::{GitHubSource, JiraSource, ProjectSources};
pub use sprint::{
    PROJECT_OPEN_SPRINTS_MAX, SPRINT_GOAL_MAX_CHARS, SPRINT_NAME_MAX_CHARS, Sprint, SprintState,
    valid_sprint_goal, valid_sprint_name,
};
pub use store::{PmStore, SCHEMA_VERSION};
pub use ticket::{
    AcceptanceCriterion, Blocker, TICKET_ASSIGNEE_MAX_CHARS, TICKET_BLOCKERS_MAX,
    TICKET_CRITERIA_MAX, TICKET_DESCRIPTION_MAX_CHARS, TICKET_ITEM_MAX_CHARS,
    TICKET_TITLE_MAX_CHARS, TICKET_VERSIONS_MAX, Ticket, TicketActivity, TicketActivityKind,
    TicketAuthor, TicketPriority, TicketStatus, TicketVersion, TicketVersionsSummary,
    valid_jira_url,
};
pub use validation::{ID_MAX_BYTES, valid_id};
