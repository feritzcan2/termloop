//! Pure Project delivery Playbook values.
//!
//! A Playbook is one user-owned current document per Project: the ordered
//! stages a Task completes on its way to done, plus the pipelines the Project
//! keeps but is not walking. Each stage names the Routine that evaluates it.
//!
//! A Task's *position* on the pipeline is never stored. What is stored is the
//! current completion verdict for each stage and Task, not a run log —
//! and position is derived from those answers by `pipeline_position`.

pub const PLAYBOOK_MILESTONES_MAX: usize = 24;
pub const PLAYBOOK_ENTRY_ID_MAX_BYTES: usize = 64;
pub const PLAYBOOK_TITLE_MAX_BYTES: usize = 120;
pub const PLAYBOOK_APPROVER_MAX_BYTES: usize = 120;
pub const PLAYBOOK_ROUTINE_ID_MAX_BYTES: usize = 64;
pub const PLAYBOOK_PIPELINE_NAME_MAX_BYTES: usize = 120;
/// Kept pipelines beside the active one. A Project switches between a handful
/// of delivery paths; this bounds the document, not the user's patience.
pub const PLAYBOOK_SAVED_PIPELINES_MAX: usize = 16;
pub const PLAYBOOK_RETRY_DELAY_MIN_SECONDS: u64 = 60;
pub const PLAYBOOK_RETRY_DELAY_MAX_SECONDS: u64 = 86_400;
/// One short factual sentence per verdict. Evidence explains an answer; it is
/// never a place to park raw external content.
pub const PLAYBOOK_EVIDENCE_MAX_BYTES: usize = 600;
/// A Git branch name a deterministic pull-request check may filter by.
pub const PLAYBOOK_BASE_BRANCH_MAX_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookGateKind {
    Automatic,
    Human,
}

/// One stop on the Project's delivery path. Whether a Task has passed it is
/// the stored verdict of its Routine, never a position stored on the Task.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookMilestone {
    pub id: String,
    pub title: String,
    pub gate: PlaybookGateKind,
    /// The Routine that evaluates this stage. Its run decides whether a Task
    /// has passed; several steps may share one Routine because the Routine
    /// holds the capability and the step holds the completion policy.
    pub routine_id: String,
    /// How long to wait before evaluating an incomplete Task again.
    pub retry_delay_seconds: u64,
    /// Human gates only: who may satisfy the gate. Advisory identity text;
    /// enforcement stays with the Steward's built-in gate rules.
    #[serde(default)]
    pub approver: Option<String>,
    /// An optional fact TermLoop can read itself from the Task branch's pull
    /// request before asking the step's Routine. `None` for every step whose
    /// completion is anything else, and for documents written before it.
    #[serde(default)]
    pub deterministic_check: Option<PlaybookDeterministicCheck>,
    /// What the Task's own Agent may do when it reports reaching this step.
    /// Documents written before agent reports default to `Signal`.
    #[serde(default)]
    pub agent_report: PlaybookAgentReportPolicy,
}

/// How a Task Agent's own report that it reached a step is treated.
///
/// An Agent's report is a claim about its own work, not independent proof.
/// `Signal` only brings the step's evaluation forward; `Trusted` records the
/// claim as the verdict and is never available on a human gate.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookAgentReportPolicy {
    /// The Task Agent cannot report this step.
    Off,
    /// The report asks the step's evaluator to check now, with the Agent's
    /// claim attached as unverified context.
    #[default]
    Signal,
    /// The report passes the step without independent evaluation.
    Trusted,
}

/// The pull-request state a deterministic step check reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookDeterministicCheckKind {
    /// Exactly one open, non-draft pull request from the Task branch.
    PullRequestOpen,
    /// Exactly one open pull request from the Task branch whose checks pass.
    PullRequestChecksPassing,
    /// Exactly one merged pull request from the Task branch.
    PullRequestMerged,
    /// The Task branch has at least one commit of its own, counted from where
    /// it left its base. Read from local Git; the commits need not be pushed.
    BranchCommitted,
    /// The Task's delivery facts show it deployed to the named environment.
    /// Only a Project opened as Project Manager keeps those facts.
    EnvironmentDeployed,
}

