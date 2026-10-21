use super::*;
use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;
use termloop_domain::PlaybookStepProgress;
use termloop_providers::{Mergeability, ReviewState};

const NOW: u64 = 1_000_000;

fn pull_request(
    number: u64,
    state: PullRequestState,
    base: &str,
    checks: CheckState,
) -> PullRequestSummary {
    PullRequestSummary {
        provider: GitHostProvider::Github,
        host: "github.com".into(),
        repository_owner: "acme".into(),
        repository_project: None,
        repository_name: "widgets".into(),
        number,
        title: "Never quoted into evidence".into(),
        url: format!("https://github.com/acme/widgets/pull/{number}"),
        state,
        merge_commit_oid: None,
        base_branch: base.into(),
        head_branch: "feature/login".into(),
        head_repository_owner: "acme".into(),
        head_repository_project: None,
        head_repository_name: "widgets".into(),
        checks,
        review: ReviewState::NotReported,
        mergeability: Mergeability::Unknown,
        updated_at_epoch_ms: 1,
    }
}

fn read(pull_requests: Vec<PullRequestSummary>) -> PullRequestRead {
    PullRequestRead::Read {
        repository: "github.com/acme/widgets".into(),
        branch: "feature/login".into(),
        pull_requests,
        truncated: false,
    }
}

fn check(kind: PlaybookDeterministicCheckKind, base: Option<&str>) -> PlaybookDeterministicCheck {
    PlaybookDeterministicCheck {
        kind,
        base_branch: base.map(str::to_owned),
    }
}

use CheckState::{Failing, NotReported, Passing, Pending, Unknown, Unsupported};
use PlaybookDeterministicCheckKind::{
    BranchCommitted, PullRequestChecksPassing, PullRequestMerged, PullRequestOpen,
};
use PullRequestState::{Closed, Draft, Merged, Open};

#[test]
fn pull_request_open_needs_exactly_one_open_non_draft_pull_request() {
    let open = check(PullRequestOpen, None);
    assert_eq!(
        decide(
            &open,
            &read(vec![pull_request(42, Open, "develop", Pending)])
        ),
        DeterministicDecision::Passed(
            "PR #42 open on github.com/acme/widgets targeting develop.".into()
        )
    );
    assert_eq!(
        decide(&open, &read(vec![])),
        DeterministicDecision::Waiting(
            "No open pull request from feature/login on github.com/acme/widgets.".into()
        )
    );
    assert_eq!(
        decide(
            &open,
            &read(vec![pull_request(7, Draft, "develop", Passing)])
        ),
        DeterministicDecision::Waiting(
            "PR #7 from feature/login on github.com/acme/widgets is still a draft.".into()
        )
    );
    // A closed pull request is not an open one.
    assert!(matches!(
        decide(
            &open,
            &read(vec![pull_request(3, Closed, "develop", Passing)])
        ),
        DeterministicDecision::Waiting(_)
    ));
    // A pull request that already merged proves it was opened, but its CI is
    // no longer the open pull request's to report.
    let merged = read(vec![
        pull_request(3, Closed, "develop", Passing),
        pull_request(4, Merged, "develop", Passing),
    ]);
    assert_eq!(
        decide(&open, &merged),
        DeterministicDecision::Passed(
            "PR #4 from feature/login on github.com/acme/widgets was opened and has merged into develop."
                .into()
        )
    );
    assert_eq!(
        decide(&check(PullRequestChecksPassing, None), &merged),
        DeterministicDecision::Fallback(Fallback::ChecksUnsupported)
    );
    assert_eq!(
        decide(
            &open,
            &read(vec![
                pull_request(1, Open, "develop", Passing),
                pull_request(2, Open, "main", Passing),
            ])
        ),
        DeterministicDecision::Fallback(Fallback::MultipleMatches)
    );
}

#[test]
fn a_base_branch_filters_by_exact_target_before_counting_matches() {
    let to_develop = check(PullRequestOpen, Some("develop"));
    let both = read(vec![
        pull_request(1, Open, "develop", Passing),
        pull_request(2, Open, "main", Passing),
    ]);
    assert_eq!(
        decide(&to_develop, &both),
        DeterministicDecision::Passed(
            "PR #1 open on github.com/acme/widgets targeting develop.".into()
        )
    );
    assert_eq!(
        decide(
            &to_develop,
            &read(vec![pull_request(2, Open, "main", Passing)])
        ),
        DeterministicDecision::Waiting(
            "No open pull request from feature/login targeting develop on github.com/acme/widgets."
                .into()
        )
    );
    // Exact: neither a prefix nor a different case counts.
    assert!(matches!(
        decide(
            &to_develop,
            &read(vec![
                pull_request(3, Open, "develop-next", Passing),
                pull_request(4, Open, "Develop", Passing),
            ])
        ),
        DeterministicDecision::Waiting(_)
    ));
}

