use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexPermissionMode {
    Default,
    AcceptEdits,
    Plan,
    BypassPermissions,
}

impl CodexPermissionMode {
    pub fn as_launch_selection(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::BypassPermissions => "bypassPermissions",
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CodexThreadSettingsObservation {
    pub native_thread_id: String,
    pub model: Option<String>,
    pub permission: CodexPermissionMode,
    pub reasoning: Option<String>,
}

impl std::fmt::Debug for CodexThreadSettingsObservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CodexThreadSettingsObservation")
            .field("native_thread_id", &"<private>")
            .field("model", &self.model)
            .field("permission", &self.permission)
            .field("reasoning", &self.reasoning)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSettingsUpdatedNotification {
    method: String,
    params: ThreadSettingsUpdatedParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSettingsUpdatedParams {
    thread_id: String,
    thread_settings: ObservedThreadSettings,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObservedThreadSettings {
    approval_policy: ApprovalPolicy,
    approvals_reviewer: ApprovalsReviewer,
    sandbox_policy: SandboxPolicy,
    active_permission_profile: Option<ActivePermissionProfile>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: ObservedReasoningEffort,
}

#[derive(Default)]
enum ObservedReasoningEffort {
    #[default]
    Missing,
    Default,
    Value(String),
}

impl<'de> Deserialize<'de> for ObservedReasoningEffort {
    fn deserialize<Deserializer>(deserializer: Deserializer) -> Result<Self, Deserializer::Error>
    where
        Deserializer: serde::Deserializer<'de>,
    {
        Ok(match Option::<String>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Default,
        })
    }
}

#[derive(Deserialize, PartialEq, Eq)]
enum ApprovalPolicy {
    #[serde(rename = "untrusted")]
    Untrusted,
    #[serde(rename = "on-request")]
    OnRequest,
    #[serde(rename = "never")]
    Never,
}

#[derive(Deserialize, PartialEq, Eq)]
enum ApprovalsReviewer {
    #[serde(rename = "user")]
    User,
    #[serde(rename = "auto_review")]
    AutoReview,
    #[serde(rename = "guardian_subagent")]
    GuardianSubagent,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
enum SandboxPolicy {
    #[serde(rename = "dangerFullAccess")]
    DangerFullAccess,
    #[serde(rename = "readOnly")]
    ReadOnly,
    #[serde(rename = "workspaceWrite")]
    WorkspaceWrite,
    #[serde(rename = "externalSandbox")]
    ExternalSandbox,
}

#[derive(Deserialize)]
struct ActivePermissionProfile {
    id: String,
}

pub fn normalize_codex_thread_settings(raw: &str) -> Option<CodexThreadSettingsObservation> {
    let notification: ThreadSettingsUpdatedNotification = serde_json::from_str(raw).ok()?;
    if notification.method != "thread/settings/updated"
        || notification.params.thread_id.is_empty()
        || notification.params.thread_id.len() > termloop_domain::ResumeRef::MAX_NATIVE_ID_BYTES
        || notification.params.thread_id.chars().any(char::is_control)
    {
        return None;
    }

    let settings = notification.params.thread_settings;
    let permission = match (
        settings.approval_policy,
        settings.approvals_reviewer,
        settings.sandbox_policy,
    ) {
        (ApprovalPolicy::Never, ApprovalsReviewer::User, SandboxPolicy::DangerFullAccess) => {
            CodexPermissionMode::BypassPermissions
        }
        (ApprovalPolicy::OnRequest, ApprovalsReviewer::User, SandboxPolicy::ReadOnly) => {
            CodexPermissionMode::Plan
        }
        (
            ApprovalPolicy::OnRequest | ApprovalPolicy::Untrusted,
            ApprovalsReviewer::User,
            SandboxPolicy::WorkspaceWrite,
        ) => CodexPermissionMode::Default,
        (
            ApprovalPolicy::OnRequest | ApprovalPolicy::Untrusted,
            ApprovalsReviewer::AutoReview,
            SandboxPolicy::WorkspaceWrite,
        ) => CodexPermissionMode::AcceptEdits,
        _ => return None,
    };

    let compatible_profile = settings.active_permission_profile.is_none_or(|profile| {
        matches!(
            (profile.id.as_str(), permission),
            (
                ":danger-full-access",
                CodexPermissionMode::BypassPermissions
            ) | (":read-only", CodexPermissionMode::Plan)
                | (":workspace", CodexPermissionMode::Default)
        )
    });
    compatible_profile.then(|| CodexThreadSettingsObservation {
        native_thread_id: notification.params.thread_id,
        model: settings.model.filter(|model| {
            matches!(
                model.as_str(),
                "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.5-pro"
            )
        }),
        permission,
        reasoning: match settings.effort {
            ObservedReasoningEffort::Missing => None,
            ObservedReasoningEffort::Default => Some("default".into()),
            ObservedReasoningEffort::Value(reasoning)
                if matches!(
                    reasoning.as_str(),
                    "low" | "medium" | "high" | "xhigh" | "max"
                ) =>
            {
                Some(reasoning)
            }
            ObservedReasoningEffort::Value(_) => None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notification(settings: &str) -> String {
        format!(
            r#"{{"method":"thread/settings/updated","params":{{"threadId":"thread-a","threadSettings":{{{settings},"cwd":"/tmp","model":"gpt-5.6-sol"}}}}}}"#
        )
    }

    #[test]
    fn maps_only_replayable_builtin_permission_settings() {
        let cases = [
            (
                r#""approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":{"id":":danger-full-access","extends":null}"#,
                CodexPermissionMode::BypassPermissions,
            ),
            (
                r#""approvalPolicy":"on-request","approvalsReviewer":"user","sandboxPolicy":{"type":"readOnly","networkAccess":false},"activePermissionProfile":{"id":":read-only","extends":null}"#,
                CodexPermissionMode::Plan,
            ),
            (
                r#""approvalPolicy":"on-request","approvalsReviewer":"user","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":{"id":":workspace","extends":null}"#,
                CodexPermissionMode::Default,
            ),
            (
                r#""approvalPolicy":"on-request","approvalsReviewer":"auto_review","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":null"#,
                CodexPermissionMode::AcceptEdits,
            ),
        ];

        for (settings, expected) in cases {
            assert_eq!(
                normalize_codex_thread_settings(&notification(settings)),
                Some(CodexThreadSettingsObservation {
                    native_thread_id: "thread-a".into(),
                    model: Some("gpt-5.6-sol".into()),
                    permission: expected,
                    reasoning: None,
                })
            );
        }
    }

    #[test]
    fn captures_only_replayable_model_and_reasoning_settings() {
        let observed = normalize_codex_thread_settings(&notification(
            r#""approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":{"id":":danger-full-access","extends":null},"effort":"xhigh""#,
        ))
        .unwrap();
        assert_eq!(observed.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(observed.reasoning.as_deref(), Some("xhigh"));

        let reset = notification(
            r#""approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":{"id":":danger-full-access","extends":null},"effort":null"#,
        );
        assert_eq!(
            normalize_codex_thread_settings(&reset)
                .unwrap()
                .reasoning
                .as_deref(),
            Some("default")
        );

        let unsupported = notification(
            r#""approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":{"id":":danger-full-access","extends":null},"effort":"ultra""#,
        )
        .replace("gpt-5.6-sol", "future-model");
        let observed = normalize_codex_thread_settings(&unsupported).unwrap();
        assert_eq!(observed.model, None);
        assert_eq!(observed.reasoning, None);
    }

    #[test]
    fn refuses_custom_or_non_replayable_permission_settings() {
        for settings in [
            r#""approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":null"#,
            r#""approvalPolicy":"never","approvalsReviewer":"user","sandboxPolicy":{"type":"dangerFullAccess"},"activePermissionProfile":{"id":"company-full-access","extends":":danger-full-access"}"#,
            r#""approvalPolicy":"on-request","approvalsReviewer":"guardian_subagent","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":null"#,
            r#""approvalPolicy":{"granular":{}},"approvalsReviewer":"user","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false},"activePermissionProfile":null"#,
        ] {
            assert!(normalize_codex_thread_settings(&notification(settings)).is_none());
        }
        assert!(normalize_codex_thread_settings("not json").is_none());
    }

    #[test]
    fn native_thread_identity_is_redacted_from_debug_output() {
        let observation = CodexThreadSettingsObservation {
            native_thread_id: "private-thread-id".into(),
            model: Some("gpt-5.6-sol".into()),
            permission: CodexPermissionMode::BypassPermissions,
            reasoning: Some("high".into()),
        };
        let debug = format!("{observation:?}");
        assert!(!debug.contains("private-thread-id"));
        assert!(debug.contains("<private>"));
    }
}
