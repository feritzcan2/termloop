use super::*;

#[test]
fn archive_is_separate_from_status_and_restore_is_idempotent() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("Archive me", Value::Null);
    let task_id = task["id"].as_str().unwrap().to_owned();
    fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["can_archive"], true);
    let archived = fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    assert_eq!(archived["task"]["status"], "closed");
    assert!(archived["task"]["archived_at_epoch_ms"].is_number());

    let active = fixture
        .runtime
        .list_tasks_current(json!({
            "projectId": fixture.project_id,
            "archiveScope": "active",
        }))
        .unwrap();
    assert!(active["items"].as_array().unwrap().is_empty());
    let archived_page = fixture
        .runtime
        .list_tasks_current(json!({
            "projectId": fixture.project_id,
            "archiveScope": "archived",
        }))
        .unwrap();
    assert_eq!(archived_page["items"][0]["id"], task_id);
    assert!(matches!(
        fixture
            .runtime
            .rename_task(json!({ "taskId": task_id, "title": "No" })),
        Err(CoreError::TaskArchived { .. })
    ));

    let restored = fixture
        .runtime
        .restore_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(restored["task"]["archived_at_epoch_ms"].is_null());
    assert_eq!(restored["task"]["status"], "closed");
    let revision = fixture.runtime.state_revision();
    let repeated = fixture
        .runtime
        .restore_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(repeated["restored_session_count"], 0);
    assert_eq!(fixture.runtime.state_revision(), revision);
}

