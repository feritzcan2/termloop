use super::*;
use crate::runtime::delivery_check::tests::project_manager_runtime;

/// Stands in for an ordinary running Agent of the Project with its committed
/// interactive MCP credential.
fn start_agent(runtime: &mut CoreRuntime, project_id: &str, session_id: &str) -> String {
    let mut session = runtime
        .store
        .sessions()
        .iter()
        .find(|session| session.id == "steward-session")
        .unwrap()
        .clone();
    session.id = session_id.into();
    session.project_id = project_id.into();
    session.runtime_epoch = 7;
    session.lifecycle_state = "running".into();
    session.process.template_ref = Some("builtin.agent.interactive".into());
    runtime
        .store
        .insert_session(&runtime.write_authority, session)
        .unwrap();
    let token = format!("{session_id}-token");
    runtime.mcp_authorizer.register(
        session_id.into(),
        7,
        AgentMcpRole::Interactive,
        token.clone(),
    );
    token
}

fn write(task_id: &str, description: &str, expected: Option<u64>) -> AgentTicketWrite {
    AgentTicketWrite {
        task_id: task_id.into(),
        title: None,
        description: Some(description.into()),
        change_summary: "Add acceptance criteria".into(),
        expected_ticket_version: expected,
    }
}

#[test]
fn an_agent_lists_reads_and_versions_tickets_of_its_project_manager_project() {
    let (mut runtime, root, project_id) = project_manager_runtime();
    let token = start_agent(&mut runtime, &project_id, "pm-agent");

    let listed = runtime.read_project_manager_ticket(&token, None).unwrap();
    let ids = listed["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["taskId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(ids.contains(&"task-1") && ids.contains(&"task-2"));
    assert_eq!(listed["tasks"][0]["inActiveSprint"], true);

    let read = runtime
        .read_project_manager_ticket(&token, Some("task-1"))
        .unwrap();
    assert_eq!(read["taskId"], "task-1");
    assert_eq!(read["ticketVersion"], Value::Null);

    let written = runtime
        .write_project_manager_ticket(&token, write("task-1", "## Acceptance\n- Works", None))
        .unwrap();
    assert_eq!(written["ticketChanged"], true);
    let version = written["ticketVersion"].as_u64().unwrap();
    let head = runtime.store.task_ticket_head("task-1").unwrap();
    assert_eq!(head.number, version);
    assert_eq!(head.author, TicketAuthor::Agent);
    assert_eq!(head.summary.as_deref(), Some("Add acceptance criteria"));
    assert_eq!(
        runtime.task_record("task-1").unwrap().brief.as_deref(),
        Some("## Acceptance\n- Works")
    );

    // The same content again saves nothing.
    let again = runtime
        .write_project_manager_ticket(
            &token,
            write("task-1", "## Acceptance\n- Works", Some(version)),
        )
        .unwrap();
    assert_eq!(again["ticketChanged"], false);
    assert_eq!(again["ticketVersion"], version);

    // A write against an older version is a conflict, and nothing changes.
    assert!(matches!(
        runtime.write_project_manager_ticket(&token, write("task-1", "Other", Some(version - 1))),
        Err(CoreError::RevisionConflict)
    ));
    assert_eq!(
        runtime.store.task_ticket_head("task-1").unwrap().number,
        version
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn ticket_tools_refuse_other_projects_and_non_project_manager_projects() {
    let (mut runtime, root, project_id) = project_manager_runtime();
    let token = start_agent(&mut runtime, &project_id, "pm-agent");
    assert!(matches!(
        runtime.read_project_manager_ticket(&token, Some("missing-task")),
        Err(CoreError::NotFound)
    ));
    assert!(matches!(
        runtime.write_project_manager_ticket(
            &token,
            AgentTicketWrite {
                description: None,
                ..write("task-1", "", None)
            }
        ),
        Err(CoreError::InvalidParams(_))
    ));
    assert!(
        runtime
            .read_project_manager_ticket("unknown-token", None)
            .is_err()
    );

    // Once the Project is no longer opened as Project Manager, its Agents
    // lose the tools.
    let revision = runtime.state_revision();
    runtime
        .handle(
            "project.modeSet",
            json!({"projectId": project_id, "mode": "developer", "expectedRevision": revision}),
        )
        .unwrap();
    assert!(matches!(
        runtime.read_project_manager_ticket(&token, None),
        Err(CoreError::CapabilityDenied)
    ));
    let _ = std::fs::remove_dir_all(root);
}
