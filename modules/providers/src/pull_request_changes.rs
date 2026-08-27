use super::*;
use similar::TextDiff;

const MAX_CHANGE_ENTRIES: usize = 256;
const CHANGE_SENTINEL: usize = MAX_CHANGE_ENTRIES + 1;
const AZURE_PULL_REQUEST_CONTENT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PATCH_BYTES: usize = 256 * 1024;
const MAX_PATCH_LINES: usize = 20_000;
const MAX_ITEM_BYTES: usize = 512 * 1024;
const MAX_DIFF_INPUT_LINES: usize = 20_000;
const MAX_DIFF_LINE_WORK: usize = 16_000_000;
const GITHUB_PAGE_SIZE: usize = 100;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PullRequestChangeIdentity {
    pub provider: GitHostProvider,
    pub repository_owner: String,
    pub repository_project: Option<String>,
    pub repository_name: String,
    pub number: u64,
}

impl PullRequestChangeIdentity {
    pub fn key(&self) -> String {
        format!(
            "{:?}|{}|{}|{}|{}",
            self.provider,
            self.repository_owner.to_ascii_lowercase(),
            self.repository_project
                .as_deref()
                .map(azure_name_key)
                .unwrap_or_default(),
            match self.provider {
                GitHostProvider::Github => self.repository_name.to_ascii_lowercase(),
                GitHostProvider::AzureDevOps => azure_name_key(&self.repository_name),
            },
            self.number
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderPullRequestChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderPullRequestChange {
    pub path: String,
    pub original_path: Option<String>,
    pub kind: ProviderPullRequestChangeKind,
    pub ordinal: usize,
    pub file_version: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderPullRequestChangeList {
    pub identity: PullRequestChangeIdentity,
    pub base_version: String,
    pub head_version: String,
    pub provider_revision: Option<u64>,
    pub target_repository_id: Option<String>,
    pub source_repository_id: Option<String>,
    pub source_repository_project: Option<String>,
    pub changes: Vec<ProviderPullRequestChange>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderPullRequestDiffState {
    Patch,
    Binary,
    NotShown,
    Truncated,
    NonUtf8,
    Changed,
}

#[derive(Clone, PartialEq, Eq)]
pub struct ProviderPullRequestDiff {
    pub state: ProviderPullRequestDiffState,
    pub patch: Option<String>,
}

impl ProviderPullRequestDiff {
    fn state(state: ProviderPullRequestDiffState) -> Self {
        Self { state, patch: None }
    }

    fn patch(patch: String) -> Self {
        Self {
            state: ProviderPullRequestDiffState::Patch,
            patch: Some(patch),
        }
    }
}

impl GitHubClient {
    pub fn list_pull_request_changes_with_timeout(
        &self,
        identity: &PullRequestChangeIdentity,
        timeout: Duration,
    ) -> Result<ProviderPullRequestChangeList, ProviderFailure> {
        validate_github_identity(identity)?;
        let deadline =
            termloop_platform::MonotonicDeadline::after(timeout.min(Duration::from_secs(8)))
                .map_err(|_| ProviderFailure::Timeout)?;
        self.ensure_changes_ready(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let metadata = self.github_pr_metadata(identity, deadline)?;
        let mut changes = Vec::new();
        let mut exhausted = false;
        for page in 1..=3 {
            let rows = self.github_file_page(identity, GITHUB_PAGE_SIZE, page, false, deadline)?;
            let row_count = rows.len();
            for row in rows {
                if changes.len() >= CHANGE_SENTINEL {
                    break;
                }
                changes.push(parse_github_file(row, changes.len())?);
            }
            if row_count < GITHUB_PAGE_SIZE {
                exhausted = true;
                break;
            }
        }
        let truncated = changes.len() > MAX_CHANGE_ENTRIES || !exhausted;
        changes.truncate(MAX_CHANGE_ENTRIES);
        Ok(ProviderPullRequestChangeList {
            identity: identity.clone(),
            base_version: metadata.base_version,
            head_version: metadata.head_version,
            provider_revision: None,
            target_repository_id: None,
            source_repository_id: None,
            source_repository_project: None,
            changes,
            truncated,
        })
    }

    pub fn pull_request_diff_with_timeout(
        &self,
        observation: &ProviderPullRequestChangeList,
        change: &ProviderPullRequestChange,
        timeout: Duration,
    ) -> Result<ProviderPullRequestDiff, ProviderFailure> {
        validate_github_identity(&observation.identity)?;
        let deadline =
            termloop_platform::MonotonicDeadline::after(timeout.min(Duration::from_secs(8)))
                .map_err(|_| ProviderFailure::Timeout)?;
        self.ensure_changes_ready(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let metadata = self.github_pr_metadata(&observation.identity, deadline)?;
        if metadata.base_version != observation.base_version
            || metadata.head_version != observation.head_version
        {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::Changed,
            ));
        }
        let mut rows = self.github_file_page(
            &observation.identity,
            1,
            change.ordinal.saturating_add(1),
            true,
            deadline,
        )?;
        if rows.len() != 1 {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::Changed,
            ));
        }
        let Some(row) = rows.pop() else {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::Changed,
            ));
        };
        let observed = parse_github_file(row.clone(), change.ordinal)?;
        if observed.path != change.path
            || observed.original_path != change.original_path
            || observed.kind != change.kind
            || observed.file_version != change.file_version
        {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::Changed,
            ));
        }
        let Some(fragment) = row.get("patch").and_then(Value::as_str) else {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::NotShown,
            ));
        };
        let (old_path, new_path) = patch_display_paths(change);
        let (diff_old_path, diff_new_path) = diff_header_paths(change);
        let patch = format!(
            "diff --git {diff_old_path} {diff_new_path}\n--- {old_path}\n+++ {new_path}\n{fragment}\n"
        );
        bounded_patch(patch)
    }

    fn ensure_changes_ready(&self, timeout: Duration) -> Result<(), ProviderFailure> {
        {
            let mut suppression = self.suppression.lock().expect("GitHub suppression mutex");
            if let Some((failure, deadline)) = *suppression {
                if deadline.remaining().is_some() {
                    return Err(failure);
                }
                *suppression = None;
            }
        }
        if self.discovery.get().is_none() {
            let _guard = self.discovery_gate.lock().expect("GitHub discovery mutex");
            if self.discovery.get().is_none() {
                self.discover(timeout.min(Duration::from_secs(2)))?;
                let _ = self.discovery.set(());
            }
        }
        Ok(())
    }

    fn github_pr_metadata(
        &self,
        identity: &PullRequestChangeIdentity,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<GithubMetadata, ProviderFailure> {
        let endpoint = github_pr_endpoint(identity);
        let outcome = self.run_github_changes_command(
            deadline,
            [
                "api".into(), "--hostname".into(), GITHUB_HOST.into(), "--method".into(),
                "GET".into(), endpoint, "--jq".into(),
                "{number:.number,owner:.base.repo.owner.login,repository:.base.repo.name,baseSha:.base.sha,headSha:.head.sha}".into(),
            ],
        )?;
        parse_github_metadata(identity, &outcome.stdout)
    }

    fn github_file_page(
        &self,
        identity: &PullRequestChangeIdentity,
        per_page: usize,
        page: usize,
        include_patch: bool,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<Vec<Value>, ProviderFailure> {
        let projection = if include_patch {
            "[.[] | {filename,status,previous_filename,sha,patch}]"
        } else {
            "[.[] | {filename,status,previous_filename,sha}]"
        };
        let endpoint = format!("{}/files", github_pr_endpoint(identity));
        let outcome = self.run_github_changes_command(
            deadline,
            [
                "api".into(),
                "--hostname".into(),
                GITHUB_HOST.into(),
                "--method".into(),
                "GET".into(),
                endpoint,
                "-f".into(),
                format!("per_page={per_page}"),
                "-f".into(),
                format!("page={page}"),
                "--jq".into(),
                projection.into(),
            ],
        )?;
        serde_json::from_slice(&outcome.stdout).map_err(|_| ProviderFailure::MalformedResponse)
    }

    fn run_github_changes_command<const N: usize>(
        &self,
        deadline: termloop_platform::MonotonicDeadline,
        arguments: [String; N],
    ) -> Result<termloop_platform::CommandOutcome, ProviderFailure> {
        let request = self
            .base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)
            .inspect_err(|&failure| {
                self.record_suppression(failure, None);
            })?;
        let outcome = termloop_platform::run_command(request.args(arguments)).map_err(|_| {
            self.record_suppression(ProviderFailure::ProviderUnavailable, None);
            ProviderFailure::ProviderUnavailable
        })?;
        if let Err(failure) = classify_termination(&outcome.termination, &outcome.stderr) {
            self.record_suppression(failure, None);
            return Err(failure);
        }
        if outcome.stdout_truncated || outcome.stderr_truncated {
            return Err(ProviderFailure::OutputLimit);
        }
        Ok(outcome)
    }
}

