mod current_branch_commits;
mod current_changes;
mod current_cleanup;
mod current_companion;
mod current_companion_supervisor;
mod current_git_host;
mod current_launch;
mod current_mcp;
mod current_playbook;
mod current_relocation;
mod current_repair;
mod current_run;
mod current_steward;
mod current_steward_authority;
mod current_task_source;
mod current_tracker;
mod current_worktree;

use termloop_contract::current::{
    COMPANION_METHODS, CONTRACT_IDENTITY, ControlRequest, METHODS, READ_ONLY_METHODS,
    validate_method_params, validate_method_result,
};

#[test]
fn generated_envelope_rejects_unknown_fields() {
    let message = serde_json::json!({
        "id": "1",
        "protocolVersion": CONTRACT_IDENTITY,
        "token": "x".repeat(64),
        "method": "system.ping",
        "params": {},
        "unexpected": true
    });
    assert!(serde_json::from_value::<ControlRequest>(message).is_err());
}

#[test]
fn project_task_automation_is_strict_and_revision_checked() {
    assert!(METHODS.contains(&"project.taskAutomationGet"));
    assert!(METHODS.contains(&"project.taskAutomationSet"));
    assert!(READ_ONLY_METHODS.contains(&"project.taskAutomationGet"));
    assert!(!READ_ONLY_METHODS.contains(&"project.taskAutomationSet"));
    assert!(validate_method_params(
        "project.taskAutomationSet",
        &serde_json::json!({
            "projectId":"project-1", "createWorktree":true,
            "agentId":"codex", "model":"gpt-5.6-sol",
            "reasoning":"high", "kickoffMessage":"Implement and verify.",
            "expectedRevision":1
        })
    ));
    assert!(!validate_method_params(
        "project.taskAutomationSet",
        &serde_json::json!({
            "projectId":"project-1", "createWorktree":false,
            "agentId":"codex", "model":"gpt-5.6-sol",
            "reasoning":"high", "kickoffMessage":null,
            "expectedRevision":1
        })
    ));
}

#[test]
fn quick_action_image_attachment_is_strict_and_bounded() {
    let attachment = serde_json::json!({
        "attachmentId": "123e4567-e89b-42d3-a456-426614174000",
        "mediaType": "image/png",
        "byteLength": 4096,
        "sha256": format!("sha256:{}", "a".repeat(64)),
        "width": 800,
        "height": 600
    });
    let params = serde_json::json!({
        "projectId": "project-1",
        "cwd": "/tmp/project",
        "agentId": "codex",
        "model": "default",
        "permission": "default",
        "reasoning": "default",
        "templateRef": "builtin.quick-action.free-prompt",
        "bindings": { "prompt": "Inspect this image" },
        "attachments": [attachment]
    });
    assert!(validate_method_params("quickAction.preview", &params));
    let mut missing = params.clone();
    missing.as_object_mut().unwrap().remove("attachments");
    assert!(!validate_method_params("quickAction.preview", &missing));
    let mut oversized = params.clone();
    oversized["attachments"][0]["byteLength"] = serde_json::json!(10 * 1024 * 1024 + 1);
    assert!(!validate_method_params("quickAction.preview", &oversized));
    let mut two = params;
    let repeated = two["attachments"][0].clone();
    two["attachments"] = serde_json::json!([repeated.clone(), repeated]);
    assert!(!validate_method_params("quickAction.preview", &two));
}

#[test]
fn companion_append_derives_author_and_bounds_utf8_bytes() {
    assert!(validate_method_params(
        "companion.transcriptAppend",
        &serde_json::json!({"projectId":"project-1","content":"ş".repeat(24_576)})
    ));
    assert!(!validate_method_params(
        "companion.transcriptAppend",
        &serde_json::json!({"projectId":"project-1","content":"ş".repeat(24_577)})
    ));
    assert!(!validate_method_params(
        "companion.transcriptAppend",
        &serde_json::json!({"projectId":"project-1","author":"user","content":"spoof"})
    ));
}

