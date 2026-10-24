use serde_json::json;
use termloop_domain::{
    EnvironmentDeployState, FactSource, PullRequestFact, PullRequestFactChecks,
    PullRequestFactState, PullRequestsFact, TaskDeliveryFacts,
};

use super::*;
use crate::project::DeliveryCheckProbeProposal;

fn merged_task(runtime: &mut CoreRuntime, task_id: &str, commit: &str) {
    runtime
        .store
        .set_task_delivery_facts(
            &runtime.write_authority,
            vec![TaskDeliveryFacts {
                task_id: task_id.into(),
                pull_requests: Some(PullRequestsFact {
                    repository: "github.com/acme/pay".into(),
                    items: vec![PullRequestFact {
                        number: 7,
                        title: "PAY-42 restrict origins".into(),
                        url: "https://github.com/acme/pay/pull/7".into(),
                        state: PullRequestFactState::Merged,
                        checks: PullRequestFactChecks::Passing,
                        base_branch: "main".into(),
                        head_branch: "feature/PAY-42".into(),
                        merge_commit: Some(commit.into()),
                        updated_at_epoch_ms: 1,
                    }],
                    truncated: false,
                    observed_at_epoch_ms: 1,
                    changed_at_epoch_ms: 1,
                }),
                ..TaskDeliveryFacts::default()
            }],
        )
        .unwrap();
}

fn output(
    hash: char,
    commit: Option<&str>,
    contains: Vec<(&str, Option<bool>)>,
) -> Result<ProbeOutput, &'static str> {
    Ok(ProbeOutput {
        hash: hash.to_string().repeat(64),
        excerpt: format!("version {hash}"),
        deployed_commit: commit.map(str::to_owned),
        contains: contains
            .into_iter()
            .map(|(task_id, contains)| (task_id.to_owned(), contains))
            .collect(),
    })
}

