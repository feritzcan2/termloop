use serde_json::json;
use termloop_contract::current::{
    MCP_HELPER_TOOLS, MCP_INTERACTIVE_TOOLS, MCP_PLAYBOOK_EVALUATOR_TOOLS, MCP_STEWARD_TOOLS,
    validate_mcp_tool_params,
};

#[test]
fn steward_accepts_optional_bounded_evaluator_settings() {
    use termloop_contract::current::validate_method_params;
    let mut params = json!({"projectId":"project", "agentId":"codex", "model":"gpt-6-astra",
        "permission":"bypassPermissions", "reasoning":"high", "enabled":true,
        "systemPrompt":"", "expectedRevision":1});
    assert!(validate_method_params("steward.configurationSet", &params));
    params["playbookEvaluator"] =
        json!({"codexModel":"gpt-6-luna", "claudeModel":null, "permission":"default"});
    assert!(validate_method_params("steward.configurationSet", &params));
    for invalid in [
        json!({"codexModel":null,"claudeModel":null,"permission":"unknown"}),
        json!({"codexModel":"","claudeModel":null,"permission":"plan"}),
        json!({"codexModel":null,"claudeModel":null,"permission":"plan","agentId":"claude"}),
    ] {
        params["playbookEvaluator"] = invalid;
        assert!(!validate_method_params("steward.configurationSet", &params));
    }
}

#[test]
fn playbook_runtime_exposes_bounded_current_evaluation_routing() {
    use termloop_contract::current::validate_method_result;
    let mut runtime = json!({
        "activePipelineName":"Delivery", "processingTaskId":"task", "steps":[],
        "doneTaskIds":[], "stateRevision":1,
        "evaluation": {"routineId":"routine", "taskId":"task", "mode":"taskAgentFork",
            "sessionId":"fork", "sourceSessionId":"source", "reason":null}
    });
    assert!(validate_method_result("playbook.runtime", &runtime));
    runtime["evaluation"]["mode"] = json!("stewardFallback");
    runtime["evaluation"]["reason"] = json!("forkUnavailable");
    assert!(validate_method_result("playbook.runtime", &runtime));
    runtime["evaluation"]["reason"] = json!("arbitrary provider output");
    assert!(!validate_method_result("playbook.runtime", &runtime));
    runtime["evaluation"]["reason"] = json!(null);
    runtime["evaluation"]["nativeSessionId"] = json!("private-conversation");
    assert!(!validate_method_result("playbook.runtime", &runtime));
    runtime["evaluation"] = json!(null);
    assert!(validate_method_result("playbook.runtime", &runtime));
}

#[test]
fn evaluator_has_only_its_scoped_read_and_report_and_no_arbitrary_target_parameters() {
    assert_eq!(
        MCP_PLAYBOOK_EVALUATOR_TOOLS,
        ["playbook_evaluation_read", "playbook_evaluation_complete"]
    );
    for tool in MCP_PLAYBOOK_EVALUATOR_TOOLS {
        assert!(!MCP_INTERACTIVE_TOOLS.contains(tool));
        assert!(!MCP_HELPER_TOOLS.contains(tool));
        assert!(!MCP_STEWARD_TOOLS.contains(tool));
    }
    assert!(validate_mcp_tool_params(
        "playbook_evaluation_read",
        &json!({})
    ));
    assert!(!validate_mcp_tool_params(
        "playbook_evaluation_read",
        &json!({"taskId":"other"})
    ));
    let report = json!({"checkId":"check", "status":"satisfied", "evidence":"PR 42 at commit abc; checks passed"});
    assert!(validate_mcp_tool_params(
        "playbook_evaluation_complete",
        &report
    ));
    for (key, value) in [
        ("taskId", json!("other")),
        ("sessionId", json!("source")),
        ("evidence", json!("a".repeat(601))),
        ("status", json!("approved")),
    ] {
        let mut invalid = report.clone();
        invalid[key] = value;
        assert!(!validate_mcp_tool_params(
            "playbook_evaluation_complete",
            &invalid
        ));
    }
}

#[test]
fn evaluation_evidence_limit_counts_utf8_bytes_for_every_verdict() {
    for status in ["satisfied", "pending", "blocked"] {
        for (evidence, valid) in [
            ("a".repeat(600), true),
            ("ş".repeat(300), true),
            ("ş".repeat(301), false),
            ("a".repeat(1239), false),
        ] {
            assert_eq!(
                validate_mcp_tool_params(
                    "playbook_evaluation_complete",
                    &json!({"checkId":"check", "status":status, "evidence":evidence}),
                ),
                valid
            );
        }
    }
}