struct GithubMetadata {
    base_version: String,
    head_version: String,
}

fn validate_github_identity(identity: &PullRequestChangeIdentity) -> Result<(), ProviderFailure> {
    if identity.provider != GitHostProvider::Github
        || identity.repository_project.is_some()
        || !valid_slug(&identity.repository_owner)
        || !valid_slug(&identity.repository_name)
        || identity.number == 0
    {
        return Err(ProviderFailure::ProviderFailure);
    }
    Ok(())
}

fn github_pr_endpoint(identity: &PullRequestChangeIdentity) -> String {
    format!(
        "repos/{}/{}/pulls/{}",
        identity.repository_owner, identity.repository_name, identity.number
    )
}

fn parse_github_metadata(
    identity: &PullRequestChangeIdentity,
    bytes: &[u8],
) -> Result<GithubMetadata, ProviderFailure> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    if value.get("number").and_then(Value::as_u64) != Some(identity.number)
        || !value
            .get("owner")
            .and_then(Value::as_str)
            .is_some_and(|owner| owner.eq_ignore_ascii_case(&identity.repository_owner))
        || !value
            .get("repository")
            .and_then(Value::as_str)
            .is_some_and(|name| name.eq_ignore_ascii_case(&identity.repository_name))
    {
        return Err(ProviderFailure::MalformedResponse);
    }
    let base_version = valid_oid(value.get("baseSha").and_then(Value::as_str))?;
    let head_version = valid_oid(value.get("headSha").and_then(Value::as_str))?;
    Ok(GithubMetadata {
        base_version,
        head_version,
    })
}

