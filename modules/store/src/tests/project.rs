use super::*;
use termloop_domain::{
    NormalizedWorktreeSpec, ProcessDescriptor, ProjectMode, ProjectModeSetting, ProjectRecord,
    ProjectTaskAutomationConfiguration, ProvisioningBranchMode, ProvisioningStage, SessionKind,
    SessionRecord, TaskRecord, TaskStatus, WorktreeProvisioningOperation,
};

fn project(id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.into(),
        name: id.into(),
        folder_path: format!("/projects/{id}"),
    }
}

fn task(id: &str, project_id: &str) -> TaskRecord {
    TaskRecord {
        id: id.into(),
        project_id: project_id.into(),
        title: id.into(),
        brief: None,
        developer_notes: vec![],
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

#[test]
fn sprints_keep_one_active_per_project_and_tracking_follows_tasks_and_sprints() {
    use termloop_domain::{ProjectSprint, SprintState, TaskTrackingRecord};
    let path = std::env::temp_dir().join(format!(
        "termloop-store-sprints-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    store.insert_task(&authority, task("task-a", "pm")).unwrap();
    let sprint = |id: &str, state| ProjectSprint {
        id: id.into(),
        project_id: "pm".into(),
        name: format!("Sprint {id}"),
        state,
        created_at_epoch_ms: 1,
        jira: None,
    };
    store
        .create_project_sprint(&authority, sprint("1", SprintState::Active))
        .unwrap();
    assert!(matches!(
        store.create_project_sprint(&authority, sprint("2", SprintState::Active)),
        Err(StoreError::ConstraintViolation)
    ));
    store
        .create_project_sprint(&authority, sprint("2", SprintState::Planned))
        .unwrap();
    assert!(matches!(
        store.update_project_sprint(&authority, "2", "Sprint 2", SprintState::Active),
        Err(StoreError::ConstraintViolation)
    ));
    store
        .update_project_sprint(&authority, "1", "Sprint 1", SprintState::Closed)
        .unwrap();
    store
        .update_project_sprint(&authority, "2", "Sprint 2", SprintState::Active)
        .unwrap();
    assert_eq!(
        store.active_sprint("pm").map(|sprint| sprint.id.as_str()),
        Some("2")
    );

    let record = TaskTrackingRecord {
        task_id: "task-a".into(),
        sprint_id: Some("2".into()),
        developer: Some("Ada".into()),
        updated_at_epoch_ms: 5,
        ..TaskTrackingRecord::default()
    };
    store.set_task_tracking(&authority, record.clone()).unwrap();
    assert!(matches!(
        store.set_task_tracking(
            &authority,
            TaskTrackingRecord {
                sprint_id: Some("missing".into()),
                ..record.clone()
            }
        ),
        Err(StoreError::ConstraintViolation)
    ));
    let revision = store.revision();
    assert_eq!(
        store
            .set_task_tracking(
                &authority,
                TaskTrackingRecord {
                    updated_at_epoch_ms: 9,
                    ..record.clone()
                }
            )
            .unwrap(),
        revision,
        "an unchanged record commits nothing"
    );
    store.delete_project_sprint(&authority, "2").unwrap();
    assert_eq!(store.task_tracking("task-a").unwrap().sprint_id, None);
    assert_eq!(
        store.task_tracking("task-a").unwrap().developer.as_deref(),
        Some("Ada")
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.project_sprints().len(), 1);
    store.delete_task(&authority, "task-a").unwrap();
    assert!(store.task_tracking_records().is_empty());
    store
        .delete_project_and_related_records(&authority, "pm")
        .unwrap();
    assert!(store.project_sprints().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn a_jira_sprint_sync_replaces_the_projects_sprints_and_moves_tasks_in_one_commit() {
    use termloop_domain::{
        IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, JiraSprintMirror, ProjectSprint,
        SprintState, TaskTrackingRecord,
    };
    let path = std::env::temp_dir().join(format!(
        "termloop-store-jira-sprints-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    store.insert_project(&authority, project("other")).unwrap();
    store.insert_task(&authority, task("task-a", "pm")).unwrap();
    let local = ProjectSprint {
        id: "local".into(),
        project_id: "pm".into(),
        name: "Local".into(),
        state: SprintState::Active,
        created_at_epoch_ms: 1,
        jira: None,
    };
    store
        .create_project_sprint(&authority, local.clone())
        .unwrap();
    store
        .set_task_tracking(
            &authority,
            TaskTrackingRecord {
                task_id: "task-a".into(),
                sprint_id: Some("local".into()),
                note: Some("Keep".into()),
                updated_at_epoch_ms: 1,
                ..TaskTrackingRecord::default()
            },
        )
        .unwrap();
    let mirrored = |id: &str, jira_id: u64, state| ProjectSprint {
        id: id.into(),
        project_id: "pm".into(),
        name: format!("Jira {jira_id}"),
        state,
        created_at_epoch_ms: 2,
        jira: Some(JiraSprintMirror {
            sprint_id: jira_id,
            board_id: 7,
            start_epoch_ms: None,
            end_epoch_ms: None,
        }),
    };
    let copied = TaskRecord {
        rank: 1,
        ..task("task-jira", "pm")
    };
    let link = IssueLink {
        task_id: "task-jira".into(),
        provider: IssueLinkProvider::Jira,
        external_ref: "PAY-1".into(),
        source_id: None,
        external_id: None,
        external_updated_at: None,
        url: Some("https://example.atlassian.net/browse/PAY-1".into()),
        sync_authority: IssueLinkSyncAuthority::None,
    };
    let revision = store.revision();
    // Two sprints cannot mirror one Jira sprint, and nothing is written.
    assert!(matches!(
        store.apply_jira_sprint_sync(
            &authority,
            "pm",
            vec![
                mirrored("j1", 41, SprintState::Active),
                mirrored("j2", 41, SprintState::Planned)
            ],
            vec![],
            vec![],
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert!(matches!(
        store.apply_jira_sprint_sync(
            &authority,
            "pm",
            vec![ProjectSprint {
                project_id: "other".into(),
                ..mirrored("j1", 41, SprintState::Active)
            }],
            vec![],
            vec![],
        ),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.revision(), revision);
    // The local sprint is left out, so task-a returns to the backlog with its
    // note kept; the copied Task lands in the mirrored active sprint.
    let committed = store
        .apply_jira_sprint_sync(
            &authority,
            "pm",
            vec![mirrored("j1", 41, SprintState::Active)],
            vec![(copied, link)],
            vec![TaskTrackingRecord {
                task_id: "task-jira".into(),
                sprint_id: Some("j1".into()),
                updated_at_epoch_ms: 3,
                ..TaskTrackingRecord::default()
            }],
        )
        .unwrap();
    assert_eq!(committed, Some(revision + 1));
    assert_eq!(store.task_tracking("task-a").unwrap().sprint_id, None);
    assert_eq!(
        store.task_tracking("task-a").unwrap().note.as_deref(),
        Some("Keep")
    );
    assert_eq!(
        store
            .task_tracking("task-jira")
            .unwrap()
            .sprint_id
            .as_deref(),
        Some("j1")
    );
    assert_eq!(store.active_sprint("pm").unwrap().id, "j1");
    // The same sync again writes nothing; the state survives a reopen.
    assert_eq!(
        store
            .apply_jira_sprint_sync(
                &authority,
                "pm",
                vec![mirrored("j1", 41, SprintState::Active)],
                vec![],
                vec![],
            )
            .unwrap(),
        None
    );
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .active_sprint("pm")
            .unwrap()
            .jira
            .as_ref()
            .unwrap()
            .sprint_id,
        41
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn ticket_saves_are_numbered_versions_that_keep_the_original_and_the_sprint() {
    use termloop_domain::{
        ProjectSprint, SprintState, TASK_TICKET_VERSIONS_MAX, TaskTicketContent,
        TaskTrackingRecord, TicketAuthor,
    };
    let path = std::env::temp_dir().join(format!(
        "termloop-store-tickets-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    store.insert_task(&authority, task("task-a", "pm")).unwrap();
    store
        .create_project_sprint(
            &authority,
            ProjectSprint {
                id: "s1".into(),
                project_id: "pm".into(),
                name: "Sprint 1".into(),
                state: SprintState::Active,
                created_at_epoch_ms: 1,
                jira: None,
            },
        )
        .unwrap();
    store
        .set_task_tracking(
            &authority,
            TaskTrackingRecord {
                task_id: "task-a".into(),
                sprint_id: Some("s1".into()),
                updated_at_epoch_ms: 2,
                ..TaskTrackingRecord::default()
            },
        )
        .unwrap();
    let content = |brief: &str| TaskTicketContent {
        title: "Ship CORS fix".into(),
        brief: Some(brief.into()),
    };
    let saved = store
        .save_task_ticket(
            &authority,
            "task-a",
            content("First"),
            TicketAuthor::ProjectManager,
            None,
            Some(0),
            false,
            10,
        )
        .unwrap();
    assert_eq!(saved, 2, "the ticket as it was is version 1");
    let original = &store.task_ticket_versions()[0];
    assert_eq!(original.content.title, "task-a");
    assert_eq!(store.tasks()[0].brief.as_deref(), Some("First"));
    let tracking = store.task_tracking("task-a").unwrap();
    assert_eq!(tracking.sprint_id.as_deref(), Some("s1"));

    assert!(matches!(
        store.save_task_ticket(
            &authority,
            "task-a",
            content("Stale"),
            TicketAuthor::ProjectManager,
            None,
            Some(1),
            false,
            11
        ),
        Err(StoreError::RevisionConflict)
    ));
    let revision = store.revision();
    assert_eq!(
        store
            .save_task_ticket(
                &authority,
                "task-a",
                content("First"),
                TicketAuthor::Agent,
                None,
                None,
                false,
                12
            )
            .unwrap(),
        2
    );
    assert_eq!(
        store.revision(),
        revision,
        "unchanged content records nothing"
    );
    for index in 0..TASK_TICKET_VERSIONS_MAX {
        store
            .save_task_ticket(
                &authority,
                "task-a",
                content(&format!("Edit {index}")),
                TicketAuthor::Agent,
                Some("Checked Jira".into()),
                None,
                false,
                20 + index as u64,
            )
            .unwrap();
    }
    assert_eq!(store.task_ticket_versions().len(), TASK_TICKET_VERSIONS_MAX);
    assert_eq!(
        store.task_ticket_head("task-a").unwrap().number,
        2 + TASK_TICKET_VERSIONS_MAX as u64
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.task_ticket_versions().len(), TASK_TICKET_VERSIONS_MAX);
    store.delete_task(&authority, "task-a").unwrap();
    assert!(store.task_ticket_versions().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn accepting_a_proposal_saves_a_version_and_settles_the_proposal_in_one_commit() {
    use termloop_domain::{TaskTicketContent, TaskTicketProposal, TicketAuthor};
    let path = std::env::temp_dir().join(format!(
        "termloop-store-proposals-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    store.insert_task(&authority, task("task-a", "pm")).unwrap();
    let proposal = TaskTicketProposal {
        task_id: "task-a".into(),
        title: None,
        brief: Some("## Status\n- Merged".into()),
        summary: "PR #42 merged".into(),
        base_version: 0,
        proposed_at_epoch_ms: 3,
    };
    assert!(matches!(
        store.set_task_ticket_proposal(
            &authority,
            TaskTicketProposal {
                task_id: "missing".into(),
                ..proposal.clone()
            }
        ),
        Err(StoreError::NotFound)
    ));
    store
        .set_task_ticket_proposal(&authority, proposal.clone())
        .unwrap();
    let revision = store.revision();
    assert_eq!(
        store
            .set_task_ticket_proposal(&authority, proposal.clone())
            .unwrap(),
        revision
    );
    let version = store
        .save_task_ticket(
            &authority,
            "task-a",
            TaskTicketContent {
                title: "task-a".into(),
                brief: proposal.brief.clone(),
            },
            TicketAuthor::Agent,
            Some(proposal.summary.clone()),
            Some(0),
            true,
            5,
        )
        .unwrap();
    assert_eq!(version, 2, "the ticket as it was is version 1");
    assert!(store.task_ticket_proposal("task-a").is_none());
    store
        .set_task_ticket_proposal(&authority, proposal)
        .unwrap();
    store
        .remove_task_ticket_proposal(&authority, "task-a")
        .unwrap();
    assert!(matches!(
        store.remove_task_ticket_proposal(&authority, "task-a"),
        Err(StoreError::NotFound)
    ));
    store
        .set_task_ticket_proposal(
            &authority,
            TaskTicketProposal {
                task_id: "task-a".into(),
                title: Some("Renamed".into()),
                brief: None,
                summary: "Clearer title".into(),
                base_version: 1,
                proposed_at_epoch_ms: 6,
            },
        )
        .unwrap();
    store.delete_task(&authority, "task-a").unwrap();
    assert!(store.task_ticket_proposals().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn delivery_facts_replace_in_place_and_follow_their_task() {
    use termloop_domain::{EnvironmentDeployState, FactSource, TaskDeliveryFacts};
    let path = std::env::temp_dir().join(format!(
        "termloop-store-facts-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    store.insert_task(&authority, task("task-a", "pm")).unwrap();
    let mut facts = TaskDeliveryFacts {
        task_id: "task-a".into(),
        ..TaskDeliveryFacts::default()
    };
    facts.observe_jira("In Review".into(), None, Some("Ada".into()), 1);
    facts.observe_environment(
        "Staging",
        EnvironmentDeployState::Deployed,
        None,
        FactSource::Probe,
        1,
    );
    store
        .set_task_delivery_facts(&authority, vec![facts.clone()])
        .unwrap();
    let revision = store.revision();
    assert_eq!(
        store
            .set_task_delivery_facts(&authority, vec![facts.clone()])
            .unwrap(),
        revision,
        "unchanged facts commit nothing"
    );
    let mut duplicate = facts.clone();
    duplicate
        .environments
        .push(duplicate.environments[0].clone());
    assert!(matches!(
        store.set_task_delivery_facts(&authority, vec![duplicate]),
        Err(StoreError::ConstraintViolation)
    ));
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.task_delivery_facts_for("task-a"), Some(&facts));
    store
        .set_task_delivery_facts(
            &authority,
            vec![TaskDeliveryFacts {
                task_id: "task-a".into(),
                ..TaskDeliveryFacts::default()
            }],
        )
        .unwrap();
    assert!(
        store.task_delivery_facts().is_empty(),
        "empty facts are absent"
    );
    store
        .set_task_delivery_facts(&authority, vec![facts])
        .unwrap();
    store
        .delete_project_and_related_records(&authority, "pm")
        .unwrap();
    assert!(store.task_delivery_facts().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn the_project_manager_mode_switch_is_off_by_default_persists_and_keeps_project_modes() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-manager-switch-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    assert!(!store.project_manager_mode_enabled());
    store.insert_project(&authority, project("switch")).unwrap();
    let revision = store.revision();
    store
        .set_project_mode(&authority, "switch", ProjectMode::ProjectManager, revision)
        .unwrap();
    let revision = store.revision();
    assert_eq!(
        store
            .set_project_manager_mode_enabled(&authority, false)
            .unwrap(),
        revision,
        "writing the current value commits nothing"
    );
    assert!(
        store
            .set_project_manager_mode_enabled(&authority, true)
            .unwrap()
            > revision
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert!(store.project_manager_mode_enabled());
    store
        .set_project_manager_mode_enabled(&authority, false)
        .unwrap();
    assert_eq!(store.project_mode_settings().len(), 1);
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_mode_is_revision_checked_stores_only_non_default_and_is_deleted_with_the_project() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-mode-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-mode"))
        .unwrap();
    let revision = store.revision();
    assert_eq!(
        store
            .set_project_mode(&authority, "project-mode", ProjectMode::Developer, revision)
            .unwrap(),
        revision,
        "the default mode is already current and commits nothing"
    );
    assert!(matches!(
        store.set_project_mode(&authority, "missing", ProjectMode::ProjectManager, revision),
        Err(StoreError::NotFound)
    ));
    let switched = store
        .set_project_mode(
            &authority,
            "project-mode",
            ProjectMode::ProjectManager,
            revision,
        )
        .unwrap();
    assert!(switched > revision);
    assert_eq!(
        store.project_mode_settings(),
        &[ProjectModeSetting {
            project_id: "project-mode".into(),
            mode: ProjectMode::ProjectManager,
        }]
    );
    assert!(matches!(
        store.set_project_mode(&authority, "project-mode", ProjectMode::Developer, revision),
        Err(StoreError::RevisionConflict)
    ));
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.project_mode_settings().len(), 1);
    let revision = store.revision();
    store
        .set_project_mode(&authority, "project-mode", ProjectMode::Developer, revision)
        .unwrap();
    assert!(store.project_mode_settings().is_empty());
    let revision = store.revision();
    store
        .set_project_mode(
            &authority,
            "project-mode",
            ProjectMode::ProjectManager,
            revision,
        )
        .unwrap();
    store
        .delete_project_and_related_records(&authority, "project-mode")
        .unwrap();
    assert!(store.project_mode_settings().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_task_automation_is_revision_checked_and_deleted_with_the_project() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-task-automation-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_project(&authority, project("project-automation"))
        .unwrap();
    let revision = store.revision();
    store
        .set_project_task_automation_configuration(
            &authority,
            ProjectTaskAutomationConfiguration {
                project_id: "project-automation".into(),
                create_worktree: true,
                worktree_prefix: "termloop".into(),
                base_ref: Some("refs/remotes/origin/main".into()),
                agent_id: Some("codex".into()),
                workflow_id: None,
                model: Some("gpt-5.6-sol".into()),
                permission: Some("bypassPermissions".into()),
                reasoning: Some("high".into()),
                kickoff_message: Some("Implement and verify this Task.".into()),
            },
            revision,
        )
        .unwrap();
    assert!(matches!(
        store.set_project_task_automation_configuration(
            &authority,
            ProjectTaskAutomationConfiguration {
                project_id: "project-automation".into(),
                create_worktree: false,
                worktree_prefix: "termloop".into(),
                base_ref: None,
                agent_id: None,
                workflow_id: None,
                model: None,
                permission: None,
                reasoning: None,
                kickoff_message: None,
            },
            revision,
        ),
        Err(StoreError::RevisionConflict)
    ));
    store
        .delete_project_and_related_records(&authority, "project-automation")
        .unwrap();
    assert!(store.project_task_automation_configurations().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn project_delete_blocks_only_worktrees_and_cascades_running_sessions() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-project-delete-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    for project_id in ["project-worktree", "project-cascade"] {
        store
            .insert_project(&authority, project(project_id))
            .unwrap();
    }
    store
        .insert_task(&authority, task("task-worktree", "project-worktree"))
        .unwrap();
    store
        .begin_task_worktree_provisioning(
            &authority,
            WorktreeProvisioningOperation {
                operation_id: "provision-task-worktree".into(),
                task_id: "task-worktree".into(),
                project_id: "project-worktree".into(),
                spec: NormalizedWorktreeSpec {
                    version: 1,
                    repository_root: "/projects/project-worktree".into(),
                    repository_common_dir: "/projects/project-worktree/.git".into(),
                    destination_path: "/worktrees/task-worktree".into(),
                    branch_name: "feature/task-worktree".into(),
                    branch_mode: ProvisioningBranchMode::Create,
                    base_ref: Some("refs/heads/main".into()),
                    base_oid: Some("a".repeat(40)),
                },
                stage: ProvisioningStage::Reserved,
                created_branch_ref: false,
                failure: None,
                started_at_epoch_ms: 1,
                updated_at_epoch_ms: 1,
            },
        )
        .unwrap();
    assert!(matches!(
        store.delete_project_and_related_records(&authority, "project-worktree"),
        Err(StoreError::ProjectHasWorktrees)
    ));

    store
        .insert_task(&authority, task("task-cascade", "project-cascade"))
        .unwrap();
    store
        .insert_session(
            &authority,
            SessionRecord {
                launch_selection: Default::default(),
                id: "running-session".into(),
                project_id: "project-cascade".into(),
                name: None,
                kind: SessionKind::Terminal,
                process: ProcessDescriptor {
                    program: "shell".into(),
                    args: vec![],
                    cwd: "/projects/project-cascade".into(),
                    agent_id: None,
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
    store
        .delete_project_and_related_records(&authority, "project-cascade")
        .unwrap();
    assert!(
        store
            .projects()
            .iter()
            .all(|project| project.id != "project-cascade")
    );
    assert!(
        store
            .tasks()
            .iter()
            .all(|task| task.project_id != "project-cascade")
    );
    assert!(
        store
            .sessions()
            .iter()
            .all(|session| session.project_id != "project-cascade")
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn delivery_probes_run_only_once_approved_and_go_with_their_project() {
    use termloop_domain::{
        DeliveryProbe, PROJECT_PROBES_MAX, ProbeAuthor, ProbeMatcher, ProbeRun, ProbeStatus,
    };
    let path = std::env::temp_dir().join(format!(
        "termloop-store-probes-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    let probe = |id: &str| DeliveryProbe {
        id: id.into(),
        project_id: "pm".into(),
        environment: "Staging".into(),
        argv: vec![
            "curl".into(),
            "-s".into(),
            "https://staging.example.com/version".into(),
        ],
        matcher: ProbeMatcher::CommitAncestry,
        status: ProbeStatus::Proposed,
        author: ProbeAuthor::Agent,
        reason: Some("The version endpoint names the deployed commit".into()),
        created_at_epoch_ms: 1,
        last_run: None,
    };
    store
        .create_delivery_probe(&authority, probe("p1"))
        .unwrap();
    let run = ProbeRun {
        at_epoch_ms: 5,
        output_hash: Some("a".repeat(64)),
        changed_at_epoch_ms: Some(5),
        deployed_commit: Some("abc1234".into()),
        failure: None,
    };
    let argv = probe("p1").argv;
    // A proposed probe never records a run.
    assert!(matches!(
        store.record_delivery_probe_run(&authority, "p1", &argv, run.clone()),
        Err(StoreError::ConstraintViolation)
    ));
    store.approve_delivery_probe(&authority, "p1").unwrap();
    // A run of a command that changed since it was planned is dropped.
    assert!(matches!(
        store.record_delivery_probe_run(&authority, "p1", &["curl".into()], run.clone()),
        Err(StoreError::ConstraintViolation)
    ));
    store
        .record_delivery_probe_run(&authority, "p1", &argv, run.clone())
        .unwrap();
    assert_eq!(store.delivery_probes()[0].last_run.as_ref(), Some(&run));
    assert!(matches!(
        store.create_delivery_probe(
            &authority,
            DeliveryProbe {
                argv: vec!["-rf".into()],
                ..probe("bad")
            }
        ),
        Err(StoreError::ConstraintViolation)
    ));
    for index in 1..PROJECT_PROBES_MAX {
        store
            .create_delivery_probe(&authority, probe(&format!("p{}", index + 1)))
            .unwrap();
    }
    assert!(matches!(
        store.create_delivery_probe(&authority, probe("one-too-many")),
        Err(StoreError::ConstraintViolation)
    ));
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.delivery_probes().len(), PROJECT_PROBES_MAX);
    store.delete_delivery_probe(&authority, "p2").unwrap();
    store
        .delete_project_and_related_records(&authority, "pm")
        .unwrap();
    assert!(store.delivery_probes().is_empty());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn project_environments_replace_in_place_and_go_with_their_project() {
    use termloop_domain::ProjectEnvironment;
    let path = std::env::temp_dir().join(format!(
        "termloop-store-environments-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store.insert_project(&authority, project("pm")).unwrap();
    let list = vec![
        ProjectEnvironment {
            name: "staging".into(),
            production: false,
        },
        ProjectEnvironment {
            name: "live".into(),
            production: true,
        },
    ];
    let revision = store.revision();
    assert!(matches!(
        store.set_project_environments(&authority, "pm", list.clone(), revision + 1),
        Err(StoreError::RevisionConflict)
    ));
    assert!(matches!(
        store.set_project_environments(&authority, "missing", list.clone(), revision),
        Err(StoreError::NotFound)
    ));
    let duplicate = vec![list[0].clone(), list[0].clone()];
    assert!(
        store
            .set_project_environments(&authority, "pm", duplicate, revision)
            .is_err()
    );
    let revision = store.revision();
    let saved = store
        .set_project_environments(&authority, "pm", list.clone(), revision)
        .unwrap();
    // The same list again changes nothing.
    assert_eq!(
        store
            .set_project_environments(&authority, "pm", list.clone(), saved)
            .unwrap(),
        saved
    );
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.project_environments("pm"), list.as_slice());
    let revision = store.revision();
    store
        .set_project_environments(&authority, "pm", vec![], revision)
        .unwrap();
    assert!(store.project_environments("pm").is_empty());
    let revision = store.revision();
    store
        .set_project_environments(&authority, "pm", list, revision)
        .unwrap();
    store
        .delete_project_and_related_records(&authority, "pm")
        .unwrap();
    assert!(store.project_environments("pm").is_empty());
    std::fs::remove_file(path).unwrap();
}
