use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::Ordering;

use termloop_contract::current::{
    ProjectionInvalidatedPayload, ProjectionTopic, TaskProjectionEntityScopeDto,
    TaskProjectionTopic,
};
use tokio::sync::{broadcast, mpsc};
use tokio::time::Duration;

use super::{AppState, current_epoch_ms};

mod session_mutation;
pub(super) use session_mutation::{CommittedSessionMutation, finish_session_mutation};

const INVALIDATION_COALESCE_WINDOW: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq, Eq)]
pub(super) struct InvalidationRequest {
    pub(super) topics: Vec<ProjectionTopic>,
    pub(super) state_revision: u64,
    pub(super) observation_sequence: u64,
}

/// One closed description of the projections changed by a committed control
/// write. Callers select the lifecycle impact; this module alone translates it
/// into transport topics and queues the publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CommitImpact {
    Project,
    Task,
    TaskSessionAgent,
    Session,
    SessionAgent,
    SessionWorkflow,
    SessionTermination,
    AgentLibrary,
    Companion,
    Steward,
    Routine,
    TaskSource,
    TaskSourceImport,
    Run,
    Playbook,
    Workflow,
}

impl CommitImpact {
    fn topics(self) -> Vec<ProjectionTopic> {
        match self {
            Self::Project => vec![ProjectionTopic::Project],
            Self::Task => vec![ProjectionTopic::Task],
            Self::TaskSessionAgent => vec![
                ProjectionTopic::Task,
                ProjectionTopic::Session,
                ProjectionTopic::AgentStatus,
            ],
            Self::Session => vec![ProjectionTopic::Session],
            Self::SessionAgent => {
                vec![ProjectionTopic::Session, ProjectionTopic::AgentStatus]
            }
            Self::SessionWorkflow => vec![ProjectionTopic::Session, ProjectionTopic::Workflow],
            Self::SessionTermination => vec![
                ProjectionTopic::Session,
                ProjectionTopic::Steward,
                ProjectionTopic::Routine,
            ],
            Self::AgentLibrary => vec![ProjectionTopic::AgentLibrary],
            Self::Companion => vec![ProjectionTopic::Companion],
            Self::Steward => vec![ProjectionTopic::Steward],
            Self::Routine => vec![ProjectionTopic::Routine],
            Self::TaskSource => vec![ProjectionTopic::TaskSource],
            Self::TaskSourceImport => {
                vec![ProjectionTopic::TaskSource, ProjectionTopic::Task]
            }
            Self::Run => vec![ProjectionTopic::Run],
            Self::Playbook => vec![ProjectionTopic::Playbook],
            Self::Workflow => vec![ProjectionTopic::Workflow],
        }
    }
}

fn commit_invalidation(
    impact: CommitImpact,
    state_revision: u64,
    observation_sequence: u64,
) -> InvalidationRequest {
    InvalidationRequest {
        topics: impact.topics(),
        state_revision,
        observation_sequence,
    }
}

fn changed_commit_invalidation(
    impact: CommitImpact,
    previous_revision: u64,
    current_revision: u64,
    observation_sequence: u64,
) -> Option<InvalidationRequest> {
    (current_revision != previous_revision)
        .then(|| commit_invalidation(impact, current_revision, observation_sequence))
}

pub(super) async fn queue_commit_invalidation(
    state: &AppState,
    impact: CommitImpact,
    state_revision: u64,
    observation_sequence: u64,
) {
    queue_invalidation(
        &state.invalidation_requests,
        commit_invalidation(impact, state_revision, observation_sequence),
    )
    .await;
}

/// Await backpressure so a full queue cannot silently lose a committed
/// revision. Callers must release the serialized Core lock before entering.
pub(super) async fn queue_invalidation(
    sender: &mpsc::Sender<InvalidationRequest>,
    invalidation: InvalidationRequest,
) {
    if sender.send(invalidation).await.is_err() {
        tracing::warn!("Committed write invalidation queue is closed");
    }
}

pub(super) async fn queue_durable_commit_invalidation(
    state: &AppState,
    impact: CommitImpact,
    state_revision: u64,
) {
    queue_commit_invalidation(
        state,
        impact,
        state_revision,
        state.observation_sequence.load(Ordering::Relaxed),
    )
    .await;
}

