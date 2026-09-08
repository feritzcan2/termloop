use super::*;
use std::path::PathBuf;
use termloop_contract::current::ProjectionTopic;
use termloop_terminal::TerminalService;

struct Fixture {
    core: CoreRuntime,
    directory: PathBuf,
    project_id: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "termloop-task-creation-{}",
            termloop_platform::generate_uuid_v4()
        ));
        let project_directory = directory.join("project");
        std::fs::create_dir_all(&project_directory).unwrap();
        let mut core =
            CoreRuntime::open(directory.join("state.json"), TerminalService::default(), 1).unwrap();
        let project = core
            .handle(
                "project.create",
                json!({"name": "Project", "folderPath": project_directory}),
            )
            .unwrap();
        Self {
            core,
            directory,
            project_id: project["id"].as_str().unwrap().to_owned(),
        }
    }

    fn params(&self, title: &str) -> Value {
        json!({
            "projectId": self.project_id,
            "title": title,
            "worktreeIntent": "inherit",
            "worktreePrefix": null,
            "baseRef": null,
            "agentId": null,
            "model": null,
            "permission": null,
            "reasoning": null,
            "kickoffMessage": null,
        })
    }

    fn set_defaults(&mut self, prefix: &str) {
        self.core
            .handle(
                "project.taskAutomationSet",
                json!({
                    "projectId": self.project_id,
                    "createWorktree": true,
                    "worktreePrefix": prefix,
                    "baseRef": "refs/remotes/origin/develop",
                    "agentId": null,
                    "model": null,
                    "permission": null,
                    "reasoning": null,
                    "kickoffMessage": null,
                    "expectedRevision": self.core.state_revision(),
                }),
            )
            .unwrap();
    }

    fn task_count(&mut self) -> usize {
        self.core
            .handle("task.list", json!({"projectId": self.project_id}))
            .unwrap()["items"]
            .as_array()
            .unwrap()
            .len()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test]
async fn schema_valid_but_invalid_automation_never_commits_a_task() {
    let mut fixture = Fixture::new();
    for (prefix, base_ref) in [
        ("1task", "refs/remotes/origin/develop"),
        ("a--b", "refs/remotes/origin/develop"),
        ("feature", "refs/remotes/origin/bad..branch"),
    ] {
        let mut params = fixture.params("Rejected automation");
        params["worktreeIntent"] = json!("provision");
        params["worktreePrefix"] = json!(prefix);
        params["baseRef"] = json!(base_ref);
        assert!(protocol::validate_method_params("task.create", &params));
        let revision = fixture.core.state_revision();
        let outcome =
            commit_created_task(&mut fixture.core, serde_json::from_value(params).unwrap());
        let (sender, mut receiver) = mpsc::channel(1);
        let result = outcome
            .finish_with_dispatch(&sender, 7, |_| panic!("rejected creation dispatched"))
            .await;
        assert!(
            matches!(result, Err(CoreError::InvalidParams(field)) if field == "taskAutomation")
        );
        assert_eq!(fixture.core.state_revision(), revision);
        assert_eq!(fixture.task_count(), 0);
        assert!(receiver.try_recv().is_err());
    }
}

