use serde_json::json;
use termloop_contract::current::{
    COMPANION_METHODS, MCP_STEWARD_TOOLS, MCP_WORKER_TOOLS, METHODS, READ_ONLY_METHODS,
    validate_mcp_tool_params, validate_mcp_tool_result, validate_method_params,
    validate_method_result,
};

fn milestone() -> serde_json::Value {
    json!({
        "id": "pr-approved",
        "title": "PR approved",
        "gate": "human",
        "routineId": "routine-pr",
        "retryDelaySeconds": 600,
        "condition": "PR review projection shows an approval by the named approver.",
        "approver": "ferit"
    })
}

fn milestone_draft() -> serde_json::Value {
    json!({
        "id": "pr-approved",
        "title": "PR approved",
        "gate": "human",
        "check": {
            "kind": "ciPr",
            "instructions": "Check the PR review projection.",
            "stewardInstructions": "If approval is still missing, propose asking the reviewer and ask the user whether to send it.",
            "actionHandling": "ask",
            "workerId": "worker-1"
        },
        "retryDelaySeconds": 600,
        "condition": "PR review projection shows an approval by the named approver.",
        "approver": "ferit"
    })
}

#[test]
fn playbook_surface_is_strict_and_scoped() {
    assert!(METHODS.contains(&"playbook.get"));
    assert!(METHODS.contains(&"playbook.update"));
    assert!(METHODS.contains(&"playbook.taskPositionSet"));
    assert!(READ_ONLY_METHODS.contains(&"playbook.get"));
    assert!(!READ_ONLY_METHODS.contains(&"playbook.update"));
    assert!(!READ_ONLY_METHODS.contains(&"playbook.taskPositionSet"));
    assert!(!COMPANION_METHODS.contains(&"playbook.get"));
    assert!(!COMPANION_METHODS.contains(&"playbook.update"));
    assert!(!COMPANION_METHODS.contains(&"playbook.taskPositionSet"));

    assert!(validate_method_params(
        "playbook.get",
        &json!({"projectId": "project-1"})
    ));
    assert!(!validate_method_params("playbook.get", &json!({})));

    assert!(validate_method_params(
        "playbook.taskPositionSet",
        &json!({
            "projectId": "project-1",
            "taskId": "task-1",
            "passedMilestoneCount": 2,
            "expectedPlaybookRevision": 4,
            "expectedRevision": 9
        })
    ));
    assert!(!validate_method_params(
        "playbook.taskPositionSet",
        &json!({
            "projectId": "project-1",
            "taskId": "task-1",
            "passedMilestoneCount": 25,
            "expectedPlaybookRevision": 4,
            "expectedRevision": 9
        })
    ));
    assert!(validate_method_result(
        "playbook.taskPositionSet",
        &json!({
            "taskId": "task-1",
            "passedMilestoneCount": 2,
            "stateRevision": 10
        })
    ));

    assert!(validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [milestone_draft()],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));

    let mut human_without_approver = milestone_draft();
    human_without_approver
        .as_object_mut()
        .unwrap()
        .remove("approver");
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [human_without_approver],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));

    let mut automatic = milestone_draft();
    automatic["gate"] = json!("automatic");
    automatic["approver"] = serde_json::Value::Null;
    assert!(validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [automatic],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));

    // Entry IDs are bounded slugs.
    let mut bad_id = milestone_draft();
    bad_id["id"] = json!("no spaces");
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [bad_id],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 1,
            "expectedRevision": 4
        })
    ));
    // The retired rules surface is gone from the wire: a document still
    // carrying one is refused, not quietly accepted and dropped.
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [],
            "workerId": null,
            "preferredWorkerAgentId": "codex",
            "rules": [{"id": "deploy-watch"}],
            "expectedPlaybookRevision": 1,
            "expectedRevision": 4
        })
    ));

    let playbook = json!({
        "projectId": "project-1",
        "revision": 2,
        "activePipelineName": "Ship to production",
        "savedPipelines": [],
        "milestones": [milestone()],
        "updatedAtEpochMs": 5
    });
    assert!(validate_method_result(
        "playbook.get",
        &json!({"playbook": playbook, "stateRevision": 9})
    ));
    assert!(validate_method_result(
        "playbook.get",
        &json!({"playbook": null, "stateRevision": 9})
    ));
    assert!(validate_method_result(
        "playbook.update",
        &json!({"playbook": playbook, "workerId": "worker-1", "stateRevision": 9})
    ));
    assert!(!validate_method_result(
        "playbook.update",
        &json!({"playbook": null, "stateRevision": 9})
    ));
}

