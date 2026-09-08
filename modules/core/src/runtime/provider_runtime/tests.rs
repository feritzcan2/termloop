use super::*;

fn staged(authorizer: &McpAuthorizer, epoch: u64, token: &str) -> PreparedProviderRuntime {
    let mut runtime = PreparedProviderRuntime::default();
    runtime.stage_mcp(
        authorizer,
        "session",
        epoch,
        token,
        &AgentMcpRole::Interactive,
    );
    runtime
}

#[test]
fn abandoning_preparation_revokes_transport_without_granting_commands() {
    let authorizer = McpAuthorizer::default();
    let prepared = staged(&authorizer, 7, "old-token");
    assert!(authorizer.authenticate_transport("old-token").is_ok());
    assert!(authorizer.authenticate("old-token").is_err());
    drop(prepared);
    assert!(authorizer.authenticate_transport("old-token").is_err());
}

#[test]
fn an_old_guard_cannot_revoke_a_replacement_even_with_the_same_epoch() {
    for epoch in [7, 8] {
        let authorizer = McpAuthorizer::default();
        let old = staged(&authorizer, 7, "old-token");
        let replacement = staged(&authorizer, epoch, "new-token");
        drop(old);
        assert_eq!(
            authorizer
                .authenticate_transport("new-token")
                .unwrap()
                .runtime_epoch(),
            epoch
        );
        assert!(authorizer.authenticate("new-token").is_err());
        drop(replacement);
        assert!(authorizer.authenticate_transport("new-token").is_err());
    }
}

#[test]
fn committed_authority_survives_transfer_and_plan_disposal() {
    let authorizer = McpAuthorizer::default();
    let mut prepared = staged(&authorizer, 7, "token");
    authorizer.register(
        "session".into(),
        7,
        AgentMcpRole::Interactive,
        "token".into(),
    );
    prepared.take_committed();
    drop(prepared);
    assert!(authorizer.authenticate("token").is_ok());
}

#[test]
fn failed_required_bridge_preparation_never_leaves_a_credential_after_disposal() {
    let authorizer = McpAuthorizer::default();
    let mut prepared = PreparedProviderRuntime::default();
    let mut signals = None;
    let result = prepared.prepare(ProviderRuntimePreparation {
        agent_id: "codex",
        session_id: "session",
        runtime_epoch: 7,
        cwd: "unused",
        managed_worktree: false,
        account: None,
        transport: None,
        mode: ProviderRuntimeMode::Resume,
        authorizer: &authorizer,
        mcp: Some(("token", &AgentMcpRole::Interactive)),
        signals: &mut signals,
        launch: None,
        history: None,
    });
    assert!(matches!(
        result,
        Err(ProviderRuntimePreparationError::Runtime(
            AgentResumePreparationError::ProviderRejected
        ))
    ));
    assert!(authorizer.authenticate_transport("token").is_err());
    drop(prepared);
    assert!(authorizer.authenticate_transport("token").is_err());
}

#[test]
fn direct_tui_preparation_allows_transport_but_never_commands_before_commit() {
    for agent_id in ["claude", "codex"] {
        let authorizer = McpAuthorizer::default();
        let mut prepared = PreparedProviderRuntime::default();
        let mut signals = None;
        prepared
            .prepare(ProviderRuntimePreparation {
                agent_id,
                session_id: "session",
                runtime_epoch: 7,
                cwd: "unused",
                managed_worktree: false,
                account: None,
                transport: None,
                mode: ProviderRuntimeMode::OptionalObservation,
                authorizer: &authorizer,
                mcp: Some(("token", &AgentMcpRole::Interactive)),
                signals: &mut signals,
                launch: None,
                history: None,
            })
            .unwrap();
        assert!(authorizer.authenticate_transport("token").is_ok());
        assert!(authorizer.authenticate("token").is_err());
        drop(prepared);
        assert!(authorizer.authenticate_transport("token").is_err());
    }
}
