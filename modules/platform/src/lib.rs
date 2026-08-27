#![deny(unsafe_code)]

mod access_crypto;
mod agent_history_fs;
#[cfg(test)]
mod dev_profile_identity;
mod diagnostic_log;
mod directory_browser;
mod env;
mod fs;
mod keep_awake;
mod launch_target;
mod managed_process;
mod path;
mod process;
mod process_tree;
mod runtime;
mod secure_credentials;
// Catalog orchestration keeps CLI execution and filesystem discovery in
// separate submodules behind this single platform-owned surface.
mod skill_manager;
mod staged_attachment;
mod stale_disposal;
mod terminal_input;
mod watch;

pub use access_crypto::{
    access_public_key_valid, access_server_fingerprint, generate_access_nonce,
    generate_pairing_code, pairing_code_digest, verify_access_signature,
};
pub use agent_history_fs::{
    BoundedHistoryFile, BoundedHistoryFileSlices, discover_bounded_history_files,
    discover_bounded_history_files_cancellable, read_bounded_history_file_slices,
};
pub use diagnostic_log::BoundedPrivateLog;
pub use directory_browser::{
    BrowsedDirectory, BrowsedDirectoryEntry, BrowsedDirectoryKind, browse_directory,
    default_projects_root, user_home_directory,
};
pub use env::{
    LaunchEnvironment, gemini_cli_system_defaults_path, gemini_cli_system_defaults_source_present,
};
pub use fs::{
    SweptDirectory, atomic_replace_private_file, backup_and_atomic_replace_private_file,
    create_private_file, read_bounded_file, read_bounded_file_if_present,
    read_file_tail_if_present, remove_dir_if_empty, remove_file_if_present, runtime_directory,
    state_directory, sweep_directory_files, take_bounded_file, write_private_file,
};
pub use keep_awake::{
    KeepAwakeError, KeepAwakeHold, KeepAwakeOverride, KeepAwakeRequest, keep_awake_overrides,
    keep_awake_supported, release_stale_keep_awake,
};
pub use launch_target::{LaunchTargetKind, ResolvedLaunchTarget, resolve_launch_target};
pub use managed_process::{
    DaemonInstanceLease, ManagedProcess, ManagedProcessRecovery, ProcessTreeSignal,
    TrackedProcessLease, acquire_daemon_instance_lease, reap_tracked_managed_processes,
    recover_tracked_managed_process, register_existing_tracked_process, signal_process_tree,
    spawn_managed_process, spawn_resolved_tracked_managed_process, spawn_tracked_managed_process,
    spawn_tracked_managed_process_with_environment, wait_for_process_tree_exit,
};
pub use path::{
    FutureDirectoryIdentity, PathComparisonInput, PathEntryState, canonical_directories_overlap,
    canonical_directory_if_exists, canonical_existing_directory, canonical_existing_directory_path,
    canonical_existing_file_within, existing_directory_comparison_input, future_directory_identity,
    host_requires_long_path_opt_in, normalized_absolute_paths_overlap, null_device_path,
    path_entry_state, resolve_existing_directory_within, sibling_directory_path,
    subprocess_path_argument,
};
pub use process::{
    CommandOutcome, CommandProbe, CommandRequest, CommandTermination, ResolvedExecutable,
    current_executable, os_string_from_process_bytes, path_from_process_bytes, probe_command,
    process_bytes_from_os_str, resolve_executable, run_command, sibling_executable,
};
pub use process_tree::{ProcessTreeGuard, SignalDelivery, attach_process_tree_guard};
pub use runtime::{
    MonotonicDeadline, current_epoch_ms, default_shell, generate_capability_token,
    generate_opaque_id, generate_opaque_runtime_token, generate_runtime_epoch, generate_uuid_v4,
    powershell_or_posix_hook_command, reserve_loopback_port, shell_command,
    shell_command_with_setup_marker, terminate_for_unrecoverable_runtime_stall,
    wait_for_daemon_shutdown_signal,
};
pub use secure_credentials::{
    NativeSecureCredentialStore, SecureCredentialError, SecureCredentialKey, SecureCredentialStore,
    SecureSecret,
};
pub use skill_manager::{
    SkillAgent, SkillAgentState, SkillAvailability, SkillCatalog, SkillCatalogItem,
    SkillCatalogLocation, SkillCatalogScope, SkillDefinition, SkillManager, SkillManagerError,
    SkillOrigin, SkillScope,
};
pub use staged_attachment::{
    ResolvedStagedImageAttachment, StagedImageAttachment, prune_staged_image_attachments,
    read_staged_image_attachment, write_staged_image_attachment,
};
pub use stale_disposal::{
    StaleDisposalTargetFacts, inspect_stale_disposal_target, remove_stale_disposal_target_exact,
};
pub use terminal_input::{
    GeneratedTerminalInputError, configure_headless_terminal_input_fixture,
    generated_terminal_paste_submission_sequence, host_uses_bracketed_paste_framing,
    terminal_paste_input, terminal_paste_submission, terminal_paste_submission_sequence,
};
pub use watch::{
    DirectoryWatcher, GitRepositoryWatchChange, watch_directories, watch_directory,
    watch_git_repository_directories,
};