pub(super) async fn queue_changed_commit_invalidation(
    state: &AppState,
    impact: CommitImpact,
    previous_revision: u64,
    current_revision: u64,
) {
    if let Some(invalidation) = changed_commit_invalidation(
        impact,
        previous_revision,
        current_revision,
        state.observation_sequence.load(Ordering::Relaxed),
    ) {
        queue_invalidation(&state.invalidation_requests, invalidation).await;
    }
}

pub(super) async fn coalesce_invalidations(
    mut receiver: mpsc::Receiver<InvalidationRequest>,
    publisher: broadcast::Sender<ProjectionInvalidatedPayload>,
) {
    while let Some(first) = receiver.recv().await {
        let mut topics = BTreeSet::new();
        extend_topic_names(&mut topics, first.topics);
        let mut state_revision = first.state_revision;
        let mut observation_sequence = first.observation_sequence;
        tokio::time::sleep(INVALIDATION_COALESCE_WINDOW).await;
        while let Ok(request) = receiver.try_recv() {
            extend_topic_names(&mut topics, request.topics);
            state_revision = state_revision.max(request.state_revision);
            observation_sequence = observation_sequence.max(request.observation_sequence);
        }
        let payload = ProjectionInvalidatedPayload {
            topics: topics.into_iter().filter_map(projection_topic).collect(),
            state_revision,
            observation_sequence,
            entity_scopes: None,
        };
        let _ = publisher.send(payload);
    }
}

pub(super) async fn refresh_task_presence_for_cwd(state: &AppState, cwd: &str) {
    let (applied, state_revision) = {
        let mut core = state.core.lock().await;
        let applied =
            core.refresh_task_worktree_presence_for_cwd(Path::new(cwd), current_epoch_ms());
        (applied, core.state_revision())
    };
    let Ok(applied) = applied else {
        return;
    };
    let mut ids = Vec::new();
    let mut sequence = 0;
    for (task_id, result) in applied {
        if result.changed {
            ids.push(task_id);
            sequence = sequence.max(result.observation_sequence);
        }
    }
    if ids.is_empty() {
        return;
    }
    ids.sort();
    ids.dedup();
    state
        .observation_sequence
        .fetch_max(sequence, Ordering::Relaxed);
    let _ = state.invalidations.send(ProjectionInvalidatedPayload {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: sequence,
        entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
            topic: TaskProjectionTopic::Task,
            ids,
        }]),
    });
}

fn extend_topic_names(topics: &mut BTreeSet<&'static str>, values: Vec<ProjectionTopic>) {
    for topic in values {
        topics.insert(match topic {
            ProjectionTopic::Project => "project",
            ProjectionTopic::Task => "task",
            ProjectionTopic::Session => "session",
            ProjectionTopic::AgentStatus => "agentStatus",
            ProjectionTopic::AgentLibrary => "agentLibrary",
            ProjectionTopic::GitHost => "gitHost",
            ProjectionTopic::BranchCommit => "branchCommit",
            ProjectionTopic::Companion => "companion",
            ProjectionTopic::Steward => "steward",
            ProjectionTopic::Routine => "routine",
            ProjectionTopic::TaskSource => "taskSource",
            ProjectionTopic::Playbook => "playbook",
            ProjectionTopic::Workflow => "workflow",
            ProjectionTopic::KeepAwake => "keepAwake",
            ProjectionTopic::Run => "run",
        });
    }
}

fn projection_topic(value: &'static str) -> Option<ProjectionTopic> {
    match value {
        "project" => Some(ProjectionTopic::Project),
        "task" => Some(ProjectionTopic::Task),
        "session" => Some(ProjectionTopic::Session),
        "agentStatus" => Some(ProjectionTopic::AgentStatus),
        "agentLibrary" => Some(ProjectionTopic::AgentLibrary),
        "gitHost" => Some(ProjectionTopic::GitHost),
        "branchCommit" => Some(ProjectionTopic::BranchCommit),
        "companion" => Some(ProjectionTopic::Companion),
        "steward" => Some(ProjectionTopic::Steward),
        "routine" => Some(ProjectionTopic::Routine),
        "taskSource" => Some(ProjectionTopic::TaskSource),
        "playbook" => Some(ProjectionTopic::Playbook),
        "workflow" => Some(ProjectionTopic::Workflow),
        "keepAwake" => Some(ProjectionTopic::KeepAwake),
        "run" => Some(ProjectionTopic::Run),
        _ => None,
    }
}

