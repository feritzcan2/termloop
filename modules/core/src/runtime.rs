//! Private serialized command/transaction runtime.

pub(crate) mod generated_input_delivery;
pub(crate) mod provider_observation_ingress;

use crate::{CoreError, CoreRuntime};
use serde_json::Value;

impl CoreRuntime {
    pub fn project_exists(&self, project_id: &str) -> bool {
        !self.project_delete_reservations.contains(project_id)
            && !self
                .project_assistant_reset_reservations
                .contains(project_id)
            && self
                .store
                .projects()
                .iter()
                .any(|project| project.id == project_id)
    }

    pub fn handle(&mut self, method: &str, params: Value) -> Result<Value, CoreError> {
        match method {
            "mcp.toolSettingsGet" => self.mcp_tool_settings_get(),
            "mcp.toolDescriptionUpdate" => self.update_mcp_tool_description(params),
            "mcp.toolDescriptionReset" => self.reset_mcp_tool_description(params),
            "project.create" => self.create_project(params),
            "project.list" => self.list_projects(),
            "project.taskAutomationGet" => self.get_project_task_automation(params),
            "project.taskAutomationSet" => self.set_project_task_automation(params),
            "project.updateDetails" => self.update_project_details(params),
            "project.delete" => {
                let result = self.delete_project(params);
                if result.is_ok() {
                    let sessions = self.store.sessions();
                    self.agent_conversation_activity.retain(|session_id| {
                        sessions.iter().any(|session| session.id == *session_id)
                    });
                    self.retain_current_tracker_runtime();
                    self.retain_current_task_source_runtime();
                }
                result
            }
            "task.create" => self.create_task(params),
            "task.list" => self.list_tasks(params),
            "task.inspectArchive" => self.inspect_task_archive(params),
            "task.archive" => self.archive_task(params),
            "task.abandonArchive" => self.abandon_task_archive(params),
            "task.restore" => self.restore_task(params),
            "task.archivedContext" => self.archived_task_context(params),
            "task.bindBranch" => self.bind_task_branch(params),
            "task.provisionWorktree" => self.provision_task_worktree(params),
            "task.dismissWorktreeProvisioning" => self.dismiss_task_worktree_provisioning(params),
            "task.rename" => self.rename_task(params),
            "task.updateBrief" => self.update_task_brief(params),
            "task.close" => self.close_task(params),
            "task.finalizeClosedWorktreeRemoval" => self.finalize_closed_worktree_removal(params),
            "task.reopen" => self.reopen_task(params),
            "task.delete" => self.delete_task(params),
            "task.deleteArchived" => self.delete_archived_task(params),
            "session.launchTerminal" => self.launch_terminal(params),
            "session.list" => self.list_sessions(),
            "session.listArchived" => self.list_archived_sessions(params),
            "session.inspectArchive" => self.inspect_session_archive(params),
            "session.archive" => self.archive_session(params),
            "session.restoreArchived" => self.restore_archived_session(params),
            "session.deleteArchived" => self.delete_archived_session(params),
            "session.rename" => self.rename_session(params),
            "agent.statusList" => self.agent_status_list(),
            "companion.transcriptList" => self.list_companion_transcript(params),
            "companion.transcriptClear" => self.clear_companion_transcript(params),
            "steward.configurationGet" => self.get_steward_configuration(params),
            "worker.configurationList" => self.list_worker_configurations(params),
            "runConfiguration.list" => self.list_run_configurations(params),
            "runConfiguration.create" => self.create_run_configuration(params),
            "runConfiguration.update" => self.update_run_configuration(params),
            "runConfiguration.delete" => self.delete_run_configuration(params),
            "configuration.versionList" => self.list_configuration_versions(params),
            "run.runtimeList" => self.list_run_runtime(params),
            "routine.configurationList" => self.list_tracker_configurations(params),
            "playbook.get" => self.get_playbook(params),
            "playbook.runtime" => self.playbook_runtime(params),
            "routine.runtimeList" => self.list_tracker_runtime(params),
            _ => Err(CoreError::MethodNotFound),
        }
    }
}
