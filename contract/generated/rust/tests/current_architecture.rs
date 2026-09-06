use termloop_contract::current::{
    COMPANION_METHODS, METHODS, READ_ONLY_METHODS, validate_method_params, validate_method_result,
};

#[test]
fn architecture_surface_is_strict_bounded_and_full_control_only() {
    let methods = [
        "project.architectureSummary",
        "project.architectureGraph",
        "project.architectureNode",
        "project.architectureRefresh",
    ];
    for method in methods {
        assert!(METHODS.contains(&method));
        assert!(!READ_ONLY_METHODS.contains(&method));
        assert!(!COMPANION_METHODS.contains(&method));
    }
    assert!(validate_method_params(
        "project.architectureGraph",
        &serde_json::json!({
            "projectId":"project-1",
            "communityKey":"n:106",
            "depth":2,
            "limit":240
        })
    ));
    assert!(!validate_method_params(
        "project.architectureGraph",
        &serde_json::json!({"projectId":"project-1", "depth":4, "limit":240})
    ));

    let node = serde_json::json!({
        "id":"src/app.rs:App",
        "label":"App",
        "kind":"type",
        "file_type":"rust",
        "source_file":"src/app.rs",
        "source_location":"12",
        "community":1,
        "community_name":"Application",
        "fan_in":4,
        "fan_out":8,
        "degree":12,
        "risk_score":72.5,
        "neighbor_community_count":3
    });
    let summary = serde_json::json!({
        "project_id":"project-1",
        "status":"ready",
        "engine_available":true,
        "built_at_commit":"abc123",
        "current_commit":"abc123",
        "node_count":1,
        "edge_count":0,
        "community_count":1,
        "communities":[{
            "key":"n:1",
            "name":"Application",
            "node_count":1,
            "risk_score":72.5
        }],
        "community_catalog_truncated":false,
        "hotspots":[node.clone()],
        "warning":null
    });
    assert!(validate_method_result(
        "project.architectureGraph",
        &serde_json::json!({
            "summary":summary.clone(),
            "nodes":[node.clone()],
            "edges":[],
            "truncated":false
        })
    ));
    let mut invalid_node = node;
    invalid_node["risk_score"] = serde_json::json!(101);
    assert!(!validate_method_result(
        "project.architectureGraph",
        &serde_json::json!({
            "summary":summary,
            "nodes":[invalid_node],
            "edges":[],
            "truncated":false
        })
    ));
}
