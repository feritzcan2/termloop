use super::*;
use crate::companion_integrations::playbook_runtime::tests::pipeline_runtime;

fn remember_last_launch(runtime: &mut CoreRuntime) {
    let mut remembered = runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == "steward-session")
        .unwrap()
        .clone();
    remembered.id = "remembered".into();
    remembered.process.template_ref = Some("builtin.agent.interactive".into());
    remembered.process.cwd = "/elsewhere".into();
    remembered.launch_selection =
        termloop_domain::AgentLaunchSelection::new("gpt-6-astra", "default", "high");
    runtime
        .store
        .insert_session_and_remember_agent_launch(&runtime.write_authority, remembered)
        .unwrap();
}

/// A Project Manager Project whose active sprint holds task-1 and task-2,
/// with a remembered ordinary launch to start checks with.
pub(crate) fn project_manager_runtime() -> (CoreRuntime, std::path::PathBuf, String) {
    let (mut runtime, root, project_id) = pipeline_runtime();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(root.clone()));
    remember_last_launch(&mut runtime);
    runtime
        .handle("projectManager.modeSet", json!({"enabled": true}))
        .unwrap();
    let revision = runtime.state_revision();
    runtime
        .handle(
            "project.modeSet",
            json!({"projectId": project_id, "mode": "projectManager", "expectedRevision": revision}),
        )
        .unwrap();
    let board = runtime
        .handle(
            "projectManager.sprintCreate",
            json!({"projectId": project_id, "name": "Sprint 1", "state": "active"}),
        )
        .unwrap();
    let sprint_id = board["sprints"][0]["id"].as_str().unwrap().to_owned();
    for task_id in ["task-1", "task-2"] {
        runtime
            .handle(
                "projectManager.taskTrackingSet",
                json!({"taskId": task_id, "sprintId": sprint_id}),
            )
            .unwrap();
    }
    (runtime, root, project_id)
}

/// Stands in for the launched check Agent: its running Session and its
/// committed MCP credential.
fn start_check_session(
    runtime: &mut CoreRuntime,
    launch: &crate::session_launch::DeliveryCheckLaunch,
) -> String {
    let mut session = runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == "steward-session")
        .unwrap()
        .clone();
    session.id = launch.plan.session_id().to_owned();
    session.runtime_epoch = launch.plan.runtime_epoch();
    session.lifecycle_state = "running".into();
    session.process.template_ref = Some(DELIVERY_CHECK_TEMPLATE.into());
    runtime
        .store
        .insert_session(&runtime.write_authority, session)
        .unwrap();
    let token = format!("{}-token", launch.check_id);
    runtime.mcp_authorizer.register(
        launch.plan.session_id().to_owned(),
        launch.plan.runtime_epoch(),
        AgentMcpRole::DeliveryCheck {
            check_id: launch.check_id.clone(),
        },
        token.clone(),
    );
    token
}

fn report(check_id: &str, task_id: &str) -> DeliveryCheckReport {
    DeliveryCheckReport {
        check_id: check_id.into(),
        tasks: vec![DeliveryCheckTaskReport {
            task_id: task_id.into(),
            environments: vec![DeliveryCheckEnvironment {
                name: "Staging".into(),
                state: "deployed".into(),
                detail: Some("v1.4.2".into()),
            }],
            blockers: Some("Waiting for QA sign-off".into()),
            notes_markdown: "## Observed\n- deploy-staging run 812 shipped v1.4.2".into(),
            ticket_proposal: Some(DeliveryCheckTicketProposal {
                title: None,
                description: Some("## Status\n- On staging".into()),
                summary: "Staging runs v1.4.2".into(),
            }),
        }],
        probe_proposals: vec![crate::project::DeliveryCheckProbeProposal {
            environment: "Staging".into(),
            argv: vec![
                "curl".into(),
                "-s".into(),
                "https://staging.example.com/version".into(),
            ],
            matcher: "commitAncestry".into(),
            reason: "The version endpoint names the deployed commit".into(),
        }],
    }
}

