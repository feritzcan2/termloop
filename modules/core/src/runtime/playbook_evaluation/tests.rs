use super::*;
use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;
use crate::session_launch::PlaybookEvaluationLaunch;
use termloop_domain::{
    PlaybookStepVerdict, ResumeProvider, ResumeRef, TaskBranchBinding, TaskWorktreeBinding,
};

fn observation(state: AgentState, sequence: u64, time: u64) -> AgentObservation {
    AgentObservation {
        state,
        source: termloop_agents::AgentSignalSource::Hook,
        sequence,
        observed_at_epoch_ms: time,
    }
}

pub(crate) fn attach_agents(runtime: &mut CoreRuntime, root: &std::path::Path, ids: &[&str]) {
    use termloop_domain::{
        ManagedWorktreeProof, NormalizedWorktreeSpec, ProvisioningBranchMode, ProvisioningStage,
        WorktreeProvisioningOperation,
    };
    let path = root.to_string_lossy().into_owned();
    let spec = NormalizedWorktreeSpec {
        version: 1,
        repository_root: path.clone(),
        repository_common_dir: format!("{path}/.git"),
        destination_path: path.clone(),
        branch_name: "task/evaluation".into(),
        branch_mode: ProvisioningBranchMode::Create,
        base_ref: Some("refs/heads/main".into()),
        base_oid: Some("a".repeat(40)),
    };
    runtime
        .store
        .begin_task_worktree_provisioning(
            &runtime.write_authority,
            WorktreeProvisioningOperation {
                operation_id: "provision-evaluation".into(),
                task_id: "task-1".into(),
                project_id: runtime
                    .store
                    .tasks()
                    .iter()
                    .find(|t| t.id == "task-1")
                    .unwrap()
                    .project_id
                    .clone(),
                spec: spec.clone(),
                stage: ProvisioningStage::Reserved,
                created_branch_ref: false,
                failure: None,
                started_at_epoch_ms: 2,
                updated_at_epoch_ms: 2,
            },
        )
        .unwrap();
    runtime
        .store
        .advance_task_worktree_provisioning(
            &runtime.write_authority,
            "task-1",
            "provision-evaluation",
            ProvisioningStage::WorktreeAdded,
            true,
            3,
        )
        .unwrap();
    runtime
        .store
        .commit_task_worktree_provisioning(
            &runtime.write_authority,
            "task-1",
            "provision-evaluation",
            termloop_store::ProvisioningCommit {
                branch: TaskBranchBinding {
                    repository_root: path.clone(),
                    name: "task/evaluation".into(),
                },
                worktree: TaskWorktreeBinding { path: path.clone() },
                proof: ManagedWorktreeProof {
                    task_id: "task-1".into(),
                    operation_id: "provision-evaluation".into(),
                    worktree_generation: 0,
                    normalized_spec_version: 1,
                    normalized_spec: spec,
                    repository_common_dir: format!("{path}/.git"),
                    registered_worktree_path: path,
                    branch_ref: "refs/heads/task/evaluation".into(),
                },
                updated_at_epoch_ms: 4,
            },
        )
        .unwrap();
    runtime
        .store
        .clear_task_worktree_provisioning(
            &runtime.write_authority,
            "task-1",
            "provision-evaluation",
        )
        .unwrap();
    for id in ids {
        let mut session = runtime
            .store
            .sessions()
            .iter()
            .find(|s| s.id == "steward-session")
            .unwrap()
            .clone();
        session.id = (*id).into();
        session.process.template_ref = Some("builtin.agent.interactive".into());
        session.launch_selection =
            termloop_domain::AgentLaunchSelection::new("gpt-6-astra", "bypassPermissions", "high");
        session.resume_ref =
            Some(ResumeRef::for_provider(ResumeProvider::Codex, format!("native-{id}")).unwrap());
        runtime
            .store
            .insert_session(&runtime.write_authority, session)
            .unwrap();
    }
    runtime
        .configure_agent_observations(crate::test_agent_observation_transport(root.to_path_buf()));
}

