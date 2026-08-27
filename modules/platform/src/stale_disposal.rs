use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::PlatformError;
use crate::path::canonical_existing_directory_path;

const STALE_DISPOSAL_ENTRY_LIMIT: usize = 100_000;

/// Bounded backoff between removal attempts when the OS reports a transient
/// conflict with a concurrent writer. Three delays mean at most four attempts
/// and a total sleep well under 500ms on every OS.
const STALE_DISPOSAL_TRANSIENT_RETRY_DELAYS_MS: [u64; 3] = [50, 100, 200];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleDisposalTargetFacts {
    pub canonical_target: PathBuf,
    pub canonical_parent: PathBuf,
    pub leaf_identity: Vec<u8>,
    pub has_git_metadata: bool,
    pub target_is_mount: bool,
    pub parent_is_filesystem_root: bool,
    pub protected_path_conflict: bool,
}

/// Returns primitive filesystem facts for the exact stale-disposal leaf.
///
/// `protected_descendants` are paths the target may neither equal nor contain
/// (daemon state, Project folders, and known repository roots).
/// `protected_overlaps` are paths that may neither contain nor be contained by
/// the target (other Task worktrees). Product policy remains in core.
pub fn inspect_stale_disposal_target(
    target: &Path,
    protected_descendants: &[PathBuf],
    protected_overlaps: &[PathBuf],
) -> Result<StaleDisposalTargetFacts, PlatformError> {
    let canonical_target = canonical_existing_directory_path(target)?;
    if canonical_target != target {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale disposal target is not its canonical leaf",
        )
        .into());
    }
    let parent = target.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale disposal target has no parent",
        )
    })?;
    let canonical_parent = canonical_existing_directory_path(parent)?;
    let metadata = fs::symlink_metadata(target)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale disposal target is not a plain directory leaf",
        )
        .into());
    }
    let parent_metadata = fs::metadata(&canonical_parent);
    let target_is_mount = directory_is_mount_point(&canonical_target, &metadata, &parent_metadata);
    let parent_is_filesystem_root = canonical_parent.parent().is_none()
        || canonical_parent.parent().is_some_and(|grandparent| {
            parent_metadata
                .as_ref()
                .map(|metadata| {
                    directory_is_mount_point(
                        &canonical_parent,
                        metadata,
                        &fs::metadata(grandparent),
                    )
                })
                .unwrap_or(true)
        });
    let has_git_metadata = target.join(".git").symlink_metadata().is_ok();
    let leaf_identity = stale_disposal_leaf_identity(&canonical_target, &metadata)?;
    let home_conflict = user_home_directory()
        .and_then(|home| canonical_existing_directory_path(&home).ok())
        .is_some_and(|home| home == canonical_target);
    let os_root_conflict = os_protected_roots()
        .into_iter()
        .filter_map(|path| canonical_existing_directory_path(&path).ok())
        .any(|path| path == canonical_target);
    let descendant_conflict = protected_descendants.iter().try_fold(
        false,
        |conflict, protected| -> Result<bool, PlatformError> {
            let protected = canonical_or_absolute_path(protected)?;
            Ok(conflict
                || canonical_target == protected
                || protected.starts_with(&canonical_target))
        },
    )?;
    let overlap_conflict = protected_overlaps.iter().try_fold(
        false,
        |conflict, protected| -> Result<bool, PlatformError> {
            let protected = canonical_or_absolute_path(protected)?;
            Ok(conflict
                || canonical_target == protected
                || protected.starts_with(&canonical_target)
                || canonical_target.starts_with(&protected))
        },
    )?;
    Ok(StaleDisposalTargetFacts {
        canonical_target,
        canonical_parent,
        leaf_identity,
        has_git_metadata,
        target_is_mount,
        parent_is_filesystem_root,
        protected_path_conflict: home_conflict
            || os_root_conflict
            || descendant_conflict
            || overlap_conflict,
    })
}