#[test]
fn checks_passing_reads_the_one_open_pull_requests_check_rollup() {
    let green = check(PullRequestChecksPassing, None);
    let one = |checks| read(vec![pull_request(42, Open, "develop", checks)]);
    assert_eq!(
        decide(&green, &one(Passing)),
        DeterministicDecision::Passed(
            "PR #42 open on github.com/acme/widgets targeting develop, checks passing.".into()
        )
    );
    assert_eq!(
        decide(&green, &one(Failing)),
        DeterministicDecision::Waiting(
            "PR #42 open on github.com/acme/widgets targeting develop, checks failing.".into()
        )
    );
    assert_eq!(
        decide(&green, &one(Pending)),
        DeterministicDecision::Waiting(
            "PR #42 open on github.com/acme/widgets targeting develop, checks pending.".into()
        )
    );
    for unreadable in [NotReported, Unsupported, Unknown] {
        assert_eq!(
            decide(&green, &one(unreadable)),
            DeterministicDecision::Fallback(Fallback::ChecksUnsupported)
        );
    }
    assert!(matches!(
        decide(&green, &read(vec![])),
        DeterministicDecision::Waiting(_)
    ));
    assert_eq!(
        decide(
            &green,
            &read(vec![
                pull_request(1, Open, "develop", Passing),
                pull_request(2, Open, "develop", Failing),
            ])
        ),
        DeterministicDecision::Fallback(Fallback::MultipleMatches)
    );
}

#[test]
fn pull_request_merged_needs_exactly_one_merged_pull_request() {
    let merged = check(PullRequestMerged, None);
    assert_eq!(
        decide(
            &merged,
            &read(vec![pull_request(42, Merged, "develop", Unknown)])
        ),
        DeterministicDecision::Passed(
            "PR #42 merged on github.com/acme/widgets targeting develop.".into()
        )
    );
    assert_eq!(
        decide(
            &merged,
            &read(vec![pull_request(42, Open, "develop", Passing)])
        ),
        DeterministicDecision::Waiting(
            "PR #42 from feature/login on github.com/acme/widgets is open and not merged yet."
                .into()
        )
    );
    assert_eq!(
        decide(&merged, &read(vec![])),
        DeterministicDecision::Waiting(
            "No merged pull request from feature/login on github.com/acme/widgets.".into()
        )
    );
    // A branch merged into two targets is ambiguous without a base branch,
    // and unambiguous with one.
    let twice = read(vec![
        pull_request(1, Merged, "develop", Unknown),
        pull_request(2, Merged, "main", Unknown),
    ]);
    assert_eq!(
        decide(&merged, &twice),
        DeterministicDecision::Fallback(Fallback::MultipleMatches)
    );
    assert!(matches!(
        decide(&check(PullRequestMerged, Some("main")), &twice),
        DeterministicDecision::Passed(evidence) if evidence.contains("PR #2")
    ));
}

#[test]
fn an_unavailable_or_partial_read_never_decides() {
    for reason in [
        Fallback::NoTaskBranch,
        Fallback::UnsupportedRepository,
        Fallback::ProviderUnavailable,
        Fallback::Unauthorized,
        Fallback::Offline,
        Fallback::RateLimited,
        Fallback::Timeout,
        Fallback::ProviderFailure,
    ] {
        assert_eq!(
            decide(
                &check(PullRequestOpen, None),
                &PullRequestRead::Unavailable(reason)
            ),
            DeterministicDecision::Fallback(reason)
        );
    }
    let partial = |pull_requests| PullRequestRead::Read {
        repository: "github.com/acme/widgets".into(),
        branch: "feature/login".into(),
        pull_requests,
        truncated: true,
    };
    // Neither "the only one" nor "none" can be proven from a partial read.
    assert_eq!(
        decide(
            &check(PullRequestOpen, None),
            &partial(vec![pull_request(1, Open, "develop", Passing)])
        ),
        DeterministicDecision::Fallback(Fallback::ProviderFailure)
    );
    assert_eq!(
        decide(&check(PullRequestMerged, None), &partial(vec![])),
        DeterministicDecision::Fallback(Fallback::ProviderFailure)
    );
}

