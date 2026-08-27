use super::*;
use termloop_domain::{
    DurableAgentPlan, DurableAgentPlanSource, DurableAgentPlanStep, DurableAgentPlanStepStatus,
    ProcessDescriptor, SessionKind, SessionRecord,
};

fn agent_session(id: &str, agent_id: &str) -> SessionRecord {
    SessionRecord {
        launch_selection: Default::default(),
        id: id.into(),
        project_id: "project".into(),
        name: None,
        kind: SessionKind::Agent,
        process: ProcessDescriptor {
            program: agent_id.into(),
            args: vec![],
            cwd: "/tmp".into(),
            agent_id: Some(agent_id.into()),
            template_ref: Some("builtin.agent.interactive".into()),
            template_version: Some(5),
        },
        lifecycle_state: "running".into(),
        runtime_epoch: 1,
        archived_at_epoch_ms: None,
        ask_to_source_session_id: None,
        run_configuration_id: None,
        improver_target: None,
        ask_to_continuation: None,
        resume_ref: None,
        resume_launch_guard: None,
        resume_failure: None,
    }
}

fn claude_plan(status: DurableAgentPlanStepStatus) -> DurableAgentPlan {
    DurableAgentPlan {
        session_id: "claude-session".into(),
        source: DurableAgentPlanSource::ClaudeHook,
        explanation: None,
        steps: vec![DurableAgentPlanStep {
            text: "Persist the current plan".into(),
            status,
            provider_task_id: Some("provider-task-1".into()),
        }],
        updated_at_epoch_ms: 10,
    }
}

#[test]
fn agent_plan_replaces_in_place_survives_reopen_and_clears_with_session() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-agent-plan-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(&authority, agent_session("claude-session", "claude"))
        .unwrap();
    store
        .replace_agent_plan(&authority, claude_plan(DurableAgentPlanStepStatus::Pending))
        .unwrap();
    let mut replacement = claude_plan(DurableAgentPlanStepStatus::Completed);
    replacement.updated_at_epoch_ms = 20;
    store.replace_agent_plan(&authority, replacement).unwrap();
    drop(store);

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.agent_plans().len(), 1);
    assert_eq!(
        reopened.agent_plans()[0].steps[0].status,
        DurableAgentPlanStepStatus::Completed
    );
    reopened
        .mark_session_exited(&authority, "claude-session")
        .unwrap();
    reopened
        .delete_session_descriptor(&authority, "claude-session")
        .unwrap();
    assert!(reopened.agent_plans().is_empty());
    drop(reopened);
    assert!(Store::open(&path).unwrap().agent_plans().is_empty());
    let _ = std::fs::remove_file(path);
}

#[test]
fn agent_plan_rejects_cross_provider_and_unbounded_state() {
    let path = std::env::temp_dir().join(format!(
        "termloop-store-agent-plan-invalid-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let authority = issue_core_write_authority_for_composition();
    let mut store = Store::open(&path).unwrap();
    store
        .insert_session(&authority, agent_session("claude-session", "claude"))
        .unwrap();
    let mut invalid = claude_plan(DurableAgentPlanStepStatus::Pending);
    invalid.source = DurableAgentPlanSource::CodexAppServer;
    assert!(matches!(
        store.replace_agent_plan(&authority, invalid),
        Err(StoreError::ConstraintViolation)
    ));
    let mut invalid = claude_plan(DurableAgentPlanStepStatus::Pending);
    invalid.steps[0].text = "x".repeat(513);
    assert!(matches!(
        store.replace_agent_plan(&authority, invalid),
        Err(StoreError::ConstraintViolation)
    ));
    let _ = std::fs::remove_file(path);
}
