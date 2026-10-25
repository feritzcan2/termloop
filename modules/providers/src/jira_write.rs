//! Changes a Project Manager makes to one Jira issue after confirming them:
//! its summary and description, its status (through a workflow transition),
//! and which sprint holds it. Credentials are only borrowed for one request
//! and never logged, stored, or put in an error. Descriptions go
//! through the REST v2 wiki markup Jira imports already carry, so what
//! TermLoop reads back is what it wrote.

use std::io::Read;

use reqwest::StatusCode;
use serde::Deserialize;

use crate::issue_key_pull_requests::valid_issue_key;
use crate::jira::{JiraCloudClient, JiraCredential, normalize_jira_site_base_url};

const JIRA_ISSUE_RESPONSE_MAX_BYTES: u64 = 1024 * 1024;
/// Jira refuses a summary longer than this.
pub const JIRA_SUMMARY_MAX_CHARS: usize = 255;
/// Jira refuses a text field longer than this.
pub const JIRA_DESCRIPTION_MAX_CHARS: usize = 32_767;

/// Transition ids are short decimal numbers; anything else is refused.
const JIRA_TRANSITION_ID_MAX_CHARS: usize = 32;
const JIRA_TRANSITIONS_MAX: usize = 64;

/// One issue's summary and description as Jira holds them now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraIssueText {
    pub key: String,
    pub summary: String,
    /// Jira wiki markup; `None` when the issue has no description.
    pub description: Option<String>,
    /// The workflow status name; `None` when Jira did not send one.
    pub status_name: Option<String>,
    /// The status's category key: `new`, `indeterminate`, or `done`.
    pub status_category: Option<String>,
    /// Jira's `updated` stamp, which moves on every change to the issue.
    pub updated: String,
}

/// One workflow transition Jira offers for an issue right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraTransition {
    /// Jira's decimal transition id.
    pub id: String,
    pub name: String,
    /// The status the issue reaches through this transition.
    pub to_status: String,
    /// Jira's grouping of that status: `new`, `indeterminate`, or `done`.
    pub to_status_category: Option<String>,
}

/// Whether `issue_url` is a browse URL of the Jira site `site_base_url`. A
/// source's credential may only be sent for an issue that passes this, so a
/// credential never reaches another host.
pub fn jira_issue_url_on_site(site_base_url: &str, issue_url: &str) -> bool {
    normalize_jira_site_base_url(site_base_url).is_ok_and(|site| {
        issue_url
            .to_ascii_lowercase()
            .starts_with(&format!("{}/browse/", site.to_ascii_lowercase()))
    })
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JiraWriteError {
    #[error("Jira Cloud site URL or issue key is invalid")]
    InvalidRequest,
    #[error("Jira credentials were rejected")]
    Unauthorized,
    #[error("Jira does not let these credentials change the issue")]
    Forbidden,
    #[error("Jira issue or sprint was not found")]
    NotFound,
    #[error("Jira rejected the change")]
    Rejected,
    #[error("Jira rate limit is active")]
    RateLimited,
    #[error("Jira is unavailable")]
    Unavailable,
    #[error("Jira returned a malformed response")]
    MalformedResponse,
}

pub trait JiraIssueWriter: Send + Sync {
    fn read_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
    ) -> Result<JiraIssueText, JiraWriteError>;

    /// Replaces the issue's summary and description (wiki markup).
    fn update_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
        summary: &str,
        description: &str,
    ) -> Result<(), JiraWriteError>;

    /// Moves the issue into a sprint, or into the backlog without one.
    fn move_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
        sprint_id: Option<u64>,
    ) -> Result<(), JiraWriteError>;

    /// The transitions Jira offers for the issue now, at most 64.
    fn transitions(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
    ) -> Result<Vec<JiraTransition>, JiraWriteError>;

    /// Moves the issue through one offered transition.
    fn transition_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
        transition_id: &str,
    ) -> Result<(), JiraWriteError>;
}

