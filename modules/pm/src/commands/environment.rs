use rusqlite::params;

use super::check_id;
use crate::environment::valid_project_environments;
use crate::store::project_environments;
use crate::{PmError, PmStore, ProjectEnvironment};

impl PmStore {
    /// Replaces a project's ordered environment list; an empty list removes
    /// it, so production falls back to the environment name.
    pub fn set_project_environments(
        &mut self,
        project_id: &str,
        environments: &[ProjectEnvironment],
    ) -> Result<Vec<ProjectEnvironment>, PmError> {
        check_id(project_id, "projectId")?;
        if !valid_project_environments(environments) {
            return Err(PmError::Invalid("environments"));
        }
        self.write(|transaction| {
            transaction.execute(
                "DELETE FROM project_environments WHERE project_id = ?1",
                [project_id],
            )?;
            for (position, environment) in (0_i64..).zip(environments) {
                transaction.execute(
                    "INSERT INTO project_environments (project_id, position, name, production) \
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        project_id,
                        position,
                        environment.name,
                        environment.production
                    ],
                )?;
            }
            project_environments(transaction, project_id)
        })
    }
}