#[test]
fn agent_plan_projection_is_bounded_and_hook_input_is_strict() {
    let steps = serde_json::json!([
        { "text": "Inspect the flow", "status": "completed" },
        { "text": "Implement the projection", "status": "inProgress" },
        { "text": "Run focused tests", "status": "pending" }
    ]);
    assert!(validate_method_params(
        "agent.observe",
        &serde_json::json!({
            "sessionId": "session-1",
            "observationProtocolVersion": 1,
            "transport": "launchScopedHook",
            "eventName": "PreToolUse",
            "plan": { "kind": "replace", "explanation": null, "steps": steps }
        })
    ));
    assert!(validate_method_result(
        "agent.statusList",
        &serde_json::json!([{
            "sessionId": "session-1",
            "status": "working",
            "source": "hook",
            "observedAtEpochMs": 10,
            "plan": {
                "source": "claudeHook",
                "explanation": null,
                "steps": steps,
                "updatedAtEpochMs": 10
            }
        }])
    ));
    assert!(!validate_method_params(
        "agent.observe",
        &serde_json::json!({
            "sessionId": "session-1",
            "observationProtocolVersion": 1,
            "transport": "launchScopedHook",
            "eventName": "PreToolUse",
            "plan": {
                "source": "claudeHook",
                "explanation": null,
                "steps": []
            }
        })
    ));
    assert!(!validate_method_params(
        "agent.observe",
        &serde_json::json!({
            "sessionId": "session-1",
            "observationProtocolVersion": 1,
            "transport": "launchScopedHook",
            "eventName": "PreToolUse",
            "plan": {
                "kind": "replace",
                "explanation": null,
                "steps": [{ "text": "x".repeat(513), "status": "pending" }]
            }
        })
    ));
}

#[test]
fn contract_identity_and_capability_registry_are_generated() {
    assert_eq!(CONTRACT_IDENTITY.len(), 71);
    assert!(CONTRACT_IDENTITY.starts_with("sha256:"));
    assert!(METHODS.contains(&"project.create"));
    assert!(METHODS.contains(&"project.listLocalBranches"));
    assert!(METHODS.contains(&"project.worktreeSummary"));
    assert!(METHODS.contains(&"project.worktreeChangeList"));
    assert!(METHODS.contains(&"project.worktreeDiff"));
    assert!(METHODS.contains(&"project.worktreePreImage"));
    assert!(METHODS.contains(&"project.updateDetails"));
    assert!(METHODS.contains(&"project.delete"));
    assert!(READ_ONLY_METHODS.contains(&"project.list"));
    assert!(READ_ONLY_METHODS.contains(&"task.list"));
    assert!(!READ_ONLY_METHODS.contains(&"project.create"));
    assert!(!READ_ONLY_METHODS.contains(&"project.listLocalBranches"));
    assert!(!READ_ONLY_METHODS.contains(&"project.worktreeSummary"));
    assert!(!READ_ONLY_METHODS.contains(&"project.worktreeChangeList"));
    assert!(!READ_ONLY_METHODS.contains(&"project.worktreeDiff"));
    assert!(!READ_ONLY_METHODS.contains(&"project.worktreePreImage"));
    assert!(!READ_ONLY_METHODS.contains(&"project.updateDetails"));
    assert!(!READ_ONLY_METHODS.contains(&"project.delete"));
    assert!(!READ_ONLY_METHODS.contains(&"task.create"));
    assert!(COMPANION_METHODS.contains(&"companion.transcriptAppend"));
    assert!(COMPANION_METHODS.contains(&"companion.transcriptList"));
    assert!(!COMPANION_METHODS.contains(&"companion.transcriptClear"));
    assert!(READ_ONLY_METHODS.contains(&"steward.configurationGet"));
    assert!(COMPANION_METHODS.contains(&"steward.configurationGet"));
    assert!(!COMPANION_METHODS.contains(&"steward.configurationSet"));
    assert!(METHODS.contains(&"task.bindBranch"));
    assert!(!READ_ONLY_METHODS.contains(&"task.bindBranch"));
    assert!(METHODS.contains(&"task.provisionWorktree"));
    assert!(!READ_ONLY_METHODS.contains(&"task.provisionWorktree"));
    // Graceful daemon shutdown stays a Full-scope command.
    assert!(METHODS.contains(&"system.shutdown"));
    assert!(!READ_ONLY_METHODS.contains(&"system.shutdown"));
    assert!(!COMPANION_METHODS.contains(&"system.shutdown"));
    assert!(validate_method_params(
        "system.shutdown",
        &serde_json::json!({})
    ));
    assert!(!validate_method_params(
        "system.shutdown",
        &serde_json::json!({ "force": true })
    ));
    assert!(validate_method_result(
        "system.shutdown",
        &serde_json::json!({ "accepted": true })
    ));
    assert!(!validate_method_result(
        "system.shutdown",
        &serde_json::json!({ "accepted": false })
    ));
}