impl JiraIssueWriter for JiraCloudClient {
    fn read_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
    ) -> Result<JiraIssueText, JiraWriteError> {
        let site = issue_site(site_base_url, issue_key)?;
        let response = self
            .http()
            .get(format!(
                "{site}/rest/api/2/issue/{issue_key}?fields=summary,description,status,updated"
            ))
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| JiraWriteError::Unavailable)?;
        let bytes = read_response(response)?;
        decode_issue_text(issue_key, &bytes)
    }

    fn update_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
        summary: &str,
        description: &str,
    ) -> Result<(), JiraWriteError> {
        let site = issue_site(site_base_url, issue_key)?;
        let summary = summary.trim();
        if summary.is_empty()
            || summary.chars().count() > JIRA_SUMMARY_MAX_CHARS
            || summary.contains(['\n', '\r'])
            || description.chars().count() > JIRA_DESCRIPTION_MAX_CHARS
        {
            return Err(JiraWriteError::InvalidRequest);
        }
        let response = self
            .http()
            .put(format!("{site}/rest/api/2/issue/{issue_key}"))
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({
                "fields": { "summary": summary, "description": description }
            }))
            .send()
            .map_err(|_| JiraWriteError::Unavailable)?;
        read_response(response).map(|_| ())
    }

    fn move_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
        sprint_id: Option<u64>,
    ) -> Result<(), JiraWriteError> {
        let site = issue_site(site_base_url, issue_key)?;
        let url = match sprint_id {
            Some(0) => return Err(JiraWriteError::InvalidRequest),
            Some(sprint_id) => format!("{site}/rest/agile/1.0/sprint/{sprint_id}/issue"),
            None => format!("{site}/rest/agile/1.0/backlog/issue"),
        };
        let response = self
            .http()
            .post(url)
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({ "issues": [issue_key] }))
            .send()
            .map_err(|_| JiraWriteError::Unavailable)?;
        read_response(response).map(|_| ())
    }

    fn transitions(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
    ) -> Result<Vec<JiraTransition>, JiraWriteError> {
        let site = issue_site(site_base_url, issue_key)?;
        let response = self
            .http()
            .get(format!("{site}/rest/api/2/issue/{issue_key}/transitions"))
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| JiraWriteError::Unavailable)?;
        decode_transitions(&read_response(response)?)
    }

    fn transition_issue(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        issue_key: &str,
        transition_id: &str,
    ) -> Result<(), JiraWriteError> {
        let site = issue_site(site_base_url, issue_key)?;
        if !valid_transition_id(transition_id) {
            return Err(JiraWriteError::InvalidRequest);
        }
        let response = self
            .http()
            .post(format!("{site}/rest/api/2/issue/{issue_key}/transitions"))
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({ "transition": { "id": transition_id } }))
            .send()
            .map_err(|_| JiraWriteError::Unavailable)?;
        read_response(response).map(|_| ())
    }
}

fn valid_transition_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= JIRA_TRANSITION_ID_MAX_CHARS
        && id.bytes().all(|byte| byte.is_ascii_digit())
}

fn issue_site(site_base_url: &str, issue_key: &str) -> Result<String, JiraWriteError> {
    if !valid_issue_key(issue_key) {
        return Err(JiraWriteError::InvalidRequest);
    }
    normalize_jira_site_base_url(site_base_url).map_err(|_| JiraWriteError::InvalidRequest)
}

fn read_response(response: reqwest::blocking::Response) -> Result<Vec<u8>, JiraWriteError> {
    if let Some(error) = write_status_error(response.status()) {
        return Err(error);
    }
    let mut bytes = Vec::new();
    response
        .take(JIRA_ISSUE_RESPONSE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| JiraWriteError::Unavailable)?;
    if bytes.len() as u64 > JIRA_ISSUE_RESPONSE_MAX_BYTES {
        return Err(JiraWriteError::MalformedResponse);
    }
    Ok(bytes)
}