/// Removes one already inspected directory without following directory
/// symlinks. The leaf identity and every non-followed traversal entry are
/// rechecked immediately before the exact `remove_dir_all` call.
///
/// A small allowlist of concurrent-writer OS errors is retried with bounded
/// backoff; every retry re-runs the complete inspection, identity comparison,
/// and safety gates before touching the filesystem again. Any error outside
/// the allowlist — including an identity mismatch on re-check — fails closed
/// immediately.
///
/// Windows allowlists its sharing-conflict codes. Unix allowlists only
/// `ENOTEMPTY`: a directory whose entries were just unlinked cannot be removed
/// because another process wrote a fresh entry into it mid-removal, which on
/// macOS is routinely Finder re-creating `.DS_Store` in a folder it is
/// displaying. Without the retry a single such write aborts the whole removal
/// and leaves a half-deleted directory behind.
pub fn remove_stale_disposal_target_exact(
    target: &Path,
    expected_leaf_identity: &[u8],
    expected_git_metadata: bool,
) -> Result<(), PlatformError> {
    let mut delays = STALE_DISPOSAL_TRANSIENT_RETRY_DELAYS_MS.iter();
    loop {
        match remove_stale_disposal_target_attempt(
            target,
            expected_leaf_identity,
            expected_git_metadata,
        ) {
            Ok(()) => return Ok(()),
            Err(error) if removal_error_is_transient(&error) => match delays.next() {
                Some(delay_ms) => std::thread::sleep(std::time::Duration::from_millis(*delay_ms)),
                None => return Err(error),
            },
            Err(error) => return Err(error),
        }
    }
}

fn remove_stale_disposal_target_attempt(
    target: &Path,
    expected_leaf_identity: &[u8],
    expected_git_metadata: bool,
) -> Result<(), PlatformError> {
    let facts = inspect_stale_disposal_target(target, &[], &[])?;
    if stale_disposal_facts_refuse_removal(&facts, expected_leaf_identity, expected_git_metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale disposal target identity or safety facts changed",
        )
        .into());
    }
    let root_metadata = fs::symlink_metadata(target)?;
    let root_device = directory_device_identity(target, &root_metadata)?;
    let mut pending = vec![target.to_path_buf()];
    let mut observed = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            observed = observed.checked_add(1).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "directory traversal overflow")
            })?;
            if observed > STALE_DISPOSAL_ENTRY_LIMIT {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "stale disposal traversal limit exceeded",
                )
                .into());
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                if directory_device_identity(&entry.path(), &metadata)? != root_device {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "stale disposal target contains a nested mount or device boundary",
                    )
                    .into());
                }
                pending.push(entry.path());
            }
        }
    }
    let final_facts = inspect_stale_disposal_target(target, &[], &[])?;
    if stale_disposal_facts_refuse_removal(
        &final_facts,
        expected_leaf_identity,
        expected_git_metadata,
    ) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale disposal target changed during traversal",
        )
        .into());
    }
    fs::remove_dir_all(target)?;
    if target.symlink_metadata().is_ok() {
        return Err(io::Error::other("stale disposal target still exists").into());
    }
    Ok(())
}

/// `expected_leaf_identity` is the fingerprint: a swapped leaf always refuses.
///
/// `expected_git_metadata` is a permission, not a fingerprint. Git metadata
/// that appears when the caller did not permit any is a hazard and refuses.
/// Metadata that is already gone is not: the leaf identity still pins the exact
/// directory, and a retry continuing a partially completed removal legitimately
/// observes a `.git` entry this run already unlinked.
fn stale_disposal_facts_refuse_removal(
    facts: &StaleDisposalTargetFacts,
    expected_leaf_identity: &[u8],
    expected_git_metadata: bool,
) -> bool {
    facts.leaf_identity != expected_leaf_identity
        || (facts.has_git_metadata && !expected_git_metadata)
        || facts.target_is_mount
        || facts.parent_is_filesystem_root
        || facts.protected_path_conflict
}

/// Device identity of one traversal entry: unix `st_dev`, Windows the volume
/// serial number observed on the entry itself. Failure to observe an identity
/// refuses removal rather than assuming a shared device.
fn directory_device_identity(path: &Path, metadata: &fs::Metadata) -> Result<u64, PlatformError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Ok(metadata.dev())
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        crate::path::windows_entry_volume_serial(path).map(u64::from)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "device identity is unsupported on this target",
        )
        .into())
    }
}

/// Windows transient sharing-conflict allowlist for the exact removal retry:
/// ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33), and
/// ERROR_DIR_NOT_EMPTY (145) observed immediately after child deletion. Any
/// other code fails closed without a retry.
#[cfg(any(windows, test))]
fn windows_removal_os_error_is_transient(code: i32) -> bool {
    matches!(code, 32 | 33 | 145)
}

/// Unix transient allowlist for the exact removal retry: only `ENOTEMPTY`,
/// which `remove_dir_all` reports when a concurrent writer re-populated a
/// directory between its traversal and the matching `rmdir`. Every other error
/// — permission, identity mismatch, device boundary — fails closed.
#[cfg(not(windows))]
fn unix_removal_error_is_transient(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::DirectoryNotEmpty
}

