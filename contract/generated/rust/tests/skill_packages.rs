use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn packages_use_strict_bounded_full_control_methods() {
    for method in ["skill.packageGet", "skill.packageCreate"] {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
    assert!(validate_method_params(
        "skill.packageGet",
        &json!({"projectId": null, "skillId": "a".repeat(64)})
    ));
    assert!(!validate_method_params(
        "skill.packageGet",
        &json!({"projectId": null, "path": "/private"})
    ));
    let file = json!({"path": "SKILL.md", "contentBase64": "c2tpbGw=", "executable": false});
    let params = json!({"directoryName": "aspire-testing", "files": [file.clone()]});
    assert!(validate_method_params("skill.packageCreate", &params));
    for (key, value) in [
        ("directoryName", json!("../escape")),
        ("files", json!([])),
        ("files", json!(vec![file.clone(); 1025])),
        (
            "files",
            json!([{ "path": "SKILL.md", "contentBase64": "c2tpbGw=" }]),
        ),
        (
            "files",
            json!([{ "path": "x".repeat(513), "contentBase64": "", "executable": false }]),
        ),
        ("overwrite", json!(true)),
    ] {
        let mut invalid = params.clone();
        invalid[key] = value;
        assert!(
            !validate_method_params("skill.packageCreate", &invalid),
            "{key}"
        );
    }
    assert!(validate_method_result(
        "skill.packageGet",
        &json!({"name": "aspire-testing", "files": [file]})
    ));
}
