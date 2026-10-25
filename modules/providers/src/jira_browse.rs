//! Jira issue browsing for an Orca-style issue list: the JQL a preset,
//! project, status, sprint, and text selection stands for, and bounded reads
//! of projects, statuses (in board column order), favourite filters, and
//! issues with their list metadata. User input only ever reaches JQL as an
//! escaped string literal or as the caller's own whole custom query.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::jira::{
    JIRA_SEARCH_LIMIT, JiraCloudClient, JiraCredential, JiraIssueSnapshot, JiraSearchError,
    SearchResponse, decode_search_page_with, normalize_jira_site_base_url, read_board_response,
    read_search_response, split_top_level_order_by, truncate_utf8, valid_board_id,
};

pub const JIRA_BROWSE_JQL_MAX_BYTES: usize = 8 * 1024;
pub const JIRA_BROWSE_STATUSES_MAX: usize = 20;
pub const JIRA_BROWSE_TEXT_MAX_CHARS: usize = 200;
pub const JIRA_BROWSE_PROJECTS_MAX: usize = 50;
const STATUS_NAME_MAX_CHARS: usize = 128;
const NAME_MAX_BYTES: usize = 256;
const LABELS_MAX: usize = 20;
const LABEL_MAX_BYTES: usize = 255;
const AVATAR_URL_MAX_BYTES: usize = 2_048;
const STATUS_CATALOG_MAX: usize = 500;
const BOARD_COLUMNS_MAX: usize = 100;
const FAVOURITE_FILTERS_MAX: usize = 100;
const FAVOURITE_FILTER_CANDIDATES_MAX: usize = 1_000;
const FAVOURITE_FILTER_NAME_MAX_CHARS: usize = 200;
const SPRINT_FIELD_TYPE: &str = "com.pyxis.greenhopper.jira:gh-sprint";
/// List fields only: a description is a detail read.
const LIST_FIELDS: [&str; 9] = [
    "summary",
    "status",
    "assignee",
    "reporter",
    "priority",
    "labels",
    "issuetype",
    "created",
    "updated",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JiraIssuePreset {
    /// Open issues assigned to the caller.
    Assigned,
    /// Open issues the caller reported.
    Reported,
    /// Every open issue the scope allows.
    AllOpen,
    /// Done issues assigned to the caller.
    Done,
    /// The caller's own JQL.
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JiraIssueOrder {
    Updated,
    Created,
    Priority,
}

impl JiraIssueOrder {
    fn field(self) -> &'static str {
        match self {
            Self::Updated => "updated",
            Self::Created => "created",
            Self::Priority => "priority",
        }
    }
}

/// One issue-list selection. `project_keys` empty means every project the
/// JQL already allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraIssueQuery {
    pub preset: JiraIssuePreset,
    pub custom_jql: Option<String>,
    pub project_keys: Vec<String>,
    pub statuses: Vec<String>,
    pub current_sprint: bool,
    pub text: Option<String>,
    pub order_by: Option<JiraIssueOrder>,
}

