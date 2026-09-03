use super::*;

#[test]
fn health_and_presence_sequences_advance_only_for_semantic_changes() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    let clean = runner.inspect_worktree_health(&destination).unwrap();
    let first = fixture
        .runtime
        .apply_task_worktree_health(&task_id, clean.clone(), 10)
        .unwrap();
    assert!(first.changed);
    let first_health = fixture
        .runtime
        .cached_task_worktree_health(&task_id)
        .unwrap();
    assert!(first_health.launch_ready);
    assert_eq!(
        first_health.checked_out_branch.as_deref(),
        Some("feature/cleanup")
    );
    let mut evidence_only_change = clean.clone();
    evidence_only_change.git_process_count += 1;
    let unchanged = fixture
        .runtime
        .apply_task_worktree_health(&task_id, evidence_only_change, 20)
        .unwrap();
    assert!(!unchanged.changed);
    assert_eq!(unchanged.observation_sequence, first.observation_sequence);
    assert_eq!(
        fixture
            .runtime
            .cached_task_worktree_health(&task_id)
            .unwrap()
            .observed_at_epoch_ms,
        20
    );
    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["decision"], "allowed");
    assert!(preview["health"]["observation_sequence"].as_u64().unwrap() > 0);
    assert!(
        preview["presence"]["observation_sequence"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(preview["warnings"], json!(["upstreamNotConfigured"]));

    for (path, registration, head) in [
        (
            WorktreePathProjectionState::Absent,
            WorktreeRegistrationProjectionState::Absent,
            WorktreeHeadProjectionState::Missing,
        ),
        (
            WorktreePathProjectionState::Replaced,
            WorktreeRegistrationProjectionState::Mismatch,
            WorktreeHeadProjectionState::Mismatch,
        ),
        (
            WorktreePathProjectionState::Unknown,
            WorktreeRegistrationProjectionState::Unknown,
            WorktreeHeadProjectionState::Unknown,
        ),
    ] {
        fixture
            .runtime
            .apply_task_worktree_health_facts(
                &task_id,
                TaskWorktreeHealthFacts::unknown(path, registration, head),
                21,
            )
            .unwrap();
        let projected = fixture
            .runtime
            .cached_task_worktree_health(&task_id)
            .unwrap();
        assert_eq!(projected.path_state, path);
        assert_eq!(projected.registration_state, registration);
        assert_eq!(projected.head_state, head);
        assert!(!projected.launch_ready);
        assert!(projected.checked_out_branch.is_none());
        assert_eq!(projected.summary, WorktreeHealthSummary::Unknown);
    }

    std::fs::write(destination.join("new.txt"), "untracked\n").unwrap();
    let changed = fixture
        .runtime
        .apply_task_worktree_health(
            &task_id,
            runner.inspect_worktree_health(&destination).unwrap(),
            30,
        )
        .unwrap();
    assert!(changed.changed);
    assert!(changed.observation_sequence > first.observation_sequence);

    let first_presence = fixture
        .runtime
        .observe_task_worktree_presence(&task_id, 40)
        .unwrap();
    let unchanged_presence = fixture
        .runtime
        .observe_task_worktree_presence(&task_id, 50)
        .unwrap();
    assert!(!unchanged_presence.changed);
    assert_eq!(
        first_presence.observation_sequence,
        unchanged_presence.observation_sequence
    );
    let nested = destination.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: "nested-session".into(),
                project_id: fixture.project_id.clone(),
                name: None,
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "agent".into(),
                    args: vec![],
                    cwd: nested.to_string_lossy().into_owned(),
                    agent_id: Some("codex".into()),
                    template_ref: None,
                    template_version: None,
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: None,
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let changed_presence = fixture
        .runtime
        .observe_task_worktree_presence(&task_id, 60)
        .unwrap();
    assert!(changed_presence.changed);
    let presence = fixture
        .runtime
        .cached_task_worktree_presence(&task_id)
        .unwrap();
    assert_eq!(presence.total_count, 1);
    assert_eq!(presence.agent_count, 1);
}

#[test]
fn alternate_branch_and_detached_head_both_stay_launchable() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::checkout_new_branch(&runner, &destination, "agent/current-work")
        .unwrap();
    fixture
        .runtime
        .apply_task_worktree_health(
            &task_id,
            runner.inspect_worktree_health(&destination).unwrap(),
            10,
        )
        .unwrap();
    let projected = fixture
        .runtime
        .cached_task_worktree_health(&task_id)
        .unwrap();
    assert_eq!(projected.head_state, WorktreeHeadProjectionState::Mismatch);
    assert!(projected.launch_ready);
    assert_eq!(
        projected.checked_out_branch.as_deref(),
        Some("agent/current-work")
    );
    fixture
        .runtime
        .plan_task_worktree_launch(json!({ "taskId": task_id }), false)
        .unwrap()
        .observe(Duration::from_secs(5))
        .unwrap();

    // A mid-rebase-style detached HEAD is an ordinary working state, not a
    // launch blocker. The branch display honestly goes blank while the
    // Task stays launchable under its registration identity.
    termloop_gitio::test_support::detach_head(&runner, &destination).unwrap();
    fixture
        .runtime
        .apply_task_worktree_health(
            &task_id,
            runner.inspect_worktree_health(&destination).unwrap(),
            20,
        )
        .unwrap();
    let projected = fixture
        .runtime
        .cached_task_worktree_health(&task_id)
        .unwrap();
    assert!(projected.launch_ready);
    assert!(projected.checked_out_branch.is_none());
    fixture
        .runtime
        .plan_task_worktree_launch(json!({ "taskId": task_id }), false)
        .unwrap()
        .observe(Duration::from_secs(5))
        .unwrap();
}

