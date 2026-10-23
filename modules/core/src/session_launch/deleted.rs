use std::path::Path;

use serde_json::{Value, json};
use termloop_domain::DeletedSessionRecord;
use termloop_terminal::{PtySpawnSpec, TerminalService};

use crate::{CoreError, CoreRuntime, required_string, store_error, terminal_error};

#[derive(Clone)]
struct DeletedSessionListItem {
    session: Value,
    cwd: String,
    deleted_at_epoch_ms: u64,
    purge_at_epoch_ms: u64,
}

pub struct DeletedSessionListPlan {
    items: Vec<DeletedSessionListItem>,
    archived_worktree_paths: Vec<String>,
}

impl DeletedSessionListPlan {
    pub fn observe(self) -> Value {
        let archived_roots = comparable_existing_paths(&self.archived_worktree_paths);
        Value::Array(
            self.items
                .into_iter()
                .map(|item| {
                    let source = crate::task_worktree::comparison_key(Path::new(&item.cwd));
                    // A missing folder no longer blocks restore: the Agent comes
                    // back in the Project root. `source_available` still says so.
                    let source_available = source.is_ok();
                    let restore_blocker = match source {
                        Err(_) => None,
                        Ok(source)
                            if archived_roots
                                .iter()
                                .any(|root| root.contains_or_equals(&source)) =>
                        {
                            Some("taskArchived")
                        }
                        Ok(_) => None,
                    };
                    json!({
                        "session": item.session,
                        "deleted_at_epoch_ms": item.deleted_at_epoch_ms,
                        "purge_at_epoch_ms": item.purge_at_epoch_ms,
                        "source_available": source_available,
                        "restore_blocker": restore_blocker,
                    })
                })
                .collect(),
        )
    }
}

#[derive(Clone, Debug)]
pub struct DeletedSessionRestorePlan {
    deleted: DeletedSessionRecord,
    archived_worktree_paths: Vec<String>,
    project_folder: Option<String>,
}

impl DeletedSessionRestorePlan {
    pub fn session_id(&self) -> &str {
        &self.deleted.session.id
    }

    pub fn observe(
        self,
        terminal: TerminalService,
    ) -> Result<ObservedDeletedSessionRestore, CoreError> {
        let original_cwd = &self.deleted.session.process.cwd;
        let (source, relocated_cwd) =
            match crate::task_worktree::comparison_key(Path::new(original_cwd)) {
                Ok(source) => (source, None),
                // The Agent's folder is gone; keep its conversation by restoring
                // it in the durable Project root instead.
                Err(_) => {
                    let project_folder = self
                        .project_folder
                        .clone()
                        .ok_or_else(|| CoreError::InvalidParams("sourceUnavailable".into()))?;
                    let source =
                        crate::task_worktree::comparison_key(Path::new(&project_folder))
                            .map_err(|_| CoreError::InvalidParams("sourceUnavailable".into()))?;
                    (source, Some(project_folder))
                }
            };
        if comparable_existing_paths(&self.archived_worktree_paths)
            .iter()
            .any(|root| root.contains_or_equals(&source))
        {
            return Err(CoreError::InvalidParams("taskArchived".into()));
        }
        if terminal
            .contains_session(&self.deleted.session.id)
            .map_err(terminal_error)?
        {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        let (program, args) = termloop_platform::default_shell();
        terminal
            .spawn(PtySpawnSpec {
                session_id: self.deleted.session.id.clone(),
                runtime_epoch: self.deleted.session.runtime_epoch,
                program,
                args,
                cwd: relocated_cwd
                    .clone()
                    .unwrap_or_else(|| original_cwd.clone()),
                environment: termloop_platform::LaunchEnvironment::os_baseline(),
                recent_output_replay: true,
            })
            .map_err(terminal_error)?;
        Ok(ObservedDeletedSessionRestore {
            plan: self,
            relocated_cwd,
        })
    }
}

#[derive(Debug)]
pub struct ObservedDeletedSessionRestore {
    plan: DeletedSessionRestorePlan,
    relocated_cwd: Option<String>,
}

impl ObservedDeletedSessionRestore {
    pub fn session_id(&self) -> &str {
        self.plan.session_id()
    }
}

impl CoreRuntime {
    pub(crate) fn reconcile_expired_deleted_sessions(&mut self) {
        let _ = self.store.purge_expired_deleted_sessions(
            &self.write_authority,
            termloop_platform::current_epoch_ms(),
        );
    }

