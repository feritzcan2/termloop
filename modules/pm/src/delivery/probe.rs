//! Delivery probes: commands that report what one environment of a PM
//! project runs. A delivery check agent may propose one; it runs only after
//! the PM approves it, or when the PM wrote it. The PM keeps only the hash
//! of each run's output and the commit it named, never the output.
//!
//! A commit-ancestry probe needs no agent: a ticket is deployed to the
//! probe's environment when its merge commit is the deployed commit or one
//! of its ancestors. The caller asks Git (`termloop-gitio`) and hands the
//! answers here; the PM never runs Git itself.

use super::facts::{EnvironmentDeployState, valid_commit};
use crate::ticket::stored_names;
use crate::validation::{valid_id, valid_label, valid_non_blank_text};

pub const PROJECT_PROBES_MAX: usize = 16;
pub const PROBE_ARGV_MAX: usize = 32;
pub const PROBE_ARGUMENT_MAX_BYTES: usize = 1_024;
pub const PROBE_REASON_MAX_CHARS: usize = 400;
pub const PROBE_ENVIRONMENT_MAX_CHARS: usize = 120;
pub const PROBE_FAILURE_MAX_BYTES: usize = 64;

/// How a probe's output is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeMatcher {
    /// The output names the deployed commit.
    CommitAncestry,
    /// Only a delivery check agent can read the output; a change starts one.
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeStatus {
    /// Proposed by a delivery check; never run until approved.
    Proposed,
    Approved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProbeAuthor {
    ProjectManager,
    Agent,
}

stored_names!(ProbeMatcher {
    CommitAncestry => "commitAncestry",
    Agent => "agent",
});
stored_names!(ProbeStatus {
    Proposed => "proposed",
    Approved => "approved",
});
stored_names!(ProbeAuthor {
    ProjectManager => "projectManager",
    Agent => "agent",
});

/// The last run of a probe.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProbeRun {
    pub at_epoch_ms: u64,
    /// SHA-256 of the last successful output, in hex.
    #[serde(default)]
    pub output_hash: Option<String>,
    /// When the successful output last changed.
    #[serde(default)]
    pub changed_at_epoch_ms: Option<u64>,
    /// The commit a commit-ancestry probe's output named.
    #[serde(default)]
    pub deployed_commit: Option<String>,
    /// A stable code for why the last run failed; the earlier hash stays.
    #[serde(default)]
    pub failure: Option<String>,
}

impl ProbeRun {
    pub fn is_valid(&self) -> bool {
        self.output_hash.as_deref().is_none_or(valid_output_hash)
            && self.deployed_commit.as_deref().is_none_or(valid_commit)
            && self.failure.as_deref().is_none_or(valid_failure_code)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeliveryProbe {
    pub id: String,
    pub project_id: String,
    pub environment: String,
    /// The program and its arguments, run without a shell in the project
    /// folder.
    pub argv: Vec<String>,
    pub matcher: ProbeMatcher,
    pub status: ProbeStatus,
    pub author: ProbeAuthor,
    /// Why the probe tells the environment's state.
    #[serde(default)]
    pub reason: Option<String>,
    pub created_at_epoch_ms: u64,
    #[serde(default)]
    pub last_run: Option<ProbeRun>,
}

impl DeliveryProbe {
    pub fn is_valid(&self) -> bool {
        valid_id(&self.id)
            && valid_id(&self.project_id)
            && valid_probe_environment(&self.environment)
            && valid_probe_argv(&self.argv)
            && self.reason.as_deref().is_none_or(valid_probe_reason)
            && self.last_run.as_ref().is_none_or(ProbeRun::is_valid)
    }

    /// The same command for the same environment.
    pub fn same_as(&self, other: &Self) -> bool {
        self.project_id == other.project_id
            && self.argv == other.argv
            && self.environment.eq_ignore_ascii_case(&other.environment)
    }
}

pub fn valid_probe_environment(name: &str) -> bool {
    valid_label(name, PROBE_ENVIRONMENT_MAX_CHARS)
}

pub fn valid_probe_reason(reason: &str) -> bool {
    valid_non_blank_text(reason, PROBE_REASON_MAX_CHARS)
}

/// A program and at most 31 arguments, none oversized or carrying control
/// characters. The program is never an option.
pub fn valid_probe_argv(argv: &[String]) -> bool {
    !argv.is_empty()
        && argv.len() <= PROBE_ARGV_MAX
        && !argv[0].trim().is_empty()
        && !argv[0].starts_with('-')
        && argv.iter().all(|argument| {
            argument.len() <= PROBE_ARGUMENT_MAX_BYTES && !argument.chars().any(char::is_control)
        })
}

fn valid_output_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_failure_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= PROBE_FAILURE_MAX_BYTES
        && code.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The commit a probe output names: the first full object name, or else the
/// first abbreviated one. A candidate holds a digit, so hex-looking words
/// such as "deface" are not commits.
pub fn named_commit(output: &str) -> Option<String> {
    let candidates = output
        .split(|character: char| !character.is_ascii_hexdigit())
        .filter(|token| valid_commit(token) && token.bytes().any(|byte| byte.is_ascii_digit()))
        .collect::<Vec<_>>();
    candidates
        .iter()
        .find(|token| token.len() >= 40)
        .or_else(|| candidates.first())
        .map(|token| token.to_ascii_lowercase())
}

/// What one probe run produced, as the caller observed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// The command succeeded; `deployed_commit` is what a commit-ancestry
    /// probe's output named (see [`named_commit`]).
    Output {
        output_hash: String,
        deployed_commit: Option<String>,
    },
    /// A stable failure code such as `timedOut` or `notFound`.
    Failed(String),
}

/// Whether one ticket's merge commit is contained in the deployed commit,
/// as Git answered; `None` when Git could not tell (for example before a
/// fetch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitAncestryFact {
    pub ticket_id: String,
    pub contained: Option<bool>,
}