pub(super) fn publish_task_invalidation_now(state: &AppState, state_revision: u64) {
    // The reservation must become observable before any blocking Git step;
    // later journal transitions may use the normal coalescing window.
    let _ = state.invalidations.send(ProjectionInvalidatedPayload {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        entity_scopes: None,
    });
}

pub(super) fn queue_task_invalidation(state: &AppState, state_revision: u64) {
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
}

pub(super) fn publish_scoped_task_invalidation(
    state: &AppState,
    state_revision: u64,
    task_id: &str,
) {
    let _ = state.invalidations.send(ProjectionInvalidatedPayload {
        topics: vec![ProjectionTopic::Task],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
            topic: TaskProjectionTopic::Task,
            ids: vec![task_id.to_owned()],
        }]),
    });
}

fn publish_git_host_invalidation(state: &AppState, state_revision: u64, task_id: &str) {
    let _ = state.invalidations.send(ProjectionInvalidatedPayload {
        topics: vec![ProjectionTopic::GitHost],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
        entity_scopes: Some(vec![TaskProjectionEntityScopeDto {
            topic: TaskProjectionTopic::GitHost,
            ids: vec![task_id.to_owned()],
        }]),
    });
}

pub(super) async fn invalidate_automatic_git_host_task(state: &AppState, task_id: &str) {
    let state_revision = {
        let mut core = state.core.lock().await;
        if !core.git_host_task_is_automatic(task_id) {
            return;
        }
        core.invalidate_git_host_task(task_id);
        core.state_revision()
    };
    publish_git_host_invalidation(state, state_revision, task_id);
}

pub(super) async fn publish_agent_resume_invalidation(state: &AppState, session_id: &str) {
    let (cwd, workflow_redelivery) = {
        let mut core = state.core.lock().await;
        let cwd = core.session_cwd(session_id);
        let workflow_redelivery = core.redeliver_pending_workflow_prompt(session_id);
        (cwd, workflow_redelivery)
    };
    if let Err(error) = workflow_redelivery
        && !matches!(
            error,
            termloop_core::CoreError::NotFound | termloop_core::CoreError::ConversationBusy
        )
    {
        tracing::warn!(%session_id, %error, "workflow step prompt redelivery failed");
    }
    if let Some(cwd) = cwd {
        refresh_task_presence_for_cwd(state, &cwd).await;
    }
    publish_session_invalidation(state).await;
}

pub(super) async fn publish_session_invalidation(state: &AppState) {
    let state_revision = state.core.lock().await.state_revision();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
            ProjectionTopic::Workflow,
        ],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
}

