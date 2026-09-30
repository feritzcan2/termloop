use super::{help_advertises_flag, probe_agent_cli};
use termloop_platform::{LaunchEnvironment, ResolvedLaunchTarget};

/// OpenCode v2 moved full-screen model/agent selection out of argv. Probe the
/// exact launch target rather than assuming every installed OpenCode is v1.
pub fn opencode_uses_server_configuration(
    target: &ResolvedLaunchTarget,
    environment: &LaunchEnvironment,
) -> bool {
    probe_agent_cli(target, environment, &["--help"]).is_ok_and(|help| {
        help.success
            && help_advertises_flag(&help.stdout, &help.stderr, "--standalone")
            && !help_advertises_flag(&help.stdout, &help.stderr, "--model")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AgentIntegrationLevel, ObservationCapability, discover_capabilities_with_environment,
    };

    #[test]
    fn v2_cli_supports_quick_action_without_claiming_observation_or_resume() {
        let directory = std::env::temp_dir().join(format!(
            "termloop-opencode-v2-capabilities-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms(),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        termloop_platform::test_support::write_cli_fixture(
            &directory,
            "opencode",
            "#!/bin/sh\ncase \"$1\" in\n--help) printf '  --standalone  Private server\\n  --session <id>  Session\\n'; exit 0 ;;\n--version) printf 'opencode v2.0.20\\n'; exit 0 ;;\nesac\nexit 1\n",
            "@echo off\r\nif \"%1\"==\"--help\" (echo   --standalone  Private server& echo   --session ^<id^>  Session& exit /b 0)\r\nif \"%1\"==\"--version\" (echo opencode v2.0.20& exit /b 0)\r\nexit /b 1\r\n",
        ).unwrap();
        let environment = LaunchEnvironment::os_baseline().with_explicit("PATH", &directory);
        let target = crate::resolve_agent_cli("opencode", &environment).unwrap();
        assert!(opencode_uses_server_configuration(&target, &environment));
        let capabilities = discover_capabilities_with_environment("opencode", &environment);
        assert!(capabilities.available);
        assert_eq!(capabilities.observation, ObservationCapability::None);
        assert_eq!(
            capabilities.integration_level(),
            AgentIntegrationLevel::LaunchOnly
        );
        assert!(!capabilities.resume_supported);
        assert!(!capabilities.native_fork_supported);
        assert!(capabilities.quick_action_supported());
        assert!(!capabilities.tracked_helpers_supported());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