fn write_status_error(status: StatusCode) -> Option<JiraWriteError> {
    match status {
        StatusCode::UNAUTHORIZED => Some(JiraWriteError::Unauthorized),
        StatusCode::FORBIDDEN => Some(JiraWriteError::Forbidden),
        StatusCode::NOT_FOUND => Some(JiraWriteError::NotFound),
        StatusCode::BAD_REQUEST => Some(JiraWriteError::Rejected),
        StatusCode::TOO_MANY_REQUESTS => Some(JiraWriteError::RateLimited),
        _ if !status.is_success() => Some(JiraWriteError::Unavailable),
        _ => None,
    }
}

#[derive(Deserialize)]
struct IssueResponse {
    key: String,
    fields: IssueFields,
}

#[derive(Deserialize)]
struct IssueFields {
    summary: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<StatusValue>,
    updated: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusValue {
    name: String,
    #[serde(default)]
    status_category: Option<CategoryValue>,
}

#[derive(Deserialize)]
struct TransitionsResponse {
    transitions: Vec<TransitionValue>,
}

#[derive(Deserialize)]
struct TransitionValue {
    id: String,
    name: String,
    to: TransitionTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransitionTarget {
    name: String,
    #[serde(default)]
    status_category: Option<CategoryValue>,
}

#[derive(Deserialize)]
struct CategoryValue {
    key: String,
}

fn known_category(category: CategoryValue) -> Option<String> {
    matches!(category.key.as_str(), "new" | "indeterminate" | "done").then_some(category.key)
}

fn bounded_name(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

/// Offered transitions; a malformed row fails the whole read so a status
/// change is never planned from a partial list.
fn decode_transitions(bytes: &[u8]) -> Result<Vec<JiraTransition>, JiraWriteError> {
    let parsed: TransitionsResponse =
        serde_json::from_slice(bytes).map_err(|_| JiraWriteError::MalformedResponse)?;
    if parsed.transitions.len() > JIRA_TRANSITIONS_MAX {
        return Err(JiraWriteError::MalformedResponse);
    }
    parsed
        .transitions
        .into_iter()
        .map(|transition| {
            Some(JiraTransition {
                id: valid_transition_id(&transition.id).then_some(transition.id)?,
                name: bounded_name(&transition.name)?,
                to_status: bounded_name(&transition.to.name)?,
                to_status_category: transition.to.status_category.and_then(known_category),
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(JiraWriteError::MalformedResponse)
}

fn decode_issue_text(issue_key: &str, bytes: &[u8]) -> Result<JiraIssueText, JiraWriteError> {
    let issue: IssueResponse =
        serde_json::from_slice(bytes).map_err(|_| JiraWriteError::MalformedResponse)?;
    let updated = issue.fields.updated.trim();
    if !issue.key.eq_ignore_ascii_case(issue_key)
        || updated.is_empty()
        || updated.len() > 128
        || updated.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(JiraWriteError::MalformedResponse);
    }
    Ok(JiraIssueText {
        key: issue.key,
        summary: issue.fields.summary.trim().to_owned(),
        description: issue
            .fields
            .description
            .filter(|description| !description.trim().is_empty()),
        status_name: issue
            .fields
            .status
            .as_ref()
            .and_then(|status| bounded_name(&status.name)),
        status_category: issue
            .fields
            .status
            .and_then(|status| status.status_category)
            .and_then(known_category),
        updated: updated.to_owned(),
    })
}

/// Markdown as Jira wiki markup: headings, lists, checklists, quotes, code
/// blocks, rules, and bold, italic, code, and link spans. Anything else
/// passes through as text.
pub fn markdown_to_jira_wiki(markdown: &str) -> String {
    let mut output = Vec::new();
    let mut fence: Option<String> = None;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if let Some(open) = &fence {
            if trimmed.starts_with(open.as_str()) {
                output.push("{code}".to_owned());
                fence = None;
            } else {
                output.push(line.to_owned());
            }
            continue;
        }
        if let Some((marker, info)) = trimmed
            .strip_prefix("```")
            .map(|info| ("```", info))
            .or_else(|| trimmed.strip_prefix("~~~").map(|info| ("~~~", info)))
        {
            let language = info.trim();
            output.push(
                if language.is_empty() || !language.bytes().all(|byte| byte.is_ascii_alphanumeric())
                {
                    "{code}".to_owned()
                } else {
                    format!("{{code:{language}}}")
                },
            );
            fence = Some(marker.to_owned());
            continue;
        }
        output.push(wiki_line(line));
    }
    if fence.is_some() {
        output.push("{code}".to_owned());
    }
    output.join("\n").trim_end().to_owned()
}

fn wiki_line(line: &str) -> String {
    let trimmed = line.trim_start();
    let depth = (line.len() - trimmed.len()) / 2 + 1;
    let hashes = trimmed.bytes().take_while(|byte| *byte == b'#').count();
    if (1..=6).contains(&hashes) && trimmed[hashes..].starts_with(' ') {
        return format!("h{hashes}. {}", wiki_inline(trimmed[hashes..].trim()));
    }
    if matches!(trimmed, "---" | "***" | "___") {
        return "----".to_owned();
    }
    if let Some(quote) = trimmed.strip_prefix("> ") {
        return format!("bq. {}", wiki_inline(quote));
    }
    if let Some(item) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        let item = if let Some(rest) = item.strip_prefix("[ ] ") {
            format!("[ ] {}", wiki_inline(rest))
        } else if let Some(rest) = item
            .strip_prefix("[x] ")
            .or_else(|| item.strip_prefix("[X] "))
        {
            format!("[x] {}", wiki_inline(rest))
        } else {
            wiki_inline(item)
        };
        return format!("{} {item}", "*".repeat(depth));
    }
    let digits = trimmed.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && trimmed[digits..].starts_with(". ") {
        return format!(
            "{} {}",
            "#".repeat(depth),
            wiki_inline(&trimmed[digits + 2..])
        );
    }
    wiki_inline(line)
}

/// Inline Markdown spans as wiki: `**bold**` → `*bold*`, `*it*`/`_it_` →
/// `_it_`, `` `code` `` → `{{code}}`, `[text](url)` → `[text|url]`.
fn wiki_inline(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(character) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix('`')
            && let Some(end) = after.find('`')
        {
            output.push_str(&format!("{{{{{}}}}}", &after[..end]));
            rest = &after[end + 1..];
            continue;
        }
        if let Some(after) = rest.strip_prefix("**")
            && let Some(end) = after.find("**")
            && end > 0
        {
            output.push('*');
            output.push_str(&wiki_inline(&after[..end]));
            output.push('*');
            rest = &after[end + 2..];
            continue;
        }
        if let Some(marker) = ['*', '_']
            .into_iter()
            .find(|marker| rest.starts_with(*marker))
            && let Some(end) = rest[1..].find(marker)
            && end > 0
            && !rest[1..].starts_with(' ')
        {
            output.push('_');
            output.push_str(&wiki_inline(&rest[1..1 + end]));
            output.push('_');
            rest = &rest[end + 2..];
            continue;
        }
        if let Some(after) = rest.strip_prefix('[')
            && let Some(close) = after.find("](")
            && let Some(end) = after[close + 2..].find(')')
        {
            let label = &after[..close];
            let url = &after[close + 2..close + 2 + end];
            output.push_str(&format!("[{}|{url}]", wiki_inline(label)));
            rest = &after[close + 3 + end..];
            continue;
        }
        output.push(character);
        rest = &rest[character.len_utf8()..];
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_markdown_blocks_and_spans_to_wiki() {
        let markdown = "# Goal\nUsers see **a timeout** at `checkout`.\n\n## Acceptance\n- Retries *once*\n  - then [fails](https://example.com/x)\n- [ ] QA signs off\n1. First\n\n> Ask QA\n\n---\n```rust\nlet a = **b**;\n```";
        assert_eq!(
            markdown_to_jira_wiki(markdown),
            "h1. Goal\nUsers see *a timeout* at {{checkout}}.\n\nh2. Acceptance\n* Retries _once_\n** then [fails|https://example.com/x]\n* [ ] QA signs off\n# First\n\nbq. Ask QA\n\n----\n{code:rust}\nlet a = **b**;\n{code}"
        );
        // An unclosed fence still closes, and a lone marker stays text.
        assert_eq!(markdown_to_jira_wiki("```\nx"), "{code}\nx\n{code}");
        assert_eq!(markdown_to_jira_wiki("2 * 3 and a_b"), "2 * 3 and a_b");
    }

    #[test]
    fn decodes_the_issue_and_refuses_another_key() {
        let body = br#"{"key":"PAY-42","fields":{"summary":" Checkout ","description":"h2. Goal","status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}},"updated":"2026-10-20T10:00:00.000+0000"}}"#;
        assert_eq!(
            decode_issue_text("PAY-42", body).unwrap(),
            JiraIssueText {
                key: "PAY-42".into(),
                summary: "Checkout".into(),
                description: Some("h2. Goal".into()),
                status_name: Some("In Progress".into()),
                status_category: Some("indeterminate".into()),
                updated: "2026-10-20T10:00:00.000+0000".into(),
            }
        );
        let empty =
            br#"{"key":"PAY-42","fields":{"summary":"S","description":null,"updated":"u"}}"#;
        assert_eq!(
            decode_issue_text("PAY-42", empty).unwrap().description,
            None
        );
        assert_eq!(
            decode_issue_text("PAY-43", body),
            Err(JiraWriteError::MalformedResponse)
        );
    }

    #[test]
    fn a_credential_goes_only_to_issues_on_its_own_site() {
        let site = "https://Acme.atlassian.net/";
        assert!(jira_issue_url_on_site(
            site,
            "https://acme.atlassian.net/browse/PAY-42"
        ));
        for other in [
            "https://acme.atlassian.net.evil.example/browse/PAY-42",
            "https://evil.example/browse/PAY-42",
            "https://acme.atlassian.net/jira/PAY-42",
            "",
        ] {
            assert!(!jira_issue_url_on_site(site, other), "{other}");
        }
        assert!(!jira_issue_url_on_site(
            "http://acme.atlassian.net",
            "http://acme.atlassian.net/browse/PAY-42"
        ));
    }

    #[test]
    fn decodes_transitions_and_refuses_a_partial_list() {
        let body = br#"{"transitions":[
          {"id":"21","name":"Start","to":{"name":"In Progress","statusCategory":{"key":"indeterminate"}}},
          {"id":"31","name":"Finish","to":{"name":"Done"}}
        ]}"#;
        assert_eq!(
            decode_transitions(body).unwrap(),
            vec![
                JiraTransition {
                    id: "21".into(),
                    name: "Start".into(),
                    to_status: "In Progress".into(),
                    to_status_category: Some("indeterminate".into()),
                },
                JiraTransition {
                    id: "31".into(),
                    name: "Finish".into(),
                    to_status: "Done".into(),
                    to_status_category: None,
                },
            ]
        );
        assert_eq!(
            decode_transitions(
                br#"{"transitions":[{"id":"x1","name":"Start","to":{"name":"In Progress"}}]}"#
            ),
            Err(JiraWriteError::MalformedResponse)
        );
        assert!(!valid_transition_id("../1"));
        assert!(valid_transition_id("11"));
    }

    #[test]
    fn maps_write_statuses() {
        assert_eq!(write_status_error(StatusCode::NO_CONTENT), None);
        assert_eq!(
            write_status_error(StatusCode::FORBIDDEN),
            Some(JiraWriteError::Forbidden)
        );
        assert_eq!(
            write_status_error(StatusCode::UNAUTHORIZED),
            Some(JiraWriteError::Unauthorized)
        );
        assert_eq!(
            write_status_error(StatusCode::BAD_REQUEST),
            Some(JiraWriteError::Rejected)
        );
        assert_eq!(
            write_status_error(StatusCode::BAD_GATEWAY),
            Some(JiraWriteError::Unavailable)
        );
        assert!(matches!(
            issue_site("https://example.atlassian.net", "not a key"),
            Err(JiraWriteError::InvalidRequest)
        ));
    }
}