#[test]
fn generated_method_params_reject_missing_extra_and_wrong_types() {
    assert!(validate_method_params(
        "project.create",
        &serde_json::json!({ "name": "Demo", "folderPath": "/tmp/demo" })
    ));
    assert!(!validate_method_params(
        "project.create",
        &serde_json::json!({ "name": "Demo" })
    ));
    assert!(!validate_method_params(
        "project.create",
        &serde_json::json!({ "name": "Demo", "folderPath": "/tmp/demo", "extra": true })
    ));
    assert!(validate_method_params(
        "project.updateDetails",
        &serde_json::json!({
            "projectId": "p1",
            "name": "Demo",
            "folderPath": "/tmp/demo"
        })
    ));
    assert!(!validate_method_params(
        "project.updateDetails",
        &serde_json::json!({ "projectId": "p1", "name": "Demo" })
    ));
    assert!(!validate_method_params(
        "project.delete",
        &serde_json::json!({ "projectId": "p1", "extra": true })
    ));
    assert!(!validate_method_params(
        "session.terminate",
        &serde_json::json!({ "sessionId": 42 })
    ));
    assert!(!validate_method_params(
        "system.ping",
        &serde_json::json!({ "unexpected": true })
    ));
    assert!(validate_method_params(
        "session.rename",
        &serde_json::json!({ "sessionId": "s1", "name": null })
    ));
    assert!(!validate_method_params(
        "session.rename",
        &serde_json::json!({ "sessionId": "s1" })
    ));
    assert!(validate_method_params(
        "task.create",
        &serde_json::json!({
            "projectId": "p1",
            "title": "Build API",
            "brief": null,
            "worktreeIntent": "inherit",
            "agentId": null,
            "model": null,
            "reasoning": null,
            "kickoffMessage": null
        })
    ));
    assert!(validate_method_params(
        "task.create",
        &serde_json::json!({
            "projectId": "p1",
            "title": "Build API",
            "worktreeIntent": "provision",
            "agentId": null,
            "model": null,
            "reasoning": null,
            "kickoffMessage": null
        })
    ));
    assert!(!validate_method_params(
        "task.create",
        &serde_json::json!({
            "projectId": "p1",
            "title": "Build API",
            "worktreeIntent": "none",
            "agentId": null,
            "model": "gpt-5.6-sol",
            "reasoning": null,
            "kickoffMessage": null
        })
    ));
    assert!(!validate_method_params(
        "task.rename",
        &serde_json::json!({ "taskId": "t1", "title": "Task", "extra": true })
    ));
    assert!(validate_method_params(
        "task.bindBranch",
        &serde_json::json!({
            "taskId": "t1",
            "repositoryPath": "/tmp/repo",
            "branchName": "feature/api"
        })
    ));
    assert!(!validate_method_params(
        "task.bindBranch",
        &serde_json::json!({ "taskId": "t1", "repositoryPath": "/tmp/repo" })
    ));
    assert!(validate_method_params(
        "task.provisionWorktree",
        &serde_json::json!({
            "operationId": "11111111-1111-4111-8111-111111111111",
            "taskId": "t1",
            "repositoryPath": "/tmp/repo",
            "destinationPath": "/tmp/worktree",
            "branchName": "feature/api",
            "branchMode": "create",
            "baseRef": "refs/heads/main"
        })
    ));
    assert!(!validate_method_params(
        "task.provisionWorktree",
        &serde_json::json!({
            "operationId": "11111111-1111-4111-8111-111111111111",
            "taskId": "t1",
            "repositoryPath": "/tmp/repo",
            "branchName": "feature/api",
            "branchMode": "create"
        })
    ));
}