#[test]
fn a_commit_check_passes_on_the_task_branchs_first_own_commit() {
    let counted = |count| CommitRead::Read {
        branch: "feature/login".into(),
        base: "origin/development".into(),
        count,
    };
    assert_eq!(
        decide_commits(&counted(0)),
        DeterministicDecision::Waiting(
            "feature/login has no commits of its own since origin/development.".into()
        )
    );
    assert_eq!(
        decide_commits(&counted(1)),
        DeterministicDecision::Passed(
            "feature/login has 1 commit of its own since origin/development.".into()
        )
    );
    assert_eq!(
        decide_commits(&counted(3)),
        DeterministicDecision::Passed(
            "feature/login has 3 commits of its own since origin/development.".into()
        )
    );
    assert_eq!(
        decide_commits(&CommitRead::Unavailable(Fallback::CommitsUnavailable)),
        DeterministicDecision::Fallback(Fallback::CommitsUnavailable)
    );
    assert_eq!(short_ref("refs/remotes/origin/main"), "origin/main");
    assert_eq!(short_ref("refs/heads/main"), "main");
}

#[test]
fn a_commit_check_reads_local_git_only_and_passes_through_the_verdict_path() {
    let committed = PlaybookDeterministicCheck {
        kind: BranchCommitted,
        base_branch: None,
    };
    let (mut runtime, root, capability) = claimed(committed, RoutineActionHandling::Off);
    let plan = runtime.plan_deterministic_step_check(&capability).unwrap();
    assert!(plan.github.is_none() && plan.azure.is_none());
    // The fixture Task has no branch, so the read stops before any Git work.
    let observation = plan.clone().observe();
    assert_eq!(
        observation.read,
        StepRead::Commits(CommitRead::Unavailable(Fallback::NoTaskBranch))
    );
    // A timed-out read stays a commit read.
    assert_eq!(
        plan.clone().timed_out().read,
        StepRead::Commits(CommitRead::Unavailable(Fallback::Timeout))
    );
    assert!(matches!(
        runtime
            .apply_deterministic_step_check(
                plan.observed(StepRead::Commits(CommitRead::Read {
                    branch: "feature/login".into(),
                    base: "origin/main".into(),
                    count: 2,
                })),
                NOW + 5,
            )
            .unwrap(),
        DeterministicStepOutcome::Recorded { .. }
    ));
    let recorded = answer(&runtime, "pr-open").expect("the verdict is stored");
    assert_eq!(recorded.verdict, PlaybookStepVerdict::Passed);
    assert_eq!(recorded.evaluator, PlaybookStepEvaluator::Deterministic);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn evidence_stays_within_the_stored_bound_on_a_character_boundary() {
    let long_branch = "ş".repeat(200);
    let evidence = match decide(
        &check(PullRequestMerged, Some(&"b".repeat(255))),
        &PullRequestRead::Read {
            repository: "github.com/acme/widgets".into(),
            branch: long_branch,
            pull_requests: vec![],
            truncated: false,
        },
    ) {
        DeterministicDecision::Waiting(evidence) => evidence,
        other => panic!("unexpected {other:?}"),
    };
    assert!(evidence.len() <= PLAYBOOK_EVIDENCE_MAX_BYTES);
    assert!(evidence.ends_with('…'));
}

/// A pipeline whose first step carries a deterministic check, with a fresh
/// claim for `task-1` at that step.
fn claimed(
    check: PlaybookDeterministicCheck,
    action_handling: RoutineActionHandling,
) -> (CoreRuntime, std::path::PathBuf, TrackerCheckCapability) {
    let (mut runtime, root, project_id) = pipeline_runtime();
    if action_handling != RoutineActionHandling::Off {
        let mut routine = runtime
            .store
            .tracker_configurations()
            .iter()
            .find(|routine| routine.id == "routine-pr")
            .unwrap()
            .clone();
        routine.action_handling = action_handling;
        routine.steward_instructions = "Offer to nudge the Task Agent.".into();
        let revision = runtime.store.revision();
        runtime
            .store
            .set_tracker_configuration(&runtime.write_authority, routine, revision)
            .unwrap();
    }
    let mut playbook = runtime
        .store
        .playbook_for_project(&project_id)
        .unwrap()
        .clone();
    playbook.revision += 1;
    playbook.milestones[0].deterministic_check = Some(check);
    let revision = runtime.store.revision();
    runtime
        .store
        .set_playbook_configuration(&runtime.write_authority, playbook, revision)
        .unwrap();
    let claim = runtime
        .claim_next_playbook_step(&project_id, "check-1".into(), NOW)
        .unwrap()
        .expect("task-1 is due at its first step");
    (runtime, root, claim.capability.unwrap())
}

fn answer<'a>(runtime: &'a CoreRuntime, milestone_id: &str) -> Option<&'a PlaybookStepProgress> {
    runtime
        .store
        .playbook_step_progress()
        .iter()
        .find(|answer| answer.task_id == "task-1" && answer.milestone_id == milestone_id)
}