pub(super) fn fallback_mutation_impact(method: &str) -> Option<CommitImpact> {
    if matches!(
        method,
        "project.delete"
            | "task.archive"
            | "task.restore"
            | "task.reopen"
            | "session.archive"
            | "session.restoreArchived"
    ) {
        None
    } else if matches!(
        method,
        "agent.profileCreate"
            | "agent.profileUpdate"
            | "agent.profileDelete"
            | "agent.profileFavorite"
    ) {
        Some(CommitImpact::AgentLibrary)
    } else if method.starts_with("steward.configuration") {
        Some(CommitImpact::Steward)
    } else if method.starts_with("runConfiguration.") {
        Some(CommitImpact::Run)
    } else if method.starts_with("workflow.configuration")
        || method.starts_with("workflow.execution")
    {
        Some(CommitImpact::Workflow)
    } else if method.starts_with("routine.configuration") || method == "routine.contextUpdate" {
        Some(CommitImpact::Routine)
    } else if method.starts_with("playbook.") {
        Some(CommitImpact::Playbook)
    } else if method.starts_with("companion.transcript") {
        Some(CommitImpact::Companion)
    } else if method.starts_with("project.") {
        Some(CommitImpact::Project)
    } else if matches!(method, "task.abandonArchive" | "task.deleteArchived") {
        Some(CommitImpact::TaskSessionAgent)
    } else if method.starts_with("task.") {
        Some(CommitImpact::Task)
    } else if method.starts_with("session.") {
        if method == "session.deleteArchived" {
            Some(CommitImpact::SessionAgent)
        } else {
            Some(CommitImpact::Session)
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_library_writes_publish_the_library_topic() {
        for method in [
            "agent.profileCreate",
            "agent.profileUpdate",
            "agent.profileDelete",
            "agent.profileFavorite",
        ] {
            assert_eq!(
                fallback_mutation_impact(method),
                Some(CommitImpact::AgentLibrary)
            );
        }
        assert_eq!(fallback_mutation_impact("agent.libraryGet"), None);
        let mut names = BTreeSet::new();
        extend_topic_names(&mut names, CommitImpact::AgentLibrary.topics());
        assert_eq!(names, BTreeSet::from(["agentLibrary"]));
        assert_eq!(
            projection_topic("agentLibrary"),
            Some(ProjectionTopic::AgentLibrary)
        );
    }

    #[test]
    fn commit_impacts_own_ordered_projection_topic_sets() {
        assert_eq!(
            commit_invalidation(CommitImpact::TaskSessionAgent, 9, 11),
            InvalidationRequest {
                topics: vec![
                    ProjectionTopic::Task,
                    ProjectionTopic::Session,
                    ProjectionTopic::AgentStatus,
                ],
                state_revision: 9,
                observation_sequence: 11,
            }
        );
        assert_eq!(
            commit_invalidation(CommitImpact::TaskSourceImport, 12, 14).topics,
            vec![ProjectionTopic::TaskSource, ProjectionTopic::Task]
        );
    }

    #[test]
    fn changed_commit_invalidates_the_new_revision_and_no_op_does_not() {
        assert_eq!(
            changed_commit_invalidation(CommitImpact::SessionAgent, 20, 21, 34),
            Some(InvalidationRequest {
                topics: vec![ProjectionTopic::Session, ProjectionTopic::AgentStatus],
                state_revision: 21,
                observation_sequence: 34,
            })
        );
        assert_eq!(
            changed_commit_invalidation(CommitImpact::SessionAgent, 21, 21, 34),
            None
        );
    }

    #[tokio::test]
    async fn committed_invalidation_waits_for_queue_capacity_instead_of_dropping() {
        let (sender, mut receiver) = mpsc::channel(1);
        sender
            .send(commit_invalidation(CommitImpact::Task, 1, 2))
            .await
            .expect("test invalidation receiver remains open");

        let queued_sender = sender.clone();
        let queued = tokio::spawn(async move {
            queue_invalidation(
                &queued_sender,
                commit_invalidation(CommitImpact::Session, 3, 4),
            )
            .await;
        });
        tokio::task::yield_now().await;
        assert!(!queued.is_finished());

        assert_eq!(
            receiver.recv().await,
            Some(commit_invalidation(CommitImpact::Task, 1, 2))
        );
        queued.await.expect("queued invalidation task completes");
        assert_eq!(
            receiver.recv().await,
            Some(commit_invalidation(CommitImpact::Session, 3, 4))
        );
    }

    #[test]
    fn fallback_policy_contains_only_lifecycles_dispatched_through_core_handle() {
        assert_eq!(
            fallback_mutation_impact("task.abandonArchive"),
            Some(CommitImpact::TaskSessionAgent)
        );
        assert_eq!(
            fallback_mutation_impact("session.deleteArchived"),
            Some(CommitImpact::SessionAgent)
        );
        assert_eq!(
            fallback_mutation_impact("workflow.configurationCreate"),
            Some(CommitImpact::Workflow)
        );
        for dedicated in [
            "project.delete",
            "task.archive",
            "task.restore",
            "task.reopen",
            "session.archive",
            "session.restoreArchived",
        ] {
            assert_eq!(fallback_mutation_impact(dedicated), None, "{dedicated}");
        }
    }
}
