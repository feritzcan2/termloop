//! Who wrote and who reviewed a few exact GitHub pull requests: logins
//! only, for ranking likely owners. One GraphQL call; a pull request the
//! repository does not have is left out.

use super::*;

/// Pull requests one read asks about at most.
pub const MAX_PULL_REQUEST_PEOPLE: usize = 6;
const MAX_REVIEWS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestPeople {
    pub number: u64,
    pub url: String,
    pub author: Option<String>,
    /// When the pull request was opened.
    pub created_at_epoch_ms: u64,
    /// Distinct reviewer logins, first review first, without the author.
    pub reviewers: Vec<String>,
}

impl GitHubClient {
    pub fn pull_request_people(
        &self,
        repository: &GitHubRepository,
        numbers: &[u64],
        timeout: Duration,
    ) -> Result<Vec<PullRequestPeople>, ProviderFailure> {
        if numbers.is_empty() {
            return Ok(Vec::new());
        }
        let body = github_people_body(repository, numbers)?;
        self.check_suppression()?;
        self.ensure_discovered(timeout)?;
        let outcome = termloop_platform::run_command(self.request(timeout)?.stdin(body))
            .map_err(|_| ProviderFailure::ProviderUnavailable)?;
        let result = classify_termination(&outcome.termination, &outcome.stderr).and_then(|()| {
            if outcome.stdout_truncated || outcome.stderr_truncated {
                Err(ProviderFailure::OutputLimit)
            } else {
                parse_github_people(repository, numbers, &outcome.stdout)
            }
        });
        if let Err(failure) = &result {
            self.record_suppression(*failure, None);
        }
        result
    }
}

fn github_people_body(
    repository: &GitHubRepository,
    numbers: &[u64],
) -> Result<Vec<u8>, ProviderFailure> {
    if !valid_slug(&repository.owner)
        || !valid_slug(&repository.name)
        || numbers.len() > MAX_PULL_REQUEST_PEOPLE
        || numbers.contains(&0)
    {
        return Err(ProviderFailure::ProviderFailure);
    }
    let fields = format!(
        "number url createdAt author{{login}} reviews(first:{MAX_REVIEWS}){{nodes{{author{{login}}}}}}"
    );
    let aliases: String = numbers
        .iter()
        .enumerate()
        .map(|(index, number)| format!("p{index}:pullRequest(number:{number}){{{fields}}} "))
        .collect();
    let query = format!(
        "query TermLoopPullRequestPeople($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{aliases}}}}}"
    );
    serde_json::to_vec(&json!({
        "query": query,
        "variables": { "owner": repository.owner, "name": repository.name }
    }))
    .map_err(|_| ProviderFailure::ProviderFailure)
}

fn login(value: Option<&Value>) -> Option<String> {
    let login = value?.get("login")?.as_str()?;
    valid_github_login(login).then(|| login.to_owned())
}

fn parse_github_people(
    repository: &GitHubRepository,
    numbers: &[u64],
    bytes: &[u8],
) -> Result<Vec<PullRequestPeople>, ProviderFailure> {
    let root: Value =
        serde_json::from_slice(bytes).map_err(|_| ProviderFailure::MalformedResponse)?;
    let Some(found) = root
        .pointer("/data/repository")
        .filter(|value| value.is_object())
    else {
        return Err(classify_graphql_errors(root.get("errors"), "repository")
            .unwrap_or(ProviderFailure::MalformedResponse));
    };
    let pulls_url = format!(
        "https://{GITHUB_HOST}/{}/{}/pull/",
        repository.owner, repository.name
    );
    let mut people = Vec::new();
    for (index, number) in numbers.iter().enumerate() {
        let Some(node) = found
            .get(format!("p{index}"))
            .filter(|value| value.is_object())
        else {
            continue;
        };
        let url = format!("{pulls_url}{number}");
        if node.get("number").and_then(Value::as_u64) != Some(*number)
            || !node
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|found| found.eq_ignore_ascii_case(&url))
        {
            return Err(ProviderFailure::MalformedResponse);
        }
        let created_at_epoch_ms = node
            .get("createdAt")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339_epoch_ms)
            .ok_or(ProviderFailure::MalformedResponse)?;
        let author = login(node.get("author"));
        let mut reviewers: Vec<String> = Vec::new();
        for review in node
            .pointer("/reviews/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(reviewer) = login(review.get("author"))
                && Some(&reviewer) != author.as_ref()
                && !reviewers.contains(&reviewer)
            {
                reviewers.push(reviewer);
            }
        }
        people.push(PullRequestPeople {
            number: *number,
            url,
            author,
            created_at_epoch_ms,
            reviewers,
        });
    }
    Ok(people)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository() -> GitHubRepository {
        GitHubRepository {
            owner: "acme".to_owned(),
            name: "pay".to_owned(),
        }
    }

    #[test]
    fn the_body_asks_for_each_number_and_refuses_too_many_or_zero() {
        let body = String::from_utf8(github_people_body(&repository(), &[7, 9]).unwrap()).unwrap();
        assert!(body.contains("p0:pullRequest(number:7)"));
        assert!(body.contains("p1:pullRequest(number:9)"));
        assert!(github_people_body(&repository(), &[0]).is_err());
        assert!(github_people_body(&repository(), &[1, 2, 3, 4, 5, 6, 7]).is_err());
    }

    #[test]
    fn people_are_authors_and_distinct_reviewers_and_missing_pull_requests_drop() {
        let response = json!({ "data": { "repository": {
            "p0": {
                "number": 7, "url": "https://github.com/acme/pay/pull/7",
                "createdAt": "2026-01-02T00:00:00Z",
                "author": { "login": "ada" },
                "reviews": { "nodes": [
                    { "author": { "login": "bo" } },
                    { "author": { "login": "ada" } },
                    { "author": { "login": "bo" } },
                    { "author": null },
                    { "author": { "login": "not a login" } }
                ] }
            },
            "p1": null
        } } });
        let people = parse_github_people(
            &repository(),
            &[7, 9],
            &serde_json::to_vec(&response).unwrap(),
        )
        .unwrap();
        assert_eq!(
            people,
            [PullRequestPeople {
                number: 7,
                url: "https://github.com/acme/pay/pull/7".to_owned(),
                author: Some("ada".to_owned()),
                created_at_epoch_ms: 1_767_312_000_000,
                reviewers: vec!["bo".to_owned()],
            }]
        );
    }

    #[test]
    fn a_pull_request_of_another_repository_or_an_error_is_refused() {
        let other = json!({ "data": { "repository": { "p0": {
            "number": 7, "url": "https://github.com/evil/pay/pull/7", "author": null,
            "createdAt": "2026-01-02T00:00:00Z",
            "reviews": { "nodes": [] }
        } } } });
        assert_eq!(
            parse_github_people(&repository(), &[7], &serde_json::to_vec(&other).unwrap()),
            Err(ProviderFailure::MalformedResponse)
        );
        let denied = json!({ "data": { "repository": null }, "errors": [
            { "type": "FORBIDDEN", "path": ["repository"] }
        ] });
        assert_eq!(
            parse_github_people(&repository(), &[7], &serde_json::to_vec(&denied).unwrap()),
            Err(ProviderFailure::Unauthorized)
        );
    }
}
