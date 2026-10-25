//! Sprints mirrored from Jira for Project Manager Projects whose Jira Task
//! Source selects boards. Jira owns those sprints and which issues its active
//! sprint holds: TermLoop copies each new issue of the active sprint into a
//! Task and keeps the sprint of every Jira-linked Task in step. Tasks without
//! a Jira link keep the sprint the Project Manager gave them.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use termloop_domain::{
    IssueLink, IssueLinkProvider, IssueLinkSyncAuthority, JiraSprintMirror, PROJECT_SPRINTS_MAX,
    ProjectSprint, SprintState, TaskRecord, TaskSourceConfiguration, TaskSourceScope, TaskStatus,
    TaskTrackingRecord,
};
use termloop_providers::{JiraSprint, JiraSprintState};

use crate::task_source::{TaskSourceCandidateSnapshot, imported_brief, imported_title};
use crate::{CoreError, CoreRuntime, JiraSprintObservation, TaskSourceFailure, store_error};

/// The most boards one Project's sprints follow.
const SPRINT_BOARDS_MAX: usize = 4;
/// The most Tasks one sync copies from the active sprint.
const SYNC_NEW_TASKS_MAX: usize = 100;

/// One planned sprint read of a Project; the server reads Jira with the
/// source's stored credential outside the core lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraSprintSyncPlan {
    pub project_id: String,
    pub source_id: String,
    generation: u64,
    pub site_base_url: String,
    pub board_ids: Vec<u64>,
}

/// Tasks newly copied from the active sprint with their Jira links, and the
/// tracking records whose sprint moves.
type ActiveSprintTasks = (Vec<(TaskRecord, IssueLink)>, Vec<TaskTrackingRecord>);

/// How the last sprint read of a Project went. Runtime-only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct JiraSprintSyncStatus {
    synced_at_epoch_ms: Option<u64>,
    failure: Option<(TaskSourceFailure, u64)>,
}

impl CoreRuntime {
    /// The enabled Jira Task Source whose boards a Project Manager Project's
    /// sprints follow, with those boards.
    fn jira_sprint_source(&self, project_id: &str) -> Option<(&TaskSourceConfiguration, Vec<u64>)> {
        if !self.is_project_manager_project(project_id) {
            return None;
        }
        self.store
            .task_source_configurations()
            .iter()
            .filter(|source| source.project_id == project_id && source.enabled)
            .find_map(|source| {
                let legacy = match &source.scope {
                    TaskSourceScope::Board { board_id, .. } => Some(board_id.as_str()),
                    _ => None,
                };
                let mut boards = Vec::new();
                for id in source
                    .boards
                    .iter()
                    .map(|board| board.id.as_str())
                    .chain(legacy)
                {
                    if let Ok(id) = id.parse::<u64>()
                        && id > 0
                        && !boards.contains(&id)
                        && boards.len() < SPRINT_BOARDS_MAX
                    {
                        boards.push(id);
                    }
                }
                (!boards.is_empty()).then_some((source, boards))
            })
    }

    /// Whether a Project's sprints mirror Jira rather than being its own.
    pub(crate) fn sprints_follow_jira(&self, project_id: &str) -> bool {
        self.jira_sprint_source(project_id).is_some()
    }

    pub fn plan_jira_sprint_sync(&self, project_id: &str) -> Option<JiraSprintSyncPlan> {
        let (source, board_ids) = self.jira_sprint_source(project_id)?;
        Some(JiraSprintSyncPlan {
            project_id: project_id.to_owned(),
            source_id: source.id.clone(),
            generation: source.generation,
            site_base_url: source.site_base_url.clone(),
            board_ids,
        })
    }

    /// Mirrors one sprint read into the Project's sprints and Tasks. A read
    /// planned against a source that changed since is dropped. Returns
    /// whether durable state changed.
    pub fn apply_jira_sprint_sync(
        &mut self,
        plan: JiraSprintSyncPlan,
        observation: Result<JiraSprintObservation, TaskSourceFailure>,
        now_epoch_ms: u64,
    ) -> Result<bool, CoreError> {
        if self.plan_jira_sprint_sync(&plan.project_id).as_ref() != Some(&plan) {
            return Ok(false);
        }
        let observation = match observation {
            Ok(observation) => observation,
            Err(failure) => {
                self.jira_sprint_syncs
                    .entry(plan.project_id)
                    .or_default()
                    .failure = Some((failure, now_epoch_ms));
                return Ok(false);
            }
        };
        let sprints = self.mirrored_sprints(&plan.project_id, &observation, now_epoch_ms);
        let active_id = sprints
            .iter()
            .find(|sprint| sprint.state == SprintState::Active && sprint.jira.is_some())
            .map(|sprint| sprint.id.clone());
        let (new_tasks, tracking) = match (&observation.active, active_id) {
            (Some((_, issues)), Some(active_id)) => {
                self.active_sprint_tasks(&plan, &active_id, issues, now_epoch_ms)?
            }
            _ => (Vec::new(), Vec::new()),
        };
        let changed = self
            .store
            .apply_jira_sprint_sync(
                &self.write_authority,
                &plan.project_id,
                sprints,
                new_tasks,
                tracking,
            )
            .map_err(store_error)?
            .is_some();
        self.jira_sprint_syncs.insert(
            plan.project_id,
            JiraSprintSyncStatus {
                synced_at_epoch_ms: Some(now_epoch_ms),
                failure: None,
            },
        );
        Ok(changed)
    }