#[test]
fn routine_create_accepts_built_in_and_custom_kinds() {
    for (kind, name) in [
        ("jira", "Jira issue synchronizer"),
        ("custom", "Customer pulse"),
    ] {
        assert!(validate_method_params(
            "routine.configurationCreate",
            &serde_json::json!({
                "projectId": "project-1",
                "workerId": "worker-1",
                "kind": kind,
                "triggerMode": "schedule",
                "name": name,
                "scheduleIntervalSeconds": 900,
                "actionHandling": "off",
                "expectedRevision": 7
            })
        ));
    }
}

#[test]
fn worker_ping_interval_and_editable_prompts_are_required_and_bounded() {
    let update = serde_json::json!({
        "workerId": "worker-1",
        "name": "Worker 1",
        "agentId": "codex",
        "model": "gpt-5.6-sol",
        "permission": "bypassPermissions",
        "reasoning": "high",
        "enabled": true,
        "pingIntervalSeconds": 60,
        "workerPrompt": "Handle each Routine carefully.",
        "systemPrompt": "Answer briefly.",
        "expectedRevision": 3
    });
    assert!(validate_method_params(
        "worker.configurationUpdate",
        &update
    ));
    let mut missing = update.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("pingIntervalSeconds");
    assert!(!validate_method_params(
        "worker.configurationUpdate",
        &missing
    ));
    let mut too_fast = update;
    too_fast["pingIntervalSeconds"] = serde_json::json!(59);
    assert!(!validate_method_params(
        "worker.configurationUpdate",
        &too_fast
    ));
    let mut missing_prompt = serde_json::json!({
        "workerId": "worker-1",
        "name": "Worker 1",
        "agentId": "codex",
        "model": "default",
        "permission": "default",
        "reasoning": "default",
        "enabled": true,
        "pingIntervalSeconds": 60,
        "workerPrompt": "",
        "systemPrompt": "",
        "expectedRevision": 3
    });
    missing_prompt
        .as_object_mut()
        .unwrap()
        .remove("workerPrompt");
    assert!(!validate_method_params(
        "worker.configurationUpdate",
        &missing_prompt
    ));
    let mut oversized = missing_prompt;
    oversized["workerPrompt"] = serde_json::json!("ş".repeat(8_193));
    assert!(!validate_method_params(
        "worker.configurationUpdate",
        &oversized
    ));
}

#[test]
fn branch_conflict_details_are_typed_and_reject_unknown_fields() {
    let valid = serde_json::json!({
        "code": "conflict",
        "message": "branch held",
        "details": { "kind": "branchHeldByTask", "taskId": "holder" }
    });
    assert!(serde_json::from_value::<termloop_contract::current::ProtocolError>(valid).is_ok());
    let invalid = serde_json::json!({
        "code": "conflict",
        "message": "branch held",
        "details": { "kind": "branchHeldByTask", "taskId": "holder", "extra": true }
    });
    assert!(serde_json::from_value::<termloop_contract::current::ProtocolError>(invalid).is_err());
    let recovery = serde_json::json!({
        "code": "conflict",
        "message": "attention",
        "details": { "kind": "worktreeRecoveryAttention", "operationId": "operation-1" }
    });
    assert!(serde_json::from_value::<termloop_contract::current::ProtocolError>(recovery).is_ok());
}

