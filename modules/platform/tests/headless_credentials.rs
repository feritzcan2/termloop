#![cfg(target_os = "linux")]

use std::process::Command;

use termloop_platform::{
    PersistentSecureCredentialStore, SecureCredentialError, SecureCredentialKey,
    SecureCredentialStore, SecureSecret,
};

#[test]
fn headless_credentials_survive_separate_daemon_processes() {
    let directory = std::env::temp_dir().join(format!(
        "termloop-headless-credentials-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&directory).unwrap();
    for action in ["set", "get", "delete", "missing"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "headless_credential_worker",
                "--ignored",
                "--nocapture",
            ])
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}/no-session-bus", directory.display()),
            )
            .env("TERMLOOP_TEST_CREDENTIAL_DIRECTORY", &directory)
            .env("TERMLOOP_TEST_CREDENTIAL_ACTION", action)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "credential worker {action} failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
#[ignore = "invoked in an isolated process by headless_credentials_survive_separate_daemon_processes"]
fn headless_credential_worker() {
    let directory =
        std::path::PathBuf::from(std::env::var_os("TERMLOOP_TEST_CREDENTIAL_DIRECTORY").unwrap());
    let store = PersistentSecureCredentialStore::new(&directory);
    let key = SecureCredentialKey::new("dev.termloop.task-source.jira", "headless-source").unwrap();
    let secret = SecureSecret::new(b"test@example.invalid\0fixture-api-token".to_vec()).unwrap();
    match std::env::var("TERMLOOP_TEST_CREDENTIAL_ACTION")
        .unwrap()
        .as_str()
    {
        "set" => store.set(&key, &secret).unwrap(),
        "get" => assert_eq!(store.get(&key).unwrap().expose(), secret.expose()),
        "delete" => store.delete(&key).unwrap(),
        "missing" => assert!(matches!(
            store.get(&key),
            Err(SecureCredentialError::NotFound)
        )),
        _ => panic!("unknown credential fixture action"),
    }
}
