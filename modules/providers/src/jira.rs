use std::io::Read;
use std::time::Duration;

use reqwest::StatusCode;
use serde::Deserialize;

const JIRA_SEARCH_LIMIT: usize = 50;
const JIRA_BOARD_PAGE_LIMIT: usize = 50;
const JIRA_BOARD_DISCOVERY_LIMIT: usize = 500;
const JIRA_SELECTED_BOARDS_MAX: usize = 10;
const JIRA_SELECTED_STATUSES_MAX: usize = 100;
const JIRA_STATUS_DISCOVERY_LIMIT: usize = 500;
const JIRA_RESPONSE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const JIRA_BOARD_RESPONSE_MAX_BYTES: u64 = 1024 * 1024;
const JIRA_TEXT_MAX_BYTES: usize = 8_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedJiraIssueRef {
    pub external_ref: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JiraIssueRefError {
    Malformed,
    UnsupportedTransport,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraSearchRequest {
    pub site_base_url: String,
    pub scope: JiraSearchScope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JiraSearchScope {
    Jql(String),
    Boards {
        board_ids: Vec<String>,
        jql: Option<String>,
        status_ids: Vec<String>,
    },
}

#[derive(Clone, Copy)]
pub struct JiraCredential<'a> {
    pub email: &'a str,
    pub api_token: &'a str,
}

impl std::fmt::Debug for JiraCredential<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JiraCredential(<redacted>)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraIssueSnapshot {
    pub external_id: String,
    pub key: String,
    pub url: String,
    pub summary: String,
    pub description: Option<String>,
    pub status_name: String,
    pub assignee_display: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraSearchResult {
    pub issues: Vec<JiraIssueSnapshot>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraBoard {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub location_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraBoardListResult {
    pub boards: Vec<JiraBoard>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraStatus {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraStatusListResult {
    pub statuses: Vec<JiraStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum JiraSearchError {
    #[error("Jira Cloud site URL is invalid")]
    InvalidSite,
    #[error("Jira credentials were rejected")]
    Unauthorized,
    #[error("Jira issue scope is invalid")]
    ScopeInvalid,
    #[error("Jira rate limit is active")]
    RateLimited { retry_after_seconds: Option<u64> },
    #[error("Jira is unavailable")]
    Unavailable,
    #[error("Jira returned too much data")]
    ResponseTooLarge,
    #[error("Jira returned a malformed response")]
    MalformedResponse,
}

pub trait JiraIssueSource: Send + Sync {
    fn search(
        &self,
        request: &JiraSearchRequest,
        credential: JiraCredential<'_>,
    ) -> Result<JiraSearchResult, JiraSearchError>;
}

pub trait JiraBoardSource: Send + Sync {
    fn list_boards(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        board_id: Option<&str>,
    ) -> Result<JiraBoardListResult, JiraSearchError>;

    fn list_statuses(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        board_ids: &[String],
    ) -> Result<JiraStatusListResult, JiraSearchError>;
}

#[derive(Clone)]
pub struct JiraCloudClient {
    client: reqwest::blocking::Client,
}

impl JiraCloudClient {
    pub fn new() -> Result<Self, JiraSearchError> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("TermLoop-Task-Sources/1")
            .build()
            .map_err(|_| JiraSearchError::Unavailable)?;
        Ok(Self { client })
    }
}

impl JiraIssueSource for JiraCloudClient {
    fn search(
        &self,
        request: &JiraSearchRequest,
        credential: JiraCredential<'_>,
    ) -> Result<JiraSearchResult, JiraSearchError> {
        let site = normalize_jira_site_base_url(&request.site_base_url)?;
        match &request.scope {
            JiraSearchScope::Jql(jql) => {
                validate_jql(jql)?;
                let response = self
                    .client
                    .post(format!("{site}/rest/api/3/search/jql"))
                    .basic_auth(credential.email, Some(credential.api_token))
                    .header(reqwest::header::ACCEPT, "application/json")
                    .json(&serde_json::json!({
                        "jql": jql,
                        "maxResults": JIRA_SEARCH_LIMIT,
                        "fields": ["summary", "description", "status", "assignee", "updated"]
                    }))
                    .send()
                    .map_err(|_| JiraSearchError::Unavailable)?;
                decode_search_response(site.as_str(), response)
            }
            JiraSearchScope::Boards {
                board_ids,
                jql,
                status_ids,
            } => {
                if board_ids.is_empty()
                    || board_ids.len() > JIRA_SELECTED_BOARDS_MAX
                    || board_ids.iter().any(|board_id| !valid_board_id(board_id))
                    || board_ids
                        .iter()
                        .enumerate()
                        .any(|(index, board_id)| board_ids[index + 1..].contains(board_id))
                {
                    return Err(JiraSearchError::ScopeInvalid);
                }
                if let Some(jql) = jql {
                    validate_jql(jql)?;
                }
                let mut issues = Vec::new();
                let mut issue_ids = std::collections::HashSet::new();
                let mut truncated = false;
                for board_id in board_ids {
                    let response = self
                        .client
                        .get(board_issue_url(
                            &site,
                            board_id,
                            jql.as_deref(),
                            status_ids,
                        )?)
                        .basic_auth(credential.email, Some(credential.api_token))
                        .header(reqwest::header::ACCEPT, "application/json")
                        .send()
                        .map_err(|_| JiraSearchError::Unavailable)?;
                    let result = decode_search_response(site.as_str(), response)?;
                    merge_board_result(&mut issues, &mut issue_ids, &mut truncated, result);
                }
                Ok(JiraSearchResult { issues, truncated })
            }
        }
    }
}

fn merge_board_result(
    issues: &mut Vec<JiraIssueSnapshot>,
    issue_ids: &mut std::collections::HashSet<String>,
    truncated: &mut bool,
    result: JiraSearchResult,
) {
    *truncated |= result.truncated;
    for issue in result.issues {
        if !issue_ids.insert(issue.external_id.clone()) {
            continue;
        }
        if issues.len() == JIRA_SEARCH_LIMIT {
            *truncated = true;
            continue;
        }
        issues.push(issue);
    }
}

fn validate_jql(jql: &str) -> Result<(), JiraSearchError> {
    if jql.trim().is_empty() || jql.len() > 4_096 {
        return Err(JiraSearchError::ScopeInvalid);
    }
    Ok(())
}

fn board_issue_url(
    site: &str,
    board_id: &str,
    jql: Option<&str>,
    status_ids: &[String],
) -> Result<reqwest::Url, JiraSearchError> {
    let mut url = reqwest::Url::parse(&format!("{site}/rest/agile/1.0/board/{board_id}/issue"))
        .map_err(|_| JiraSearchError::InvalidSite)?;
    let mut query = url.query_pairs_mut();
    query
        .append_pair("maxResults", &JIRA_SEARCH_LIMIT.to_string())
        .append_pair("fields", "summary,description,status,assignee,updated");
    if let Some(jql) = combined_board_jql(jql, status_ids)? {
        query.append_pair("jql", &jql);
    }
    drop(query);
    Ok(url)
}

impl JiraBoardSource for JiraCloudClient {
    fn list_boards(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        board_id: Option<&str>,
    ) -> Result<JiraBoardListResult, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        if let Some(board_id) = board_id {
            if !valid_board_id(board_id) {
                return Err(JiraSearchError::ScopeInvalid);
            }
            let response = self
                .client
                .get(format!("{site}/rest/agile/1.0/board/{board_id}"))
                .basic_auth(credential.email, Some(credential.api_token))
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|_| JiraSearchError::Unavailable)?;
            return decode_board_value_response(response).map(|board| JiraBoardListResult {
                boards: vec![board],
                truncated: false,
            });
        }

        let mut start_at = 0usize;
        let mut boards = Vec::new();
        let mut board_ids = std::collections::HashSet::new();
        let mut truncated = false;
        loop {
            let response = self
                .client
                .get(format!(
                    "{site}/rest/agile/1.0/board?startAt={start_at}&maxResults={JIRA_BOARD_PAGE_LIMIT}&orderBy=name"
                ))
                .basic_auth(credential.email, Some(credential.api_token))
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|_| JiraSearchError::Unavailable)?;
            let page = decode_board_page_response(response)?;
            truncated |= page.partial;
            for board in page.boards {
                if !board_ids.insert(board.id.clone()) {
                    // The paginated collection can move while Jira serves it.
                    // Keep the stable ID once and surface that the observation
                    // was partial instead of blanking every visible board.
                    truncated = true;
                    continue;
                }
                if boards.len() == JIRA_BOARD_DISCOVERY_LIMIT {
                    truncated = true;
                    break;
                }
                boards.push(board);
            }

            let next_start = start_at.saturating_add(page.returned);
            let complete = page.returned == 0
                || page.is_last == Some(true)
                || page.total.is_some_and(|total| next_start >= total);
            if complete {
                break;
            }
            if boards.len() == JIRA_BOARD_DISCOVERY_LIMIT || next_start <= start_at {
                truncated = true;
                break;
            }
            start_at = next_start;
        }
        sort_boards(&mut boards);
        Ok(JiraBoardListResult { boards, truncated })
    }

    fn list_statuses(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        board_ids: &[String],
    ) -> Result<JiraStatusListResult, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        validate_numeric_ids(board_ids, JIRA_SELECTED_BOARDS_MAX)?;
        let mut selected_ids = std::collections::HashSet::new();
        for board_id in board_ids {
            let response = self
                .client
                .get(format!(
                    "{site}/rest/agile/1.0/board/{board_id}/configuration"
                ))
                .basic_auth(credential.email, Some(credential.api_token))
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .map_err(|_| JiraSearchError::Unavailable)?;
            selected_ids.extend(decode_board_status_ids_response(response)?);
            if selected_ids.len() > JIRA_STATUS_DISCOVERY_LIMIT {
                return Err(JiraSearchError::ResponseTooLarge);
            }
        }
        let response = self
            .client
            .get(format!("{site}/rest/api/3/status"))
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| JiraSearchError::Unavailable)?;
        let bytes = read_board_response(response)?;
        decode_status_catalog_bytes(&bytes, &selected_ids)
    }
}

fn validate_numeric_ids(ids: &[String], maximum: usize) -> Result<(), JiraSearchError> {
    if ids.is_empty()
        || ids.len() > maximum
        || ids.iter().any(|id| !valid_board_id(id))
        || ids
            .iter()
            .enumerate()
            .any(|(index, id)| ids[index + 1..].contains(id))
    {
        return Err(JiraSearchError::ScopeInvalid);
    }
    Ok(())
}

fn combined_board_jql(
    jql: Option<&str>,
    status_ids: &[String],
) -> Result<Option<String>, JiraSearchError> {
    if status_ids.is_empty() {
        return Ok(jql.map(str::to_owned));
    }
    validate_numeric_ids(status_ids, JIRA_SELECTED_STATUSES_MAX)?;
    let status_filter = format!("status in ({})", status_ids.join(", "));
    let Some(jql) = jql else {
        return Ok(Some(status_filter));
    };
    let (predicate, ordering) = split_top_level_order_by(jql);
    let ordering = if ordering.is_empty() {
        String::new()
    } else {
        format!(" {ordering}")
    };
    let combined = if predicate.trim().is_empty() {
        format!("{status_filter}{ordering}")
    } else {
        format!("({}) AND {status_filter}{ordering}", predicate.trim())
    };
    Ok(Some(combined))
}

fn split_top_level_order_by(jql: &str) -> (&str, &str) {
    let bytes = jql.as_bytes();
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        match byte {
            b'\'' | b'"' => quote = Some(byte),
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            _ if depth == 0 && order_by_starts_at(jql, index) => {
                return (&jql[..index], &jql[index..]);
            }
            _ => {}
        }
        index += 1;
    }
    (jql, "")
}

fn order_by_starts_at(jql: &str, index: usize) -> bool {
    let bytes = jql.as_bytes();
    bytes.len().saturating_sub(index) >= 8
        && bytes[index..index + 8].eq_ignore_ascii_case(b"ORDER BY")
        && (index == 0 || jql.as_bytes()[index - 1].is_ascii_whitespace())
        && bytes
            .get(index + 8)
            .is_none_or(|byte| byte.is_ascii_whitespace())
}

pub fn normalize_jira_site_base_url(value: &str) -> Result<String, JiraSearchError> {
    let parsed = reqwest::Url::parse(value).map_err(|_| JiraSearchError::InvalidSite)?;
    let host = parsed.host_str().ok_or(JiraSearchError::InvalidSite)?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || !parsed.path().trim_matches('/').is_empty()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !host.to_ascii_lowercase().ends_with(".atlassian.net")
        || host.len() <= ".atlassian.net".len()
    {
        return Err(JiraSearchError::InvalidSite);
    }
    Ok(format!("https://{}", host.to_ascii_lowercase()))
}

fn decode_search_response(
    site: &str,
    response: reqwest::blocking::Response,
) -> Result<JiraSearchResult, JiraSearchError> {
    let status = response.status();
    let retry_after_seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(error) = search_status_error(status, retry_after_seconds) {
        return Err(error);
    }
    if response
        .content_length()
        .is_some_and(|length| length > JIRA_RESPONSE_MAX_BYTES)
    {
        return Err(JiraSearchError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    response
        .take(JIRA_RESPONSE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| JiraSearchError::Unavailable)?;
    if bytes.len() as u64 > JIRA_RESPONSE_MAX_BYTES {
        return Err(JiraSearchError::ResponseTooLarge);
    }
    decode_search_bytes(site, &bytes)
}

fn search_status_error(
    status: StatusCode,
    retry_after_seconds: Option<u64>,
) -> Option<JiraSearchError> {
    match status {
        StatusCode::UNAUTHORIZED => Some(JiraSearchError::Unauthorized),
        StatusCode::FORBIDDEN | StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND => {
            Some(JiraSearchError::ScopeInvalid)
        }
        StatusCode::TOO_MANY_REQUESTS => Some(JiraSearchError::RateLimited {
            retry_after_seconds,
        }),
        _ if !status.is_success() => Some(JiraSearchError::Unavailable),
        _ => None,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardListResponse {
    #[serde(default)]
    values: Vec<serde_json::Value>,
    #[serde(default)]
    total: Option<usize>,
    #[serde(default)]
    is_last: Option<bool>,
}

#[derive(Deserialize)]
struct BoardValue {
    id: u64,
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    location: Option<BoardLocation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardLocation {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardConfigurationValue {
    column_config: BoardColumnConfigValue,
}

#[derive(Deserialize)]
struct BoardColumnConfigValue {
    #[serde(default)]
    columns: Vec<BoardColumnValue>,
}

#[derive(Deserialize)]
struct BoardColumnValue {
    #[serde(default)]
    statuses: Vec<BoardStatusRefValue>,
}

#[derive(Deserialize)]
struct BoardStatusRefValue {
    id: String,
}

#[derive(Deserialize)]
struct StatusValue {
    id: String,
    name: String,
}

fn read_board_response(response: reqwest::blocking::Response) -> Result<Vec<u8>, JiraSearchError> {
    let status = response.status();
    let retry_after_seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(error) = search_status_error(status, retry_after_seconds) {
        return Err(error);
    }
    if response
        .content_length()
        .is_some_and(|length| length > JIRA_BOARD_RESPONSE_MAX_BYTES)
    {
        return Err(JiraSearchError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    response
        .take(JIRA_BOARD_RESPONSE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| JiraSearchError::Unavailable)?;
    if bytes.len() as u64 > JIRA_BOARD_RESPONSE_MAX_BYTES {
        return Err(JiraSearchError::ResponseTooLarge);
    }
    Ok(bytes)
}

fn decode_board_page_response(
    response: reqwest::blocking::Response,
) -> Result<BoardPage, JiraSearchError> {
    let bytes = read_board_response(response)?;
    decode_board_page_bytes(&bytes)
}

fn decode_board_value_response(
    response: reqwest::blocking::Response,
) -> Result<JiraBoard, JiraSearchError> {
    let bytes = read_board_response(response)?;
    decode_board_value_bytes(&bytes)
}

fn decode_board_status_ids_response(
    response: reqwest::blocking::Response,
) -> Result<Vec<String>, JiraSearchError> {
    let bytes = read_board_response(response)?;
    decode_board_status_ids_bytes(&bytes)
}

fn decode_board_status_ids_bytes(bytes: &[u8]) -> Result<Vec<String>, JiraSearchError> {
    let parsed = serde_json::from_slice::<BoardConfigurationValue>(bytes)
        .map_err(|_| JiraSearchError::MalformedResponse)?;
    let mut ids = std::collections::HashSet::new();
    for status in parsed
        .column_config
        .columns
        .into_iter()
        .flat_map(|column| column.statuses)
    {
        if !valid_board_id(&status.id) {
            return Err(JiraSearchError::MalformedResponse);
        }
        ids.insert(status.id);
    }
    let mut ids = ids.into_iter().collect::<Vec<_>>();
    ids.sort_unstable();
    Ok(ids)
}

fn decode_status_catalog_bytes(
    bytes: &[u8],
    selected_ids: &std::collections::HashSet<String>,
) -> Result<JiraStatusListResult, JiraSearchError> {
    let parsed = serde_json::from_slice::<Vec<StatusValue>>(bytes)
        .map_err(|_| JiraSearchError::MalformedResponse)?;
    let mut seen = std::collections::HashSet::new();
    let mut statuses = Vec::new();
    for status in parsed {
        if !selected_ids.contains(&status.id) {
            continue;
        }
        let name = status.name.trim();
        if !valid_board_id(&status.id)
            || name.is_empty()
            || name.len() > 256
            || name.bytes().any(|byte| byte.is_ascii_control())
            || !seen.insert(status.id.clone())
        {
            return Err(JiraSearchError::MalformedResponse);
        }
        statuses.push(JiraStatus {
            id: status.id,
            name: name.to_owned(),
        });
        if statuses.len() > JIRA_STATUS_DISCOVERY_LIMIT {
            return Err(JiraSearchError::ResponseTooLarge);
        }
    }
    statuses.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(JiraStatusListResult { statuses })
}

fn decode_board_value_bytes(bytes: &[u8]) -> Result<JiraBoard, JiraSearchError> {
    let value = serde_json::from_slice::<BoardValue>(bytes)
        .map_err(|_| JiraSearchError::MalformedResponse)?;
    validated_board(value).ok_or(JiraSearchError::MalformedResponse)
}

#[derive(Debug)]
struct BoardPage {
    boards: Vec<JiraBoard>,
    returned: usize,
    total: Option<usize>,
    is_last: Option<bool>,
    partial: bool,
}

fn decode_board_page_bytes(bytes: &[u8]) -> Result<BoardPage, JiraSearchError> {
    let parsed: BoardListResponse =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    let returned = parsed.values.len();
    let mut partial = returned > JIRA_BOARD_PAGE_LIMIT;
    let mut board_ids = std::collections::HashSet::new();
    let mut boards = Vec::with_capacity(returned.min(JIRA_BOARD_PAGE_LIMIT));
    for value in parsed.values.into_iter().take(JIRA_BOARD_PAGE_LIMIT) {
        let Ok(board) = serde_json::from_value::<BoardValue>(value) else {
            partial = true;
            continue;
        };
        let Some(board) = validated_board(board) else {
            partial = true;
            continue;
        };
        if !board_ids.insert(board.id.clone()) {
            return Err(JiraSearchError::MalformedResponse);
        }
        boards.push(board);
    }
    Ok(BoardPage {
        boards,
        returned,
        total: parsed.total,
        is_last: parsed.is_last,
        partial,
    })
}

#[cfg(test)]
fn decode_board_bytes(bytes: &[u8]) -> Result<JiraBoardListResult, JiraSearchError> {
    let page = decode_board_page_bytes(bytes)?;
    let mut boards = page.boards;
    sort_boards(&mut boards);
    Ok(JiraBoardListResult {
        boards,
        truncated: page.partial
            || page.is_last == Some(false)
            || page.total.is_some_and(|total| total > page.returned),
    })
}

fn validated_board(board: BoardValue) -> Option<JiraBoard> {
    let id = board.id.to_string();
    let name = board.name.trim();
    let kind = board.kind.trim();
    if !valid_board_id(&id)
        || name.is_empty()
        || name.len() > 256
        || name.bytes().any(|byte| byte.is_ascii_control())
        || kind.is_empty()
        || kind.len() > 32
        || kind.bytes().any(|byte| byte.is_ascii_control())
    {
        return None;
    }
    let location_name = board.location.and_then(|location| {
        location
            .display_name
            .or(location.name)
            .map(|value| truncate_utf8(value.trim(), 256))
            .filter(|value| !value.is_empty())
    });
    Some(JiraBoard {
        id,
        name: name.to_owned(),
        kind: kind.to_owned(),
        location_name,
    })
}

fn sort_boards(boards: &mut [JiraBoard]) {
    boards.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn valid_board_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && value.as_bytes()[0] != b'0'
        && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    #[serde(default)]
    issues: Vec<serde_json::Value>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    is_last: Option<bool>,
}

#[derive(Deserialize)]
struct SearchIssue {
    id: String,
    key: String,
    fields: SearchFields,
}

#[derive(Deserialize)]
struct SearchFields {
    summary: String,
    #[serde(default)]
    description: Option<serde_json::Value>,
    status: NamedField,
    #[serde(default)]
    assignee: Option<AssigneeField>,
    updated: String,
}

#[derive(Deserialize)]
struct NamedField {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssigneeField {
    display_name: String,
}

fn decode_search_bytes(site: &str, bytes: &[u8]) -> Result<JiraSearchResult, JiraSearchError> {
    let parsed: SearchResponse =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    let mut truncated = parsed.issues.len() > JIRA_SEARCH_LIMIT
        || parsed.next_page_token.is_some()
        || parsed.is_last == Some(false);
    let mut issues = Vec::with_capacity(parsed.issues.len().min(JIRA_SEARCH_LIMIT));
    let mut external_ids = std::collections::HashSet::new();
    let mut issue_keys = std::collections::HashSet::new();
    for value in parsed.issues.into_iter().take(JIRA_SEARCH_LIMIT) {
        let Ok(issue) = serde_json::from_value::<SearchIssue>(value) else {
            truncated = true;
            continue;
        };
        let Some(issue) = decode_search_issue(site, issue) else {
            truncated = true;
            continue;
        };
        if !external_ids.insert(issue.external_id.clone()) {
            return Err(JiraSearchError::MalformedResponse);
        }
        if !issue_keys.insert(issue.key.to_ascii_lowercase()) {
            truncated = true;
            continue;
        }
        issues.push(issue);
    }
    Ok(JiraSearchResult { issues, truncated })
}

fn decode_search_issue(site: &str, issue: SearchIssue) -> Option<JiraIssueSnapshot> {
    if issue.id.is_empty()
        || issue.id.len() > 64
        || !issue.id.bytes().all(|byte| byte.is_ascii_digit())
        || !valid_issue_key(&issue.key)
        || issue.fields.summary.trim().is_empty()
        || issue.fields.summary.len() > JIRA_TEXT_MAX_BYTES
        || issue.fields.status.name.trim().is_empty()
        || issue.fields.status.name.len() > 256
        || issue.fields.updated.trim().is_empty()
        || issue.fields.updated.len() > 128
        || issue
            .fields
            .updated
            .bytes()
            .any(|byte| byte.is_ascii_control())
    {
        return None;
    }
    Some(JiraIssueSnapshot {
        external_id: issue.id,
        url: format!("{site}/browse/{}", issue.key),
        key: issue.key,
        summary: truncate_utf8(issue.fields.summary.trim(), JIRA_TEXT_MAX_BYTES),
        description: issue
            .fields
            .description
            .as_ref()
            .and_then(adf_plain_text)
            .filter(|value| !value.is_empty()),
        status_name: truncate_utf8(issue.fields.status.name.trim(), 256),
        assignee_display: issue
            .fields
            .assignee
            .map(|assignee| truncate_utf8(assignee.display_name.trim(), 256))
            .filter(|value| !value.is_empty()),
        updated_at: issue.fields.updated.trim().to_owned(),
    })
}

fn adf_plain_text(value: &serde_json::Value) -> Option<String> {
    fn visit(value: &serde_json::Value, output: &mut String) {
        if output.len() >= JIRA_TEXT_MAX_BYTES {
            return;
        }
        if let Some(text) = value.get("text").and_then(serde_json::Value::as_str) {
            if !output.is_empty() && !output.ends_with(' ') && !output.ends_with('\n') {
                output.push(' ');
            }
            output.push_str(&truncate_utf8(text, JIRA_TEXT_MAX_BYTES - output.len()));
        }
        if let Some(children) = value.get("content").and_then(serde_json::Value::as_array) {
            for child in children {
                visit(child, output);
                if output.len() >= JIRA_TEXT_MAX_BYTES {
                    break;
                }
            }
        }
    }
    let mut output = String::new();
    visit(value, &mut output);
    let output = output.trim().to_owned();
    (!output.is_empty()).then_some(output)
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// Accepts only an exact HTTPS Jira browse URL. This deliberately rejects
/// query strings, fragments, credentials, and fuzzy title/key input so callers
/// can persist only one clearly identified issue without leaking URL secrets.
pub fn normalize_jira_issue_url(value: &str) -> Result<NormalizedJiraIssueRef, JiraIssueRefError> {
    if value.len() > 2_048
        || value.bytes().any(|byte| byte.is_ascii_control())
        || value.contains(['?', '#'])
    {
        return Err(JiraIssueRefError::Malformed);
    }
    let rest = value
        .strip_prefix("https://")
        .ok_or(JiraIssueRefError::UnsupportedTransport)?;
    let (authority, path) = rest.split_once('/').ok_or(JiraIssueRefError::Malformed)?;
    if authority.is_empty()
        || authority.contains('@')
        || !authority.is_ascii()
        || !authority
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        || !authority
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !authority
            .bytes()
            .next_back()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(JiraIssueRefError::Malformed);
    }
    let path = path.strip_suffix('/').unwrap_or(path);
    let mut segments = path.split('/');
    if segments.next() != Some("browse") {
        return Err(JiraIssueRefError::Malformed);
    }
    let issue_key = segments.next().ok_or(JiraIssueRefError::Malformed)?;
    if segments.next().is_some() || !valid_issue_key(issue_key) {
        return Err(JiraIssueRefError::Malformed);
    }
    Ok(NormalizedJiraIssueRef {
        external_ref: issue_key.to_owned(),
        url: format!(
            "https://{}/browse/{issue_key}",
            authority.to_ascii_lowercase()
        ),
    })
}

fn valid_issue_key(value: &str) -> bool {
    let Some((project, number)) = value.rsplit_once('-') else {
        return false;
    };
    !project.is_empty()
        && project.len() <= 64
        && project.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphabetic() || (index > 0 && (byte.is_ascii_digit() || byte == b'_'))
        })
        && !number.is_empty()
        && number.len() <= 20
        && number.bytes().all(|byte| byte.is_ascii_digit())
        && number != "0"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_exact_https_browse_urls() {
        assert_eq!(
            normalize_jira_issue_url("https://Example.atlassian.net/browse/term_2-42/").unwrap(),
            NormalizedJiraIssueRef {
                external_ref: "term_2-42".into(),
                url: "https://example.atlassian.net/browse/term_2-42".into(),
            }
        );
    }

    #[test]
    fn rejects_fuzzy_or_secret_bearing_references() {
        for value in [
            "TERM-42",
            "http://example.atlassian.net/browse/TERM-42",
            "https://user@example.atlassian.net/browse/TERM-42",
            "https://example.atlassian.net\\evil/browse/TERM-42",
            "https://example.atlassian.net/issues/TERM-42",
            "https://example.atlassian.net/browse/TERM-42?token=secret",
            "https://example.atlassian.net/browse/TERM-42#comment",
            " https://example.atlassian.net/browse/TERM-42",
            "https://example.atlassian.net/browse/TERM-42//",
        ] {
            assert!(normalize_jira_issue_url(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn accepts_only_jira_cloud_origins() {
        assert_eq!(
            normalize_jira_site_base_url("https://Example.atlassian.net/").unwrap(),
            "https://example.atlassian.net"
        );
        for value in [
            "http://example.atlassian.net",
            "https://example.atlassian.net/path",
            "https://user@example.atlassian.net",
            "https://localhost",
            "https://atlassian.net",
        ] {
            assert!(
                normalize_jira_site_base_url(value).is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn board_issue_url_applies_the_issue_scope_as_a_separate_jql_filter() {
        let url = board_issue_url(
            "https://example.atlassian.net",
            "84",
            Some("assignee = currentUser() ORDER BY updated DESC"),
            &["10000".into(), "5".into()],
        )
        .unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(url.path(), "/rest/agile/1.0/board/84/issue");
        assert_eq!(
            query.get("maxResults").map(|value| value.as_ref()),
            Some("50")
        );
        assert_eq!(
            query.get("jql").map(|value| value.as_ref()),
            Some("(assignee = currentUser()) AND status in (10000, 5) ORDER BY updated DESC")
        );
    }

    #[test]
    fn status_filter_preserves_boolean_scope_and_top_level_ordering() {
        assert_eq!(
            combined_board_jql(
                Some("project = UKIE OR summary ~ 'ORDER BY car' ORDER BY updated DESC"),
                &["1".into(), "3".into()],
            )
            .unwrap()
            .as_deref(),
            Some(
                "(project = UKIE OR summary ~ 'ORDER BY car') AND status in (1, 3) ORDER BY updated DESC"
            )
        );
    }

    #[test]
    fn discovers_only_statuses_used_by_selected_board_columns() {
        let ids = decode_board_status_ids_bytes(
            br#"{"columnConfig":{"columns":[
              {"name":"To Do","statuses":[{"id":"1"},{"id":"4"}]},
              {"name":"In progress","statuses":[{"id":"3"},{"id":"4"}]}
            ]}}"#,
        )
        .unwrap();
        assert_eq!(ids, vec!["1", "3", "4"]);
        let selected = ids.into_iter().collect();
        let result = decode_status_catalog_bytes(
            br#"[
              {"id":"3","name":"In Progress"},
              {"id":"9","name":"Unrelated"},
              {"id":"4","name":"Ready for Development"},
              {"id":"1","name":"Open"}
            ]"#,
            &selected,
        )
        .unwrap();
        assert_eq!(
            result.statuses,
            vec![
                JiraStatus {
                    id: "3".into(),
                    name: "In Progress".into()
                },
                JiraStatus {
                    id: "1".into(),
                    name: "Open".into()
                },
                JiraStatus {
                    id: "4".into(),
                    name: "Ready for Development".into()
                },
            ]
        );
    }

    #[test]
    fn multi_board_results_are_unioned_by_stable_issue_id_and_bounded() {
        let issue = |external_id: usize, key: &str| JiraIssueSnapshot {
            external_id: external_id.to_string(),
            key: key.into(),
            url: format!("https://example.atlassian.net/browse/{key}"),
            summary: key.into(),
            description: None,
            status_name: "Open".into(),
            assignee_display: None,
            updated_at: "2026-08-26T10:00:00.000+0000".into(),
        };
        let mut issues = vec![];
        let mut issue_ids = std::collections::HashSet::new();
        let mut truncated = false;
        merge_board_result(
            &mut issues,
            &mut issue_ids,
            &mut truncated,
            JiraSearchResult {
                issues: (1..=40).map(|id| issue(id, &format!("ONE-{id}"))).collect(),
                truncated: false,
            },
        );
        merge_board_result(
            &mut issues,
            &mut issue_ids,
            &mut truncated,
            JiraSearchResult {
                issues: (31..=60)
                    .map(|id| issue(id, &format!("TWO-{id}")))
                    .collect(),
                truncated: false,
            },
        );
        assert_eq!(issues.len(), JIRA_SEARCH_LIMIT);
        assert_eq!(
            issues
                .iter()
                .filter(|issue| issue.external_id == "31")
                .count(),
            1
        );
        assert!(truncated);
    }

    #[test]
    fn decodes_bounded_issue_search_snapshot() {
        let result = decode_search_bytes(
            "https://example.atlassian.net",
            br#"{
              "issues":[{"id":"10042","key":"TERM-42","fields":{
                "summary":"Ship Task Sources","description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Inbound Jira work"}]}]},
                "status":{"name":"In Progress"},"assignee":{"displayName":"Ada"},"updated":"2026-08-25T12:00:00.000+0000"
              }}],"isLast":false,"nextPageToken":"next"
            }"#,
        )
        .unwrap();
        assert!(result.truncated);
        assert_eq!(result.issues[0].external_id, "10042");
        assert_eq!(
            result.issues[0].description.as_deref(),
            Some("Inbound Jira work")
        );
        assert_eq!(
            result.issues[0].url,
            "https://example.atlassian.net/browse/TERM-42"
        );
    }

    #[test]
    fn maps_auth_scope_rate_limit_and_offline_statuses() {
        assert_eq!(
            search_status_error(StatusCode::UNAUTHORIZED, None),
            Some(JiraSearchError::Unauthorized)
        );
        assert_eq!(
            search_status_error(StatusCode::BAD_REQUEST, None),
            Some(JiraSearchError::ScopeInvalid)
        );
        assert_eq!(
            search_status_error(StatusCode::FORBIDDEN, None),
            Some(JiraSearchError::ScopeInvalid)
        );
        assert_eq!(
            search_status_error(StatusCode::TOO_MANY_REQUESTS, Some(45)),
            Some(JiraSearchError::RateLimited {
                retry_after_seconds: Some(45),
            })
        );
        assert_eq!(
            search_status_error(StatusCode::SERVICE_UNAVAILABLE, None),
            Some(JiraSearchError::Unavailable)
        );
        assert_eq!(search_status_error(StatusCode::OK, None), None);
    }

    #[test]
    fn decodes_visible_boards_with_bounded_partial_results() {
        let result = decode_board_bytes(
            br#"{
              "total":4,"isLast":false,"values":[
                {"id":84,"name":"Payments","type":"scrum","location":{"displayName":"Money"}},
                {"id":17,"name":"Platform","type":"kanban","location":{"name":"Core"}},
                {"id":0,"name":"Invalid","type":"scrum"}
              ]
            }"#,
        )
        .unwrap();
        assert!(result.truncated);
        assert_eq!(result.boards.len(), 2);
        assert_eq!(result.boards[0].id, "84");
        assert_eq!(result.boards[0].location_name.as_deref(), Some("Money"));
        assert_eq!(result.boards[1].kind, "kanban");
    }

    #[test]
    fn decodes_an_exact_visible_board_for_url_or_id_lookup() {
        let board = decode_board_value_bytes(
            br#"{
              "id":310,"name":"UK & IE Flow Next","type":"scrum",
              "location":{"displayName":"UK & IE Flow Next (UKIE)"}
            }"#,
        )
        .unwrap();
        assert_eq!(board.id, "310");
        assert_eq!(board.name, "UK & IE Flow Next");
        assert_eq!(
            board.location_name.as_deref(),
            Some("UK & IE Flow Next (UKIE)")
        );
    }

    #[test]
    fn board_page_decoder_preserves_pagination_progress() {
        let page = decode_board_page_bytes(
            br#"{
              "startAt":50,"maxResults":50,"total":137,"isLast":false,
              "values":[{"id":310,"name":"UK & IE Flow Next","type":"scrum"}]
            }"#,
        )
        .unwrap();
        assert_eq!(page.returned, 1);
        assert_eq!(page.total, Some(137));
        assert_eq!(page.is_last, Some(false));
        assert_eq!(page.boards[0].id, "310");
    }

    #[test]
    fn rejects_duplicate_board_ids() {
        assert_eq!(
            decode_board_bytes(
                br#"{"isLast":true,"values":[
                  {"id":84,"name":"One","type":"scrum"},
                  {"id":84,"name":"Two","type":"kanban"}
                ]}"#,
            ),
            Err(JiraSearchError::MalformedResponse)
        );
    }

    #[test]
    fn skips_invalid_issues_but_rejects_duplicate_stable_ids() {
        let partial = decode_search_bytes(
            "https://example.atlassian.net",
            br#"{"issues":[
              {"id":"not-numeric","key":"TERM-42","fields":{"summary":"Bad id","status":{"name":"Open"},"updated":"now"}},
              {"id":"10043","key":"TERM-42/../../secret","fields":{"summary":"Bad key","status":{"name":"Open"},"updated":"now"}},
              {"id":"10044","key":"team_2-44","fields":{"summary":"Usable","status":{"name":"Open"},"updated":"now"}}
            ],"isLast":true}"#,
        )
        .unwrap();
        assert!(partial.truncated);
        assert_eq!(partial.issues.len(), 1);
        assert_eq!(partial.issues[0].key, "team_2-44");

        let duplicate = br#"{"issues":[{"id":"10042","key":"TERM-42","fields":{"summary":"One","status":{"name":"Open"},"updated":"now"}},{"id":"10042","key":"TERM-43","fields":{"summary":"Two","status":{"name":"Open"},"updated":"now"}}]}"#;
        assert_eq!(
            decode_search_bytes("https://example.atlassian.net", duplicate),
            Err(JiraSearchError::MalformedResponse)
        );
    }
}