#[test]
fn generated_method_results_cover_project_task_and_session_wire_shapes() {
    assert!(validate_method_params(
        "project.worktreeSummary",
        &serde_json::json!({ "projectId": "p1" })
    ));
    assert!(validate_method_result(
        "project.worktreeSummary",
        &serde_json::json!({
            "project_id": "p1",
            "checked_out_branch": "feature/sidebar",
            "change_count": 3
        })
    ));
    assert!(!validate_method_result(
        "project.worktreeSummary",
        &serde_json::json!({
            "project_id": "p1",
            "checked_out_branch": "feature/sidebar",
            "change_count": 3,
            "extra": true
        })
    ));
    assert!(validate_method_result(
        "project.worktreeChangeList",
        &serde_json::json!({
            "project_id": "p1",
            "observation_id": "project-changes-1",
            "entries": [],
            "truncated": false
        })
    ));
    assert!(validate_method_result(
        "project.worktreeDiff",
        &serde_json::json!({
            "project_id": "p1",
            "observation_id": "project-changes-1",
            "entry_id": "entry-0",
            "state": "patch",
            "patch": "diff --git a/a b/a"
        })
    ));
    assert!(validate_method_result(
        "project.listLocalBranches",
        &serde_json::json!({
            "repository_root": "/tmp/demo",
            "branches": [
                { "name": "feature/api", "exact_ref": "refs/heads/feature/api" },
                { "name": "main", "exact_ref": "refs/heads/main" }
            ],
            "truncated": false
        })
    ));
    assert!(!validate_method_result(
        "project.listLocalBranches",
        &serde_json::json!({
            "repository_root": "/tmp/demo",
            "branches": [{ "name": "main", "exact_ref": "main" }],
            "truncated": false
        })
    ));
    assert!(validate_method_result(
        "project.list",
        &serde_json::json!([{ "id": "p1", "name": "Demo", "folder_path": "/tmp/demo" }])
    ));
    assert!(validate_method_result(
        "project.delete",
        &serde_json::json!({ "projectId": "p1", "deleted": true })
    ));
    assert!(validate_method_result(
        "task.list",
        &serde_json::json!({"items": [{
            "id": "t1",
            "project_id": "p1",
            "title": "Build API",
            "brief": null,
            "jira_url": null,
            "status": "open",
            "archived_at_epoch_ms": null,
            "branch": null,
            "worktree": null,
            "rank": 0,
            "created_at_epoch_ms": 1,
            "updated_at_epoch_ms": 1
        }], "next_cursor": null})
    ));
    assert!(!validate_method_result(
        "task.list",
        &serde_json::json!({"items": [{
            "id": "t1",
            "project_id": "p1",
            "title": "Build API",
            "brief": null,
            "jira_url": null,
            "status": "open",
            "archived_at_epoch_ms": null,
            "branch": { "repository_root": "/tmp/repo", "name": "feat/api", "extra": true },
            "worktree": null,
            "rank": 0,
            "created_at_epoch_ms": 1,
            "updated_at_epoch_ms": 1
        }], "next_cursor": null})
    ));
    assert!(validate_method_result(
        "session.list",
        &serde_json::json!([{
            "id": "s1",
            "project_id": "p1",
            "name": null,
            "kind": "Terminal",
            "process": {
                "program": "/bin/sh",
                "args": [],
                "cwd": "/tmp/demo",
                "agent_id": null,
                "template_ref": null,
                "template_version": null
            },
            "lifecycle_state": "running",
            "runtime_epoch": 1,
            "archived_at_epoch_ms": null,
            "resume_failure_reason": null,
            "retryable": false,
            "closable": false,
            "forkable": false,
            "ask_to_source_session_id": null,
            "run_configuration_id": null
        }])
    ));
    assert!(!validate_method_result(
        "session.list",
        &serde_json::json!([{
            "id": "s1",
            "project_id": "p1",
            "kind": "Terminal",
            "process": {
                "program": "/bin/sh",
                "args": [],
                "cwd": "/tmp/demo",
                "agent_id": null,
                "template_ref": null,
                "template_version": null
            },
            "lifecycle_state": "running",
            "runtime_epoch": 1,
            "archived_at_epoch_ms": null,
            "resume_failure_reason": null,
            "retryable": false,
            "closable": false,
            "forkable": false,
            "ask_to_source_session_id": null,
            "run_configuration_id": null
        }])
    ));
}