#[test]
fn exact_worktree_branch_evidence_becomes_durable_and_drives_commit_review() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::checkout_new_branch(&runner, &destination, "agent/secondary")
        .unwrap();
    std::fs::write(destination.join("secondary.txt"), "secondary\n").unwrap();
    termloop_gitio::test_support::commit_all(&runner, &destination, "secondary commit").unwrap();

    let observed = fixture
        .runtime
        .plan_task_worktree_health(&task_id)
        .unwrap()
        .observe();
    fixture
        .runtime
        .apply_observed_task_worktree_health(observed, 10)
        .unwrap();

    let projected = fixture.runtime.task_current_projection(&task_id).unwrap();
    let branches = projected["branches"]["items"].as_array().unwrap();
    let secondary = branches
        .iter()
        .find(|branch| branch["name"] == "agent/secondary")
        .unwrap();
    assert_eq!(secondary["role"], "associated");
    assert_eq!(secondary["base_ref"], "feature/cleanup");
    assert_eq!(secondary["base_evidence"], "branchCreationReflog");
    assert_eq!(
        projected["branches"]["checked_out_branch_id"],
        secondary["branch_id"]
    );

    let branch_id = secondary["branch_id"].as_str().unwrap();
    let plan = fixture
        .runtime
        .plan_task_branch_commit_list(json!({
            "taskId": task_id,
            "branchId": branch_id,
        }))
        .unwrap();
    let commits = fixture
        .runtime
        .complete_task_branch_commit_list(plan.observe())
        .unwrap();
    assert_eq!(commits["branch_name"], "agent/secondary");
    assert_eq!(commits["base_ref"], "refs/heads/feature/cleanup");
    assert_eq!(commits["base_evidence"], "branchCreationReflog");
    assert_eq!(commits["commits"].as_array().unwrap().len(), 1);
    assert_eq!(commits["commits"][0]["branch_name"], "agent/secondary");
}

#[test]
fn cleanup_presence_uses_one_bounded_running_or_reserved_resume_predicate() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let nested = destination.join("sessions");
    std::fs::create_dir_all(&nested).unwrap();
    for index in 0..66 {
        let session_id = format!("session-{index:02}");
        fixture
            .runtime
            .store
            .insert_session(
                &fixture.runtime.write_authority,
                termloop_domain::SessionRecord {
                    launch_selection: Default::default(),
                    id: session_id.clone(),
                    project_id: fixture.project_id.clone(),
                    name: None,
                    kind: if index % 2 == 0 {
                        termloop_domain::SessionKind::Agent
                    } else {
                        termloop_domain::SessionKind::Terminal
                    },
                    process: termloop_domain::ProcessDescriptor {
                        program: "shell".into(),
                        args: vec![],
                        cwd: nested.to_string_lossy().into_owned(),
                        agent_id: (index % 2 == 0).then(|| "claude".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: if index < 64 {
                        "running".into()
                    } else {
                        "resuming".into()
                    },
                    runtime_epoch: 1,
                    archived_at_epoch_ms: None,
                    ask_to_source_session_id: None,
                    run_configuration_id: None,
                    improver_target: None,
                    ask_to_continuation: None,
                    resume_ref: None,
                    resume_launch_guard: None,
                    resume_failure: None,
                },
            )
            .unwrap();
        if index == 64 {
            fixture.runtime.resume_reservations.insert(session_id);
        }
    }

    fixture
        .runtime
        .observe_task_worktree_presence(&task_id, 70)
        .unwrap();
    let presence = fixture
        .runtime
        .cached_task_worktree_presence(&task_id)
        .unwrap();
    assert_eq!(presence.total_count, 65);
    assert_eq!(presence.attached_sessions.len(), 64);
    assert!(presence.truncated);
    assert!(
        !presence
            .attached_sessions
            .iter()
            .any(|session| session.session_id == "session-65")
    );

    let preview = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert!(
        preview["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|blocker| blocker == "sessionAttached")
    );
    assert!(preview["presence"]["truncated"].as_bool().unwrap());
    assert!(
        !preview["presence"]["attached_sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    std::fs::remove_dir_all(&destination).unwrap();
    assert!(matches!(
        fixture.runtime.observe_task_worktree_presence(&task_id, 80),
        Err(CoreError::RepositoryUnavailable)
    ));
}
