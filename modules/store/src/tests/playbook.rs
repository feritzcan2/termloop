use super::*;
use termloop_domain::{
    PendingRoutineFinding, PlaybookConfiguration, PlaybookGateKind, PlaybookMilestone,
    PlaybookPipeline, PlaybookStepProgress, PlaybookStepVerdict, RoutineActionHandling,
    RoutineTriggerMode, StewardAgentId, StewardConfiguration, TrackerConfiguration, TrackerKind,
    WorkerConfiguration,
};

fn temp_store(label: &str) -> (std::path::PathBuf, Store) {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-playbook-{label}-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let store = Store::open(&path).unwrap();
    (path, store)
}

fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        name: id.into(),
        folder_path: format!("/tmp/{id}"),
    }
}

fn step_worker(project_id: &str) -> WorkerConfiguration {
    WorkerConfiguration {
        id: "worker-1".into(),
        project_id: project_id.into(),
        name: "Worker 1".into(),
        agent_id: StewardAgentId::Claude,
        model: "default".into(),
        permission: "default".into(),
        reasoning: "default".into(),
        enabled: true,
        ping_interval_seconds: 60,
        worker_prompt: String::new(),
        system_prompt: String::new(),
        executor_session_id: None,
        generation: 1,
        updated_at_epoch_ms: 1,
    }
}

fn disabled_steward(project_id: &str) -> StewardConfiguration {
    StewardConfiguration {
        project_id: project_id.into(),
        agent_id: StewardAgentId::Codex,
        model: "gpt-5.6-luna".into(),
        permission: "bypassPermissions".into(),
        reasoning: "medium".into(),
        enabled: false,
        system_prompt: String::new(),
        executor_session_id: None,
        generation: 1,
        updated_at_epoch_ms: 1,
    }
}

/// The on-demand Routine a pipeline step checks with. A step may only name a
/// Routine that exists in the same Project.
fn step_routine(project_id: &str, id: &str) -> TrackerConfiguration {
    TrackerConfiguration {
        id: id.into(),
        project_id: project_id.into(),
        kind: TrackerKind::CiPr,
        trigger_mode: RoutineTriggerMode::OnDemand,
        name: "PR checker".into(),
        prompt: "Look at the Task's pull request and report whether it is approved.".into(),
        steward_instructions: String::new(),
        worker_id: "worker-1".into(),
        enabled: true,
        schedule_interval_seconds: 300,
        generation: 1,
        context_markdown: String::new(),
        context_revision: 1,
        recent_source_keys: vec![],
        related_task_ids: vec![],
        action_handling: RoutineActionHandling::Off,
        pending_routine_findings: vec![],
        last_check_started_at_epoch_ms: None,
        last_attempt_at_epoch_ms: None,
        last_successful_report_at_epoch_ms: None,
        updated_at_epoch_ms: 1,
    }
}

fn playbook(project_id: &str, revision: u64) -> PlaybookConfiguration {
    PlaybookConfiguration {
        project_id: project_id.into(),
        revision,
        active_pipeline_name: "Ship to production".into(),
        saved_pipelines: Vec::new(),
        milestones: vec![PlaybookMilestone {
            id: "pr-approved".into(),
            title: "PR approved".into(),
            gate: PlaybookGateKind::Human,
            routine_id: "routine-pr".into(),
            retry_delay_seconds: 600,
            condition: "PR review projection shows an approval.".into(),
            approver: Some("ferit".into()),
        }],
        updated_at_epoch_ms: 1,
    }
}

#[test]
fn atomic_playbook_apply_creates_capacity_checks_and_document_in_one_revision() {
    let (path, mut store) = temp_store("atomic-apply");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_steward_configuration(&authority, disabled_steward("project-a"), revision)
        .unwrap();
    let mut enabled_steward = disabled_steward("project-a");
    enabled_steward.enabled = true;
    enabled_steward.generation = 2;
    enabled_steward.updated_at_epoch_ms = 2;
    let before = store.revision();
    let applied = store
        .apply_playbook(
            &authority,
            PlaybookApply {
                configuration: playbook("project-a", 1),
                steward_configuration: Some(enabled_steward),
                create_worker: Some(step_worker("project-a")),
                upsert_routines: vec![step_routine("project-a", "routine-pr")],
                delete_routine_ids: Vec::new(),
            },
            before,
        )
        .unwrap();
    assert_eq!(applied.revision, 1);
    assert_eq!(store.revision(), before + 1);
    assert_eq!(store.worker_configurations().len(), 1);
    assert_eq!(store.tracker_configurations().len(), 1);
    assert_eq!(store.playbook_configurations().len(), 1);
    assert!(store.steward_configurations()[0].enabled);
    assert_eq!(store.steward_configurations()[0].generation, 2);

    drop(store);
    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.worker_configurations().len(), 1);
    assert_eq!(reopened.tracker_configurations().len(), 1);
    assert_eq!(reopened.playbook_configurations().len(), 1);
    assert!(reopened.steward_configurations()[0].enabled);
    let _ = std::fs::remove_file(path);
}

