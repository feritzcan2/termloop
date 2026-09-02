use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use termloop_domain::{
    IssueLinkProvider, TASK_DEVELOPER_NOTES_MAX, TaskDeveloperNote, TaskRecord, TaskStatus,
    TaskSuspensionReason,
};

use super::cleanup::{
    cleanup_operation_json, health_json, presence_json, stale_resolution_operation_json,
};
use super::repair::repair_operation_json;
use crate::{CoreError, CoreRuntime, json_error, required_string, store_error};

pub(crate) const TITLE_LIMIT: usize = 160;
pub(crate) const BRIEF_LIMIT: usize = 8_000;

#[derive(Debug, Deserialize, Serialize)]
struct TaskListCursor {
    version: u8,
    project_id: String,
    archive_scope: String,
    status: Option<String>,
    state_revision: u64,
    offset: usize,
}

fn decode_task_list_cursor(value: &str) -> Result<TaskListCursor, CoreError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| CoreError::InvalidParams("cursor".into()))?;
    serde_json::from_slice(&bytes).map_err(|_| CoreError::InvalidParams("cursor".into()))
}

fn encode_task_list_cursor(cursor: &TaskListCursor) -> Result<String, CoreError> {
    let bytes =
        serde_json::to_vec(cursor).map_err(|_| CoreError::InvalidParams("cursor".into()))?;
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    if encoded.len() > 256 {
        return Err(CoreError::InvalidParams("cursor".into()));
    }
    Ok(encoded)
}

