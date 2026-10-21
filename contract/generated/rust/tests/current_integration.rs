use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

fn github_status() -> serde_json::Value {
    json!({
        "provider": "github",
        "target": "github.com",
        "state": "connected",
        "account": "octocat",
        "credentialSource": "cli",
        "capabilities": [
            {"capability": "pullRequests", "available": true},
            {"capability": "checks", "available": true}
        ],
        "retryAfterEpochMs": null,
        "checkedAtEpochMs": 10
    })
}

#[test]
fn integration_status_is_full_control_only_and_strict() {
    for method in ["integration.statusList", "integration.azureDevOpsTokenSet"] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }

    assert!(validate_method_params(
        "integration.statusList",
        &json!({"refresh": true})
    ));
    assert!(!validate_method_params(
        "integration.statusList",
        &json!({})
    ));
    assert!(validate_method_result(
        "integration.statusList",
        &json!({"integrations": [github_status()]})
    ));

    let mut unknown_state = github_status();
    unknown_state["state"] = json!("probablyFine");
    assert!(!validate_method_result(
        "integration.statusList",
        &json!({"integrations": [unknown_state]})
    ));
    let mut leaked_field = github_status();
    leaked_field["token"] = json!("secret");
    assert!(!validate_method_result(
        "integration.statusList",
        &json!({"integrations": [leaked_field]})
    ));

    assert!(validate_method_params(
        "integration.azureDevOpsTokenSet",
        &json!({"token": "pat-value"})
    ));
    assert!(validate_method_params(
        "integration.azureDevOpsTokenSet",
        &json!({"token": null})
    ));
    assert!(!validate_method_params(
        "integration.azureDevOpsTokenSet",
        &json!({"token": ""})
    ));
    assert!(!validate_method_params(
        "integration.azureDevOpsTokenSet",
        &json!({"token": "x".repeat(1025)})
    ));
}