fn claim(runtime: &mut CoreRuntime, project: &str) -> StewardRoutineClaim {
    runtime
        .claim_next_steward_routine(
            project,
            "steward-session",
            "evaluation-check".into(),
            termloop_platform::current_epoch_ms(),
        )
        .unwrap()
}

fn evaluator(runtime: &mut CoreRuntime, claim: &StewardRoutineClaim) {
    runtime
        .reserve_playbook_evaluation(claim, "source".into(), "reviewer".into(), 1)
        .unwrap();
    let capability = claim.capability.as_ref().unwrap();
    runtime
        .store
        .start_playbook_evaluation(
            &runtime.write_authority,
            termloop_domain::PlaybookEvaluationRecord {
                id: capability.check_id.clone(),
                project_id: capability.project_id.clone(),
                task_id: "task-1".into(),
                task_title: "Task snapshot".into(),
                milestone_id: claim.result["step"]["milestoneId"].as_str().unwrap().into(),
                milestone_title: "Step snapshot".into(),
                source_session_id: "source".into(),
                source_name: "Implementer".into(),
                session_id: "reviewer".into(),
                agent_id: "codex".into(),
                model: "gpt-6-luna".into(),
                permission: "plan".into(),
                started_at_epoch_ms: capability.claimed_at_epoch_ms,
                finished_at_epoch_ms: None,
                outcome: termloop_domain::PlaybookEvaluationOutcome::InProgress,
                evidence: String::new(),
            },
        )
        .unwrap();
    let mut session = runtime
        .store
        .sessions()
        .iter()
        .find(|s| s.id == "steward-session")
        .unwrap()
        .clone();
    session.id = "reviewer".into();
    session.process.template_ref = Some(EVALUATOR_TEMPLATE.into());
    session.launch_selection.permission = "plan".into();
    runtime
        .store
        .insert_session(&runtime.write_authority, session)
        .unwrap();
    runtime.mcp_authorizer.register(
        "reviewer".into(),
        1,
        AgentMcpRole::PlaybookEvaluator {
            check_id: "evaluation-check".into(),
        },
        "reviewer-token".into(),
    );
}

#[test]
fn activity_counts_work_and_ignores_duplicate_signals_and_idle_time() {
    let mut activity = TaskAgentActivity::default();
    activity.observe(observation(AgentState::Working, 1, 100));
    activity.observe(observation(AgentState::Idle, 2, 300));
    activity.observe(observation(AgentState::Working, 1, 500));
    assert_eq!(activity.score(10_000), (200, 300));
    activity.observe(observation(AgentState::Working, 3, 10_000));
    assert_eq!(activity.score(10_500), (700, 10_000));
}

