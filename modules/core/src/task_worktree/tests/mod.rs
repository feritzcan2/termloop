use super::git_mapping::{local_branch_ref, map_git_observation_error};
use super::provisioning::{observe_provisioning_spec, provisioning_marker};
use super::*;
use crate::{CoreError, CoreRuntime};
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use termloop_domain::{
    ProvisioningFailureKind, ProvisioningStage, TaskBranchBinding, WorktreeCleanupBlocker,
    WorktreeCleanupFailureKind, WorktreeCleanupStage, WorktreeProvisioningOperation,
};
use termloop_gitio::{GitError, GitRefName, GitReflogMessage, GitRunner, ObjectId};
use termloop_store::Store;
use termloop_terminal::TerminalService;
use uuid::Uuid;

mod archive;
mod branch_binding;
mod branch_commits;
mod changes;
mod cleanup;
mod health_presence;
mod provisioning;
mod recovery;
mod relocation;
mod stale_disposal;

fn failed_observation<F>(fixture: &Fixture, task_id: &str, create_runner: F) -> CoreError
where
    F: FnOnce() -> Result<GitRunner, GitError>,
{
    let revision = fixture.runtime.state_revision();
    let tasks = fixture
        .runtime
        .list_tasks(json!({ "projectId": fixture.project_id }))
        .unwrap();
    let plan = fixture
        .runtime
        .plan_task_branch_binding(json!({
            "taskId": task_id,
            "repositoryPath": fixture.project_directory,
            "branchName": "main",
        }))
        .unwrap();
    let error = match create_runner()
        .map_err(map_git_observation_error)
        .and_then(|runner| plan.observe_with_runner(&runner))
    {
        Err(error) => error,
        Ok(_) => panic!("fake Git observation unexpectedly succeeded"),
    };
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert_eq!(
        fixture
            .runtime
            .list_tasks(json!({ "projectId": fixture.project_id }))
            .unwrap(),
        tasks
    );
    error
}

struct Fixture {
    runtime: CoreRuntime,
    fixture_root: std::path::PathBuf,
    state_path: std::path::PathBuf,
    project_directory: std::path::PathBuf,
    project_id: String,
}

impl Fixture {
    fn new() -> Self {
        let id = Uuid::new_v4();
        // Keep repositories and candidate worktrees below a non-mount parent.
        // On Linux `/tmp` is commonly its own mount, which correctly trips the
        // stale-disposal parent mount/root guard for direct children.
        let fixture_root = std::env::temp_dir()
            .join("termloop-next-test-fixtures")
            .join(format!("termloop-task-{id}"));
        let state_path = fixture_root.join("state.json");
        // One extra ordinary directory keeps the candidate worktree's parent
        // below `/tmp` itself when CI mounts `/tmp` as a separate filesystem.
        let project_directory = fixture_root.join("checkouts/project");
        std::fs::create_dir_all(&project_directory).unwrap();
        let authority = termloop_store::issue_core_write_authority_for_composition();
        let store = Store::open(&state_path).unwrap();
        let mut runtime =
            CoreRuntime::new(store, authority, TerminalService::default(), 1).unwrap();
        let project = runtime
            .create_project(json!({
                "name": "Project",
                "folderPath": project_directory,
            }))
            .unwrap();
        Self {
            runtime,
            fixture_root,
            state_path,
            project_directory,
            project_id: project["id"].as_str().unwrap().to_owned(),
        }
    }

    fn create_task(&mut self, title: &str, brief: Value) -> Value {
        self.runtime
            .create_task(json!({
                "projectId": self.project_id,
                "title": title,
                "brief": brief,
                "worktreeIntent": "none",
            }))
            .unwrap()
    }

    fn rewrite_state_and_reopen(&mut self, rewrite: impl FnOnce(&mut Value)) {
        let mut state: Value = serde_json::from_slice(&std::fs::read(&self.state_path).unwrap())
            .expect("fixture state is valid JSON");
        rewrite(&mut state);
        std::fs::write(
            &self.state_path,
            serde_json::to_vec_pretty(&state).expect("fixture state serializes"),
        )
        .unwrap();
        let authority = termloop_store::issue_core_write_authority_for_composition();
        self.runtime = CoreRuntime::new(
            Store::open(&self.state_path).unwrap(),
            authority,
            TerminalService::default(),
            1,
        )
        .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.fixture_root);
    }
}

struct FakeGit {
    directory: PathBuf,
    program: PathBuf,
}