impl JiraIssueQuery {
    pub fn preset(preset: JiraIssuePreset) -> Self {
        Self {
            preset,
            custom_jql: None,
            project_keys: Vec::new(),
            statuses: Vec::new(),
            current_sprint: false,
            text: None,
            order_by: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JiraQueryError {
    #[error("a custom Jira search needs JQL")]
    MissingJql,
    #[error("the JQL is invalid")]
    InvalidJql,
    #[error("the Jira project key is invalid")]
    InvalidProjectKey,
    #[error("the status filter is invalid")]
    InvalidStatuses,
    #[error("the search text is invalid")]
    InvalidText,
}

impl JiraQueryError {
    /// The request parameter the error names.
    pub fn parameter(self) -> &'static str {
        match self {
            Self::MissingJql | Self::InvalidJql => "jql",
            Self::InvalidProjectKey => "jiraProjectKey",
            Self::InvalidStatuses => "statuses",
            Self::InvalidText => "text",
        }
    }
}

/// The JQL an issue-list selection stands for, built the way Orca builds
/// its presets: the preset's clauses, then project, status, open-sprint,
/// and text restrictions, then the ordering.
pub fn build_jira_issue_jql(query: &JiraIssueQuery) -> Result<String, JiraQueryError> {
    let mut clauses: Vec<String> = Vec::new();
    let mut ordering: Option<String> = None;
    match query.preset {
        JiraIssuePreset::Custom => {
            let jql = query
                .custom_jql
                .as_deref()
                .map(str::trim)
                .filter(|jql| !jql.is_empty())
                .ok_or(JiraQueryError::MissingJql)?;
            if !valid_custom_jql(jql) {
                return Err(JiraQueryError::InvalidJql);
            }
            let (predicate, order) = split_top_level_order_by(jql);
            if !predicate.trim().is_empty() {
                clauses.push(format!("({})", predicate.trim()));
            }
            if !order.trim().is_empty() {
                ordering = Some(order.trim().to_owned());
            }
        }
        JiraIssuePreset::Assigned => {
            clauses.push("assignee = currentUser()".to_owned());
            clauses.push("statusCategory != Done".to_owned());
        }
        JiraIssuePreset::Reported => {
            clauses.push("reporter = currentUser()".to_owned());
            clauses.push("statusCategory != Done".to_owned());
        }
        JiraIssuePreset::AllOpen => clauses.push("statusCategory != Done".to_owned()),
        JiraIssuePreset::Done => {
            clauses.push("assignee = currentUser()".to_owned());
            clauses.push("statusCategory = Done".to_owned());
        }
    }
    if let Some(clause) = project_clause(&query.project_keys)? {
        clauses.push(clause);
    }
    if !query.statuses.is_empty() {
        if query.statuses.len() > JIRA_BROWSE_STATUSES_MAX
            || !query.statuses.iter().all(|name| valid_status_name(name))
        {
            return Err(JiraQueryError::InvalidStatuses);
        }
        let names: Vec<String> = query
            .statuses
            .iter()
            .map(|name| jql_string(name.trim()))
            .collect();
        clauses.push(format!("status in ({})", names.join(", ")));
    }
    if query.current_sprint {
        clauses.push("sprint in openSprints()".to_owned());
    }
    if let Some(text) = query.text.as_deref() {
        if text.chars().count() > JIRA_BROWSE_TEXT_MAX_CHARS || text.chars().any(char::is_control) {
            return Err(JiraQueryError::InvalidText);
        }
        if let Some(clause) = text_match_clause(text) {
            clauses.push(clause);
        }
    }
    let ordering = match query.order_by {
        Some(order) => format!("ORDER BY {} DESC", order.field()),
        None => ordering.unwrap_or_else(|| "ORDER BY updated DESC".to_owned()),
    };
    Ok(if clauses.is_empty() {
        ordering
    } else {
        format!("{} {ordering}", clauses.join(" AND "))
    })
}

fn project_clause(keys: &[String]) -> Result<Option<String>, JiraQueryError> {
    if keys.len() > JIRA_BROWSE_PROJECTS_MAX || !keys.iter().all(|key| valid_project_key(key)) {
        return Err(JiraQueryError::InvalidProjectKey);
    }
    Ok(match keys {
        [] => None,
        [key] => Some(format!("project = {}", jql_string(key))),
        keys => {
            let keys: Vec<String> = keys.iter().map(|key| jql_string(key)).collect();
            Some(format!("project in ({})", keys.join(", ")))
        }
    })
}

/// A JQL string literal. Callers reject control characters first, so the
/// only characters that could end the literal are escaped here.
fn jql_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// A Jira project key as Jira issues them: an uppercase letter, then
/// uppercase letters, digits, or underscores.
pub fn valid_project_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_uppercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

fn valid_status_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= STATUS_NAME_MAX_CHARS
        && !trimmed.chars().any(char::is_control)
}

/// A whole custom query: bounded, free of control text other than line
/// breaks and tabs, and with every quote and parenthesis closed, so the
/// restrictions added after it apply to all of it.
pub fn valid_custom_jql(jql: &str) -> bool {
    if jql.trim().is_empty()
        || jql.len() > JIRA_BROWSE_JQL_MAX_BYTES
        || jql
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return false;
    }
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0usize;
    for character in jql.chars() {
        if let Some(open) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == open {
                quote = None;
            }
            continue;
        }
        match character {
            '"' | '\'' => quote = Some(character),
            '(' => depth += 1,
            ')' if depth == 0 => return false,
            ')' => depth -= 1,
            _ => {}
        }
    }
    quote.is_none() && depth == 0
}

