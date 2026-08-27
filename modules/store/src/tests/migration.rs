use super::*;

#[test]
fn schema_38_adds_an_empty_deleted_agent_bin_without_inference() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-deleted-agents-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 38,
            "revision": 2,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.deleted_sessions().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["deleted_sessions"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_36_defaults_existing_routines_to_action_handling_off() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-routine-actions-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 36,
            "revision": 2,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": [],
            "worker_configurations": [{
                "id":"worker-1", "projectId":"project-1", "name":"Worker 1",
                "agentId":"codex", "model":"gpt-5.6-luna", "permission":"bypassPermissions",
                "reasoning":"medium", "enabled":false, "pingIntervalSeconds":60,
                "workerPrompt":"", "systemPrompt":"", "executorSessionId":null,
                "generation":1, "updatedAtEpochMs":1
            }],
            "tracker_configurations": [{
                "id":"routine-1", "projectId":"project-1", "kind":"custom",
                "triggerMode":"schedule", "name":"Check", "prompt":"Inspect current state.",
                "workerId":"worker-1", "enabled":false, "scheduleIntervalSeconds":300,
                "generation":1, "contextMarkdown":"", "contextRevision":1,
                "recentSourceKeys":[], "relatedTaskIds":[],
                "lastCheckStartedAtEpochMs":null, "lastAttemptAtEpochMs":null,
                "lastSuccessfulReportAtEpochMs":null, "updatedAtEpochMs":1
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    let routine = &store.tracker_configurations()[0];
    assert_eq!(
        routine.action_handling,
        termloop_domain::RoutineActionHandling::Off
    );
    assert!(routine.steward_instructions.is_empty());
    assert!(routine.pending_routine_findings.is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["tracker_configurations"][0]["actionHandling"],
        "off"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_37_converts_action_candidates_to_factual_pending_findings() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-routine-findings-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 37,
            "revision": 2,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": [],
            "worker_configurations": [{
                "id":"worker-1", "projectId":"project-1", "name":"Worker 1",
                "agentId":"codex", "model":"gpt-5.6-luna", "permission":"bypassPermissions",
                "reasoning":"medium", "enabled":false, "pingIntervalSeconds":60,
                "workerPrompt":"", "systemPrompt":"", "executorSessionId":null,
                "generation":1, "updatedAtEpochMs":1
            }],
            "tracker_configurations": [{
                "id":"routine-1", "projectId":"project-1", "kind":"custom",
                "triggerMode":"schedule", "name":"Check", "prompt":"Inspect current state.",
                "workerId":"worker-1", "enabled":false, "scheduleIntervalSeconds":300,
                "generation":1, "contextMarkdown":"", "contextRevision":1,
                "recentSourceKeys":[], "relatedTaskIds":[], "actionHandling":"ask",
                "recentActionKeys":["custom:failure:42"],
                "pendingActionCandidates":[{
                    "id":"finding-1", "dedupeKey":"custom:failure:42", "routineGeneration":1,
                    "summary":"Deployment 42 failed", "requestedOutcome":"Create an incident",
                    "evidence":"Deploy stage is failed", "sourceReferences":["run://42"],
                    "relatedTaskIds":[], "createdAtEpochMs":2
                }],
                "lastCheckStartedAtEpochMs":null, "lastAttemptAtEpochMs":null,
                "lastSuccessfulReportAtEpochMs":null, "updatedAtEpochMs":2
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    let routine = &store.tracker_configurations()[0];
    assert!(routine.steward_instructions.is_empty());
    assert_eq!(routine.pending_routine_findings.len(), 1);
    assert_eq!(
        routine.pending_routine_findings[0].source_key,
        "custom:failure:42"
    );
    assert_eq!(
        routine.pending_routine_findings[0].summary,
        "Deployment 42 failed"
    );
    assert!(
        routine
            .recent_source_keys
            .contains(&"custom:failure:42".into())
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(persisted["tracker_configurations"][0]["pendingRoutineFindings"].is_array());
    assert!(
        persisted["tracker_configurations"][0]
            .get("pendingActionCandidates")
            .is_none()
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_35_repairs_orphan_conversation_readiness() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-orphan-readiness-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 35,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": [{
                "id":"agent-1","project_id":"project-1","kind":"Agent",
                "process":{"program":"codex","args":[],"cwd":"/tmp/demo","agent_id":"codex"},
                "lifecycle_state":"exited","runtime_epoch":1
            }],
            "agent_conversation_readiness": [
                {"sessionId":"agent-1","readiness":"resumable"},
                {"sessionId":"removed-assistant","readiness":"legacyUnknown"}
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.agent_conversation_readiness("agent-1"),
        Some(termloop_domain::AgentConversationReadiness::Resumable)
    );
    assert_eq!(
        store.agent_conversation_readiness("removed-assistant"),
        None
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["agent_conversation_readiness"],
        serde_json::json!([{"sessionId":"agent-1","readiness":"resumable"}])
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_34_assigns_the_new_assistant_permission_defaults() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-assistant-permission-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 34,
            "revision": 3,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": [],
            "steward_configurations": [{
                "projectId":"project-1", "agentId":"claude", "model":"sonnet",
                "reasoning":"medium", "enabled":false, "systemPrompt":"",
                "executorSessionId":null, "generation":1, "updatedAtEpochMs":1
            }],
            "worker_configurations": [{
                "id":"worker-1", "projectId":"project-1", "name":"Worker 1",
                "agentId":"codex", "model":"gpt-5.6-luna", "reasoning":"medium",
                "enabled":false, "pingIntervalSeconds":60, "workerPrompt":"",
                "systemPrompt":"", "executorSessionId":null, "generation":1,
                "updatedAtEpochMs":1
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.steward_configurations()[0].permission,
        "bypassPermissions"
    );
    assert_eq!(
        store.worker_configurations()[0].permission,
        "bypassPermissions"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["steward_configurations"][0]["permission"],
        "bypassPermissions"
    );
    assert_eq!(
        persisted["worker_configurations"][0]["permission"],
        "bypassPermissions"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_29_preserves_legacy_resume_attempts_without_claiming_confirmation() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-conversation-readiness-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 29,
            "revision": 3,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "sessions": [
                {
                    "id":"legacy-agent","project_id":"project-1","kind":"Agent",
                    "process":{"program":"codex","args":[],"cwd":"/tmp/demo","agent_id":"codex"},
                    "lifecycle_state":"running","runtime_epoch":1,
                    "resume_ref":{"provider":"codex","nativeSessionId":"thread-1"}
                },
                {
                    "id":"blank-agent","project_id":"project-1","kind":"Agent",
                    "process":{"program":"codex","args":[],"cwd":"/tmp/demo","agent_id":"codex"},
                    "lifecycle_state":"running","runtime_epoch":1
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.agent_conversation_readiness("legacy-agent"),
        Some(termloop_domain::AgentConversationReadiness::LegacyUnknown)
    );
    assert_eq!(
        store.agent_conversation_readiness("blank-agent"),
        Some(termloop_domain::AgentConversationReadiness::Unconfirmed)
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["agent_conversation_readiness"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn schema_27_adds_no_inferred_agent_plans() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-migration-agent-plan-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 27,
            "revision": 3,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.agent_plans().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["agent_plans"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v26_migration_upgrades_only_the_exact_default_jira_routine() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-jira-v26-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    let retired_prompt =
        include_str!("../../../../resources/prompts/retired/builtin.tracker.jira.v3.md")
            .splitn(3, "\n\n")
            .nth(2)
            .unwrap()
            .trim();
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 26,
            "revision": 4,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "worker_configurations": [{
                "id":"worker-1", "projectId":"project-1", "name":"Worker 1",
                "agentId":"codex", "model":"default", "reasoning":"default",
                "enabled":false, "pingIntervalSeconds":60, "workerPrompt":"",
                "systemPrompt":"", "executorSessionId":null, "generation":1,
                "updatedAtEpochMs":100
            }],
            "tracker_configurations": [
                {
                    "id":"jira-default", "projectId":"project-1", "kind":"jira",
                    "name":"Jira issue synchronizer", "prompt":retired_prompt,
                    "workerId":"worker-1", "enabled":false, "scheduleIntervalSeconds":900,
                    "generation":2, "contextMarkdown":"# stale broad results",
                    "contextRevision":7, "recentSourceKeys":["jira:OLD-1"],
                    "relatedTaskIds":[], "lastCheckStartedAtEpochMs":110,
                    "lastAttemptAtEpochMs":120, "lastSuccessfulReportAtEpochMs":120,
                    "updatedAtEpochMs":120
                },
                {
                    "id":"jira-custom", "projectId":"project-1", "kind":"jira",
                    "name":"Custom Jira", "prompt":"Keep my custom Jira policy.",
                    "workerId":"worker-1", "enabled":false, "scheduleIntervalSeconds":900,
                    "generation":5, "contextMarkdown":"# keep",
                    "contextRevision":3, "recentSourceKeys":["jira:CUSTOM-1"],
                    "relatedTaskIds":[], "lastCheckStartedAtEpochMs":210,
                    "lastAttemptAtEpochMs":220, "lastSuccessfulReportAtEpochMs":220,
                    "updatedAtEpochMs":220
                }
            ],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    let upgraded = &store.tracker_configurations()[0];
    assert!(upgraded.prompt.contains("does not prove access"));
    assert!(
        upgraded
            .prompt
            .contains("jira:<stable-issue-id>:<material-state>")
    );
    assert!(!upgraded.prompt.contains("A sprint is never required"));
    assert_eq!(upgraded.generation, 3);
    assert!(upgraded.context_markdown.is_empty());
    assert_eq!(upgraded.context_revision, 8);
    assert!(upgraded.recent_source_keys.is_empty());
    assert_eq!(upgraded.last_attempt_at_epoch_ms, None);
    assert_eq!(upgraded.updated_at_epoch_ms, 0);

    let custom = &store.tracker_configurations()[1];
    assert_eq!(custom.prompt, "Keep my custom Jira policy.");
    assert_eq!(custom.generation, 5);
    assert_eq!(custom.context_markdown, "# keep");
    assert_eq!(custom.recent_source_keys, ["jira:CUSTOM-1"]);

    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    let _ = std::fs::remove_file(path);
}

#[test]
fn v25_migration_adds_empty_relocation_current_state_without_inference() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-relocation-v25-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 25,
            "revision": 4,
            "projects": [],
            "tasks": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.session_relocation_operations().is_empty());
    assert!(store.session_relocation_receipts().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["session_relocation_operations"],
        serde_json::json!([])
    );
    assert_eq!(
        persisted["session_relocation_receipts"],
        serde_json::json!([])
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v20_migration_preserves_current_request_without_expiry() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-ask-to-v20-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 20,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "sessions": [
                {
                    "id":"source", "project_id":"project-1", "name":null,
                    "kind":"Agent", "launch_selection":{"model":"default","permission":"default","reasoning":"default"},
                    "process":{"program":"codex","args":[],"cwd":"/tmp/demo","agent_id":"codex","template_ref":"builtin.agent.interactive","template_version":1},
                    "lifecycle_state":"running", "runtime_epoch":1,
                    "ask_to_source_session_id":null, "ask_to_continuation":null
                },
                {
                    "id":"helper", "project_id":"project-1", "name":null,
                    "kind":"Agent", "launch_selection":{"model":"default","permission":"default","reasoning":"default"},
                    "process":{"program":"claude","args":[],"cwd":"/tmp/demo","agent_id":"claude","template_ref":"builtin.agent.ask-to-helper","template_version":2},
                    "lifecycle_state":"running", "runtime_epoch":1,
                    "ask_to_source_session_id":"source",
                    "ask_to_continuation":{
                        "conversation_id":"conversation-1",
                        "current_request_id":"request-1",
                        "current_request_expires_at_epoch_ms":1
                    }
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.sessions()[1]
            .ask_to_continuation
            .as_ref()
            .and_then(|continuation| continuation.current_request_id.as_deref()),
        Some("request-1")
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(
        persisted["sessions"][1]["ask_to_continuation"]
            .get("current_request_expires_at_epoch_ms")
            .is_none()
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v22_archive_migration_infers_neither_archived_tasks_nor_suspended_sessions() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-archive-v22-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 22,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "tasks": [{
                "id":"task-1","project_id":"project-1","title":"Closed but active",
                "brief":null,"status":"closed","branch":null,"worktree":null,
                "worktree_generation":0,"rank":0,"created_at_epoch_ms":1,"updated_at_epoch_ms":2
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.tasks()[0].archived_at_epoch_ms, None);
    assert!(store.task_archive_operations().is_empty());
    assert!(store.task_archive_suspensions().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["task_archive_operations"], serde_json::json!([]));
    assert_eq!(persisted["task_archive_suspensions"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v19_migration_adds_no_ask_to_conversation_authority() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-ask-to-v19-migration-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 19,
            "revision": 5,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "sessions": [
                {
                    "id":"source", "project_id":"project-1", "name":null,
                    "kind":"Agent", "launch_selection":{"model":"default","permission":"default","reasoning":"default"},
                    "process":{"program":"claude","args":[],"cwd":"/tmp/demo","agent_id":"claude","template_ref":"builtin.agent.interactive","template_version":1},
                    "lifecycle_state":"exited", "runtime_epoch":1,
                    "ask_to_source_session_id":null
                },
                {
                    "id":"helper", "project_id":"project-1", "name":null,
                    "kind":"Agent", "launch_selection":{"model":"default","permission":"default","reasoning":"default"},
                    "process":{"program":"claude","args":[],"cwd":"/tmp/demo","agent_id":"claude","template_ref":"builtin.agent.ask-to-helper","template_version":2},
                    "lifecycle_state":"exited", "runtime_epoch":1,
                    "ask_to_source_session_id":"source"
                }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.sessions()[1].ask_to_continuation, None);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(
        persisted["sessions"][1]
            .get("ask_to_continuation")
            .is_none()
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v17_migration_initializes_ask_to_source_without_inference() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-ask-to-v17-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 17,
            "revision": 4,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "sessions": [{
                "id":"legacy-helper", "project_id":"project-1", "name":null,
                "kind":"Agent", "launch_selection":{
                    "model":"default", "permission":"default", "reasoning":"default"
                },
                "process":{
                    "program":"claude", "args":[], "cwd":"/tmp/demo",
                    "agent_id":"claude", "template_ref":"builtin.agent.ask-to-helper",
                    "template_version":1
                },
                "lifecycle_state":"exited", "runtime_epoch":1
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.sessions()[0].ask_to_source_session_id, None);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(persisted["sessions"][0]["ask_to_source_session_id"].is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn v19_migration_preserves_launch_preference_and_initializes_empty_issue_links() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-issue-link-v19-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 19,
            "revision": 2,
            "projects": [],
            "tasks": [],
            "sessions": [],
            "last_agent_launch_selection": {
                "agentId": "codex",
                "selection": {
                    "model": "gpt-5.6-sol",
                    "permission": "workspaceWrite",
                    "reasoning": "high"
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.issue_links().is_empty());
    assert_eq!(
        store.last_agent_launch_selection().unwrap().agent_id,
        "codex"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["issue_links"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v18_migration_does_not_infer_a_launch_preference() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-launch-preference-v18-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 18,
            "revision": 1,
            "projects": [],
            "tasks": [],
            "sessions": [{
                "id":"agent-1", "project_id":"project-1", "name":null, "kind":"Agent",
                "process":{
                    "program":"codex", "args":[], "cwd":"/tmp", "agent_id":"codex",
                    "template_ref":"builtin.agent.interactive", "template_version":1
                },
                "launch_selection":{
                    "model":"gpt-5.6-sol", "permission":"bypassPermissions", "reasoning":"high"
                },
                "lifecycle_state":"running", "runtime_epoch":1
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.last_agent_launch_selection().is_none());
    assert_eq!(
        store.sessions()[0].launch_selection.permission,
        "bypassPermissions"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(persisted["last_agent_launch_selection"].is_null());
    let _ = std::fs::remove_file(path);
}

#[test]
fn v17_migration_types_legacy_messages_and_initializes_empty_issue_links() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-companion-v17-kind-{}-{}.json",
        std::process::id(),
        termloop_platform::current_epoch_ms()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 17,
            "revision": 9,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [{
                "id":"task-1","project_id":"project-1","title":"Task","brief":null,
                "status":"open","branch":null,"worktree":null,"worktree_generation":0,
                "rank":0,"created_at_epoch_ms":1,"updated_at_epoch_ms":1
            }],
            "companion_messages": [{
                "id":"message-1", "projectId":"project-1", "sequence":1,
                "author":"steward", "content":"I created Task task-1.",
                "createdAtEpochMs":1
            }],
            "steward_configurations": [],
            "steward_conversation_refs": [],
            "tracker_configurations": [],
            "worker_configurations": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.tasks()[0].title, "Task");
    assert!(store.issue_links().is_empty());
    let message = &store.companion_messages()[0];
    assert_eq!(message.kind, termloop_domain::CompanionMessageKind::Reply);
    assert!(message.refs.is_none());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(persisted["companion_messages"][0].get("kind").is_none());
    assert_eq!(persisted["issue_links"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v15_migration_preserves_current_state_and_defaults_agent_launch_selection() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-companion-v15-current-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 15,
            "revision": 23,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "companion_messages": [{
                "id":"message-1", "projectId":"project-1", "sequence":1,
                "author":"steward", "content":"Current report", "createdAtEpochMs":100
            }],
            "steward_configurations": [{
                "projectId":"project-1", "agentId":"claude", "enabled":false,
                "executorSessionId":null, "generation":2, "updatedAtEpochMs":101
            }],
            "steward_conversation_refs": [],
            "worker_configurations": [{
                "id":"worker-1", "projectId":"project-1", "name":"Worker 1",
                "agentId":"codex", "enabled":false, "executorSessionId":null,
                "generation":3, "updatedAtEpochMs":102
            }],
            "tracker_configurations": [{
                "id":"worker-task-1", "projectId":"project-1", "kind":"slack",
                "name":"Slack action tracker", "prompt":"Inspect #product and report.",
                "workerId":"worker-1", "enabled":true, "scheduleIntervalSeconds":300,
                "generation":4, "lastAttemptAtEpochMs":104,
                "lastSuccessfulReportAtEpochMs":103, "updatedAtEpochMs":105
            }],
            "sessions": [{
                "id":"legacy-agent", "project_id":"project-1", "name":null,
                "kind":"Agent",
                "process":{
                    "program":"codex", "args":[], "cwd":"/tmp",
                    "agent_id":"codex", "template_ref":"builtin.agent.interactive",
                    "template_version":1
                },
                "lifecycle_state":"running", "runtime_epoch":1
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.revision(), 23);
    assert_eq!(store.companion_messages()[0].content, "Current report");
    assert_eq!(
        store.companion_messages()[0].kind,
        termloop_domain::CompanionMessageKind::Reply
    );
    assert!(store.companion_messages()[0].refs.is_none());
    assert_eq!(store.steward_configurations()[0].generation, 2);
    assert_eq!(store.steward_configurations()[0].system_prompt, "");
    assert_eq!(store.worker_configurations()[0].generation, 3);
    let worker_task = &store.tracker_configurations()[0];
    assert_eq!(worker_task.prompt, "Inspect #product and report.");
    assert_eq!(worker_task.last_attempt_at_epoch_ms, Some(104));
    assert_eq!(worker_task.last_successful_report_at_epoch_ms, Some(103));
    assert_eq!(
        store.sessions()[0].launch_selection,
        termloop_domain::AgentLaunchSelection::default()
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["sessions"][0]["launch_selection"]["permission"],
        "default"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v12_migration_drops_retired_proposals_and_preserves_current_state() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-proposal-v12-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 12,
            "revision": 3,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "companion_messages": [],
            "companion_proposals": [{
              "id":"proposal-1","projectId":"project-1","revision":1,
              "action":{"kind":"taskCreate","title":"Retired","brief":null},
              "supportingReportIds":[],"baseStateRevision":3,
              "targetTaskFingerprint":null,"createdAtEpochMs":1,"updatedAtEpochMs":1
            }],
            "steward_configurations": [],
            "steward_conversation_refs": [],
            "tracker_configurations": [],
            "tracker_conversation_refs": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.projects().len(), 1);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(persisted.get("companion_proposals").is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn v13_migration_preserves_routine_and_initializes_last_attempt() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-worker-task-v13-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 13,
            "revision": 3,
            "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
            "tasks": [],
            "worker_configurations": [{
                "id":"worker-1","projectId":"project-1","name":"Worker 1",
                "agentId":"claude","enabled":false,"executorSessionId":null,
                "generation":1,"updatedAtEpochMs":1
            }],
            "tracker_configurations": [{
                "id":"task-1","projectId":"project-1","kind":"slack","name":"Slack action tracker",
                "prompt":"Inspect Slack, then call `steward_report`; use `report_problem` if this assignment cannot run. Finish each check exactly once.",
                "workerId":"worker-1","enabled":false,
                "scheduleIntervalSeconds":300,"generation":1,
                "lastSuccessfulReportAtEpochMs":null,"updatedAtEpochMs":1
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.tracker_configurations().len(), 1);
    assert_eq!(
        store.tracker_configurations()[0].last_attempt_at_epoch_ms,
        None
    );
    assert_eq!(store.tracker_configurations()[0].context_revision, 1);
    assert!(
        store.tracker_configurations()[0]
            .context_markdown
            .is_empty()
    );
    assert!(
        store.tracker_configurations()[0]
            .recent_source_keys
            .is_empty()
    );
    assert!(
        store.tracker_configurations()[0]
            .related_task_ids
            .is_empty()
    );
    assert!(
        store.tracker_configurations()[0]
            .prompt
            .contains("`worker_complete_routine`")
    );
    assert!(
        store.tracker_configurations()[0]
            .prompt
            .contains("`worker_report_routine_problem`")
    );
    assert!(
        !store.tracker_configurations()[0]
            .prompt
            .contains("this assignment")
    );
    assert!(store.tracker_configurations()[0].prompt.contains("Routine"));
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["tracker_configurations"][0]["lastAttemptAtEpochMs"],
        serde_json::Value::Null
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v1_migration_assigns_generation_only_to_an_exact_managed_pair() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-cleanup-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        r#"{
          "schema_version": 1,
          "revision": 9,
          "projects": [],
          "tasks": [
            {"id":"valid","project_id":"p","title":"valid","brief":null,"status":"open","branch":{"repository_root":"/repo","name":"feature/valid"},"worktree":{"path":"/wt/valid"},"rank":0,"created_at_epoch_ms":1,"updated_at_epoch_ms":1},
            {"id":"ambiguous","project_id":"p","title":"ambiguous","brief":null,"status":"open","branch":{"repository_root":"/repo","name":"feature/ambiguous"},"worktree":{"path":"/wt/ambiguous"},"rank":1,"created_at_epoch_ms":1,"updated_at_epoch_ms":1},
            {"id":"empty","project_id":"p","title":"empty","brief":null,"status":"open","branch":null,"worktree":null,"rank":2,"created_at_epoch_ms":1,"updated_at_epoch_ms":1}
          ],
          "provisioning_operations": [],
          "managed_worktrees": [{
            "task_id":"valid","operation_id":"proof-valid","normalized_spec_version":1,
            "normalized_spec":{"version":1,"repository_root":"/repo","repository_common_dir":"/repo/.git","destination_path":"/wt/valid","branch_name":"feature/valid","branch_mode":"create","base_ref":"refs/heads/main","base_oid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
            "repository_common_dir":"/repo/.git","registered_worktree_path":"/wt/valid","branch_ref":"refs/heads/feature/valid"
          }],
          "sessions": []
        }"#,
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(store.revision(), 9);
    assert_eq!(store.tasks()[0].worktree_generation, 1);
    assert_eq!(store.managed_worktrees()[0].worktree_generation, 1);
    assert_eq!(store.tasks()[1].worktree_generation, 0);
    assert_eq!(store.tasks()[2].worktree_generation, 0);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["revision"], 9);
    assert_eq!(persisted["stale_resolution_operations"], json!([]));
    assert_eq!(persisted["stale_resolution_receipts"], json!([]));
    assert_eq!(persisted["mcp_tool_description_overrides"], json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v4_migration_preserves_main_project_task_and_session_state() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-companion-v4-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 4,
            "revision": 17,
            "projects": [{
                "id":"project-main", "name":"Main Project", "folder_path":"/tmp/main-project"
            }],
            "tasks": [{
                "id":"task-main", "project_id":"project-main", "title":"Preserve me",
                "brief":"Main schema-four Task", "status":"open",
                "branch":null, "worktree":null, "worktree_generation":0,
                "rank":4, "created_at_epoch_ms":10, "updated_at_epoch_ms":11
            }],
            "sessions": [{
                "id":"session-main", "project_id":"project-main", "name":"Main agent",
                "kind":"Agent",
                "process":{
                    "program":"claude", "args":["--resume","conversation-main"],
                    "cwd":"/tmp/main-project", "agent_id":"claude",
                    "template_ref":"builtin.agent.interactive", "template_version":1
                },
                "lifecycle_state":"exited", "runtime_epoch":3,
                "resume_ref":{
                    "provider":"claude",
                    "nativeSessionId":"019f1dae-3bf3-73d1-b3c7-08ddbbd1f035"
                },
                "resume_launch_guard":null, "resume_failure":null
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.revision(), 17);
    assert_eq!(store.projects()[0].id, "project-main");
    assert_eq!(store.projects()[0].name, "Main Project");
    assert_eq!(store.tasks()[0].id, "task-main");
    assert_eq!(
        store.tasks()[0].brief.as_deref(),
        Some("Main schema-four Task")
    );
    assert_eq!(store.sessions()[0].id, "session-main");
    assert_eq!(store.sessions()[0].name.as_deref(), Some("Main agent"));
    assert_eq!(
        store.sessions()[0].process.args,
        ["--resume", "conversation-main"]
    );
    assert!(store.companion_messages().is_empty());
    assert!(store.steward_configurations().is_empty());
    assert!(store.worker_configurations().is_empty());
    assert!(store.tracker_configurations().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["revision"], 17);
    assert_eq!(persisted["projects"][0]["id"], "project-main");
    assert_eq!(persisted["tasks"][0]["id"], "task-main");
    assert_eq!(persisted["sessions"][0]["id"], "session-main");
    assert_eq!(persisted["companion_messages"], serde_json::json!([]));
    assert_eq!(persisted["steward_configurations"], serde_json::json!([]));
    assert_eq!(persisted["worker_configurations"], serde_json::json!([]));
    assert_eq!(persisted["tracker_configurations"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v5_migrates_to_an_empty_steward_configuration_collection() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-steward-v5-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 5,
            "revision": 2,
            "projects": [],
            "companion_messages": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(&path).unwrap();
    assert!(store.steward_configurations().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["steward_configurations"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v6_migrates_to_an_empty_tracker_configuration_collection() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-tracker-v6-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 6,
            "revision": 0,
            "projects": [],
            "tasks": [],
            "provisioning_operations": [],
            "managed_worktrees": [],
            "cleanup_operations": [],
            "cleanup_receipts": [],
            "repair_operations": [],
            "repair_receipts": [],
            "stale_resolution_operations": [],
            "stale_resolution_receipts": [],
            "companion_messages": [],
            "steward_configurations": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(&path).unwrap();
    assert!(store.tracker_configurations().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(persisted["tracker_configurations"], serde_json::json!([]));
    assert!(persisted.get("tracker_conversation_refs").is_none());
    assert_eq!(persisted["worker_configurations"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v7_migration_drops_the_retired_tracker_conversation_collection() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-tracker-conversation-v7-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 7,
            "revision": 0,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    Store::open(&path).unwrap();
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(persisted.get("tracker_conversation_refs").is_none());
    assert_eq!(persisted["worker_configurations"], serde_json::json!([]));
    let _ = std::fs::remove_file(path);
}

#[test]
fn v8_migrates_to_an_empty_private_steward_conversation_collection() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-steward-conversation-v8-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 8,
            "revision": 0,
            "projects": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    Store::open(&path).unwrap();
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["steward_conversation_refs"],
        serde_json::json!([])
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v10_reset_removes_only_retired_tracker_assistant_state() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-worker-reset-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "schema_version": 10, "revision": 1,
        "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
        "tasks": [], "tracker_configurations": [{
            "id":"tracker-1","projectId":"project-1","kind":"slack","name":"Slack",
            "agentId":"claude","enabled":true,"scheduleIntervalSeconds":300,
            "sourceScope":{"selectedRefs":[],"includeDirectMessages":false},
            "executorSessionId":"tracker-session","generation":1,
            "lastSuccessfulReportAtEpochMs":null,"updatedAtEpochMs":1
        }],
        "sessions": [{
            "id":"tracker-session","project_id":"project-1","name":"Old Tracker","kind":"Agent",
            "process":{"program":"claude","args":[],"cwd":"/tmp/demo","agent_id":"claude","template_ref":"builtin.tracker.slack","template_version":1},
            "lifecycle_state":"running","runtime_epoch":1
        }]
    })).unwrap()).unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.projects().len(), 1);
    assert!(store.tracker_configurations().is_empty());
    assert!(store.worker_configurations().is_empty());
    assert!(store.sessions().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert!(persisted.get("tracker_conversation_refs").is_none());
    let _ = std::fs::remove_file(path);
}

#[test]
fn v11_reset_removes_promptless_workers_and_keeps_ordinary_sessions() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-prompt-assignment-reset-{}.json",
        std::process::id()
    ));
    std::fs::write(&path, serde_json::to_vec(&serde_json::json!({
        "schema_version": 11, "revision": 1,
        "projects": [{"id":"project-1","name":"Demo","folder_path":"/tmp/demo"}],
        "tasks": [],
        "worker_configurations": [{
            "id":"worker-1","projectId":"project-1","name":"Worker 1",
            "agentId":"claude","enabled":true,"executorSessionId":"worker-session",
            "generation":1,"updatedAtEpochMs":1
        }],
        "tracker_configurations": [{
            "id":"tracker-1","projectId":"project-1","kind":"slack","name":"Slack",
            "workerId":"worker-1","enabled":true,"scheduleIntervalSeconds":300,
            "generation":1,"lastSuccessfulReportAtEpochMs":null,"updatedAtEpochMs":1
        }],
        "sessions": [
            {
                "id":"worker-session","project_id":"project-1","name":"Worker 1","kind":"Agent",
                "process":{"program":"claude","args":[],"cwd":"/tmp/demo","agent_id":"claude","template_ref":"builtin.worker.executor","template_version":1},
                "lifecycle_state":"running","runtime_epoch":1
            },
            {
                "id":"ordinary-session","project_id":"project-1","name":"Terminal","kind":"Terminal",
                "process":{"program":"zsh","args":[],"cwd":"/tmp/demo","agent_id":null,"template_ref":null,"template_version":null},
                "lifecycle_state":"exited","runtime_epoch":1
            }
        ]
    })).unwrap()).unwrap();
    let store = Store::open(&path).unwrap();
    assert!(store.worker_configurations().is_empty());
    assert!(store.tracker_configurations().is_empty());
    assert_eq!(store.sessions().len(), 1);
    assert_eq!(store.sessions()[0].id, "ordinary-session");
    let _ = std::fs::remove_file(path);
}
#[test]
fn v41_migration_initializes_empty_task_sources_without_inferring_legacy_links() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-source-v41-migration-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 41,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "tasks": [{
                "id":"task-1","project_id":"project-1","title":"Legacy linked Task",
                "brief":null,"status":"open","branch":null,"worktree":null,
                "worktree_generation":0,"rank":0,"created_at_epoch_ms":1,"updated_at_epoch_ms":1
            }],
            "issue_links": [{
                "taskId":"task-1","provider":"jira","externalRef":"TERM-42",
                "url":"https://example.atlassian.net/browse/TERM-42","syncAuthority":"none"
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(&path).unwrap();
    assert!(store.task_source_configurations().is_empty());
    assert_eq!(store.issue_links().len(), 1);
    assert_eq!(store.issue_links()[0].source_id, None);
    assert_eq!(store.issue_links()[0].external_id, None);
    assert_eq!(store.issue_links()[0].external_updated_at, None);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["task_source_configurations"],
        serde_json::json!([])
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v42_migration_lifts_unanimous_source_task_automation_to_the_project() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-automation-v42-migration-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 42,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [legacy_task_source("source-1", true, Some("codex"))],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.project_task_automation_configurations(),
        &[termloop_domain::ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            worktree_prefix: "termloop".into(),
            agent_id: Some("codex".into()),
            model: Some("default".into()),
            permission: Some("default".into()),
            reasoning: Some("default".into()),
            kickoff_message: None,
        }]
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert!(
        persisted["task_source_configurations"][0]
            .get("createWorktree")
            .is_none()
    );
    assert!(
        persisted["task_source_configurations"][0]
            .get("agentId")
            .is_none()
    );
    assert_eq!(
        persisted["task_source_configurations"][0]["autoImportActiveTaskLimit"],
        termloop_domain::TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v43_migration_adds_the_default_auto_import_active_task_limit() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-source-limit-v43-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut source = legacy_task_source("source-1", false, None);
    source.as_object_mut().unwrap().remove("createWorktree");
    source.as_object_mut().unwrap().remove("agentId");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 43,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [source],
            "project_task_automation_configurations": [],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.task_source_configurations()[0].auto_import_active_task_limit,
        termloop_domain::TASK_SOURCE_AUTO_IMPORT_ACTIVE_TASK_LIMIT_DEFAULT
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["task_source_configurations"][0]["autoImportActiveTaskLimit"],
        5
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v44_migration_adds_safe_task_agent_launch_defaults() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-automation-v44-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 44,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [],
            "project_task_automation_configurations": [{
                "projectId": "project-1",
                "createWorktree": true,
                "agentId": "codex"
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.project_task_automation_configurations(),
        &[termloop_domain::ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: true,
            worktree_prefix: "termloop".into(),
            agent_id: Some("codex".into()),
            model: Some("default".into()),
            permission: Some("default".into()),
            reasoning: Some("default".into()),
            kickoff_message: None,
        }]
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["model"],
        "default"
    );
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["reasoning"],
        "default"
    );
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["permission"],
        "default"
    );
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["kickoffMessage"],
        serde_json::Value::Null
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v45_migration_adds_safe_task_agent_permission_defaults() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-automation-v45-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 45,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [],
            "project_task_automation_configurations": [{
                "projectId": "project-1",
                "createWorktree": true,
                "agentId": "codex",
                "model": "gpt-5.6-sol",
                "reasoning": "high",
                "kickoffMessage": null
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.project_task_automation_configurations()[0].permission,
        Some("default".into())
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["permission"],
        "default"
    );
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["worktreePrefix"],
        "termloop"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v46_migration_adds_the_default_task_worktree_prefix() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-automation-v46-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 46,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [],
            "project_task_automation_configurations": [{
                "projectId": "project-1",
                "createWorktree": true,
                "agentId": "codex",
                "model": "gpt-5.6-sol",
                "permission": "bypassPermissions",
                "reasoning": "high",
                "kickoffMessage": null
            }],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.project_task_automation_configurations()[0].worktree_prefix,
        "termloop"
    );
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    assert_eq!(
        persisted["project_task_automation_configurations"][0]["worktreePrefix"],
        "termloop"
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v42_migration_preserves_legacy_default_automation_fields() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-automation-default-v42-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut source = legacy_task_source("source-1", false, None);
    source.as_object_mut().unwrap().remove("createWorktree");
    source.as_object_mut().unwrap().remove("agentId");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 42,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [source],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.project_task_automation_configurations(),
        &[termloop_domain::ProjectTaskAutomationConfiguration {
            project_id: "project-1".into(),
            create_worktree: false,
            worktree_prefix: "termloop".into(),
            agent_id: None,
            model: None,
            permission: None,
            reasoning: None,
            kickoff_message: None,
        }]
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn v42_migration_does_not_broaden_conflicting_source_automation() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-task-automation-conflict-v42-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 42,
            "revision": 7,
            "projects": [{"id":"project-1","name":"Project","folder_path":"/tmp/project"}],
            "task_source_configurations": [
                legacy_task_source("source-1", true, Some("codex")),
                legacy_task_source("source-2", false, None),
            ],
            "sessions": []
        }))
        .unwrap(),
    )
    .unwrap();

    let store = Store::open(&path).unwrap();
    assert!(store.project_task_automation_configurations().is_empty());
    let _ = std::fs::remove_file(path);
}

fn legacy_task_source(
    id: &str,
    create_worktree: bool,
    agent_id: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "projectId": "project-1",
        "provider": "jira",
        "name": "Jira",
        "enabled": true,
        "generation": 1,
        "siteBaseUrl": "https://example.atlassian.net",
        "scope": {"kind":"assignedToMe"},
        "boards": [],
        "statuses": [],
        "importPolicy": "review",
        "createWorktree": create_worktree,
        "agentId": agent_id,
        "refreshIntervalSeconds": 900,
        "ignoredExternalIds": [],
        "createdAtEpochMs": 1,
        "updatedAtEpochMs": 1
    })
}
