//! Pull requests of one repository that name a Jira issue key.
//!
//! A Project Manager project identifies a developer's work only by the Jira
//! key (for example `PAY-42`) appearing in the pull request head branch or
//! title. This lists every such pull request in any state. Multiple matches
//! stay a list; the provider never picks one.

use super::*;

pub const MAX_ISSUE_KEY_PULL_REQUESTS: usize = 20;
const MAX_ISSUE_KEY_CHARS: usize = 100;
const GITHUB_ISSUE_KEY_SEARCH_ROWS: usize = 20;
const GITHUB_ISSUE_KEY_RECENT_ROWS: usize = 50;
const AZURE_ISSUE_KEY_ROWS: usize = 100;
const GITHUB_PULL_REQUEST_FIELDS: &str = "number title state isDraft baseRefName headRefName headRepository{nameWithOwner} mergeCommit{oid} updatedAt mergeable reviewDecision commits(last:1){nodes{commit{statusCheckRollup{state}}}}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueKeyPullRequests {
    /// Newest-updated first, deduplicated by number, at most
    /// [`MAX_ISSUE_KEY_PULL_REQUESTS`].
    pub pull_requests: Vec<PullRequestSummary>,
    /// More matching pull requests may exist than were returned, or a
    /// candidate could not be normalized.
    pub truncated: bool,
}

/// Valid Jira issue key: `^[A-Z][A-Z0-9_]*-[1-9][0-9]*$`.
pub fn valid_issue_key(key: &str) -> bool {
    let Some((project, number)) = key.split_once('-') else {
        return false;
    };
    let project = project.as_bytes();
    let number = number.as_bytes();
    key.len() <= MAX_ISSUE_KEY_CHARS
        && project.first().is_some_and(u8::is_ascii_uppercase)
        && project
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
        && number
            .first()
            .is_some_and(|byte| (b'1'..=b'9').contains(byte))
        && number.iter().all(u8::is_ascii_digit)
}

/// Case-insensitive whole-key match inside a branch name or title:
/// `feature/pay-42-cors`, `PAY-42: fix`, and `[PAY-42]` name `PAY-42`;
/// `PAY-420`, `XPAY-42`, and `PAY-4` do not. A boundary is the start or end
/// of the text or any non-alphanumeric character.
pub fn names_issue_key(text: &str, key: &str) -> bool {
    if !valid_issue_key(key) {
        return false;
    }
    let key = key.as_bytes();
    let bytes = text.as_bytes();
    if bytes.len() < key.len() {
        return false;
    }
    (0..=bytes.len() - key.len()).any(|start| {
        let end = start + key.len();
        // The key is ASCII, so a matching window always starts and ends on
        // character boundaries.
        bytes[start..end].eq_ignore_ascii_case(key)
            && !text[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric)
            && !text[end..]
                .chars()
                .next()
                .is_some_and(char::is_alphanumeric)
    })
}

impl GitHubClient {
    /// One GraphQL call combining a title search with a scan of the 50 most
    /// recently updated pull requests, which catches keys that appear only in
    /// the head branch name. That recent scan is a bounded heuristic: a
    /// branch-only match older than the 50 most recent pull requests is not
    /// found, and this does not set `truncated`.
    pub fn issue_key_pull_requests(
        &self,
        repository: &GitHubRepository,
        key: &str,
        timeout: Duration,
    ) -> Result<IssueKeyPullRequests, ProviderFailure> {
        if !valid_issue_key(key) {
            return Err(ProviderFailure::ProviderFailure);
        }
        self.check_suppression()?;
        let result = self.issue_key_pull_requests_unsuppressed(
            repository,
            key,
            timeout.min(Duration::from_secs(8)),
        );
        if let Err((failure, retry_after)) = &result {
            self.record_suppression(*failure, *retry_after);
        }
        result.map_err(|(failure, _)| failure)
    }