/// A step's completion expressed as the Task branch's own pull request state.
/// It is read fresh from the Git host; it never consults a display cache.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookDeterministicCheck {
    pub kind: PlaybookDeterministicCheckKind,
    /// Only pull requests targeting exactly this branch count. `None` accepts
    /// any target branch.
    #[serde(default)]
    pub base_branch: Option<String>,
    /// The environment an `EnvironmentDeployed` check reads, matched without
    /// regard to case; absent for every other kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
}

/// Who produced a stored verdict.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookStepEvaluator {
    /// TermLoop read the Git host itself.
    Deterministic,
    /// The step's Routine evaluated it.
    #[default]
    Routine,
    /// The Task's own Agent reported it under a `Trusted` step policy.
    Agent,
}

/// Why a step with a deterministic check was answered by its Routine instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookDeterministicFallback {
    NoTaskBranch,
    UnsupportedRepository,
    ProviderUnavailable,
    Unauthorized,
    Offline,
    RateLimited,
    Timeout,
    ProviderFailure,
    MultipleMatches,
    ChecksUnsupported,
    /// Local Git could not count the Task branch's own commits.
    CommitsUnavailable,
    /// No delivery fact says where the Task's environment stands.
    EnvironmentUnknown,
}

/// The one current Playbook document for a Project. Replace-only: updates
/// carry the complete next document and the expected document revision.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookConfiguration {
    pub project_id: String,
    pub revision: u64,
    /// Which of the Project's pipelines the Tasks are walking. Never empty, and
    /// never also present in `saved_pipelines`: a pipeline is either the one in
    /// use or one of the ones kept.
    #[serde(default = "default_pipeline_name")]
    pub active_pipeline_name: String,
    /// The active pipeline's stages.
    #[serde(default)]
    pub milestones: Vec<PlaybookMilestone>,
    /// The Project's other pipelines, kept whole so switching away from one
    /// never destroys it.
    #[serde(default)]
    pub saved_pipelines: Vec<PlaybookPipeline>,
    pub updated_at_epoch_ms: u64,
}

/// A named delivery path a Project can switch to. Its stages keep their own
/// Routine references, so switching back finds the same Routines still there.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookPipeline {
    pub name: String,
    #[serde(default)]
    pub milestones: Vec<PlaybookMilestone>,
}

/// The current completion verdict for one pipeline stage and Task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybookStepVerdict {
    /// The Routine observed evidence that this Task completed the stage.
    Passed,
    /// The Routine looked and could not prove it yet.
    Waiting,
    /// The Routine could not inspect a required source or execute its check.
    /// This never advances the Task and remains distinct from ordinary waiting.
    Blocked,
}

/// One Task's current verdict for one stage of the pipeline it is walking.
///
/// This is current state, not history: a later run replaces the row rather than
/// appending to it. Rows exist only for the active pipeline, so a stage is
/// identified by its milestone ID alone; the evaluating Routine is recorded so
/// reusing an ID with another Routine invalidates the old verdict.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybookStepProgress {
    pub task_id: String,
    pub milestone_id: String,
    pub routine_id: String,
    pub verdict: PlaybookStepVerdict,
    /// Why the Routine reported this verdict, in its own words.
    #[serde(default)]
    pub evidence: String,
    pub decided_at_epoch_ms: u64,
    /// When this stage may be evaluated for this Task again. `None` once the
    /// Task has passed: a passed step is not re-evaluated.
    #[serde(default)]
    pub next_attempt_at_epoch_ms: Option<u64>,
    /// Who produced this verdict. Rows written before deterministic checks
    /// existed were all Routine answers.
    #[serde(default)]
    pub evaluator: PlaybookStepEvaluator,
    /// Set only on a Routine answer to a step whose deterministic check could
    /// not decide.
    #[serde(default)]
    pub deterministic_fallback: Option<PlaybookDeterministicFallback>,
}