    /// The Project's complete sprint list after a read: Jira's active and
    /// future sprints mirrored in place, mirrored sprints Jira no longer
    /// lists closed, and local sprints kept but never active beside Jira's.
    fn mirrored_sprints(
        &self,
        project_id: &str,
        observation: &JiraSprintObservation,
        now_epoch_ms: u64,
    ) -> Vec<ProjectSprint> {
        let existing = self
            .store
            .project_sprints()
            .iter()
            .filter(|sprint| sprint.project_id == project_id)
            .cloned()
            .collect::<Vec<_>>();
        let complete = observation.boards.iter().all(|board| !board.truncated);
        let active_jira_id = observation.active.as_ref().map(|(sprint, _)| sprint.id);
        let mut seen = HashSet::new();
        let observed = observation
            .boards
            .iter()
            .flat_map(|board| board.sprints.iter().flatten())
            .filter(|sprint| seen.insert(sprint.id))
            .collect::<Vec<_>>();
        let mut sprints = Vec::with_capacity(existing.len() + observed.len());
        for sprint in &existing {
            let Some(mirror) = &sprint.jira else {
                let mut local = sprint.clone();
                if local.state == SprintState::Active && active_jira_id.is_some() {
                    local.state = SprintState::Planned;
                }
                sprints.push(local);
                continue;
            };
            if observed
                .iter()
                .any(|candidate| candidate.id == mirror.sprint_id)
            {
                continue;
            }
            let mut gone = sprint.clone();
            if complete || gone.state == SprintState::Active {
                gone.state = SprintState::Closed;
            }
            sprints.push(gone);
        }
        for jira in observed {
            let state = if Some(jira.id) == active_jira_id {
                SprintState::Active
            } else if jira.state == JiraSprintState::Closed {
                SprintState::Closed
            } else {
                SprintState::Planned
            };
            let current = existing.iter().find(|sprint| {
                sprint
                    .jira
                    .as_ref()
                    .is_some_and(|mirror| mirror.sprint_id == jira.id)
            });
            sprints.push(ProjectSprint {
                id: current.map_or_else(termloop_platform::generate_uuid_v4, |sprint| {
                    sprint.id.clone()
                }),
                project_id: project_id.to_owned(),
                name: sprint_name(jira),
                state,
                created_at_epoch_ms: current
                    .map_or(now_epoch_ms, |sprint| sprint.created_at_epoch_ms),
                jira: Some(JiraSprintMirror {
                    sprint_id: jira.id,
                    board_id: jira.board_id,
                    start_epoch_ms: jira.start_epoch_ms,
                    end_epoch_ms: jira.end_epoch_ms,
                }),
            });
        }
        // The oldest closed mirrors make room first; the Project's own
        // sprints and Jira's current ones are kept.
        while sprints.len() > PROJECT_SPRINTS_MAX {
            let oldest = sprints
                .iter()
                .enumerate()
                .filter(|(_, sprint)| sprint.jira.is_some() && sprint.state == SprintState::Closed)
                .min_by_key(|(_, sprint)| sprint.created_at_epoch_ms)
                .map(|(index, _)| index);
            match oldest {
                Some(index) => {
                    sprints.remove(index);
                }
                None => {
                    // More open sprints than fit: the furthest planned ones wait.
                    let last_planned = sprints.iter().rposition(|sprint| {
                        sprint.jira.is_some() && sprint.state == SprintState::Planned
                    });
                    match last_planned {
                        Some(index) => {
                            sprints.remove(index);
                        }
                        None => break,
                    }
                }
            }
        }
        sprints
    }

