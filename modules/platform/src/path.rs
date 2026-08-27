use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::PlatformError;

pub fn canonical_existing_directory(path: &str) -> Result<PathBuf, PlatformError> {
    canonical_existing_directory_path(Path::new(path))
}

/// Resolves one existing directory relative to an existing root and proves the
/// result stays inside that root after host-native canonicalization. Absolute
/// inputs and symlink escapes are rejected.
pub fn resolve_existing_directory_within(
    root: &Path,
    relative: &Path,
) -> Result<PathBuf, PlatformError> {
    if relative.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "relative directory must not be absolute",
        )
        .into());
    }
    let root = existing_directory_comparison_input(root)?;
    let resolved = existing_directory_comparison_input(&root.canonical_path().join(relative))?;
    let contained =
        root.root() == resolved.root() && resolved.segments().starts_with(root.segments());
    if !contained {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "resolved directory escapes its root",
        )
        .into());
    }
    Ok(resolved.canonical_path().to_path_buf())
}

/// Whether this host enforces the legacy Windows `MAX_PATH` limit on deep
/// filesystem paths unless a process explicitly opts into long-path support.
///
/// Callers own what to do with the fact (for example, Git's `core.longpaths`
/// opt-in belongs to `gitio`); platform only reports the OS behavior.
pub fn host_requires_long_path_opt_in() -> bool {
    cfg!(windows)
}

/// Returns the host's filesystem null device for subprocess arguments.
/// The caller owns the command semantics; platform owns the OS-specific path.
pub fn null_device_path() -> &'static Path {
    #[cfg(windows)]
    {
        Path::new("NUL")
    }
    #[cfg(not(windows))]
    {
        Path::new("/dev/null")
    }
}

/// Renders a path for use as a child-process argument. Windows
/// canonicalization produces verbatim (`\\?\`) paths, which many programs --
/// Git for Windows included -- reject as arguments; this returns the
/// equivalent drive or UNC form when one exists and the original path
/// otherwise. On Unix the path is returned unchanged.
pub fn subprocess_path_argument(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return path.to_path_buf();
        };
        let base = match prefix.kind() {
            Prefix::VerbatimDisk(disk) => PathBuf::from(format!("{}:\\", disk as char)),
            Prefix::VerbatimUNC(server, share) => {
                let mut base = std::ffi::OsString::from(r"\\");
                base.push(server);
                base.push(r"\");
                base.push(share);
                PathBuf::from(base)
            }
            _ => return path.to_path_buf(),
        };
        let mut rendered = base;
        for component in components {
            match component {
                Component::RootDir => {}
                value => rendered.push(value.as_os_str()),
            }
        }
        rendered
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

pub fn canonical_existing_directory_path(path: &Path) -> Result<PathBuf, PlatformError> {
    let candidate = path;
    if !candidate.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory path must be absolute",
        )
        .into());
    }
    let canonical = fs::canonicalize(candidate)?;
    if !fs::metadata(&canonical)?.is_dir() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "path is not a directory").into());
    }
    Ok(simplified_canonical_form(canonical))
}

/// Resolves an existing non-symlink regular file and proves its canonical
/// parent stays inside the exact existing root directory on this host.
pub fn canonical_existing_file_within(
    root: &Path,
    candidate: &Path,
) -> Result<PathBuf, PlatformError> {
    if !candidate.is_absolute() {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "file path must be absolute").into(),
        );
    }
    let entry = fs::symlink_metadata(candidate)?;
    if entry.file_type().is_symlink() || !entry.is_file() {
        return Err(
            io::Error::new(io::ErrorKind::InvalidInput, "path is not a regular file").into(),
        );
    }
    let canonical_file = simplified_canonical_form(fs::canonicalize(candidate)?);
    let parent = canonical_file.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "file path has no parent directory",
        )
    })?;
    let root = existing_directory_comparison_input(root)?;
    let parent = existing_directory_comparison_input(parent)?;
    if root.root() != parent.root() || !parent.segments().starts_with(root.segments()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file path escapes its allowed root",
        )
        .into());
    }
    Ok(canonical_file)
}

