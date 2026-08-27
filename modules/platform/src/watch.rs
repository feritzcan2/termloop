use std::io;
use std::path::{Path, PathBuf};

use crate::PlatformError;

/// Owns one recursive filesystem watcher. Dropping it unregisters the OS
/// handle; callbacks carry no path data across the platform boundary.
pub struct DirectoryWatcher {
    _watcher: notify::RecommendedWatcher,
}

impl std::fmt::Debug for DirectoryWatcher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectoryWatcher")
            .finish_non_exhaustive()
    }
}

pub fn watch_directory(
    path: &Path,
    on_change: impl Fn() + Send + Sync + 'static,
) -> Result<DirectoryWatcher, PlatformError> {
    watch_directories(&[path.to_path_buf()], on_change)
}

pub fn watch_directories(
    paths: &[PathBuf],
    on_change: impl Fn() + Send + Sync + 'static,
) -> Result<DirectoryWatcher, PlatformError> {
    use notify::Watcher;
    let callback = std::sync::Arc::new(on_change);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if event.is_ok() {
            callback();
        }
    })
    .map_err(|error| io::Error::other(error.to_string()))?;
    for path in paths {
        watcher
            .watch(path, notify::RecursiveMode::Recursive)
            .map_err(|error| io::Error::other(error.to_string()))?;
    }
    Ok(DirectoryWatcher { _watcher: watcher })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitRepositoryWatchChange {
    pub git_configuration_or_ref_changed: bool,
    pub branch_ref_or_config_changed: bool,
}

/// Reuses one recursive watcher for worktree health and Git-host projection
/// demand while keeping filesystem event/path interpretation in platform.
pub fn watch_git_repository_directories(
    worktree_root: &Path,
    repository_common_dir: &Path,
    on_change: impl Fn(GitRepositoryWatchChange) + Send + Sync + 'static,
) -> Result<DirectoryWatcher, PlatformError> {
    use notify::Watcher;
    let callback = std::sync::Arc::new(on_change);
    let worktree_git = worktree_root.join(".git");
    let common_dir = repository_common_dir.to_path_buf();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let git_configuration_or_ref_changed = event
            .paths
            .iter()
            .any(|path| git_repository_event_is_relevant(path, &worktree_git, &common_dir));
        let branch_ref_or_config_changed = event
            .paths
            .iter()
            .any(|path| branch_commit_event_is_relevant(path, &common_dir));
        callback(GitRepositoryWatchChange {
            git_configuration_or_ref_changed,
            branch_ref_or_config_changed,
        });
    })
    .map_err(|error| io::Error::other(error.to_string()))?;
    watcher
        .watch(worktree_root, notify::RecursiveMode::Recursive)
        .map_err(|error| io::Error::other(error.to_string()))?;
    watcher
        .watch(repository_common_dir, notify::RecursiveMode::Recursive)
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(DirectoryWatcher { _watcher: watcher })
}

fn branch_commit_event_is_relevant(path: &Path, common_dir: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(common_dir) else {
        return false;
    };
    let mut components = relative.components();
    let Some(first) = components
        .next()
        .and_then(|value| value.as_os_str().to_str())
    else {
        return false;
    };
    if matches!(first, "config" | "config.worktree" | "packed-refs" | "refs") {
        return true;
    }
    first == "worktrees"
        && components.next().is_some()
        && components
            .next()
            .is_some_and(|value| value.as_os_str() == "config.worktree")
        && components.next().is_none()
}

fn git_repository_event_is_relevant(path: &Path, worktree_git: &Path, common_dir: &Path) -> bool {
    if path == worktree_git || path.starts_with(worktree_git) {
        return true;
    }
    let Ok(relative) = path.strip_prefix(common_dir) else {
        return false;
    };
    let Some(first) = relative.components().next() else {
        return false;
    };
    matches!(
        first.as_os_str().to_str(),
        Some("config" | "config.worktree" | "HEAD" | "packed-refs" | "refs" | "worktrees")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    #[test]
    fn directory_watcher_reports_changes_and_drop_unregisters_the_handle() {
        let directory = std::env::temp_dir().join(format!(
            "termloop-watch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let watcher = watch_directory(&directory, move || {
            let _ = sender.send(());
        })
        .unwrap();
        fs::write(directory.join("change"), b"changed").unwrap();
        receiver.recv_timeout(Duration::from_secs(3)).unwrap();
        drop(watcher);
        // Backends may split one write into several asynchronously delivered
        // events, including callbacks already queued while the watcher handle
        // is being unregistered. Drain those pre-drop callbacks only after the
        // handle is gone so they cannot be mistaken for an event produced by
        // the write below.
        while receiver.recv_timeout(Duration::from_millis(300)).is_ok() {}
        fs::write(directory.join("after-drop"), b"changed").unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(300)).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn git_repository_events_distinguish_worktree_content_from_git_metadata() {
        let worktree = PathBuf::from("/tmp/worktree");
        let common = PathBuf::from("/tmp/repository/.git");
        assert!(!git_repository_event_is_relevant(
            &worktree.join("src/main.rs"),
            &worktree.join(".git"),
            &common,
        ));
        assert!(git_repository_event_is_relevant(
            &common.join("config"),
            &worktree.join(".git"),
            &common,
        ));
        assert!(git_repository_event_is_relevant(
            &common.join("refs/heads/main"),
            &worktree.join(".git"),
            &common,
        ));
        let main_git = PathBuf::from("/tmp/repository/.git");
        assert!(!branch_commit_event_is_relevant(
            &main_git.join("index"),
            &main_git,
        ));
        assert!(!branch_commit_event_is_relevant(
            &main_git.join("logs/refs/heads/main"),
            &main_git,
        ));
        for relevant in [
            main_git.join("config"),
            main_git.join("packed-refs"),
            main_git.join("refs/heads/main"),
            main_git.join("refs/remotes/origin/main"),
            main_git.join("worktrees/task/config.worktree"),
        ] {
            assert!(branch_commit_event_is_relevant(&relevant, &main_git));
        }
    }
}