/// Where one Task stands on a pipeline, derived from its stored answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybookPosition {
    /// The Task is waiting at this milestone index; it has passed every
    /// earlier one.
    At(usize),
    /// Every stage has a `passed` verdict.
    Done,
}

/// What a document written before pipelines had names calls its only pipeline.
fn default_pipeline_name() -> String {
    "Pipeline".to_string()
}

/// Where a Task stands on `milestones`, given the answers stored for it.
///
/// The pipeline is walked in order and the first stage this Task has not passed
/// is where it stands. An empty pipeline has no waiting position.
pub fn pipeline_position(
    milestones: &[PlaybookMilestone],
    answers: &[&PlaybookStepProgress],
) -> PlaybookPosition {
    for (index, milestone) in milestones.iter().enumerate() {
        let passed = answers.iter().any(|answer| {
            answer.milestone_id == milestone.id
                && answer.routine_id == milestone.routine_id
                && answer.verdict == PlaybookStepVerdict::Passed
        });
        if !passed {
            return PlaybookPosition::At(index);
        }
    }
    PlaybookPosition::Done
}

impl PlaybookStepProgress {
    pub fn is_valid(&self) -> bool {
        !self.task_id.trim().is_empty()
            && self.task_id.len() <= 256
            && valid_entry_id(&self.milestone_id)
            && valid_routine_reference(&self.routine_id)
            && valid_optional_text(&self.evidence, PLAYBOOK_EVIDENCE_MAX_BYTES)
            // A fallback explains why the Routine answered; a deterministic
            // answer has none.
            && (self.evaluator == PlaybookStepEvaluator::Routine
                || self.deterministic_fallback.is_none())
            && match self.verdict {
                // A passed step is never evaluated again, so a retry time on
                // one would let the engine act on it twice.
                PlaybookStepVerdict::Passed => self.next_attempt_at_epoch_ms.is_none(),
                PlaybookStepVerdict::Waiting | PlaybookStepVerdict::Blocked => {
                    self.next_attempt_at_epoch_ms.is_some()
                }
            }
    }
}

impl PlaybookPipeline {
    pub fn is_valid(&self) -> bool {
        valid_required_text(&self.name, PLAYBOOK_PIPELINE_NAME_MAX_BYTES)
            && self.milestones.len() <= PLAYBOOK_MILESTONES_MAX
            && self.milestones.iter().all(PlaybookMilestone::is_valid)
            && unique_ids(self.milestones.iter().map(|milestone| &milestone.id))
    }
}

impl PlaybookMilestone {
    pub fn is_valid(&self) -> bool {
        valid_routine_reference(&self.routine_id)
            && (PLAYBOOK_RETRY_DELAY_MIN_SECONDS..=PLAYBOOK_RETRY_DELAY_MAX_SECONDS)
                .contains(&self.retry_delay_seconds)
            && valid_entry_id(&self.id)
            && valid_required_text(&self.title, PLAYBOOK_TITLE_MAX_BYTES)
            && match (&self.gate, &self.approver) {
                (PlaybookGateKind::Human, Some(approver)) => {
                    valid_required_text(approver, PLAYBOOK_APPROVER_MAX_BYTES)
                }
                (PlaybookGateKind::Human, None) => false,
                (PlaybookGateKind::Automatic, approver) => approver.is_none(),
            }
            && match (&self.gate, &self.deterministic_check) {
                (_, None) => true,
                // A pull-request read cannot establish a named person's
                // approval, so a human gate never carries one.
                (PlaybookGateKind::Human, Some(_)) => false,
                (PlaybookGateKind::Automatic, Some(check)) => check.is_valid(),
            }
            // An Agent cannot approve on behalf of a named person.
            && !(self.gate == PlaybookGateKind::Human
                && self.agent_report == PlaybookAgentReportPolicy::Trusted)
    }
}

