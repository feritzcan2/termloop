use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn steward_configuration_is_typed_and_capability_scoped() {
    assert!(METHODS.contains(&"steward.configurationGet"));
    assert!(METHODS.contains(&"steward.configurationSet"));
    assert!(METHODS.contains(&"steward.configurationDelete"));
    assert!(READ_ONLY_METHODS.contains(&"steward.configurationGet"));
    assert!(COMPANION_METHODS.contains(&"steward.configurationGet"));
    assert!(!READ_ONLY_METHODS.contains(&"steward.configurationSet"));
    assert!(!COMPANION_METHODS.contains(&"steward.configurationSet"));
    assert!(!READ_ONLY_METHODS.contains(&"steward.configurationDelete"));
    assert!(!COMPANION_METHODS.contains(&"steward.configurationDelete"));
    assert!(validate_method_params(
        "steward.configurationSet",
        &json!({
            "projectId":"project-1",
            "agentId":"codex",
            "model":"gpt-5.6-sol",
            "permission":"bypassPermissions",
            "reasoning":"high",
            "enabled":false,
            "systemPrompt":"You are a PM.",
            "expectedRevision":3
        })
    ));
    assert!(!validate_method_params(
        "steward.configurationSet",
        &json!({
            "projectId":"project-1",
            "agentId":"other",
            "model":"default",
            "permission":"default",
            "reasoning":"default",
            "enabled":false,
            "systemPrompt":"You are a PM.",
            "expectedRevision":3
        })
    ));
    assert!(validate_method_params(
        "steward.configurationDelete",
        &json!({"projectId":"project-1","expectedRevision":3})
    ));
    assert!(!validate_method_params(
        "steward.configurationDelete",
        &json!({"projectId":"project-1"})
    ));
}

#[test]
fn absent_and_current_configuration_results_are_strict() {
    assert!(validate_method_result(
        "steward.configurationGet",
        &json!({
            "configuration":null,
            "defaultSystemPrompt":"You are a PM.",
            "promptContext":{
                "initialPrompt":"Activate the persistent Steward.",
                "instructionsPrompt":"You are a PM. Keep updates concise.",
                "instructionDelivery":"codexDeveloperInstructions",
                "protectedPrompt":"You are a PM.",
                "wakePrompt":"Inspect current Project activity."
            },
            "supervisorAvailability":"available",
            "presence":{
                "lastActivityAtEpochMs":null,
                "activeCommandLabel":null,
                "pendingProposal":false
            },
            "stateRevision":3
        })
    ));
    assert!(!validate_method_result(
        "steward.configurationGet",
        &json!({"configuration":null,"defaultSystemPrompt":"PM","supervisorAvailability":"available","stateRevision":3})
    ));
    let protected_prompt = "p".repeat(32 * 1024);
    assert!(validate_method_result(
        "steward.configurationGet",
        &json!({
            "configuration":null,
            "defaultSystemPrompt":protected_prompt,
            "promptContext":{
                "initialPrompt":"Activate the persistent Steward.",
                "instructionsPrompt":"You are a PM. Keep updates concise.",
                "instructionDelivery":"codexDeveloperInstructions",
                "protectedPrompt":protected_prompt,
                "wakePrompt":"Inspect current Project activity."
            },
            "supervisorAvailability":"available",
            "presence":{
                "lastActivityAtEpochMs":null,
                "activeCommandLabel":null,
                "pendingProposal":false
            },
            "stateRevision":3
        })
    ));
    let oversized_protected_prompt = "p".repeat((32 * 1024) + 1);
    assert!(!validate_method_result(
        "steward.configurationGet",
        &json!({
            "configuration":null,
            "defaultSystemPrompt":oversized_protected_prompt,
            "promptContext":{
                "initialPrompt":"Activate the persistent Steward.",
                "instructionsPrompt":"You are a PM. Keep updates concise.",
                "instructionDelivery":"codexDeveloperInstructions",
                "protectedPrompt":"You are a PM.",
                "wakePrompt":"Inspect current Project activity."
            },
            "supervisorAvailability":"available",
            "presence":{
                "lastActivityAtEpochMs":null,
                "activeCommandLabel":null,
                "pendingProposal":false
            },
            "stateRevision":3
        })
    ));
    assert!(validate_method_result(
        "steward.configurationSet",
        &json!({
            "configuration":{
                "projectId":"project-1",
                "agentId":"claude",
                "model":"sonnet",
                "permission":"acceptEdits",
                "reasoning":"medium",
                "enabled":true,
                "systemPrompt":"You are a PM.",
                "executorSessionId":null,
                "playbookEvaluator":{"codexModel":null,"claudeModel":null,"permission":"plan"},
                "generation":1,
                "updatedAtEpochMs":10
            },
            "stateRevision":4
        })
    ));
    assert!(validate_method_result(
        "steward.configurationDelete",
        &json!({
            "projectId":"project-1",
            "deleted":true,
            "deletedRoutines":3,
            "deletedSessions":4,
            "deletedMessages":5,
            "playbookDeleted":true,
            "stateRevision":6
        })
    ));
    assert!(!validate_method_result(
        "steward.configurationDelete",
        &json!({
            "projectId":"project-1",
            "deleted":true,
            "deletedRoutines":3,
            "deletedSessions":4,
            "deletedMessages":5,
            "playbookDeleted":true
        })
    ));
}

#[test]
fn steward_auto_compaction_is_optional_and_bounded_per_provider_unit() {
    let params = |auto_compaction: serde_json::Value| {
        let mut params = json!({
            "projectId":"project-1",
            "agentId":"claude",
            "model":"default",
            "permission":"bypassPermissions",
            "reasoning":"default",
            "enabled":true,
            "systemPrompt":"",
            "expectedRevision":1
        });
        if !auto_compaction.is_null() {
            params["autoCompaction"] = auto_compaction;
        }
        params
    };
    // Older clients omit the field and keep the saved value.
    assert!(validate_method_params("steward.configurationSet", &params(json!(null))));
    for (claude, codex, valid) in [
        (250_000, 90, true),
        (100_000, 1, true),
        (1_000_000, 100, true),
        (99_999, 90, false),
        (1_000_001, 90, false),
        (250_000, 0, false),
        (250_000, 101, false),
    ] {
        assert_eq!(
            validate_method_params(
                "steward.configurationSet",
                &params(json!({"claudeWindowTokens":claude,"codexThresholdPercent":codex})),
            ),
            valid,
            "{claude} {codex}"
        );
    }
    assert!(!validate_method_params(
        "steward.configurationSet",
        &params(json!({"claudeWindowTokens":250_000})),
    ));
    assert!(validate_method_result(
        "steward.configurationSet",
        &json!({
            "configuration":{
                "projectId":"project-1",
                "agentId":"codex",
                "model":"default",
                "permission":"bypassPermissions",
                "reasoning":"default",
                "enabled":true,
                "systemPrompt":"",
                "executorSessionId":null,
                "playbookEvaluator":{"codexModel":null,"claudeModel":null,"permission":"plan"},
                "autoCompaction":{"claudeWindowTokens":250_000,"codexThresholdPercent":90},
                "generation":1,
                "updatedAtEpochMs":10
            },
            "stateRevision":4
        })
    ));
}
