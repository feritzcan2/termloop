//! Running approved delivery probes of Project Manager Projects. Core plans
//! which probes run and which Tasks they can place; the server runs the plan
//! outside the core lock; core applies the result. Only the output's hash and
//! the commit it named are stored. A commit-ancestry probe places each
//! tracked Task's merge commit on its environment; an Agent probe whose
//! output changed asks for a delivery check instead.

use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};
use termloop_domain::{
    EnvironmentDeployState, FactSource, ProbeMatcher, ProbeRun, ProbeStatus, TaskDeliveryFacts,
};
use termloop_gitio::GitRunner;
use termloop_platform::{CommandRequest, CommandTermination, LaunchEnvironment};

use crate::{CoreError, CoreRuntime, store_error};

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
/// How much of a changed output a delivery check is shown.
const CHANGED_OUTPUT_EXCERPT_CHARS: usize = 1_500;

/// One planned run of a Project's approved probes.
pub struct ProbeRunPlan {
    pub project_id: String,
    project_folder: PathBuf,
    probes: Vec<PlannedProbe>,
    /// Tracked Tasks with a merge commit, as `(task_id, commit)`.
    merged: Vec<(String, String)>,
}

struct PlannedProbe {
    id: String,
    argv: Vec<String>,
    matcher: ProbeMatcher,
}

/// What running a plan observed, one entry per planned probe.
pub struct ProbeRunObservation {
    results: Vec<Result<ProbeOutput, &'static str>>,
}

struct ProbeOutput {
    hash: String,
    excerpt: String,
    deployed_commit: Option<String>,
    /// Whether each merged Task's commit is in the deployed one; `None`
    /// when the repository does not have one of the commits.
    contains: Vec<(String, Option<bool>)>,
}

/// What applying a run changed, and the delivery checks it asks for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ProbeRunOutcome {
    pub changed: bool,
    /// One context per Agent probe whose output changed.
    pub check_contexts: Vec<String>,
}

impl CoreRuntime {
    /// The approved probes of a Project Manager Project, if it has any.
    pub fn plan_probe_runs(&self, project_id: &str) -> Option<ProbeRunPlan> {
        if !self.is_project_manager_project(project_id) {
            return None;
        }
        let probes = self
            .store
            .delivery_probes()
            .iter()
            .filter(|probe| probe.project_id == project_id && probe.status == ProbeStatus::Approved)
            .map(|probe| PlannedProbe {
                id: probe.id.clone(),
                argv: probe.argv.clone(),
                matcher: probe.matcher,
            })
            .collect::<Vec<_>>();
        if probes.is_empty() {
            return None;
        }
        let project_folder = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == project_id)?
            .folder_path
            .clone()
            .into();
        let merged = self
            .project_manager_tracked_tasks(project_id)
            .into_iter()
            .filter_map(|task| {
                let commit = self
                    .store
                    .task_delivery_facts_for(&task.id)?
                    .merged_commit()?
                    .to_owned();
                Some((task.id, commit))
            })
            .collect();
        Some(ProbeRunPlan {
            project_id: project_id.to_owned(),
            project_folder,
            probes,
            merged,
        })
    }

    /// Records a run: each probe's last run, the environments its commit
    /// places tracked Tasks on, and the checks changed Agent probes ask for.
    /// A probe changed or removed while it ran is skipped.
    pub fn apply_probe_runs(
        &mut self,
        plan: ProbeRunPlan,
        observation: ProbeRunObservation,
        now_epoch_ms: u64,
    ) -> Result<ProbeRunOutcome, CoreError> {
        let revision = self.store.revision();
        let mut outcome = ProbeRunOutcome::default();
        let tracked = self
            .project_manager_tracked_tasks(&plan.project_id)
            .into_iter()
            .map(|task| task.id)
            .collect::<Vec<_>>();
        let mut facts = Vec::<TaskDeliveryFacts>::new();
        for (planned, result) in plan.probes.iter().zip(observation.results) {
            let Some(current) = self.store.delivery_probes().iter().find(|probe| {
                probe.id == planned.id
                    && probe.status == ProbeStatus::Approved
                    && probe.argv == planned.argv
                    && probe.matcher == planned.matcher
            }) else {
                continue;
            };
            let previous = current.last_run.clone();
            let environment = current.environment.clone();
            let run = match result {
                Ok(output) => {
                    let changed = previous
                        .as_ref()
                        .and_then(|run| run.output_hash.as_deref())
                        .is_some_and(|hash| hash != output.hash);
                    let first = previous
                        .as_ref()
                        .and_then(|run| run.output_hash.as_ref())
                        .is_none();
                    if planned.matcher == ProbeMatcher::Agent && changed {
                        outcome.check_contexts.push(changed_context(
                            &environment,
                            &planned.argv,
                            &output.excerpt,
                        ));
                    }
                    if planned.matcher == ProbeMatcher::CommitAncestry
                        && let Some(commit) = &output.deployed_commit
                    {
                        for (task_id, contains) in &output.contains {
                            let Some(contains) = contains else { continue };
                            if !tracked.contains(task_id) {
                                continue;
                            }
                            let index =
                                match facts.iter().position(|record| record.task_id == *task_id) {
                                    Some(index) => index,
                                    None => {
                                        facts.push(
                                            self.store
                                                .task_delivery_facts_for(task_id)
                                                .cloned()
                                                .unwrap_or_else(|| TaskDeliveryFacts {
                                                    task_id: task_id.clone(),
                                                    ..TaskDeliveryFacts::default()
                                                }),
                                        );
                                        facts.len() - 1
                                    }
                                };
                            facts[index].observe_environment(
                                &environment,
                                if *contains {
                                    EnvironmentDeployState::Deployed
                                } else {
                                    EnvironmentDeployState::NotDeployed
                                },
                                Some(format!("Runs {}", &commit[..commit.len().min(12)])),
                                FactSource::Probe,
                                now_epoch_ms,
                            );
                        }
                    }
                    ProbeRun {
                        at_epoch_ms: now_epoch_ms,
                        changed_at_epoch_ms: if changed || first {
                            Some(now_epoch_ms)
                        } else {
                            previous.as_ref().and_then(|run| run.changed_at_epoch_ms)
                        },
                        failure: (planned.matcher == ProbeMatcher::CommitAncestry
                            && output.deployed_commit.is_none())
                        .then(|| "noCommit".to_owned()),
                        output_hash: Some(output.hash),
                        deployed_commit: output.deployed_commit,
                    }
                }
                Err(failure) => ProbeRun {
                    at_epoch_ms: now_epoch_ms,
                    failure: Some(failure.to_owned()),
                    ..previous.unwrap_or(ProbeRun {
                        at_epoch_ms: now_epoch_ms,
                        output_hash: None,
                        changed_at_epoch_ms: None,
                        deployed_commit: None,
                        failure: None,
                    })
                },
            };
            self.store
                .record_delivery_probe_run(&self.write_authority, &planned.id, &planned.argv, run)
                .map_err(store_error)?;
        }
        facts.retain(|record| record.is_valid());
        if !facts.is_empty() {
            self.store
                .set_task_delivery_facts(&self.write_authority, facts)
                .map_err(store_error)?;
        }
        outcome.changed = self.store.revision() != revision;
        Ok(outcome)
    }
}

