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

const INVALIDATION_COALESCE_WINDOW: Duration = Duration::from_millis(100);

#[derive(Debug)]
pub(super) struct InvalidationRequest {
    pub(super) topics: Vec<ProjectionTopic>,
    pub(super) state_revision: u64,
    pub(super) observation_sequence: u64,
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
            ProjectionTopic::GitHost => "gitHost",
            ProjectionTopic::BranchCommit => "branchCommit",
            ProjectionTopic::Companion => "companion",
            ProjectionTopic::Steward => "steward",
            ProjectionTopic::Routine => "routine",
            ProjectionTopic::TaskSource => "taskSource",
            ProjectionTopic::Playbook => "playbook",
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
        "gitHost" => Some(ProjectionTopic::GitHost),
        "branchCommit" => Some(ProjectionTopic::BranchCommit),
        "companion" => Some(ProjectionTopic::Companion),
        "steward" => Some(ProjectionTopic::Steward),
        "routine" => Some(ProjectionTopic::Routine),
        "taskSource" => Some(ProjectionTopic::TaskSource),
        "playbook" => Some(ProjectionTopic::Playbook),
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
    let cwd = state.core.lock().await.session_cwd(session_id);
    if let Some(cwd) = cwd {
        refresh_task_presence_for_cwd(state, &cwd).await;
    }
    publish_session_invalidation(state).await;
}

pub(super) async fn publish_session_invalidation(state: &AppState) {
    let state_revision = state.core.lock().await.state_revision();
    let _ = state.invalidation_requests.try_send(InvalidationRequest {
        topics: vec![ProjectionTopic::Session, ProjectionTopic::AgentStatus],
        state_revision,
        observation_sequence: state.observation_sequence.load(Ordering::Relaxed),
    });
}

pub(super) fn mutation_topics(method: &str) -> Vec<ProjectionTopic> {
    if method.starts_with("steward.configuration") {
        vec![ProjectionTopic::Steward]
    } else if method.starts_with("runConfiguration.") {
        vec![ProjectionTopic::Run]
    } else if method.starts_with("routine.configuration") || method == "routine.contextUpdate" {
        vec![ProjectionTopic::Routine]
    } else if method.starts_with("playbook.") {
        vec![ProjectionTopic::Playbook]
    } else if method.starts_with("companion.transcript") {
        vec![ProjectionTopic::Companion]
    } else if method == "project.delete" {
        vec![
            ProjectionTopic::Project,
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
            ProjectionTopic::Companion,
            ProjectionTopic::Steward,
            ProjectionTopic::Routine,
            ProjectionTopic::Run,
            ProjectionTopic::Playbook,
            ProjectionTopic::GitHost,
        ]
    } else if method.starts_with("project.") {
        vec![ProjectionTopic::Project]
    } else if matches!(
        method,
        "task.archive" | "task.restore" | "task.abandonArchive" | "task.deleteArchived"
    ) {
        vec![
            ProjectionTopic::Task,
            ProjectionTopic::Session,
            ProjectionTopic::AgentStatus,
        ]
    } else if method.starts_with("task.") {
        vec![ProjectionTopic::Task]
    } else if method.starts_with("session.") {
        if matches!(
            method,
            "session.archive" | "session.restoreArchived" | "session.deleteArchived"
        ) {
            vec![ProjectionTopic::Session, ProjectionTopic::AgentStatus]
        } else {
            vec![ProjectionTopic::Session]
        }
    } else {
        vec![]
    }
}