#[test]
fn atomic_playbook_apply_rolls_back_the_entire_invalid_replacement() {
    let (path, mut store) = temp_store("atomic-rollback");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_steward_configuration(&authority, disabled_steward("project-a"), revision)
        .unwrap();
    let before = store.revision();
    let mut routine = step_routine("project-a", "routine-pr");
    routine.worker_id = "missing-worker".into();
    let mut enabled_steward = disabled_steward("project-a");
    enabled_steward.enabled = true;
    enabled_steward.generation = 2;
    assert!(matches!(
        store.apply_playbook(
            &authority,
            PlaybookApply {
                configuration: playbook("project-a", 1),
                steward_configuration: Some(enabled_steward),
                create_worker: Some(step_worker("project-a")),
                upsert_routines: vec![routine],
                delete_routine_ids: Vec::new(),
            },
            before,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), before);
    assert!(store.worker_configurations().is_empty());
    assert!(store.tracker_configurations().is_empty());
    assert!(store.playbook_configurations().is_empty());
    assert!(!store.steward_configurations()[0].enabled);
    assert_eq!(store.steward_configurations()[0].generation, 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn playbook_is_one_replaceable_document_per_project_and_survives_reopen() {
    let (path, mut store) = temp_store("replace");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();

    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, playbook("project-a", 1), revision)
        .unwrap();
    assert_eq!(store.playbook_configurations().len(), 1);

    // Replacing keeps one document per Project.
    let mut replacement = playbook("project-a", 2);
    replacement.milestones[0].title = "Is the PR approved?".into();
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, replacement.clone(), revision)
        .unwrap();
    assert_eq!(store.playbook_configurations().len(), 1);
    assert_eq!(store.playbook_configurations()[0], replacement);

    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.playbook_configurations().len(), 1);
    assert_eq!(
        store.playbook_configurations()[0].milestones[0].title,
        "Is the PR approved?"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn playbook_write_requires_current_revision_valid_document_and_known_project() {
    let (path, mut store) = temp_store("guards");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();

    let stale = store.revision().wrapping_add(7);
    assert!(matches!(
        store.set_playbook_configuration(&authority, playbook("project-a", 1), stale),
        Err(StoreError::RevisionConflict)
    ));

    let revision = store.revision();
    assert!(matches!(
        store.set_playbook_configuration(&authority, playbook("project-missing", 1), revision),
        Err(StoreError::ConstraintViolation)
    ));

    let mut invalid = playbook("project-a", 1);
    invalid.milestones[0].id = "not a slug".into();
    let revision = store.revision();
    assert!(matches!(
        store.set_playbook_configuration(&authority, invalid, revision),
        Err(StoreError::ConstraintViolation)
    ));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn project_delete_removes_its_playbook() {
    let (path, mut store) = temp_store("cascade");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, playbook("project-a", 1), revision)
        .unwrap();
    store
        .delete_project_and_related_records(&authority, "project-a")
        .unwrap();
    assert!(store.playbook_configurations().is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn steward_brief_update_is_document_cas_replace_only() {
    let (path, mut store) = temp_store("brief");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();
    store
        .insert_task(
            &authority,
            TaskRecord {
                id: "task-1".into(),
                project_id: "project-a".into(),
                title: "Task".into(),
                brief: None,
                status: TaskStatus::Open,
                archived_at_epoch_ms: None,
                branch: None,
                worktree: None,
                worktree_generation: 0,
                steward_brief_markdown: String::new(),
                steward_brief_revision: 1,
                rank: 0,
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();

    assert!(matches!(
        store.update_task_steward_brief(&authority, "task-1", "Observed: ...".into(), 9, 5),
        Err(StoreError::RevisionConflict)
    ));
    assert!(matches!(
        store.update_task_steward_brief(&authority, "task-missing", "x".into(), 1, 5),
        Err(StoreError::NotFound)
    ));

    let updated = store
        .update_task_steward_brief(&authority, "task-1", "Observed: tests green.".into(), 1, 5)
        .unwrap();
    assert_eq!(updated.steward_brief_revision, 2);
    assert_eq!(updated.steward_brief_markdown, "Observed: tests green.");

    // An identical value is a no-op that keeps the revision.
    let unchanged = store
        .update_task_steward_brief(&authority, "task-1", "Observed: tests green.".into(), 2, 6)
        .unwrap();
    assert_eq!(unchanged.steward_brief_revision, 2);

    assert!(matches!(
        store.update_task_steward_brief(&authority, "task-1", "   ".into(), 2, 7),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(matches!(
        store.update_task_steward_brief(
            &authority,
            "task-1",
            "x".repeat(termloop_domain::TASK_STEWARD_BRIEF_MAX_BYTES + 1),
            2,
            7,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn schema_31_migration_defaults_playbooks_and_task_steward_briefs() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-playbook-migration-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "schema_version": 31,
            "revision": 2,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [{
                "id": "task-1",
                "project_id": "project-1",
                "title": "Task",
                "brief": null,
                "status": "open",
                "archived_at_epoch_ms": null,
                "branch": null,
                "worktree": null,
                "worktree_generation": 0,
                "rank": 0,
                "created_at_epoch_ms": 1,
                "updated_at_epoch_ms": 1
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.playbook_configurations().is_empty());
    assert_eq!(store.tasks()[0].steward_brief_markdown, "");
    assert_eq!(store.tasks()[0].steward_brief_revision, 1);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    let _ = std::fs::remove_file(path);
}

#[test]
fn playbook_step_must_name_a_routine_in_its_own_project() {
    let (path, mut store) = temp_store("step-routine");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();

    // A step pointing at a Routine that does not exist could never be decided.
    let mut unknown_routine = playbook("project-a", 1);
    unknown_routine.milestones[0].routine_id = "routine-missing".into();
    let revision = store.revision();
    assert!(matches!(
        store.set_playbook_configuration(&authority, unknown_routine, revision),
        Err(StoreError::ConstraintViolation)
    ));

    // Neither may it borrow another Project's Routine.
    store
        .insert_project(&authority, project("project-b"))
        .unwrap();
    let mut cross_project = playbook("project-b", 1);
    cross_project.milestones[0].routine_id = "routine-pr".into();
    let revision = store.revision();
    assert!(matches!(
        store.set_playbook_configuration(&authority, cross_project, revision),
        Err(StoreError::ConstraintViolation)
    ));

    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, playbook("project-a", 1), revision)
        .unwrap();

    // A Routine owned by a Playbook cannot be deleted out from under the step.
    // The Playbook replacement command is the sole lifecycle owner.
    let revision = store.revision();
    assert!(matches!(
        store.delete_tracker_configuration(&authority, "routine-pr", revision),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.playbook_configurations()[0].milestones.len(), 1);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn on_demand_routines_are_current_state_like_scheduled_ones() {
    let (path, mut store) = temp_store("on-demand");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();
    assert_eq!(
        store.tracker_configurations()[0].trigger_mode,
        RoutineTriggerMode::OnDemand
    );

    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.tracker_configurations()[0].trigger_mode,
        RoutineTriggerMode::OnDemand
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn step_verdict_and_waiting_finding_commit_atomically() {
    let (path, mut store) = temp_store("step-finding-atomic");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, playbook("project-a", 1), revision)
        .unwrap();
    store
        .insert_task(
            &authority,
            TaskRecord {
                id: "task-1".into(),
                project_id: "project-a".into(),
                title: "Task".into(),
                brief: None,
                status: TaskStatus::Open,
                archived_at_epoch_ms: None,
                branch: None,
                worktree: None,
                worktree_generation: 0,
                steward_brief_markdown: String::new(),
                steward_brief_revision: 1,
                rank: 0,
                created_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();

    let answer = PlaybookStepProgress {
        task_id: "task-1".into(),
        milestone_id: "pr-approved".into(),
        routine_id: "routine-pr".into(),
        verdict: PlaybookStepVerdict::Waiting,
        evidence: "No approval is visible.".into(),
        decided_at_epoch_ms: 2,
        next_attempt_at_epoch_ms: Some(602_000),
    };
    let mut routine = store.tracker_configurations()[0].clone();
    routine.action_handling = RoutineActionHandling::Ask;
    routine.recent_source_keys = vec!["ciPr:step-waiting:digest".into()];
    routine.pending_routine_findings = vec![PendingRoutineFinding {
        id: "finding-1".into(),
        source_key: "ciPr:step-waiting:digest".into(),
        routine_generation: routine.generation,
        summary: "Task is waiting at PR approved.".into(),
        evidence: answer.evidence.clone(),
        source_references: vec![],
        related_task_ids: vec!["task-1".into()],
        created_at_epoch_ms: 2,
    }];
    routine.updated_at_epoch_ms = 2;
    let revision = store.revision();
    store
        .record_playbook_step_progress_with_routine(
            &authority,
            "project-a",
            vec![answer.clone()],
            routine.clone(),
            revision,
        )
        .unwrap();
    assert_eq!(store.revision(), revision + 1);
    assert_eq!(
        store.playbook_step_progress(),
        std::slice::from_ref(&answer)
    );
    assert_eq!(store.tracker_configurations()[0], routine);

    let before_revision = store.revision();
    let before_progress = store.playbook_step_progress().to_vec();
    let before_routine = store.tracker_configurations()[0].clone();
    let mut mismatched = before_routine.clone();
    mismatched.id = "routine-missing".into();
    assert!(matches!(
        store.record_playbook_step_progress_with_routine(
            &authority,
            "project-a",
            vec![PlaybookStepProgress {
                evidence: "Changed evidence must not land alone.".into(),
                ..answer
            }],
            mismatched,
            before_revision,
        ),
        Err(StoreError::NotFound | StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), before_revision);
    assert_eq!(store.playbook_step_progress(), before_progress);
    assert_eq!(store.tracker_configurations()[0], before_routine);

    store
        .set_task_status(&authority, "task-1", TaskStatus::Closed, 3)
        .unwrap();
    assert!(
        store.tracker_configurations()[0]
            .pending_routine_findings
            .is_empty()
    );
    store.delete_task(&authority, "task-1").unwrap();
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_pipeline_the_project_kept_still_holds_its_routines() {
    let (path, mut store) = temp_store("kept-pipeline");
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();

    // A pipeline the Project is not walking is still part of the document, so
    // its questions must name Routines that exist here too.
    let mut dangling = playbook("project-a", 1);
    dangling.saved_pipelines = vec![PlaybookPipeline {
        name: "Code review".into(),
        milestones: vec![PlaybookMilestone {
            routine_id: "routine-missing".into(),
            ..dangling.milestones[0].clone()
        }],
    }];
    let revision = store.revision();
    assert!(matches!(
        store.set_playbook_configuration(&authority, dangling, revision),
        Err(StoreError::ConstraintViolation)
    ));

    let mut kept = playbook("project-a", 1);
    kept.saved_pipelines = vec![PlaybookPipeline {
        name: "Code review".into(),
        milestones: vec![kept.milestones[0].clone()],
    }];
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, kept, revision)
        .unwrap();

    // A kept pipeline owns its check just as strongly as the active pipeline.
    let mut active_only = store.playbook_configurations()[0].clone();
    active_only.revision = 2;
    active_only.milestones = Vec::new();
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, active_only, revision)
        .unwrap();
    let revision = store.revision();
    assert!(matches!(
        store.delete_tracker_configuration(&authority, "routine-pr", revision),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(
        store.playbook_configurations()[0].saved_pipelines[0]
            .milestones
            .len(),
        1
    );

    drop(store);
    std::fs::remove_dir_all(path).ok();
}

fn task(id: &str, project_id: &str) -> TaskRecord {
    TaskRecord {
        id: id.into(),
        project_id: project_id.into(),
        title: id.into(),
        brief: None,
        status: TaskStatus::Open,
        archived_at_epoch_ms: None,
        branch: None,
        worktree: None,
        worktree_generation: 0,
        steward_brief_markdown: String::new(),
        steward_brief_revision: 1,
        rank: 0,
        created_at_epoch_ms: 1,
        updated_at_epoch_ms: 1,
    }
}

fn answer(task_id: &str, verdict: PlaybookStepVerdict) -> PlaybookStepProgress {
    PlaybookStepProgress {
        task_id: task_id.into(),
        milestone_id: "pr-approved".into(),
        routine_id: "routine-pr".into(),
        verdict,
        evidence: "Approval visible on the open PR.".into(),
        decided_at_epoch_ms: 10,
        next_attempt_at_epoch_ms: match verdict {
            PlaybookStepVerdict::Passed => None,
            PlaybookStepVerdict::Waiting => Some(610),
        },
    }
}

/// Sets up a Project with a Worker, a step Routine, one Playbook, and one Task.
fn project_with_pipeline(label: &str) -> (std::path::PathBuf, Store, CoreWriteAuthority) {
    let (path, mut store) = temp_store(label);
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(&authority, project("project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_worker_configuration(&authority, step_worker("project-a"), revision)
        .unwrap();
    let revision = store.revision();
    store
        .set_tracker_configuration(
            &authority,
            step_routine("project-a", "routine-pr"),
            revision,
        )
        .unwrap();
    store
        .insert_task(&authority, task("task-1", "project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, playbook("project-a", 1), revision)
        .unwrap();
    (path, store, authority)
}

#[test]
fn a_step_verdict_is_current_state_that_a_later_run_replaces() {
    let (path, mut store, authority) = project_with_pipeline("verdicts");

    // A whole step's answers land together, and a later run replaces rather
    // than appends: one Task has one current answer per question.
    let revision = store.revision();
    store
        .record_playbook_step_progress(
            &authority,
            "project-a",
            vec![answer("task-1", PlaybookStepVerdict::Waiting)],
            revision,
        )
        .unwrap();
    assert_eq!(store.playbook_step_progress().len(), 1);
    let revision = store.revision();
    store
        .record_playbook_step_progress(
            &authority,
            "project-a",
            vec![answer("task-1", PlaybookStepVerdict::Passed)],
            revision,
        )
        .unwrap();
    assert_eq!(store.playbook_step_progress().len(), 1);
    assert_eq!(
        store.playbook_step_progress()[0].verdict,
        PlaybookStepVerdict::Passed
    );

    // The same batch twice is a no-op that does not move the revision.
    let revision = store.revision();
    store
        .record_playbook_step_progress(
            &authority,
            "project-a",
            vec![answer("task-1", PlaybookStepVerdict::Passed)],
            revision,
        )
        .unwrap();
    assert_eq!(store.revision(), revision);

    // A verdict survives a reopen; it is durable current state, not runtime.
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.playbook_step_progress().len(), 1);

    // A deleted Task asks nothing, so its answers go with it.
    store.delete_task(&authority, "task-1").unwrap();
    assert!(store.playbook_step_progress().is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn one_tasks_pipeline_answers_are_replaced_atomically() {
    let (path, mut store, authority) = project_with_pipeline("task-position");
    store
        .insert_task(&authority, task("task-2", "project-a"))
        .unwrap();
    let revision = store.revision();
    store
        .record_playbook_step_progress(
            &authority,
            "project-a",
            vec![
                answer("task-1", PlaybookStepVerdict::Waiting),
                answer("task-2", PlaybookStepVerdict::Passed),
            ],
            revision,
        )
        .unwrap();

    let replacement = answer("task-1", PlaybookStepVerdict::Passed);
    let revision = store.revision();
    store
        .replace_task_playbook_progress(
            &authority,
            "project-a",
            "task-1",
            vec![replacement.clone()],
            revision,
        )
        .unwrap();
    assert!(store.playbook_step_progress().contains(&replacement));
    assert!(
        store
            .playbook_step_progress()
            .iter()
            .any(|entry| entry.task_id == "task-2")
    );

    let revision = store.revision();
    store
        .replace_task_playbook_progress(&authority, "project-a", "task-1", Vec::new(), revision)
        .unwrap();
    assert!(
        store
            .playbook_step_progress()
            .iter()
            .all(|entry| entry.task_id != "task-1")
    );
    assert!(
        store
            .playbook_step_progress()
            .iter()
            .any(|entry| entry.task_id == "task-2")
    );

    let stale = store.revision().saturating_sub(1);
    assert!(matches!(
        store.replace_task_playbook_progress(
            &authority,
            "project-a",
            "task-1",
            vec![answer("task-1", PlaybookStepVerdict::Passed)],
            stale,
        ),
        Err(StoreError::RevisionConflict)
    ));
    let revision = store.revision();
    assert!(matches!(
        store.replace_task_playbook_progress(
            &authority,
            "project-a",
            "task-1",
            vec![answer("task-2", PlaybookStepVerdict::Passed)],
            revision,
        ),
        Err(StoreError::ConstraintViolation)
    ));

    let _ = std::fs::remove_file(path);
}

#[test]
fn a_verdict_must_answer_a_question_this_project_is_asking() {
    let (path, mut store, authority) = project_with_pipeline("verdict-guards");

    let stale = store.revision().wrapping_add(3);
    assert!(matches!(
        store.record_playbook_step_progress(
            &authority,
            "project-a",
            vec![answer("task-1", PlaybookStepVerdict::Passed)],
            stale,
        ),
        Err(StoreError::RevisionConflict)
    ));

    // A question the active pipeline does not ask.
    let mut foreign = answer("task-1", PlaybookStepVerdict::Passed);
    foreign.milestone_id = "somewhere-else".into();
    let revision = store.revision();
    assert!(matches!(
        store.record_playbook_step_progress(&authority, "project-a", vec![foreign], revision),
        Err(StoreError::ConstraintViolation)
    ));

    // A Task that is not this Project's.
    let mut other_project = answer("task-missing", PlaybookStepVerdict::Passed);
    other_project.task_id = "task-missing".into();
    let revision = store.revision();
    assert!(matches!(
        store.record_playbook_step_progress(&authority, "project-a", vec![other_project], revision),
        Err(StoreError::ConstraintViolation)
    ));

    // Two answers for the same Task and question in one batch.
    let revision = store.revision();
    assert!(matches!(
        store.record_playbook_step_progress(
            &authority,
            "project-a",
            vec![
                answer("task-1", PlaybookStepVerdict::Passed),
                answer("task-1", PlaybookStepVerdict::Waiting),
            ],
            revision,
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(store.playbook_step_progress().is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn switching_the_pipeline_drops_answers_to_questions_it_does_not_ask() {
    let (path, mut store, authority) = project_with_pipeline("pipeline-switch");
    let revision = store.revision();
    store
        .record_playbook_step_progress(
            &authority,
            "project-a",
            vec![answer("task-1", PlaybookStepVerdict::Passed)],
            revision,
        )
        .unwrap();

    // Parking this pipeline and walking another one leaves the definition
    // intact but not the walk: position only means something on the path a
    // Task is actually on.
    let mut switched = store.playbook_configurations()[0].clone();
    switched.revision = 2;
    switched.saved_pipelines = vec![PlaybookPipeline {
        name: switched.active_pipeline_name.clone(),
        milestones: switched.milestones.clone(),
    }];
    switched.active_pipeline_name = "Code review".into();
    switched.milestones = Vec::new();
    let revision = store.revision();
    store
        .set_playbook_configuration(&authority, switched, revision)
        .unwrap();
    assert!(store.playbook_step_progress().is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn schema_33_migration_retires_playbook_rules() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-playbook-rules-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&json!({
            "schema_version": 33,
            "revision": 4,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": [],
            "worker_configurations": [{
                "id": "worker-1", "projectId": "project-1", "name": "Worker 1",
                "agentId": "claude", "model": "default", "reasoning": "default",
                "enabled": true, "pingIntervalSeconds": 60, "workerPrompt": "",
                "systemPrompt": "", "executorSessionId": null, "generation": 1,
                "updatedAtEpochMs": 1
            }],
            "tracker_configurations": [{
                "id": "routine-pr", "projectId": "project-1", "kind": "ciPr",
                "triggerMode": "onDemand", "name": "PR checker",
                "prompt": "Look at the pull request.", "workerId": "worker-1",
                "enabled": false, "scheduleIntervalSeconds": 300, "generation": 1,
                "contextMarkdown": "", "contextRevision": 1, "recentSourceKeys": [],
                "relatedTaskIds": [], "lastSuccessfulReportAtEpochMs": null,
                "updatedAtEpochMs": 1
            }],
            "playbook_configurations": [{
                "projectId": "project-1", "revision": 3,
                "activePipelineName": "Ship to production",
                "milestones": [{
                    "id": "pr-approved", "title": "Is the PR approved?", "gate": "automatic",
                    "routineId": "routine-pr", "retryDelaySeconds": 600,
                    "condition": "", "approver": null
                }],
                "savedPipelines": [],
                "rules": [{
                    "id": "deploy-watch", "title": "Deploy watch", "sensorKind": "delivery",
                    "condition": "", "instruction": "Tell the user.", "autonomy": "report"
                }],
                "updatedAtEpochMs": 1
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.playbook_configurations().len(), 1);
    assert_eq!(store.playbook_configurations()[0].milestones.len(), 1);
    // Nobody starts partway along the pipeline: the walk begins empty.
    assert!(store.playbook_step_progress().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(
        persisted["playbook_configurations"][0]
            .get("rules")
            .is_none()
    );
    let _ = std::fs::remove_file(path);
}