#[tokio::test]
async fn full_queue_defers_dispatch_and_response_and_keeps_the_committed_snapshot() {
    let mut fixture = Fixture::new();
    fixture.set_defaults("captured");
    let params = serde_json::from_value(fixture.params("Captured Task")).unwrap();
    let outcome = commit_created_task(&mut fixture.core, params);
    let committed_revision = fixture.core.state_revision();
    fixture.set_defaults("changed");
    let later_revision = fixture.core.state_revision();

    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .send(commit_invalidation(
            CommitImpact::Project,
            later_revision,
            8,
        ))
        .await
        .unwrap();
    let (dispatched, mut actions) = mpsc::unbounded_channel();
    let finish = outcome.finish_with_dispatch(&sender, 7, |batch| dispatched.send(batch).unwrap());
    tokio::pin!(finish);
    tokio::select! {
        biased;
        result = &mut finish => panic!("full queue lost creation effects: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    assert!(actions.try_recv().is_err());
    assert_eq!(
        receiver.recv().await.unwrap().state_revision,
        later_revision
    );
    let task = tokio::time::timeout(Duration::from_secs(1), &mut finish)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        receiver.try_recv().unwrap(),
        InvalidationRequest {
            topics: vec![ProjectionTopic::Task],
            state_revision: committed_revision,
            observation_sequence: 7,
        }
    );
    let actions = actions.try_recv().unwrap();
    assert_eq!(actions.len(), 1);
    assert_eq!(actions[0].task_id, task["id"].as_str().unwrap());
    assert_eq!(actions[0].worktree_prefix, "captured");
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn later_batch_failure_still_publishes_and_dispatches_every_earlier_commit() {
    let mut fixture = Fixture::new();
    fixture.set_defaults("batch");
    let prepared = PreparedTaskAutomation::prepare(
        &fixture.core,
        &fixture.project_id,
        TaskAutomationSelection::inherit(),
    )
    .unwrap();
    let params = [
        fixture.params("First"),
        fixture.params("Second"),
        fixture.params(""),
    ];
    let outcome = TaskCreationOutcome::collect(CommitImpact::TaskSourceImport, |committed| {
        for params in params {
            let before_revision = fixture.core.state_revision();
            let task = fixture.core.handle("task.create", params)?;
            // Exercise the same import-receipt consumption as manual and batch
            // import, with actual durable Core writes and a failing third write.
            committed.record_import(
                &termloop_core::TaskSourceImport {
                    task,
                    state_revision: fixture.core.state_revision(),
                },
                before_revision,
                prepared.clone(),
            );
        }
        Ok(())
    });
    let revision = fixture.core.state_revision();
    assert_eq!(fixture.task_count(), 2);
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .send(commit_invalidation(CommitImpact::Project, revision - 2, 6))
        .await
        .unwrap();
    let (dispatched, mut actions) = mpsc::unbounded_channel();
    let finish = outcome.finish_with_dispatch(&sender, 7, |batch| dispatched.send(batch).unwrap());
    tokio::pin!(finish);
    tokio::select! {
        biased;
        result = &mut finish => panic!("batch failure escaped before committed effects: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    assert!(actions.try_recv().is_err());
    receiver.recv().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), &mut finish)
        .await
        .unwrap();
    assert!(matches!(result, Err(CoreError::InvalidParams(field)) if field == "title"));
    assert_eq!(
        receiver.try_recv().unwrap(),
        InvalidationRequest {
            topics: vec![ProjectionTopic::TaskSource, ProjectionTopic::Task],
            state_revision: revision,
            observation_sequence: 7,
        }
    );
    assert_eq!(
        actions
            .try_recv()
            .unwrap()
            .iter()
            .map(|action| action.title.as_str())
            .collect::<Vec<_>>(),
        vec!["First", "Second"]
    );
    assert!(receiver.try_recv().is_err());
}

#[tokio::test]
async fn unchanged_import_receipt_does_not_dispatch_automation_again() {
    let mut fixture = Fixture::new();
    let params = fixture.params("Existing Task");
    let task = fixture.core.handle("task.create", params).unwrap();
    let revision = fixture.core.state_revision();
    let automation = PreparedTaskAutomation::prepare(
        &fixture.core,
        &fixture.project_id,
        TaskAutomationSelection::inherit(),
    )
    .unwrap();
    let outcome = TaskCreationOutcome::collect(CommitImpact::TaskSourceImport, |committed| {
        committed.record_import(
            &termloop_core::TaskSourceImport {
                task: task.clone(),
                state_revision: revision,
            },
            revision,
            automation,
        );
        Ok(task.clone())
    });
    let (sender, mut receiver) = mpsc::channel(1);
    assert_eq!(
        outcome
            .finish_with_dispatch(&sender, 7, |_| panic!("unchanged import dispatched"))
            .await
            .unwrap(),
        task
    );
    assert_eq!(receiver.try_recv().unwrap().state_revision, revision);
    assert_eq!(fixture.task_count(), 1);
}

#[tokio::test]
async fn steward_creation_waits_for_all_of_its_topics_before_dispatch() {
    let (sender, mut receiver) = mpsc::channel(1);
    sender
        .send(commit_invalidation(CommitImpact::Project, 40, 6))
        .await
        .unwrap();
    let mut fixture = Fixture::new();
    let prepared = PreparedTaskAutomation::prepare(
        &fixture.core,
        &fixture.project_id,
        TaskAutomationSelection::inherit(),
    )
    .unwrap();
    let params = fixture.params("Steward Task");
    let outcome = TaskCreationOutcome::collect(CommitImpact::StewardTask, |committed| {
        let task = fixture.core.handle("task.create", params)?;
        committed.record(&task, fixture.core.state_revision(), Some(prepared));
        Ok(task)
    });
    let (dispatched, mut actions) = mpsc::unbounded_channel();
    let finish = outcome.finish_with_dispatch(&sender, 7, |batch| dispatched.send(batch).unwrap());
    tokio::pin!(finish);
    tokio::select! {
        biased;
        result = &mut finish => panic!("Steward creation skipped queue capacity: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    assert!(actions.try_recv().is_err());
    receiver.recv().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), &mut finish)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        receiver.try_recv().unwrap().topics,
        vec![
            ProjectionTopic::Task,
            ProjectionTopic::Companion,
            ProjectionTopic::Steward
        ]
    );
    assert_eq!(actions.try_recv().unwrap().len(), 1);
}

#[tokio::test]
async fn post_commit_projection_failure_keeps_the_success_and_publication() {
    let mut fixture = Fixture::new();
    let automation = PreparedTaskAutomation::prepare(
        &fixture.core,
        &fixture.project_id,
        TaskAutomationSelection::inherit(),
    )
    .unwrap();
    let params = fixture.params("Durable Task");
    let outcome = TaskCreationOutcome::collect(CommitImpact::Task, |committed| {
        let task = fixture.core.handle("task.create", params)?;
        let mut incomplete = task.clone();
        incomplete.as_object_mut().unwrap().remove("title");
        committed.record(&incomplete, fixture.core.state_revision(), Some(automation));
        Ok(task)
    });
    let (sender, mut receiver) = mpsc::channel(1);
    let task = outcome
        .finish_with_dispatch(&sender, 7, |_| panic!("invalid projection dispatched"))
        .await
        .unwrap();
    assert_eq!(task["title"], "Durable Task");
    assert_eq!(
        receiver.try_recv().unwrap().state_revision,
        fixture.core.state_revision()
    );
    assert_eq!(fixture.task_count(), 1);
}

#[tokio::test]
async fn failed_or_empty_collection_has_no_publication_or_dispatch() {
    let (sender, mut receiver) = mpsc::channel(1);
    let outcome = TaskCreationOutcome::<()>::collect(CommitImpact::Task, |_| {
        Err(CoreError::RevisionConflict)
    });
    assert!(matches!(
        outcome
            .finish_with_dispatch(&sender, 7, |_| panic!("failed write dispatched"))
            .await,
        Err(CoreError::RevisionConflict)
    ));
    let outcome = TaskCreationOutcome::collect(CommitImpact::TaskSourceImport, |_| Ok(()));
    outcome
        .finish_with_dispatch(&sender, 7, |_| panic!("empty batch dispatched"))
        .await
        .unwrap();
    assert!(receiver.try_recv().is_err());
}
