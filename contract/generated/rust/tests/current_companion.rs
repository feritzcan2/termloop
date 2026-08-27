use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, ErrorCode, METHODS, validate_method_params, validate_method_result,
};

#[test]
fn companion_transcript_contract_is_bounded_and_capability_scoped() {
    for method in [
        "companion.transcriptAppend",
        "companion.proposalRespond",
        "companion.suggestionAccept",
        "companion.transcriptList",
        "companion.transcriptClear",
    ] {
        assert!(METHODS.contains(&method));
    }
    assert!(COMPANION_METHODS.contains(&"companion.transcriptAppend"));
    assert!(COMPANION_METHODS.contains(&"companion.transcriptList"));
    assert!(!COMPANION_METHODS.contains(&"companion.proposalRespond"));
    assert!(!COMPANION_METHODS.contains(&"companion.suggestionAccept"));
    assert!(!COMPANION_METHODS.contains(&"companion.transcriptClear"));
    assert_eq!(
        serde_json::from_value::<ErrorCode>(json!("quotaExceeded")).unwrap(),
        ErrorCode::QuotaExceeded
    );

    assert!(validate_method_params(
        "companion.transcriptAppend",
        &json!({"projectId":"project-1","content":"hello"})
    ));
    assert!(!validate_method_params(
        "companion.transcriptAppend",
        &json!({"projectId":"project-1","content":" "})
    ));
    assert!(validate_method_params(
        "companion.proposalRespond",
        &json!({
            "projectId":"project-1",
            "proposalMessageId":"project-1:2",
            "decision":"approve"
        })
    ));
    assert!(!validate_method_params(
        "companion.proposalRespond",
        &json!({
            "projectId":"project-1",
            "proposalMessageId":"project-1:2",
            "decision":"later"
        })
    ));
    assert!(validate_method_params(
        "companion.suggestionAccept",
        &json!({
            "projectId":"project-1",
            "suggestionMessageId":"project-1:3"
        })
    ));
    assert!(!validate_method_params(
        "companion.transcriptList",
        &json!({"projectId":"project-1","limit":101})
    ));
}

#[test]
fn companion_transcript_results_require_visible_quota_and_cursor_state() {
    assert!(validate_method_result(
        "companion.transcriptList",
        &json!({
            "messages": [{
                "id":"project-1:2",
                "projectId":"project-1",
                "sequence":2,
                "author":"steward",
                "kind":"suggestion",
                "refs":{"taskId":"task-1"},
                "content":"status",
                "createdAtEpochMs":2
            }],
            "nextBeforeSequence":null,
            "usage":{
                "usedBytes":6,
                "usedMessages":1,
                "softLimitBytes":41943040,
                "hardLimitBytes":52428800,
                "hardMessageLimit":10000,
                "softLimitExceeded":false
            },
            "stateRevision":3
        })
    ));
    assert!(!validate_method_result(
        "companion.transcriptList",
        &json!({
            "messages": [{
                "id":"project-1:2", "projectId":"project-1", "sequence":2,
                "author":"steward", "content":"untyped", "createdAtEpochMs":2
            }],
            "nextBeforeSequence":null,
            "usage":{
                "usedBytes":7, "usedMessages":1, "softLimitBytes":41943040,
                "hardLimitBytes":52428800, "hardMessageLimit":10000,
                "softLimitExceeded":false
            },
            "stateRevision":3
        })
    ));
    assert!(!validate_method_result(
        "companion.transcriptList",
        &json!({"messages":[],"nextBeforeSequence":null,"stateRevision":3})
    ));
}