fn apply(
    runtime: &mut CoreRuntime,
    capability: &TrackerCheckCapability,
    read: PullRequestRead,
) -> DeterministicStepOutcome {
    let plan = runtime
        .plan_deterministic_step_check(capability)
        .expect("the claimed step has a deterministic check");
    runtime
        .apply_deterministic_step_check(plan.observed(StepRead::PullRequests(read)), NOW + 5)
        .unwrap()
}

#[test]
fn a_deterministic_pass_is_recorded_through_the_routine_verdict_path() {
    let (mut runtime, root, capability) = claimed(
        check(PullRequestChecksPassing, Some("develop")),
        RoutineActionHandling::Off,
    );
    let outcome = apply(
        &mut runtime,
        &capability,
        read(vec![pull_request(42, Open, "develop", Passing)]),
    );
    let DeterministicStepOutcome::Recorded { result, .. } = outcome else {
        panic!("a decided pass is recorded");
    };
    assert_eq!(result["status"], "verdictsRecorded");
    assert_eq!(result["passedCount"], 1);
    let recorded = answer(&runtime, "pr-open").unwrap();
    assert_eq!(recorded.verdict, PlaybookStepVerdict::Passed);
    assert_eq!(recorded.evaluator, PlaybookStepEvaluator::Deterministic);
    assert_eq!(recorded.deterministic_fallback, None);
    assert_eq!(
        recorded.evidence,
        "PR #42 open on github.com/acme/widgets targeting develop, checks passing."
    );
    assert_eq!(recorded.next_attempt_at_epoch_ms, None);
    // The claim is finished and the Task now stands at the next step, which
    // is due right away rather than after this step's retry delay.
    assert!(!runtime.tracker_check_is_current(&capability));
    assert_eq!(
        runtime.playbook_step_due_epoch_ms("routine-deploy"),
        Some(0)
    );
    let runtime_view = runtime
        .playbook_runtime(serde_json::json!({"projectId": capability.project_id}))
        .unwrap();
    assert_eq!(
        runtime_view["steps"][0]["progress"][0]["evaluator"],
        "deterministic"
    );
    assert_eq!(
        runtime_view["steps"][0]["progress"][0]["deterministicFallback"],
        Value::Null
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn deterministic_waiting_is_recorded_when_no_waiting_action_is_configured() {
    let (mut runtime, root, capability) =
        claimed(check(PullRequestMerged, None), RoutineActionHandling::Off);
    let outcome = apply(
        &mut runtime,
        &capability,
        read(vec![pull_request(42, Open, "develop", Passing)]),
    );
    assert!(matches!(outcome, DeterministicStepOutcome::Recorded { .. }));
    let recorded = answer(&runtime, "pr-open").unwrap();
    assert_eq!(recorded.verdict, PlaybookStepVerdict::Waiting);
    assert_eq!(recorded.evaluator, PlaybookStepEvaluator::Deterministic);
    assert_eq!(recorded.next_attempt_at_epoch_ms, Some(NOW + 5 + 600_000));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn deterministic_waiting_with_waiting_actions_falls_through_to_the_routine() {
    let (mut runtime, root, capability) =
        claimed(check(PullRequestMerged, None), RoutineActionHandling::Ask);
    let outcome = apply(&mut runtime, &capability, read(vec![]));
    assert!(matches!(outcome, DeterministicStepOutcome::Routine));
    assert!(answer(&runtime, "pr-open").is_none());
    assert!(runtime.tracker_check_is_current(&capability));
    assert_eq!(
        runtime.claimed_step_evaluation(&capability),
        (PlaybookStepEvaluator::Routine, None)
    );
    // The Routine then answers exactly as it would without the check.
    runtime
        .report_steward_step_verdicts(
            &capability,
            vec![StewardStepVerdict {
                task_id: "task-1".into(),
                verdict: PlaybookStepVerdict::Waiting,
                evidence: "Not merged; the author has not responded.".into(),
            }],
            "report-1".into(),
            NOW + 10,
        )
        .unwrap();
    let recorded = answer(&runtime, "pr-open").unwrap();
    assert_eq!(recorded.evaluator, PlaybookStepEvaluator::Routine);
    assert_eq!(recorded.deterministic_fallback, None);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn an_undecidable_read_hands_the_claim_to_the_routine_with_its_reason() {
    let (mut runtime, root, capability) =
        claimed(check(PullRequestOpen, None), RoutineActionHandling::Off);
    let outcome = apply(
        &mut runtime,
        &capability,
        read(vec![
            pull_request(1, Open, "develop", Passing),
            pull_request(2, Open, "main", Passing),
        ]),
    );
    assert!(matches!(outcome, DeterministicStepOutcome::Routine));
    assert!(answer(&runtime, "pr-open").is_none());
    runtime
        .report_steward_step_verdicts(
            &capability,
            vec![StewardStepVerdict {
                task_id: "task-1".into(),
                verdict: PlaybookStepVerdict::Passed,
                evidence: "PR #1 is the delivery PR named in the Task brief.".into(),
            }],
            "report-1".into(),
            NOW + 10,
        )
        .unwrap();
    let recorded = answer(&runtime, "pr-open").unwrap();
    assert_eq!(recorded.evaluator, PlaybookStepEvaluator::Routine);
    assert_eq!(
        recorded.deterministic_fallback,
        Some(Fallback::MultipleMatches)
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_read_for_a_question_the_board_no_longer_asks_records_nothing() {
    let (mut runtime, root, capability) =
        claimed(check(PullRequestOpen, None), RoutineActionHandling::Off);
    let plan = runtime.plan_deterministic_step_check(&capability).unwrap();
    // The user changes the step's check while the read is running.
    let mut playbook = runtime
        .store
        .playbook_for_project(&capability.project_id)
        .unwrap()
        .clone();
    playbook.revision += 1;
    playbook.milestones[0].deterministic_check = Some(check(PullRequestMerged, None));
    let revision = runtime.store.revision();
    runtime
        .store
        .set_playbook_configuration(&runtime.write_authority, playbook, revision)
        .unwrap();
    let outcome = runtime
        .apply_deterministic_step_check(
            plan.observed(StepRead::PullRequests(read(vec![pull_request(
                42, Open, "develop", Passing,
            )]))),
            NOW + 5,
        )
        .unwrap();
    assert!(matches!(outcome, DeterministicStepOutcome::Routine));
    assert!(answer(&runtime, "pr-open").is_none());
    assert_eq!(
        runtime.claimed_step_evaluation(&capability),
        (PlaybookStepEvaluator::Routine, None)
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn a_step_without_a_deterministic_check_plans_no_read() {
    let (mut runtime, root, project_id) = pipeline_runtime();
    let claim = runtime
        .claim_next_playbook_step(&project_id, "check-1".into(), NOW)
        .unwrap()
        .unwrap();
    assert!(
        runtime
            .plan_deterministic_step_check(claim.capability.as_ref().unwrap())
            .is_none()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn no_task_branch_falls_back_without_any_git_or_provider_work() {
    let (mut runtime, root, capability) =
        claimed(check(PullRequestOpen, None), RoutineActionHandling::Off);
    let plan = runtime.plan_deterministic_step_check(&capability).unwrap();
    let observation = plan.observe();
    assert_eq!(
        observation.read,
        StepRead::PullRequests(PullRequestRead::Unavailable(Fallback::NoTaskBranch))
    );
    assert!(matches!(
        runtime
            .apply_deterministic_step_check(observation, NOW + 5)
            .unwrap(),
        DeterministicStepOutcome::Routine
    ));
    assert_eq!(
        runtime.claimed_step_evaluation(&capability),
        (PlaybookStepEvaluator::Routine, Some(Fallback::NoTaskBranch))
    );
    let _ = std::fs::remove_dir_all(root);
}

/// The display-only Git-host projection and the provider row cache both say
/// the Task branch has an open pull request. The gate must still read the
/// Git host itself; with no GitHub client available it cannot decide.
#[test]
fn cached_git_host_display_state_never_satisfies_the_gate() {
    let (mut runtime, root, capability) =
        claimed(check(PullRequestOpen, None), RoutineActionHandling::Off);
    let repository = root.join("repository");
    std::fs::create_dir_all(&repository).unwrap();
    let runner = termloop_gitio::GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &repository).unwrap();
    termloop_gitio::test_support::set_config(
        &runner,
        &repository,
        "remote.origin.url",
        "https://github.com/acme/widgets.git",
    )
    .unwrap();
    // Bind task-1 to a branch on that repository.
    runtime
        .store
        .bind_task_branch(
            &runtime.write_authority,
            "task-1",
            termloop_domain::TaskBranchBinding {
                repository_root: repository.to_string_lossy().into_owned(),
                name: "feature/login".into(),
            },
            NOW,
        )
        .unwrap();
    assert!(runtime.github_client.is_none());

    let cached = termloop_store::CachedPullRequest {
        provider: "github".into(),
        host: "github.com".into(),
        repository_owner: "acme".into(),
        repository_project: None,
        repository_name: "widgets".into(),
        number: 42,
        title: "Login".into(),
        url: "https://github.com/acme/widgets/pull/42".into(),
        state: "open".into(),
        merge_commit_oid: None,
        base_branch: "develop".into(),
        head_branch: "feature/login".into(),
        head_repository_owner: "acme".into(),
        head_repository_project: None,
        head_repository_name: "widgets".into(),
        checks: "passing".into(),
        review: "approved".into(),
        mergeability: "mergeable".into(),
        updated_at_epoch_ms: NOW,
    };
    let _ = runtime
        .provider_cache
        .update(termloop_store::ProviderCacheRow {
            key: "github|github.com|acme/widgets|feature/login".into(),
            matches: vec![cached.clone()],
            truncated: false,
            parent_resolved: true,
            failure: None,
            last_success_observed_at: Some(NOW),
            last_attempt_observed_at: NOW,
            retry_after: None,
        });
    runtime.git_host_projections.insert(
        capability.project_id.clone(),
        super::super::GitHostTaskProjection {
            usage: "displayOnly",
            task_id: "task-1".into(),
            branch_name: Some("feature/login".into()),
            repository_provider: Some("github".into()),
            repository_host: Some("github.com".into()),
            repository_owner: Some("acme".into()),
            repository_project: None,
            repository_name: Some("widgets".into()),
            quality: super::super::GitHostProjectionQuality::Matches,
            freshness: super::super::GitHostProjectionFreshness::Fresh,
            reason: None,
            matches: vec![super::super::projection_summary(&cached)],
            truncated: false,
            candidate_truncated: false,
            freshness_generation: NOW,
            last_success_observed_at_epoch_ms: Some(NOW),
            last_attempt_observed_at_epoch_ms: NOW,
        },
    );

    let observation = runtime
        .plan_deterministic_step_check(&capability)
        .unwrap()
        .observe();
    assert_eq!(
        observation.read,
        StepRead::PullRequests(PullRequestRead::Unavailable(Fallback::ProviderUnavailable))
    );
    assert!(matches!(
        runtime
            .apply_deterministic_step_check(observation, NOW + 5)
            .unwrap(),
        DeterministicStepOutcome::Routine
    ));
    assert!(answer(&runtime, "pr-open").is_none());
    assert_eq!(
        runtime.claimed_step_evaluation(&capability),
        (
            PlaybookStepEvaluator::Routine,
            Some(Fallback::ProviderUnavailable)
        )
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn stored_documents_and_answers_written_before_deterministic_checks_still_load() {
    let milestone: termloop_domain::PlaybookMilestone = serde_json::from_value(serde_json::json!({
        "id": "merged",
        "title": "Merged",
        "gate": "automatic",
        "routineId": "routine-1",
        "retryDelaySeconds": 600,
        "approver": null
    }))
    .unwrap();
    assert_eq!(milestone.deterministic_check, None);
    let answer: PlaybookStepProgress = serde_json::from_value(serde_json::json!({
        "taskId": "task-1",
        "milestoneId": "merged",
        "routineId": "routine-1",
        "verdict": "passed",
        "evidence": "Merged.",
        "decidedAtEpochMs": 10,
        "nextAttemptAtEpochMs": null
    }))
    .unwrap();
    assert_eq!(answer.evaluator, PlaybookStepEvaluator::Routine);
    assert_eq!(answer.deterministic_fallback, None);

    let mut checked = milestone;
    checked.deterministic_check = Some(check(PullRequestChecksPassing, Some("develop")));
    let encoded = serde_json::to_value(&checked).unwrap();
    assert_eq!(
        encoded["deterministicCheck"],
        serde_json::json!({"kind": "pullRequestChecksPassing", "baseBranch": "develop"})
    );
    assert_eq!(
        serde_json::from_value::<termloop_domain::PlaybookMilestone>(encoded).unwrap(),
        checked
    );
}
