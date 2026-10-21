//! Repository-wide open pull request listing for one resolved repository.
//!
//! Unlike the branch-targeted Task lookup, this lists every open pull request
//! of the repository, optionally narrowed to the authenticated CLI identity.
//! The provider resolves that identity (`@me` on GitHub, `me` on Azure DevOps),
//! so no account name crosses into arguments or results.

use super::*;

pub const MAX_REPOSITORY_PULL_REQUESTS: usize = 50;
const MAX_AUTHOR_CHARS: usize = 120;
const AZURE_REPOSITORY_PR_QUERY: &str = "[].{pullRequestId:pullRequestId,title:title,status:status,isDraft:isDraft,sourceRefName:sourceRefName,targetRefName:targetRefName,mergeStatus:mergeStatus,mergeCommitId:lastMergeCommit.commitId,creationDate:creationDate,closedDate:closedDate,sourceCommitDate:lastMergeSourceCommit.committer.date,repository:{name:repository.name,project:repository.project.name},forkSource:{repository:{name:forkSource.repository.name,project:forkSource.repository.project.name}},reviewers:reviewers[?isRequired].{vote:vote,isRequired:isRequired},author:createdBy.displayName}";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryPullRequestFilter {
    All,
    Authored,
    ReviewRequested,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryPullRequest {
    pub summary: PullRequestSummary,
    pub author: Option<String>,
    pub created_at_epoch_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryPullRequestList {
    pub pull_requests: Vec<RepositoryPullRequest>,
    pub truncated: bool,
}

impl GitHubClient {
    pub fn list_repository_pull_requests(
        &self,
        repository: &GitHubRepository,
        filter: RepositoryPullRequestFilter,
        timeout: Duration,
    ) -> Result<RepositoryPullRequestList, ProviderFailure> {
        self.check_suppression()?;
        let result = self.list_repository_pull_requests_unsuppressed(
            repository,
            filter,
            timeout.min(Duration::from_secs(8)),
        );
        if let Err((failure, retry_after)) = &result {
            self.record_suppression(*failure, *retry_after);
        }
        result.map_err(|(failure, _)| failure)
    }

    fn list_repository_pull_requests_unsuppressed(
        &self,
        repository: &GitHubRepository,
        filter: RepositoryPullRequestFilter,
        timeout: Duration,
    ) -> Result<RepositoryPullRequestList, (ProviderFailure, Option<u64>)> {
        let without_retry = |failure| (failure, None);
        self.ensure_discovered(timeout).map_err(without_retry)?;
        let body = github_repository_search_body(repository, filter).map_err(without_retry)?;
        let outcome = termloop_platform::run_command(
            self.request(timeout).map_err(without_retry)?.stdin(body),
        )
        .map_err(|_| without_retry(ProviderFailure::ProviderUnavailable))?;
        classify_termination(&outcome.termination, &outcome.stderr).map_err(without_retry)?;
        if outcome.stdout_truncated || outcome.stderr_truncated {
            return Err(without_retry(ProviderFailure::OutputLimit));
        }
        parse_github_repository_search(
            repository,
            &outcome.stdout,
            termloop_platform::current_epoch_ms(),
        )
    }
}

fn github_repository_search_body(
    repository: &GitHubRepository,
    filter: RepositoryPullRequestFilter,
) -> Result<Vec<u8>, ProviderFailure> {
    if !valid_slug(&repository.owner) || !valid_slug(&repository.name) {
        return Err(ProviderFailure::ProviderFailure);
    }
    let qualifier = match filter {
        RepositoryPullRequestFilter::All => "",
        RepositoryPullRequestFilter::Authored => " author:@me",
        RepositoryPullRequestFilter::ReviewRequested => " review-requested:@me",
    };
    let search = format!(
        "repo:{}/{} is:pr is:open sort:updated-desc{qualifier}",
        repository.owner, repository.name
    );
    let query = format!(
        "query TermLoopRepositoryPullRequests($search:String!){{search(query:$search,type:ISSUE,first:{MAX_REPOSITORY_PULL_REQUESTS}){{issueCount pageInfo{{hasNextPage}} nodes{{... on PullRequest{{number title state isDraft baseRefName headRefName headRepository{{nameWithOwner}} author{{login}} mergeCommit{{oid}} createdAt updatedAt mergeable reviewDecision commits(last:1){{nodes{{commit{{statusCheckRollup{{state}}}}}}}}}}}}}} rateLimit{{remaining resetAt}}}}"
    );
    serde_json::to_vec(&json!({ "query": query, "variables": { "search": search } }))
        .map_err(|_| ProviderFailure::ProviderFailure)
}

fn parse_github_repository_search(
    repository: &GitHubRepository,
    bytes: &[u8],
    now: u64,
) -> Result<RepositoryPullRequestList, (ProviderFailure, Option<u64>)> {
    let malformed = (ProviderFailure::MalformedResponse, None);
    let root: Value = serde_json::from_slice(bytes).map_err(|_| malformed)?;
    let data = root
        .get("data")
        .filter(|value| value.is_object())
        .ok_or(malformed)?;
    if data.pointer("/rateLimit/remaining").and_then(Value::as_u64) == Some(0) {
        let retry_after = data
            .pointer("/rateLimit/resetAt")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_epoch_ms)
            .map(|reset| {
                now.saturating_add(reset.saturating_sub(now).clamp(60_000, 30 * 60 * 1_000))
            });
        return Err((ProviderFailure::RateLimited, retry_after));
    }
    if let Some(failure) = classify_graphql_errors(root.get("errors"), "search") {
        return Err((failure, None));
    }
    let search = data
        .get("search")
        .filter(|value| !value.is_null())
        .ok_or((ProviderFailure::ProviderFailure, None))?;
    let nodes = search
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or(malformed)?;
    let mut truncated = search
        .pointer("/pageInfo/hasNextPage")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        || nodes.len() > MAX_REPOSITORY_PULL_REQUESTS;
    let mut pull_requests = Vec::new();
    for node in nodes.iter().take(MAX_REPOSITORY_PULL_REQUESTS) {
        match normalize_github_repository_node(repository, node) {
            Some(pull_request) => pull_requests.push(pull_request),
            None => truncated = true,
        }
    }
    Ok(RepositoryPullRequestList {
        pull_requests,
        truncated,
    })
}

fn normalize_github_repository_node(
    repository: &GitHubRepository,
    node: &Value,
) -> Option<RepositoryPullRequest> {
    let head_branch = bounded_text(node.get("headRefName")?.as_str()?, 255);
    // A deleted fork leaves no head repository; it is still an open pull
    // request of this repository, so the head owner stays empty.
    let (head_owner, head_name) = match node.pointer("/headRepository/nameWithOwner") {
        Some(Value::String(value)) => value.split_once('/')?,
        Some(Value::Null) | None => ("", ""),
        Some(_) => return None,
    };
    let summary =
        normalize_matching_summary(node, repository, &head_branch, head_owner, head_name)?;
    Some(RepositoryPullRequest {
        summary,
        author: node
            .pointer("/author/login")
            .and_then(Value::as_str)
            .and_then(author_label),
        created_at_epoch_ms: node
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_epoch_ms),
    })
}