impl PlaybookDeterministicCheck {
    pub fn is_valid(&self) -> bool {
        // Commits are counted from the Task branch's own base, so naming
        // another target would describe a different question.
        if self.kind == PlaybookDeterministicCheckKind::BranchCommitted {
            return self.base_branch.is_none() && self.environment.is_none();
        }
        // An environment check names its environment and no branch.
        if self.kind == PlaybookDeterministicCheckKind::EnvironmentDeployed {
            return self.base_branch.is_none()
                && self
                    .environment
                    .as_deref()
                    .is_some_and(crate::valid_probe_environment);
        }
        if self.environment.is_some() {
            return false;
        }
        self.base_branch.as_deref().is_none_or(|branch| {
            !branch.is_empty()
                && branch.len() <= PLAYBOOK_BASE_BRANCH_MAX_BYTES
                && !branch
                    .chars()
                    .any(|character| character.is_control() || character.is_whitespace())
        })
    }
}

impl PlaybookConfiguration {
    pub fn is_valid(&self) -> bool {
        !self.project_id.trim().is_empty()
            && self.revision > 0
            && self.milestones.len() <= PLAYBOOK_MILESTONES_MAX
            && self.milestones.iter().all(PlaybookMilestone::is_valid)
            && unique_ids(self.milestones.iter().map(|milestone| &milestone.id))
            && valid_required_text(&self.active_pipeline_name, PLAYBOOK_PIPELINE_NAME_MAX_BYTES)
            && self.saved_pipelines.len() <= PLAYBOOK_SAVED_PIPELINES_MAX
            && self.saved_pipelines.iter().all(PlaybookPipeline::is_valid)
            // One name, one pipeline: two paths a user cannot tell apart on the
            // board could not be switched between with any confidence.
            && unique_ids(
                std::iter::once(&self.active_pipeline_name)
                    .chain(self.saved_pipelines.iter().map(|pipeline| &pipeline.name)),
            )
    }

    /// Every stage in the document, active or kept. Referential checks run
    /// over all of them: a kept pipeline naming a deleted Routine would break
    /// the moment the user switched back to it.
    pub fn all_milestones(&self) -> impl Iterator<Item = &PlaybookMilestone> {
        self.milestones.iter().chain(
            self.saved_pipelines
                .iter()
                .flat_map(|pipeline| pipeline.milestones.iter()),
        )
    }

    /// Whether stored progress still describes a stage in the active pipeline.
    /// Progress for removed stages is not retained because position is only
    /// meaningful on the path a Task is walking.
    pub fn progress_matches_current_step(&self, progress: &PlaybookStepProgress) -> bool {
        self.milestones.iter().any(|milestone| {
            milestone.id == progress.milestone_id && milestone.routine_id == progress.routine_id
        })
    }
}

/// The Routine a step points at. Existence is a store-level check because the
/// Routine lives outside this document; the value itself is only bounded here.
fn valid_routine_reference(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= PLAYBOOK_ROUTINE_ID_MAX_BYTES
}

fn valid_entry_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= PLAYBOOK_ENTRY_ID_MAX_BYTES
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn valid_required_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn valid_optional_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes
        && (value.is_empty() || !value.trim().is_empty())
        && !value
            .chars()
            .any(|character| character.is_control() && character != '\n')
}