fn removal_error_is_transient(error: &PlatformError) -> bool {
    #[cfg(windows)]
    {
        matches!(
            error,
            PlatformError::Io(io_error)
                if io_error
                    .raw_os_error()
                    .is_some_and(windows_removal_os_error_is_transient)
        )
    }
    #[cfg(not(windows))]
    {
        matches!(error, PlatformError::Io(io_error) if unix_removal_error_is_transient(io_error))
    }
}

fn canonical_or_absolute_path(path: &Path) -> Result<PathBuf, PlatformError> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "protected path must be absolute",
        )
        .into());
    }
    match canonical_existing_directory_path(path) {
        Ok(path) => Ok(path),
        Err(PlatformError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
            let mut ancestor = path.to_path_buf();
            let mut missing = Vec::new();
            loop {
                match canonical_existing_directory_path(&ancestor) {
                    Ok(mut canonical) => {
                        for component in missing.iter().rev() {
                            canonical.push(component);
                        }
                        return Ok(canonical);
                    }
                    Err(PlatformError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                        let leaf = ancestor.file_name().ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidInput,
                                "protected path has no existing ancestor",
                            )
                        })?;
                        missing.push(leaf.to_os_string());
                        ancestor = ancestor
                            .parent()
                            .ok_or_else(|| {
                                io::Error::new(
                                    io::ErrorKind::InvalidInput,
                                    "protected path escapes its filesystem root",
                                )
                            })?
                            .to_path_buf();
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Err(error) => Err(error),
    }
}

/// Filesystem identity of the exact leaf: unix `dev`+`ino`, Windows volume
/// serial plus 64-bit file index via `GetFileInformationByHandle`. A swapped
/// leaf therefore changes identity on every supported OS; textual paths are
/// never an identity.
fn stale_disposal_leaf_identity(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<Vec<u8>, PlatformError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        let mut identity = metadata.dev().to_be_bytes().to_vec();
        identity.extend(metadata.ino().to_be_bytes());
        Ok(identity)
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        crate::path::windows_directory_identity_bytes(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "stale disposal leaf identity is unsupported on this target",
        )
        .into())
    }
}

fn directory_is_mount_point(
    path: &Path,
    target: &fs::Metadata,
    parent: &Result<fs::Metadata, io::Error>,
) -> bool {
    let Ok(parent) = parent else { return true };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        target.dev() != parent.dev()
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        let _ = parent;
        // A redirecting reparse point (volume mount point or junction) is a
        // mount hazard. Tag-level disambiguation is deliberately skipped: any
        // reparse directory reports the hazard, which fails closed.
        if target.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
        // A directory equal to its own volume mount root (a drive root or a
        // mounted-volume folder) is a mount point. Ambiguous detection also
        // reports the hazard.
        match windows_volume_mount_root(path) {
            Ok(volume_root) => windows_paths_textually_equivalent(path, &volume_root),
            Err(_) => true,
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, target, parent);
        true
    }
}

/// Resolves the volume mount root that contains `path` via
/// `GetVolumePathNameW`. If the directory itself is that root, it is a mount
/// point (drive root or mounted-volume folder).
#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_volume_mount_root(path: &Path) -> Result<PathBuf, PlatformError> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buffer = vec![0u16; wide.len().max(512)];
    // SAFETY: `wide` is an owned null-terminated UTF-16 buffer, `buffer` is
    // writable for exactly the element count passed, and both live across the
    // call. GetVolumePathNameW writes a null-terminated result on success.
    let resolved =
        unsafe { GetVolumePathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if resolved == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let length = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length],
    )))
}

/// Conservative textual equivalence used only to compare a directory against
/// its own OS-reported volume mount root: separators are unified, trailing
/// separators ignored, and ASCII case folded. A false positive reports a mount
/// hazard, which fails closed.
#[cfg(any(windows, test))]
fn windows_paths_textually_equivalent(left: &Path, right: &Path) -> bool {
    fn key(path: &Path) -> String {
        let mut key = path.to_string_lossy().replace('/', "\\");
        key.make_ascii_lowercase();
        key.trim_end_matches('\\').to_string()
    }
    key(left) == key(right)
}