#[test]
fn most_observed_task_work_wins_and_evaluators_never_become_candidates() {
    let (mut runtime, root, project) = pipeline_runtime();
    attach_agents(&mut runtime, &root, &["source", "second"]);
    assert_eq!(
        runtime
            .select_playbook_source(&project, "task-1", 1_000)
            .unwrap(),
        None
    );
    let working = observation(AgentState::Working, 1, 100);
    runtime.observe_task_agent_work("source", None, working);
    runtime.observe_task_agent_work(
        "source",
        Some(working),
        observation(AgentState::Idle, 2, 800),
    );
    runtime.observe_task_agent_work("second", None, working);
    runtime.observe_task_agent_work(
        "second",
        Some(working),
        observation(AgentState::Idle, 2, 200),
    );
    assert_eq!(
        runtime
            .select_playbook_source(&project, "task-1", 1_000)
            .unwrap()
            .as_deref(),
        Some("source")
    );
    let mut reviewer = runtime
        .store
        .sessions()
        .iter()
        .find(|s| s.id == "source")
        .unwrap()
        .clone();
    reviewer.id = "reviewer".into();
    reviewer.process.template_ref = Some(EVALUATOR_TEMPLATE.into());
    runtime
        .store
        .insert_session(&runtime.write_authority, reviewer)
        .unwrap();
    runtime.observe_task_agent_work("reviewer", None, working);
    assert!(
        !runtime
            .playbook_evaluation
            .activity
            .contains_key("reviewer")
    );
    let statuses = runtime
        .task_agent_status_projection_for_executor(&project, "task-1")
        .unwrap();
    assert!(
        !statuses
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["sessionId"] == "reviewer")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_unmeasured_single_agent_is_usable_and_duplicate_claim_reuses_one_fork() {
    let (mut runtime, root, project) = pipeline_runtime();
    attach_agents(&mut runtime, &root, &["source"]);
    let claim = claim(&mut runtime, &project);
    let first = runtime.plan_playbook_evaluation(&claim).unwrap();
    let PlaybookEvaluationLaunch::Fork { plan, result, .. } = first else {
        panic!("expected fork");
    };
    assert_eq!(result["evaluation"]["sourceSessionId"], "source");
    let second = runtime.plan_playbook_evaluation(&claim).unwrap();
    assert!(
        matches!(second, PlaybookEvaluationLaunch::Delegated(value) if value["evaluation"]["sessionId"] == plan.session_id())
    );
    assert_eq!(runtime.playbook_evaluation.evaluations.len(), 1);
    let history = runtime
        .playbook_evaluation_history(json!({"projectId": project}))
        .unwrap();
    assert_eq!(history["entries"].as_array().unwrap().len(), 1);
    assert_eq!(history["entries"][0]["sessionId"], plan.session_id());
    assert_eq!(history["entries"][0]["sourceSessionId"], "source");
    assert_eq!(history["entries"][0]["model"], "gpt-6-astra");
    assert_eq!(history["entries"][0]["outcome"], "inProgress");
    runtime
        .fail_playbook_evaluation_launch("evaluation-check")
        .unwrap();
    assert!(
        matches!(runtime.plan_playbook_evaluation(&claim).unwrap(), PlaybookEvaluationLaunch::Steward(value) if value["evaluation"]["reason"] == "forkUnavailable")
    );
    assert!(runtime.playbook_evaluation.evaluations.is_empty());
    assert_eq!(
        runtime.store.playbook_evaluations()[0].outcome,
        termloop_domain::PlaybookEvaluationOutcome::Failed
    );
    runtime
        .report_steward_step_verdicts(
            claim.capability.as_ref().unwrap(),
            vec![StewardStepVerdict {
                task_id: "task-1".into(),
                verdict: PlaybookStepVerdict::Passed,
                evidence: "Fallback proof".into(),
            }],
            "fallback-report".into(),
            termloop_platform::current_epoch_ms(),
        )
        .unwrap();
    assert_eq!(
        runtime.store.playbook_evaluations()[0].outcome,
        termloop_domain::PlaybookEvaluationOutcome::Failed
    );

    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn no_task_agent_preserves_an_explicit_steward_fallback() {
    let (mut runtime, root, project) = pipeline_runtime();
    let claim = claim(&mut runtime, &project);
    assert!(
        matches!(runtime.plan_playbook_evaluation(&claim).unwrap(), PlaybookEvaluationLaunch::Steward(value) if value["evaluation"]["reason"] == "noUnambiguousTaskAgent")
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn evaluation_projection_tracks_startup_executor_fallback_and_completion() {
    let (mut runtime, root, project) = pipeline_runtime();
    assert!(
        runtime
            .playbook_runtime(json!({"projectId": project}))
            .unwrap()["evaluation"]
            .is_null()
    );
    let mut claim = claim(&mut runtime, &project);
    let read = |runtime: &CoreRuntime| {
        runtime
            .playbook_runtime(json!({"projectId": project}))
            .unwrap()["evaluation"]
            .clone()
    };
    assert_eq!(read(&runtime)["mode"], "starting");
    evaluator(&mut runtime, &claim);
    runtime.pending_agent_forks.insert("reviewer".into());
    let starting = read(&runtime);
    assert_eq!(starting["mode"], "starting");
    assert_eq!(starting["sourceSessionId"], "source");
    assert!(starting["sessionId"].is_null());
    runtime.pending_agent_forks.remove("reviewer");
    let active = read(&runtime);
    assert_eq!(active["mode"], "taskAgentFork");
    assert_eq!(active["sessionId"], "reviewer");
    assert_eq!(active["taskId"], "task-1");
    assert_eq!(
        active["routineId"],
        claim.capability.as_ref().unwrap().tracker_id
    );
    assert!(active["reason"].is_null());
    runtime
        .fail_playbook_evaluation_launch("evaluation-check")
        .unwrap();
    let fallback = read(&runtime);
    assert_eq!(fallback["mode"], "stewardFallback");
    assert_eq!(fallback["reason"], "forkUnavailable");
    assert_eq!(fallback["sessionId"], "steward-session");
    assert!(fallback["sourceSessionId"].is_null());
    for reason in [
        "noUnambiguousTaskAgent",
        "forkUnsupported",
        "evaluationCapacity",
    ] {
        claim.result["evaluation"] = json!({"mode":"stewardFallback", "reason":reason});
        runtime.record_playbook_evaluation_fallback(&claim);
        assert_eq!(read(&runtime)["reason"], reason);
    }
    runtime
        .report_steward_step_verdicts(
            claim.capability.as_ref().unwrap(),
            vec![StewardStepVerdict {
                task_id: "task-1".into(),
                verdict: PlaybookStepVerdict::Passed,
                evidence: "Current proof".into(),
            }],
            "report".into(),
            termloop_platform::current_epoch_ms(),
        )
        .unwrap();
    assert!(read(&runtime).is_null());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn verdict_requires_exact_fork_read_and_advances_once_without_steward_overwrite() {
    let (mut runtime, root, project) = pipeline_runtime();
    let claim = claim(&mut runtime, &project);
    evaluator(&mut runtime, &claim);
    assert!(matches!(
        runtime.complete_playbook_evaluation(
            "reviewer-token",
            "evaluation-check",
            PlaybookStepVerdict::Passed,
            "PR 42 verified".into()
        ),
        Err(CoreError::CapabilityDenied)
    ));
    assert!(matches!(
        runtime.read_playbook_evaluation("wrong-token"),
        Err(CoreError::CapabilityDenied)
    ));
    assert!(matches!(
        runtime.send_to_agent("reviewer-token", "steward-session", "Do something"),
        Err(CoreError::CapabilityDenied)
    ));
    let read = runtime.read_playbook_evaluation("reviewer-token").unwrap();
    assert_eq!(read["task"]["id"], "task-1");
    assert_eq!(
        read["assignment"]["step"]["finishWith"],
        "playbook_evaluation_complete"
    );
    assert_eq!(
        read["assignment"]["step"]["taskRead"]["tool"],
        "playbook_evaluation_read"
    );
    assert!(matches!(
        runtime.complete_playbook_evaluation(
            "reviewer-token",
            "other-check",
            PlaybookStepVerdict::Passed,
            "PR 42 verified".into()
        ),
        Err(CoreError::CapabilityDenied)
    ));
    assert!(matches!(
        runtime.report_steward_step_verdicts(
            claim.capability.as_ref().unwrap(),
            vec![StewardStepVerdict {
                task_id: "task-1".into(),
                verdict: PlaybookStepVerdict::Passed,
                evidence: "Unrequested Steward answer".into()
            }],
            "steward-report".into(),
            termloop_platform::current_epoch_ms()
        ),
        Err(CoreError::CapabilityDenied)
    ));
    let before_completion = runtime.state_revision();
    let completed = runtime
        .complete_playbook_evaluation(
            "reviewer-token",
            "evaluation-check",
            PlaybookStepVerdict::Passed,
            "PR 42 verified".into(),
        )
        .unwrap();
    assert_eq!(completed["result"]["passedCount"], 1);
    assert_eq!(runtime.state_revision(), before_completion + 1);
    let history = runtime
        .playbook_evaluation_history(json!({"projectId": project}))
        .unwrap();
    assert_eq!(history["entries"][0]["outcome"], "passed");
    assert_eq!(history["entries"][0]["evidence"], "PR 42 verified");
    assert_eq!(history["entries"][0]["taskTitle"], "Task snapshot");

    assert_eq!(runtime.store.playbook_step_progress().len(), 1);
    assert!(matches!(
        runtime.retire_playbook_evaluator_descriptor("steward-session"),
        Err(CoreError::CapabilityDenied)
    ));
    runtime
        .retire_playbook_evaluator_descriptor("reviewer")
        .unwrap();
    assert!(
        runtime
            .store
            .sessions()
            .iter()
            .any(|s| s.id == "steward-session")
    );
    assert!(matches!(
        runtime.complete_playbook_evaluation(
            "reviewer-token",
            "evaluation-check",
            PlaybookStepVerdict::Passed,
            "PR 42 verified".into()
        ),
        Err(CoreError::CapabilityDenied)
    ));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn changing_policy_or_manually_moving_task_rejects_the_in_flight_answer() {
    for policy_change in [false, true] {
        let (mut runtime, root, project) = pipeline_runtime();
        let claim = claim(&mut runtime, &project);
        evaluator(&mut runtime, &claim);
        runtime.read_playbook_evaluation("reviewer-token").unwrap();
        if policy_change {
            let mut playbook = runtime
                .store
                .playbook_for_project(&project)
                .unwrap()
                .clone();
            playbook.revision += 1;
            runtime
                .store
                .set_playbook_configuration(
                    &runtime.write_authority,
                    playbook,
                    runtime.state_revision(),
                )
                .unwrap();
        } else {
            runtime
                .set_task_playbook_position(
                    &project,
                    "task-1",
                    2,
                    1,
                    runtime.state_revision(),
                    termloop_platform::current_epoch_ms(),
                )
                .unwrap();
        }
        assert!(matches!(
            runtime.complete_playbook_evaluation(
                "reviewer-token",
                "evaluation-check",
                PlaybookStepVerdict::Passed,
                "Old evidence".into()
            ),
            Err(CoreError::TrackerReportStale)
        ));
        runtime.obsolete_playbook_evaluator_sessions().unwrap();
        assert_eq!(
            runtime.store.playbook_evaluations()[0].outcome,
            termloop_domain::PlaybookEvaluationOutcome::Interrupted
        );
        assert!(
            runtime
                .mcp_authorizer
                .authenticate("reviewer-token")
                .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn fork_exit_without_a_verdict_is_recorded_as_interrupted_before_claim_expiry() {
    let (mut runtime, root, project) = pipeline_runtime();
    let claim = claim(&mut runtime, &project);
    evaluator(&mut runtime, &claim);
    runtime
        .store
        .mark_session_exited(&runtime.write_authority, "reviewer")
        .unwrap();
    assert_eq!(
        runtime.obsolete_playbook_evaluator_sessions().unwrap(),
        vec!["reviewer"]
    );
    let history = runtime
        .playbook_evaluation_history(json!({"projectId": project}))
        .unwrap();
    assert_eq!(history["entries"][0]["outcome"], "interrupted");
    assert_eq!(
        history["entries"][0]["evidence"],
        "The fork agent exited before recording a result."
    );
    runtime
        .retire_playbook_evaluator_descriptor("reviewer")
        .unwrap();
    assert_eq!(runtime.store.playbook_evaluations().len(), 1);
    std::fs::remove_dir_all(root).unwrap();
}