    fn issue_key_pull_requests_unsuppressed(
        &self,
        repository: &GitHubRepository,
        key: &str,
        timeout: Duration,
    ) -> Result<IssueKeyPullRequests, (ProviderFailure, Option<u64>)> {
        let without_retry = |failure| (failure, None);
        let body = github_issue_key_body(repository, key).map_err(without_retry)?;
        self.ensure_discovered(timeout).map_err(without_retry)?;
        let outcome = termloop_platform::run_command(
            self.request(timeout).map_err(without_retry)?.stdin(body),
        )
        .map_err(|_| without_retry(ProviderFailure::ProviderUnavailable))?;
        classify_termination(&outcome.termination, &outcome.stderr).map_err(without_retry)?;
        if outcome.stdout_truncated || outcome.stderr_truncated {
            return Err(without_retry(ProviderFailure::OutputLimit));
        }
        parse_github_issue_key_response(
            repository,
            key,
            &outcome.stdout,
            termloop_platform::current_epoch_ms(),
        )
    }
}

fn github_issue_key_body(
    repository: &GitHubRepository,
    key: &str,
) -> Result<Vec<u8>, ProviderFailure> {
    if !valid_slug(&repository.owner) || !valid_slug(&repository.name) || !valid_issue_key(key) {
        return Err(ProviderFailure::ProviderFailure);
    }
    let search = format!(
        "repo:{}/{} is:pr {key} in:title sort:updated-desc",
        repository.owner, repository.name
    );
    let query = format!(
        "query TermLoopIssueKeyPullRequests($search:String!,$owner:String!,$name:String!){{search:search(query:$search,type:ISSUE,first:{GITHUB_ISSUE_KEY_SEARCH_ROWS}){{issueCount nodes{{... on PullRequest{{{GITHUB_PULL_REQUEST_FIELDS}}}}}}} recent:repository(owner:$owner,name:$name){{pullRequests(first:{GITHUB_ISSUE_KEY_RECENT_ROWS},orderBy:{{field:UPDATED_AT,direction:DESC}}){{nodes{{{GITHUB_PULL_REQUEST_FIELDS}}}}}}} rateLimit{{remaining resetAt}}}}"
    );
    let body = serde_json::to_vec(&json!({
        "query": query,
        "variables": {
            "search": search,
            "owner": repository.owner,
            "name": repository.name,
        }
    }))
    .map_err(|_| ProviderFailure::ProviderFailure)?;
    if body.len() > MAX_STDIN {
        return Err(ProviderFailure::OutputLimit);
    }
    Ok(body)
}

fn parse_github_issue_key_response(
    repository: &GitHubRepository,
    key: &str,
    bytes: &[u8],
    now: u64,
) -> Result<IssueKeyPullRequests, (ProviderFailure, Option<u64>)> {
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
    for alias in ["search", "recent"] {
        if let Some(failure) = classify_graphql_errors(root.get("errors"), alias) {
            return Err((failure, None));
        }
    }
    let unavailable = (ProviderFailure::ProviderFailure, None);
    let search = data
        .get("search")
        .filter(|value| !value.is_null())
        .ok_or(unavailable)?;
    let search_nodes = search
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or(malformed)?;
    let recent_nodes = data
        .get("recent")
        .filter(|value| !value.is_null())
        .ok_or(unavailable)?
        .pointer("/pullRequests/nodes")
        .and_then(Value::as_array)
        .ok_or(malformed)?;
    let mut truncated = search
        .get("issueCount")
        .and_then(Value::as_u64)
        .is_none_or(|count| count > search_nodes.len() as u64);
    let mut matches = BTreeMap::new();
    for node in search_nodes.iter().chain(recent_nodes) {
        match normalize_github_issue_key_node(repository, key, node) {
            KeyedNode::Match(summary) => {
                matches.entry(summary.number).or_insert(*summary);
            }
            KeyedNode::NonMatch => {}
            KeyedNode::Incomplete => truncated = true,
        }
    }
    Ok(capped_newest_first(
        matches.into_values().collect(),
        truncated,
    ))
}

enum KeyedNode {
    Match(Box<PullRequestSummary>),
    NonMatch,
    Incomplete,
}

fn normalize_github_issue_key_node(
    repository: &GitHubRepository,
    key: &str,
    node: &Value,
) -> KeyedNode {
    let head_branch = node.get("headRefName").and_then(Value::as_str);
    let title = node.get("title").and_then(Value::as_str);
    if !names_key_in(head_branch, title, key) {
        return if head_branch.is_none() || title.is_none() {
            KeyedNode::Incomplete
        } else {
            KeyedNode::NonMatch
        };
    }
    let Some(head_branch) = head_branch.map(|value| bounded_text(value, 255)) else {
        return KeyedNode::Incomplete;
    };
    // A deleted fork leaves no head repository; the pull request still
    // belongs to this repository, so the head owner stays empty.
    let (head_owner, head_name) = match node.pointer("/headRepository/nameWithOwner") {
        Some(Value::String(value)) => match value.split_once('/') {
            Some(parts) => parts,
            None => return KeyedNode::Incomplete,
        },
        Some(Value::Null) | None => ("", ""),
        Some(_) => return KeyedNode::Incomplete,
    };
    match normalize_matching_summary(node, repository, &head_branch, head_owner, head_name) {
        Some(summary) => KeyedNode::Match(Box::new(summary)),
        None => KeyedNode::Incomplete,
    }
}

