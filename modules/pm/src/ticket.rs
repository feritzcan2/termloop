//! Tickets: the PM's unit of work. A ticket's description is not a column of
//! its own: it is the newest of its immutable description versions.

use crate::validation::{valid_id, valid_label, valid_non_blank_text, valid_text};

pub const TICKET_TITLE_MAX_CHARS: usize = 160;
pub const TICKET_DESCRIPTION_MAX_CHARS: usize = 20_000;
pub const TICKET_ASSIGNEE_MAX_CHARS: usize = 120;
pub const TICKET_ITEM_MAX_CHARS: usize = 500;
pub const TICKET_BLOCKERS_MAX: usize = 32;
pub const TICKET_CRITERIA_MAX: usize = 64;
/// The newest versions kept per ticket; older ones are dropped whole.
pub const TICKET_VERSIONS_MAX: usize = 100;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketStatus {
    #[default]
    Todo,
    InProgress,
    InReview,
    Done,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketPriority {
    Lowest,
    Low,
    #[default]
    Medium,
    High,
    Highest,
}

/// Who recorded one description version.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TicketAuthor {
    #[default]
    Pm,
    Agent,
    Jira,
}

macro_rules! stored_names {
    ($kind:ty { $($variant:ident => $name:literal),+ $(,)? }) => {
        impl $kind {
            pub(crate) const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $name),+ }
            }

            pub(crate) fn parse(value: &str) -> Option<Self> {
                match value { $($name => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}
pub(crate) use stored_names;

stored_names!(TicketStatus {
    Todo => "todo",
    InProgress => "inProgress",
    InReview => "inReview",
    Done => "done",
});
stored_names!(TicketPriority {
    Lowest => "lowest",
    Low => "low",
    Medium => "medium",
    High => "high",
    Highest => "highest",
});
stored_names!(TicketAuthor {
    Pm => "pm",
    Agent => "agent",
    Jira => "jira",
});

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Blocker {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AcceptanceCriterion {
    pub id: String,
    pub text: String,
    pub done: bool,
}

/// The newest description version of a ticket and how many are kept.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketVersionsSummary {
    pub count: u64,
    pub head_number: u64,
    pub head_author: TicketAuthor,
    pub head_recorded_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Ticket {
    pub id: String,
    pub project_id: String,
    pub title: String,
    /// The newest description version's text; empty without versions.
    pub description: String,
    pub status: TicketStatus,
    pub priority: TicketPriority,
    #[serde(default)]
    pub assignee: Option<String>,
    /// `None` is the project backlog.
    #[serde(default)]
    pub sprint_id: Option<String>,
    /// Order within its sprint or the backlog, ascending.
    pub rank: i64,
    /// The exact HTTPS browse URL of the Jira issue this ticket tracks.
    #[serde(default)]
    pub jira_url: Option<String>,
    /// How often the ticket left a closed sprint unfinished.
    pub carry_over_count: u32,
    pub blockers: Vec<Blocker>,
    pub acceptance_criteria: Vec<AcceptanceCriterion>,
    #[serde(default)]
    pub versions: Option<TicketVersionsSummary>,
    pub created_at_epoch_ms: u64,
    pub updated_at_epoch_ms: u64,
}

/// One immutable saved description of a ticket, numbered from 1 per ticket.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketVersion {
    pub ticket_id: String,
    pub number: u64,
    pub description: String,
    pub author: TicketAuthor,
    pub recorded_at_epoch_ms: u64,
}

impl TicketVersion {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.ticket_id) && self.number > 0 && valid_ticket_description(&self.description)
    }
}

pub fn valid_ticket_title(title: &str) -> bool {
    valid_label(title, TICKET_TITLE_MAX_CHARS)
}

/// A description may be empty (cleared) but never carries control text.
pub fn valid_ticket_description(description: &str) -> bool {
    valid_text(description, TICKET_DESCRIPTION_MAX_CHARS)
}

pub fn valid_assignee(assignee: &str) -> bool {
    valid_label(assignee, TICKET_ASSIGNEE_MAX_CHARS)
}

/// Blocker and acceptance-criterion text.
pub fn valid_ticket_item(text: &str) -> bool {
    valid_non_blank_text(text, TICKET_ITEM_MAX_CHARS) && text.trim() == text
}

/// Only the exact, secret-free form `https://<host>/browse/<KEY-1>` is kept:
/// no userinfo, query, fragment, trailing slash, or uppercase host.
pub fn valid_jira_url(url: &str) -> bool {
    termloop_providers::normalize_jira_issue_url(url).is_ok_and(|normalized| normalized.url == url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_secret_free_browse_url_is_a_jira_link() {
        assert!(valid_jira_url("https://acme.atlassian.net/browse/PM-12"));
        for rejected in [
            "http://acme.atlassian.net/browse/PM-12",
            "https://user:token@acme.atlassian.net/browse/PM-12",
            "https://acme.atlassian.net/browse/PM-12?token=secret",
            "https://acme.atlassian.net/browse/PM-12#comment",
            "https://acme.atlassian.net/browse/PM-12/",
            "https://ACME.atlassian.net/browse/PM-12",
            "https://acme.atlassian.net/jira/PM-12",
            "https://acme.atlassian.net/browse/12",
            "",
        ] {
            assert!(!valid_jira_url(rejected), "{rejected}");
        }
    }

    #[test]
    fn stored_names_round_trip() {
        for status in [
            TicketStatus::Todo,
            TicketStatus::InProgress,
            TicketStatus::InReview,
            TicketStatus::Done,
        ] {
            assert_eq!(TicketStatus::parse(status.as_str()), Some(status));
        }
        for author in [TicketAuthor::Pm, TicketAuthor::Agent, TicketAuthor::Jira] {
            assert_eq!(TicketAuthor::parse(author.as_str()), Some(author));
        }
        assert_eq!(TicketPriority::parse("urgent"), None);
    }

    #[test]
    fn items_and_titles_are_trimmed_and_bounded() {
        assert!(valid_ticket_title("Add login"));
        assert!(!valid_ticket_title(""));
        assert!(valid_ticket_item("Waiting on API keys"));
        assert!(!valid_ticket_item(" padded"));
        assert!(!valid_ticket_item(&"x".repeat(TICKET_ITEM_MAX_CHARS + 1)));
        assert!(valid_ticket_description(""));
        assert!(valid_ticket_description("## Goal\n- one"));
    }
}
