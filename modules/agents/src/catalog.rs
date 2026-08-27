/// Closed implementation dispatch for the provider adapters compiled into this
/// TermLoop build. Wire and durable identities remain bounded strings; this
/// enum keeps provider-specific code exhaustive inside the owning module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinAgentAdapter {
    Claude,
    Codex,
    Gemini,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeIdentityScope {
    Global,
    WorkingDirectory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    pub executable_candidates: &'static [&'static str],
    pub adapter: BuiltinAgentAdapter,
    /// Canonical invocation option values exposed to clients. The invocation
    /// adapter remains the validation and argv authority for every value.
    pub models: &'static [&'static str],
    pub permissions: &'static [&'static str],
    pub reasoning: &'static [&'static str],
    pub resume_identity_scope: ResumeIdentityScope,
    /// The adapter can attribute generated submissions to a newer structured
    /// provider signal. Runtime discovery may still degrade this capability.
    pub generated_input_coordination_supported: bool,
    /// The provider can host TermLoop's authenticated tracked-helper profile.
    /// Runtime MCP discovery remains the final launch authority.
    pub tracked_helpers_supported: bool,
}

const CLAUDE_EXECUTABLE_CANDIDATES: &[&str] = &["claude"];
const CODEX_EXECUTABLE_CANDIDATES: &[&str] = &["codex"];
const GEMINI_EXECUTABLE_CANDIDATES: &[&str] = &["gemini"];
const CLAUDE_MODELS: &[&str] = &["default", "opus[1m]", "fable", "sonnet", "haiku", "opus"];
const CODEX_MODELS: &[&str] = &[
    "default",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.5-pro",
];
const GEMINI_MODELS: &[&str] = &["default", "auto", "pro", "flash", "flash-lite"];
const STANDARD_PERMISSIONS: &[&str] = &["default", "acceptEdits", "plan", "bypassPermissions"];
const STANDARD_REASONING: &[&str] = &["default", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_REASONING: &[&str] = &["default"];

const AGENT_CATALOG: &[AgentDescriptor] = &[
    AgentDescriptor {
        id: "claude",
        label: "Claude",
        executable_candidates: CLAUDE_EXECUTABLE_CANDIDATES,
        adapter: BuiltinAgentAdapter::Claude,
        models: CLAUDE_MODELS,
        permissions: STANDARD_PERMISSIONS,
        reasoning: STANDARD_REASONING,
        resume_identity_scope: ResumeIdentityScope::Global,
        generated_input_coordination_supported: true,
        tracked_helpers_supported: true,
    },
    AgentDescriptor {
        id: "codex",
        label: "Codex",
        executable_candidates: CODEX_EXECUTABLE_CANDIDATES,
        adapter: BuiltinAgentAdapter::Codex,
        models: CODEX_MODELS,
        permissions: STANDARD_PERMISSIONS,
        reasoning: STANDARD_REASONING,
        resume_identity_scope: ResumeIdentityScope::Global,
        generated_input_coordination_supported: true,
        tracked_helpers_supported: true,
    },
    AgentDescriptor {
        id: "gemini",
        label: "Gemini CLI",
        executable_candidates: GEMINI_EXECUTABLE_CANDIDATES,
        adapter: BuiltinAgentAdapter::Gemini,
        models: GEMINI_MODELS,
        permissions: STANDARD_PERMISSIONS,
        reasoning: DEFAULT_REASONING,
        resume_identity_scope: ResumeIdentityScope::WorkingDirectory,
        generated_input_coordination_supported: true,
        tracked_helpers_supported: false,
    },
];

pub fn agent_catalog() -> &'static [AgentDescriptor] {
    AGENT_CATALOG
}

pub fn agent_descriptor(agent_id: &str) -> Option<&'static AgentDescriptor> {
    AGENT_CATALOG
        .iter()
        .find(|descriptor| descriptor.id == agent_id)
}

pub fn is_supported_agent(agent_id: &str) -> bool {
    agent_descriptor(agent_id).is_some()
}

pub fn supports_generated_input_coordination(agent_id: &str) -> bool {
    agent_descriptor(agent_id)
        .is_some_and(|descriptor| descriptor.generated_input_coordination_supported)
}

pub fn supports_tracked_helpers(agent_id: &str) -> bool {
    agent_descriptor(agent_id).is_some_and(|descriptor| descriptor.tracked_helpers_supported)
}

pub fn has_global_resume_identity(agent_id: &str) -> bool {
    agent_descriptor(agent_id)
        .is_some_and(|descriptor| descriptor.resume_identity_scope == ResumeIdentityScope::Global)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_identities_and_executable_candidates_are_bounded_and_unique() {
        let mut ids = HashSet::new();
        for descriptor in agent_catalog() {
            assert!(termloop_domain::agent_id_is_well_formed(descriptor.id));
            assert!(ids.insert(descriptor.id), "duplicate id {}", descriptor.id);
            assert!(!descriptor.label.trim().is_empty());
            assert!(!descriptor.executable_candidates.is_empty());

            for options in [
                descriptor.models,
                descriptor.permissions,
                descriptor.reasoning,
            ] {
                assert_eq!(options.first(), Some(&"default"));
                let mut values = HashSet::new();
                for value in options {
                    assert!(!value.trim().is_empty());
                    assert!(values.insert(value), "duplicate option {value}");
                }
            }

            let mut candidates = HashSet::new();
            for candidate in descriptor.executable_candidates {
                assert!(!candidate.trim().is_empty());
                assert!(
                    candidates.insert(candidate),
                    "duplicate candidate {candidate}"
                );
            }
        }
    }

    #[test]
    fn lookup_and_closed_adapter_dispatch_cover_the_whole_catalog() {
        assert_eq!(
            agent_descriptor("claude").map(|descriptor| descriptor.adapter),
            Some(BuiltinAgentAdapter::Claude)
        );
        assert_eq!(
            agent_descriptor("codex").map(|descriptor| descriptor.adapter),
            Some(BuiltinAgentAdapter::Codex)
        );
        assert_eq!(
            agent_descriptor("gemini").map(|descriptor| descriptor.adapter),
            Some(BuiltinAgentAdapter::Gemini)
        );
        assert_eq!(
            agent_descriptor("gemini").map(|descriptor| descriptor.resume_identity_scope),
            Some(ResumeIdentityScope::WorkingDirectory)
        );
        assert!(agent_descriptor("unknown").is_none());
        assert!(!is_supported_agent("unknown"));
        for agent_id in ["claude", "codex", "gemini"] {
            assert!(supports_generated_input_coordination(agent_id));
        }
        for agent_id in ["claude", "codex"] {
            assert!(supports_tracked_helpers(agent_id));
            assert!(has_global_resume_identity(agent_id));
        }
        assert!(!supports_tracked_helpers("gemini"));
        assert!(!has_global_resume_identity("gemini"));
        assert!(!supports_generated_input_coordination("unknown"));
        assert!(!supports_tracked_helpers("unknown"));
        assert!(!has_global_resume_identity("unknown"));
    }
}
