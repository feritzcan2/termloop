//! What the PM observes about one ticket's delivery: its Jira status, the
//! pull requests that name its Jira key, which environments run it, what the
//! latest delivery check wrote, and why the newest read failed.
//!
//! Each fact carries when it was last observed and last changed. It is one
//! current record per ticket, replaced in place, never a history. A failed
//! read keeps the last good facts beside its reason, so it is never shown as
//! "nothing found".

use termloop_providers::{CheckState, PullRequestState, PullRequestSummary, ReviewState};

use crate::validation::{valid_label, valid_non_blank_text};

pub const TICKET_PULL_REQUEST_FACTS_MAX: usize = 20;
pub const TICKET_ENVIRONMENT_FACTS_MAX: usize = 12;
pub const TICKET_CHECK_NOTES_MAX_BYTES: usize = 8_192;
const FACT_SHORT_MAX_CHARS: usize = 300;
const FACT_LONG_MAX_CHARS: usize = 2_000;
const HOUR_MS: u64 = 60 * 60 * 1000;
/// Facts recorded longer ago than this are stale: still shown, but marked,
/// and never the basis of a Jira write.
pub const FACTS_STALE_AFTER_MS: u64 = 6 * HOUR_MS;

/// Where a fact came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FactSource {
    Jira,
    GitHost,
    Probe,
    Check,
    ProjectManager,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnvironmentDeployState {
    #[default]
    Unknown,
    NotDeployed,
    InProgress,
    Deployed,
}

/// Jira's own grouping of an issue status, whatever the status is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JiraStatusCategory {
    New,
    Indeterminate,
    Done,
}

