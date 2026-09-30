fn configure_opencode_launch(
    target: &termloop_platform::ResolvedLaunchTarget,
    arguments: &mut Vec<ResolvedArgument>,
    environment: &mut termloop_platform::LaunchEnvironment,
    model: &str,
    permission: &str,
    reasoning: &str,
) {
    let server_configuration = termloop_agents::opencode_uses_server_configuration(target, environment);
    let mut config = serde_json::Map::new();
    if server_configuration && model != "default" {
        config.insert("model".into(), model.into());
        arguments.retain(|argument| argument.purpose != "model selection");
    }
    if server_configuration && permission == "plan" {
        config.insert("default_agent".into(), "plan".into());
        arguments.retain(|argument| argument.purpose != "permission selection");
    }
    if reasoning != "default" {
        let (provider, model_id) = model.split_once('/').expect("validated explicit OpenCode model");
        let settings = match reasoning {
            "none" => serde_json::json!({"thinking": {"type": "disabled"}}),
            "thinking" => serde_json::json!({"thinking": {"type": "adaptive"}}),
            _ => serde_json::json!({"reasoningEffort": reasoning}),
        };
        if server_configuration {
            config.insert("providers".into(), serde_json::json!({provider: {"models": {model_id: {"settings": settings}}}}));
        } else {
            config.insert("provider".into(), serde_json::json!({provider: {"models": {model_id: {"options": settings}}}}));
        }
    }
    if config.is_empty() {
        return;
    }
    // The shared v2 server has its own environment. A private server is needed
    // for this launch's selection to apply without changing other Sessions.
    if server_configuration {
        arguments.push(ResolvedArgument::exact(
            "--standalone",
            "launch-scoped OpenCode configuration",
        ));
    }
    *environment = environment.clone().with_explicit(
        "OPENCODE_CONFIG_CONTENT",
        serde_json::Value::Object(config).to_string(),
    );
}
