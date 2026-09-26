pub fn validate_agent_configuration(
    agent_id: &str,
    model: &str,
    permission: &str,
    reasoning: &str,
) -> Result<(), InvocationError> {
    model_args(agent_id, model)?;
    permission_args(agent_id, permission)?;
    reasoning_args(agent_id, reasoning).map(|_| ())
}

fn model_args(agent_id: &str, model: &str) -> Result<Vec<String>, InvocationError> {
    match (agent_id, model) {
        ("claude" | "codex" | "gemini", "default") => Ok(vec![]),
        ("claude", "opus[1m]" | "fable" | "sonnet" | "haiku" | "opus")
        | (
            "codex",
            "gpt-6-astra" | "gpt-6-sol" | "gpt-6-luna" | "gpt-5.6-sol" | "gpt-5.6-terra"
            | "gpt-5.6-luna" | "gpt-5.5" | "gpt-5.5-pro",
        ) => Ok(vec!["--model".into(), model.into()]),
        ("gemini", "auto" | "pro" | "flash" | "flash-lite") => Ok(vec!["-m".into(), model.into()]),
        ("claude" | "codex" | "gemini", _) => Err(InvocationError::UnsupportedModel {
            agent_id: agent_id.to_owned(),
            model: model.to_owned(),
        }),
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}

fn reasoning_args(agent_id: &str, reasoning: &str) -> Result<Vec<String>, InvocationError> {
    match (agent_id, reasoning) {
        ("claude" | "codex" | "gemini", "default") => Ok(vec![]),
        ("claude", "low" | "medium" | "high" | "xhigh" | "max") => {
            Ok(vec!["--effort".into(), reasoning.into()])
        }
        ("codex", "low" | "medium" | "high" | "xhigh" | "max") => Ok(vec![
            "-c".into(),
            format!("model_reasoning_effort=\"{reasoning}\""),
        ]),
        ("claude" | "codex" | "gemini", _) => Err(InvocationError::UnsupportedReasoning {
            agent_id: agent_id.to_owned(),
            reasoning: reasoning.to_owned(),
        }),
        _ => Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    }
}

fn permission_args(agent_id: &str, permission: &str) -> Result<Vec<String>, InvocationError> {
    let args = match (agent_id, permission) {
        ("claude", "default") => vec!["--permission-mode".into(), "default".into()],
        // Claude renamed accept-edits to `auto`. Passing the legacy name still
        // launches, but the TUI then labels the Session "accept edits" while
        // TermLoop calls it auto, and an unchanged mode reads as a mode the
        // user never picked. The stored selection keeps its contract value.
        ("claude", "acceptEdits") => vec!["--permission-mode".into(), "auto".into()],
        ("claude", "plan") => vec!["--permission-mode".into(), permission.into()],
        ("claude", "bypassPermissions") => vec!["--dangerously-skip-permissions".into()],
        ("codex", "default") => vec![],
        // `--approve-for-me` already selects the workspace-write sandbox.
        // Current Codex releases reject combining it with an explicit
        // `--sandbox workspace-write` argument.
        ("codex", "acceptEdits") => vec!["--approve-for-me".into()],
        ("codex", "plan") => vec![
            "--sandbox".into(),
            "read-only".into(),
            "--ask-for-approval".into(),
            "on-request".into(),
        ],
        ("codex", "bypassPermissions") => {
            vec!["--dangerously-bypass-approvals-and-sandbox".into()]
        }
        ("gemini", "default") => vec![],
        ("gemini", "acceptEdits") => {
            vec!["--approval-mode".into(), "auto_edit".into()]
        }
        ("gemini", "plan") => vec!["--approval-mode".into(), "plan".into()],
        ("gemini", "bypassPermissions") => {
            vec!["--approval-mode".into(), "yolo".into()]
        }
        ("claude" | "codex" | "gemini", _) => {
            return Err(InvocationError::UnsupportedPermission {
                agent_id: agent_id.to_owned(),
                permission: permission.to_owned(),
            });
        }
        _ => return Err(InvocationError::UnsupportedAgent(agent_id.to_owned())),
    };
    Ok(args)
}
