use super::*;

#[test]
fn branch_commit_summary_counts_against_local_remote_default_and_stays_ephemeral() {
    let mut fixture = Fixture::new();
    let repository = fixture.project_directory.join("repo");
    std::fs::create_dir_all(repository.join(".git")).unwrap();
    let fake = FakeGit::compile(
        "branch-commit-summary",
        r#"
use std::io::Write;
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--version"] {
        print!("git version 2.44.0\n");
        return;
    }
    let cwd = std::env::current_dir().unwrap();
    match args.first().map(String::as_str) {
        Some("rev-parse") if args.get(1).map(String::as_str) == Some("--is-bare-repository") => {
            print!("false\n{}/.git\n", cwd.display());
        }
        Some("rev-parse") if args.get(1).map(String::as_str) == Some("--git-common-dir") => {
            print!(".git\n");
        }
        Some("rev-parse") if args.get(1).map(String::as_str) == Some("--show-toplevel") => {
            println!("{}", cwd.display());
        }
        Some("show-ref") => {}
        Some("for-each-ref") => {
            std::io::stdout().write_all(
                b"refs/heads/feature/count\0origin\0refs/remotes/origin/feature/count\0\0\0\n"
            ).unwrap();
        }
        Some("config") => {
            std::io::stdout().write_all(
                b"remote.origin.url\nhttps://redacted.invalid/repository.git\0"
            ).unwrap();
        }
        Some("symbolic-ref") => print!("refs/remotes/origin/main\n"),
        Some("rev-list") => print!("2\n"),
        _ => std::process::exit(2),
    }
}
"#,
    );
    let runner = GitRunner::discover_program(&fake.program).unwrap();

    let task = fixture.create_task("Count commits", Value::Null);
    let no_branch = fixture.create_task("No branch", Value::Null);
    let task_id = task["id"].as_str().unwrap();
    fixture
        .runtime
        .complete_task_branch_binding(ObservedTaskBranchBinding {
            task_id: task_id.to_owned(),
            project_id: fixture.project_id.clone(),
            binding: termloop_domain::TaskBranchBinding {
                repository_root: repository.display().to_string(),
                name: "feature/count".into(),
            },
        })
        .unwrap();
    let revision = fixture.runtime.state_revision();
    let unavailable_plan = fixture
        .runtime
        .plan_task_branch_commit_summary_list(json!({
            "projectId": fixture.project_id,
            "taskIds": [task_id],
        }))
        .unwrap();
    let unavailable = fixture
        .runtime
        .complete_task_branch_commit_summary_list(
            unavailable_plan.observation_unavailable(CoreError::GitObservationTimedOut),
        )
        .unwrap();
    assert_eq!(unavailable[0]["freshness"], "unavailable");
    assert_eq!(unavailable[0]["reason"], "timeout");
    let plan = fixture
        .runtime
        .plan_task_branch_commit_summary_list(json!({
            "projectId": fixture.project_id,
            "taskIds": [task_id, no_branch["id"].as_str().unwrap()],
        }))
        .unwrap();
    assert!(plan.requires_observation());
    let result = fixture
        .runtime
        .complete_task_branch_commit_summary_list(plan.observe_with_runner(&runner))
        .unwrap();
    let rows = result.as_array().unwrap();
    let counted = rows.iter().find(|row| row["task_id"] == task_id).unwrap();
    assert_eq!(counted["count"], 2);
    assert_eq!(counted["freshness"], "fresh");
    assert_eq!(counted["base_ref"], "refs/remotes/origin/main");
    assert_eq!(counted["not_in_base"]["count"], 2);
    assert_eq!(
        counted["not_in_base"]["base_ref"],
        "refs/remotes/origin/main"
    );
    let unavailable = rows
        .iter()
        .find(|row| row["task_id"] == no_branch["id"])
        .unwrap();
    assert_eq!(unavailable["reason"], "noBranch");
    assert_eq!(fixture.runtime.state_revision(), revision);
    assert_eq!(
        fixture
            .runtime
            .task_branch_commit_watch_targets(&[fixture.project_id.clone()])
            .len(),
        1
    );
    let cached_plan = fixture
        .runtime
        .plan_task_branch_commit_summary_list(json!({
            "projectId": fixture.project_id,
            "taskIds": [task_id],
        }))
        .unwrap();
    assert!(!cached_plan.requires_observation());
    let cached = fixture
        .runtime
        .complete_task_branch_commit_summary_list(cached_plan.observe())
        .unwrap();
    assert_eq!(cached[0]["count"], 2);
    let durable = std::fs::read_to_string(&fixture.state_path).unwrap();
    assert!(!durable.contains("branch_commit"));
    assert!(!durable.contains("refs/remotes/origin/main"));
}

#[test]
fn branch_commit_cache_invalidation_advances_only_the_observation_sequence() {
    let mut fixture = Fixture::new();
    let revision = fixture.runtime.state_revision();
    let sequence = fixture.runtime.observation_sequence();

    let invalidation_sequence = fixture
        .runtime
        .invalidate_branch_commit_summaries_for_common_dir(&fixture.project_directory)
        .unwrap();

    assert!(invalidation_sequence > sequence);
    assert_eq!(
        fixture.runtime.observation_sequence(),
        invalidation_sequence
    );
    assert_eq!(fixture.runtime.state_revision(), revision);
}

