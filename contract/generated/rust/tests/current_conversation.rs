use serde_json::json;
use termloop_contract::current::{COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result};

#[test]
fn saved_conversation_is_a_bounded_full_control_session_read() {
    let method = "session.conversationRead";
    assert!(METHODS.contains(&method));
    assert!(!READ_ONLY_METHODS.contains(&method));
    assert!(!COMPANION_METHODS.contains(&method));
    assert!(validate_method_params(method, &json!({"projectId":"p","sessionId":"s"})));
    assert!(validate_method_params(method, &json!({"projectId":"p","sessionId":"s","before":42})));
    for extra in [json!({"before":0}), json!({"before":-1}), json!({"path":"private"}), json!({"nativeSessionId":"private"})] {
        let mut params = json!({"projectId":"p","sessionId":"s"});
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        assert!(!validate_method_params(method, &params));
    }
    let result = json!({"status":"available","messages":[{"role":"assistant","text":"## Full\n\nanswer","truncated":false}],"next_before":null,"incomplete":false});
    assert!(validate_method_result(method, &result));
    for (key, value) in [("role", json!("system")), ("text", json!("x".repeat(65_537))), ("providerSessionId", json!("private"))] {
        let mut bad = result.clone(); bad["messages"][0][key] = value;
        assert!(!validate_method_result(method, &bad));
    }
    let mut bad = result.clone(); bad["messages"] = json!(vec![result["messages"][0].clone(); 51]);
    assert!(!validate_method_result(method, &bad));
}
