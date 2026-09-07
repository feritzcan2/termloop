pub fn discover() -> Vec<crate::DiscoveredAgentCapabilities> {
    crate::discover_agent_capabilities_matching(|id| matches!(id, "codex" | "claude"))
}

pub fn prepare(
    capabilities: &[crate::DiscoveredAgentCapabilities],
) -> Result<Vec<(String, crate::AgentRuntimeCapabilities)>, crate::CoreError> {
    let mut updates = Vec::new();
    for capability in capabilities {
        if !matches!(capability.agent_id.as_str(), "codex" | "claude") {
            continue;
        }
        let observation = match capability.observation {
            crate::ObservationCapability::None => crate::AgentObservationRuntimeTransport::None,
            crate::ObservationCapability::DaemonOwnedBridge => {
                crate::AgentObservationRuntimeTransport::DaemonOwnedBridge
            }
            crate::ObservationCapability::LaunchScopedHook => {
                let executable = termloop_platform::current_executable()
                    .map_err(|_| crate::CoreError::AgentCapabilityUnproven)?;
                let settings =
                    crate::provider_hook_settings(&capability.agent_id, executable.path())
                        .map_err(|_| crate::CoreError::AgentCapabilityUnproven)?
                        .ok_or(crate::CoreError::AgentCapabilityUnproven)?;
                crate::AgentObservationRuntimeTransport::LaunchScopedConfig(
                    crate::AgentLaunchScopedConfig::InlineSettings {
                        content: settings.content,
                        inspectable_content: settings.inspectable_content,
                    },
                )
            }
        };
        updates.push((
            capability.agent_id.clone(),
            crate::AgentRuntimeCapabilities {
                observation,
                fresh_session_id_supported: capability.fresh_session_id_supported,
                resume_supported: capability.resume_supported,
                native_fork_supported: capability.native_fork_supported,
                mcp_http_supported: capability.mcp_http_supported,
            },
        ));
    }
    Ok(updates)
}

impl crate::CoreRuntime {
    pub fn refresh_agent_connections(
        &mut self,
        updates: Vec<(String, crate::AgentRuntimeCapabilities)>,
    ) {
        if let Some(transport) = self.observation_transport.as_mut() {
            for (id, capability) in updates {
                transport.agents.insert(id, capability);
            }
        }
    }
}
