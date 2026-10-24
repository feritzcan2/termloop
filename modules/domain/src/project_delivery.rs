//! What TermLoop observes about a Task's delivery in a Project opened as
//! Project Manager: its Jira status, the pull requests that name its Jira key,
//! and which environments run it.
//!
//! Each fact carries where it came from and when it was last observed and last
//! changed. Jira and Git-host facts are read by TermLoop itself; environment
//! facts come from a delivery check, a probe, or the Project Manager. This is
//! one current record per Task, replaced in place, never a history.

use crate::project_sprint::{valid_long, valid_short};

pub const TASK_PULL_REQUEST_FACTS_MAX: usize = 20;
pub const TASK_ENVIRONMENT_FACTS_MAX: usize = 12;
pub const TASK_CHECK_NOTES_MAX_BYTES: usize = 8_192;
const FACT_TEXT_MAX_CHARS: usize = 300;

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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JiraFact {
    pub status: String,
    #[serde(default)]
    pub assignee: Option<String>,
    pub observed_at_epoch_ms: u64,
    pub changed_at_epoch_ms: u64,
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

/// One pull request whose head branch or title names the Task's Jira key.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PullRequestFact {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: PullRequestFactState,
    pub checks: PullRequestFactChecks,
    pub base_branch: String,
    pub head_branch: String,
    #[serde(default)]
    pub merge_commit: Option<String>,
    pub updated_at_epoch_ms: u64,
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

/// Whether, and with what evidence, a Task's change reached one environment.
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

/// The newest failure of one TermLoop read, kept beside the last good facts
/// so a failed read is never shown as "nothing found".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FactReadFailure {
    pub source: FactSource,
    /// A stable reason code such as `unauthorized` or `unsupportedRepository`.
    pub reason: String,
    pub at_epoch_ms: u64,
}

/// What the latest delivery check wrote about a Task in its own words.
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
pub struct TaskDeliveryFacts {
    pub task_id: String,
    #[serde(default)]
    pub jira: Option<JiraFact>,
    #[serde(default)]
    pub pull_requests: Option<PullRequestsFact>,
    #[serde(default)]
    pub environments: Vec<EnvironmentFact>,
    #[serde(default)]
    pub check_notes: Option<CheckNotes>,
    /// At most one current failure per TermLoop-read source.
    #[serde(default)]
    pub read_failures: Vec<FactReadFailure>,
}

impl TaskDeliveryFacts {
    pub fn is_valid(&self) -> bool {
        !self.task_id.trim().is_empty()
            && self.jira.as_ref().is_none_or(|jira| {
                valid_short(Some(&jira.status)) && valid_short(jira.assignee.as_deref())
            })
            && self.pull_requests.as_ref().is_none_or(|facts| {
                valid_fact_text(&facts.repository)
                    && facts.items.len() <= TASK_PULL_REQUEST_FACTS_MAX
                    && facts.items.iter().enumerate().all(|(index, item)| {
                        valid_fact_text(&item.title)
                            && valid_fact_text(&item.url)
                            && valid_fact_text(&item.base_branch)
                            && valid_fact_text(&item.head_branch)
                            && item.merge_commit.as_deref().is_none_or(valid_commit)
                            && !facts.items[index + 1..]
                                .iter()
                                .any(|other| other.number == item.number)
                    })
            })
            && self.environments.len() <= TASK_ENVIRONMENT_FACTS_MAX
            && self
                .environments
                .iter()
                .enumerate()
                .all(|(index, environment)| {
                    valid_short(Some(&environment.name))
                        && valid_short(environment.detail.as_deref())
                        && !self.environments[index + 1..]
                            .iter()
                            .any(|other| other.name.eq_ignore_ascii_case(&environment.name))
                })
            && self.check_notes.as_ref().is_none_or(|notes| {
                !notes.markdown.trim().is_empty()
                    && notes.markdown.len() <= TASK_CHECK_NOTES_MAX_BYTES
                    && valid_long(notes.blockers.as_deref())
            })
            && self
                .read_failures
                .iter()
                .enumerate()
                .all(|(index, failure)| {
                    matches!(failure.source, FactSource::Jira | FactSource::GitHost)
                        && valid_short(Some(&failure.reason))
                        && !self.read_failures[index + 1..]
                            .iter()
                            .any(|other| other.source == failure.source)
                })
    }

    /// A record with nothing in it is stored as its absence.
    pub fn is_empty(&self) -> bool {
        self.jira.is_none()
            && self.pull_requests.is_none()
            && self.environments.is_empty()
            && self.check_notes.is_none()
            && self.read_failures.is_empty()
    }

    pub fn environment(&self, name: &str) -> Option<&EnvironmentFact> {
        self.environments
            .iter()
            .find(|environment| environment.name.eq_ignore_ascii_case(name))
    }

    /// Records one environment observation. An unchanged state keeps its
    /// change time; a fact the Project Manager stated is only replaced by the
    /// Project Manager or by a newer, different observation.
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

    /// Records a Jira read. The change time moves only when status or
    /// assignee changed.
    pub fn observe_jira(&mut self, status: String, assignee: Option<String>, now_epoch_ms: u64) {
        let changed_at = match &self.jira {
            Some(previous) if previous.status == status && previous.assignee == assignee => {
                previous.changed_at_epoch_ms
            }
            _ => now_epoch_ms,
        };
        self.jira = Some(JiraFact {
            status,
            assignee,
            observed_at_epoch_ms: now_epoch_ms,
            changed_at_epoch_ms: changed_at,
        });
        self.clear_failure(FactSource::Jira);
    }