fn user_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn os_protected_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            "/System",
            "/Library",
            "/Applications",
            "/usr",
            "/bin",
            "/sbin",
            "/private",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        [
            "/usr", "/etc", "/var", "/bin", "/sbin", "/boot", "/proc", "/sys", "/dev",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(windows)]
    {
        ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stale_disposal_fixture(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "termloop-stale-disposal-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        canonical_existing_directory_path(&root).unwrap()
    }

    #[test]
    fn stale_disposal_inspection_and_removal_are_exact_and_non_following() {
        let root = stale_disposal_fixture("exact");
        let target = root.join("orphan");
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::write(target.join("nested/file.txt"), b"fixture").unwrap();
        let facts = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
        assert_eq!(facts.canonical_target, target);
        assert!(!facts.has_git_metadata);
        assert!(!facts.target_is_mount);
        assert!(!facts.parent_is_filesystem_root);
        assert!(!facts.protected_path_conflict);

        remove_stale_disposal_target_exact(&target, &facts.leaf_identity, false).unwrap();
        assert!(!target.exists());
        assert!(root.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_disposal_refuses_git_metadata_and_protected_descendants() {
        let root = stale_disposal_fixture("protected");
        let target = root.join("orphan");
        let project = target.join("nested-project");
        fs::create_dir_all(&project).unwrap();
        fs::write(target.join(".git"), b"gitdir: elsewhere").unwrap();
        let facts = inspect_stale_disposal_target(&target, &[project], &[]).unwrap();
        assert!(facts.has_git_metadata);
        assert!(facts.protected_path_conflict);
        assert!(remove_stale_disposal_target_exact(&target, &facts.leaf_identity, false).is_err());
        assert!(target.exists());
        fs::remove_file(target.join(".git")).unwrap();
        let absent_protected = target.join("reserved-project");
        let facts = inspect_stale_disposal_target(&target, &[absent_protected], &[]).unwrap();
        assert!(facts.protected_path_conflict);
        let unrelated_missing_tree = root.join("runtime/profiles/fixture/state");
        let facts = inspect_stale_disposal_target(&target, &[unrelated_missing_tree], &[]).unwrap();
        assert!(!facts.protected_path_conflict);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_disposal_removes_git_metadata_only_when_exactly_expected() {
        let root = stale_disposal_fixture("expected-git-metadata");
        let target = root.join("orphan");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join(".git"), b"gitdir: /already-removed/worktree").unwrap();
        let facts = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
        assert!(facts.has_git_metadata);

        assert!(remove_stale_disposal_target_exact(&target, &facts.leaf_identity, false).is_err());
        remove_stale_disposal_target_exact(&target, &facts.leaf_identity, true).unwrap();
        assert!(!target.exists());
        assert!(root.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn permitted_git_metadata_already_unlinked_still_removes() {
        // A retry continuing a partially completed removal observes the `.git`
        // entry the previous attempt already unlinked. Permission to discard
        // git metadata is not a fingerprint, so its absence must not refuse.
        let root = stale_disposal_fixture("git-metadata-gone");
        let target = root.join("orphan");
        fs::create_dir_all(&target).unwrap();
        let facts = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
        assert!(!facts.has_git_metadata);

        remove_stale_disposal_target_exact(&target, &facts.leaf_identity, true).unwrap();
        assert!(!target.exists());
        assert!(root.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transient_removal_allowlist_is_exact_and_backoff_is_bounded() {
        for transient in [32, 33, 145] {
            assert!(windows_removal_os_error_is_transient(transient));
        }
        for non_transient in [0, 2, 5, 31, 34, 87, 144, 146, 1224] {
            assert!(!windows_removal_os_error_is_transient(non_transient));
        }
        let total_ms: u64 = STALE_DISPOSAL_TRANSIENT_RETRY_DELAYS_MS.iter().sum();
        assert!(total_ms < 500);
        assert_eq!(STALE_DISPOSAL_TRANSIENT_RETRY_DELAYS_MS.len() + 1, 4);
    }

    #[test]
    fn windows_volume_root_equivalence_ignores_case_and_trailing_separator() {
        use std::path::Path;
        assert!(windows_paths_textually_equivalent(
            Path::new(r"\\?\C:\"),
            Path::new(r"\\?\c:")
        ));
        assert!(windows_paths_textually_equivalent(
            Path::new(r"C:\Mount\Volume"),
            Path::new(r"C:\mount\volume\")
        ));
        assert!(!windows_paths_textually_equivalent(
            Path::new(r"C:\Mount\Volume\nested"),
            Path::new(r"C:\Mount\Volume")
        ));
        assert!(!windows_paths_textually_equivalent(
            Path::new(r"C:\"),
            Path::new(r"D:\")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn unix_classifies_only_a_repopulated_directory_as_transient() {
        // Raw OS codes 32/33/145 are Windows sharing violations but unix
        // EPIPE/EDOM/EOVERFLOW-class errors; they must keep failing closed.
        for code in [32, 33, 145] {
            let error = PlatformError::Io(io::Error::from_raw_os_error(code));
            assert!(!removal_error_is_transient(&error));
        }
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::NotFound,
            io::ErrorKind::InvalidInput,
            io::ErrorKind::Other,
        ] {
            assert!(!removal_error_is_transient(&PlatformError::Io(
                io::Error::from(kind)
            )));
        }
        let repopulated = PlatformError::Io(io::Error::from(io::ErrorKind::DirectoryNotEmpty));
        assert!(removal_error_is_transient(&repopulated));

        // The concrete host errno must decode to that kind, otherwise the
        // allowlist would never match a real `remove_dir_all` failure.
        #[cfg(target_os = "macos")]
        let enotempty = 66;
        #[cfg(all(unix, not(target_os = "macos")))]
        let enotempty = 39;
        assert!(unix_removal_error_is_transient(
            &io::Error::from_raw_os_error(enotempty)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_transient_classification_reads_the_raw_os_error() {
        let transient = PlatformError::Io(io::Error::from_raw_os_error(32));
        assert!(removal_error_is_transient(&transient));
        let identity_mismatch = PlatformError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "stale disposal target identity or safety facts changed",
        ));
        assert!(!removal_error_is_transient(&identity_mismatch));
        let non_transient = PlatformError::Io(io::Error::from_raw_os_error(5));
        assert!(!removal_error_is_transient(&non_transient));
    }

    #[cfg(windows)]
    #[test]
    fn windows_leaf_identity_is_filesystem_identity_not_path_text() {
        let root = stale_disposal_fixture("win-identity");
        let target = root.join("orphan");
        fs::create_dir_all(&target).unwrap();
        let facts = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
        let textual = facts
            .canonical_target
            .to_string_lossy()
            .to_lowercase()
            .into_bytes();
        assert_ne!(facts.leaf_identity, textual);

        // Swapping the directory behind the same path must change identity and
        // refuse removal, exactly as on unix.
        fs::remove_dir(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(remove_stale_disposal_target_exact(&target, &facts.leaf_identity, false).is_err());
        assert!(target.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn windows_mount_detection_flags_volume_roots_and_ordinary_directories_pass() {
        let root = stale_disposal_fixture("win-mount");
        let target = root.join("orphan");
        fs::create_dir_all(&target).unwrap();
        let facts = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
        assert!(!facts.target_is_mount);

        let canonical = canonical_existing_directory_path(&target).unwrap();
        let volume_root = windows_volume_mount_root(&canonical).unwrap();
        assert!(!windows_paths_textually_equivalent(
            &canonical,
            &volume_root
        ));
        // The volume root compares equal to itself: a directory that is its
        // own mount root is reported as a mount hazard.
        let root_of_root = windows_volume_mount_root(&volume_root).unwrap();
        assert!(windows_paths_textually_equivalent(
            &volume_root,
            &root_of_root
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn stale_disposal_refuses_a_replaced_leaf_identity_and_symlink_leaf() {
        let root = stale_disposal_fixture("identity");
        let target = root.join("orphan");
        fs::create_dir_all(&target).unwrap();
        let facts = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
        fs::remove_dir(&target).unwrap();
        // Some Unix filesystems immediately recycle the just-freed inode. Keep
        // allocating sibling directories until the replacement has a genuinely
        // different leaf identity, which is the condition this test exercises.
        let mut replacement = None;
        for attempt in 0..64 {
            fs::create_dir(root.join(format!("inode-holder-{attempt}"))).unwrap();
            fs::create_dir(&target).unwrap();
            let candidate = inspect_stale_disposal_target(&target, &[], &[]).unwrap();
            if candidate.leaf_identity != facts.leaf_identity {
                replacement = Some(candidate);
                break;
            }
            fs::remove_dir(&target).unwrap();
        }
        assert!(
            replacement.is_some(),
            "could not allocate a distinct leaf identity"
        );
        assert!(remove_stale_disposal_target_exact(&target, &facts.leaf_identity, false).is_err());

        let link = root.join("orphan-link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(inspect_stale_disposal_target(&link, &[], &[]).is_err());
        assert!(target.exists());
        let _ = fs::remove_dir_all(root);
    }
}