fn parse_github_file(
    value: Value,
    ordinal: usize,
) -> Result<ProviderPullRequestChange, ProviderFailure> {
    let path = normalized_provider_path(
        value
            .get("filename")
            .and_then(Value::as_str)
            .ok_or(ProviderFailure::MalformedResponse)?,
    )?;
    let original_path = value
        .get("previous_filename")
        .and_then(Value::as_str)
        .map(normalized_provider_path)
        .transpose()?;
    let kind = match value.get("status").and_then(Value::as_str) {
        Some("modified" | "changed") => ProviderPullRequestChangeKind::Modified,
        Some("added") => ProviderPullRequestChangeKind::Added,
        Some("removed") => ProviderPullRequestChangeKind::Deleted,
        Some("renamed") => ProviderPullRequestChangeKind::Renamed,
        Some("copied") => ProviderPullRequestChangeKind::Copied,
        _ => return Err(ProviderFailure::MalformedResponse),
    };
    let file_version = value
        .get("sha")
        .and_then(Value::as_str)
        .map(|value| valid_oid(Some(value)))
        .transpose()?;
    if kind == ProviderPullRequestChangeKind::Renamed && original_path.is_none() {
        return Err(ProviderFailure::MalformedResponse);
    }
    Ok(ProviderPullRequestChange {
        path,
        original_path,
        kind,
        ordinal,
        file_version,
    })
}

impl AzureDevOpsClient {
    pub fn list_pull_request_changes_with_timeout(
        &self,
        identity: &PullRequestChangeIdentity,
        timeout: Duration,
    ) -> Result<ProviderPullRequestChangeList, ProviderFailure> {
        let normalized = normalize_azure_change_identity(identity)?;
        let deadline = azure_pull_request_content_deadline(timeout)?;
        self.ensure_discovered(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let metadata = self.azure_pr_change_metadata(&normalized, deadline)?;
        let iteration =
            self.azure_latest_iteration(&normalized, &metadata.target_repository_id, deadline)?;
        let rows = self.azure_iteration_changes(
            &normalized,
            &metadata.target_repository_id,
            iteration,
            deadline,
        )?;
        let mut changes = rows.changes;
        let truncated = rows.truncated || changes.len() > MAX_CHANGE_ENTRIES;
        changes.truncate(MAX_CHANGE_ENTRIES);
        Ok(ProviderPullRequestChangeList {
            identity: normalized,
            base_version: metadata.target_version,
            head_version: metadata.source_version,
            provider_revision: Some(iteration),
            target_repository_id: Some(metadata.target_repository_id),
            source_repository_id: Some(metadata.source_repository_id),
            source_repository_project: Some(metadata.source_repository_project),
            changes,
            truncated,
        })
    }

    pub fn pull_request_diff_with_timeout(
        &self,
        observation: &ProviderPullRequestChangeList,
        change: &ProviderPullRequestChange,
        timeout: Duration,
    ) -> Result<ProviderPullRequestDiff, ProviderFailure> {
        let normalized = normalize_azure_change_identity(&observation.identity)?;
        let deadline = azure_pull_request_content_deadline(timeout)?;
        self.ensure_discovered(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let metadata = self.azure_pr_change_metadata(&normalized, deadline)?;
        let iteration =
            self.azure_latest_iteration(&normalized, &metadata.target_repository_id, deadline)?;
        if metadata.target_version != observation.base_version
            || metadata.source_version != observation.head_version
            || Some(iteration) != observation.provider_revision
            || observation.target_repository_id.as_deref()
                != Some(metadata.target_repository_id.as_str())
            || observation.source_repository_id.as_deref()
                != Some(metadata.source_repository_id.as_str())
            || observation.source_repository_project.as_deref()
                != Some(metadata.source_repository_project.as_str())
        {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::Changed,
            ));
        }

        let old_path = change.original_path.as_deref().unwrap_or(&change.path);
        let old = match change.kind {
            ProviderPullRequestChangeKind::Added => AzureItemContent::Bytes(Vec::new()),
            _ => self.azure_item_content(
                &normalized,
                azure_project(&normalized)?,
                &metadata.target_repository_id,
                old_path,
                &observation.base_version,
                deadline,
            )?,
        };
        let new = match change.kind {
            ProviderPullRequestChangeKind::Deleted => AzureItemContent::Bytes(Vec::new()),
            _ => self.azure_item_content(
                &normalized,
                &metadata.source_repository_project,
                &metadata.source_repository_id,
                &change.path,
                &observation.head_version,
                deadline,
            )?,
        };
        let (AzureItemContent::Bytes(old), AzureItemContent::Bytes(new)) = (old, new) else {
            return Ok(ProviderPullRequestDiff::state(
                ProviderPullRequestDiffState::NotShown,
            ));
        };
        synthesize_patch(change, &old, &new)
    }