#[test]
fn managed_created_branch_tracks_its_current_local_base_when_no_remote_exists() {
    let mut fixture = Fixture::new();
    let (task_id, destination, _, _) = provision_cleanup_fixture(&mut fixture);
    let runner = GitRunner::discover().unwrap();
    for index in 1..=2 {
        std::fs::write(
            destination.join("tracked.txt"),
            format!("feature {index}\n"),
        )
        .unwrap();
        termloop_gitio::test_support::commit_all(
            &runner,
            &destination,
            if index == 1 { "first" } else { "second" },
        )
        .unwrap();
    }

    let plan = fixture
        .runtime
        .plan_task_branch_commit_summary_list(json!({
            "projectId": fixture.project_id,
            "taskIds": [task_id],
        }))
        .unwrap();
    let summary = fixture
        .runtime
        .complete_task_branch_commit_summary_list(plan.observe_with_runner(&runner))
        .unwrap();
    assert_eq!(summary[0]["count"], 2);
    assert_eq!(summary[0]["base_ref"], "refs/heads/main");
    assert_eq!(summary[0]["freshness"], "fresh");
    assert_eq!(summary[0]["not_in_base"]["count"], 2);
    assert_eq!(summary[0]["not_in_base"]["base_ref"], "refs/heads/main");

    let mut commits = None;
    for _ in 0..4 {
        let plan = fixture
            .runtime
            .plan_task_branch_commit_list(json!({ "taskId": task_id }))
            .unwrap();
        match fixture
            .runtime
            .complete_task_branch_commit_list(plan.observe())
        {
            Ok(observed) => {
                commits = Some(observed);
                break;
            }
            Err(CoreError::GitObservationTimedOut) => {}
            Err(error) => panic!("branch commit observation failed: {error:?}"),
        }
    }
    let commits = commits.expect("branch commit observation repeatedly timed out");
    assert_eq!(commits["base_ref"], "refs/heads/main");
    assert_eq!(commits["commits"].as_array().unwrap().len(), 2);

    let plan = fixture
        .runtime
        .plan_task_branch_commit_list(json!({ "taskId": task_id }))
        .unwrap();
    let commits = fixture
        .runtime
        .complete_task_branch_commit_list(plan.observe())
        .unwrap();
    assert_eq!(commits["commits"].as_array().unwrap().len(), 2);

    let observation_id = commits["observation_id"].as_str().unwrap();
    let plan = fixture
        .runtime
        .plan_task_branch_commit_change_list(json!({
            "taskId": task_id,
            "observationId": observation_id,
            "commitId": "all",
        }))
        .unwrap();
    let all_changes = fixture
        .runtime
        .complete_task_branch_commit_change_list(plan.observe())
        .unwrap();
    assert_eq!(all_changes["state"], "available");
    assert_eq!(all_changes["entries"].as_array().unwrap().len(), 1);

    let entry_id = all_changes["entries"][0]["entry_id"].as_str().unwrap();
    let plan = fixture
        .runtime
        .plan_task_branch_commit_diff(json!({
            "taskId": task_id,
            "observationId": observation_id,
            "commitId": "all",
            "entryId": entry_id,
        }))
        .unwrap();
    let all_diff = fixture
        .runtime
        .complete_task_branch_commit_diff(plan.observe())
        .unwrap();
    assert_eq!(all_diff["state"], "patch");
    assert!(all_diff["patch"].as_str().unwrap().contains("feature 2"));

    termloop_gitio::test_support::merge_fast_forward(
        &runner,
        &fixture.project_directory,
        "feature/cleanup",
    )
    .unwrap();
    let common_dir = runner
        .inspect_repository(&fixture.project_directory)
        .unwrap()
        .common_dir;
    fixture
        .runtime
        .invalidate_branch_commit_summaries_for_common_dir(&common_dir)
        .unwrap();
    let plan = fixture
        .runtime
        .plan_task_branch_commit_summary_list(json!({
            "projectId": fixture.project_id,
            "taskIds": [task_id],
        }))
        .unwrap();
    let merged_summary = fixture
        .runtime
        .complete_task_branch_commit_summary_list(plan.observe_with_runner(&runner))
        .unwrap();
    assert_eq!(merged_summary[0]["count"], 0);
    assert_eq!(merged_summary[0]["not_in_base"]["count"], 0);

    let plan = fixture
        .runtime
        .plan_task_branch_commit_list(json!({ "taskId": task_id }))
        .unwrap();
    let commits = fixture
        .runtime
        .complete_task_branch_commit_list(plan.observe())
        .unwrap();
    assert!(commits["commits"].as_array().unwrap().is_empty());
    runner
        .remove_worktree_non_force(&fixture.project_directory, &destination)
        .unwrap();
}