fn names_key_in(head_branch: Option<&str>, title: Option<&str>, key: &str) -> bool {
    head_branch.is_some_and(|value| names_issue_key(value, key))
        || title.is_some_and(|value| names_issue_key(value, key))
}

fn capped_newest_first(
    mut pull_requests: Vec<PullRequestSummary>,
    truncated: bool,
) -> IssueKeyPullRequests {
    pull_requests.sort_by(|left, right| {
        right
            .updated_at_epoch_ms
            .cmp(&left.updated_at_epoch_ms)
            .then_with(|| right.number.cmp(&left.number))
    });
    let truncated = truncated || pull_requests.len() > MAX_ISSUE_KEY_PULL_REQUESTS;
    pull_requests.truncate(MAX_ISSUE_KEY_PULL_REQUESTS);
    IssueKeyPullRequests {
        pull_requests,
        truncated,
    }
}

impl AzureDevOpsClient {
    /// One `az repos pr list` for the repository, matched against every key
    /// in memory: Azure DevOps cannot search by key, so listing once serves
    /// all keys. Results follow `keys`; an invalid key fails alone. With
    /// `include_checks`, each matched pull request's policy rollup is read
    /// once, however many keys name it.
    pub fn issue_keys_pull_requests(
        &self,
        repository: &AzureRepository,
        keys: &[String],
        include_checks: bool,
        timeout: Duration,
    ) -> Result<Vec<Result<IssueKeyPullRequests, ProviderFailure>>, ProviderFailure> {
        if !keys.iter().any(|key| valid_issue_key(key)) {
            return Ok(keys
                .iter()
                .map(|_| Err(ProviderFailure::ProviderFailure))
                .collect());
        }
        let deadline =
            termloop_platform::MonotonicDeadline::after(timeout.min(Duration::from_secs(20)))
                .map_err(|_| ProviderFailure::Timeout)?;
        let repository = repository
            .normalized()
            .ok_or(ProviderFailure::ProviderFailure)?;
        let project_key = repository.project_key();
        let repository_key = repository.repository_key();
        self.check_suppression(&project_key, &repository_key)?;
        self.ensure_discovered(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?;
        let generation = self.credential.generation();
        let outcome = termloop_platform::run_command(
            self.base_request(deadline.remaining().ok_or(ProviderFailure::Timeout)?)?
                .args(azure_issue_key_arguments(&repository)),
        )
        .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        self.classify_query_outcome(&project_key, &repository_key, generation, &outcome)?;
        let organization = repository.organization.clone();
        let mut results: Vec<_> = keys
            .iter()
            .map(|key| {
                if !valid_issue_key(key) {
                    return Err(ProviderFailure::ProviderFailure);
                }
                parse_azure_issue_key_pull_requests(repository.clone(), key, &outcome.stdout)
            })
            .collect();
        if include_checks {
            let mut matched = BTreeMap::new();
            for summary in results
                .iter()
                .flatten()
                .flat_map(|found| &found.pull_requests)
            {
                matched
                    .entry(summary.number)
                    .or_insert_with(|| summary.clone());
            }
            let mut checked = IssueKeyPullRequests {
                pull_requests: matched.into_values().collect(),
                truncated: false,
            };
            self.attach_issue_key_checks(&organization, &mut checked, deadline);
            let checked: BTreeMap<_, _> = checked
                .pull_requests
                .into_iter()
                .map(|summary| (summary.number, summary))
                .collect();
            for summary in results
                .iter_mut()
                .flatten()
                .flat_map(|found| &mut found.pull_requests)
            {
                if let Some(with_checks) = checked.get(&summary.number) {
                    *summary = with_checks.clone();
                }
            }
        }
        Ok(results)
    }

    /// The policy rollup attaches at most [`AZURE_MAX_MATCHES`] active pull
    /// requests per scan, so the capped list is attached in chunks.
    fn attach_issue_key_checks(
        &self,
        organization: &str,
        result: &mut IssueKeyPullRequests,
        deadline: termloop_platform::MonotonicDeadline,
    ) {
        let mut attached = Vec::with_capacity(result.pull_requests.len());
        let mut pending = std::mem::take(&mut result.pull_requests);
        while !pending.is_empty() {
            let rest = pending.split_off(pending.len().min(AZURE_MAX_MATCHES));
            let mut scan = AzurePullRequestScan {
                pull_requests: pending,
                truncated: false,
                incomplete: false,
                parent_resolved: true,
            };
            self.attach_azure_policy_checks(organization, &mut scan, deadline);
            attached.extend(scan.pull_requests);
            pending = rest;
        }
        result.pull_requests = attached;
    }
}

fn azure_issue_key_arguments(repository: &AzureRepository) -> Vec<String> {
    vec![
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
        "all".into(),
        "--top".into(),
        AZURE_ISSUE_KEY_ROWS.to_string(),
        "--detect".into(),
        "false".into(),
        "--query".into(),
        AZURE_PR_QUERY.into(),
        "--output".into(),
        "json".into(),
        "--only-show-errors".into(),
    ]
}

fn parse_azure_issue_key_pull_requests(
    repository: AzureRepository,
    key: &str,
    bytes: &[u8],
) -> Result<IssueKeyPullRequests, ProviderFailure> {
    let rows: Vec<Value> =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let mut truncated = rows.len() >= AZURE_ISSUE_KEY_ROWS;
    let target = repository.clone();
    let query = AzurePullRequestQuery {
        repository,
        head_branch: String::new(),
    };
    let mut matches = BTreeMap::new();
    for row in rows.iter().take(AZURE_ISSUE_KEY_ROWS) {
        let head_branch = row
            .get("sourceRefName")
            .and_then(Value::as_str)
            .map(|value| value.strip_prefix("refs/heads/").unwrap_or(value));
        let title = row.get("title").and_then(Value::as_str);
        if !names_key_in(head_branch, title, key) {
            truncated |= head_branch.is_none() || title.is_none();
            continue;
        }
        match normalize_azure_summary(&query, Some(&target), row) {
            Some(summary) => {
                matches.entry(summary.number).or_insert(summary);
            }
            None => truncated = true,
        }
    }
    Ok(capped_newest_first(
        matches.into_values().collect(),
        truncated,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_keys_must_be_uppercase_project_dash_positive_number() {
        for key in ["PAY-42", "A-1", "MY_PROJ2-10", "X9-100"] {
            assert!(valid_issue_key(key), "rejected {key}");
        }
        for key in [
            "", "pay-42", "PAY-0", "PAY-042", "PAY42", "-42", "9PAY-1", "_PAY-1", "PAY-", "PAY-4a",
            "PAY-42-1", " PAY-42", "PAY-42\n",
        ] {
            assert!(!valid_issue_key(key), "accepted {key:?}");
        }
        assert!(!valid_issue_key(&format!("P{}-1", "A".repeat(100))));
    }

    #[test]
    fn issue_key_matches_whole_keys_case_insensitively() {
        for (text, expected) in [
            ("feature/pay-42-cors", true),
            ("PAY-42: fix", true),
            ("[PAY-42] Fix CORS", true),
            ("PAY-42", true),
            ("bugfix/PAY-42", true),
            ("fix(pay-42)", true),
            ("PAY-420", false),
            ("XPAY-42", false),
            ("PAY-4", false),
            ("feature/PAY-4-and-PAY-421", false),
            ("PAY-421 then PAY-42", true),
            ("éPAY-42", false),
            ("PAY-42é", false),
            ("ü/PAY-42", true),
            ("", false),
        ] {
            assert_eq!(names_issue_key(text, "PAY-42"), expected, "{text:?}");
        }
        assert!(!names_issue_key("pay-42", "pay-42"));
        assert!(names_issue_key("feature/PAY-4", "PAY-4"));
    }

    fn github_repository() -> GitHubRepository {
        GitHubRepository {
            owner: "acme".into(),
            name: "widget".into(),
        }
    }

    fn github_node(number: u64, title: &str, head: &str, updated: &str) -> Value {
        json!({
            "number": number,
            "title": title,
            "state": "OPEN",
            "isDraft": false,
            "baseRefName": "main",
            "headRefName": head,
            "headRepository": { "nameWithOwner": "acme/widget" },
            "mergeCommit": null,
            "updatedAt": updated,
            "mergeable": "MERGEABLE",
            "reviewDecision": "APPROVED",
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
        })
    }

    fn github_response(search: Vec<Value>, issue_count: u64, recent: Vec<Value>) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "data": {
                "search": { "issueCount": issue_count, "nodes": search },
                "recent": { "pullRequests": { "nodes": recent } },
                "rateLimit": { "remaining": 4000, "resetAt": "2026-10-21T11:00:00Z" }
            }
        }))
        .unwrap()
    }

    #[test]
    fn github_body_combines_title_search_and_recent_scan_through_variables() {
        let body: Value =
            serde_json::from_slice(&github_issue_key_body(&github_repository(), "PAY-42").unwrap())
                .unwrap();
        assert_eq!(
            body["variables"]["search"],
            "repo:acme/widget is:pr PAY-42 in:title sort:updated-desc"
        );
        assert_eq!(body["variables"]["owner"], "acme");
        assert_eq!(body["variables"]["name"], "widget");
        let query = body["query"].as_str().unwrap();
        assert!(query.contains("search:search(query:$search,type:ISSUE,first:20)"));
        assert!(query.contains(
            "recent:repository(owner:$owner,name:$name){pullRequests(first:50,orderBy:{field:UPDATED_AT,direction:DESC})"
        ));
        assert!(query.contains("statusCheckRollup"));
        assert!(!query.contains("acme") && !query.contains("PAY-42"));
        assert!(github_issue_key_body(&github_repository(), "pay-42").is_err());
    }

    #[test]
    fn github_merges_search_and_recent_scan_filtered_deduplicated_newest_first() {
        let mut merged = github_node(3, "Old work", "feature/pay-42-cors", "2026-10-19T10:00:00Z");
        merged["state"] = json!("MERGED");
        merged["mergeCommit"] = json!({ "oid": "a".repeat(40) });
        let list = parse_github_issue_key_response(
            &github_repository(),
            "PAY-42",
            &github_response(
                vec![
                    github_node(7, "PAY-42: fix CORS", "fix-cors", "2026-10-21T10:00:00Z"),
                    // The search tokenizes keys; the exact-key filter drops this.
                    github_node(8, "PAY-420 neighbour", "other", "2026-10-22T10:00:00Z"),
                ],
                2,
                vec![
                    github_node(7, "PAY-42: fix CORS", "fix-cors", "2026-10-21T10:00:00Z"),
                    merged,
                    github_node(9, "Unrelated", "feature/XPAY-42", "2026-10-23T10:00:00Z"),
                ],
            ),
            0,
        )
        .unwrap();
        assert!(!list.truncated);
        assert_eq!(
            list.pull_requests
                .iter()
                .map(|pull_request| pull_request.number)
                .collect::<Vec<_>>(),
            vec![7, 3]
        );
        let first = &list.pull_requests[0];
        assert_eq!(first.url, "https://github.com/acme/widget/pull/7");
        assert_eq!(first.checks, CheckState::Failing);
        assert_eq!(first.review, ReviewState::Approved);
        assert_eq!(list.pull_requests[1].state, PullRequestState::Merged);
        assert_eq!(
            list.pull_requests[1].merge_commit_oid.as_deref(),
            Some("a".repeat(40).as_str())
        );
    }

    #[test]
    fn github_marks_unreturned_search_hits_overflow_and_incomplete_matches_truncated() {
        let more_search_hits = parse_github_issue_key_response(
            &github_repository(),
            "PAY-42",
            &github_response(
                vec![github_node(1, "PAY-42", "a", "2026-10-21T10:00:00Z")],
                25,
                vec![],
            ),
            0,
        )
        .unwrap();
        assert!(more_search_hits.truncated);
        assert_eq!(more_search_hits.pull_requests.len(), 1);

        let recent = (1..=MAX_ISSUE_KEY_PULL_REQUESTS as u64 + 1)
            .map(|number| {
                github_node(
                    number,
                    "work",
                    &format!("feature/PAY-42-{number}"),
                    "2026-10-21T10:00:00Z",
                )
            })
            .collect();
        let over_cap = parse_github_issue_key_response(
            &github_repository(),
            "PAY-42",
            &github_response(vec![], 0, recent),
            0,
        )
        .unwrap();
        assert!(over_cap.truncated);
        assert_eq!(over_cap.pull_requests.len(), MAX_ISSUE_KEY_PULL_REQUESTS);
        assert_eq!(over_cap.pull_requests[0].number, 21);

        let mut incomplete = github_node(4, "PAY-42", "a", "2026-10-21T10:00:00Z");
        incomplete["state"] = Value::Null;
        let list = parse_github_issue_key_response(
            &github_repository(),
            "PAY-42",
            &github_response(vec![], 0, vec![incomplete]),
            0,
        )
        .unwrap();
        assert!(list.truncated);
        assert!(list.pull_requests.is_empty());

        let mut deleted_fork = github_node(5, "PAY-42", "a", "2026-10-21T10:00:00Z");
        deleted_fork["headRepository"] = Value::Null;
        let list = parse_github_issue_key_response(
            &github_repository(),
            "PAY-42",
            &github_response(vec![deleted_fork], 1, vec![]),
            0,
        )
        .unwrap();
        assert!(!list.truncated);
        assert_eq!(list.pull_requests[0].head_repository_owner, "");
    }

    #[test]
    fn github_degraded_states_are_typed_and_never_an_empty_list() {
        let rate_limited = serde_json::to_vec(&json!({
            "data": {
                "search": { "issueCount": 0, "nodes": [] },
                "recent": { "pullRequests": { "nodes": [] } },
                "rateLimit": { "remaining": 0, "resetAt": "1970-01-01T00:00:01Z" }
            }
        }))
        .unwrap();
        assert_eq!(
            parse_github_issue_key_response(&github_repository(), "PAY-42", &rate_limited, 1_000)
                .unwrap_err(),
            (ProviderFailure::RateLimited, Some(61_000))
        );
        let forbidden = serde_json::to_vec(&json!({
            "data": { "search": { "issueCount": 0, "nodes": [] }, "recent": null },
            "errors": [{ "type": "FORBIDDEN", "path": ["recent"] }]
        }))
        .unwrap();
        assert_eq!(
            parse_github_issue_key_response(&github_repository(), "PAY-42", &forbidden, 0)
                .unwrap_err(),
            (ProviderFailure::Unauthorized, None)
        );
        let missing_repository = serde_json::to_vec(&json!({
            "data": { "search": { "issueCount": 0, "nodes": [] }, "recent": null }
        }))
        .unwrap();
        assert_eq!(
            parse_github_issue_key_response(&github_repository(), "PAY-42", &missing_repository, 0)
                .unwrap_err(),
            (ProviderFailure::ProviderFailure, None)
        );
        assert_eq!(
            parse_github_issue_key_response(&github_repository(), "PAY-42", b"not json", 0)
                .unwrap_err(),
            (ProviderFailure::MalformedResponse, None)
        );
    }

    #[test]
    fn invalid_key_fails_before_any_provider_command() {
        let github = GitHubClient::new(std::env::temp_dir().join("termloop-never-used"));
        for key in ["pay-42", "PAY-0", "", "PAY-42 OR is:open"] {
            assert_eq!(
                github
                    .issue_key_pull_requests(&github_repository(), key, Duration::from_secs(1))
                    .unwrap_err(),
                ProviderFailure::ProviderFailure
            );
        }
        assert_eq!(github.sequence.load(Ordering::Relaxed), 0);
        assert!(github.discovery.get().is_none());

        let azure = AzureDevOpsClient::new(std::env::temp_dir().join("termloop-never-used"));
        assert_eq!(
            azure
                .issue_keys_pull_requests(
                    &azure_repository(),
                    &["PAY-42;rm".to_owned(), "pay-42".to_owned()],
                    true,
                    Duration::from_secs(1)
                )
                .unwrap(),
            vec![
                Err(ProviderFailure::ProviderFailure),
                Err(ProviderFailure::ProviderFailure)
            ]
        );
        assert_eq!(azure.sequence.load(Ordering::Relaxed), 0);
        assert!(azure.discovery.get().is_none());
    }

    fn azure_repository() -> AzureRepository {
        AzureRepository {
            organization: "contoso".into(),
            project: "Fabrikam".into(),
            name: "Storefront".into(),
        }
    }

    fn azure_row(number: u64, title: &str, source: &str, created: &str) -> Value {
        json!({
            "pullRequestId": number,
            "title": title,
            "status": "active",
            "isDraft": false,
            "sourceRefName": format!("refs/heads/{source}"),
            "targetRefName": "refs/heads/main",
            "mergeStatus": "succeeded",
            "mergeCommitId": null,
            "creationDate": created,
            "closedDate": null,
            "sourceCommitDate": null,
            "repository": { "name": "Storefront", "project": "Fabrikam" },
            "forkSource": { "repository": { "name": null, "project": null } },
            "reviewers": []
        })
    }

    #[test]
    fn azure_lists_all_states_of_the_repository_bounded_to_one_hundred_rows() {
        let arguments = azure_issue_key_arguments(&azure_repository());
        assert!(arguments.windows(2).any(|pair| pair == ["--status", "all"]));
        assert!(arguments.windows(2).any(|pair| pair == ["--top", "100"]));
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--repository", "Storefront"])
        );
        assert!(
            arguments
                .windows(2)
                .any(|pair| pair == ["--organization", "https://dev.azure.com/contoso"])
        );
        assert!(!arguments.iter().any(|argument| argument == "me"));
    }

    #[test]
    fn azure_keeps_rows_naming_the_key_in_branch_or_title_newest_first() {
        let mut abandoned = azure_row(3, "Spike", "users/ada/pay-42", "2026-10-22T10:00:00Z");
        abandoned["status"] = json!("abandoned");
        let bytes = serde_json::to_vec(&json!([
            azure_row(1, "[PAY-42] Fix CORS", "fix-cors", "2026-10-20T10:00:00Z"),
            azure_row(2, "Unrelated", "feature/PAY-420", "2026-10-23T10:00:00Z"),
            abandoned,
            azure_row(4, "XPAY-42 neighbour", "x", "2026-10-24T10:00:00Z"),
        ]))
        .unwrap();
        let list =
            parse_azure_issue_key_pull_requests(azure_repository(), "PAY-42", &bytes).unwrap();
        assert!(!list.truncated);
        assert_eq!(
            list.pull_requests
                .iter()
                .map(|pull_request| pull_request.number)
                .collect::<Vec<_>>(),
            vec![3, 1]
        );
        assert_eq!(list.pull_requests[0].state, PullRequestState::Closed);
        assert_eq!(list.pull_requests[0].head_branch, "users/ada/pay-42");
        assert_eq!(list.pull_requests[1].checks, CheckState::Unsupported);
        assert_eq!(
            list.pull_requests[1].url,
            "https://dev.azure.com/contoso/Fabrikam/_git/Storefront/pullrequest/1"
        );
    }

    #[test]
    fn azure_full_page_overflow_and_malformed_matches_are_truncated() {
        let full_page = (1..=AZURE_ISSUE_KEY_ROWS as u64)
            .map(|number| azure_row(number, "other", "other", "2026-10-21T10:00:00Z"))
            .collect::<Vec<_>>();
        let list = parse_azure_issue_key_pull_requests(
            azure_repository(),
            "PAY-42",
            &serde_json::to_vec(&full_page).unwrap(),
        )
        .unwrap();
        assert!(list.truncated);
        assert!(list.pull_requests.is_empty());

        let over_cap = (1..=MAX_ISSUE_KEY_PULL_REQUESTS as u64 + 1)
            .map(|number| azure_row(number, "PAY-42", "x", "2026-10-21T10:00:00Z"))
            .collect::<Vec<_>>();
        let list = parse_azure_issue_key_pull_requests(
            azure_repository(),
            "PAY-42",
            &serde_json::to_vec(&over_cap).unwrap(),
        )
        .unwrap();
        assert!(list.truncated);
        assert_eq!(list.pull_requests.len(), MAX_ISSUE_KEY_PULL_REQUESTS);

        let mut malformed = azure_row(5, "PAY-42", "x", "2026-10-21T10:00:00Z");
        malformed["status"] = json!("weird");
        let list = parse_azure_issue_key_pull_requests(
            azure_repository(),
            "PAY-42",
            &serde_json::to_vec(&json!([malformed])).unwrap(),
        )
        .unwrap();
        assert!(list.truncated);
        assert!(list.pull_requests.is_empty());
        assert_eq!(
            parse_azure_issue_key_pull_requests(azure_repository(), "PAY-42", b"{}").unwrap_err(),
            ProviderFailure::MalformedResponse
        );
    }
}
