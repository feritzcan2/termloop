use std::fs as std_fs;
use std::io;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(unix)]
use crate::managed_process::process_tree_is_running;
use crate::managed_process::{
    create_tracked_process_record_with, process_identity, spawn_managed_process_inner,
};
use crate::*;

mod keep_awake;
mod managed_process;
mod process;
mod process_tree;

#[test]
fn bounded_private_log_rotates_and_rejects_multiline_content() {
    let root = std::env::temp_dir().join(format!(
        "termloop-diagnostic-log-{}-{}",
        std::process::id(),
        current_epoch_ms()
    ));
    let path = root.join("resume.jsonl");
    let log = BoundedPrivateLog::open(&path, 20).unwrap();
    log.append_line("first").unwrap();
    log.append_line("second").unwrap();
    log.append_line("third-long").unwrap();
    assert_eq!(std_fs::read_to_string(&path).unwrap(), "third-long\n");
    assert!(log.append_line("unsafe\nline").is_err());
    let _ = std_fs::remove_dir_all(root);
}

#[test]
fn bounded_ephemeral_file_is_consumed_once() {
    let root = std::env::temp_dir().join(format!(
        "termloop-bounded-take-{}-{}",
        std::process::id(),
        current_epoch_ms()
    ));
    let path = root.join("handoff.json");
    atomic_replace_private_file(&path, br#"{"version":1}"#).unwrap();
    assert_eq!(
        take_bounded_file(&path, 64).unwrap(),
        Some(br#"{"version":1}"#.to_vec())
    );
    assert_eq!(take_bounded_file(&path, 64).unwrap(), None);

    atomic_replace_private_file(&path, b"too-large").unwrap();
    assert!(take_bounded_file(&path, 3).is_err());
    assert!(!path.exists());
    let _ = std_fs::remove_dir_all(root);
}

const COMMAND_FIXTURE_MODE: &str = "TERMLOOP_PLATFORM_COMMAND_FIXTURE_MODE";

fn fixture_request(mode: &str) -> CommandRequest {
    CommandRequest::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "tests::process::command_fixture_entrypoint",
            "--nocapture",
        ])
        .environment(COMMAND_FIXTURE_MODE, mode)
        .timeout(Duration::from_secs(5))
}