impl FakeGit {
    fn compile(label: &str, body: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("termloop-core-fake-git-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let source = directory.join("fake_git.rs");
        let program = directory.join(format!("fake-git{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&source, body).unwrap();
        let status = Command::new("rustc")
            .args([source.as_os_str(), OsStr::new("-o"), program.as_os_str()])
            .status()
            .unwrap();
        assert!(status.success(), "fake Git fixture did not compile");
        Self { directory, program }
    }
}

impl Drop for FakeGit {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn reserve_create_operation(
    fixture: &mut Fixture,
    runner: &GitRunner,
    task_id: &str,
    destination: &Path,
    branch_name: &str,
) -> WorktreeProvisioningOperation {
    reserve_operation(
        fixture,
        runner,
        json!({
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": branch_name,
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }),
        task_id,
    )
}

fn provision_cleanup_fixture(fixture: &mut Fixture) -> (String, PathBuf, String, u64) {
    let runner = GitRunner::discover().unwrap();
    termloop_gitio::test_support::initialize_repository(&runner, &fixture.project_directory)
        .unwrap();
    let task = fixture.create_task("Cleanup", Value::Null);
    let task_id = task["id"].as_str().unwrap().to_owned();
    let destination = fixture
        .project_directory
        .with_file_name(format!("cleanup-worktree-{}", Uuid::new_v4()));
    fixture
        .runtime
        .provision_task_worktree(json!({
            "operationId": Uuid::new_v4().to_string(),
            "taskId": task_id,
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": "feature/cleanup",
            "branchMode": "create",
            "baseRef": "refs/heads/main",
        }))
        .unwrap();
    let proof = fixture.runtime.store.managed_worktrees()[0].clone();
    (
        task_id,
        destination,
        proof.operation_id,
        proof.worktree_generation,
    )
}

fn cleanup_params(task_id: &str, operation_id: &str, proof_id: &str, generation: u64) -> Value {
    json!({
        "operationId": operation_id,
        "taskId": task_id,
        "expectedManagedWorktreeOperationId": proof_id,
        "expectedWorktreeGeneration": generation,
        "cleanupMode": "safe",
        "acknowledgedContentBlockers": [],
    })
}

fn stale_resolution_params(
    task_id: &str,
    operation_id: &str,
    proof_id: Option<&str>,
    generation: u64,
    target: &Path,
    acknowledge_disposal: bool,
) -> Value {
    let mut params = json!({
        "operationId": operation_id,
        "taskId": task_id,
        "expectedManagedWorktreeOperationId": proof_id,
        "expectedWorktreeGeneration": generation,
        "targetPath": target,
    });
    if acknowledge_disposal {
        params["acknowledgeUnverifiedDirectoryDeletion"] = json!(true);
    }
    params
}

fn prepare_cleanup_removal(fixture: &mut Fixture, params: Value) -> TaskWorktreeCleanupRemovalStep {
    let plan = match fixture.runtime.plan_task_worktree_cleanup(params).unwrap() {
        TaskWorktreeCleanupPlanning::Observe(plan) => plan,
        TaskWorktreeCleanupPlanning::Return(_) | TaskWorktreeCleanupPlanning::Finalize(_) => {
            panic!("cleanup unexpectedly completed")
        }
    };
    let progress = fixture
        .runtime
        .begin_task_worktree_cleanup(plan.observe().unwrap())
        .unwrap();
    let TaskWorktreeCleanupProgress::Revalidate(step) = progress else {
        panic!("cleanup did not enter final revalidation");
    };
    let progress = fixture
        .runtime
        .apply_task_worktree_cleanup_observation(step.observe().unwrap())
        .unwrap();
    let TaskWorktreeCleanupProgress::Remove(step) = progress else {
        panic!("cleanup did not prepare removal");
    };
    *step
}

fn reserve_existing_operation(
    fixture: &mut Fixture,
    runner: &GitRunner,
    task_id: &str,
    destination: &Path,
    branch_name: &str,
) -> WorktreeProvisioningOperation {
    reserve_operation(
        fixture,
        runner,
        json!({
            "repositoryPath": fixture.project_directory,
            "destinationPath": destination,
            "branchName": branch_name,
            "branchMode": "existing",
        }),
        task_id,
    )
}

fn reserve_operation(
    fixture: &mut Fixture,
    runner: &GitRunner,
    params: Value,
    task_id: &str,
) -> WorktreeProvisioningOperation {
    let task = fixture
        .runtime
        .store
        .tasks()
        .iter()
        .find(|task| task.id == task_id)
        .unwrap()
        .clone();
    let observed = observe_provisioning_spec(
        runner,
        &params,
        &task,
        &fixture.project_directory,
        None,
        false,
    )
    .unwrap();
    let operation = WorktreeProvisioningOperation {
        operation_id: Uuid::new_v4().to_string(),
        task_id: task.id,
        project_id: fixture.project_id.clone(),
        spec: observed.spec,
        stage: ProvisioningStage::Reserved,
        created_branch_ref: false,
        failure: None,
        started_at_epoch_ms: 1,
        updated_at_epoch_ms: 1,
    };
    fixture
        .runtime
        .store
        .begin_task_worktree_provisioning(&fixture.runtime.write_authority, operation.clone())
        .unwrap();
    operation
}