impl AzureDevOpsClient {
    pub fn list_repository_pull_requests(
        &self,
        repository: &AzureRepository,
        filter: RepositoryPullRequestFilter,
        timeout: Duration,
    ) -> Result<RepositoryPullRequestList, ProviderFailure> {
        let deadline =
            termloop_platform::MonotonicDeadline::after(timeout.min(Duration::from_secs(8)))
                .map_err(|_| ProviderFailure::Timeout)?;
        let repository = AzureRepository {
            organization: normalize_organization(&repository.organization)
                .map_err(|_| ProviderFailure::ProviderFailure)?,
            project: normalize_azure_display_name(&repository.project, AzureNameKind::Project)
                .map_err(|_| ProviderFailure::ProviderFailure)?,
            name: normalize_azure_display_name(&repository.name, AzureNameKind::Repository)
                .map_err(|_| ProviderFailure::ProviderFailure)?,
        };
        let project_key = repository.project_key();
        let repository_key = repository.repository_key();
        self.check_suppression(&project_key, &repository_key)?;
        self.ensure_discovered(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let generation = self.credential.generation();
        let outcome = termloop_platform::run_command(
            self.base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?
                .args(azure_repository_pull_request_arguments(&repository, filter)),
        )
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        self.classify_query_outcome(&project_key, &repository_key, generation, &outcome)?;
        parse_azure_repository_pull_requests(repository, &outcome.stdout)
    }
}

fn azure_repository_pull_request_arguments(
    repository: &AzureRepository,
    filter: RepositoryPullRequestFilter,
) -> Vec<String> {
    let mut arguments = vec![
        "repos".into(),
        "pr".into(),
        "list".into(),
        "--organization".into(),
        format!("https://{AZURE_HOST}/{}", repository.organization),
        "--project".into(),
        repository.project.clone(),
        "--repository".into(),
        repository.name.clone(),
        "--status".into(),
        "active".into(),
        "--top".into(),
        (MAX_REPOSITORY_PULL_REQUESTS + 1).to_string(),
    ];
    match filter {
        RepositoryPullRequestFilter::All => {}
        RepositoryPullRequestFilter::Authored => {
            arguments.extend(["--creator".into(), "me".into()]);
        }
        RepositoryPullRequestFilter::ReviewRequested => {
            arguments.extend(["--reviewer".into(), "me".into()]);
        }
    }
    arguments.extend([
        "--detect".into(),
        "false".into(),
        "--query".into(),
        AZURE_REPOSITORY_PR_QUERY.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]);
    arguments
}

fn parse_azure_repository_pull_requests(
    repository: AzureRepository,
    bytes: &[u8],
) -> Result<RepositoryPullRequestList, ProviderFailure> {
    let rows: Vec<Value> =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let mut truncated = rows.len() > MAX_REPOSITORY_PULL_REQUESTS;
    let target = AzureRepository {
        organization: repository.organization.clone(),
        project: repository.project.clone(),
        name: repository.name.clone(),
    };
    let query = AzurePullRequestQuery {
        repository,
        head_branch: String::new(),
    };
    let mut pull_requests = Vec::new();
    for row in rows.iter().take(MAX_REPOSITORY_PULL_REQUESTS) {
        let Some(summary) = normalize_azure_summary(&query, Some(&target), row) else {
            truncated = true;
            continue;
        };
        pull_requests.push(RepositoryPullRequest {
            summary,
            author: row
                .get("author")
                .and_then(Value::as_str)
                .and_then(author_label),
            created_at_epoch_ms: row
                .get("creationDate")
                .and_then(Value::as_str)
                .and_then(parse_rfc3339_epoch_ms),
        });
    }
    pull_requests.sort_by(|left, right| {
        right
            .summary
            .updated_at_epoch_ms
            .cmp(&left.summary.updated_at_epoch_ms)
            .then_with(|| right.summary.number.cmp(&left.summary.number))
    });
    Ok(RepositoryPullRequestList {
        pull_requests,
        truncated,
    })
}

fn author_label(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && !value.chars().any(char::is_control))
        .then(|| bounded_text(value, MAX_AUTHOR_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github_repository() -> GitHubRepository {
        GitHubRepository {
            owner: "acme".into(),
            name: "widget".into(),
        }
    }

    fn github_node(number: u64) -> Value {
        json!({
            "number": number,
            "title": format!("PR {number}"),
            "state": "OPEN",
            "isDraft": false,
            "baseRefName": "main",
            "headRefName": format!("feature/{number}"),
            "headRepository": { "nameWithOwner": "acme/widget" },
            "author": { "login": "octo-cat" },
            "mergeCommit": null,
            "createdAt": "2026-10-20T10:00:00Z",
            "updatedAt": "2026-10-21T10:00:00Z",
            "mergeable": "MERGEABLE",
            "reviewDecision": "REVIEW_REQUIRED",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "SUCCESS" } } }] }
        })
    }

    fn github_response(nodes: Vec<Value>, has_next_page: bool) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "data": {
                "search": {
                    "issueCount": nodes.len(),
                    "pageInfo": { "hasNextPage": has_next_page },
                    "nodes": nodes
                },
                "rateLimit": { "remaining": 4000, "resetAt": "2026-10-21T11:00:00Z" }
            }
        }))
        .unwrap()
    }

    #[test]
    fn github_search_body_passes_the_filter_as_a_variable_and_never_an_identity() {
        let body: Value = serde_json::from_slice(
            &github_repository_search_body(
                &github_repository(),
                RepositoryPullRequestFilter::ReviewRequested,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            body["variables"]["search"],
            "repo:acme/widget is:pr is:open sort:updated-desc review-requested:@me"
        );
        assert!(!body["query"].as_str().unwrap().contains("acme"));
        assert!(
            github_repository_search_body(
                &GitHubRepository {
                    owner: "acme widget".into(),
                    name: "x".into()
                },
                RepositoryPullRequestFilter::All
            )
            .is_err()
        );
    }

    #[test]
    fn github_search_normalizes_open_pull_requests_with_author_and_signals() {
        let mut deleted_fork = github_node(8);
        deleted_fork["headRepository"] = Value::Null;
        deleted_fork["author"] = Value::Null;
        let list = parse_github_repository_search(
            &github_repository(),
            &github_response(vec![github_node(7), deleted_fork], false),
            0,
        )
        .unwrap();
        assert!(!list.truncated);
        assert_eq!(list.pull_requests.len(), 2);
        let first = &list.pull_requests[0];
        assert_eq!(first.author.as_deref(), Some("octo-cat"));
        assert_eq!(first.summary.url, "https://github.com/acme/widget/pull/7");
        assert_eq!(first.summary.checks, CheckState::Passing);
        assert_eq!(first.summary.review, ReviewState::ReviewRequired);
        assert!(first.created_at_epoch_ms.is_some());
        assert_eq!(list.pull_requests[1].author, None);
        assert_eq!(list.pull_requests[1].summary.head_repository_owner, "");
    }

    #[test]
    fn github_search_marks_more_pages_and_incomplete_nodes_as_truncated() {
        let list = parse_github_repository_search(
            &github_repository(),
            &github_response(vec![github_node(1)], true),
            0,
        )
        .unwrap();
        assert!(list.truncated);
        let mut incomplete = github_node(2);
        incomplete["state"] = Value::Null;
        let list = parse_github_repository_search(
            &github_repository(),
            &github_response(vec![incomplete], false),
            0,
        )
        .unwrap();
        assert!(list.truncated);
        assert!(list.pull_requests.is_empty());
    }

    #[test]
    fn github_search_exhausted_rate_limit_is_typed_with_a_bounded_retry() {
        let bytes = serde_json::to_vec(&json!({
            "data": {
                "search": { "pageInfo": { "hasNextPage": false }, "nodes": [] },
                "rateLimit": { "remaining": 0, "resetAt": "1970-01-01T00:00:01Z" }
            }
        }))
        .unwrap();
        let failure = parse_github_repository_search(&github_repository(), &bytes, 1_000);
        assert_eq!(
            failure.unwrap_err(),
            (ProviderFailure::RateLimited, Some(61_000))
        );
        let unauthorized = serde_json::to_vec(&json!({
            "data": { "search": null },
            "errors": [{ "type": "FORBIDDEN", "path": ["search"] }]
        }))
        .unwrap();
        assert_eq!(
            parse_github_repository_search(&github_repository(), &unauthorized, 0).unwrap_err(),
            (ProviderFailure::Unauthorized, None)
        );
    }

    fn azure_repository() -> AzureRepository {
        AzureRepository {
            organization: "contoso".into(),
            project: "Fabrikam".into(),
            name: "Storefront".into(),
        }
    }

    fn azure_row(number: u64, updated: &str) -> Value {
        json!({
            "pullRequestId": number,
            "title": format!("PR {number}"),
            "status": "active",
            "isDraft": false,
            "sourceRefName": "refs/heads/feature",
            "targetRefName": "refs/heads/main",
            "mergeStatus": "succeeded",
            "mergeCommitId": null,
            "creationDate": updated,
            "closedDate": null,
            "sourceCommitDate": null,
            "repository": { "name": "Storefront", "project": "Fabrikam" },
            "forkSource": { "repository": { "name": null, "project": null } },
            "reviewers": [],
            "author": "Ada Lovelace"
        })
    }

    #[test]
    fn azure_filters_use_the_cli_me_identity_and_bound_rows() {
        let all = azure_repository_pull_request_arguments(
            &azure_repository(),
            RepositoryPullRequestFilter::All,
        );
        assert!(!all.iter().any(|argument| argument == "me"));
        assert!(all.windows(2).any(|pair| pair == ["--status", "active"]));
        assert!(all.windows(2).any(|pair| pair == ["--top", "51"]));
        let authored = azure_repository_pull_request_arguments(
            &azure_repository(),
            RepositoryPullRequestFilter::Authored,
        );
        assert!(authored.windows(2).any(|pair| pair == ["--creator", "me"]));
        let review = azure_repository_pull_request_arguments(
            &azure_repository(),
            RepositoryPullRequestFilter::ReviewRequested,
        );
        assert!(review.windows(2).any(|pair| pair == ["--reviewer", "me"]));
    }

    #[test]
    fn azure_rows_normalize_newest_first_and_mark_overflow_or_malformed_rows() {
        let bytes = serde_json::to_vec(&json!([
            azure_row(1, "2026-10-20T10:00:00Z"),
            azure_row(2, "2026-10-21T10:00:00Z")
        ]))
        .unwrap();
        let list = parse_azure_repository_pull_requests(azure_repository(), &bytes).unwrap();
        assert!(!list.truncated);
        assert_eq!(
            list.pull_requests
                .iter()
                .map(|pull_request| pull_request.summary.number)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(
            list.pull_requests[0].author.as_deref(),
            Some("Ada Lovelace")
        );
        assert_eq!(
            list.pull_requests[0].summary.checks,
            CheckState::Unsupported
        );

        let mut malformed = azure_row(3, "2026-10-21T10:00:00Z");
        malformed["status"] = json!("weird");
        let rows = (0..MAX_REPOSITORY_PULL_REQUESTS as u64 + 1)
            .map(|number| azure_row(number + 10, "2026-10-21T10:00:00Z"))
            .chain([malformed])
            .collect::<Vec<_>>();
        let list = parse_azure_repository_pull_requests(
            azure_repository(),
            &serde_json::to_vec(&rows).unwrap(),
        )
        .unwrap();
        assert!(list.truncated);
        assert_eq!(list.pull_requests.len(), MAX_REPOSITORY_PULL_REQUESTS);
    }

    #[test]
    fn author_labels_are_bounded_and_control_free() {
        assert_eq!(author_label("  ada "), Some("ada".into()));
        assert_eq!(author_label("bad\u{7}bell"), None);
        assert_eq!(author_label(""), None);
        assert_eq!(
            author_label(&"a".repeat(500)).map(|label| label.chars().count()),
            Some(MAX_AUTHOR_CHARS)
        );
    }
}
