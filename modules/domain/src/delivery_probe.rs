//! Delivery probes: commands that report what one environment of a Project
//! Manager Project runs. A delivery check Agent may propose one; it runs only
//! after the Project Manager approves it, or when the Project Manager wrote
//! it. TermLoop keeps only the hash of each run's output and the commit it
//! named, never the output.

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
    /// The output names the deployed commit; a Task is deployed when its
    /// merge commit is that commit or one of its ancestors.
    CommitAncestry,
    /// Only a delivery check can read the output; a change starts one.
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
    /// Why the last run failed, if it did; the earlier hash stays.
    #[serde(default)]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DeliveryProbe {
    pub id: String,
    pub project_id: String,
    pub environment: String,
    /// The program and its arguments, run without a shell in the Project
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
        !self.id.trim().is_empty()
            && !self.project_id.trim().is_empty()
            && valid_probe_environment(&self.environment)
            && valid_probe_argv(&self.argv)
            && self.reason.as_deref().is_none_or(|reason| {
                !reason.trim().is_empty() && reason.chars().count() <= PROBE_REASON_MAX_CHARS
            })
            && self.last_run.as_ref().is_none_or(ProbeRun::is_valid)
    }
}

impl ProbeRun {
    pub fn is_valid(&self) -> bool {
        self.output_hash.as_deref().is_none_or(|hash| {
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) && self.deployed_commit.as_deref().is_none_or(valid_commit)
            && self.failure.as_deref().is_none_or(|failure| {
                !failure.is_empty()
                    && failure.len() <= PROBE_FAILURE_MAX_BYTES
                    && failure.bytes().all(|byte| byte.is_ascii_alphanumeric())
            })
    }
}

pub fn valid_probe_environment(name: &str) -> bool {
    !name.trim().is_empty()
        && name.trim() == name
        && name.chars().count() <= PROBE_ENVIRONMENT_MAX_CHARS
        && !name.chars().any(char::is_control)
}

/// A program and at most 31 arguments, none empty-programmed, oversized, or
/// carrying control characters. The program is never an option.
pub fn valid_probe_argv(argv: &[String]) -> bool {
    !argv.is_empty()
        && argv.len() <= PROBE_ARGV_MAX
        && !argv[0].trim().is_empty()
        && !argv[0].starts_with('-')
        && argv.iter().all(|argument| {
            argument.len() <= PROBE_ARGUMENT_MAX_BYTES && !argument.chars().any(char::is_control)
        })
}

pub fn valid_commit(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_probe_runs_a_program_never_an_option_or_control_text() {
        let argv = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).to_owned())
                .collect::<Vec<_>>()
        };
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
        assert!(valid_commit("abc1234"));
        assert!(!valid_commit("abc123"));
        assert!(!valid_commit("abc123z"));
    }
}