#[test]
fn archive_keeps_multiple_project_sessions_as_sidecars_not_task_children() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let cwd = termloop_platform::canonical_existing_directory_path(&destination)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    for (id, lifecycle_state) in [("agent-one", "exited"), ("agent-two", "resumeFailed")] {
        fixture
            .runtime
            .store
            .insert_session(
                &fixture.runtime.write_authority,
                termloop_domain::SessionRecord {
                    launch_selection: Default::default(),
                    id: id.into(),
                    project_id: fixture.project_id.clone(),
                    name: Some(id.into()),
                    kind: termloop_domain::SessionKind::Agent,
                    process: termloop_domain::ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: cwd.clone(),
                        agent_id: Some("codex".into()),
                        template_ref: None,
                        template_version: None,
                    },
                    lifecycle_state: lifecycle_state.into(),
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
    }
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["sessions"].as_array().unwrap().len(), 2);
    assert!(
        preview["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|session| { session["disposition"] == "willPreservePlaceholder" })
    );
    fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    assert_eq!(fixture.runtime.store.task_archive_suspensions().len(), 2);
    assert!(
        fixture
            .runtime
            .list_sessions()
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    let context = fixture
        .runtime
        .archived_task_context(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(context["sessions"].as_array().unwrap().len(), 2);

    let restored = fixture
        .runtime
        .restore_task(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(restored["restored_session_count"], 2);
    assert!(
        restored["resume_session_ids"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(fixture.runtime.store.sessions().len(), 2);
    assert!(fixture.runtime.store.task_archive_suspensions().is_empty());
}

#[test]
fn archive_ticket_fails_closed_when_task_changes_after_preview() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("Stale preview", Value::Null);
    let task_id = task["id"].as_str().unwrap();
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    fixture
        .runtime
        .rename_task(json!({ "taskId": task_id, "title": "Changed" }))
        .unwrap();
    assert!(matches!(
        fixture.runtime.archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        })),
        Err(CoreError::ArchivePreviewStale { .. })
    ));
    assert!(fixture.runtime.store.task_archive_operations().is_empty());
}

#[test]
fn archived_task_reuses_cleanup_then_deletes_only_its_exact_suspension_cohort() {
    let mut fixture = Fixture::new();
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let cwd = termloop_platform::canonical_existing_directory_path(&destination)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: "archived-delete-agent".into(),
                project_id: fixture.project_id.clone(),
                name: Some("Archived delete agent".into()),
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: cwd.clone(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "exited".into(),
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
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                launch_selection: Default::default(),
                id: "independently-archived-agent".into(),
                project_id: fixture.project_id.clone(),
                name: Some("Independent archive".into()),
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd,
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "exited".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: Some(9),
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: Some(
                    termloop_domain::ResumeRef::for_provider(
                        termloop_domain::ResumeProvider::Codex,
                        "independent-thread".into(),
                    )
                    .unwrap(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
            },
        )
        .unwrap();
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    assert_eq!(
        fixture.runtime.store.task_archive_suspensions()[0]
            .task_id
            .as_deref(),
        Some(task_id.as_str()),
    );
    assert!(matches!(
        fixture
            .runtime
            .inspect_task_worktree_cleanup(json!({ "taskId": task_id })),
        Err(CoreError::InvalidParams(reason)) if reason == "archivedTaskDeleteRefused"
    ));
    fixture
        .runtime
        .store
        .delete_archived_session_descriptor(
            &fixture.runtime.write_authority,
            "independently-archived-agent",
        )
        .unwrap();

    let cleanup = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(cleanup["decision"], "allowed");
    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    assert!(!destination.exists());

    fixture
        .runtime
        .delete_archived_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(fixture.runtime.store.tasks().is_empty());
    assert!(fixture.runtime.store.sessions().is_empty());
    assert!(fixture.runtime.store.task_archive_suspensions().is_empty());
    let branch = GitRefName::from_bytes(b"refs/heads/feature/cleanup".to_vec()).unwrap();
    assert!(
        GitRunner::discover()
            .unwrap()
            .resolve_ref(&fixture.project_directory, &branch)
            .unwrap()
            .is_some()
    );
}

/// Parks one running Agent by archiving its Task and removes the checkout,
/// the state a close leaves when it stops before finalizing.
fn archive_with_worktree_removed(fixture: &mut Fixture) -> (String, &'static str) {
    let (task_id, destination, proof_id, generation) = provision_cleanup_fixture(fixture);
    let worktree_cwd = termloop_platform::canonical_existing_directory_path(&destination)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let session_id = "parked-worktree-agent";
    fixture
        .runtime
        .configure_agent_observations(crate::test_agent_observation_transport(
            fixture.project_directory.join("provider"),
        ));
    fixture
        .runtime
        .store
        .insert_session(
            &fixture.runtime.write_authority,
            termloop_domain::SessionRecord {
                id: session_id.into(),
                project_id: fixture.project_id.clone(),
                name: Some("Parked worktree agent".into()),
                kind: termloop_domain::SessionKind::Agent,
                process: termloop_domain::ProcessDescriptor {
                    program: "codex".into(),
                    args: vec![],
                    cwd: worktree_cwd.clone(),
                    agent_id: Some("codex".into()),
                    template_ref: Some("builtin.agent.interactive".into()),
                    template_version: Some(1),
                },
                lifecycle_state: "running".into(),
                runtime_epoch: 1,
                archived_at_epoch_ms: None,
                ask_to_source_session_id: None,
                run_configuration_id: None,
                improver_target: None,
                ask_to_continuation: None,
                resume_ref: termloop_domain::ResumeRef::for_provider(
                    termloop_domain::ResumeProvider::Codex,
                    "00000000-0000-4000-8000-000000000001".into(),
                ),
                resume_launch_guard: None,
                resume_failure: None,
                launch_selection: termloop_domain::AgentLaunchSelection {
                    account_id: None,
                    model: "gpt-5.6-sol".into(),
                    permission: "acceptEdits".into(),
                    reasoning: "high".into(),
                },
            },
        )
        .unwrap();
    let (program, args) = termloop_platform::default_shell();
    fixture
        .runtime
        .terminal
        .spawn(termloop_terminal::PtySpawnSpec {
            session_id: session_id.into(),
            runtime_epoch: 1,
            program,
            args,
            cwd: worktree_cwd,
            environment: termloop_platform::LaunchEnvironment::os_baseline(),
            recent_output_replay: false,
        })
        .unwrap();

    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(preview["can_archive"], true);
    fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    let cleanup = fixture
        .runtime
        .inspect_task_worktree_cleanup(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(cleanup["decision"], "allowed");
    fixture
        .runtime
        .cleanup_task_worktree(cleanup_params(
            &task_id,
            &Uuid::new_v4().to_string(),
            &proof_id,
            generation,
        ))
        .unwrap();
    (task_id, session_id)
}

/// Parks one running Agent by archiving its Task, removes the checkout, and
/// finalizes the Task as closed, the state close-with-worktree-removal leaves.
fn close_with_worktree_removed(fixture: &mut Fixture) -> (String, &'static str) {
    let (task_id, session_id) = archive_with_worktree_removed(fixture);
    let project_cwd =
        termloop_platform::canonical_existing_directory_path(&fixture.project_directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
    let closed = fixture
        .runtime
        .finalize_closed_worktree_removal(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(closed["status"], "closed");
    assert!(closed["archived_at_epoch_ms"].is_null());
    assert!(closed["worktree"].is_null());
    assert_eq!(fixture.runtime.store.sessions()[0].process.cwd, project_cwd);
    assert_eq!(
        fixture.runtime.store.task_archive_suspensions()[0].reason,
        termloop_domain::TaskSuspensionReason::ClosedWorktreeRemoved,
    );

    (task_id, session_id)
}

#[test]
fn closed_task_restores_parked_agent_from_project_after_worktree_removal() {
    let mut fixture = Fixture::new();
    let (task_id, session_id) = close_with_worktree_removed(&mut fixture);
    let (reopened, resume_session_ids) = fixture
        .runtime
        .reopen_task_with_resume_plan(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(reopened["status"], "open");
    assert_eq!(resume_session_ids, vec![session_id.to_owned()]);
    assert!(fixture.runtime.store.task_archive_suspensions().is_empty());
    assert_eq!(
        fixture.runtime.store.sessions()[0].resume_failure,
        Some(termloop_domain::ResumeFailureReason::DaemonInterrupted),
    );
}

#[test]
fn reopen_resumes_worktree_removed_agent_inside_recreated_worktree() {
    let mut fixture = Fixture::new();
    let (task_id, session_id) = close_with_worktree_removed(&mut fixture);
    let plan = fixture.runtime.plan_task_reopen_worktree(&task_id).unwrap();
    assert_eq!(plan.branch_name, "feature/cleanup");
    assert_eq!(plan.worktree_leaf, "feature-cleanup_worktree");
    let destination = fixture.project_directory.with_file_name(format!(
        "{}-{}",
        plan.worktree_leaf,
        Uuid::new_v4()
    ));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": plan.operation_id,
            "taskId": task_id,
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": plan.branch_name,
            "branchMode": "existing",
        }))
        .unwrap();
    assert!(
        fixture
            .runtime
            .plan_task_reopen_worktree(&task_id)
            .is_none()
    );
    let worktree_path = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .and_then(|task| task.worktree.as_ref())
        .map(|worktree| worktree.path.clone())
        .unwrap();

    let (reopened, resume_session_ids) = fixture
        .runtime
        .reopen_task_with_resume_plan(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(reopened["status"], "open");
    assert_eq!(resume_session_ids, vec![session_id.to_owned()]);
    let session = &fixture.runtime.store.sessions()[0];
    assert_eq!(session.process.cwd, worktree_path);
    // Resume is guarded by the recreated checkout, not the removed one.
    let guard = session.resume_launch_guard.as_ref().unwrap();
    assert_eq!(guard.path, worktree_path);
    assert_eq!(guard.managed_worktree_operation_id, plan.operation_id);
}

#[test]
fn reopen_starts_a_fresh_branch_from_base_and_resumes_the_agent_inside_it() {
    let mut fixture = Fixture::new();
    let (task_id, session_id) = close_with_worktree_removed(&mut fixture);
    let plan = fixture.runtime.plan_task_reopen_worktree(&task_id).unwrap();
    let crate::task_worktree::TaskWorktreeRecreationBase::FreshFromBase {
        released,
        configured_base_ref,
    } = plan.base
    else {
        panic!("reopen must start from the latest base");
    };
    assert_eq!(released.name, "feature/cleanup");
    assert_eq!(configured_base_ref, None);
    fixture
        .runtime
        .release_task_branch_for_fresh_checkout(&task_id, &released)
        .unwrap();
    let destination = fixture
        .project_directory
        .with_file_name(format!("feature-cleanup-r2_worktree-{}", Uuid::new_v4()));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": plan.operation_id,
            "taskId": task_id,
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": "feature/cleanup-r2",
            "branchMode": "create",
            "baseRef": "refs/remotes/origin/main",
        }))
        .unwrap();
    let task = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .unwrap()
        .clone();
    assert_eq!(task.branch.unwrap().name, "feature/cleanup-r2");
    let worktree_path = task.worktree.unwrap().path;

    let (reopened, resume_session_ids) = fixture
        .runtime
        .reopen_task_with_resume_plan(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(reopened["status"], "open");
    assert_eq!(resume_session_ids, vec![session_id.to_owned()]);
    let session = &fixture.runtime.store.sessions()[0];
    assert_eq!(session.process.cwd, worktree_path);
    assert_eq!(
        session.resume_launch_guard.as_ref().unwrap().path,
        worktree_path
    );
}

#[test]
fn failed_fresh_checkout_rebinds_the_released_branch() {
    let mut fixture = Fixture::new();
    let (task_id, _) = close_with_worktree_removed(&mut fixture);
    let plan = fixture.runtime.plan_task_reopen_worktree(&task_id).unwrap();
    let crate::task_worktree::TaskWorktreeRecreationBase::FreshFromBase { released, .. } =
        plan.base
    else {
        panic!("reopen must start from the latest base");
    };
    fixture
        .runtime
        .release_task_branch_for_fresh_checkout(&task_id, &released)
        .unwrap();
    fixture
        .runtime
        .rebind_task_branch_after_failed_fresh_checkout(&task_id, released.clone())
        .unwrap();
    let task = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .unwrap();
    assert_eq!(task.branch.as_ref(), Some(&released));
    // Reopen still finds its parked Agent and plans a checkout again.
    assert!(
        fixture
            .runtime
            .plan_task_reopen_worktree(&task_id)
            .is_some()
    );
}

#[test]
fn restoring_an_archived_task_without_its_checkout_settles_into_reopen() {
    let mut fixture = Fixture::new();
    let (task_id, session_id) = archive_with_worktree_removed(&mut fixture);
    let settled = fixture
        .runtime
        .settle_archived_task_without_worktree(&json!({ "taskId": task_id }))
        .unwrap();
    assert!(settled);
    let task = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .unwrap();
    assert!(task.archived_at_epoch_ms.is_none());
    assert_eq!(task.status, termloop_domain::TaskStatus::Closed);
    assert_eq!(
        fixture.runtime.store.task_archive_suspensions()[0].reason,
        termloop_domain::TaskSuspensionReason::ClosedWorktreeRemoved,
    );
    // Reopen now recreates the checkout and resumes the parked Agent there.
    assert!(
        fixture
            .runtime
            .plan_task_reopen_worktree(&task_id)
            .is_some()
    );
    let (reopened, resume_session_ids) = fixture
        .runtime
        .reopen_task_with_resume_plan(json!({ "taskId": task_id }))
        .unwrap();
    assert_eq!(reopened["status"], "open");
    assert_eq!(resume_session_ids, vec![session_id.to_owned()]);
}

#[test]
fn restoring_an_archived_task_with_its_checkout_is_not_settled() {
    let mut fixture = Fixture::new();
    let (task_id, _, _, _) = provision_cleanup_fixture(&mut fixture);
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    let revision = fixture.runtime.state_revision();
    assert!(
        !fixture
            .runtime
            .settle_archived_task_without_worktree(&json!({ "taskId": task_id }))
            .unwrap()
    );
    assert_eq!(fixture.runtime.state_revision(), revision);
}

#[test]
fn restore_waits_for_a_running_worktree_cleanup() {
    let mut fixture = Fixture::new();
    let (task_id, _, proof_id, generation) = provision_cleanup_fixture(&mut fixture);
    let preview = fixture
        .runtime
        .inspect_task_archive(json!({ "taskId": task_id }))
        .unwrap();
    fixture
        .runtime
        .archive_task(json!({
            "taskId": task_id,
            "operationId": Uuid::new_v4().to_string(),
            "archiveTicket": preview["archive_ticket"],
        }))
        .unwrap();
    let operation_id = Uuid::new_v4().to_string();
    let TaskWorktreeCleanupPlanning::Observe(plan) = fixture
        .runtime
        .plan_task_worktree_cleanup(cleanup_params(
            &task_id,
            &operation_id,
            &proof_id,
            generation,
        ))
        .unwrap()
    else {
        panic!("cleanup unexpectedly completed")
    };
    fixture
        .runtime
        .begin_task_worktree_cleanup(plan.observe().unwrap())
        .unwrap();

    assert!(matches!(
        fixture
            .runtime
            .settle_archived_task_without_worktree(&json!({ "taskId": task_id })),
        Ok(false)
    ));
    assert!(matches!(
        fixture.runtime.restore_task(json!({ "taskId": task_id })),
        Err(CoreError::CleanupInProgress { operation_id: running, .. }) if running == operation_id
    ));
}

#[test]
fn reopen_plans_no_worktree_for_open_or_agentless_tasks() {
    let mut fixture = Fixture::new();
    let task = fixture.create_task("No agents", Value::Null);
    let task_id = task["id"].as_str().unwrap().to_owned();
    assert!(
        fixture
            .runtime
            .plan_task_reopen_worktree(&task_id)
            .is_none()
    );
    fixture
        .runtime
        .close_task(json!({ "taskId": task_id }))
        .unwrap();
    assert!(
        fixture
            .runtime
            .plan_task_reopen_worktree(&task_id)
            .is_none()
    );
}