/// Windows `fs::canonicalize` returns verbatim (`\\?\`) paths while Git and
/// other tooling record the drive/UNC form, so a verbatim canonical result is
/// rewritten to its equivalent drive/UNC form whenever that form remains
/// representable for non-long-path-aware consumers. Long results keep the
/// verbatim form. Elsewhere this is the identity function.
fn simplified_canonical_form(canonical: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        const MAX_NON_VERBATIM_LENGTH: usize = 240;
        let simplified = subprocess_path_argument(&canonical);
        if simplified.as_os_str() != canonical.as_os_str()
            && simplified.as_os_str().len() <= MAX_NON_VERBATIM_LENGTH
        {
            return simplified;
        }
        canonical
    }
    #[cfg(not(windows))]
    {
        canonical
    }
}

pub fn canonical_directory_if_exists(path: &Path) -> Result<Option<PathBuf>, PlatformError> {
    match canonical_existing_directory_path(path) {
        Ok(path) => Ok(Some(path)),
        Err(PlatformError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Derives a future sibling directory from one proven existing directory.
///
/// The leaf is deliberately a single portable path component. Callers own its
/// product meaning; this boundary owns canonical parent selection and rejects
/// absolute, parent-relative, or multi-component path injection.
pub fn sibling_directory_path(
    existing_directory: &str,
    sibling_leaf: &str,
) -> Result<PathBuf, PlatformError> {
    let existing = canonical_existing_directory(existing_directory)?;
    let mut components = Path::new(sibling_leaf).components();
    let Some(std::path::Component::Normal(component)) = components.next() else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid sibling leaf").into());
    };
    if components.next().is_some() || component.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid sibling leaf").into());
    }
    let parent = existing.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "existing directory has no sibling parent",
        )
    })?;
    Ok(parent.join(component))
}

/// Filesystem-derived input for a domain-owned path comparison key.
///
/// The canonical display path remains available to callers, while the root and
/// component identity vectors are the only values that should enter pure equality
/// or containment logic. Existing paths are canonicalized first so symlink,
/// junction, separator, drive-prefix, and host volume casing behavior are
/// resolved by the platform boundary rather than reimplemented by consumers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathComparisonInput {
    canonical_path: PathBuf,
    root: Vec<u8>,
    segments: Vec<Vec<u8>>,
}

impl PathComparisonInput {
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }

    pub fn root(&self) -> &[u8] {
        &self.root
    }

    pub fn segments(&self) -> &[Vec<u8>] {
        &self.segments
    }
}

pub fn existing_directory_comparison_input(
    path: &Path,
) -> Result<PathComparisonInput, PlatformError> {
    let canonical_path = canonical_existing_directory_path(path)?;
    let mut root = Vec::new();
    let mut segments = Vec::new();
    let mut cursor = PathBuf::new();
    for component in canonical_path.components() {
        cursor.push(component.as_os_str());
        match component {
            std::path::Component::Prefix(_) => {}
            std::path::Component::RootDir => {
                root = directory_identity_bytes(&cursor, &fs::metadata(&cursor)?)?;
            }
            std::path::Component::Normal(_) => {
                segments.push(directory_identity_bytes(&cursor, &fs::metadata(&cursor)?)?);
            }
            std::path::Component::CurDir | std::path::Component::ParentDir => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "canonical path contains a lexical component",
                )
                .into());
            }
        }
    }
    if root.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "canonical path has no filesystem root",
        )
        .into());
    }
    Ok(PathComparisonInput {
        canonical_path,
        root,
        segments,
    })
}

fn directory_identity_bytes(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<Vec<u8>, PlatformError> {
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "path component is not a directory",
        )
        .into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        let mut identity = metadata.dev().to_le_bytes().to_vec();
        identity.extend_from_slice(&metadata.ino().to_le_bytes());
        Ok(identity)
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        windows_directory_identity_bytes(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem directory identity is unsupported on this target",
        )
        .into())
    }
}

