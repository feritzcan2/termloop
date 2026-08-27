use termloop_domain::{IssueLink, IssueLinkProvider, IssueLinkSyncAuthority};

use super::super::{CoreWriteAuthority, Store, StoreError};

impl Store {
    pub fn insert_task_jira_issue_link(
        &mut self,
        _authority: &CoreWriteAuthority,
        link: IssueLink,
    ) -> Result<u64, StoreError> {
        let previous = self.state.clone();
        insert_jira_issue_link_record(
            &self.state.tasks,
            &self.state.task_source_configurations,
            &mut self.state.issue_links,
            link,
        )?;
        self.commit_or_restore(previous)
    }
}

pub(super) fn insert_jira_issue_link_record(
    tasks: &[termloop_domain::TaskRecord],
    sources: &[termloop_domain::TaskSourceConfiguration],
    links: &mut Vec<IssueLink>,
    link: IssueLink,
) -> Result<(), StoreError> {
    if link.provider != IssueLinkProvider::Jira
        || link.sync_authority != IssueLinkSyncAuthority::None
        || link.external_ref.is_empty()
        || link.external_ref.len() > 85
        || link.source_id.as_ref().is_some_and(|source_id| {
            source_id.is_empty()
                || source_id.len() > 64
                || link.external_id.is_none()
                || link.external_updated_at.is_none()
                || !sources.iter().any(|source| source.id == *source_id)
        })
        || link.external_id.as_ref().is_some_and(|external_id| {
            external_id.is_empty()
                || external_id.len() > termloop_domain::TASK_SOURCE_EXTERNAL_ID_MAX_BYTES
                || !external_id.bytes().all(|byte| byte.is_ascii_digit())
                || link.source_id.is_none()
        })
        || link.external_updated_at.as_ref().is_some_and(|updated_at| {
            updated_at.is_empty()
                || updated_at.len() > 128
                || updated_at.bytes().any(|byte| byte.is_ascii_control())
                || link.source_id.is_none()
                || link.external_id.is_none()
        })
        || link.url.as_ref().is_none_or(|url| {
            url.is_empty()
                || url.len() > 2_048
                || url.bytes().any(|byte| byte.is_ascii_control())
                || url.contains(['?', '#', '@'])
        })
        || !tasks.iter().any(|task| task.id == link.task_id)
        || links.iter().any(|candidate| {
            (candidate.task_id == link.task_id && candidate.provider == IssueLinkProvider::Jira)
                || same_source_issue(candidate, &link)
                || same_site_issue(candidate, &link)
                || same_site_key(candidate, &link)
        })
    {
        return Err(StoreError::ConstraintViolation);
    }
    links.push(link);
    Ok(())
}

pub(crate) fn same_source_issue(existing: &IssueLink, incoming: &IssueLink) -> bool {
    existing.provider == incoming.provider
        && existing.source_id.is_some()
        && existing.source_id == incoming.source_id
        && existing.external_id == incoming.external_id
}

pub(crate) fn same_site_issue(existing: &IssueLink, incoming: &IssueLink) -> bool {
    existing.provider == incoming.provider
        && existing.external_id.is_some()
        && existing.external_id == incoming.external_id
        && same_https_authority(existing.url.as_deref(), incoming.url.as_deref())
}

pub(crate) fn same_site_key(existing: &IssueLink, incoming: &IssueLink) -> bool {
    existing.provider == incoming.provider
        && existing
            .external_ref
            .eq_ignore_ascii_case(&incoming.external_ref)
        && same_https_authority(existing.url.as_deref(), incoming.url.as_deref())
}

fn same_https_authority(left: Option<&str>, right: Option<&str>) -> bool {
    left.and_then(https_authority)
        .zip(right.and_then(https_authority))
        .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn https_authority(value: &str) -> Option<&str> {
    value.strip_prefix("https://")?.split('/').next()
}
