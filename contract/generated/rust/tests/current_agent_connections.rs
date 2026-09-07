use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params,
};

#[test]
fn account_management_is_closed_full_control_only() {
    for method in [
        "agent.authStatusList",
        "agent.install",
        "agent.authStart",
        "agent.authLogout",
        "agent.authGet",
        "agent.authCancel",
        "agent.authSubmitCode",
    ] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
    assert!(validate_method_params(
        "agent.authStart",
        &json!({"agentId":"codex"})
    ));
    assert!(!validate_method_params(
        "agent.authStart",
        &json!({"agentId":"shell"})
    ));
    assert!(!validate_method_params(
        "agent.install",
        &json!({"agentId":"claude", "command":"arbitrary"})
    ));
    assert!(!validate_method_params(
        "agent.authGet",
        &json!({"agentId":"codex"})
    ));
    assert!(validate_method_params(
        "agent.authSubmitCode",
        &json!({"agentId":"claude", "operationId":"operation", "code":"code#state"})
    ));
    for code in ["", "line\nbreak", "\u{1b}[A", "two words"] {
        assert!(!validate_method_params(
            "agent.authSubmitCode",
            &json!({"agentId":"claude", "operationId":"operation", "code":code})
        ));
    }
}