#[cfg(windows)]
pub(crate) fn windows_directory_identity_bytes(path: &Path) -> Result<Vec<u8>, PlatformError> {
    let information = windows_by_handle_information(path, false)?;
    let mut identity = information.dwVolumeSerialNumber.to_le_bytes().to_vec();
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    identity.extend_from_slice(&file_index.to_le_bytes());
    Ok(identity)
}

/// Volume serial number of the exact path entry itself. The handle is opened
/// with reparse-point semantics so a junction or mounted-volume folder reports
/// its own containing volume rather than the redirect destination.
#[cfg(windows)]
pub(crate) fn windows_entry_volume_serial(path: &Path) -> Result<u32, PlatformError> {
    windows_by_handle_information(path, true).map(|information| information.dwVolumeSerialNumber)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_by_handle_information(
    path: &Path,
    observe_entry_itself: bool,
) -> Result<windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION, PlatformError> {
    use std::fs::OpenOptions;
    use std::mem::MaybeUninit;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        GetFileInformationByHandle,
    };

    let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
    if observe_entry_itself {
        flags |= FILE_FLAG_OPEN_REPARSE_POINT;
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(path)?;
    let mut information = MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: `file` owns a live directory handle, the pointer targets writable
    // storage of the exact API output type, and success initializes every field.
    let result =
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) };
    if result == 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: the successful API call above initialized the complete structure.
    Ok(unsafe { information.assume_init() })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FutureDirectoryIdentity {
    pub requested_path: PathBuf,
    pub lexical_absolute_path: PathBuf,
    pub canonical_parent: PathBuf,
    pub reserved_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathEntryState {
    Absent,
    Present,
}

/// Observes a path entry without following its final symlink. A dangling
/// symlink is therefore present and cannot be mistaken for a free destination.
pub fn path_entry_state(path: &Path) -> Result<PathEntryState, PlatformError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(PathEntryState::Present),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PathEntryState::Absent),
        Err(error) => Err(error.into()),
    }
}

/// Resolves an absent future directory through an existing canonical parent.
/// The leaf itself must not exist; callers re-canonicalize it after creation.
pub fn future_directory_identity(path: &Path) -> Result<FutureDirectoryIdentity, PlatformError> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "future directory path must be absolute",
        )
        .into());
    }
    let mut lexical = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !lexical.pop() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "future directory escapes its filesystem root",
                    )
                    .into());
                }
            }
            value => lexical.push(value.as_os_str()),
        }
    }
    let leaf = lexical.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "future directory must have a final path component",
        )
    })?;
    let parent = lexical.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "future directory must have a parent",
        )
    })?;
    let canonical_parent = canonical_existing_directory_path(parent)?;
    let reserved_path = canonical_parent.join(leaf);
    match path_entry_state(&reserved_path)? {
        PathEntryState::Present => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "future directory already exists",
            )
            .into());
        }
        PathEntryState::Absent => {}
    }
    Ok(FutureDirectoryIdentity {
        requested_path: path.to_path_buf(),
        lexical_absolute_path: lexical,
        canonical_parent,
        reserved_path,
    })
}

/// Returns whether two existing directories are equal or one contains the
/// other after filesystem canonicalization. Containment is component-based,
/// never a textual prefix comparison.
pub fn canonical_directories_overlap(left: &Path, right: &Path) -> Result<bool, PlatformError> {
    let left = canonical_existing_directory_path(left)?;
    let right = canonical_existing_directory_path(right)?;
    Ok(left == right || left.starts_with(&right) || right.starts_with(&left))
}