    /// The Tasks the active sprint's issues imply: new Tasks copied from
    /// issues no Task links yet, and the tracking records whose sprint moves.
    /// A Jira-linked Task that left the active sprint returns to the backlog
    /// when Jira listed the whole sprint.
    fn active_sprint_tasks(
        &self,
        plan: &JiraSprintSyncPlan,
        active_id: &str,
        issues: &termloop_providers::JiraSearchResult,
        now_epoch_ms: u64,
    ) -> Result<ActiveSprintTasks, CoreError> {
        let jira_links = self
            .store
            .issue_links()
            .iter()
            .filter(|link| link.provider == IssueLinkProvider::Jira)
            .collect::<Vec<_>>();
        let project_task = |task_id: &str| {
            self.store
                .tasks()
                .iter()
                .find(|task| task.id == task_id && task.project_id == plan.project_id)
        };
        let mut rank = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == plan.project_id)
            .map(|task| task.rank)
            .max();
        let mut new_tasks = Vec::new();
        let mut in_sprint = HashSet::new();
        let mut tracking = HashMap::<String, TaskTrackingRecord>::new();
        let move_to = |task_id: &str,
                       sprint_id: Option<&str>,
                       tracking: &mut HashMap<String, TaskTrackingRecord>| {
            let current = self
                .store
                .task_tracking(task_id)
                .cloned()
                .unwrap_or_else(|| TaskTrackingRecord {
                    task_id: task_id.to_owned(),
                    ..TaskTrackingRecord::default()
                });
            if current.sprint_id.as_deref() != sprint_id {
                tracking.insert(
                    task_id.to_owned(),
                    TaskTrackingRecord {
                        sprint_id: sprint_id.map(str::to_owned),
                        updated_at_epoch_ms: now_epoch_ms,
                        ..current
                    },
                );
            }
        };
        for issue in &issues.issues {
            let link = jira_links.iter().find(|link| {
                link.url.as_deref() == Some(issue.url.as_str()) || link.external_ref == issue.key
            });
            if let Some(link) = link {
                // An issue another Project already tracks stays there.
                if project_task(&link.task_id).is_some() {
                    in_sprint.insert(link.task_id.clone());
                    move_to(&link.task_id, Some(active_id), &mut tracking);
                }
                continue;
            }
            // An issue Jira answered without its numeric ID cannot be linked.
            if new_tasks.len() >= SYNC_NEW_TASKS_MAX
                || issue.external_id.is_empty()
                || !issue.external_id.bytes().all(|byte| byte.is_ascii_digit())
            {
                continue;
            }
            let candidate = TaskSourceCandidateSnapshot::from(issue.clone());
            let next_rank = rank.map_or(Ok(0), |rank: u64| {
                rank.checked_add(1)
                    .ok_or_else(|| CoreError::Store("Task rank overflow".into()))
            })?;
            rank = Some(next_rank);
            let task = TaskRecord {
                id: termloop_platform::generate_uuid_v4(),
                project_id: plan.project_id.clone(),
                title: imported_title(&candidate),
                brief: imported_brief(&candidate),
                developer_notes: Vec::new(),
                status: TaskStatus::Open,
                archived_at_epoch_ms: None,
                branch: None,
                worktree: None,
                worktree_generation: 0,
                steward_brief_markdown: String::new(),
                steward_brief_revision: 1,
                rank: next_rank,
                created_at_epoch_ms: now_epoch_ms,
                updated_at_epoch_ms: now_epoch_ms,
            };
            tracking.insert(
                task.id.clone(),
                TaskTrackingRecord {
                    task_id: task.id.clone(),
                    sprint_id: Some(active_id.to_owned()),
                    updated_at_epoch_ms: now_epoch_ms,
                    ..TaskTrackingRecord::default()
                },
            );
            new_tasks.push((
                task.clone(),
                IssueLink {
                    task_id: task.id,
                    provider: IssueLinkProvider::Jira,
                    external_ref: candidate.external_ref,
                    source_id: Some(plan.source_id.clone()),
                    external_id: Some(candidate.external_id),
                    external_updated_at: Some(candidate.updated_at),
                    url: Some(candidate.url),
                    sync_authority: IssueLinkSyncAuthority::None,
                },
            ));
        }
        if !issues.truncated {
            for link in &jira_links {
                if project_task(&link.task_id).is_some()
                    && !in_sprint.contains(&link.task_id)
                    && self
                        .store
                        .task_tracking(&link.task_id)
                        .and_then(|record| record.sprint_id.as_deref())
                        == Some(active_id)
                {
                    move_to(&link.task_id, None, &mut tracking);
                }
            }
        }
        Ok((new_tasks, tracking.into_values().collect()))
    }

    /// The sprint source of a Project's board, if its sprints follow Jira.
    pub(super) fn sprint_sync_json(&self, project_id: &str) -> Value {
        let Some((source, board_ids)) = self.jira_sprint_source(project_id) else {
            return Value::Null;
        };
        let status = self
            .jira_sprint_syncs
            .get(project_id)
            .cloned()
            .unwrap_or_default();
        let (failure, failed_at) = status.failure.map_or((None, None), |(failure, at)| {
            (Some(crate::task_source_failure_wire(failure)), Some(at))
        });
        json!({
            "sourceName": source.name,
            "boardIds": board_ids,
            "syncedAtEpochMs": status.synced_at_epoch_ms,
            "failureReason": failure,
            "failedAtEpochMs": failed_at,
        })
    }
}

fn sprint_name(sprint: &JiraSprint) -> String {
    let name = sprint
        .name
        .trim()
        .chars()
        .take(termloop_domain::SPRINT_NAME_MAX_CHARS)
        .collect::<String>();
    let name = name.trim();
    if name.is_empty() {
        format!("Sprint {}", sprint.id)
    } else {
        name.to_owned()
    }
}

#[cfg(test)]
pub(super) mod tests;