/// Orca's text match: Lucene syntax characters become spaces (so no quote
/// or backslash survives), words are lowercased, and the last word becomes
/// a prefix match when it is a plain word. `None` when no word remains.
fn text_match_clause(text: &str) -> Option<String> {
    let cleaned: String = text
        .chars()
        .map(|character| {
            if "+-&|!(){}[]^\"~*?:\\/".contains(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    let words = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let last = words.rsplit(' ').next().filter(|word| !word.is_empty())?;
    let wildcard = last
        .chars()
        .all(|character| character.is_alphanumeric() || character == '\'');
    Some(format!(
        "text ~ \"{words}{}\"",
        if wildcard { "*" } else { "" }
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraProject {
    pub key: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraProjectList {
    pub projects: Vec<JiraProject>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JiraStatusCategory {
    New,
    Indeterminate,
    Done,
}

impl JiraStatusCategory {
    /// Jira's category key; a status without a known category (`undefined`)
    /// reads as not started.
    pub fn from_key(key: Option<&str>) -> Self {
        match key {
            Some("indeterminate") => Self::Indeterminate,
            Some("done") => Self::Done,
            _ => Self::New,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraCategorizedStatus {
    pub id: String,
    pub name: String,
    pub category: JiraStatusCategory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraBoardColumn {
    pub name: String,
    pub status_ids: Vec<String>,
}

/// Statuses in board column order, then alphabetically; `columns` is empty
/// when no board ordered them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraStatusCatalog {
    pub statuses: Vec<JiraCategorizedStatus>,
    pub columns: Vec<JiraBoardColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraFavouriteFilter {
    pub id: String,
    pub name: String,
    pub jql: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraFavouriteFilterList {
    pub filters: Vec<JiraFavouriteFilter>,
    pub truncated: bool,
}

/// List metadata beside an issue's snapshot. Avatar URLs are plain HTTPS
/// image URLs without credentials.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JiraIssueDetails {
    pub issue_type: Option<String>,
    pub priority: Option<String>,
    pub reporter_display: Option<String>,
    pub assignee_avatar_url: Option<String>,
    pub labels: Vec<String>,
    pub sprint: Option<String>,
    pub created_at_epoch_ms: Option<u64>,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraListedIssue {
    pub snapshot: JiraIssueSnapshot,
    pub details: JiraIssueDetails,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraIssueListing {
    pub issues: Vec<JiraListedIssue>,
    pub truncated: bool,
}

impl JiraCloudClient {
    fn get_json(
        &self,
        url: String,
        credential: JiraCredential<'_>,
        large: bool,
    ) -> Result<Vec<u8>, JiraSearchError> {
        let response = self
            .http()
            .get(url)
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| JiraSearchError::Unavailable)?;
        if large {
            read_search_response(response)
        } else {
            read_board_response(response)
        }
    }

    /// The first page (at most 50) of projects the credential can browse,
    /// by name.
    pub fn browse_projects(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
    ) -> Result<JiraProjectList, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        let bytes = self.get_json(
            format!(
                "{site}/rest/api/3/project/search?maxResults={JIRA_BROWSE_PROJECTS_MAX}&orderBy=name"
            ),
            credential,
            false,
        )?;
        decode_project_page_bytes(&bytes)
    }

    /// Statuses of one Jira project, or of the board when no project is
    /// named, or of the site; ordered by the board's columns when a board
    /// is given and readable.
    pub fn browse_statuses(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        project_key: Option<&str>,
        board_id: Option<u64>,
    ) -> Result<JiraStatusCatalog, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        if project_key.is_some_and(|key| !valid_project_key(key)) {
            return Err(JiraSearchError::ScopeInvalid);
        }
        // A board that cannot be read leaves the statuses alphabetical.
        let columns = match board_id {
            Some(board_id) if board_id > 0 => self
                .get_json(
                    format!("{site}/rest/agile/1.0/board/{board_id}/configuration"),
                    credential,
                    false,
                )
                .ok()
                .and_then(|bytes| decode_board_columns_bytes(&bytes).ok())
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        let statuses = match project_key {
            Some(key) => decode_project_statuses_bytes(&self.get_json(
                format!("{site}/rest/api/3/project/{key}/statuses"),
                credential,
                true,
            )?)?,
            None => decode_status_list_bytes(&self.get_json(
                format!("{site}/rest/api/3/status"),
                credential,
                true,
            )?)?,
        };
        Ok(order_statuses(statuses, columns, project_key.is_none()))
    }

    /// The caller's favourite Jira filters with their JQL; a filter whose
    /// JQL cannot run as a custom search is left out.
    pub fn favourite_filters(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
    ) -> Result<JiraFavouriteFilterList, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        let bytes = self.get_json(
            format!("{site}/rest/api/3/filter/favourite?expand=jql"),
            credential,
            false,
        )?;
        decode_favourite_filters_bytes(&bytes)
    }

    /// The id of the site's sprint field, when it has one.
    pub fn sprint_field_id(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
    ) -> Result<Option<String>, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        let bytes = self.get_json(format!("{site}/rest/api/3/field"), credential, true)?;
        decode_sprint_field_bytes(&bytes)
    }

    /// At most 50 issues matching `jql`, with list metadata; the sprint is
    /// read from `sprint_field` when given.
    pub fn browse_issues(
        &self,
        site_base_url: &str,
        credential: JiraCredential<'_>,
        jql: &str,
        sprint_field: Option<&str>,
    ) -> Result<JiraIssueListing, JiraSearchError> {
        let site = normalize_jira_site_base_url(site_base_url)?;
        if jql.trim().is_empty() || jql.len() > 2 * JIRA_BROWSE_JQL_MAX_BYTES {
            return Err(JiraSearchError::ScopeInvalid);
        }
        let sprint_field = sprint_field.filter(|field| valid_custom_field_id(field));
        let mut fields: Vec<&str> = LIST_FIELDS.to_vec();
        fields.extend(sprint_field);
        let response = self
            .http()
            .post(format!("{site}/rest/api/3/search/jql"))
            .basic_auth(credential.email, Some(credential.api_token))
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&serde_json::json!({
                "jql": jql,
                "maxResults": JIRA_SEARCH_LIMIT,
                "fields": fields,
            }))
            .send()
            .map_err(|_| JiraSearchError::Unavailable)?;
        let bytes = read_search_response(response)?;
        decode_issue_listing_bytes(&site, &bytes, sprint_field)
    }
}

fn valid_custom_field_id(field: &str) -> bool {
    field
        .strip_prefix("customfield_")
        .is_some_and(valid_board_id)
}

/// Trimmed, bounded text without control characters; `None` when empty.
fn clean_text(value: &str, max_bytes: usize) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && !trimmed.chars().any(char::is_control))
        .then(|| truncate_utf8(trimmed, max_bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPage {
    #[serde(default)]
    values: Vec<serde_json::Value>,
    #[serde(default)]
    total: Option<usize>,
    #[serde(default)]
    is_last: Option<bool>,
}

#[derive(Deserialize)]
struct ProjectValue {
    key: String,
    name: String,
}

fn decode_project_page_bytes(bytes: &[u8]) -> Result<JiraProjectList, JiraSearchError> {
    let page: ProjectPage =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    let returned = page.values.len();
    let mut truncated = returned > JIRA_BROWSE_PROJECTS_MAX
        || page.is_last == Some(false)
        || page.total.is_some_and(|total| total > returned);
    let mut keys = HashSet::new();
    let mut projects = Vec::new();
    for value in page.values.into_iter().take(JIRA_BROWSE_PROJECTS_MAX) {
        let project = serde_json::from_value::<ProjectValue>(value)
            .ok()
            .filter(|project| valid_project_key(&project.key))
            .and_then(|project| {
                Some(JiraProject {
                    name: clean_text(&project.name, NAME_MAX_BYTES)?,
                    key: project.key,
                })
            });
        match project {
            Some(project) if keys.insert(project.key.clone()) => projects.push(project),
            _ => truncated = true,
        }
    }
    Ok(JiraProjectList {
        projects,
        truncated,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusValue {
    id: String,
    name: String,
    #[serde(default)]
    status_category: Option<CategoryValue>,
}

#[derive(Deserialize)]
struct CategoryValue {
    #[serde(default)]
    key: Option<String>,
}

#[derive(Deserialize)]
struct IssueTypeStatuses {
    #[serde(default)]
    statuses: Vec<serde_json::Value>,
}

fn categorized_status(value: serde_json::Value) -> Option<JiraCategorizedStatus> {
    let status = serde_json::from_value::<StatusValue>(value).ok()?;
    if !valid_board_id(&status.id) {
        return None;
    }
    Some(JiraCategorizedStatus {
        name: clean_text(&status.name, NAME_MAX_BYTES)?,
        id: status.id,
        category: JiraStatusCategory::from_key(
            status
                .status_category
                .as_ref()
                .and_then(|category| category.key.as_deref()),
        ),
    })
}

/// Statuses deduplicated by id, at most `STATUS_CATALOG_MAX`.
fn collect_statuses(values: impl Iterator<Item = serde_json::Value>) -> Vec<JiraCategorizedStatus> {
    let mut seen = HashSet::new();
    values
        .filter_map(categorized_status)
        .filter(|status| seen.insert(status.id.clone()))
        .take(STATUS_CATALOG_MAX)
        .collect()
}

fn decode_status_list_bytes(bytes: &[u8]) -> Result<Vec<JiraCategorizedStatus>, JiraSearchError> {
    let values: Vec<serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    Ok(collect_statuses(values.into_iter()))
}

fn decode_project_statuses_bytes(
    bytes: &[u8],
) -> Result<Vec<JiraCategorizedStatus>, JiraSearchError> {
    let issue_types: Vec<IssueTypeStatuses> =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    Ok(collect_statuses(
        issue_types
            .into_iter()
            .flat_map(|issue_type| issue_type.statuses),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoardConfiguration {
    column_config: ColumnConfig,
}

#[derive(Deserialize)]
struct ColumnConfig {
    #[serde(default)]
    columns: Vec<ColumnValue>,
}

#[derive(Deserialize)]
struct ColumnValue {
    #[serde(default)]
    name: String,
    #[serde(default)]
    statuses: Vec<ColumnStatusValue>,
}

#[derive(Deserialize)]
struct ColumnStatusValue {
    id: String,
}

/// Named board columns in board order. A status listed by two columns
/// stays in the first.
fn decode_board_columns_bytes(bytes: &[u8]) -> Result<Vec<JiraBoardColumn>, JiraSearchError> {
    let configuration: BoardConfiguration =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    let mut seen = HashSet::new();
    Ok(configuration
        .column_config
        .columns
        .into_iter()
        .filter_map(|column| {
            Some(JiraBoardColumn {
                name: clean_text(&column.name, NAME_MAX_BYTES)?,
                status_ids: column
                    .statuses
                    .into_iter()
                    .map(|status| status.id)
                    .filter(|id| valid_board_id(id) && seen.insert(id.clone()))
                    .collect(),
            })
        })
        .take(BOARD_COLUMNS_MAX)
        .collect())
}

/// Board column order first, then the rest by name. With `board_only`, the
/// catalog keeps only the board's statuses when the board lists any.
fn order_statuses(
    statuses: Vec<JiraCategorizedStatus>,
    mut columns: Vec<JiraBoardColumn>,
    board_only: bool,
) -> JiraStatusCatalog {
    let known: HashSet<&str> = statuses.iter().map(|status| status.id.as_str()).collect();
    for column in &mut columns {
        column.status_ids.retain(|id| known.contains(id.as_str()));
    }
    let rank: HashMap<String, usize> = columns
        .iter()
        .flat_map(|column| column.status_ids.iter().cloned())
        .enumerate()
        .map(|(index, id)| (id, index))
        .collect();
    let mut statuses = statuses;
    if board_only && !rank.is_empty() {
        statuses.retain(|status| rank.contains_key(&status.id));
    }
    statuses.sort_by(|left, right| {
        let order = |status: &JiraCategorizedStatus| rank.get(&status.id).copied();
        match (order(left), order(right)) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left
                .name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.id.cmp(&right.id)),
        }
    });
    JiraStatusCatalog { statuses, columns }
}

#[derive(Deserialize)]
struct FavouriteFilterValue {
    id: serde_json::Value,
    name: String,
    #[serde(default)]
    jql: Option<String>,
}

fn decode_favourite_filters_bytes(
    bytes: &[u8],
) -> Result<JiraFavouriteFilterList, JiraSearchError> {
    let values: Vec<serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    let mut truncated = values.len() > FAVOURITE_FILTER_CANDIDATES_MAX;
    let mut ids = HashSet::new();
    let mut filters = Vec::new();
    for value in values.into_iter().take(FAVOURITE_FILTER_CANDIDATES_MAX) {
        let filter = serde_json::from_value::<FavouriteFilterValue>(value)
            .ok()
            .and_then(|filter| {
                let id = match &filter.id {
                    serde_json::Value::String(id) => id.trim().to_owned(),
                    serde_json::Value::Number(id) => id.to_string(),
                    _ => return None,
                };
                let name = clean_text(&filter.name, 4 * FAVOURITE_FILTER_NAME_MAX_CHARS)?
                    .chars()
                    .take(FAVOURITE_FILTER_NAME_MAX_CHARS)
                    .collect();
                let jql = filter.jql.as_deref().map(str::trim)?;
                (valid_board_id(&id) && valid_custom_jql(jql)).then(|| JiraFavouriteFilter {
                    id,
                    name,
                    jql: jql.to_owned(),
                })
            });
        let Some(filter) = filter.filter(|filter| ids.insert(filter.id.clone())) else {
            truncated = true;
            continue;
        };
        if filters.len() == FAVOURITE_FILTERS_MAX {
            truncated = true;
            break;
        }
        filters.push(filter);
    }
    Ok(JiraFavouriteFilterList { filters, truncated })
}

#[derive(Deserialize)]
struct FieldValue {
    id: String,
    #[serde(default)]
    schema: Option<FieldSchema>,
}

#[derive(Deserialize)]
struct FieldSchema {
    #[serde(default)]
    custom: Option<String>,
}

fn decode_sprint_field_bytes(bytes: &[u8]) -> Result<Option<String>, JiraSearchError> {
    let values: Vec<serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    Ok(values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<FieldValue>(value).ok())
        .find(|field| {
            field
                .schema
                .as_ref()
                .and_then(|schema| schema.custom.as_deref())
                == Some(SPRINT_FIELD_TYPE)
                && valid_custom_field_id(&field.id)
        })
        .map(|field| field.id))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DetailFields {
    #[serde(default)]
    issuetype: Option<NamedValue>,
    #[serde(default)]
    priority: Option<NamedValue>,
    #[serde(default)]
    reporter: Option<PersonValue>,
    #[serde(default)]
    assignee: Option<PersonValue>,
    #[serde(default)]
    labels: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    updated: Option<String>,
}

#[derive(Deserialize)]
struct NamedValue {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonValue {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    avatar_urls: Option<HashMap<String, String>>,
}

fn decode_issue_listing_bytes(
    site: &str,
    bytes: &[u8],
    sprint_field: Option<&str>,
) -> Result<JiraIssueListing, JiraSearchError> {
    let parsed: SearchResponse =
        serde_json::from_slice(bytes).map_err(|_| JiraSearchError::MalformedResponse)?;
    let (issues, truncated) =
        decode_search_page_with(site, parsed, |value| issue_details(value, sprint_field))?;
    Ok(JiraIssueListing {
        issues: issues
            .into_iter()
            .map(|(snapshot, details)| JiraListedIssue { snapshot, details })
            .collect(),
        truncated,
    })
}

/// An issue's list metadata; `None` when its update time is unreadable.
fn issue_details(
    value: &serde_json::Value,
    sprint_field: Option<&str>,
) -> Option<JiraIssueDetails> {
    let fields = value.get("fields")?;
    let detail = DetailFields::deserialize(fields).unwrap_or_default();
    let name = |value: Option<NamedValue>| {
        value
            .and_then(|value| value.name)
            .and_then(|name| clean_text(&name, NAME_MAX_BYTES))
    };
    Some(JiraIssueDetails {
        updated_at_epoch_ms: detail.updated.as_deref().and_then(jira_epoch_ms)?,
        created_at_epoch_ms: detail.created.as_deref().and_then(jira_epoch_ms),
        issue_type: name(detail.issuetype),
        priority: name(detail.priority),
        reporter_display: detail
            .reporter
            .and_then(|person| person.display_name)
            .and_then(|name| clean_text(&name, NAME_MAX_BYTES)),
        assignee_avatar_url: detail
            .assignee
            .and_then(|person| person.avatar_urls)
            .and_then(|urls| avatar_url(&urls)),
        labels: detail
            .labels
            .unwrap_or_default()
            .iter()
            .filter_map(serde_json::Value::as_str)
            .filter_map(|label| clean_text(label, LABEL_MAX_BYTES))
            .take(LABELS_MAX)
            .collect(),
        sprint: sprint_field
            .and_then(|field| fields.get(field))
            .and_then(sprint_name),
    })
}

/// The largest square avatar Jira lists, when it is a credential-free
/// HTTPS URL.
fn avatar_url(urls: &HashMap<String, String>) -> Option<String> {
    let raw = ["48x48", "32x32", "24x24", "16x16"]
        .iter()
        .find_map(|size| urls.get(*size))?;
    let parsed = reqwest::Url::parse(raw).ok()?;
    let serialized = parsed.as_str();
    (parsed.scheme() == "https"
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && serialized.len() <= AVATAR_URL_MAX_BYTES
        && !serialized
            .chars()
            .any(|character| character.is_whitespace() || character.is_control()))
    .then(|| serialized.to_owned())
}

/// The active sprint an issue is in, else the latest one listed.
fn sprint_name(value: &serde_json::Value) -> Option<String> {
    let sprints: Vec<&serde_json::Value> = match value {
        serde_json::Value::Array(values) => values.iter().collect(),
        serde_json::Value::Object(_) => vec![value],
        _ => return None,
    };
    let active = sprints.iter().copied().find(|sprint| {
        sprint
            .get("state")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|state| state.eq_ignore_ascii_case("active"))
    });
    let sprint = active.or_else(|| sprints.last().copied())?;
    sprint
        .get("name")
        .and_then(serde_json::Value::as_str)
        .and_then(|name| clean_text(name, NAME_MAX_BYTES))
}

/// Jira's timestamp (`2026-10-25T09:30:00.000+0000`) or RFC 3339, as epoch
/// milliseconds.
fn jira_epoch_ms(value: &str) -> Option<u64> {
    let value = value.trim();
    let bytes = value.as_bytes();
    let compact_offset = bytes.len() > 5
        && matches!(bytes[bytes.len() - 5], b'+' | b'-')
        && bytes[bytes.len() - 4..].iter().all(u8::is_ascii_digit);
    if compact_offset {
        let (timestamp, offset) = value.split_at(value.len() - 2);
        return crate::parse_rfc3339_epoch_ms(&format!("{timestamp}:{offset}"));
    }
    crate::parse_rfc3339_epoch_ms(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(preset: JiraIssuePreset) -> JiraIssueQuery {
        JiraIssueQuery::preset(preset)
    }

    #[test]
    fn each_preset_builds_orca_jql() {
        let cases = [
            (
                JiraIssuePreset::Assigned,
                "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
            ),
            (
                JiraIssuePreset::Reported,
                "reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC",
            ),
            (
                JiraIssuePreset::AllOpen,
                "statusCategory != Done ORDER BY updated DESC",
            ),
            (
                JiraIssuePreset::Done,
                "assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC",
            ),
        ];
        for (preset, expected) in cases {
            assert_eq!(build_jira_issue_jql(&query(preset)).unwrap(), expected);
        }
    }

    #[test]
    fn filters_combine_in_orca_order() {
        let mut query = query(JiraIssuePreset::AllOpen);
        query.project_keys = vec!["PAY".to_owned()];
        query.statuses = vec!["Blocked".to_owned(), "In Progress".to_owned()];
        query.current_sprint = true;
        query.text = Some("Login fails".to_owned());
        query.order_by = Some(JiraIssueOrder::Priority);
        assert_eq!(
            build_jira_issue_jql(&query).unwrap(),
            "statusCategory != Done AND project = \"PAY\" AND status in (\"Blocked\", \"In Progress\") \
             AND sprint in openSprints() AND text ~ \"login fails*\" ORDER BY priority DESC"
        );
        query.project_keys = vec!["PAY".to_owned(), "OPS_2".to_owned()];
        query.statuses.clear();
        query.current_sprint = false;
        query.text = None;
        query.order_by = Some(JiraIssueOrder::Created);
        assert_eq!(
            build_jira_issue_jql(&query).unwrap(),
            "statusCategory != Done AND project in (\"PAY\", \"OPS_2\") ORDER BY created DESC"
        );
    }

    #[test]
    fn status_names_are_escaped_string_literals() {
        let mut query = query(JiraIssuePreset::AllOpen);
        query.statuses = vec![
            "Needs \"QA\" \\ Review".to_owned(),
            "x\") OR project = SECRET OR status in (\"y".to_owned(),
        ];
        assert_eq!(
            build_jira_issue_jql(&query).unwrap(),
            "statusCategory != Done AND status in (\"Needs \\\"QA\\\" \\\\ Review\", \
             \"x\\\") OR project = SECRET OR status in (\\\"y\") ORDER BY updated DESC"
        );
        for bad in ["", "  ", "Line\nbreak", &"x".repeat(129)] {
            query.statuses = vec![bad.to_owned()];
            assert_eq!(
                build_jira_issue_jql(&query),
                Err(JiraQueryError::InvalidStatuses)
            );
        }
        query.statuses = vec!["A".to_owned(); 21];
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::InvalidStatuses)
        );
    }

    #[test]
    fn search_text_cannot_leave_its_literal() {
        let mut query = query(JiraIssuePreset::Assigned);
        query.text = Some("\" OR project = X OR text ~ \"\\".to_owned());
        let jql = build_jira_issue_jql(&query).unwrap();
        assert_eq!(
            jql,
            "assignee = currentUser() AND statusCategory != Done AND \
             text ~ \"or project = x or text*\" ORDER BY updated DESC"
        );
        query.text = Some("c# api".to_owned());
        assert!(
            build_jira_issue_jql(&query)
                .unwrap()
                .contains("text ~ \"c# api*\"")
        );
        query.text = Some("c#".to_owned());
        assert!(
            build_jira_issue_jql(&query)
                .unwrap()
                .contains("text ~ \"c#\"")
        );
        query.text = Some(" ()\"* ".to_owned());
        assert!(!build_jira_issue_jql(&query).unwrap().contains("text ~"));
        query.text = Some("a\u{0}b".to_owned());
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::InvalidText)
        );
        query.text = Some("x".repeat(201));
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::InvalidText)
        );
    }

    #[test]
    fn custom_jql_is_wrapped_and_keeps_its_ordering() {
        let mut query = query(JiraIssuePreset::Custom);
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::MissingJql)
        );
        query.custom_jql = Some("  ".to_owned());
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::MissingJql)
        );
        query.custom_jql =
            Some("labels = \"order by\" OR status = Open order by rank ASC".to_owned());
        query.current_sprint = true;
        assert_eq!(
            build_jira_issue_jql(&query).unwrap(),
            "(labels = \"order by\" OR status = Open) AND sprint in openSprints() order by rank ASC"
        );
        query.order_by = Some(JiraIssueOrder::Updated);
        assert_eq!(
            build_jira_issue_jql(&query).unwrap(),
            "(labels = \"order by\" OR status = Open) AND sprint in openSprints() ORDER BY updated DESC"
        );
        query.current_sprint = false;
        query.order_by = None;
        query.custom_jql = Some("ORDER BY created".to_owned());
        assert_eq!(build_jira_issue_jql(&query).unwrap(), "ORDER BY created");
        for bad in [
            "status = Open) OR (project = X",
            "summary ~ \"open",
            "(status = Open",
            "status = Open\u{0}",
        ] {
            query.custom_jql = Some(bad.to_owned());
            assert_eq!(
                build_jira_issue_jql(&query),
                Err(JiraQueryError::InvalidJql),
                "{bad}"
            );
        }
        query.custom_jql = Some(format!("summary ~ \"{}\"", "x".repeat(8 * 1024)));
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::InvalidJql)
        );
        query.custom_jql = Some("summary ~ \"a \\\" b\"\nAND status = Open".to_owned());
        assert!(build_jira_issue_jql(&query).is_ok());
    }

    #[test]
    fn project_keys_must_be_jira_keys() {
        let mut query = query(JiraIssuePreset::Assigned);
        for bad in ["pay", "1PAY", "PAY\"", "PAY KEY", ""] {
            query.project_keys = vec![bad.to_owned()];
            assert_eq!(
                build_jira_issue_jql(&query),
                Err(JiraQueryError::InvalidProjectKey),
                "{bad}"
            );
        }
        query.project_keys = vec!["P".to_owned(); 51];
        assert_eq!(
            build_jira_issue_jql(&query),
            Err(JiraQueryError::InvalidProjectKey)
        );
    }

    const SEARCH_FIXTURE: &str = r#"{
      "isLast": true,
      "issues": [
        {"id": "10042", "key": "PAY-42", "fields": {
          "summary": "Checkout fails",
          "status": {"name": "In Progress", "statusCategory": {"key": "indeterminate"}},
          "assignee": {"displayName": "Ada", "avatarUrls": {
            "48x48": "https://avatar-management.example/ada/48.png?s=48",
            "24x24": "https://avatar-management.example/ada/24.png"}},
          "reporter": {"displayName": "Grace"},
          "priority": {"name": "High"},
          "issuetype": {"name": "Bug"},
          "labels": ["payments", "  ", "web"],
          "created": "2026-10-20T08:00:00.000+0200",
          "updated": "2026-10-25T09:30:00.000+0000",
          "customfield_10020": [
            {"id": 1, "name": "Sprint 7", "state": "closed"},
            {"id": 2, "name": "Sprint 8", "state": "active"}
          ]
        }},
        {"id": "10043", "key": "PAY-43", "fields": {
          "summary": "Rotate keys",
          "status": {"name": "To Do"},
          "assignee": {"displayName": "Lin", "avatarUrls": {"48x48": "https://user:pw@evil.example/a.png"}},
          "updated": "2026-10-24T10:00:00Z"
        }},
        {"id": "10044", "key": "PAY-44", "fields": {
          "summary": "No time", "status": {"name": "To Do"}, "updated": "yesterday"
        }}
      ]
    }"#;

    #[test]
    fn listed_issues_carry_list_metadata() {
        let listing = decode_issue_listing_bytes(
            "https://acme.atlassian.net",
            SEARCH_FIXTURE.as_bytes(),
            Some("customfield_10020"),
        )
        .unwrap();
        assert!(listing.truncated, "the unreadable update time drops PAY-44");
        assert_eq!(listing.issues.len(), 2);
        let first = &listing.issues[0];
        assert_eq!(first.snapshot.key, "PAY-42");
        assert_eq!(
            first.snapshot.url,
            "https://acme.atlassian.net/browse/PAY-42"
        );
        assert_eq!(
            first.snapshot.status_category.as_deref(),
            Some("indeterminate")
        );
        assert_eq!(
            first.details,
            JiraIssueDetails {
                issue_type: Some("Bug".to_owned()),
                priority: Some("High".to_owned()),
                reporter_display: Some("Grace".to_owned()),
                assignee_avatar_url: Some(
                    "https://avatar-management.example/ada/48.png?s=48".to_owned()
                ),
                labels: vec!["payments".to_owned(), "web".to_owned()],
                sprint: Some("Sprint 8".to_owned()),
                created_at_epoch_ms: Some(1_792_476_000_000),
                updated_at_epoch_ms: 1_792_920_600_000,
            }
        );
        let second = &listing.issues[1];
        assert_eq!(second.details.assignee_avatar_url, None);
        assert_eq!(second.details.sprint, None);
        assert_eq!(second.details.created_at_epoch_ms, None);
        assert_eq!(second.details.updated_at_epoch_ms, 1_792_836_000_000);
    }

    #[test]
    fn jira_timestamps_parse_with_compact_offsets() {
        assert_eq!(jira_epoch_ms("1970-01-01T01:00:00.000+0100"), Some(0));
        assert_eq!(jira_epoch_ms("1970-01-01T00:00:01.500Z"), Some(1_500));
        assert_eq!(jira_epoch_ms("not a time"), None);
    }

    #[test]
    fn projects_page_is_bounded_and_validated() {
        let list = decode_project_page_bytes(
            br#"{"isLast": false, "total": 80, "values": [
              {"id": "1", "key": "PAY", "name": "Payments"},
              {"id": "2", "key": "bad key", "name": "Bad"},
              {"id": "3", "key": "OPS", "name": "  Operations "}
            ]}"#,
        )
        .unwrap();
        assert!(list.truncated);
        assert_eq!(
            list.projects,
            [
                JiraProject {
                    key: "PAY".to_owned(),
                    name: "Payments".to_owned()
                },
                JiraProject {
                    key: "OPS".to_owned(),
                    name: "Operations".to_owned()
                },
            ]
        );
        assert!(decode_project_page_bytes(b"not json").is_err());
    }

    #[test]
    fn statuses_follow_board_columns_then_names() {
        let statuses = decode_project_statuses_bytes(
            br#"[
              {"name": "Bug", "statuses": [
                {"id": "3", "name": "Done", "statusCategory": {"key": "done"}},
                {"id": "1", "name": "To Do", "statusCategory": {"key": "new"}},
                {"id": "9", "name": "Archived", "statusCategory": {"key": "undefined"}}
              ]},
              {"name": "Story", "statuses": [
                {"id": "2", "name": "In Progress", "statusCategory": {"key": "indeterminate"}},
                {"id": "1", "name": "To Do", "statusCategory": {"key": "new"}}
              ]}
            ]"#,
        )
        .unwrap();
        let columns = decode_board_columns_bytes(
            br#"{"columnConfig": {"columns": [
              {"name": "Backlog", "statuses": [{"id": "1"}]},
              {"name": "Doing", "statuses": [{"id": "2"}, {"id": "77"}]},
              {"name": "Shipped", "statuses": [{"id": "3"}, {"id": "1"}]}
            ]}}"#,
        )
        .unwrap();
        let catalog = order_statuses(statuses.clone(), columns, false);
        let order: Vec<(&str, JiraStatusCategory)> = catalog
            .statuses
            .iter()
            .map(|status| (status.name.as_str(), status.category))
            .collect();
        assert_eq!(
            order,
            [
                ("To Do", JiraStatusCategory::New),
                ("In Progress", JiraStatusCategory::Indeterminate),
                ("Done", JiraStatusCategory::Done),
                ("Archived", JiraStatusCategory::New),
            ]
        );
        assert_eq!(catalog.columns[1].status_ids, ["2"], "unknown ids leave");
        assert_eq!(catalog.columns[2].status_ids, ["3"], "first column wins");

        let alphabetical = order_statuses(statuses, Vec::new(), true);
        let names: Vec<&str> = alphabetical
            .statuses
            .iter()
            .map(|status| status.name.as_str())
            .collect();
        assert_eq!(names, ["Archived", "Done", "In Progress", "To Do"]);
    }

    #[test]
    fn favourite_filters_keep_only_runnable_jql() {
        let list = decode_favourite_filters_bytes(
            br#"[
              {"id": "10000", "name": "My open bugs", "jql": "type = Bug AND resolution IS EMPTY"},
              {"id": 10001, "name": "Numeric id", "jql": "project = PAY ORDER BY rank"},
              {"id": "10002", "name": "No JQL"},
              {"id": "10003", "name": "Broken", "jql": "summary ~ \"open"},
              {"id": "10000", "name": "Duplicate", "jql": "project = PAY"}
            ]"#,
        )
        .unwrap();
        assert!(list.truncated);
        let ids: Vec<&str> = list
            .filters
            .iter()
            .map(|filter| filter.id.as_str())
            .collect();
        assert_eq!(ids, ["10000", "10001"]);
        assert_eq!(list.filters[1].jql, "project = PAY ORDER BY rank");
        assert!(decode_favourite_filters_bytes(b"{}").is_err());
    }

    #[test]
    fn the_sprint_field_is_found_by_its_schema() {
        assert_eq!(
            decode_sprint_field_bytes(
                br#"[
                  {"id": "summary", "schema": {"system": "summary"}},
                  {"id": "customfield_10020", "schema": {"custom": "com.pyxis.greenhopper.jira:gh-sprint"}}
                ]"#
            )
            .unwrap()
            .as_deref(),
            Some("customfield_10020")
        );
        assert_eq!(decode_sprint_field_bytes(b"[]").unwrap(), None);
    }
}
