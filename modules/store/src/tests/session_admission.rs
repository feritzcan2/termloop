use super::workflow::{configuration, coordinator_session, execution, project, task};
use super::*;
use termloop_domain::{AgentLaunchSelection, PersonalAgent, StewardAgentId};

#[derive(Debug, Clone, Copy)]
enum Admission {
    Standalone,
    Remembered,
    Profiled,
    ProfiledRemembered,
    Workflow,
    Steward,
}

const ADMISSIONS: [Admission; 6] = [
    Admission::Standalone,
    Admission::Remembered,
    Admission::Profiled,
    Admission::ProfiledRemembered,
    Admission::Workflow,
    Admission::Steward,
];

impl Admission {
    fn remembers(self) -> bool {
        matches!(
            self,
            Self::Remembered | Self::ProfiledRemembered | Self::Workflow
        )
    }

    fn session(self) -> SessionRecord {
        let mut session = coordinator_session("admitted", "project");
        session.launch_selection = AgentLaunchSelection::new("default", "plan", "high");
        session.process.template_ref = Some(
            match self {
                Self::Profiled | Self::ProfiledRemembered => "builtin.agent.personal",
                Self::Workflow => "builtin.agent.task-workflow",
                Self::Steward => "builtin.steward.executor",
                _ => "builtin.agent.interactive",
            }
            .into(),
        );
        session
    }

    fn apply(self, store: &mut Store, session: SessionRecord) -> Result<(), StoreError> {
        let authority = issue_core_write_authority_for_composition();
        match self {
            Self::Standalone => store.insert_session(&authority, session).map(|_| ()),
            Self::Remembered => store
                .insert_session_and_remember_agent_launch(&authority, session)
                .map(|_| ()),
            Self::Profiled | Self::ProfiledRemembered => {
                let agent = PersonalAgent {
                    id: "builtin.agent-profile.edge-case-hunter".into(),
                    version: 1,
                    name: "Edge Case Hunter".into(),
                    description: "Inspect boundary conditions.".into(),
                    category: "Quality".into(),
                    instructions: "Inspect the change for edge cases.".into(),
                    agent_id: "codex".into(),
                    selection: session.launch_selection.clone(),
                };
                store
                    .insert_personal_agent_session(&authority, session, agent, self.remembers())
                    .map(|_| ())
            }
            Self::Workflow => {
                let mut configuration = configuration("workflow", "project");
                configuration.launch_selection = session.launch_selection.clone();
                let execution = execution("execution", "task", &session.id, configuration);
                store
                    .insert_workflow_coordinator_session(&authority, session, execution)
                    .map(|_| ())
            }
            Self::Steward => store
                .attach_steward_executor_session(&authority, session, "project", 1, 2)
                .map(|_| ()),
        }
    }
}

struct Fixture {
    directory: PathBuf,
    store: Store,
}