impl CoreRuntime {
    pub fn list_tasks_current(&self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let archive_scope = params
            .get("archiveScope")
            .and_then(Value::as_str)
            .unwrap_or("active");
        if !matches!(archive_scope, "active" | "archived" | "all") {
            return Err(CoreError::InvalidParams("archiveScope".into()));
        }
        let requested = params.get("taskIds").and_then(Value::as_array).map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .collect::<std::collections::HashSet<_>>()
        });
        if requested.is_some() && (params.get("cursor").is_some() || params.get("limit").is_some())
        {
            return Err(CoreError::InvalidParams("cursor".into()));
        }
        let status = params.get("status").and_then(Value::as_str);
        if status.is_some_and(|status| !matches!(status, "open" | "closed")) {
            return Err(CoreError::InvalidParams("status".into()));
        }
        let cursor = params
            .get("cursor")
            .and_then(Value::as_str)
            .map(decode_task_list_cursor)
            .transpose()?;
        if cursor.as_ref().is_some_and(|cursor| {
            cursor.version != 1
                || cursor.project_id != project_id
                || cursor.archive_scope != archive_scope
                || cursor.status.as_deref() != status
                || cursor.state_revision != self.state_revision()
        }) {
            return Err(CoreError::InvalidParams("cursor".into()));
        }
        let mut tasks = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .filter(|task| match archive_scope {
                "active" => task.archived_at_epoch_ms.is_none(),
                "archived" => task.archived_at_epoch_ms.is_some(),
                _ => true,
            })
            .filter(|task| match status {
                Some("open") => task.status == TaskStatus::Open,
                Some("closed") => task.status == TaskStatus::Closed,
                _ => true,
            })
            .filter(|task| {
                requested
                    .as_ref()
                    .is_none_or(|ids| ids.contains(task.id.as_str()))
            })
            .cloned()
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| {
            if archive_scope == "archived" {
                right
                    .archived_at_epoch_ms
                    .cmp(&left.archived_at_epoch_ms)
                    .then_with(|| left.id.cmp(&right.id))
            } else {
                left.rank
                    .cmp(&right.rank)
                    .then_with(|| left.id.cmp(&right.id))
            }
        });
        let offset = cursor.as_ref().map_or(0, |cursor| cursor.offset);
        let limit = params
            .get("limit")
            .and_then(Value::as_u64)
            .map(|limit| usize::try_from(limit).unwrap_or(usize::MAX))
            .unwrap_or_else(|| {
                if requested.is_some() {
                    tasks.len().max(1)
                } else {
                    50
                }
            });
        let maximum_limit = if requested.is_some() { 128 } else { 100 };
        if !(1..=maximum_limit).contains(&limit) || offset > tasks.len() {
            return Err(CoreError::InvalidParams("limit".into()));
        }
        let end = offset.saturating_add(limit).min(tasks.len());
        let items = tasks[offset..end]
            .iter()
            .map(|task| self.task_current_projection(&task.id))
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = (end < tasks.len())
            .then(|| {
                encode_task_list_cursor(&TaskListCursor {
                    version: 1,
                    project_id: project_id.to_owned(),
                    archive_scope: archive_scope.to_owned(),
                    status: status.map(str::to_owned),
                    state_revision: self.state_revision(),
                    offset: end,
                })
            })
            .transpose()?;
        Ok(json!({
            "items": items,
            "next_cursor": next_cursor,
        }))
    }

    pub fn task_current_projection(&self, task_id: &str) -> Result<Value, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        let mut value = self.task_projection(task)?;
        value["worktree_generation"] = json!(task.worktree_generation);
        if let Some(health) = self.cached_task_worktree_health(task_id) {
            value["worktree_health"] = health_json(health);
        }
        if let Some(presence) = self.cached_task_worktree_presence(task_id) {
            value["worktree_presence"] = presence_json(presence);
        }
        if let Some(operation) = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            value["worktree_cleanup"] = cleanup_operation_json(operation);
        }
        if let Some(operation) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            value["worktree_repair"] = repair_operation_json(operation);
        }
        if let Some(operation) = self
            .store
            .stale_resolution_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            value["worktree_stale_resolution"] = stale_resolution_operation_json(operation);
        }
        Ok(value)
    }

    /// Returns one exact Task projection inside the caller's authenticated
    /// Project. Agent-facing reads never accept Project scope from the payload.
    pub fn task_projection_for_executor(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Value, CoreError> {
        if !self
            .store
            .tasks()
            .iter()
            .any(|task| task.id == task_id && task.project_id == project_id)
        {
            return Err(CoreError::NotFound);
        }
        self.task_current_projection(task_id)
    }

    fn task_agent_session_ids_for_executor(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<HashSet<String>, CoreError> {
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id && task.project_id == project_id)
            .ok_or(CoreError::NotFound)?;
        let Some(worktree) = task.worktree.as_ref() else {
            return Ok(HashSet::new());
        };
        let worktree_key = super::comparison_key(Path::new(&worktree.path))
            .map_err(|_| CoreError::InvalidParams("taskWorktree".into()))?;
        let assistant_session_ids = self
            .store
            .steward_configurations()
            .iter()
            .filter(|configuration| configuration.project_id == project_id)
            .filter_map(|configuration| configuration.executor_session_id.as_deref())
            .chain(
                self.store
                    .worker_configurations()
                    .iter()
                    .filter(|configuration| configuration.project_id == project_id)
                    .filter_map(|configuration| configuration.executor_session_id.as_deref()),
            )
            .collect::<HashSet<_>>();
        Ok(self
            .store
            .sessions()
            .iter()
            .filter(|session| {
                session.project_id == project_id
                    && session.kind == termloop_domain::SessionKind::Agent
                    && session.ask_to_source_session_id.is_none()
                    && session.improver_target.is_none()
                    && !assistant_session_ids.contains(session.id.as_str())
                    && super::comparison_key(Path::new(&session.process.cwd))
                        .is_ok_and(|session_key| worktree_key.contains_or_equals(&session_key))
            })
            .map(|session| session.id.clone())
            .collect())
    }

    /// Projects current status only for ordinary Agent Sessions whose cwd is
    /// inside this exact Task's current worktree. Persistent assistants,
    /// helpers, and Improve Sessions never become Task evidence through cwd.
    pub fn task_agent_status_projection_for_executor(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Value, CoreError> {
        let task_session_ids = self.task_agent_session_ids_for_executor(project_id, task_id)?;
        let statuses = self.agent_status_list_for_project(Some(project_id))?;
        Ok(Value::Array(
            statuses
                .as_array()
                .into_iter()
                .flatten()
                .filter(|status| {
                    status
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|session_id| task_session_ids.contains(session_id))
                })
                .cloned()
                .collect(),
        ))
    }

    /// Authorizes one Worker request target only when it is an ordinary Agent
    /// projected into this exact Task worktree. The server separately proves
    /// the Worker's live Playbook check and scoped Task-read receipt before
    /// invoking the existing authenticated handoff path.
    pub fn ensure_task_agent_request_target_for_executor(
        &self,
        project_id: &str,
        task_id: &str,
        target_session_id: &str,
    ) -> Result<(), CoreError> {
        self.task_agent_session_ids_for_executor(project_id, task_id)?
            .contains(target_session_id)
            .then_some(())
            .ok_or(CoreError::CapabilityDenied)
    }

    pub(crate) fn create_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        let worktree_intent = params
            .get("worktreeIntent")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::InvalidParams("worktreeIntent".into()))?;
        if !matches!(worktree_intent, "inherit" | "none" | "provision") {
            return Err(CoreError::InvalidParams("worktreeIntent".into()));
        }
        let agent_id = match params.get("agentId") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(value.as_str()),
            _ => return Err(CoreError::InvalidParams("agentId".into())),
        };
        if agent_id.is_some_and(|agent_id| {
            worktree_intent != "provision" || !termloop_domain::agent_id_is_well_formed(agent_id)
        }) {
            return Err(CoreError::InvalidParams("agentId".into()));
        }
        let title = normalized_required_text(&params, "title", TITLE_LIMIT)?;
        let brief = normalized_nullable_text(&params, "brief", BRIEF_LIMIT)?;
        let rank = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.project_id == project_id)
            .map(|task| task.rank)
            .max()
            .map_or(Ok(0), |rank| {
                rank.checked_add(1)
                    .ok_or_else(|| CoreError::Store("Task rank overflow".into()))
            })?;
        let now = termloop_platform::current_epoch_ms();
        let task = TaskRecord {
            id: termloop_platform::generate_uuid_v4(),
            project_id,
            title,
            brief,
            developer_notes: Vec::new(),
            status: TaskStatus::Open,
            archived_at_epoch_ms: None,
            branch: None,
            worktree: None,
            worktree_generation: 0,
            steward_brief_markdown: String::new(),
            steward_brief_revision: 1,
            rank,
            created_at_epoch_ms: now,
            updated_at_epoch_ms: now,
        };
        self.store
            .insert_task(&self.write_authority, task.clone())
            .map_err(store_error)?;
        self.task_projection(&task)
    }

    pub(crate) fn list_tasks(&self, params: Value) -> Result<Value, CoreError> {
        self.list_tasks_current(params)
    }

    pub(crate) fn rename_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let title = normalized_required_text(&params, "title", TITLE_LIMIT)?;
        let task = self
            .store
            .rename_task(
                &self.write_authority,
                &task_id,
                title,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.task_projection(&task)
    }

    pub(crate) fn update_task_brief(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let brief = normalized_nullable_text(&params, "brief", BRIEF_LIMIT)?;
        let task = self
            .store
            .update_task_brief(
                &self.write_authority,
                &task_id,
                brief,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.task_projection(&task)
    }

    pub(crate) fn update_task_developer_notes(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let expected_notes = parse_developer_notes(&params, "expectedDeveloperNotes")?;
        let developer_notes = parse_developer_notes(&params, "developerNotes")?;
        let task = self
            .store
            .update_task_developer_notes(
                &self.write_authority,
                &task_id,
                &expected_notes,
                developer_notes,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.task_projection(&task)
    }

    pub(crate) fn close_task(&mut self, params: Value) -> Result<Value, CoreError> {
        self.change_task_status(params, TaskStatus::Closed)
    }

    pub(crate) fn reopen_task(&mut self, params: Value) -> Result<Value, CoreError> {
        self.reopen_task_with_resume_plan(params)
            .map(|(result, _)| result)
    }

    pub fn reopen_task_with_resume_plan(
        &mut self,
        params: Value,
    ) -> Result<(Value, Vec<String>), CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let has_suspended_sessions =
            self.store
                .task_archive_suspensions()
                .iter()
                .any(|suspension| {
                    suspension.task_id.as_deref() == Some(task_id.as_str())
                        && suspension.reason == TaskSuspensionReason::ClosedWorktreeRemoved
                });
        if has_suspended_sessions {
            let (task, resume_session_ids) = self
                .store
                .reopen_task_with_suspended_sessions(
                    &self.write_authority,
                    &task_id,
                    termloop_platform::current_epoch_ms(),
                )
                .map_err(store_error)?;
            return Ok((self.task_projection(&task)?, resume_session_ids));
        }
        let task = self
            .store
            .set_task_status(
                &self.write_authority,
                &task_id,
                TaskStatus::Open,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        Ok((self.task_projection(&task)?, Vec::new()))
    }

    pub(crate) fn finalize_closed_worktree_removal(
        &mut self,
        params: Value,
    ) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        let task = self
            .store
            .finalize_archived_task_as_closed_after_worktree_removal(
                &self.write_authority,
                &task_id,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&task_id);
        self.task_projection(&task)
    }

    pub(crate) fn delete_task(&mut self, params: Value) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        if let Some(operation) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::ProvisioningAlreadyInProgress {
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .cleanup_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::CleanupInProgress {
                task_id,
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .repair_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::RepairInProgress {
                task_id,
                operation_id: operation.operation_id.clone(),
            });
        }
        if let Some(operation) = self
            .store
            .stale_resolution_operations()
            .iter()
            .find(|operation| operation.task_id == task_id)
        {
            return Err(CoreError::StaleDisposalInProgress {
                task_id,
                operation_id: operation.operation_id.clone(),
            });
        }
        let task = self
            .store
            .tasks()
            .iter()
            .find(|task| task.id == task_id)
            .ok_or(CoreError::NotFound)?;
        if task.worktree.is_some() {
            return Err(CoreError::TaskWorktreeCleanupRequired { task_id });
        }
        self.store
            .delete_task(&self.write_authority, &task_id)
            .map_err(store_error)?;
        self.clear_task_worktree_projections(&task_id);
        Ok(json!({ "taskId": task_id, "deleted": true }))
    }

    fn change_task_status(
        &mut self,
        params: Value,
        status: TaskStatus,
    ) -> Result<Value, CoreError> {
        let task_id = required_string(&params, "taskId")?;
        self.ensure_task_active(&task_id)?;
        let task = self
            .store
            .set_task_status(
                &self.write_authority,
                &task_id,
                status,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        self.task_projection(&task)
    }

    pub(crate) fn task_projection(&self, task: &TaskRecord) -> Result<Value, CoreError> {
        let mut value = serde_json::to_value(task).map_err(json_error)?;
        value["jira_url"] = self
            .store
            .issue_links()
            .iter()
            .find(|link| link.task_id == task.id && link.provider == IssueLinkProvider::Jira)
            .and_then(|link| link.url.as_ref())
            .map_or(Value::Null, |url| json!(url));
        value["branches"] = self.task_branches_json(task);
        // Current protocol always emits the durable generation. It remains optional in
        // the schema only so a new client can safely detect an older daemon.
        if let Some(operation) = self
            .store
            .provisioning_operations()
            .iter()
            .find(|operation| operation.task_id == task.id)
        {
            value["worktree_provisioning"] = json!({
                "operation_id": operation.operation_id,
                "status": if operation.failure.is_some() { "failed" } else { "running" },
                "failure": operation.failure.map(|kind| json!({ "kind": kind })),
            });
        }
        Ok(value)
    }

    fn task_branches_json(&self, task: &TaskRecord) -> Value {
        let checked_out = self
            .cached_task_worktree_health(&task.id)
            .and_then(|health| health.checked_out_branch.as_deref());
        let recorded_base = task
            .branch
            .as_ref()
            .and_then(|binding| self.task_recorded_branch_base(&task.id, binding));
        let mut items = Vec::new();
        if let Some(binding) = task.branch.as_ref() {
            items.push(json!({
                "branch_id": "primary",
                "name": binding.name,
                "role": "primary",
                "held_by_task_id": Value::Null,
                "checked_out": checked_out == Some(binding.name.as_str()),
                "base_ref": recorded_base.as_ref().and_then(|(reference, _)| display_branch_ref(reference)),
                "base_oid": recorded_base.as_ref().map(|(_, oid)| oid),
                "base_evidence": recorded_base.as_ref().map(|_| "provisioned"),
                "first_observed_worktree_generation": task.worktree_generation,
                "rollup_eligible": true,
            }));
        }
        let branch_set = self
            .store
            .task_branch_sets()
            .iter()
            .find(|set| set.task_id == task.id);
        if let Some(branch_set) = branch_set {
            for membership in &branch_set.memberships {
                let Some(name) = display_branch_ref(&membership.ref_name) else {
                    continue;
                };
                let base_ref = membership
                    .parent_ref_name
                    .as_deref()
                    .and_then(display_branch_ref);
                let (role, held_by_task_id) = self.task_branch_membership_role(
                    task,
                    &membership.repository_root,
                    &membership.ref_name,
                    recorded_base
                        .as_ref()
                        .map(|(reference, _)| reference.as_str()),
                );
                items.push(json!({
                    "branch_id": membership.id,
                    "name": name,
                    "role": role,
                    "held_by_task_id": held_by_task_id,
                    "checked_out": checked_out == Some(name.as_str()),
                    "base_ref": base_ref,
                    "base_oid": membership.first_observed_oid,
                    "base_evidence": match membership.evidence {
                        termloop_domain::TaskBranchMembershipEvidence::CurrentBranch => "currentBranch",
                        termloop_domain::TaskBranchMembershipEvidence::WorktreeReflog => "worktreeReflog",
                        termloop_domain::TaskBranchMembershipEvidence::BranchCreationReflog => "branchCreationReflog",
                    },
                    "first_observed_worktree_generation": membership.first_observed_worktree_generation,
                    "rollup_eligible": role == "associated",
                }));
            }
        }
        let checked_out_branch_id = items.iter().find_map(|item| {
            item.get("checked_out")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                .then(|| item.get("branch_id").and_then(Value::as_str))
                .flatten()
        });
        json!({
            "primary_branch_id": task.branch.as_ref().map(|_| "primary"),
            "checked_out_branch_id": checked_out_branch_id,
            "evidence_truncated": branch_set.is_some_and(|set| set.evidence_truncated),
            "items": items,
        })
    }

    fn task_branch_membership_role(
        &self,
        task: &TaskRecord,
        repository_root: &str,
        ref_name: &str,
        recorded_base_ref: Option<&str>,
    ) -> (&'static str, Option<String>) {
        if recorded_base_ref
            .and_then(local_counterpart_ref)
            .is_some_and(|base| base == ref_name)
        {
            return ("baseBranch", None);
        }
        let held = self.store.tasks().iter().find(|candidate| {
            candidate.id != task.id
                && candidate.project_id == task.project_id
                && candidate.branch.as_ref().is_some_and(|binding| {
                    binding.repository_root == repository_root
                        && format!("refs/heads/{}", binding.name) == ref_name
                })
        });
        match held {
            Some(held) => ("heldByOtherTask", Some(held.id.clone())),
            None => ("associated", None),
        }
    }
}