/// Component-based overlap for already normalized absolute path identities.
pub fn normalized_absolute_paths_overlap(left: &Path, right: &Path) -> Result<bool, PlatformError> {
    if !left.is_absolute() || !right.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "normalized paths must be absolute",
        )
        .into());
    }
    Ok(left == right || left.starts_with(right) || right.starts_with(left))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::current_epoch_ms;

    #[test]
    fn subprocess_path_argument_keeps_ordinary_paths_verbatim() {
        let ordinary = std::env::temp_dir().join("termloop-subprocess-arg");
        assert_eq!(subprocess_path_argument(&ordinary), ordinary);
    }

    #[cfg(windows)]
    #[test]
    fn subprocess_path_argument_strips_windows_verbatim_prefixes() {
        assert_eq!(
            subprocess_path_argument(Path::new(r"\\?\C:\repo\worktree")),
            PathBuf::from(r"C:\repo\worktree")
        );
        assert_eq!(
            subprocess_path_argument(Path::new(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
        let canonical = fs::canonicalize(std::env::temp_dir()).unwrap();
        let rendered = subprocess_path_argument(&canonical);
        assert!(!rendered.as_os_str().to_string_lossy().starts_with(r"\\?\"));
        assert_eq!(fs::canonicalize(&rendered).unwrap(), canonical);
    }

    #[test]
    fn long_path_opt_in_fact_matches_the_compiled_host_family() {
        assert_eq!(
            host_requires_long_path_opt_in(),
            std::env::consts::OS == "windows"
        );
    }

    #[test]
    fn null_device_path_matches_the_host_family() {
        #[cfg(windows)]
        assert_eq!(null_device_path(), Path::new("NUL"));
        #[cfg(not(windows))]
        assert_eq!(null_device_path(), Path::new("/dev/null"));
    }

    #[test]
    fn existing_file_confinement_accepts_nested_files_and_rejects_siblings() {
        let root = std::env::temp_dir().join(format!(
            "termloop-confined-file-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let allowed = root.join("allowed/nested");
        let sibling = root.join("allowed-other");
        fs::create_dir_all(&allowed).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let inside = allowed.join("rollout.jsonl");
        let outside = sibling.join("rollout.jsonl");
        fs::write(&inside, b"inside").unwrap();
        fs::write(&outside, b"outside").unwrap();

        assert_eq!(
            canonical_existing_file_within(&root.join("allowed"), &inside).unwrap(),
            simplified_canonical_form(fs::canonicalize(&inside).unwrap())
        );
        assert!(canonical_existing_file_within(&root.join("allowed"), &outside).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn canonical_directory_overlap_is_segment_based_and_symlink_aware() {
        let root = std::env::temp_dir().join(format!(
            "termloop-path-overlap-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let project = root.join("project");
        let nested = project.join("nested");
        let sibling_prefix = root.join("project-other");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&sibling_prefix).unwrap();
        assert!(canonical_directories_overlap(&project, &nested).unwrap());
        assert!(!canonical_directories_overlap(&project, &sibling_prefix).unwrap());

        let link = root.join("project-link");
        #[cfg(unix)]
        let symlink_result =
            std::os::unix::fs::symlink(&project, &link).map_err(PlatformError::from);
        #[cfg(windows)]
        let symlink_result =
            std::os::windows::fs::symlink_dir(&project, &link).map_err(PlatformError::from);
        match symlink_result {
            Ok(()) => assert!(canonical_directories_overlap(&link, &nested).unwrap()),
            Err(error) => eprintln!("UNMEASURED: directory symlink unavailable: {error}"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn comparison_input_is_canonical_segmented_and_symlink_aware() {
        let root = std::env::temp_dir().join(format!(
            "termloop-path-key-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let project = root.join("Project ünicode");
        let nested = project.join("nested");
        let sibling = root.join("Project ünicode-other");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&sibling).unwrap();

        let project_input = existing_directory_comparison_input(&project).unwrap();
        let nested_input = existing_directory_comparison_input(&nested).unwrap();
        let sibling_input = existing_directory_comparison_input(&sibling).unwrap();
        assert_eq!(project_input.root(), nested_input.root());
        assert!(
            nested_input
                .segments()
                .starts_with(project_input.segments())
        );
        assert!(
            !sibling_input
                .segments()
                .starts_with(project_input.segments())
        );

        let link = root.join("project-link");
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(&project, &link);
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_dir(&project, &link);
        match symlink_result {
            Ok(()) => {
                let link_input = existing_directory_comparison_input(&link).unwrap();
                assert_eq!(link_input.root(), project_input.root());
                assert_eq!(link_input.segments(), project_input.segments());
                assert_eq!(link_input.canonical_path(), project_input.canonical_path());
            }
            Err(error) => eprintln!("UNMEASURED: directory symlink unavailable: {error}"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_relative_directory_resolution_is_confined_after_canonicalization() {
        let root = std::env::temp_dir().join(format!(
            "termloop-platform-confined-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        let nested = root.join("packages").join("app");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            resolve_existing_directory_within(&root, Path::new("packages/app")).unwrap(),
            canonical_existing_directory_path(&nested).unwrap()
        );
        assert!(resolve_existing_directory_within(&root, Path::new("../")).is_err());
        assert!(resolve_existing_directory_within(&root, &nested).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn comparison_input_uses_filesystem_identity_on_case_insensitive_volumes() {
        let root = std::env::temp_dir().join(format!(
            "termloop-path-case-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let mixed_case = root.join("CaseProbe");
        fs::create_dir_all(&mixed_case).unwrap();
        let original = existing_directory_comparison_input(&mixed_case).unwrap();
        let alternate = root.join("caseprobe");
        match existing_directory_comparison_input(&alternate) {
            Ok(alternate) => {
                assert_eq!(alternate.root(), original.root());
                assert_eq!(alternate.segments(), original.segments());
            }
            Err(PlatformError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                eprintln!("MEASURED: fixture volume is case-sensitive");
            }
            Err(error) => panic!("case probe failed unexpectedly: {error}"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn future_directory_identity_requires_an_absent_leaf_and_canonicalizes_parent() {
        let root = std::env::temp_dir().join(format!(
            "termloop-future-directory-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let parent = root.join("parent");
        fs::create_dir_all(&parent).unwrap();
        let requested = parent.join("segment").join("..").join("worktree");
        let identity = future_directory_identity(&requested).unwrap();
        assert_eq!(identity.requested_path, requested);
        assert_eq!(identity.lexical_absolute_path, parent.join("worktree"));
        assert_eq!(
            identity.canonical_parent,
            canonical_existing_directory_path(&parent).unwrap()
        );
        assert_eq!(
            identity.reserved_path,
            identity.canonical_parent.join("worktree")
        );
        assert!(
            normalized_absolute_paths_overlap(
                &identity.reserved_path,
                &identity.reserved_path.join("nested")
            )
            .unwrap()
        );
        assert!(
            !normalized_absolute_paths_overlap(
                &identity.reserved_path,
                &identity.canonical_parent.join("worktree-other")
            )
            .unwrap()
        );
        fs::create_dir_all(identity.reserved_path).unwrap();
        assert!(future_directory_identity(&requested).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sibling_directory_derivation_is_canonical_and_rejects_path_injection() {
        let root = std::env::temp_dir().join(format!(
            "termloop-sibling-directory-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        let repository = root.join("Project");
        fs::create_dir_all(&repository).unwrap();
        let sibling = sibling_directory_path(
            repository.to_str().unwrap(),
            "Project-feature-task_worktree",
        )
        .unwrap();
        assert_eq!(
            sibling,
            canonical_existing_directory_path(&root)
                .unwrap()
                .join("Project-feature-task_worktree")
        );
        assert!(sibling_directory_path(repository.to_str().unwrap(), "../escape").is_err());
        assert!(sibling_directory_path(repository.to_str().unwrap(), "/escape").is_err());
        assert!(sibling_directory_path(repository.to_str().unwrap(), "nested/escape").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dangling_symlink_is_a_present_path_entry() {
        let root = std::env::temp_dir().join(format!(
            "termloop-path-entry-{}-{}",
            std::process::id(),
            current_epoch_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let link = root.join("destination");
        #[cfg(unix)]
        let symlink_result = std::os::unix::fs::symlink(root.join("missing"), &link);
        #[cfg(windows)]
        let symlink_result = std::os::windows::fs::symlink_dir(root.join("missing"), &link);
        match symlink_result {
            Ok(()) => assert_eq!(path_entry_state(&link).unwrap(), PathEntryState::Present),
            Err(error) => eprintln!("UNMEASURED: dangling symlink unavailable: {error}"),
        }
        let _ = fs::remove_dir_all(root);
    }
}
