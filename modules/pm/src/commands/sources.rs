use rusqlite::params;

use super::check_id;
use crate::store::project_sources;
use crate::{PmError, PmStore, ProjectSources};

impl PmStore {
    /// Replaces a project's sources. Only non-secret identifiers are kept;
    /// an empty value removes them.
    pub fn set_project_sources(
        &mut self,
        project_id: &str,
        sources: &ProjectSources,
    ) -> Result<ProjectSources, PmError> {
        check_id(project_id, "projectId")?;
        if !sources.is_valid() {
            return Err(PmError::Invalid("sources"));
        }
        self.write(|transaction| {
            transaction.execute(
                "DELETE FROM project_sources WHERE project_id = ?1",
                [project_id],
            )?;
            if sources != &ProjectSources::default() {
                let jira = sources.jira.as_ref();
                let github = sources.github.as_ref();
                transaction.execute(
                    "INSERT INTO project_sources (project_id, jira_site_url, jira_board_id, \
                         jira_account_email, jira_credential_handle, github_owner, github_name) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        project_id,
                        jira.map(|jira| &jira.site_url),
                        jira.and_then(|jira| jira.board_id),
                        jira.map(|jira| &jira.account_email),
                        jira.map(|jira| &jira.credential_handle),
                        github.map(|github| &github.owner),
                        github.map(|github| &github.name),
                    ],
                )?;
            }
            project_sources(transaction, project_id)
        })
    }
}