fn unique_ids<'a>(ids: impl Iterator<Item = &'a String> + Clone) -> bool {
    ids.clone()
        .enumerate()
        .all(|(index, id)| !ids.clone().skip(index + 1).any(|other| other == id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn milestone(id: &str) -> PlaybookMilestone {
        PlaybookMilestone {
            id: id.into(),
            title: "PR approved".into(),
            gate: PlaybookGateKind::Human,
            routine_id: "routine-pr".into(),
            retry_delay_seconds: 600,
            approver: Some("ferit".into()),
            deterministic_check: None,
            agent_report: PlaybookAgentReportPolicy::Signal,
        }
    }

    fn playbook() -> PlaybookConfiguration {
        PlaybookConfiguration {
            project_id: "project-1".into(),
            revision: 1,
            active_pipeline_name: "Ship to production".into(),
            milestones: vec![milestone("pr-approved")],
            saved_pipelines: Vec::new(),
            updated_at_epoch_ms: 1,
        }
    }

    fn passed(task: &str, milestone_id: &str) -> PlaybookStepProgress {
        PlaybookStepProgress {
            task_id: task.into(),
            milestone_id: milestone_id.into(),
            routine_id: "routine-pr".into(),
            verdict: PlaybookStepVerdict::Passed,
            evidence: "Approval by ferit on the open PR.".into(),
            decided_at_epoch_ms: 10,
            next_attempt_at_epoch_ms: None,
            evaluator: PlaybookStepEvaluator::Routine,
            deterministic_fallback: None,
        }
    }

    #[test]
    fn a_project_keeps_the_pipelines_it_is_not_walking() {
        let kept = PlaybookPipeline {
            name: "Code review".into(),
            milestones: vec![milestone("pr-approved")],
        };
        let mut document = playbook();
        document.saved_pipelines = vec![kept.clone()];
        assert!(document.is_valid());
        // Every question counts, whichever pipeline holds it: a kept pipeline
        // naming a Routine that no longer exists would only break later.
        assert_eq!(document.all_milestones().count(), 2);

        // A pipeline is either the one in use or one of the kept ones. Two that
        // share a name could not be told apart on the board.
        let mut clashing = playbook();
        clashing.saved_pipelines = vec![PlaybookPipeline {
            name: clashing.active_pipeline_name.clone(),
            milestones: Vec::new(),
        }];
        assert!(!clashing.is_valid());

        let mut twice = playbook();
        twice.saved_pipelines = vec![kept.clone(), kept.clone()];
        assert!(!twice.is_valid());

        // A pipeline with no name cannot be switched to.
        let mut unnamed = playbook();
        unnamed.saved_pipelines = vec![PlaybookPipeline {
            name: "  ".into(),
            milestones: Vec::new(),
        }];
        assert!(!unnamed.is_valid());
        let mut anonymous_active = playbook();
        anonymous_active.active_pipeline_name = String::new();
        assert!(!anonymous_active.is_valid());

        // A kept pipeline's own questions are held to the same rules.
        let mut broken = playbook();
        broken.saved_pipelines = vec![PlaybookPipeline {
            name: "Code review".into(),
            milestones: vec![milestone("pr-approved"), milestone("pr-approved")],
        }];
        assert!(!broken.is_valid());

        let mut too_many = playbook();
        too_many.saved_pipelines = (0..=PLAYBOOK_SAVED_PIPELINES_MAX)
            .map(|index| PlaybookPipeline {
                name: format!("Pipeline {index}"),
                milestones: Vec::new(),
            })
            .collect();
        assert!(!too_many.is_valid());
    }

    #[test]
    fn a_task_stands_at_the_first_question_it_has_not_passed() {
        let mut document = playbook();
        document.milestones = vec![
            milestone("opened"),
            milestone("green"),
            milestone("shipped"),
        ];

        // No answers at all: the Task is at the very first question.
        assert_eq!(
            pipeline_position(&document.milestones, &[]),
            PlaybookPosition::At(0)
        );
        assert_eq!(
            pipeline_position(&document.milestones, &[&passed("task-1", "opened")]),
            PlaybookPosition::At(1)
        );

        // A later question answered out of order does not move the Task past
        // an earlier one it has not passed.
        assert_eq!(
            pipeline_position(&document.milestones, &[&passed("task-1", "shipped")]),
            PlaybookPosition::At(0)
        );

        let all = [
            passed("task-1", "opened"),
            passed("task-1", "green"),
            passed("task-1", "shipped"),
        ];
        assert_eq!(
            pipeline_position(&document.milestones, &all.iter().collect::<Vec<_>>()),
            PlaybookPosition::Done
        );

        // An answer recorded against a different Routine belongs to a question
        // this pipeline no longer asks, so it proves nothing here.
        let mut foreign = passed("task-1", "opened");
        foreign.routine_id = "routine-other".into();
        assert_eq!(
            pipeline_position(&document.milestones, &[&foreign]),
            PlaybookPosition::At(0)
        );
        assert!(!document.progress_matches_current_step(&foreign));
        assert!(document.progress_matches_current_step(&passed("task-1", "opened")));

        // A pipeline with no questions asks nothing of anyone.
        assert_eq!(pipeline_position(&[], &[]), PlaybookPosition::Done);
    }

    #[test]
    fn a_verdict_carries_a_retry_time_only_while_it_is_still_waiting() {
        let answer = passed("task-1", "pr-approved");
        assert!(answer.is_valid());

        let mut passed_with_retry = answer.clone();
        passed_with_retry.next_attempt_at_epoch_ms = Some(500);
        assert!(!passed_with_retry.is_valid());

        let mut waiting = answer.clone();
        waiting.verdict = PlaybookStepVerdict::Waiting;
        assert!(!waiting.is_valid());
        waiting.next_attempt_at_epoch_ms = Some(500);
        assert!(waiting.is_valid());

        let mut oversized = answer.clone();
        oversized.evidence = "x".repeat(PLAYBOOK_EVIDENCE_MAX_BYTES + 1);
        assert!(!oversized.is_valid());

        let mut anonymous = answer;
        anonymous.task_id = "  ".into();
        assert!(!anonymous.is_valid());
    }

    #[test]
    fn playbook_bounds_are_enforced() {
        assert!(playbook().is_valid());

        let mut oversized = playbook();
        oversized.milestones = (0..=PLAYBOOK_MILESTONES_MAX)
            .map(|index| milestone(&format!("milestone-{index}")))
            .collect();
        assert!(!oversized.is_valid());

        let mut zero_revision = playbook();
        zero_revision.revision = 0;
        assert!(!zero_revision.is_valid());
    }

    #[test]
    fn entry_ids_are_bounded_slugs_and_unique() {
        let mut duplicate = playbook();
        duplicate.milestones = vec![milestone("same"), milestone("same")];
        assert!(!duplicate.is_valid());

        let mut invalid_id = playbook();
        invalid_id.milestones[0].id = "no spaces allowed".into();
        assert!(!invalid_id.is_valid());

        let mut oversize_id = playbook();
        oversize_id.milestones[0].id = "x".repeat(PLAYBOOK_ENTRY_ID_MAX_BYTES + 1);
        assert!(!oversize_id.is_valid());
    }

    #[test]
    fn approver_is_human_gate_only() {
        let mut automatic_with_approver = playbook();
        automatic_with_approver.milestones[0].gate = PlaybookGateKind::Automatic;
        assert!(!automatic_with_approver.is_valid());

        let mut human_without_approver = playbook();
        human_without_approver.milestones[0].approver = None;
        assert!(!human_without_approver.is_valid());
    }

    fn automatic(check: Option<PlaybookDeterministicCheck>) -> PlaybookConfiguration {
        let mut document = playbook();
        document.milestones[0].gate = PlaybookGateKind::Automatic;
        document.milestones[0].approver = None;
        document.milestones[0].deterministic_check = check;
        document
    }

    #[test]
    fn deterministic_checks_are_automatic_only_and_bound_their_base_branch() {
        let check = |base: Option<&str>| PlaybookDeterministicCheck {
            kind: PlaybookDeterministicCheckKind::PullRequestMerged,
            base_branch: base.map(str::to_owned),
            environment: None,
        };
        assert!(automatic(None).is_valid());
        assert!(automatic(Some(check(None))).is_valid());
        assert!(automatic(Some(check(Some("release/2026.10")))).is_valid());
        let longest = "b".repeat(PLAYBOOK_BASE_BRANCH_MAX_BYTES);
        assert!(automatic(Some(check(Some(&longest)))).is_valid());

        for invalid in ["", " ", "has space", "tab\there", &"b".repeat(256)] {
            assert!(
                !automatic(Some(check(Some(invalid)))).is_valid(),
                "{invalid:?} must be rejected"
            );
        }

        let committed = |base: Option<&str>| PlaybookDeterministicCheck {
            kind: PlaybookDeterministicCheckKind::BranchCommitted,
            base_branch: base.map(str::to_owned),
            environment: None,
        };
        assert!(automatic(Some(committed(None))).is_valid());
        assert!(!automatic(Some(committed(Some("development")))).is_valid());

        let deployed = |environment: Option<&str>, base: Option<&str>| PlaybookDeterministicCheck {
            kind: PlaybookDeterministicCheckKind::EnvironmentDeployed,
            base_branch: base.map(str::to_owned),
            environment: environment.map(str::to_owned),
        };
        assert!(automatic(Some(deployed(Some("Production"), None))).is_valid());
        assert!(!automatic(Some(deployed(None, None))).is_valid());
        assert!(!automatic(Some(deployed(Some(" Production"), None))).is_valid());
        assert!(!automatic(Some(deployed(Some("Production"), Some("main")))).is_valid());
        // Only an environment check names an environment.
        let mut named = check(None);
        named.environment = Some("Production".into());
        assert!(!automatic(Some(named)).is_valid());

        // A pull-request read cannot prove a named person's approval.
        let mut human = playbook();
        human.milestones[0].deterministic_check = Some(check(None));
        assert!(!human.is_valid());

        // Kept pipelines are held to the same rule.
        let mut kept = automatic(None);
        kept.saved_pipelines = vec![PlaybookPipeline {
            name: "Kept".into(),
            milestones: human.milestones.clone(),
        }];
        assert!(!kept.is_valid());
    }

    #[test]
    fn only_a_routine_answer_explains_a_deterministic_fallback() {
        let mut routine = passed("task-1", "pr-approved");
        routine.deterministic_fallback = Some(PlaybookDeterministicFallback::MultipleMatches);
        assert!(routine.is_valid());

        let mut deterministic = routine.clone();
        deterministic.evaluator = PlaybookStepEvaluator::Deterministic;
        assert!(!deterministic.is_valid());
        deterministic.deterministic_fallback = None;
        assert!(deterministic.is_valid());
    }

    #[test]
    fn an_agent_report_can_pass_only_an_automatic_step() {
        // Documents written before agent reports treat a report as a signal.
        assert_eq!(
            PlaybookAgentReportPolicy::default(),
            PlaybookAgentReportPolicy::Signal
        );

        for policy in [
            PlaybookAgentReportPolicy::Off,
            PlaybookAgentReportPolicy::Signal,
            PlaybookAgentReportPolicy::Trusted,
        ] {
            let mut document = automatic(None);
            document.milestones[0].agent_report = policy;
            assert!(document.is_valid(), "{policy:?} on an automatic step");
        }

        // An Agent cannot approve on behalf of a named person.
        let mut human = playbook();
        human.milestones[0].agent_report = PlaybookAgentReportPolicy::Signal;
        assert!(human.is_valid());
        human.milestones[0].agent_report = PlaybookAgentReportPolicy::Trusted;
        assert!(!human.is_valid());

        let mut agent = passed("task-1", "pr-approved");
        agent.evaluator = PlaybookStepEvaluator::Agent;
        assert!(agent.is_valid());
        agent.deterministic_fallback = Some(PlaybookDeterministicFallback::Timeout);
        assert!(!agent.is_valid());
    }
}