    fn azure_pr_change_metadata(
        &self,
        identity: &PullRequestChangeIdentity,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<AzureChangeMetadata, ProviderFailure> {
        let outcome = self.run_azure_changes_command(
            identity,
            azure_project(identity)?,
            deadline,
            azure_pr_show_arguments(identity),
        )?;
        parse_azure_change_metadata(identity, &outcome.stdout)
    }

    fn azure_latest_iteration(
        &self,
        identity: &PullRequestChangeIdentity,
        repository_id: &str,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<u64, ProviderFailure> {
        let outcome = self.run_azure_changes_command(
            identity,
            azure_project(identity)?,
            deadline,
            azure_invoke_arguments(
                identity,
                "pullRequestIterations",
                vec![
                    format!("project={}", azure_project(identity)?),
                    format!("repositoryId={repository_id}"),
                    format!("pullRequestId={}", identity.number),
                ],
                vec![],
                AZURE_ITERATION_IDS_QUERY,
            ),
        )?;
        let rows: Vec<Value> = serde_json::from_slice(&outcome.stdout)
            .map_err(|_| ProviderFailure::MalformedResponse)?;
        rows.iter()
            .filter_map(|row| row.get("id").and_then(Value::as_u64))
            .max()
            .filter(|id| *id > 0)
            .ok_or(ProviderFailure::MalformedResponse)
    }

    fn azure_iteration_changes(
        &self,
        identity: &PullRequestChangeIdentity,
        repository_id: &str,
        iteration: u64,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<AzureChangeRows, ProviderFailure> {
        let outcome = self.run_azure_changes_command(
            identity,
            azure_project(identity)?,
            deadline,
            azure_invoke_arguments(
                identity,
                "pullRequestIterationChanges",
                vec![
                    format!("project={}", azure_project(identity)?),
                    format!("repositoryId={repository_id}"),
                    format!("pullRequestId={}", identity.number),
                    format!("iterationId={iteration}"),
                ],
                vec!["$top=257".into(), "$compareTo=0".into()],
                "{changeEntries:changeEntries[].{changeType:changeType,path:item.path,originalPath:originalPath,objectId:item.objectId},nextSkip:nextSkip,nextTop:nextTop}",
            ),
        )?;
        parse_azure_change_rows(&outcome.stdout)
    }

    fn azure_item_content(
        &self,
        identity: &PullRequestChangeIdentity,
        project: &str,
        repository_id: &str,
        path: &str,
        version: &str,
        deadline: termloop_platform::MonotonicDeadline,
    ) -> Result<AzureItemContent, ProviderFailure> {
        let outcome = self.run_azure_changes_command(
            identity,
            project,
            deadline,
            azure_item_arguments(identity, project, repository_id, path, version),
        )?;
        parse_azure_item_content(path, &outcome.stdout)
    }

    fn run_azure_changes_command(
        &self,
        identity: &PullRequestChangeIdentity,
        project: &str,
        deadline: termloop_platform::MonotonicDeadline,
        arguments: Vec<String>,
    ) -> Result<termloop_platform::CommandOutcome, ProviderFailure> {
        let project_key = format!(
            "azureDevOps|{AZURE_HOST}|{}|{}",
            identity.repository_owner,
            azure_name_key(project)
        );
        self.check_suppression(&project_key, &identity.key())?;
        let outcome = termloop_platform::run_command(
            self.base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?
                .args(arguments),
        )
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        self.classify_query_outcome(&project_key, &identity.key(), &outcome)?;
        Ok(outcome)
    }
}

fn azure_pull_request_content_deadline(
    timeout: Duration,
) -> Result<termloop_platform::MonotonicDeadline, ProviderFailure> {
    termloop_platform::MonotonicDeadline::after(timeout.min(AZURE_PULL_REQUEST_CONTENT_TIMEOUT))
        .map_err(|_| ProviderFailure::Timeout)
}

struct AzureChangeMetadata {
    target_repository_id: String,
    source_repository_id: String,
    source_repository_project: String,
    source_version: String,
    target_version: String,
}

struct AzureChangeRows {
    changes: Vec<ProviderPullRequestChange>,
    truncated: bool,
}

const AZURE_ITERATION_IDS_QUERY: &str = "value[].{id:id}";

enum AzureItemContent {
    Bytes(Vec<u8>),
    NotShown,
}

fn azure_project(identity: &PullRequestChangeIdentity) -> Result<&str, ProviderFailure> {
    identity
        .repository_project
        .as_deref()
        .ok_or(ProviderFailure::ProviderFailure)
}

fn normalize_azure_change_identity(
    identity: &PullRequestChangeIdentity,
) -> Result<PullRequestChangeIdentity, ProviderFailure> {
    if identity.provider != GitHostProvider::AzureDevOps || identity.number == 0 {
        return Err(ProviderFailure::ProviderFailure);
    }
    Ok(PullRequestChangeIdentity {
        provider: GitHostProvider::AzureDevOps,
        repository_owner: normalize_organization(&identity.repository_owner)
            .map_err(|_| ProviderFailure::ProviderFailure)?,
        repository_project: Some(
            normalize_azure_display_name(
                identity
                    .repository_project
                    .as_deref()
                    .ok_or(ProviderFailure::ProviderFailure)?,
                AzureNameKind::Project,
            )
            .map_err(|_| ProviderFailure::ProviderFailure)?,
        ),
        repository_name: normalize_azure_display_name(
            &identity.repository_name,
            AzureNameKind::Repository,
        )
        .map_err(|_| ProviderFailure::ProviderFailure)?,
        number: identity.number,
    })
}

const AZURE_CHANGE_METADATA_QUERY: &str = "{pullRequestId:pullRequestId,supportsIterations:supportsIterations,sourceCommitId:lastMergeSourceCommit.commitId,targetCommitId:lastMergeTargetCommit.commitId,repository:{id:repository.id,name:repository.name,project:repository.project.name},forkSource:{repository:{id:forkSource.repository.id,name:forkSource.repository.name,project:forkSource.repository.project.name}}}";

fn azure_pr_show_arguments(identity: &PullRequestChangeIdentity) -> Vec<String> {
    vec![
        "repos".into(),
        "pr".into(),
        "show".into(),
        "--organization".into(),
        format!("https://{AZURE_HOST}/{}", identity.repository_owner),
        "--id".into(),
        identity.number.to_string(),
        "--detect".into(),
        "false".into(),
        "--query".into(),
        AZURE_CHANGE_METADATA_QUERY.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]
}

fn azure_invoke_arguments(
    identity: &PullRequestChangeIdentity,
    resource: &str,
    route_parameters: Vec<String>,
    query_parameters: Vec<String>,
    query: &str,
) -> Vec<String> {
    let mut arguments = vec![
        "devops".into(),
        "invoke".into(),
        "--organization".into(),
        format!("https://{AZURE_HOST}/{}", identity.repository_owner),
        "--area".into(),
        "git".into(),
        "--resource".into(),
        resource.into(),
        "--http-method".into(),
        "GET".into(),
        "--api-version".into(),
        "7.1".into(),
        "--detect".into(),
        "false".into(),
        "--route-parameters".into(),
    ];
    arguments.extend(route_parameters);
    if !query_parameters.is_empty() {
        arguments.push("--query-parameters".into());
        arguments.extend(query_parameters);
    }
    arguments.extend([
        "--query".into(),
        query.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]);
    arguments
}

fn azure_item_arguments(
    identity: &PullRequestChangeIdentity,
    project: &str,
    repository_id: &str,
    path: &str,
    version: &str,
) -> Vec<String> {
    azure_invoke_arguments(
        identity,
        "items",
        vec![
            format!("project={project}"),
            format!("repositoryId={repository_id}"),
        ],
        vec![
            format!("path={path}"),
            "includeContent=true".into(),
            "resolveLfs=false".into(),
            format!("versionDescriptor.version={version}"),
            "versionDescriptor.versionType=commit".into(),
        ],
        "{path:path,gitObjectType:gitObjectType,isSymLink:isSymLink,content:content,contentMetadata:{isBinary:contentMetadata.isBinary,encoding:contentMetadata.encoding}}",
    )
}

fn parse_azure_change_metadata(
    identity: &PullRequestChangeIdentity,
    bytes: &[u8],
) -> Result<AzureChangeMetadata, ProviderFailure> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let repository = value
        .get("repository")
        .ok_or(ProviderFailure::MalformedResponse)?;
    if value.get("pullRequestId").and_then(Value::as_u64) != Some(identity.number)
        || value.get("supportsIterations").and_then(Value::as_bool) != Some(true)
        || !repository
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| azure_name_eq(name, &identity.repository_name))
        || !repository
            .get("project")
            .and_then(Value::as_str)
            .is_some_and(|project| {
                identity
                    .repository_project
                    .as_deref()
                    .is_some_and(|expected| azure_name_eq(project, expected))
            })
    {
        return Err(ProviderFailure::MalformedResponse);
    }
    let target_repository_id = valid_identifier(repository.get("id").and_then(Value::as_str), 128)?;
    let fork_repository = value.pointer("/forkSource/repository");
    let (source_repository_id, source_repository_project) =
        match fork_repository.map(|repository| {
            (
                repository.get("id").and_then(Value::as_str),
                repository.get("name").and_then(Value::as_str),
                repository.get("project").and_then(Value::as_str),
            )
        }) {
            None | Some((None, None, None)) => (
                target_repository_id.clone(),
                azure_project(identity)?.to_owned(),
            ),
            Some((Some(id), Some(name), Some(project))) => {
                normalize_azure_display_name(name, AzureNameKind::Repository)
                    .map_err(|_| ProviderFailure::MalformedResponse)?;
                let project = normalize_azure_display_name(project, AzureNameKind::Project)
                    .map_err(|_| ProviderFailure::MalformedResponse)?;
                (valid_identifier(Some(id), 128)?, project)
            }
            _ => return Err(ProviderFailure::MalformedResponse),
        };
    let source_version = valid_oid(value.get("sourceCommitId").and_then(Value::as_str))?;
    let target_version = valid_oid(value.get("targetCommitId").and_then(Value::as_str))?;
    Ok(AzureChangeMetadata {
        target_repository_id,
        source_repository_id,
        source_repository_project,
        source_version,
        target_version,
    })
}

fn parse_azure_change_rows(bytes: &[u8]) -> Result<AzureChangeRows, ProviderFailure> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let entries = value
        .get("changeEntries")
        .and_then(Value::as_array)
        .ok_or(ProviderFailure::MalformedResponse)?;
    let mut changes = Vec::with_capacity(entries.len().min(CHANGE_SENTINEL));
    for (ordinal, entry) in entries.iter().take(CHANGE_SENTINEL).enumerate() {
        let path = normalized_provider_path(
            entry
                .get("path")
                .and_then(Value::as_str)
                .ok_or(ProviderFailure::MalformedResponse)?,
        )?;
        let original_path = entry
            .get("originalPath")
            .and_then(Value::as_str)
            .map(normalized_provider_path)
            .transpose()?;
        let raw_kind = entry
            .get("changeType")
            .and_then(Value::as_str)
            .ok_or(ProviderFailure::MalformedResponse)?
            .to_ascii_lowercase();
        let kind = if raw_kind.contains("rename") {
            ProviderPullRequestChangeKind::Renamed
        } else if raw_kind.contains("add") {
            ProviderPullRequestChangeKind::Added
        } else if raw_kind.contains("delete") {
            ProviderPullRequestChangeKind::Deleted
        } else if raw_kind.contains("edit") || raw_kind.contains("encoding") {
            ProviderPullRequestChangeKind::Modified
        } else {
            return Err(ProviderFailure::MalformedResponse);
        };
        if kind == ProviderPullRequestChangeKind::Renamed && original_path.is_none() {
            return Err(ProviderFailure::MalformedResponse);
        }
        let file_version = entry
            .get("objectId")
            .and_then(Value::as_str)
            .map(|value| valid_oid(Some(value)))
            .transpose()?;
        changes.push(ProviderPullRequestChange {
            path,
            original_path,
            kind,
            ordinal,
            file_version,
        });
    }
    let continuation = value.get("nextSkip").and_then(Value::as_u64).unwrap_or(0) > 0
        || value.get("nextTop").and_then(Value::as_u64).unwrap_or(0) > 0;
    Ok(AzureChangeRows {
        truncated: continuation || entries.len() > MAX_CHANGE_ENTRIES,
        changes,
    })
}

