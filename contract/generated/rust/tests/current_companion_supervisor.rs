use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn wake_methods_are_bounded_and_companion_only() {
    for method in ["companion.wakeNext", "companion.stewardWake"] {
        assert!(COMPANION_METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
    }
    assert!(validate_method_params(
        "companion.wakeNext",
        &json!({"waitMilliseconds":30_000})
    ));
    assert!(!validate_method_params(
        "companion.wakeNext",
        &json!({"waitMilliseconds":30_001})
    ));
    assert!(validate_method_params(
        "companion.stewardWake",
        &json!({"projectId":"project-1","generation":1})
    ));
    assert!(!validate_method_params(
        "companion.stewardWake",
        &json!({"projectId":"project-1","generation":0})
    ));
}

#[test]
fn empty_and_pending_wakes_have_one_strict_shape() {
    assert!(validate_method_result(
        "companion.wakeNext",
        &json!({"projectId":null,"reason":null,"generation":0})
    ));
    assert!(validate_method_result(
        "companion.wakeNext",
        &json!({"projectId":"project-1","reason":"pipelineMoved","generation":2})
    ));
    assert!(!validate_method_result(
        "companion.wakeNext",
        &json!({"projectId":"project-1","reason":"arbitrary","generation":2})
    ));
    assert!(validate_method_result(
        "companion.stewardWake",
        &json!({"admitted":true,"coalesced":false})
    ));
}
