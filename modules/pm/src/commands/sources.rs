use rusqlite::params;

use super::check_id;
use crate::store::project_sources;
use crate::{PmError, PmStore, ProjectSources};

impl PmStore {
    /// Replaces a project's sources. Only non-secret identifiers are kept;
    /// an empty value removes them. An Azure DevOps repository is stored
    /// normalized.
    pub fn set_project_sources(
        &mut self,
        project_id: &str,
        sources: &ProjectSources,
    ) -> Result<ProjectSources, PmError> {
        check_id(project_id, "projectId")?;
        let sources = &sources.normalized().ok_or(PmError::Invalid("sources"))?;
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
                let azure = sources.azure_devops.as_ref();
                transaction.execute(
                    "INSERT INTO project_sources (project_id, jira_site_url, jira_board_id, \
                         jira_account_email, jira_credential_handle, github_owner, github_name, \
                         azure_organization, azure_project, azure_repository) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    params![
                        project_id,
                        jira.map(|jira| &jira.site_url),
                        jira.and_then(|jira| jira.board_id),
                        jira.map(|jira| &jira.account_email),
                        jira.map(|jira| &jira.credential_handle),
                        github.map(|github| &github.owner),
                        github.map(|github| &github.name),
                        azure.map(|azure| &azure.organization),
                        azure.map(|azure| &azure.project),
                        azure.map(|azure| &azure.name),
                    ],
                )?;
            }
            project_sources(transaction, project_id)
        })
    }
}
