use crate::{
    AgentPlanUpdate, AgentSignal, AgentSignalSource, BuiltinAgentAdapter, agent_descriptor,
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
}

pub fn normalize_provider_hook_observation(
    agent_id: &str,
    input: ProviderHookObservationInput,
) -> Option<NormalizedProviderObservation> {
    let descriptor = agent_descriptor(agent_id)?;
    match descriptor.adapter {
        BuiltinAgentAdapter::Claude => normalize_claude_hook(input),
        BuiltinAgentAdapter::Gemini => normalize_gemini_hook(input),
        BuiltinAgentAdapter::Codex => None,
    }
}

fn normalize_claude_hook(
    input: ProviderHookObservationInput,
) -> Option<NormalizedProviderObservation> {
    let signal =
        crate::normalize_hook_event(&input.event_name, input.notification_type.as_deref())?;
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
    })
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
}