    pub fn plan_deleted_session_list(
        &mut self,
        params: Value,
    ) -> Result<DeletedSessionListPlan, CoreError> {
        let project_id = required_string(&params, "projectId")?;
        if !self.project_exists(&project_id) {
            return Err(CoreError::NotFound);
        }
        self.store
            .purge_expired_deleted_sessions(
                &self.write_authority,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;

        let mut deleted = self
            .store
            .deleted_sessions()
            .iter()
            .filter(|deleted| deleted.session.project_id == project_id)
            .cloned()
            .collect::<Vec<_>>();
        deleted.sort_by(|left, right| {
            right
                .deleted_at_epoch_ms
                .cmp(&left.deleted_at_epoch_ms)
                .then_with(|| left.session.id.cmp(&right.session.id))
        });
        Ok(DeletedSessionListPlan {
            items: deleted
                .iter()
                .map(|deleted| DeletedSessionListItem {
                    session: self.project_session(&deleted.session),
                    cwd: deleted.session.process.cwd.clone(),
                    deleted_at_epoch_ms: deleted.deleted_at_epoch_ms,
                    purge_at_epoch_ms: deleted.purge_at_epoch_ms(),
                })
                .collect(),
            archived_worktree_paths: self.archived_worktree_paths(),
        })
    }

    pub fn plan_deleted_session_restore(
        &mut self,
        params: Value,
    ) -> Result<DeletedSessionRestorePlan, CoreError> {
        let session_id = required_string(&params, "sessionId")?;
        self.store
            .purge_expired_deleted_sessions(
                &self.write_authority,
                termloop_platform::current_epoch_ms(),
            )
            .map_err(store_error)?;
        let deleted = self
            .store
            .deleted_sessions()
            .iter()
            .find(|deleted| deleted.session.id == session_id)
            .cloned()
            .ok_or(CoreError::NotFound)?;
        let project_folder = self
            .store
            .projects()
            .iter()
            .find(|project| project.id == deleted.session.project_id)
            .map(|project| project.folder_path.clone());
        Ok(DeletedSessionRestorePlan {
            deleted,
            archived_worktree_paths: self.archived_worktree_paths(),
            project_folder,
        })
    }

    pub fn apply_deleted_session_restore(
        &mut self,
        observed: ObservedDeletedSessionRestore,
    ) -> Result<Value, CoreError> {
        let ObservedDeletedSessionRestore {
            plan,
            relocated_cwd,
        } = observed;
        let current = self
            .store
            .deleted_sessions()
            .iter()
            .find(|deleted| deleted.session.id == plan.deleted.session.id)
            .ok_or(CoreError::NotFound)?;
        if current != &plan.deleted
            || self.archived_worktree_paths() != plan.archived_worktree_paths
        {
            return Err(CoreError::InvalidParams("deletedSessionChanged".into()));
        }
        if !self
            .terminal
            .contains_session(&plan.deleted.session.id)
            .map_err(terminal_error)?
        {
            return Err(CoreError::InvalidParams("sessionId".into()));
        }
        let restored = self
            .store
            .restore_deleted_session_descriptor(
                &self.write_authority,
                &plan.deleted.session.id,
                relocated_cwd.as_deref(),
            )
            .map_err(store_error)?;
        self.agent_terminal_holds.insert(restored.id.clone());
        Ok(self.project_session(&restored))
    }

    pub(super) fn archived_worktree_paths(&self) -> Vec<String> {
        let mut paths = self
            .store
            .tasks()
            .iter()
            .filter(|task| task.archived_at_epoch_ms.is_some())
            .filter_map(|task| task.worktree.as_ref().map(|worktree| worktree.path.clone()))
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }
}

fn comparable_existing_paths(paths: &[String]) -> Vec<termloop_domain::PathComparisonKey> {
    paths
        .iter()
        .filter_map(|path| crate::task_worktree::comparison_key(Path::new(path)).ok())
        .collect()
}