    /// Records a Git-host read. The change time moves only when the set of
    /// pull requests or one of their states, checks, or merge commits changed.
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
        items.truncate(TASK_PULL_REQUEST_FACTS_MAX);
        let fingerprint = |items: &[PullRequestFact]| {
            let mut keys = items
                .iter()
                .map(|item| {
                    (
                        item.number,
                        item.state,
                        item.checks,
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

    /// The merge commit of the one merged pull request, when exactly one is
    /// merged.
    pub fn merged_commit(&self) -> Option<&str> {
        let merged = self
            .pull_requests
            .as_ref()?
            .items
            .iter()
            .filter(|item| item.state == PullRequestFactState::Merged)
            .collect::<Vec<_>>();
        match merged[..] {
            [only] => only.merge_commit.as_deref(),
            _ => None,
        }
    }
}

fn valid_fact_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= FACT_TEXT_MAX_CHARS
}

fn valid_commit(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull_request(number: u64, state: PullRequestFactState) -> PullRequestFact {
        PullRequestFact {
            number,
            title: format!("PAY-42 change {number}"),
            url: format!("https://github.com/acme/pay/pull/{number}"),
            state,
            checks: PullRequestFactChecks::Passing,
            base_branch: "main".into(),
            head_branch: "feature/PAY-42".into(),
            merge_commit: (state == PullRequestFactState::Merged).then(|| "abc1234def".into()),
            updated_at_epoch_ms: number,
        }
    }

    #[test]
    fn change_times_move_only_when_the_observed_value_changes() {
        let mut facts = TaskDeliveryFacts {
            task_id: "task".into(),
            ..TaskDeliveryFacts::default()
        };
        facts.observe_jira("In Progress".into(), Some("Ada".into()), 10);
        facts.observe_jira("In Progress".into(), Some("Ada".into()), 20);
        assert_eq!(facts.jira.as_ref().unwrap().changed_at_epoch_ms, 10);
        assert_eq!(facts.jira.as_ref().unwrap().observed_at_epoch_ms, 20);
        facts.observe_jira("Done".into(), Some("Ada".into()), 30);
        assert_eq!(facts.jira.as_ref().unwrap().changed_at_epoch_ms, 30);

        let repository = "github.com/acme/pay".to_owned();
        facts.observe_pull_requests(
            repository.clone(),
            vec![pull_request(1, PullRequestFactState::Open)],
            false,
            40,
        );
        facts.observe_pull_requests(
            repository.clone(),
            vec![pull_request(1, PullRequestFactState::Open)],
            false,
            50,
        );
        assert_eq!(
            facts.pull_requests.as_ref().unwrap().changed_at_epoch_ms,
            40
        );
        facts.observe_pull_requests(
            repository,
            vec![pull_request(1, PullRequestFactState::Merged)],
            false,
            60,
        );
        assert_eq!(
            facts.pull_requests.as_ref().unwrap().changed_at_epoch_ms,
            60
        );
        assert_eq!(facts.merged_commit(), Some("abc1234def"));
        assert!(facts.is_valid());
    }

    #[test]
    fn a_failed_read_keeps_the_last_good_facts() {
        let mut facts = TaskDeliveryFacts {
            task_id: "task".into(),
            ..TaskDeliveryFacts::default()
        };
        facts.observe_jira("In Review".into(), None, 1);
        facts.fail_read(FactSource::Jira, "unauthorized".into(), 2);
        facts.fail_read(FactSource::Jira, "offline".into(), 3);
        assert_eq!(facts.jira.as_ref().unwrap().status, "In Review");
        assert_eq!(facts.read_failures.len(), 1);
        assert_eq!(facts.read_failures[0].reason, "offline");
        facts.observe_jira("Done".into(), None, 4);
        assert!(facts.read_failures.is_empty());
    }

    #[test]
    fn the_project_manager_statement_survives_an_agreeing_observation() {
        let mut facts = TaskDeliveryFacts {
            task_id: "task".into(),
            ..TaskDeliveryFacts::default()
        };
        facts.observe_environment(
            "Production",
            EnvironmentDeployState::Deployed,
            Some("Released Monday".into()),
            FactSource::ProjectManager,
            1,
        );
        facts.observe_environment(
            "production",
            EnvironmentDeployState::Deployed,
            Some("v1.4".into()),
            FactSource::Check,
            2,
        );
        let production = facts.environment("PRODUCTION").unwrap();
        assert_eq!(production.source, FactSource::ProjectManager);
        assert_eq!(production.detail.as_deref(), Some("Released Monday"));
        assert_eq!(production.observed_at_epoch_ms, 2);
        facts.observe_environment(
            "Production",
            EnvironmentDeployState::NotDeployed,
            Some("Rolled back".into()),
            FactSource::Check,
            3,
        );
        let production = facts.environment("production").unwrap();
        assert_eq!(production.source, FactSource::Check);
        assert_eq!(production.changed_at_epoch_ms, 3);
    }

    #[test]
    fn duplicate_environments_and_bad_commits_are_invalid() {
        let mut facts = TaskDeliveryFacts {
            task_id: "task".into(),
            ..TaskDeliveryFacts::default()
        };
        facts.observe_environment(
            "Staging",
            EnvironmentDeployState::Deployed,
            None,
            FactSource::Probe,
            1,
        );
        assert!(facts.is_valid());
        facts.environments.push(facts.environments[0].clone());
        facts.environments[1].name = "STAGING".into();
        assert!(!facts.is_valid());
        let mut facts = TaskDeliveryFacts {
            task_id: "task".into(),
            ..TaskDeliveryFacts::default()
        };
        let mut merged = pull_request(1, PullRequestFactState::Merged);
        merged.merge_commit = Some("not-a-sha".into());
        facts.observe_pull_requests("github.com/acme/pay".into(), vec![merged], false, 1);
        assert!(!facts.is_valid());
    }
}