#[test]
fn playbook_and_brief_tools_are_steward_only_and_strict() {
    assert!(MCP_STEWARD_TOOLS.contains(&"playbook_read"));
    assert!(MCP_STEWARD_TOOLS.contains(&"task_set_steward_brief"));
    assert!(!MCP_WORKER_TOOLS.contains(&"playbook_read"));
    assert!(!MCP_WORKER_TOOLS.contains(&"task_set_steward_brief"));

    assert!(validate_mcp_tool_params("playbook_read", &json!({})));
    assert!(!validate_mcp_tool_params(
        "playbook_read",
        &json!({"projectId": "project-1"})
    ));

    assert!(validate_mcp_tool_params(
        "task_set_steward_brief",
        &json!({
            "taskId": "task-1",
            "briefMarkdown": "## Observed\n- tests green (a3f19c2)",
            "expectedBriefRevision": 1
        })
    ));
    assert!(!validate_mcp_tool_params(
        "task_set_steward_brief",
        &json!({"taskId": "task-1", "briefMarkdown": "x"})
    ));
    assert!(!validate_mcp_tool_params(
        "task_set_steward_brief",
        &json!({
            "taskId": "task-1",
            "briefMarkdown": "x".repeat(8001),
            "expectedBriefRevision": 1
        })
    ));
    assert!(validate_mcp_tool_result(
        "task_set_steward_brief",
        &json!({"taskId": "task-1", "status": "updated", "briefRevision": 2})
    ));
    assert!(!validate_mcp_tool_result(
        "task_set_steward_brief",
        &json!({"taskId": "task-1", "status": "updated"})
    ));
}

#[test]
fn task_dto_carries_optional_steward_brief_fields() {
    let task = json!({
        "id": "task-1",
        "project_id": "project-1",
        "title": "Task",
        "brief": null,
        "jira_url": null,
        "status": "open",
        "archived_at_epoch_ms": null,
        "branch": null,
        "worktree": null,
        "rank": 0,
        "created_at_epoch_ms": 1,
        "updated_at_epoch_ms": 1,
        "steward_brief_markdown": "## Observed\n- CI green",
        "steward_brief_revision": 3
    });
    assert!(validate_method_result("task.create", &task));
    let mut zero_revision = task.clone();
    zero_revision["steward_brief_revision"] = json!(0);
    assert!(!validate_method_result("task.create", &zero_revision));
}

#[test]
fn playbook_step_carries_its_check_intent_and_retry_delay() {
    // Mutation input describes check intent; internal Routine identity is
    // materialized by Core and appears only in the read projection.
    let mut without_check = milestone_draft();
    without_check.as_object_mut().unwrap().remove("check");
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [without_check],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));

    // The retry delay is bounded like every other cadence on the wire.
    for delay in [30, 90_000] {
        let mut out_of_range = milestone_draft();
        out_of_range["retryDelaySeconds"] = json!(delay);
        assert!(!validate_method_params(
            "playbook.update",
            &json!({
                "projectId": "project-1",
                "activePipelineName": "Ship to production",
                "savedPipelines": [],
                "milestones": [out_of_range],
                "workerId": "worker-1",
                "preferredWorkerAgentId": "codex",
                "expectedPlaybookRevision": 0,
                "expectedRevision": 4
            })
        ));
    }

    // A step carries one typed check; it has no second sensor vocabulary.
    let mut step_with_sensor = milestone_draft();
    step_with_sensor["sensorKind"] = json!("pullRequest");
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "savedPipelines": [],
            "milestones": [step_with_sensor],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));
}

#[test]
fn routine_trigger_mode_is_a_closed_wire_choice() {
    for mode in ["schedule", "onDemand"] {
        assert!(validate_method_params(
            "routine.configurationCreate",
            &json!({
                "projectId": "project-1",
                "workerId": "worker-1",
                "kind": "ciPr",
                "triggerMode": mode,
                "name": "PR checker",
                "scheduleIntervalSeconds": 900,
                "actionHandling": "off",
                "expectedRevision": 7
            })
        ));
    }
    assert!(!validate_method_params(
        "routine.configurationCreate",
        &json!({
            "projectId": "project-1",
            "workerId": "worker-1",
            "kind": "ciPr",
            "triggerMode": "whenever",
            "name": "PR checker",
            "scheduleIntervalSeconds": 900,
            "actionHandling": "off",
            "expectedRevision": 7
        })
    ));
}

#[test]
fn a_playbook_keeps_the_pipelines_it_is_not_walking() {
    let kept = json!({
        "name": "Code review",
        "milestones": [milestone_draft()]
    });
    assert!(validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "milestones": [milestone_draft()],
            "savedPipelines": [kept],
            "workerId": "worker-1",
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 1,
            "expectedRevision": 4
        })
    ));

    // The active pipeline always has a name, and a kept one always has both a
    // name and its own questions: switching needs to know what it is switching
    // to, so neither half is optional on the wire.
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "milestones": [],
            "savedPipelines": [],
            "workerId": null,
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "",
            "milestones": [],
            "savedPipelines": [],
            "workerId": null,
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));
    assert!(!validate_method_params(
        "playbook.update",
        &json!({
            "projectId": "project-1",
            "activePipelineName": "Ship to production",
            "milestones": [],
            "savedPipelines": [{"name": "Code review"}],
            "workerId": null,
            "preferredWorkerAgentId": "codex",
            "expectedPlaybookRevision": 0,
            "expectedRevision": 4
        })
    ));

    // A read reports the same shape, so the board can list what to switch to.
    assert!(validate_method_result(
        "playbook.get",
        &json!({
            "playbook": {
                "projectId": "project-1",
                "revision": 2,
                "activePipelineName": "Ship to production",
                "milestones": [milestone()],
                "savedPipelines": [{"name": "Code review", "milestones": [milestone()]}],
                "updatedAtEpochMs": 5
            },
            "stateRevision": 9
        })
    ));
}