/// The environment state each ticket gets from one commit-ancestry run.
/// An unknown answer says nothing, so it changes nothing.
pub fn commit_ancestry_states(
    deployed_commit: &str,
    facts: &[CommitAncestryFact],
) -> Vec<(String, EnvironmentDeployState, String)> {
    let short = &deployed_commit[..deployed_commit.len().min(12)];
    facts
        .iter()
        .filter_map(|fact| {
            let state = if fact.contained? {
                EnvironmentDeployState::Deployed
            } else {
                EnvironmentDeployState::NotDeployed
            };
            Some((fact.ticket_id.clone(), state, format!("Runs {short}")))
        })
        .collect()
}

/// The next run record from the previous one and this run's outcome. A
/// failure keeps the previous output hash and commit; a commit-ancestry
/// output without a commit is recorded as the `noCommit` failure.
pub fn next_probe_run(
    matcher: ProbeMatcher,
    previous: Option<&ProbeRun>,
    outcome: &ProbeOutcome,
    now_epoch_ms: u64,
) -> ProbeRun {
    match outcome {
        ProbeOutcome::Output {
            output_hash,
            deployed_commit,
        } => {
            let previous_hash = previous.and_then(|run| run.output_hash.as_deref());
            ProbeRun {
                at_epoch_ms: now_epoch_ms,
                changed_at_epoch_ms: if previous_hash == Some(output_hash.as_str()) {
                    previous.and_then(|run| run.changed_at_epoch_ms)
                } else {
                    Some(now_epoch_ms)
                },
                failure: (matcher == ProbeMatcher::CommitAncestry && deployed_commit.is_none())
                    .then(|| "noCommit".to_owned()),
                output_hash: Some(output_hash.clone()),
                deployed_commit: deployed_commit.clone(),
            }
        }
        ProbeOutcome::Failed(code) => ProbeRun {
            at_epoch_ms: now_epoch_ms,
            failure: Some(code.clone()),
            ..previous.cloned().unwrap_or(ProbeRun {
                at_epoch_ms: now_epoch_ms,
                output_hash: None,
                changed_at_epoch_ms: None,
                deployed_commit: None,
                failure: None,
            })
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn a_probe_runs_a_program_never_an_option_or_control_text() {
        assert!(valid_probe_argv(&argv(&[
            "curl",
            "-s",
            "https://staging.example.com/version"
        ])));
        assert!(!valid_probe_argv(&[]));
        assert!(!valid_probe_argv(&argv(&["-c", "rm"])));
        assert!(!valid_probe_argv(&argv(&["curl", "a\nb"])));
        assert!(!valid_probe_argv(&argv(&[" "])));
        assert!(valid_probe_environment("Staging"));
        assert!(!valid_probe_environment(" Staging"));
    }

    #[test]
    fn outputs_name_their_commit() {
        let full = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            named_commit(&format!("version abc1234 built from {full}\n")).as_deref(),
            Some(full)
        );
        assert_eq!(
            named_commit("{\"sha\":\"ABC1234\"}").as_deref(),
            Some("abc1234")
        );
        assert_eq!(named_commit("deface cafebabe"), None);
    }

    #[test]
    fn ancestry_answers_become_environment_states_and_unknown_changes_nothing() {
        let states = commit_ancestry_states(
            "0123456789abcdef",
            &[
                CommitAncestryFact {
                    ticket_id: "t1".into(),
                    contained: Some(true),
                },
                CommitAncestryFact {
                    ticket_id: "t2".into(),
                    contained: Some(false),
                },
                CommitAncestryFact {
                    ticket_id: "t3".into(),
                    contained: None,
                },
            ],
        );
        assert_eq!(
            states,
            vec![
                (
                    "t1".to_owned(),
                    EnvironmentDeployState::Deployed,
                    "Runs 0123456789ab".to_owned()
                ),
                (
                    "t2".to_owned(),
                    EnvironmentDeployState::NotDeployed,
                    "Runs 0123456789ab".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn a_run_keeps_its_change_time_until_the_output_changes() {
        let hash = |digit: char| digit.to_string().repeat(64);
        let output = |digit| ProbeOutcome::Output {
            output_hash: hash(digit),
            deployed_commit: Some("abc1234".into()),
        };
        let first = next_probe_run(ProbeMatcher::CommitAncestry, None, &output('a'), 1);
        assert_eq!(first.changed_at_epoch_ms, Some(1));
        let same = next_probe_run(ProbeMatcher::CommitAncestry, Some(&first), &output('a'), 2);
        assert_eq!((same.at_epoch_ms, same.changed_at_epoch_ms), (2, Some(1)));
        let failed = next_probe_run(
            ProbeMatcher::CommitAncestry,
            Some(&same),
            &ProbeOutcome::Failed("timedOut".into()),
            3,
        );
        assert_eq!(failed.output_hash, Some(hash('a')));
        assert_eq!(failed.failure.as_deref(), Some("timedOut"));
        let no_commit = next_probe_run(
            ProbeMatcher::CommitAncestry,
            Some(&failed),
            &ProbeOutcome::Output {
                output_hash: hash('b'),
                deployed_commit: None,
            },
            4,
        );
        assert_eq!(no_commit.failure.as_deref(), Some("noCommit"));
        assert_eq!(no_commit.changed_at_epoch_ms, Some(4));
        assert!(no_commit.is_valid());
    }
}