impl ProbeRunPlan {
    /// Runs every planned probe, without a shell, in the Project folder.
    /// Blocking; never call it under the core lock.
    pub fn observe(&self) -> ProbeRunObservation {
        let git = GitRunner::discover().ok();
        ProbeRunObservation {
            results: self
                .probes
                .iter()
                .map(|probe| self.observe_probe(probe, git.as_ref()))
                .collect(),
        }
    }

    fn observe_probe(
        &self,
        probe: &PlannedProbe,
        git: Option<&GitRunner>,
    ) -> Result<ProbeOutput, &'static str> {
        let environment = LaunchEnvironment::os_baseline();
        let target = termloop_platform::resolve_launch_target(&probe.argv[0], &environment)
            .map_err(|_| "notFound")?;
        let (program, arguments) = target.command_line(probe.argv[1..].iter().map(String::as_str));
        let outcome = termloop_platform::run_command(
            CommandRequest::new(program)
                .args(arguments)
                .cwd(&self.project_folder)
                .launch_environment(environment)
                .timeout(PROBE_TIMEOUT)
                .output_limit(PROBE_OUTPUT_LIMIT),
        )
        .map_err(|_| "notStarted")?;
        match outcome.termination {
            CommandTermination::Exited { code: 0 } => {}
            CommandTermination::TimedOut => return Err("timedOut"),
            _ => return Err("failed"),
        }
        if outcome.stdout_truncated {
            return Err("outputTooLarge");
        }
        let text = String::from_utf8_lossy(&outcome.stdout);
        let deployed_commit = (probe.matcher == ProbeMatcher::CommitAncestry)
            .then(|| named_commit(&text))
            .flatten();
        let contains = match (&deployed_commit, git) {
            (Some(deployed), Some(git)) => self
                .merged
                .iter()
                .map(|(task_id, merged)| {
                    let contains = git
                        .commit_contains(&self.project_folder, deployed, merged)
                        .ok()
                        .flatten();
                    (task_id.clone(), contains)
                })
                .collect(),
            _ => Vec::new(),
        };
        Ok(ProbeOutput {
            hash: format!("{:x}", Sha256::digest(&outcome.stdout)),
            excerpt: text.chars().take(CHANGED_OUTPUT_EXCERPT_CHARS).collect(),
            deployed_commit,
            contains,
        })
    }
}

/// The commit an output names: the first full object name, or else the
/// first abbreviated one. A candidate holds a digit, so hex-looking words
/// such as "deface" are not commits.
fn named_commit(text: &str) -> Option<String> {
    let candidates = text
        .split(|character: char| !character.is_ascii_hexdigit())
        .filter(|token| {
            termloop_domain::valid_commit(token) && token.bytes().any(|byte| byte.is_ascii_digit())
        })
        .collect::<Vec<_>>();
    candidates
        .iter()
        .find(|token| token.len() >= 40)
        .or_else(|| candidates.first())
        .map(|token| token.to_ascii_lowercase())
}

fn changed_context(environment: &str, argv: &[String], excerpt: &str) -> String {
    let command = argv.join(" ").chars().take(300).collect::<String>();
    format!(
        "The approved probe for {environment} (`{command}`) now prints something different:\n```\n{excerpt}\n```"
    )
}

#[cfg(test)]
mod tests;
