use termloop_agents::AgentAccountContext;
use termloop_domain::{ResumeProvider, ResumeRef};
use termloop_invocation::{
    AgentConversationLaunch, AgentObservationLaunch, AgentObservationLaunchTransport,
    InvocationError, LaunchPayload, configured_interactive_agent_for_conversation,
};

const THREAD_ID: &str = "019f1dae-3bf3-73d1-b3c7-08ddbbd1f036";
const ENDPOINT: &str = "ws://127.0.0.1:4567";
const PERMISSION_ARGUMENTS: &[(&str, &[&str])] = &[
    ("default", &[]),
    ("acceptEdits", &["--approve-for-me"]),
    (
        "plan",
        &["--sandbox", "read-only", "--ask-for-approval", "on-request"],
    ),
    (
        "bypassPermissions",
        &["--dangerously-bypass-approvals-and-sandbox"],
    ),
];

fn observation() -> AgentObservationLaunch<'static> {
    AgentObservationLaunch {
        session_id: "session",
        endpoint: "http://127.0.0.1:123/agent-observation",
        token: "",
        transport: AgentObservationLaunchTransport::DaemonOwnedBridge { endpoint: ENDPOINT },
    }
}

fn provider_args(launch: &LaunchPayload) -> &[String] {
    let executable = &launch.inspectable_manifest().target.executable;
    launch
        .args()
        .iter()
        .position(|argument| argument == executable)
        .map_or_else(|| launch.args(), |index| &launch.args()[index + 1..])
}

#[test]
fn remote_resume_inherits_permissions_and_keeps_preview_and_payload_in_sync() {
    let resume_ref = ResumeRef::for_provider(ResumeProvider::Codex, THREAD_ID.into()).unwrap();
    let account = AgentAccountContext {
        agent_id: "codex".into(),
        account_id: "c3dcf1a0-2548-420c-b662-2a2143a567da".into(),
        name: "Work".into(),
        config_directory: Some(std::env::temp_dir().join("codex-resume-private-account")),
    };
    for account in [None, Some(&account)] {
        for (permission, _) in PERMISSION_ARGUMENTS.iter().rev() {
            let launch = configured_interactive_agent_for_conversation(
                "codex",
                "/tmp/project",
                "gpt-6-astra",
                permission,
                "xhigh",
                AgentConversationLaunch::Resume {
                    resume_ref: &resume_ref,
                }
                .in_account(account),
                Some(observation()),
                None,
            )
            .unwrap();
            let args = provider_args(&launch);
            assert_eq!(&args[..2], ["resume", THREAD_ID]);
            assert!(args.windows(2).any(|pair| pair == ["--remote", ENDPOINT]));
            assert!(args.windows(2).any(|pair| pair == ["-C", "/tmp/project"]));
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["--model", "gpt-6-astra"])
            );
            assert!(
                args.windows(2)
                    .any(|pair| pair == ["-c", "model_reasoning_effort=\"xhigh\""])
            );
            for (_, rejected) in PERMISSION_ARGUMENTS {
                for argument in *rejected {
                    assert!(
                        !args.iter().any(|arg| arg == argument),
                        "{permission}: {argument}"
                    );
                }
            }

            let manifest = launch.inspectable_manifest();
            let actual = manifest
                .arguments
                .iter()
                .filter(|argument| argument.purpose == "permission selection")
                .map(|argument| argument.display.as_str())
                .collect::<Vec<_>>();
            assert!(actual.is_empty());
            assert_eq!(manifest.target.permission, *permission);
            assert_eq!(manifest.target.model, "gpt-6-astra");
            assert_eq!(manifest.target.reasoning, "xhigh");
            assert_eq!(manifest.arguments.len(), args.len());
            for argument in &manifest.arguments {
                if argument.visibility == "exact" {
                    assert_eq!(argument.display, args[argument.position]);
                }
            }
            assert!(manifest.limitations.iter().any(|limitation| {
                limitation.kind == "providerManaged"
                    && limitation
                        .description
                        .contains("conversation's saved permissions")
                    && limitation.description.contains("last saved selection")
            }));
            assert_eq!(launch.initial_input(), None);
            let preview = serde_json::to_string(manifest).unwrap();
            assert!(!preview.contains(THREAD_ID));
            assert!(!preview.contains(ENDPOINT));
            assert!(!preview.contains("codex-resume-private-account"));
        }
    }
}

#[test]
fn fresh_and_forked_remote_sessions_and_local_resumes_keep_permission_arguments() {
    let resume_ref = ResumeRef::for_provider(ResumeProvider::Codex, THREAD_ID.into()).unwrap();
    for (conversation, observation) in [
        (
            AgentConversationLaunch::Fresh { resume_ref: None },
            Some(observation()),
        ),
        (
            AgentConversationLaunch::Fork {
                source_ref: &resume_ref,
            },
            Some(observation()),
        ),
        (
            AgentConversationLaunch::Resume {
                resume_ref: &resume_ref,
            },
            None,
        ),
    ] {
        for (permission, expected) in PERMISSION_ARGUMENTS {
            let launch = configured_interactive_agent_for_conversation(
                "codex",
                "/tmp/project",
                "default",
                permission,
                "default",
                conversation,
                observation,
                None,
            )
            .unwrap();
            let manifest = launch.inspectable_manifest();
            let actual = manifest
                .arguments
                .iter()
                .filter(|argument| argument.purpose == "permission selection")
                .map(|argument| argument.display.as_str())
                .collect::<Vec<_>>();
            assert_eq!(actual, *expected);
            for argument in *expected {
                assert!(provider_args(&launch).iter().any(|arg| arg == argument));
            }
            assert!(!manifest.limitations.iter().any(|limitation| {
                limitation
                    .description
                    .contains("conversation's saved permissions")
            }));
        }
    }
}

#[test]
fn remote_resume_still_rejects_invalid_permission_selections() {
    let resume_ref = ResumeRef::for_provider(ResumeProvider::Codex, THREAD_ID.into()).unwrap();
    let result = configured_interactive_agent_for_conversation(
        "codex",
        "/tmp/project",
        "default",
        "unsupported",
        "default",
        AgentConversationLaunch::Resume {
            resume_ref: &resume_ref,
        },
        Some(observation()),
        None,
    );
    assert!(matches!(
        result,
        Err(InvocationError::UnsupportedPermission { .. })
    ));
}
