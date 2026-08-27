//! Pure Project-scoped run configuration values.
//!
//! A run configuration is durable current state describing one named shell
//! command a user can start inside a Task worktree. Executions are ordinary
//! Terminal Sessions; no run history, attempt, or log records exist here.

pub const RUN_CONFIGURATIONS_PER_PROJECT_MAX: usize = 16;
pub const RUN_CONFIGURATION_ID_MAX_BYTES: usize = 64;
pub const RUN_CONFIGURATION_NAME_MAX_BYTES: usize = 80;
pub const RUN_CONFIGURATION_COMMAND_MAX_BYTES: usize = 4 * 1024;
pub const RUN_CONFIGURATION_WORKING_DIRECTORY_MAX_BYTES: usize = 1024;
pub const RUN_CONFIGURATION_ENV_MAX_ENTRIES: usize = 32;
pub const RUN_CONFIGURATION_ENV_NAME_MAX_BYTES: usize = 128;
pub const RUN_CONFIGURATION_ENV_VALUE_MAX_BYTES: usize = 4 * 1024;
pub const RUN_CONFIGURATION_FALLBACK_URLS_MAX: usize = 8;
pub const RUN_CONFIGURATION_FALLBACK_URL_MAX_BYTES: usize = 512;
pub const RUN_SETUP_MARKS_PER_PROJECT_MAX: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunConfigurationKind {
    DevServer,
    Build,
    TestRunner,
    Typecheck,
    Storybook,
    Custom,
}

