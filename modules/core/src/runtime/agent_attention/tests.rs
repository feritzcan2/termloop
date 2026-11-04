use serde_json::json;
use termloop_domain::{ProcessDescriptor, SessionKind, SessionRecord};
use termloop_store::Store;
use termloop_terminal::TerminalService;

use crate::{CoreError, CoreRuntime};

fn session(id: &str, kind: SessionKind) -> SessionRecord {
    SessionRecord {
        launch_selection: Default::default(),
        id: id.into(),
        project_id: "project-1".into(),
        name: None,
        kind,
        process: ProcessDescriptor {
            program: "claude".into(),
            args: vec![],
            cwd: "/tmp".into(),
            agent_id: Some("claude".into()),
            template_ref: None,
            template_version: None,
        },
        lifecycle_state: "exited".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        fork_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: None,
        resume_launch_guard: None,
        resume_failure: None,
    }
}

fn runtime() -> (CoreRuntime, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "termloop-core-attention-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = termloop_store::issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(&authority, session("agent-1", SessionKind::Agent))
        .unwrap();
    store
        .insert_session(&authority, session("terminal-1", SessionKind::Terminal))
        .unwrap();
    (
        CoreRuntime::new(store, authority, TerminalService::default(), 2).unwrap(),
        path,
    )
}

fn acknowledged_at(runtime: &CoreRuntime) -> serde_json::Value {
    runtime
        .agent_status_list()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .find(|status| status["sessionId"] == "agent-1")
        .unwrap()["attentionAcknowledgedAtEpochMs"]
        .clone()
}

#[test]
fn acknowledgement_is_projected_to_every_status_reader_and_only_moves_forward() {
    let (mut runtime, path) = runtime();
    assert_eq!(acknowledged_at(&runtime), serde_json::Value::Null);

    let revision = runtime.state_revision();
    let first = runtime
        .handle(
            "agent.attentionAcknowledge",
            json!({ "sessionId": "agent-1", "observedAtEpochMs": 20 }),
        )
        .unwrap();
    assert_eq!(first, json!({ "acknowledged": true }));
    assert_eq!(acknowledged_at(&runtime), json!(20));
    // Runtime presentation state only: no durable write.
    assert_eq!(runtime.state_revision(), revision);

    // Repeating or acknowledging an older observation from a second client
    // changes nothing, so it publishes nothing either.
    for observed in [20, 10] {
        assert_eq!(
            runtime
                .handle(
                    "agent.attentionAcknowledge",
                    json!({ "sessionId": "agent-1", "observedAtEpochMs": observed }),
                )
                .unwrap(),
            json!({ "acknowledged": false })
        );
    }
    assert_eq!(acknowledged_at(&runtime), json!(20));

    runtime
        .handle(
            "agent.attentionAcknowledge",
            json!({ "sessionId": "agent-1", "observedAtEpochMs": 30 }),
        )
        .unwrap();
    assert_eq!(acknowledged_at(&runtime), json!(30));
    let _ = std::fs::remove_file(path);
}

#[test]
fn acknowledgement_rejects_unknown_non_agent_and_malformed_targets() {
    let (mut runtime, path) = runtime();
    for (params, expected_not_found) in [
        (
            json!({ "sessionId": "missing", "observedAtEpochMs": 1 }),
            true,
        ),
        (
            json!({ "sessionId": "terminal-1", "observedAtEpochMs": 1 }),
            true,
        ),
        (json!({ "sessionId": "agent-1" }), false),
        (
            json!({ "sessionId": "agent-1", "observedAtEpochMs": -1 }),
            false,
        ),
    ] {
        let error = runtime
            .handle("agent.attentionAcknowledge", params)
            .unwrap_err();
        if expected_not_found {
            assert!(matches!(error, CoreError::NotFound), "{error:?}");
        } else {
            assert!(matches!(error, CoreError::InvalidParams(_)), "{error:?}");
        }
    }
    assert_eq!(acknowledged_at(&runtime), serde_json::Value::Null);
    let _ = std::fs::remove_file(path);
}
