fn configure_opencode_launch(
    target: &termloop_platform::ResolvedLaunchTarget,
    arguments: &mut Vec<ResolvedArgument>,
    environment: &mut termloop_platform::LaunchEnvironment,
    model: &str,
    permission: &str,
) {
    if !termloop_agents::opencode_uses_server_configuration(target, environment) {
        return;
    }
    let mut config = serde_json::Map::new();
    if model != "default" {
        config.insert("model".into(), model.into());
        arguments.retain(|argument| argument.purpose != "model selection");
    }
    if permission == "plan" {
        config.insert("default_agent".into(), "plan".into());
        arguments.retain(|argument| argument.purpose != "permission selection");
    }
    if config.is_empty() {
        return;
    }
    // The shared v2 server has its own environment. A private server is needed
    // for this launch's selection to apply without changing other Sessions.
    arguments.push(ResolvedArgument::exact(
        "--standalone",
        "launch-scoped OpenCode configuration",
    ));
    *environment = environment.clone().with_explicit(
        "OPENCODE_CONFIG_CONTENT",
        serde_json::Value::Object(config).to_string(),
    );
}