impl JiraStatusCategory {
    /// Jira's `statusCategory.key`.
    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "new" => Some(Self::New),
            "indeterminate" => Some(Self::Indeterminate),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JiraFact {
    pub status: String,
    #[serde(default)]
    pub status_category: Option<JiraStatusCategory>,
    #[serde(default)]
    pub assignee: Option<String>,
    /// Jira's own `updated` stamp of the issue, when read.
    #[serde(default)]
    pub updated_at_epoch_ms: Option<u64>,
    pub observed_at_epoch_ms: u64,
    pub changed_at_epoch_ms: u64,
}

impl JiraFact {
    /// Whether Jira says the work is finished: its status category when Jira
    /// sent one, otherwise the common spellings of a finished status.
    pub fn done(&self) -> bool {
        self.status_category.map_or_else(
            || {
                let status = self.status.trim().to_ascii_lowercase();
                matches!(
                    status.as_str(),
                    "done"
                        | "closed"
                        | "resolved"
                        | "released"
                        | "complete"
                        | "completed"
                        | "shipped"
                ) || status.starts_with("done")
            },
            |category| category == JiraStatusCategory::Done,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestFactState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestFactChecks {
    Passing,
    Failing,
    Pending,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PullRequestFactReview {
    Approved,
    ChangesRequested,
    ReviewRequired,
    Unknown,
}

/// One pull request whose head branch or title names the ticket's Jira key.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PullRequestFact {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PullRequestFactState,
    pub checks: PullRequestFactChecks,
    pub review: PullRequestFactReview,
    pub base_branch: String,
    pub head_branch: String,
    #[serde(default)]
    pub merge_commit: Option<String>,
    pub updated_at_epoch_ms: u64,
    /// Since when an open pull request has waited for an approval, as first
    /// observed. Maintained by [`TicketDeliveryFacts::observe_pull_requests`].
    #[serde(default)]
    pub awaiting_review_since_epoch_ms: Option<u64>,
}

impl PullRequestFact {
    /// A provider summary as a fact; the review wait is set when observed.
    pub fn from_summary(summary: &PullRequestSummary) -> Self {
        Self {
            number: summary.number,
            title: summary.title.clone(),
            url: summary.url.clone(),
            state: match summary.state {
                PullRequestState::Open => PullRequestFactState::Open,
                PullRequestState::Draft => PullRequestFactState::Draft,
                PullRequestState::Merged => PullRequestFactState::Merged,
                PullRequestState::Closed => PullRequestFactState::Closed,
            },
            checks: match summary.checks {
                CheckState::Passing => PullRequestFactChecks::Passing,
                CheckState::Failing => PullRequestFactChecks::Failing,
                CheckState::Pending => PullRequestFactChecks::Pending,
                CheckState::NotReported | CheckState::Unsupported | CheckState::Unknown => {
                    PullRequestFactChecks::Unknown
                }
            },
            review: match summary.review {
                ReviewState::Approved => PullRequestFactReview::Approved,
                ReviewState::ChangesRequested => PullRequestFactReview::ChangesRequested,
                ReviewState::ReviewRequired => PullRequestFactReview::ReviewRequired,
                ReviewState::NotReported | ReviewState::Unknown => PullRequestFactReview::Unknown,
            },
            base_branch: summary.base_branch.clone(),
            head_branch: summary.head_branch.clone(),
            merge_commit: summary.merge_commit_oid.clone(),
            updated_at_epoch_ms: summary.updated_at_epoch_ms,
            awaiting_review_since_epoch_ms: None,
        }
    }

    /// Open, ready for review, and not approved yet.
    pub fn awaits_review(&self) -> bool {
        self.state == PullRequestFactState::Open && self.review != PullRequestFactReview::Approved
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PullRequestsFact {
    /// A secret-free repository label such as `github.com/owner/repo`.
    pub repository: String,
    pub items: Vec<PullRequestFact>,
    /// The Git host had more matches than were read.
    pub truncated: bool,
    pub observed_at_epoch_ms: u64,
    pub changed_at_epoch_ms: u64,
}

/// Whether, and with what evidence, a ticket's change reached one
/// environment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct EnvironmentFact {
    pub name: String,
    pub state: EnvironmentDeployState,
    #[serde(default)]
    pub detail: Option<String>,
    pub source: FactSource,
    pub observed_at_epoch_ms: u64,
    pub changed_at_epoch_ms: u64,
}

/// The newest failure of one PM read, kept beside the last good facts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FactReadFailure {
    pub source: FactSource,
    /// A stable reason code such as `unauthorized` or `rateLimited`.
    pub reason: String,
    pub at_epoch_ms: u64,
}

/// What the latest delivery check wrote about a ticket in its own words.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckNotes {
    #[serde(default)]
    pub blockers: Option<String>,
    pub markdown: String,
    pub recorded_at_epoch_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TicketDeliveryFacts {
    pub ticket_id: String,
    /// When any fact of this record was last recorded.
    pub recorded_at_epoch_ms: u64,
    #[serde(default)]
    pub jira: Option<JiraFact>,
    #[serde(default)]
    pub pull_requests: Option<PullRequestsFact>,
    #[serde(default)]
    pub environments: Vec<EnvironmentFact>,
    #[serde(default)]
    pub check_notes: Option<CheckNotes>,
    /// At most one current failure per PM-read source.
    #[serde(default)]
    pub read_failures: Vec<FactReadFailure>,
}

impl TicketDeliveryFacts {
    pub fn new(ticket_id: impl Into<String>) -> Self {
        Self {
            ticket_id: ticket_id.into(),
            ..Self::default()
        }
    }

    pub fn is_valid(&self) -> bool {
        crate::valid_id(&self.ticket_id)
            && self.jira.as_ref().is_none_or(|jira| {
                short(&jira.status) && jira.assignee.as_deref().is_none_or(short)
            })
            && self.pull_requests.as_ref().is_none_or(|facts| {
                short(&facts.repository)
                    && facts.items.len() <= TICKET_PULL_REQUEST_FACTS_MAX
                    && facts.items.iter().enumerate().all(|(index, item)| {
                        short(&item.title)
                            && short(&item.url)
                            && short(&item.base_branch)
                            && short(&item.head_branch)
                            && item.merge_commit.as_deref().is_none_or(valid_commit)
                            && !facts.items[index + 1..]
                                .iter()
                                .any(|other| other.number == item.number)
                    })
            })
            && self.environments.len() <= TICKET_ENVIRONMENT_FACTS_MAX
            && self
                .environments
                .iter()
                .enumerate()
                .all(|(index, environment)| {
                    short(&environment.name)
                        && environment.detail.as_deref().is_none_or(short)
                        && !self.environments[index + 1..]
                            .iter()
                            .any(|other| other.name.eq_ignore_ascii_case(&environment.name))
                })
            && self.check_notes.as_ref().is_none_or(|notes| {
                !notes.markdown.trim().is_empty()
                    && notes.markdown.len() <= TICKET_CHECK_NOTES_MAX_BYTES
                    && notes
                        .blockers
                        .as_deref()
                        .is_none_or(|text| valid_non_blank_text(text, FACT_LONG_MAX_CHARS))
            })
            && self
                .read_failures
                .iter()
                .enumerate()
                .all(|(index, failure)| {
                    matches!(failure.source, FactSource::Jira | FactSource::GitHost)
                        && short(&failure.reason)
                        && !self.read_failures[index + 1..]
                            .iter()
                            .any(|other| other.source == failure.source)
                })
    }

    /// Recorded longer ago than [`FACTS_STALE_AFTER_MS`].
    pub fn is_stale(&self, now_epoch_ms: u64) -> bool {
        now_epoch_ms.saturating_sub(self.recorded_at_epoch_ms) > FACTS_STALE_AFTER_MS
    }

    pub fn environment(&self, name: &str) -> Option<&EnvironmentFact> {
        self.environments
            .iter()
            .find(|environment| environment.name.eq_ignore_ascii_case(name))
    }

    /// Records one environment observation. An unchanged state keeps its
    /// change time; a fact the PM stated is only replaced by the PM or by a
    /// different observation.
    pub fn observe_environment(
        &mut self,
        name: &str,
        state: EnvironmentDeployState,
        detail: Option<String>,
        source: FactSource,
        now_epoch_ms: u64,
    ) {
        match self
            .environments
            .iter_mut()
            .find(|environment| environment.name.eq_ignore_ascii_case(name))
        {
            Some(existing) => {
                if existing.source == FactSource::ProjectManager
                    && source != FactSource::ProjectManager
                    && existing.state == state
                {
                    existing.observed_at_epoch_ms = now_epoch_ms;
                    return;
                }
                if existing.state != state {
                    existing.changed_at_epoch_ms = now_epoch_ms;
                }
                existing.state = state;
                existing.detail = detail;
                existing.source = source;
                existing.observed_at_epoch_ms = now_epoch_ms;
            }
            None => self.environments.push(EnvironmentFact {
                name: name.to_owned(),
                state,
                detail,
                source,
                observed_at_epoch_ms: now_epoch_ms,
                changed_at_epoch_ms: now_epoch_ms,
            }),
        }
    }

    /// Records a Jira read. The change time moves only when the status, its
    /// category, or the assignee changed.
    pub fn observe_jira(
        &mut self,
        status: String,
        status_category: Option<JiraStatusCategory>,
        assignee: Option<String>,
        updated_at_epoch_ms: Option<u64>,
        now_epoch_ms: u64,
    ) {
        let changed_at = match &self.jira {
            Some(previous)
                if previous.status == status
                    && previous.status_category == status_category
                    && previous.assignee == assignee =>
            {
                previous.changed_at_epoch_ms
            }
            _ => now_epoch_ms,
        };
        self.jira = Some(JiraFact {
            status,
            status_category,
            assignee,
            updated_at_epoch_ms,
            observed_at_epoch_ms: now_epoch_ms,
            changed_at_epoch_ms: changed_at,
        });
        self.clear_failure(FactSource::Jira);
    }

    /// Records a Git-host read. The change time moves only when the set of
    /// pull requests or one of their states, checks, reviews, or merge
    /// commits changed. A pull request still waiting for review keeps the
    /// time its wait was first observed.
    pub fn observe_pull_requests(
        &mut self,
        repository: String,
        mut items: Vec<PullRequestFact>,
        truncated: bool,
        now_epoch_ms: u64,
    ) {
        items.sort_by(|left, right| {
            right
                .updated_at_epoch_ms
                .cmp(&left.updated_at_epoch_ms)
                .then(left.number.cmp(&right.number))
        });
        items.dedup_by_key(|item| item.number);
        items.truncate(TICKET_PULL_REQUEST_FACTS_MAX);
        let previous_items = self
            .pull_requests
            .as_ref()
            .filter(|previous| previous.repository == repository)
            .map(|previous| previous.items.as_slice())
            .unwrap_or_default();
        for item in &mut items {
            item.awaiting_review_since_epoch_ms = item.awaits_review().then(|| {
                previous_items
                    .iter()
                    .find(|previous| previous.number == item.number)
                    .and_then(|previous| previous.awaiting_review_since_epoch_ms)
                    .unwrap_or(now_epoch_ms)
            });
        }
        let fingerprint = |items: &[PullRequestFact]| {
            let mut keys = items
                .iter()
                .map(|item| {
                    (
                        item.number,
                        item.state,
                        item.checks,
                        item.review,
                        item.merge_commit.clone(),
                    )
                })
                .collect::<Vec<_>>();
            keys.sort_by_key(|key| key.0);
            keys
        };
        let changed_at = match &self.pull_requests {
            Some(previous)
                if previous.repository == repository
                    && fingerprint(&previous.items) == fingerprint(&items) =>
            {
                previous.changed_at_epoch_ms
            }
            _ => now_epoch_ms,
        };
        self.pull_requests = Some(PullRequestsFact {
            repository,
            items,
            truncated,
            observed_at_epoch_ms: now_epoch_ms,
            changed_at_epoch_ms: changed_at,
        });
        self.clear_failure(FactSource::GitHost);
    }

    /// Keeps the last good facts and remembers why the newest read failed.
    pub fn fail_read(&mut self, source: FactSource, reason: String, now_epoch_ms: u64) {
        self.clear_failure(source);
        self.read_failures.push(FactReadFailure {
            source,
            reason,
            at_epoch_ms: now_epoch_ms,
        });
    }

    fn clear_failure(&mut self, source: FactSource) {
        self.read_failures
            .retain(|failure| failure.source != source);
    }

    pub fn pull_request_items(&self) -> &[PullRequestFact] {
        self.pull_requests
            .as_ref()
            .map(|fact| fact.items.as_slice())
            .unwrap_or_default()
    }

    /// The merge commit of the one merged pull request, when exactly one is
    /// merged.
    pub fn merged_commit(&self) -> Option<&str> {
        let mut merged = self
            .pull_request_items()
            .iter()
            .filter(|item| item.state == PullRequestFactState::Merged);
        match (merged.next(), merged.next()) {
            (Some(only), None) => only.merge_commit.as_deref(),
            _ => None,
        }
    }
}

fn short(value: &str) -> bool {
    valid_label(value, FACT_SHORT_MAX_CHARS)
}

/// A full or abbreviated hex Git object name.
pub fn valid_commit(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn pull_request(number: u64, state: PullRequestFactState) -> PullRequestFact {
        PullRequestFact {
            number,
            title: format!("PAY-42 change {number}"),
            url: format!("https://github.com/acme/pay/pull/{number}"),
            state,
            checks: PullRequestFactChecks::Passing,
            review: PullRequestFactReview::ReviewRequired,
            base_branch: "main".into(),
            head_branch: "feature/PAY-42".into(),
            merge_commit: (state == PullRequestFactState::Merged).then(|| "abc1234def".into()),
            updated_at_epoch_ms: number,
            awaiting_review_since_epoch_ms: None,
        }
    }

    #[test]
    fn change_times_move_only_when_the_observed_value_changes() {
        let mut facts = TicketDeliveryFacts::new("ticket");
        facts.observe_jira("In Progress".into(), None, Some("Ada".into()), None, 10);
        facts.observe_jira("In Progress".into(), None, Some("Ada".into()), None, 20);
        assert_eq!(facts.jira.as_ref().unwrap().changed_at_epoch_ms, 10);
        assert_eq!(facts.jira.as_ref().unwrap().observed_at_epoch_ms, 20);
        facts.observe_jira("Done".into(), None, Some("Ada".into()), None, 30);
        assert_eq!(facts.jira.as_ref().unwrap().changed_at_epoch_ms, 30);

        let repository = "github.com/acme/pay".to_owned();
        let open = || vec![pull_request(1, PullRequestFactState::Open)];
        facts.observe_pull_requests(repository.clone(), open(), false, 40);
        facts.observe_pull_requests(repository.clone(), open(), false, 50);
        let fact = facts.pull_requests.as_ref().unwrap();
        assert_eq!(fact.changed_at_epoch_ms, 40);
        assert_eq!(fact.items[0].awaiting_review_since_epoch_ms, Some(40));
        facts.observe_pull_requests(
            repository,
            vec![pull_request(1, PullRequestFactState::Merged)],
            false,
            60,
        );
        let fact = facts.pull_requests.as_ref().unwrap();
        assert_eq!(fact.changed_at_epoch_ms, 60);
        assert_eq!(fact.items[0].awaiting_review_since_epoch_ms, None);
        assert_eq!(facts.merged_commit(), Some("abc1234def"));
        assert!(facts.is_valid());
    }

    #[test]
    fn a_failed_read_keeps_the_last_good_facts() {
        let mut facts = TicketDeliveryFacts::new("ticket");
        facts.observe_jira("In Review".into(), None, None, None, 1);
        facts.fail_read(FactSource::Jira, "unauthorized".into(), 2);
        facts.fail_read(FactSource::Jira, "offline".into(), 3);
        assert_eq!(facts.jira.as_ref().unwrap().status, "In Review");
        assert_eq!(facts.read_failures.len(), 1);
        assert_eq!(facts.read_failures[0].reason, "offline");
        facts.observe_jira("Done".into(), None, None, None, 4);
        assert!(facts.read_failures.is_empty());
    }

    #[test]
    fn the_project_manager_statement_survives_an_agreeing_observation() {
        let mut facts = TicketDeliveryFacts::new("ticket");
        let deployed = EnvironmentDeployState::Deployed;
        let pm = FactSource::ProjectManager;
        facts.observe_environment("Production", deployed, Some("Monday".into()), pm, 1);
        facts.observe_environment("production", deployed, None, FactSource::Check, 2);
        let production = facts.environment("PRODUCTION").unwrap();
        assert_eq!(production.source, pm);
        assert_eq!(production.detail.as_deref(), Some("Monday"));
        assert_eq!(production.observed_at_epoch_ms, 2);
        let rolled_back = EnvironmentDeployState::NotDeployed;
        facts.observe_environment("Production", rolled_back, None, FactSource::Check, 3);
        let production = facts.environment("production").unwrap();
        assert_eq!(production.source, FactSource::Check);
        assert_eq!(production.changed_at_epoch_ms, 3);
    }

    #[test]
    fn duplicate_environments_bad_commits_and_age_are_checked() {
        let mut facts = TicketDeliveryFacts::new("ticket");
        facts.observe_environment(
            "Staging",
            EnvironmentDeployState::Deployed,
            None,
            FactSource::Probe,
            1,
        );
        assert!(facts.is_valid());
        let mut duplicate = facts.environments[0].clone();
        duplicate.name = "STAGING".into();
        facts.environments.push(duplicate);
        assert!(!facts.is_valid());

        let mut facts = TicketDeliveryFacts::new("ticket");
        let mut merged = pull_request(1, PullRequestFactState::Merged);
        merged.merge_commit = Some("not-a-sha".into());
        facts.observe_pull_requests("github.com/acme/pay".into(), vec![merged], false, 1);
        assert!(!facts.is_valid());

        facts.recorded_at_epoch_ms = 100;
        assert!(!facts.is_stale(100 + FACTS_STALE_AFTER_MS));
        assert!(facts.is_stale(101 + FACTS_STALE_AFTER_MS));
    }

    #[test]
    fn jira_done_follows_the_category_before_the_name() {
        let fact = |status: &str, category| JiraFact {
            status: status.into(),
            status_category: category,
            assignee: None,
            updated_at_epoch_ms: None,
            observed_at_epoch_ms: 0,
            changed_at_epoch_ms: 0,
        };
        assert!(fact("Resolved", None).done());
        assert!(!fact("In QA", None).done());
        assert!(fact("Shipped to QA", Some(JiraStatusCategory::Done)).done());
        assert!(!fact("Done-ish", Some(JiraStatusCategory::Indeterminate)).done());
    }
}