fn parse_azure_item_content(
    expected_path: &str,
    bytes: &[u8],
) -> Result<AzureItemContent, ProviderFailure> {
    let mut value: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    if let Some(first) = value
        .get_mut("value")
        .and_then(Value::as_array_mut)
        .and_then(|rows| rows.pop())
    {
        value = first;
    }
    if value.get("path").and_then(Value::as_str) != Some(expected_path) {
        return Err(ProviderFailure::MalformedResponse);
    }
    if value.get("isSymLink").and_then(Value::as_bool) == Some(true)
        || value
            .get("gitObjectType")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "blob")
        || value
            .pointer("/contentMetadata/isBinary")
            .and_then(Value::as_bool)
            == Some(true)
        || value
            .pointer("/contentMetadata/encoding")
            .and_then(Value::as_str)
            .is_some_and(|encoding| {
                !matches!(encoding.to_ascii_lowercase().as_str(), "utf-8" | "utf8")
            })
    {
        return Ok(AzureItemContent::NotShown);
    }
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .ok_or(ProviderFailure::MalformedResponse)?
        .as_bytes()
        .to_vec();
    if content.len() > MAX_ITEM_BYTES {
        return Err(ProviderFailure::OutputLimit);
    }
    Ok(AzureItemContent::Bytes(content))
}

