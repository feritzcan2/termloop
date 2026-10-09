//! Explicit Git fixture support for downstream module tests.
//!
//! This surface is feature-gated so Git subprocess ownership remains in gitio
//! without exposing fixture creation in production builds.

use std::ffi::OsString;
use std::path::Path;

use crate::{GitError, GitOperation, GitRunner};

pub fn initialize_repository(runner: &GitRunner, path: &Path) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        path,
        ["init", "--initial-branch=main"],
    )?;
    commit_empty(runner, path, "fixture")?;
    // Provisioning fetches the base branch from its remote before resolving it,
    // so the fixture needs a reachable `origin`. Pointing the remote at the
    // repository itself keeps the fixture hermetic: no network, no second
    // checkout, and `refs/remotes/origin/main` always has a real upstream.
    runner.checked(
        GitOperation::CreateRef,
        path,
        [
            OsString::from("remote"),
            OsString::from("add"),
            OsString::from("origin"),
            termloop_platform::subprocess_path_argument(path).into_os_string(),
        ],
    )?;
    update_ref(runner, path, "refs/remotes/origin/main", "HEAD")?;
    Ok(())
}

/// Repoints an existing remote at another local repository so a test can
/// model an upstream that advanced, lost a branch, or disappeared.
pub fn set_remote_url(
    runner: &GitRunner,
    repository: &Path,
    remote: &str,
    url_path: &Path,
) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [
            OsString::from("remote"),
            OsString::from("set-url"),
            OsString::from(remote),
            termloop_platform::subprocess_path_argument(url_path).into_os_string(),
        ],
    )?;
    Ok(())
}

pub fn update_ref(
    runner: &GitRunner,
    repository: &Path,
    reference: &str,
    target: &str,
) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [
            OsString::from("update-ref"),
            OsString::from(reference),
            OsString::from(target),
        ],
    )?;
    Ok(())
}

pub fn commit_empty(runner: &GitRunner, repository: &Path, message: &str) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [
            OsString::from("-c"),
            OsString::from("user.name=TermLoop Fixture"),
            OsString::from("-c"),
            OsString::from("user.email=fixture@termloop.invalid"),
            OsString::from("commit"),
            OsString::from("--allow-empty"),
            OsString::from("-m"),
            OsString::from(message),
        ],
    )?;
    Ok(())
}

pub fn create_branch(runner: &GitRunner, repository: &Path, name: &str) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [OsString::from("branch"), OsString::from(name)],
    )?;
    Ok(())
}

pub fn checkout_new_branch(
    runner: &GitRunner,
    repository: &Path,
    name: &str,
) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [
            OsString::from("checkout"),
            OsString::from("-b"),
            OsString::from(name),
        ],
    )?;
    Ok(())
}

pub fn detach_head(runner: &GitRunner, repository: &Path) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        ["checkout", "--detach"],
    )?;
    Ok(())
}

pub fn stage_path(
    runner: &GitRunner,
    repository: &Path,
    path: &std::ffi::OsStr,
) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [OsString::from("add"), OsString::from("--"), path.to_owned()],
    )?;
    Ok(())
}

pub fn commit_all(runner: &GitRunner, repository: &Path, message: &str) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [OsString::from("add"), OsString::from("-A")],
    )?;
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [
            OsString::from("-c"),
            OsString::from("user.name=TermLoop Fixture"),
            OsString::from("-c"),
            OsString::from("user.email=fixture@termloop.invalid"),
            OsString::from("commit"),
            OsString::from("-m"),
            OsString::from(message),
        ],
    )?;
    Ok(())
}

pub fn merge_fast_forward(
    runner: &GitRunner,
    repository: &Path,
    branch: &str,
) -> Result<(), GitError> {
    runner.checked(
        GitOperation::CreateRef,
        repository,
        [
            OsString::from("merge"),
            OsString::from("--ff-only"),
            OsString::from(branch),
        ],
    )?;
    Ok(())
}

pub fn reset_hard(runner: &GitRunner, repository: &Path) -> Result<(), GitError> {
    runner.checked(GitOperation::CreateRef, repository, ["reset", "--hard"])?;
    Ok(())
}

pub fn clean_untracked(runner: &GitRunner, repository: &Path) -> Result<(), GitError> {
    runner.checked(GitOperation::CreateRef, repository, ["clean", "-fd"])?;
    Ok(())
}
