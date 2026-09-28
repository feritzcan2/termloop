use super::*;
use termloop_domain::{PlaybookEvaluationOutcome as Outcome, PlaybookEvaluationRecord};

pub(super) fn evaluation(id: &str, time: u64) -> PlaybookEvaluationRecord {
    PlaybookEvaluationRecord {
        id: id.into(),
        project_id: "project-a".into(),
        task_id: "task-1".into(),
        task_title: "Original task".into(),
        milestone_id: "pr-approved".into(),
        milestone_title: "PR approved".into(),
        source_session_id: "source".into(),
        source_name: "Implementer".into(),
        session_id: format!("fork-{id}"),
        agent_id: "codex".into(),
        model: "gpt-6-luna".into(),
        permission: "plan".into(),
        started_at_epoch_ms: time,
        finished_at_epoch_ms: None,
        outcome: Outcome::InProgress,
        evidence: String::new(),
    }
}

fn fixture(label: &str) -> (std::path::PathBuf, Store, CoreWriteAuthority) {
    let path = std::env::temp_dir().join(format!(
        "termloop-evaluation-{label}-{}.json",
        termloop_platform::generate_opaque_id()
    ));
    let mut store = Store::open(&path).unwrap();
    let authority = issue_core_write_authority_for_composition();
    store
        .insert_project(
            &authority,
            ProjectRecord {
                id: "project-a".into(),
                name: "Project".into(),
                folder_path: "/tmp/project-a".into(),
            },
        )
        .unwrap();
    (path, store, authority)
}

#[test]
fn evaluation_results_survive_missing_sessions_and_restart_without_rewriting_completed_results() {
    let (path, mut store, authority) = fixture("restart");
    let started = evaluation("one", 1);
    store
        .start_playbook_evaluation(&authority, started.clone())
        .unwrap();
    let revision = store.revision();
    store
        .start_playbook_evaluation(&authority, started.clone())
        .unwrap();
    assert_eq!(store.revision(), revision);
    let mut finished = started.clone();
    finished.outcome = Outcome::Waiting;
    finished.finished_at_epoch_ms = Some(5);
    finished.evidence = "Awaiting reviewer approval.".into();
    let mut changed_snapshot = finished.clone();
    changed_snapshot.source_name = "A different agent".into();
    assert!(matches!(
        store.finish_playbook_evaluation(&authority, changed_snapshot),
        Err(StoreError::ConstraintViolation)
    ));
    assert_eq!(store.playbook_evaluations(), &[started]);
    store
        .finish_playbook_evaluation(&authority, finished.clone())
        .unwrap();
    let revision = store.revision();
    store
        .finish_playbook_evaluation(&authority, finished.clone())
        .unwrap();
    assert_eq!(store.revision(), revision);
    store
        .start_playbook_evaluation(&authority, evaluation("two", 10))
        .unwrap();
    drop(store);
    let mut reopened = Store::open(&path).unwrap();
    reopened
        .interrupt_playbook_evaluations_on_restart(&authority, 11)
        .unwrap();
    assert_eq!(reopened.playbook_evaluations()[0], finished);
    assert_eq!(
        reopened.playbook_evaluations()[1].outcome,
        Outcome::Interrupted
    );
    assert_eq!(
        reopened.playbook_evaluations()[1].finished_at_epoch_ms,
        Some(11)
    );
    assert_eq!(
        Store::open(&path).unwrap().playbook_evaluations(),
        reopened.playbook_evaluations()
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn evaluation_retention_evicts_oldest_finished_receipt_and_preserves_in_progress() {
    let (path, mut store, authority) = fixture("retention");
    store
        .start_playbook_evaluation(&authority, evaluation("running", 0))
        .unwrap();
    for i in 1..=201 {
        let mut record = evaluation(&i.to_string(), i);
        store
            .start_playbook_evaluation(&authority, record.clone())
            .unwrap();
        record.outcome = Outcome::Passed;
        record.finished_at_epoch_ms = Some(i + 1);
        record.evidence = "Verified.".into();
        store
            .finish_playbook_evaluation(&authority, record)
            .unwrap();
    }
    let records = store.playbook_evaluations();
    assert_eq!(records.len(), 200);
    assert!(records.iter().any(|r| r.id == "running"));
    assert!(!records.iter().any(|r| r.id == "1" || r.id == "2"));
    assert!(records.iter().any(|r| r.id == "201"));
    store
        .delete_project_and_related_records(&authority, "project-a")
        .unwrap();
    assert!(
        Store::open(&path)
            .unwrap()
            .playbook_evaluations()
            .is_empty()
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn version_63_migrates_to_empty_evaluation_history() {
    let (path, store, _) = fixture("migration");
    drop(store);
    let mut old: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    old["schema_version"] = json!(63);
    old.as_object_mut().unwrap().remove("playbook_evaluations");
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let reopened = Store::open(&path).unwrap();
    assert!(reopened.playbook_evaluations().is_empty());
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted["schema_version"], CURRENT_SCHEMA_VERSION);
    std::fs::remove_file(path).unwrap();
}