#[test]
fn a_delivery_check_runs_in_the_project_checkout_records_once_and_is_retired() {
    let (mut runtime, root, project_id) = project_manager_runtime();
    let launch = runtime
        .plan_delivery_check(&project_id, None, DeliveryCheckReason::Requested, None)
        .unwrap()
        .expect("no check runs yet");
    assert_eq!(launch.task_ids, ["task-1", "task-2"]);
    // A second request for a covered Task does not start another check.
    assert!(
        runtime
            .plan_delivery_check(
                &project_id,
                Some(vec!["task-2".into()]),
                DeliveryCheckReason::Requested,
                None,
            )
            .unwrap()
            .is_none()
    );
    let token = start_check_session(&mut runtime, &launch);
    let session_id = launch.plan.session_id().to_owned();
    let board = runtime.project_manager_board(&project_id);
    assert_eq!(board["checks"][0]["sessionId"], session_id.as_str());

    // The report is accepted only after the assignment was read.
    assert!(matches!(
        runtime.record_delivery_check(&token, report(&launch.check_id, "task-1"), 5),
        Err(CoreError::CapabilityDenied)
    ));
    let read = runtime.read_delivery_check(&token).unwrap();
    assert_eq!(read["checkId"], launch.check_id.as_str());
    assert_eq!(read["reason"], "requested");
    assert_eq!(read["tasks"].as_array().unwrap().len(), 2);
    assert!(
        read["tasks"][0]["facts"]["environments"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(matches!(
        runtime.record_delivery_check(&token, report("another-check", "task-1"), 5),
        Err(CoreError::CapabilityDenied)
    ));
    let mut outside = report(&launch.check_id, "task-1");
    outside.tasks[0].task_id = "task-3".into();
    assert!(matches!(
        runtime.record_delivery_check(&token, outside, 5),
        Err(CoreError::InvalidParams(field)) if field == "taskId"
    ));
    let mut unknown_state = report(&launch.check_id, "task-1");
    unknown_state.tasks[0].environments[0].state = "live".into();
    assert!(matches!(
        runtime.record_delivery_check(&token, unknown_state, 5),
        Err(CoreError::InvalidParams(field)) if field == "environments"
    ));

    let recorded = runtime
        .record_delivery_check(&token, report(&launch.check_id, "task-1"), 5)
        .unwrap();
    assert_eq!(recorded["sessionId"], session_id.as_str());
    let facts = runtime.store.task_delivery_facts_for("task-1").unwrap();
    let staging = facts.environment("staging").unwrap();
    assert_eq!(staging.state, EnvironmentDeployState::Deployed);
    assert_eq!(staging.source, FactSource::Check);
    assert_eq!(staging.detail.as_deref(), Some("v1.4.2"));
    let notes = facts.check_notes.as_ref().unwrap();
    assert_eq!(notes.blockers.as_deref(), Some("Waiting for QA sign-off"));
    // The probe it found waits for the Project Manager's approval.
    let probe = &runtime.store.delivery_probes()[0];
    assert_eq!(probe.status, termloop_domain::ProbeStatus::Proposed);
    assert_eq!(probe.author, termloop_domain::ProbeAuthor::Agent);
    let proposal = runtime.store.task_ticket_proposal("task-1").unwrap();
    assert_eq!(proposal.summary, "Staging runs v1.4.2");
    assert_eq!(proposal.brief.as_deref(), Some("## Status\n- On staging"));
    // The check is finished: its credential is gone and its Session retires.
    assert!(runtime.running_delivery_checks(&project_id).is_empty());
    assert!(runtime.read_delivery_check(&token).is_err());
    assert_eq!(
        runtime.obsolete_delivery_check_sessions(6),
        std::slice::from_ref(&session_id)
    );
    runtime
        .retire_delivery_check_descriptor(&session_id)
        .unwrap();
    assert!(
        !runtime
            .store
            .sessions()
            .iter()
            .any(|session| session.id == session_id)
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_unreported_check_is_forgotten_after_its_deadline_or_when_the_mode_is_switched_off() {
    let (mut runtime, root, project_id) = project_manager_runtime();
    let launch = runtime
        .plan_delivery_check(
            &project_id,
            Some(vec!["task-1".into()]),
            DeliveryCheckReason::Requested,
            None,
        )
        .unwrap()
        .unwrap();
    let token = start_check_session(&mut runtime, &launch);
    let started = runtime.delivery_checks.checks[&launch.check_id].started_at_epoch_ms;
    assert!(
        runtime
            .obsolete_delivery_check_sessions(started + 1)
            .is_empty()
    );
    assert_eq!(
        runtime.obsolete_delivery_check_sessions(started + CHECK_DEADLINE_MS + 1),
        [launch.plan.session_id().to_owned()]
    );
    assert!(runtime.read_delivery_check(&token).is_err());

    let launch = runtime
        .plan_delivery_check(
            &project_id,
            None,
            DeliveryCheckReason::ProbeChanged,
            Some("staging changed".into()),
        )
        .unwrap()
        .unwrap();
    let token = start_check_session(&mut runtime, &launch);
    assert_eq!(
        runtime.read_delivery_check(&token).unwrap()["context"],
        "staging changed"
    );
    runtime
        .handle("projectManager.modeSet", json!({"enabled": false}))
        .unwrap();
    assert!(matches!(
        runtime.read_delivery_check(&token),
        Err(CoreError::TrackerReportStale)
    ));
    assert!(
        runtime
            .obsolete_delivery_check_sessions(termloop_platform::current_epoch_ms())
            .contains(&launch.plan.session_id().to_owned())
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn only_a_project_manager_project_with_tracked_tasks_can_be_checked() {
    let (mut runtime, root, project_id) = pipeline_runtime();
    runtime.configure_agent_observations(crate::test_agent_observation_transport(root.clone()));
    remember_last_launch(&mut runtime);
    assert!(matches!(
        runtime.plan_delivery_check(&project_id, None, DeliveryCheckReason::Requested, None),
        Err(CoreError::CapabilityDenied)
    ));
    runtime
        .handle("projectManager.modeSet", json!({"enabled": true}))
        .unwrap();
    let revision = runtime.state_revision();
    runtime
        .handle(
            "project.modeSet",
            json!({"projectId": project_id, "mode": "projectManager", "expectedRevision": revision}),
        )
        .unwrap();
    // No active sprint yet, so nothing is tracked.
    assert!(matches!(
        runtime.plan_delivery_check(&project_id, None, DeliveryCheckReason::Requested, None),
        Err(CoreError::InvalidParams(field)) if field == "taskIds"
    ));
    // A named open Task can be checked on its own.
    assert!(
        runtime
            .plan_delivery_check(
                &project_id,
                Some(vec!["task-1".into()]),
                DeliveryCheckReason::Requested,
                None,
            )
            .unwrap()
            .is_some()
    );
    std::fs::remove_dir_all(root).unwrap();
}