fn valid_oid(value: Option<&str>) -> Result<String, ProviderFailure> {
    let value = value.ok_or(ProviderFailure::MalformedResponse)?;
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ProviderFailure::MalformedResponse);
    }
    Ok(value.to_ascii_lowercase())
}

fn valid_identifier(value: Option<&str>, max: usize) -> Result<String, ProviderFailure> {
    let value = value.ok_or(ProviderFailure::MalformedResponse)?;
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(ProviderFailure::MalformedResponse);
    }
    Ok(value.to_owned())
}

fn normalized_provider_path(value: &str) -> Result<String, ProviderFailure> {
    if value.is_empty() || value.len() > 16 * 1024 || value.contains('\0') {
        return Err(ProviderFailure::MalformedResponse);
    }
    Ok(value.to_owned())
}

pub(crate) fn display_path(value: &str) -> String {
    let value = value.strip_prefix('/').unwrap_or(value);
    let mut output = String::new();
    for character in value.chars().take(4096) {
        if character.is_control() || is_bidi_control(character) || is_unsafe_separator(character) {
            output.push('�');
        } else {
            output.push(character);
        }
    }
    if output.is_empty() {
        "(unnamed)".into()
    } else {
        output
    }
}

fn is_bidi_control(character: char) -> bool {
    matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn is_unsafe_separator(character: char) -> bool {
    matches!(character, '\u{2028}' | '\u{2029}')
}

fn patch_display_paths(change: &ProviderPullRequestChange) -> (String, String) {
    let current = display_path(&change.path);
    let original = display_path(change.original_path.as_deref().unwrap_or(&change.path));
    let old = if change.kind == ProviderPullRequestChangeKind::Added {
        "/dev/null".into()
    } else {
        format!("a/{original}")
    };
    let new = if change.kind == ProviderPullRequestChangeKind::Deleted {
        "/dev/null".into()
    } else {
        format!("b/{current}")
    };
    (old, new)
}

fn diff_header_paths(change: &ProviderPullRequestChange) -> (String, String) {
    let current = display_path(&change.path);
    let original = display_path(change.original_path.as_deref().unwrap_or(&change.path));
    (format!("a/{original}"), format!("b/{current}"))
}

fn bounded_patch(patch: String) -> Result<ProviderPullRequestDiff, ProviderFailure> {
    if patch.as_bytes().contains(&0) {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::Binary,
        ));
    }
    if patch
        .chars()
        .any(|character| is_bidi_control(character) || is_unsafe_separator(character))
        || patch
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::NotShown,
        ));
    }
    if patch.len() > MAX_PATCH_BYTES || patch.lines().count() > MAX_PATCH_LINES {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::Truncated,
        ));
    }
    Ok(ProviderPullRequestDiff::patch(patch))
}