#[test]
fn a_commit_ancestry_probe_places_merged_tasks_on_its_environment() {
    let (mut runtime, root, project_id) =
        crate::runtime::delivery_check::tests::project_manager_runtime();
    assert!(runtime.plan_probe_runs(&project_id).is_none());
    let board = runtime
        .handle(
            "projectManager.probeCreate",
            json!({
                "projectId": project_id,
                "environment": "Staging",
                "argv": ["curl", "-s", "https://staging.example.com/version"],
                "matcher": "commitAncestry",
            }),
        )
        .unwrap();
    assert_eq!(
        board["probes"][0]["status"], "approved",
        "the Project Manager's own probe runs as written"
    );
    assert!(matches!(
        runtime.handle(
            "projectManager.probeCreate",
            json!({"projectId": project_id, "environment": "Staging", "argv": ["curl", "-s", "https://staging.example.com/version"], "matcher": "commitAncestry"}),
        ),
        Err(CoreError::InvalidParams(field)) if field == "argv"
    ));
    merged_task(&mut runtime, "task-1", "abc1234def");
    merged_task(&mut runtime, "task-2", "bbb2222def");
    let plan = runtime.plan_probe_runs(&project_id).unwrap();
    assert_eq!(plan.merged.len(), 2);
    let outcome = runtime
        .apply_probe_runs(
            plan,
            ProbeRunObservation {
                results: vec![output(
                    'a',
                    Some("fff0000aaa"),
                    vec![("task-1", Some(true)), ("task-2", Some(false))],
                )],
            },
            50,
        )
        .unwrap();
    assert!(outcome.changed);
    assert!(outcome.check_contexts.is_empty());
    let staging = |runtime: &CoreRuntime, task_id: &str| {
        runtime
            .store
            .task_delivery_facts_for(task_id)
            .unwrap()
            .environment("staging")
            .cloned()
            .unwrap()
    };
    assert_eq!(
        staging(&runtime, "task-1").state,
        EnvironmentDeployState::Deployed
    );
    assert_eq!(staging(&runtime, "task-1").source, FactSource::Probe);
    assert_eq!(
        staging(&runtime, "task-1").detail.as_deref(),
        Some("Runs fff0000aaa")
    );
    assert_eq!(
        staging(&runtime, "task-2").state,
        EnvironmentDeployState::NotDeployed
    );
    let run = runtime.store.delivery_probes()[0].last_run.clone().unwrap();
    assert_eq!(run.deployed_commit.as_deref(), Some("fff0000aaa"));
    assert_eq!(run.changed_at_epoch_ms, Some(50));

    // A failed run keeps what the last good one saw.
    let plan = runtime.plan_probe_runs(&project_id).unwrap();
    runtime
        .apply_probe_runs(
            plan,
            ProbeRunObservation {
                results: vec![Err("timedOut")],
            },
            60,
        )
        .unwrap();
    let run = runtime.store.delivery_probes()[0].last_run.clone().unwrap();
    assert_eq!(run.failure.as_deref(), Some("timedOut"));
    assert_eq!(run.deployed_commit.as_deref(), Some("fff0000aaa"));
    assert_eq!(run.at_epoch_ms, 60);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_proposed_probe_waits_for_approval_and_an_agent_probe_asks_for_a_check_on_change() {
    let (mut runtime, root, project_id) =
        crate::runtime::delivery_check::tests::project_manager_runtime();
    let proposals = runtime
        .proposed_probes(
            &project_id,
            &[
                DeliveryCheckProbeProposal {
                    environment: "Production".into(),
                    argv: vec!["gh".into(), "run".into(), "list".into()],
                    matcher: "agent".into(),
                    reason: "Deploy runs show what production runs".into(),
                },
                DeliveryCheckProbeProposal {
                    environment: "production".into(),
                    argv: vec!["gh".into(), "run".into(), "list".into()],
                    matcher: "agent".into(),
                    reason: "The same probe again".into(),
                },
            ],
        )
        .unwrap();
    assert_eq!(proposals.len(), 1, "a repeated proposal is left out");
    assert!(matches!(
        runtime.proposed_probes(
            &project_id,
            &[DeliveryCheckProbeProposal {
                environment: "Production".into(),
                argv: vec!["-c".into()],
                matcher: "agent".into(),
                reason: "x".into(),
            }],
        ),
        Err(CoreError::InvalidParams(field)) if field == "probeProposals"
    ));
    let probe_id = proposals[0].id.clone();
    runtime
        .store
        .create_delivery_probe(&runtime.write_authority, proposals[0].clone())
        .unwrap();
    assert!(
        runtime.plan_probe_runs(&project_id).is_none(),
        "a proposal never runs"
    );
    runtime
        .handle("projectManager.probeApprove", json!({"probeId": probe_id}))
        .unwrap();
    let run = |runtime: &mut CoreRuntime, hash: char, now: u64| {
        let plan = runtime.plan_probe_runs(&project_id).unwrap();
        runtime
            .apply_probe_runs(
                plan,
                ProbeRunObservation {
                    results: vec![output(hash, None, vec![])],
                },
                now,
            )
            .unwrap()
    };
    assert!(
        run(&mut runtime, 'a', 10).check_contexts.is_empty(),
        "the first run sets the baseline"
    );
    assert!(run(&mut runtime, 'a', 20).check_contexts.is_empty());
    let changed = run(&mut runtime, 'b', 30);
    assert_eq!(changed.check_contexts.len(), 1);
    assert!(changed.check_contexts[0].contains("version b"));
    assert!(changed.check_contexts[0].contains("`gh run list`"));
    runtime
        .handle("projectManager.probeDelete", json!({"probeId": probe_id}))
        .unwrap();
    assert!(runtime.plan_probe_runs(&project_id).is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_output_names_its_commit_and_a_missing_program_fails_typed() {
    assert_eq!(
        named_commit(
            "deployed: v1.4.2 (abc1234) built from 0123456789abcdef0123456789abcdef01234567"
        ),
        Some("0123456789abcdef0123456789abcdef01234567".into())
    );
    assert_eq!(
        named_commit("{\"sha\":\"ABC1234\"}"),
        Some("abc1234".into())
    );
    assert_eq!(named_commit("deface added"), None);
    let plan = ProbeRunPlan {
        project_id: "project".into(),
        project_folder: std::env::temp_dir(),
        probes: vec![PlannedProbe {
            id: "p".into(),
            argv: vec!["termloop-no-such-program".into()],
            matcher: ProbeMatcher::Agent,
        }],
        merged: Vec::new(),
    };
    assert!(matches!(
        plan.observe().results.as_slice(),
        [Err("notFound")]
    ));
}