fn parse_developer_notes(params: &Value, key: &str) -> Result<Vec<TaskDeveloperNote>, CoreError> {
    let notes = serde_json::from_value::<Vec<TaskDeveloperNote>>(
        params
            .get(key)
            .cloned()
            .ok_or_else(|| CoreError::InvalidParams(key.into()))?,
    )
    .map_err(|_| CoreError::InvalidParams(key.into()))?;
    if notes.len() > TASK_DEVELOPER_NOTES_MAX
        || notes.iter().any(|note| !note.is_valid())
        || notes.iter().enumerate().any(|(index, note)| {
            notes[index + 1..]
                .iter()
                .any(|candidate| candidate.id == note.id)
        })
    {
        return Err(CoreError::InvalidParams(key.into()));
    }
    Ok(notes)
}

fn display_branch_ref(reference: &str) -> Option<String> {
    reference
        .strip_prefix("refs/heads/")
        .or_else(|| {
            reference
                .strip_prefix("refs/remotes/")
                .and_then(|value| value.split_once('/').map(|(_, branch)| branch))
        })
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn local_counterpart_ref(reference: &str) -> Option<String> {
    display_branch_ref(reference).map(|name| format!("refs/heads/{name}"))
}

fn normalized_required_text(params: &Value, key: &str, limit: usize) -> Result<String, CoreError> {
    let value = required_string(params, key)?;
    let value = value.trim();
    if value.chars().next().is_none() || value.chars().count() > limit {
        return Err(CoreError::InvalidParams(key.into()));
    }
    Ok(value.to_owned())
}

fn normalized_nullable_text(
    params: &Value,
    key: &str,
    limit: usize,
) -> Result<Option<String>, CoreError> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    let value = match value {
        Value::Null => "",
        Value::String(value) => value,
        _ => return Err(CoreError::InvalidParams(key.into())),
    };
    let value = value.trim();
    if value.chars().count() > limit {
        return Err(CoreError::InvalidParams(key.into()));
    }
    Ok(value.chars().next().is_some().then(|| value.to_owned()))
}