fn synthesize_patch(
    change: &ProviderPullRequestChange,
    old: &[u8],
    new: &[u8],
) -> Result<ProviderPullRequestDiff, ProviderFailure> {
    if old.contains(&0) || new.contains(&0) {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::Binary,
        ));
    }
    const LFS_POINTER_HEADER: &[u8] = b"version https://git-lfs.github.com/spec/v1\n";
    if old.starts_with(LFS_POINTER_HEADER) || new.starts_with(LFS_POINTER_HEADER) {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::NotShown,
        ));
    }
    let (Ok(old), Ok(new)) = (std::str::from_utf8(old), std::str::from_utf8(new)) else {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::NonUtf8,
        ));
    };
    if old.len().saturating_add(new.len()) > MAX_ITEM_BYTES * 2 {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::Truncated,
        ));
    }
    let old_lines = old.lines().count();
    let new_lines = new.lines().count();
    if old_lines.saturating_add(new_lines) > MAX_DIFF_INPUT_LINES
        || old_lines.saturating_mul(new_lines) > MAX_DIFF_LINE_WORK
    {
        return Ok(ProviderPullRequestDiff::state(
            ProviderPullRequestDiffState::Truncated,
        ));
    }
    let (old_path, new_path) = patch_display_paths(change);
    let (diff_old_path, diff_new_path) = diff_header_paths(change);
    let patch = TextDiff::from_lines(old, new)
        .unified_diff()
        .context_radius(3)
        .header(&old_path, &new_path)
        .to_string();
    bounded_patch(format!(
        "diff --git {diff_old_path} {diff_new_path}\n{patch}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github_identity() -> PullRequestChangeIdentity {
        PullRequestChangeIdentity {
            provider: GitHostProvider::Github,
            repository_owner: "acme".into(),
            repository_project: None,
            repository_name: "widget".into(),
            number: 42,
        }
    }

    #[test]
    fn github_metadata_and_files_are_strict_and_bounded() {
        let identity = github_identity();
        let metadata = parse_github_metadata(&identity, br#"{"number":42,"owner":"ACME","repository":"Widget","baseSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}"#).unwrap();
        assert_eq!(metadata.base_version, "a".repeat(40));
        let row = serde_json::json!({"filename":"src/main.rs","status":"renamed","previous_filename":"src/lib.rs","sha":"cccccccccccccccccccccccccccccccccccccccc"});
        let change = parse_github_file(row, 7).unwrap();
        assert_eq!(change.kind, ProviderPullRequestChangeKind::Renamed);
        assert_eq!(change.ordinal, 7);
        assert!(
            parse_github_file(serde_json::json!({"filename":"x","status":"mystery"}), 0).is_err()
        );
    }

    #[test]
    fn azure_iteration_rows_keep_rename_and_the_257th_sentinel() {
        let identity = PullRequestChangeIdentity {
            provider: GitHostProvider::AzureDevOps,
            repository_owner: "valuespaces".into(),
            repository_project: Some("Target".into()),
            repository_name: "Widget".into(),
            number: 42,
        };
        let metadata = parse_azure_change_metadata(
            &identity,
            br#"{"pullRequestId":42,"supportsIterations":true,"sourceCommitId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","targetCommitId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","repository":{"id":"target-id","name":"Widget","project":"Target"},"forkSource":{"repository":{"id":"source-id","name":"Widget Fork","project":"Source"}}}"#,
        )
        .unwrap();
        assert_eq!(metadata.target_repository_id, "target-id");
        assert_eq!(metadata.source_repository_id, "source-id");
        assert_eq!(metadata.source_repository_project, "Source");

        let entries = (0..257)
            .map(|index| {
                serde_json::json!({
                    "changeType": if index == 0 { "rename" } else { "edit" },
                    "path": format!("/src/{index}.rs"),
                    "originalPath": (index == 0).then_some("/old.rs"),
                    "objectId": "cccccccccccccccccccccccccccccccccccccccc"
                })
            })
            .collect::<Vec<_>>();
        let rows = parse_azure_change_rows(
            &serde_json::to_vec(&serde_json::json!({
                "changeEntries": entries, "nextSkip": 0, "nextTop": 0
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(rows.changes.len(), 257);
        assert!(rows.truncated);
        assert_eq!(rows.changes[0].kind, ProviderPullRequestChangeKind::Renamed);

        assert!(matches!(
            parse_azure_item_content(
                "/asset.bin",
                br#"{"path":"/asset.bin","gitObjectType":"blob","content":"AA==","contentMetadata":{"isBinary":true,"encoding":"base64"}}"#,
            )
            .unwrap(),
            AzureItemContent::NotShown
        ));
    }

    #[test]
    fn patch_generation_is_bounded_and_sanitizes_display_paths() {
        let change = ProviderPullRequestChange {
            path: "src/evil\u{202e}.rs".into(),
            original_path: None,
            kind: ProviderPullRequestChangeKind::Modified,
            ordinal: 0,
            file_version: None,
        };
        let result = synthesize_patch(&change, b"old\n", b"new\n").unwrap();
        assert_eq!(result.state, ProviderPullRequestDiffState::Patch);
        let patch = result.patch.unwrap();
        assert!(patch.contains("evil�.rs"));
        assert!(!patch.contains('\u{202e}'));

        let renamed = ProviderPullRequestChange {
            path: "src/new name.rs".into(),
            original_path: Some("src/old name.rs".into()),
            kind: ProviderPullRequestChangeKind::Renamed,
            ordinal: 1,
            file_version: None,
        };
        let renamed_patch = synthesize_patch(&renamed, b"old\n", b"new\n")
            .unwrap()
            .patch
            .unwrap();
        assert!(renamed_patch.contains("diff --git a/src/old name.rs b/src/new name.rs"));
        assert!(renamed_patch.contains("--- a/src/old name.rs"));
        assert!(renamed_patch.contains("+++ b/src/new name.rs"));

        let unsafe_separator =
            synthesize_patch(&change, "old\u{2028}\n".as_bytes(), b"new\n").unwrap();
        assert_eq!(
            unsafe_separator.state,
            ProviderPullRequestDiffState::NotShown
        );

        let huge = "x\n".repeat(MAX_PATCH_LINES + 1);
        assert_eq!(
            synthesize_patch(&change, b"", huge.as_bytes())
                .unwrap()
                .state,
            ProviderPullRequestDiffState::Truncated
        );
        let adversarial_lines = "x\n".repeat(MAX_DIFF_INPUT_LINES / 2);
        assert_eq!(
            synthesize_patch(
                &change,
                adversarial_lines.as_bytes(),
                adversarial_lines.as_bytes()
            )
            .unwrap()
            .state,
            ProviderPullRequestDiffState::Truncated
        );
        assert_eq!(
            synthesize_patch(&change, b"\xff", b"new").unwrap().state,
            ProviderPullRequestDiffState::NonUtf8
        );
        assert_eq!(
            synthesize_patch(
                &change,
                b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
                b"new"
            )
            .unwrap()
            .state,
            ProviderPullRequestDiffState::NotShown
        );
    }

    #[test]
    fn provider_command_shapes_are_fixed_and_do_not_accept_client_endpoints() {
        let github = github_identity();
        assert_eq!(github_pr_endpoint(&github), "repos/acme/widget/pulls/42");
        let azure = PullRequestChangeIdentity {
            provider: GitHostProvider::AzureDevOps,
            repository_owner: "valuespaces".into(),
            repository_project: Some("Nucleus".into()),
            repository_name: "Nucleus".into(),
            number: 13632,
        };
        let args = azure_invoke_arguments(
            &azure,
            "pullRequestIterationChanges",
            vec![
                "project=Nucleus".into(),
                "repositoryId=repo".into(),
                "pullRequestId=13632".into(),
                "iterationId=2".into(),
            ],
            vec!["$top=257".into(), "$compareTo=0".into()],
            "{changeEntries:changeEntries}",
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--resource", "pullRequestIterationChanges"])
        );
        assert!(args.contains(&"$compareTo=0".into()));
        assert!(!args.iter().any(|arg| arg.contains("AZURE_DEVOPS_EXT_PAT")));

        let iteration_args = azure_invoke_arguments(
            &azure,
            "pullRequestIterations",
            vec![
                "project=Nucleus".into(),
                "repositoryId=repo".into(),
                "pullRequestId=13632".into(),
            ],
            vec![],
            AZURE_ITERATION_IDS_QUERY,
        );
        assert!(
            iteration_args
                .windows(2)
                .any(|pair| pair == ["--query", "value[].{id:id}"])
        );

        let source_item = azure_item_arguments(
            &azure,
            "Source Project",
            "source-repo-id",
            "/src/lib.rs",
            &"a".repeat(40),
        );
        assert!(source_item.contains(&"project=Source Project".into()));
        assert!(source_item.contains(&"repositoryId=source-repo-id".into()));
        assert!(!source_item.contains(&"project=Nucleus".into()));
    }

    #[test]
    fn azure_pull_request_content_allows_the_sequential_cli_call_budget() {
        let deadline = azure_pull_request_content_deadline(Duration::from_secs(60)).unwrap();
        let remaining = deadline.remaining().unwrap();

        assert!(remaining > Duration::from_secs(19));
        assert!(remaining <= AZURE_PULL_REQUEST_CONTENT_TIMEOUT);
    }

    #[test]
    fn content_reads_share_provider_suppression_at_the_exact_scope() {
        let github = GitHubClient::new(std::path::Path::new("/private/provider-processes"));
        github.record_suppression(ProviderFailure::Unauthorized, None);
        assert!(matches!(
            github.list_pull_request_changes_with_timeout(
                &github_identity(),
                Duration::from_millis(10),
            ),
            Err(ProviderFailure::Unauthorized)
        ));

        let azure = AzureDevOpsClient::new(std::path::Path::new("/private/provider-processes"));
        let deadline =
            termloop_platform::MonotonicDeadline::after(Duration::from_secs(60)).unwrap();
        let source_key = "azureDevOps|dev.azure.com|valuespaces|source";
        let target_key = "azureDevOps|dev.azure.com|valuespaces|target";
        azure
            .suppression
            .lock()
            .unwrap()
            .insert(source_key.into(), (ProviderFailure::Unauthorized, deadline));
        assert!(azure.check_suppression(target_key, "target-alias").is_ok());
        assert_eq!(
            azure.check_suppression(source_key, "source-alias"),
            Err(ProviderFailure::Unauthorized)
        );
    }
}
