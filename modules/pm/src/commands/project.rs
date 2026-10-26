//! Projects registry and settings commands.

use rusqlite::{OptionalExtension, params};

use super::check_id;
use crate::project::{PROJECTS_MAX, valid_project_folder, valid_project_name};
use crate::settings::{PmSettings, SettingsEdit};
use crate::store::to_json;
use crate::{PmError, PmStore, Project, ProjectSources};

/// Every table holding rows of one project, in a safe deletion order.
const PROJECT_TABLES: &[&str] = &[
    "epic_breakdowns",
    "delivery_checks",
    "skill_runs",
    "skill_drafts",
    "skills",
    "skill_discovery_cache",
    "tickets",
    "epics",
    "sprints",
    "project_sources",
    "playbooks",
    "playbook_proposals",
    "assistant_conversations",
];

fn project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        folder: row.get(2)?,
        created_at_epoch_ms: row.get(3)?,
    })
}

impl PmStore {
    /// Registers a project; its id is new and never reused.
    pub fn create_project(&mut self, name: &str, folder: Option<&str>) -> Result<Project, PmError> {
        if !valid_project_name(name) {
            return Err(PmError::Invalid("name"));
        }
        if folder.is_some_and(|folder| !valid_project_folder(folder)) {
            return Err(PmError::Invalid("folder"));
        }
        let project = Project {
            id: self.new_id(),
            name: name.to_owned(),
            folder: folder.map(str::to_owned),
            created_at_epoch_ms: self.now(),
        };
        self.write(|transaction| {
            let count: i64 =
                transaction.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
            if usize::try_from(count).unwrap_or(usize::MAX) >= PROJECTS_MAX {
                return Err(PmError::Constraint("too many projects"));
            }
            transaction.execute(
                "INSERT INTO projects (id, name, folder, created_at_epoch_ms) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    project.id,
                    project.name,
                    project.folder,
                    project.created_at_epoch_ms
                ],
            )?;
            Ok(())
        })?;
        Ok(project)
    }

    /// Sets or clears the code folder the project's agents run in.
    pub fn set_project_folder(
        &mut self,
        project_id: &str,
        folder: Option<&str>,
    ) -> Result<Project, PmError> {
        check_id(project_id, "projectId")?;
        if folder.is_some_and(|folder| !valid_project_folder(folder)) {
            return Err(PmError::Invalid("folder"));
        }
        self.write(|transaction| {
            let changed = transaction.execute(
                "UPDATE projects SET folder = ?2 WHERE id = ?1",
                params![project_id, folder],
            )?;
            if changed == 0 {
                return Err(PmError::NotFound);
            }
            Ok(())
        })?;
        self.project(project_id)?.ok_or(PmError::NotFound)
    }

    /// Deletes a project and everything stored for it: sprints, tickets with
    /// their versions, notes, proposals, and facts, sources, the Playbook,
    /// skills, and delivery checks. Returns the project as it was, with the
    /// sources it had, so the caller can drop what lives outside the store.
    pub fn delete_project(
        &mut self,
        project_id: &str,
    ) -> Result<(Project, ProjectSources), PmError> {
        let project = self.project(project_id)?.ok_or(PmError::NotFound)?;
        let sources = self.project_sources(project_id)?;
        self.write(|transaction| {
            // Children first: tickets refuse to lose their sprint, and
            // ticket and skill rows cascade to their own children.
            for table in PROJECT_TABLES {
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE project_id = ?1"),
                    [project_id],
                )?;
            }
            transaction.execute("DELETE FROM projects WHERE id = ?1", [project_id])?;
            Ok(())
        })?;
        Ok((project, sources))
    }

    /// Every registered project, oldest first.
    pub fn projects(&self) -> Result<Vec<Project>, PmError> {
        let mut statement = self.connection().prepare(
            "SELECT id, name, folder, created_at_epoch_ms FROM projects \
             ORDER BY created_at_epoch_ms, rowid",
        )?;
        let projects = statement
            .query_map([], project_row)?
            .collect::<Result<_, _>>()?;
        Ok(projects)
    }

    pub fn project(&self, project_id: &str) -> Result<Option<Project>, PmError> {
        check_id(project_id, "projectId")?;
        Ok(self
            .connection()
            .query_row(
                "SELECT id, name, folder, created_at_epoch_ms FROM projects WHERE id = ?1",
                [project_id],
                project_row,
            )
            .optional()?)
    }

    /// The stored settings, or the defaults before any update.
    pub fn settings(&self) -> Result<PmSettings, PmError> {
        let stored: Option<String> = self
            .connection()
            .query_row(
                "SELECT settings_json FROM pm_settings WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let Some(json) = stored else {
            return Ok(PmSettings::default());
        };
        let settings: PmSettings =
            serde_json::from_str(&json).map_err(|error| PmError::Storage(error.to_string()))?;
        match settings.invalid_field() {
            None => Ok(settings),
            Some(_) => Err(PmError::Storage("stored settings are invalid".to_owned())),
        }
    }

    /// Applies a partial change; an invalid result changes nothing.
    pub fn update_settings(&mut self, edit: SettingsEdit) -> Result<PmSettings, PmError> {
        let now = self.now();
        let settings = self.settings()?.edited(edit);
        if let Some(field) = settings.invalid_field() {
            return Err(PmError::Invalid(field));
        }
        let json = to_json(&settings)?;
        self.write(|transaction| {
            transaction.execute(
                "INSERT INTO pm_settings (id, settings_json, updated_at_epoch_ms) \
                 VALUES (1, ?1, ?2) \
                 ON CONFLICT (id) DO UPDATE SET \
                     settings_json = excluded.settings_json, \
                     updated_at_epoch_ms = excluded.updated_at_epoch_ms",
                params![json, now],
            )?;
            Ok(())
        })?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::PROJECT_TABLES;
    use crate::PmStore;

    #[test]
    fn project_deletion_covers_every_table_with_a_project_id() {
        let store = PmStore::open_in_memory().unwrap();
        let mut statement = store
            .connection()
            .prepare(
                "SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c \
                 WHERE m.type = 'table' AND c.name = 'project_id' ORDER BY m.name",
            )
            .unwrap();
        let tables: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let mut covered: Vec<&str> = PROJECT_TABLES.to_vec();
        covered.sort_unstable();
        assert_eq!(tables, covered);
    }
}
