use crate::{
    AgentPendingWakes, AgentPlanUpdate, AgentSignal, AgentSignalSource, AgentSubagentUpdate,
    BuiltinAgentAdapter, agent_descriptor,
};
use termloop_domain::{ResumeProvider, ResumeRef};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderObservationIngress {
    LaunchScopedHook,
    DaemonOwnedBridge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHookObservationInput {
    pub event_name: String,
    pub notification_type: Option<String>,
    pub native_session_id: Option<String>,
    pub provider_model_id: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
    pub transcript_path: Option<String>,
    pub prompt_id: Option<String>,
    pub plan: Option<AgentPlanUpdate>,
    pub pending_wakes: Option<AgentPendingWakes>,
    pub subagent: Option<AgentSubagentUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderTurnWatch {
    pub transcript_path: String,
    pub prompt_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedProviderObservation {
    pub ingress: ProviderObservationIngress,
    pub signal: AgentSignal,
    pub source: AgentSignalSource,
    pub resume_ref: Option<ResumeRef>,
    pub provider_model_id: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
    pub turn_watch: Option<ProviderTurnWatch>,
    pub plan: Option<AgentPlanUpdate>,
    pub pending_wakes: Option<AgentPendingWakes>,
    pub subagent: Option<AgentSubagentUpdate>,
}

pub fn normalize_provider_hook_observation(
    agent_id: &str,
    input: ProviderHookObservationInput,
) -> Option<NormalizedProviderObservation> {
    let descriptor = agent_descriptor(agent_id)?;
    match descriptor.adapter {
        BuiltinAgentAdapter::Claude => normalize_claude_hook(input),
        BuiltinAgentAdapter::Gemini => normalize_gemini_hook(input),
        BuiltinAgentAdapter::OpenCode => normalize_opencode_hook(input),
        BuiltinAgentAdapter::Codex => None,
    }
}

fn normalize_claude_hook(
    input: ProviderHookObservationInput,
) -> Option<NormalizedProviderObservation> {
    let signal = subagent_scoped_signal(
        crate::normalize_hook_event(&input.event_name, input.notification_type.as_deref())?,
        input.subagent.as_ref(),
    );
    let resume_ref = input
        .native_session_id
        .as_deref()
        .and_then(|value| ResumeRef::for_provider(ResumeProvider::Claude, canonical_uuid(value)?));
    let turn_watch = (input.event_name == "UserPromptSubmit")
        .then(|| {
            Some(ProviderTurnWatch {
                transcript_path: input.transcript_path?,
                prompt_id: input.prompt_id?,
            })
        })
        .flatten();
    Some(NormalizedProviderObservation {
        ingress: ProviderObservationIngress::LaunchScopedHook,
        signal,
        source: AgentSignalSource::Hook,
        resume_ref,
        provider_model_id: input.provider_model_id,
        permission_mode: input.permission_mode,
        reasoning_level: input.reasoning_level,
        turn_watch,
        plan: input.plan,
        pending_wakes: input.pending_wakes,
        subagent: input.subagent,
    })
}

fn normalize_gemini_hook(
    input: ProviderHookObservationInput,
) -> Option<NormalizedProviderObservation> {
    let signal = match input.event_name.as_str() {
        "SessionStart" => AgentSignal::SessionStarted,
        "BeforeAgent" => AgentSignal::PromptSubmitted,
        "BeforeTool" => AgentSignal::ToolStarted,
        "AfterTool" => AgentSignal::ToolFinished,
        "Notification" if input.notification_type.as_deref() == Some("ToolPermission") => {
            AgentSignal::PermissionRequested
        }
        "Notification" => AgentSignal::Notification,
        "PreCompress" => AgentSignal::CompactStarted,
        "AfterAgent" => AgentSignal::Stopped,
        "SessionEnd" => AgentSignal::SessionEnded,
        _ => return None,
    };
    let resume_ref = input
        .native_session_id
        .as_deref()
        .and_then(|value| ResumeRef::for_provider(ResumeProvider::Gemini, canonical_uuid(value)?));
    Some(NormalizedProviderObservation {
        ingress: ProviderObservationIngress::LaunchScopedHook,
        signal,
        source: AgentSignalSource::Hook,
        resume_ref,
        provider_model_id: input.provider_model_id,
        permission_mode: None,
        reasoning_level: None,
        turn_watch: None,
        plan: None,
        pending_wakes: None,
        subagent: None,
    })
}

fn normalize_opencode_hook(
    input: ProviderHookObservationInput,
) -> Option<NormalizedProviderObservation> {
    let signal = match input.event_name.as_str() {
        "OpenCodeSessionStart" => AgentSignal::SessionStarted,
        "OpenCodeWorking" => AgentSignal::PromptSubmitted,
        "OpenCodeIdle" => AgentSignal::Stopped,
        "OpenCodePermission" => AgentSignal::PermissionRequested,
        "OpenCodeError" => AgentSignal::Failed,
        "OpenCodeSessionEnd" => AgentSignal::SessionEnded,
        _ => return None,
    };
    let resume_ref = input
        .native_session_id
        .and_then(|id| ResumeRef::for_provider(ResumeProvider::Opencode, id));
    Some(NormalizedProviderObservation {
        ingress: ProviderObservationIngress::LaunchScopedHook,
        signal,
        source: AgentSignalSource::Hook,
        resume_ref,
        provider_model_id: None,
        permission_mode: None,
        reasoning_level: None,
        turn_watch: None,
        plan: None,
        pending_wakes: None,
        subagent: None,
    })
}

/// A hook carrying a child's `agent_id` reports that child, not the lead turn.
/// Attention requests still surface, because the user must answer them.
fn subagent_scoped_signal(
    signal: AgentSignal,
    subagent: Option<&AgentSubagentUpdate>,
) -> AgentSignal {
    match (subagent, signal) {
        (
            Some(AgentSubagentUpdate::Active { .. }),
            AgentSignal::ToolStarted | AgentSignal::ToolFinished,
        ) => AgentSignal::SubagentActivity,
        (Some(AgentSubagentUpdate::Stopped { .. }), AgentSignal::Failed) => {
            AgentSignal::AmbientNotification
        }
        _ => signal,
    }
}

fn canonical_uuid(value: &str) -> Option<String> {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|value| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(event_name: &str) -> ProviderHookObservationInput {
        ProviderHookObservationInput {
            event_name: event_name.into(),
            notification_type: None,
            native_session_id: None,
            provider_model_id: None,
            permission_mode: None,
            reasoning_level: None,
            transcript_path: None,
            prompt_id: None,
            plan: None,
            pending_wakes: None,
            subagent: None,
        }
    }

    #[test]
    fn provider_adapters_have_distinct_event_contracts() {
        assert_eq!(
            normalize_provider_hook_observation("claude", input("UserPromptSubmit"))
                .unwrap()
                .signal,
            AgentSignal::PromptSubmitted
        );
        assert!(normalize_provider_hook_observation("gemini", input("UserPromptSubmit")).is_none());
        assert_eq!(
            normalize_provider_hook_observation("gemini", input("BeforeAgent"))
                .unwrap()
                .signal,
            AgentSignal::PromptSubmitted
        );
        assert!(normalize_provider_hook_observation("codex", input("BeforeAgent")).is_none());
    }

    fn child(event_name: &str, subagent: AgentSubagentUpdate) -> AgentSignal {
        let mut hook = input(event_name);
        hook.subagent = Some(subagent);
        normalize_provider_hook_observation("claude", hook)
            .unwrap()
            .signal
    }

    #[test]
    fn claude_subagent_hooks_do_not_drive_the_lead_turn() {
        let active = || AgentSubagentUpdate::Active {
            key: "subagent:a1".into(),
            agent_type: None,
            activity: None,
        };
        assert_eq!(child("PreToolUse", active()), AgentSignal::SubagentActivity);
        assert_eq!(
            child("PostToolUse", active()),
            AgentSignal::SubagentActivity
        );
        assert_eq!(
            child("PermissionRequest", active()),
            AgentSignal::PermissionRequested
        );
        assert_eq!(
            child(
                "StopFailure",
                AgentSubagentUpdate::Stopped {
                    key: "subagent:a1".into()
                }
            ),
            AgentSignal::AmbientNotification
        );
        assert_eq!(
            normalize_provider_hook_observation("claude", input("PreToolUse"))
                .unwrap()
                .signal,
            AgentSignal::ToolStarted
        );
    }

    #[test]
    fn gemini_permission_notification_is_attention_bearing() {
        let mut hook = input("Notification");
        hook.notification_type = Some("ToolPermission".into());
        assert_eq!(
            normalize_provider_hook_observation("gemini", hook)
                .unwrap()
                .signal,
            AgentSignal::PermissionRequested
        );
    }

    #[test]
    fn compatible_event_names_cannot_cross_provider_contracts() {
        let native_session_id = "019f1dae-3bf3-73d1-b3c7-08ddbbd1f035";
        let mut claude = input("SessionStart");
        claude.native_session_id = Some(native_session_id.into());
        let mut gemini = input("SessionStart");
        gemini.native_session_id = Some(native_session_id.into());
        assert_eq!(
            normalize_provider_hook_observation("claude", claude)
                .unwrap()
                .resume_ref
                .unwrap()
                .provider,
            ResumeProvider::Claude
        );
        assert_eq!(
            normalize_provider_hook_observation("gemini", gemini)
                .unwrap()
                .resume_ref
                .unwrap()
                .provider,
            ResumeProvider::Gemini
        );
    }

    #[test]
    fn opencode_events_have_a_bounded_resume_identity_and_distinct_statuses() {
        let mut started = input("OpenCodeSessionStart");
        started.native_session_id = Some("ses_abc123".into());
        let normalized = normalize_provider_hook_observation("opencode", started).unwrap();
        assert_eq!(normalized.signal, AgentSignal::SessionStarted);
        assert_eq!(
            normalized.resume_ref.unwrap().provider,
            ResumeProvider::Opencode
        );
        for (event, signal) in [
            ("OpenCodeWorking", AgentSignal::PromptSubmitted),
            ("OpenCodeIdle", AgentSignal::Stopped),
            ("OpenCodePermission", AgentSignal::PermissionRequested),
            ("OpenCodeError", AgentSignal::Failed),
            ("OpenCodeSessionEnd", AgentSignal::SessionEnded),
        ] {
            assert_eq!(
                normalize_provider_hook_observation("opencode", input(event))
                    .unwrap()
                    .signal,
                signal
            );
            assert!(normalize_provider_hook_observation("claude", input(event)).is_none());
        }
        let mut invalid = input("OpenCodeSessionStart");
        invalid.native_session_id = Some("ses_bad/id".into());
        assert!(
            normalize_provider_hook_observation("opencode", invalid)
                .unwrap()
                .resume_ref
                .is_none()
        );
    }
}