#[test]
fn the_board_reads_where_every_task_is_standing() {
    assert!(METHODS.contains(&"playbook.runtime"));
    // Reading where Tasks stand changes nothing, so it belongs to the
    // read-only scope beside `playbook.get`.
    assert!(READ_ONLY_METHODS.contains(&"playbook.runtime"));
    assert!(!COMPANION_METHODS.contains(&"playbook.runtime"));

    assert!(validate_method_params(
        "playbook.runtime",
        &json!({"projectId": "project-1"})
    ));
    assert!(!validate_method_params("playbook.runtime", &json!({})));

    let step = json!({
        "milestoneId": "pr-approved",
        "routineId": "routine-pr",
        "waitingTaskIds": ["task-2"],
        "progress": [{
            "taskId": "task-1",
            "verdict": "passed",
            "evidence": "PR #12 is approved by ferit.",
            "decidedAtEpochMs": 20,
            "nextAttemptAtEpochMs": null
        }, {
            "taskId": "task-2",
            "verdict": "waiting",
            "evidence": "No branch has been pushed yet.",
            "decidedAtEpochMs": 20,
            "nextAttemptAtEpochMs": 620
        }],
        "nextAttemptAtEpochMs": 620
    });
    assert!(validate_method_result(
        "playbook.runtime",
        &json!({
            "activePipelineName": "Ship to production",
            "processingTaskId": "task-2",
            "steps": [step],
            "doneTaskIds": [],
            "stateRevision": 9
        })
    ));
    assert!(validate_method_result(
        "playbook.runtime",
        &json!({
            "activePipelineName": "Ship to production",
            "processingTaskId": null,
            "steps": [],
            "doneTaskIds": [],
            "stateRevision": 9
        })
    ));
    assert!(!validate_method_result(
        "playbook.runtime",
        &json!({
            "activePipelineName": "Ship to production",
            "steps": [],
            "doneTaskIds": [],
            "stateRevision": 9
        })
    ));

    // A verdict is a closed two-value answer, never free text.
    let mut invented = step.clone();
    invented["progress"][0]["verdict"] = json!("probably");
    assert!(!validate_method_result(
        "playbook.runtime",
        &json!({
            "activePipelineName": "Ship to production",
            "processingTaskId": null,
            "steps": [invented],
            "doneTaskIds": [],
            "stateRevision": 9
        })
    ));
}

#[test]
fn a_step_check_is_finished_with_verdicts_and_only_by_a_worker() {
    assert!(MCP_WORKER_TOOLS.contains(&"worker_report_step_verdicts"));
    assert!(!MCP_STEWARD_TOOLS.contains(&"worker_report_step_verdicts"));
    // MCP-only tools never enter the control method enum.
    assert!(!METHODS.contains(&"worker_report_step_verdicts"));

    assert!(validate_mcp_tool_params(
        "worker_report_step_verdicts",
        &json!({
            "checkId": "check-1",
            "verdicts": [
                {"taskId": "task-1", "passed": true, "evidence": "PR #12 is open against main."}
            ]
        })
    ));

    // The scheduler focuses one Task at a time; a Worker cannot recreate the
    // retired stage-wide batch by submitting additional Task verdicts.
    assert!(!validate_mcp_tool_params(
        "worker_report_step_verdicts",
        &json!({
            "checkId": "check-1",
            "verdicts": [
                {"taskId": "task-1", "passed": true, "evidence": "PR #12 is open."},
                {"taskId": "task-2", "passed": false, "evidence": "No branch pushed yet."}
            ]
        })
    ));

    // A verdict always says which Task, whether it passed, and on what basis:
    // a `passed` with nothing behind it is exactly the claim this must refuse.
    for incomplete in [
        json!({"taskId": "task-1", "passed": true}),
        json!({"taskId": "task-1", "passed": true, "evidence": ""}),
        json!({"passed": true, "evidence": "Seen."}),
        json!({"taskId": "task-1", "evidence": "Seen."}),
    ] {
        assert!(!validate_mcp_tool_params(
            "worker_report_step_verdicts",
            &json!({"checkId": "check-1", "verdicts": [incomplete]})
        ));
    }

    // Answering nobody is not an answer.
    assert!(!validate_mcp_tool_params(
        "worker_report_step_verdicts",
        &json!({"checkId": "check-1", "verdicts": []})
    ));
    // Evidence is one short sentence, not a place to park a payload.
    assert!(!validate_mcp_tool_params(
        "worker_report_step_verdicts",
        &json!({
            "checkId": "check-1",
            "verdicts": [{"taskId": "task-1", "passed": true, "evidence": "x".repeat(601)}]
        })
    ));

    assert!(validate_mcp_tool_result(
        "worker_report_step_verdicts",
        &json!({"status": "verdictsRecorded"})
    ));
}
