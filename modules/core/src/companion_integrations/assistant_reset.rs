//! Atomic Project Assistant reset and runtime retirement.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::{CodexRuntime, CoreError, CoreRuntime, store_error};

pub struct ProjectAssistantResetCommit {
    pub result: Value,
    pub session_ids: Vec<String>,
    pub retired_runtimes: Vec<CodexRuntime>,
}

impl CoreRuntime {
    /// Removes all state owned by the Project Assistant while preserving the
    /// Project, Tasks, worktrees, ordinary Task Agents, and Run Configurations.
    /// The returned reservation remains active until the server finishes
    /// best-effort process teardown, which fences a Builder launch prepared
    /// against the Playbook that was just deleted.
    pub fn reset_project_assistant(
        &mut self,
        project_id: &str,
        expected_revision: u64,
        updated_at_epoch_ms: u64,
    ) -> Result<ProjectAssistantResetCommit, CoreError> {
        if self.project_delete_reservations.contains(project_id)
            || self
                .project_assistant_reset_reservations
                .contains(project_id)
        {
            return Err(CoreError::RevisionConflict);
        }
        if !self
            .store
            .projects()
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(CoreError::NotFound);
        }
        self.project_assistant_reset_reservations
            .insert(project_id.to_owned());
        let reset = match self.store.reset_project_assistant(
            &self.write_authority,
            project_id,
            expected_revision,
            updated_at_epoch_ms,
        ) {
            Ok(reset) => reset,
            Err(error) => {
                self.project_assistant_reset_reservations.remove(project_id);
                return Err(store_error(error));
            }
        };

        let session_ids = reset.session_ids;
        let session_id_set = session_ids.iter().cloned().collect::<HashSet<_>>();
        let retired_runtimes = session_ids
            .iter()
            .filter_map(|session_id| self.codex_runtimes.remove(session_id))
            .collect::<Vec<_>>();
        for session_id in &session_ids {
            self.agent_observations.remove(session_id);
            self.generated_input_deliveries.remove_session(session_id);
            self.daemon_restart_handoffs.remove(session_id);
            self.agent_terminal_holds.remove(session_id);
            self.resume_reservations.remove(session_id);
            self.provider_history_repair_reservations.remove(session_id);
            self.resume_ready.remove(session_id);
            self.resume_failure_reaps.remove(session_id);
            self.pending_agent_forks.remove(session_id);
            self.pending_agent_resume_refs.remove(session_id);
            self.agent_conversation_activity.remove(session_id);
            self.claude_turn_watches.remove(session_id);
            self.mcp_authorizer.remove(session_id);
            self.forget_ask_to_session(session_id);
        }
        self.fork_source_session_ids
            .retain(|session_id, source_id| {
                !session_id_set.contains(session_id) && !session_id_set.contains(source_id)
            });
        self.quick_action_previews.retain(|(_, ticket)| {
            ticket.project_id() != project_id || !ticket.is_assistant_prompt_improver()
        });
        self.agent_resume_previews
            .retain(|(_, ticket)| !session_id_set.contains(ticket.session_id()));
        self.session_archive_previews
            .retain(|(_, ticket)| !session_id_set.contains(ticket.session_id()));
        self.session_relocation_previews
            .retain(|(_, ticket)| ticket.project_id() != project_id);
        self.retain_current_tracker_runtime();

        Ok(ProjectAssistantResetCommit {
            result: json!({
                "projectId": project_id,
                "deleted": true,
                "deletedWorkers": reset.deleted_workers,
                "deletedRoutines": reset.deleted_routines,
                "deletedSessions": session_ids.len(),
                "deletedMessages": reset.deleted_messages,
                "playbookDeleted": reset.playbook_deleted,
                "stateRevision": self.store.revision(),
            }),
            session_ids,
            retired_runtimes,
        })
    }

    pub fn finish_project_assistant_reset(&mut self, project_id: &str) {
        self.project_assistant_reset_reservations.remove(project_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AssistantAvailability, StewardConfigurationUpdate};
    use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
    use termloop_store::{Store, issue_core_write_authority_for_composition};
    use termloop_terminal::TerminalService;

    fn runtime_with_assistant() -> (CoreRuntime, std::path::PathBuf, String) {
        let state_path = std::env::temp_dir().join(format!(
            "termloop-core-assistant-reset-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let folder = state_path.with_extension("project");
        std::fs::create_dir_all(&folder).unwrap();
        let mut runtime = CoreRuntime::new(
            Store::open(&state_path).unwrap(),
            issue_core_write_authority_for_composition(),
            TerminalService::default(),
            1,
        )
        .unwrap();
        let project_id = runtime
            .handle("project.create", json!({"name":"Demo","folderPath":folder}))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        runtime
            .set_steward_configuration(StewardConfigurationUpdate {
                project_id: &project_id,
                agent_id: "codex",
                model: "default".into(),
                permission: "bypassPermissions".into(),
                reasoning: "default".into(),
                enabled: false,
                system_prompt: "Coordinate this Project.".into(),
                expected_revision: runtime.state_revision(),
                capability: AssistantAvailability::Unavailable,
                updated_at_epoch_ms: 1,
            })
            .unwrap();
        runtime
            .create_worker_configuration(
                "worker-1".into(),
                &project_id,
                "Worker 1".into(),
                "codex",
                false,
                "default".into(),
                "bypassPermissions".into(),
                "default".into(),
                60,
                String::new(),
                String::new(),
                runtime.state_revision(),
                AssistantAvailability::Unavailable,
                1,
            )
            .unwrap();
        runtime
            .store
            .insert_session(
                &runtime.write_authority,
                SessionRecord {
                    id: "builder-session".into(),
                    project_id: project_id.clone(),
                    name: Some("build: Project Playbook".into()),
                    kind: SessionKind::Agent,
                    process: ProcessDescriptor {
                        program: "codex".into(),
                        args: vec![],
                        cwd: folder.to_string_lossy().into_owned(),
                        agent_id: Some("codex".into()),
                        template_ref: Some("builtin.builder.playbook".into()),
                        template_version: Some(1),
                    },
                    launch_selection: Default::default(),
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
        (runtime, state_path, project_id)
    }

    #[test]
    fn reset_uses_revision_cas_and_fences_late_assistant_launches_until_reap_finishes() {
        let (mut runtime, state_path, project_id) = runtime_with_assistant();
        assert!(matches!(
            runtime.reset_project_assistant(&project_id, 0, 2),
            Err(CoreError::RevisionConflict)
        ));
        assert_eq!(runtime.store.worker_configurations().len(), 1);

        let commit = runtime
            .reset_project_assistant(&project_id, runtime.state_revision(), 2)
            .unwrap();
        assert_eq!(commit.result["deletedWorkers"], 1);
        assert_eq!(commit.result["deletedSessions"], 1);
        assert_eq!(commit.session_ids, vec!["builder-session".to_owned()]);
        assert!(matches!(
            runtime.handle("steward.configurationGet", json!({"projectId":project_id})),
            Err(CoreError::NotFound)
        ));

        runtime.finish_project_assistant_reset(&project_id);
        let steward = runtime
            .handle("steward.configurationGet", json!({"projectId":project_id}))
            .unwrap();
        assert!(steward["configuration"].is_null());
        assert!(runtime.store.worker_configurations().is_empty());
        assert!(runtime.store.sessions().is_empty());
        let _ = std::fs::remove_file(&state_path);
        let _ = std::fs::remove_dir_all(state_path.with_extension("project"));
    }
}
