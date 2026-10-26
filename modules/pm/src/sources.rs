//! Where a PM project reads from: a Jira Cloud site and one code host
//! repository, on GitHub or Azure DevOps. Only non-secret identifiers are kept; a Jira API token lives
//! in the platform credential store under the named handle and is read by
//! the caller for one request, never stored here.

use termloop_providers::{AzureRepository, normalize_jira_site_base_url, valid_issue_key};

use crate::validation::{valid_id, valid_label};

pub const JIRA_ACCOUNT_EMAIL_MAX_CHARS: usize = 254;
const GITHUB_NAME_MAX_CHARS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JiraSource {
    /// The normalized `https://<site>` base URL.
    pub site_url: String,
    /// The Jira board whose sprints the project mirrors, when chosen.
    #[serde(default)]
    pub board_id: Option<u64>,
    /// The Jira account the API token belongs to.
    pub account_email: String,
    /// The account name of the token in the platform credential store.
    pub credential_handle: String,
}

impl JiraSource {
    pub fn is_valid(&self) -> bool {
        normalize_jira_site_base_url(&self.site_url).is_ok_and(|site| site == self.site_url)
            && self.board_id.is_none_or(|board| board > 0)
            && valid_label(&self.account_email, JIRA_ACCOUNT_EMAIL_MAX_CHARS)
            && self.account_email.contains('@')
            && valid_id(&self.credential_handle)
    }

    /// The browse URL of one issue on this site.
    pub fn issue_url(&self, issue_key: &str) -> Option<String> {
        valid_issue_key(issue_key).then(|| format!("{}/browse/{issue_key}", self.site_url))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GitHubSource {
    pub owner: String,
    pub name: String,
}

impl GitHubSource {
    pub fn is_valid(&self) -> bool {
        valid_github_name(&self.owner) && valid_github_name(&self.name)
    }

    /// The secret-free repository label pull request facts carry.
    pub fn label(&self) -> String {
        format!("github.com/{}/{}", self.owner, self.name)
    }
}

fn valid_github_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= GITHUB_NAME_MAX_CHARS
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectSources {
    #[serde(default)]
    pub jira: Option<JiraSource>,
    #[serde(default)]
    pub github: Option<GitHubSource>,
    /// Kept normalized: a lowercase organization and NFC names.
    #[serde(default)]
    pub azure_devops: Option<AzureRepository>,
}

impl ProjectSources {
    /// A project reads pull requests from at most one code host.
    pub fn is_valid(&self) -> bool {
        self.jira.as_ref().is_none_or(JiraSource::is_valid)
            && self.github.as_ref().is_none_or(GitHubSource::is_valid)
            && self
                .azure_devops
                .as_ref()
                .is_none_or(|azure| azure.normalized().as_ref() == Some(azure))
            && !(self.github.is_some() && self.azure_devops.is_some())
    }

    /// The same sources with the Azure DevOps repository normalized, or
    /// `None` when its names are invalid.
    pub fn normalized(&self) -> Option<Self> {
        Some(Self {
            azure_devops: match &self.azure_devops {
                Some(azure) => Some(azure.normalized()?),
                None => None,
            },
            ..self.clone()
        })
    }

    pub fn has_code_host(&self) -> bool {
        self.github.is_some() || self.azure_devops.is_some()
    }

    /// The label of the code host repository pull requests are read from.
    pub fn code_label(&self) -> Option<String> {
        self.github
            .as_ref()
            .map(GitHubSource::label)
            .or_else(|| self.azure_devops.as_ref().map(AzureRepository::label))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_keep_only_normalized_secret_free_identifiers() {
        let jira = JiraSource {
            site_url: "https://acme.atlassian.net".into(),
            board_id: Some(84),
            account_email: "ada@acme.example".into(),
            credential_handle: "jira-acme".into(),
        };
        assert!(jira.is_valid());
        assert_eq!(
            jira.issue_url("PAY-42").as_deref(),
            Some("https://acme.atlassian.net/browse/PAY-42")
        );
        assert_eq!(jira.issue_url("pay 42"), None);
        for invalid in [
            JiraSource {
                site_url: "https://acme.atlassian.net/".into(),
                ..jira.clone()
            },
            JiraSource {
                site_url: "https://user:token@acme.atlassian.net".into(),
                ..jira.clone()
            },
            JiraSource {
                board_id: Some(0),
                ..jira.clone()
            },
            JiraSource {
                credential_handle: "has space".into(),
                ..jira.clone()
            },
        ] {
            assert!(!invalid.is_valid(), "{invalid:?}");
        }
        let github = GitHubSource {
            owner: "acme".into(),
            name: "pay.api".into(),
        };
        assert!(github.is_valid());
        assert_eq!(github.label(), "github.com/acme/pay.api");
        assert!(
            !GitHubSource {
                name: "../x".into(),
                ..github
            }
            .is_valid()
        );
    }

    #[test]
    fn azure_devops_sources_are_kept_normalized_and_exclude_github() {
        let raw = ProjectSources {
            azure_devops: Some(AzureRepository {
                organization: "Contoso".into(),
                project: "Parking Platform".into(),
                name: "Nucleus".into(),
            }),
            ..ProjectSources::default()
        };
        assert!(!raw.is_valid());
        let sources = raw.normalized().expect("valid names");
        assert!(sources.is_valid() && sources.has_code_host());
        assert_eq!(
            sources.code_label().as_deref(),
            Some("dev.azure.com/contoso/Parking Platform/Nucleus")
        );
        let invalid = ProjectSources {
            azure_devops: Some(AzureRepository {
                project: "a/b".into(),
                ..sources.azure_devops.clone().unwrap()
            }),
            ..ProjectSources::default()
        };
        assert_eq!(invalid.normalized(), None);
        let both = ProjectSources {
            github: Some(GitHubSource {
                owner: "acme".into(),
                name: "pay".into(),
            }),
            ..sources
        };
        assert!(!both.is_valid());
        assert!(!ProjectSources::default().has_code_host());
    }
}