use std::io;

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("a user-local runtime directory could not be resolved")]
    RuntimeDirectoryUnavailable,
    #[error("spawned process ownership could not be recovered")]
    ProcessOwnershipUncertain,
    #[error("launch target was not found on the provided environment PATH")]
    LaunchTargetNotFound,
    #[error("launch target was found but cannot be launched on this platform")]
    LaunchTargetUnusable,
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[cfg(feature = "test-support")]
pub mod test_support {
    use std::path::{Path, PathBuf};

    pub use crate::secure_credentials::test_support::MemorySecureCredentialStore;
    use crate::{PlatformError, ResolvedExecutable};

    pub fn resolved_executable(path: &Path) -> Result<ResolvedExecutable, PlatformError> {
        crate::process::resolved_executable_from_path(path)
    }

    pub fn create_directory_symlink(target: &Path, link: &Path) -> Result<(), PlatformError> {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(target, link)?;
        Ok(())
    }

    /// Whether `signal_process_tree` can deliver graceful (hangup/terminate)
    /// signals on this OS. Windows reports `GracefulUnsupported`, so callers'
    /// grace phases are skipped there; tests use this fact to select the
    /// matching termination expectations without owning OS conditionals.
    pub fn graceful_tree_signals_supported() -> bool {
        cfg!(unix)
    }

    /// Selects a Windows-valid path component on Windows and the richer
    /// filesystem fixture elsewhere, keeping OS branching inside platform.
    pub fn host_path_component<'a>(windows: &'a str, other: &'a str) -> &'a str {
        #[cfg(windows)]
        {
            let _ = other;
            windows
        }
        #[cfg(not(windows))]
        {
            let _ = windows;
            other
        }
    }

    /// Writes a launchable test CLI using the host's native script mechanism.
    /// Callers provide both bodies so OS branching remains owned by platform.
    pub fn write_cli_fixture(
        directory: &Path,
        name: &str,
        _unix_body: &str,
        _windows_body: &str,
    ) -> Result<PathBuf, PlatformError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let path = directory.join(name);
            std::fs::write(&path, _unix_body)?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
            Ok(path)
        }
        #[cfg(windows)]
        {
            let path = directory.join(format!("{name}.cmd"));
            std::fs::write(&path, _windows_body)?;
            Ok(path)
        }
    }

    /// Creates an executable-looking but unusable CLI where the host has a
    /// POSIX execute-bit model. Windows has no equivalent fixture here.
    pub fn write_unusable_cli_fixture(directory: &Path, name: &str) -> bool {
        #[cfg(unix)]
        {
            std::fs::write(directory.join(name), "#!/bin/sh\nexit 0\n").is_ok()
        }
        #[cfg(windows)]
        {
            let _ = (directory, name);
            false
        }
    }

    pub fn signal_ignoring_process(ready_file: &Path) -> Option<(String, Vec<String>)> {
        #[cfg(unix)]
        {
            Some((
                "/bin/sh".to_owned(),
                vec![
                    "-c".to_owned(),
                    format!(
                        "trap '' HUP TERM; printf ready > '{}'; while :; do sleep 1; done",
                        ready_file.display()
                    ),
                ],
            ))
        }
        #[cfg(not(unix))]
        {
            let _ = ready_file;
            None
        }
    }

    /// Returns a long-lived command that accepts terminal input for
    /// cross-platform orchestration tests. Provider-specific behavior is not
    /// part of this fixture; tests use it only to prove PTY identity/lifetime.
    pub fn persistent_terminal_process() -> (String, Vec<String>) {
        #[cfg(unix)]
        {
            ("/bin/cat".to_owned(), vec![])
        }
        #[cfg(windows)]
        {
            ("cmd.exe".to_owned(), vec!["/Q".to_owned(), "/K".to_owned()])
        }
    }
}

#[cfg(test)]
mod tests;