impl Fixture {
    fn new(admission: Admission) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "termloop-session-admission-{}",
            uuid::Uuid::new_v4()
        ));
        let mut store = Store::open(directory.join("state.json")).unwrap();
        let authority = issue_core_write_authority_for_composition();
        store
            .insert_project(&authority, project("project"))
            .unwrap();
        store
            .insert_task(&authority, task("task", "project"))
            .unwrap();
        let mut previous = coordinator_session("previous", "project");
        previous.process.template_ref = Some("builtin.agent.interactive".into());
        store
            .insert_session_and_remember_agent_launch(&authority, previous)
            .unwrap();
        if matches!(admission, Admission::Steward) {
            store
                .set_steward_configuration(
                    &authority,
                    StewardConfiguration {
                        project_id: "project".into(),
                        agent_id: StewardAgentId::Codex,
                        model: "default".into(),
                        permission: "plan".into(),
                        reasoning: "high".into(),
                        enabled: true,
                        system_prompt: "Coordinate project work.".into(),
                        executor_session_id: None,
                        generation: 1,
                        updated_at_epoch_ms: 1,
                    },
                    store.revision(),
                )
                .unwrap();
            let mut obsolete = admission.session();
            obsolete.id = "obsolete-steward".into();
            obsolete.lifecycle_state = "exited".into();
            store.insert_session(&authority, obsolete).unwrap();
        }
        Self { directory, store }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn fresh_session_admission_rolls_back_every_sidecar_and_retries_as_one_commit() {
    for admission in ADMISSIONS {
        let mut fixture = Fixture::new(admission);
        let store = &mut fixture.store;
        let before = serde_json::to_value(&store.state).unwrap();
        let revision = store.revision();
        let previous_preference = store.last_agent_launch_selection().cloned();
        let path = store.path.clone();
        let bytes = fs::read(&path).unwrap();
        let persisted_bytes = store.persisted_bytes;
        // Replacing a nonempty directory with the state file must fail on
        // every platform, even when tests run with elevated permissions.
        store.path = fixture.directory.clone();
        assert!(
            matches!(
                admission.apply(store, admission.session()),
                Err(StoreError::Io(_))
            ),
            "{admission:?}"
        );
        assert_eq!(
            serde_json::to_value(&store.state).unwrap(),
            before,
            "{admission:?}"
        );
        assert_eq!(store.persisted_bytes, persisted_bytes);
        assert_eq!(fs::read(&path).unwrap(), bytes);

        store.path = path.clone();
        let session = admission.session();
        admission.apply(store, session.clone()).unwrap();
        assert_eq!(store.revision(), revision + 1, "{admission:?}");
        assert_eq!(
            store.sessions().iter().find(|value| value.id == session.id),
            Some(&session)
        );
        assert_eq!(
            store.agent_conversation_readiness(&session.id),
            Some(AgentConversationReadiness::Unconfirmed)
        );
        assert_eq!(
            store
                .state
                .agent_conversation_readiness
                .iter()
                .filter(|value| value.session_id == session.id)
                .count(),
            1
        );
        let expected_preference = if admission.remembers() {
            Some(SavedAgentLaunchSelection::new(
                "codex",
                session.launch_selection.clone(),
            ))
        } else {
            previous_preference
        };
        assert_eq!(
            store.last_agent_launch_selection(),
            expected_preference.as_ref()
        );
        match admission {
            Admission::Profiled | Admission::ProfiledRemembered => {
                assert_eq!(
                    store.session_agent_profile(&session.id).unwrap().selection,
                    session.launch_selection
                );
            }
            Admission::Workflow => {
                assert_eq!(store.workflow_executions().len(), 1);
                assert_eq!(
                    store.workflow_executions()[0].coordinator_session_id,
                    session.id
                );
            }
            Admission::Steward => {
                assert_eq!(
                    store.steward_configurations()[0]
                        .executor_session_id
                        .as_deref(),
                    Some(session.id.as_str())
                );
                assert!(
                    !store
                        .sessions()
                        .iter()
                        .any(|value| value.id == "obsolete-steward")
                );
                assert!(
                    store
                        .agent_conversation_readiness("obsolete-steward")
                        .is_none()
                );
            }
            _ => {}
        }
        let reopened = Store::open(path).unwrap();
        assert_eq!(
            serde_json::to_value(&reopened.state).unwrap(),
            serde_json::to_value(&store.state).unwrap(),
            "{admission:?}"
        );
    }
}

#[test]
fn duplicate_admission_never_adds_a_second_readiness_or_sidecar() {
    for admission in ADMISSIONS {
        let mut fixture = Fixture::new(admission);
        let store = &mut fixture.store;
        let session = admission.session();
        admission.apply(store, session.clone()).unwrap();
        let before = serde_json::to_value(&store.state).unwrap();
        let bytes = fs::read(&store.path).unwrap();
        let result = admission.apply(store, session);
        match admission {
            Admission::Standalone | Admission::Remembered => {
                assert!(matches!(result, Err(StoreError::AlreadyExists)))
            }
            _ => assert!(matches!(result, Err(StoreError::ConstraintViolation))),
        }
        assert_eq!(
            serde_json::to_value(&store.state).unwrap(),
            before,
            "{admission:?}"
        );
        assert_eq!(fs::read(&store.path).unwrap(), bytes);
    }
}

#[test]
fn stale_steward_generation_leaves_existing_records_untouched() {
    let mut fixture = Fixture::new(Admission::Steward);
    let store = &mut fixture.store;
    let before = serde_json::to_value(&store.state).unwrap();
    let authority = issue_core_write_authority_for_composition();
    assert!(matches!(
        store.attach_steward_executor_session(
            &authority,
            Admission::Steward.session(),
            "project",
            2,
            2
        ),
        Err(StoreError::RevisionConflict)
    ));
    assert_eq!(serde_json::to_value(&store.state).unwrap(), before);
}

#[test]
fn standalone_terminal_admission_does_not_seed_agent_readiness_or_preference() {
    let mut fixture = Fixture::new(Admission::Standalone);
    let store = &mut fixture.store;
    let previous_preference = store.last_agent_launch_selection().cloned();
    let mut session = Admission::Standalone.session();
    session.kind = SessionKind::Terminal;
    session.launch_selection = AgentLaunchSelection::default();
    session.process.agent_id = None;
    session.process.template_ref = None;
    session.process.template_version = None;
    let revision = store.revision();
    Admission::Standalone.apply(store, session).unwrap();
    assert_eq!(store.revision(), revision + 1);
    assert!(store.agent_conversation_readiness("admitted").is_none());
    assert_eq!(
        store.last_agent_launch_selection(),
        previous_preference.as_ref()
    );
    Store::open(&store.path).unwrap();
}