impl RunConfigurationKind {
    /// Every kind, so a caller that must consider all of them cannot silently
    /// miss one a later variant adds.
    pub const ALL: [Self; 6] = [
        Self::DevServer,
        Self::Build,
        Self::TestRunner,
        Self::Typecheck,
        Self::Storybook,
        Self::Custom,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunSetupPolicy {
    OncePerWorktree,
    Always,
    Never,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfigurationEnvVar {
    pub name: String,
    pub value: String,
}

impl RunConfigurationEnvVar {
    pub fn is_valid(&self) -> bool {
        !self.name.is_empty()
            && self.name.len() <= RUN_CONFIGURATION_ENV_NAME_MAX_BYTES
            && self.name.bytes().enumerate().all(|(index, byte)| {
                byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
            })
            && self.value.len() <= RUN_CONFIGURATION_ENV_VALUE_MAX_BYTES
            && !self.value.contains('\0')
    }
}

/// One named shell command a user can run inside a Task worktree.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfiguration {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub kind: RunConfigurationKind,
    /// One shell command line. Composition into a concrete program/argv is
    /// platform policy; domain only bounds the value.
    pub command: String,
    /// Launch directory relative to the worktree root. Confinement to the
    /// worktree is core/platform policy; domain only bounds the value.
    pub working_directory: String,
    #[serde(default)]
    pub env: Vec<RunConfigurationEnvVar>,
    #[serde(default)]
    pub setup_command: Option<String>,
    pub setup_policy: RunSetupPolicy,
    pub url_auto_detect: bool,
    #[serde(default)]
    pub fallback_urls: Vec<String>,
    pub auto_open_first_url: bool,
    pub generation: u64,
    pub updated_at_epoch_ms: u64,
}

impl RunConfiguration {
    pub fn is_valid(&self) -> bool {
        !self.id.trim().is_empty()
            && self.id.len() <= RUN_CONFIGURATION_ID_MAX_BYTES
            && !self.project_id.trim().is_empty()
            && !self.name.trim().is_empty()
            && self.name.len() <= RUN_CONFIGURATION_NAME_MAX_BYTES
            && bounded_command(&self.command)
            && !self.working_directory.trim().is_empty()
            && self.working_directory.len() <= RUN_CONFIGURATION_WORKING_DIRECTORY_MAX_BYTES
            && !self.working_directory.contains('\0')
            && self.env.len() <= RUN_CONFIGURATION_ENV_MAX_ENTRIES
            && self.env.iter().all(RunConfigurationEnvVar::is_valid)
            && self.env.iter().enumerate().all(|(index, entry)| {
                !self.env[index + 1..]
                    .iter()
                    .any(|candidate| candidate.name == entry.name)
            })
            && self.setup_command.as_deref().is_none_or(bounded_command)
            && self.fallback_urls.len() <= RUN_CONFIGURATION_FALLBACK_URLS_MAX
            && self.fallback_urls.iter().all(|url| {
                !url.is_empty()
                    && url.len() <= RUN_CONFIGURATION_FALLBACK_URL_MAX_BYTES
                    && (url.starts_with("http://") || url.starts_with("https://"))
                    && !url.chars().any(char::is_whitespace)
            })
            && self.generation >= 1
    }
}

fn bounded_command(command: &str) -> bool {
    !command.trim().is_empty()
        && command.len() <= RUN_CONFIGURATION_COMMAND_MAX_BYTES
        && !command.contains('\0')
}

/// Current fact that a run configuration's setup command completed successfully
/// for one exact worktree at one configuration generation. This is a
/// replace-in-place mark, never setup execution history.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSetupMark {
    pub project_id: String,
    pub configuration_id: String,
    /// Exact Task-recorded worktree path, compared by equality only.
    pub worktree_path: String,
    pub configuration_generation: u64,
    pub completed_at_epoch_ms: u64,
}

impl RunSetupMark {
    pub fn is_valid(&self) -> bool {
        !self.project_id.trim().is_empty()
            && !self.configuration_id.trim().is_empty()
            && self.configuration_id.len() <= RUN_CONFIGURATION_ID_MAX_BYTES
            && !self.worktree_path.trim().is_empty()
            && self.configuration_generation >= 1
            && self.completed_at_epoch_ms > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> RunConfiguration {
        RunConfiguration {
            id: "dev-server".into(),
            project_id: "project-1".into(),
            name: "Dev server".into(),
            kind: RunConfigurationKind::DevServer,
            command: "pnpm dev".into(),
            working_directory: ".".into(),
            env: vec![RunConfigurationEnvVar {
                name: "PORT".into(),
                value: "5173".into(),
            }],
            setup_command: Some("pnpm install".into()),
            setup_policy: RunSetupPolicy::OncePerWorktree,
            url_auto_detect: true,
            fallback_urls: vec!["http://localhost:5173".into()],
            auto_open_first_url: false,
            generation: 1,
            updated_at_epoch_ms: 0,
        }
    }

    #[test]
    fn run_configuration_accepts_a_bounded_complete_value() {
        assert!(configuration().is_valid());
    }

    #[test]
    fn run_configuration_rejects_blank_or_oversized_fields() {
        for mutate in [
            (|value: &mut RunConfiguration| value.id = "  ".into()) as fn(&mut RunConfiguration),
            |value| value.id = "x".repeat(RUN_CONFIGURATION_ID_MAX_BYTES + 1),
            |value| value.project_id = String::new(),
            |value| value.name = " ".into(),
            |value| value.name = "x".repeat(RUN_CONFIGURATION_NAME_MAX_BYTES + 1),
            |value| value.command = "\n".into(),
            |value| value.command = "x".repeat(RUN_CONFIGURATION_COMMAND_MAX_BYTES + 1),
            |value| value.command = "echo \0".into(),
            |value| value.working_directory = String::new(),
            |value| value.setup_command = Some("  ".into()),
            |value| value.generation = 0,
        ] {
            let mut value = configuration();
            mutate(&mut value);
            assert!(!value.is_valid(), "expected invalid: {value:?}");
        }
    }

    #[test]
    fn run_configuration_env_names_are_identifier_shaped_and_unique() {
        let mut value = configuration();
        value.env = vec![RunConfigurationEnvVar {
            name: "1BAD".into(),
            value: String::new(),
        }];
        assert!(!value.is_valid());
        value.env = vec![RunConfigurationEnvVar {
            name: "A=B".into(),
            value: String::new(),
        }];
        assert!(!value.is_valid());
        value.env = vec![
            RunConfigurationEnvVar {
                name: "PORT".into(),
                value: "1".into(),
            },
            RunConfigurationEnvVar {
                name: "PORT".into(),
                value: "2".into(),
            },
        ];
        assert!(!value.is_valid());
        value.env = vec![RunConfigurationEnvVar {
            name: "_OK_2".into(),
            value: "value".into(),
        }];
        assert!(value.is_valid());
    }

    #[test]
    fn run_configuration_fallback_urls_must_be_bounded_http() {
        let mut value = configuration();
        value.fallback_urls = vec!["ftp://host".into()];
        assert!(!value.is_valid());
        value.fallback_urls = vec!["http://localhost:3000 /".into()];
        assert!(!value.is_valid());
        value.fallback_urls = vec!["https://localhost:3000".into()];
        assert!(value.is_valid());
        value.fallback_urls =
            vec!["http://localhost".into(); RUN_CONFIGURATION_FALLBACK_URLS_MAX + 1];
        assert!(!value.is_valid());
    }

    #[test]
    fn run_setup_mark_requires_exact_bounded_identity() {
        let mark = RunSetupMark {
            project_id: "project-1".into(),
            configuration_id: "dev-server".into(),
            worktree_path: "/work/tree".into(),
            configuration_generation: 1,
            completed_at_epoch_ms: 1,
        };
        assert!(mark.is_valid());
        assert!(
            !RunSetupMark {
                configuration_generation: 0,
                ..mark.clone()
            }
            .is_valid()
        );
        assert!(
            !RunSetupMark {
                worktree_path: " ".into(),
                ..mark
            }
            .is_valid()
        );
    }
}
