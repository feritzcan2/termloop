use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::PlatformError;

pub fn runtime_directory() -> Result<PathBuf, PlatformError> {
    selected_directory(
        std::env::var_os("TERMLOOP_RUNTIME_DIR").map(PathBuf::from),
        runtime_base_directory(),
        compiled_development_profile(),
        "runtime",
    )
    .ok_or(PlatformError::RuntimeDirectoryUnavailable)
}

fn runtime_base_directory() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|path| path.join("AppData/Local"))
        });
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            // Match Node's `process.getuid()` so every shipped client discovers
            // the same fallback path even when the shell did not export `UID`.
            #[allow(unsafe_code)]
            let uid = unsafe { libc::geteuid() };
            Some(std::env::temp_dir().join(format!("termloop-next-{uid}")))
        });

    base
}

pub fn state_directory() -> Result<PathBuf, PlatformError> {
    selected_directory(
        std::env::var_os("TERMLOOP_STATE_DIR").map(PathBuf::from),
        state_base_directory(),
        compiled_development_profile(),
        "state",
    )
    .ok_or(PlatformError::RuntimeDirectoryUnavailable)
}

fn state_base_directory() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|path| path.join("AppData/Local"))
        });
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|path| path.join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|path| path.join(".local/state"))
        });

    base
}

fn selected_directory(
    explicit: Option<PathBuf>,
    base: Option<PathBuf>,
    development_profile: Option<&str>,
    profile_leaf: &str,
) -> Option<PathBuf> {
    explicit.or_else(|| {
        base.map(|path| match development_profile {
            Some(profile) => path
                .join("termloop-next/profiles")
                .join(profile)
                .join(profile_leaf),
            None => path.join("termloop-next"),
        })
    })
}

#[cfg(debug_assertions)]
fn compiled_development_profile() -> Option<&'static str> {
    option_env!("TERMLOOP_COMPILED_DEV_PROFILE")
}

#[cfg(not(debug_assertions))]
fn compiled_development_profile() -> Option<&'static str> {
    None
}

pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), PlatformError> {
    let parent = path
        .parent()
        .ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
    fs::create_dir_all(parent)?;

    #[cfg(unix)]
    {
        use std::fs::{OpenOptions, Permissions};
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        fs::set_permissions(parent, Permissions::from_mode(0o700))?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true).mode(0o600);
        let mut file = options.open(path)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }

    #[cfg(windows)]
    {
        // Private semantics on Windows are enforced explicitly: the parent
        // directory and the file both receive a protected DACL granting full
        // control to only the current process user SID, mirroring unix
        // 0700/0600. A failed ACL application fails the write.
        harden_private_directory(parent)?;
        let file_result = fs::write(path, bytes).map_err(PlatformError::from);
        let hardened = file_result.and_then(|()| harden_private_file(path));
        if let Err(error) = hardened {
            let _ = fs::remove_file(path);
            return Err(error);
        }
    }

    Ok(())
}

/// Creates one new private file without replacing an existing entry. This is
/// the backup primitive for callers that must preserve the exact pre-mutation
/// bytes before an atomic replacement.
pub fn create_private_file(path: &Path, bytes: &[u8]) -> Result<(), PlatformError> {
    let parent = path
        .parent()
        .ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
    if !parent.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "parent directory is absent").into());
    }

    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.create_new(true).write(true).mode(0o600);
        let mut file = options.open(path)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }

    #[cfg(windows)]
    {
        use std::fs::OpenOptions;
        let result = (|| -> Result<(), PlatformError> {
            let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
            io::Write::write_all(&mut file, bytes)?;
            file.sync_all()?;
            harden_private_file(path)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(path);
            return Err(error);
        }
    }

    Ok(())
}

/// Applies the Windows private-file DACL: protected (no inherited ACEs), full
/// control for only the current process user SID. This is the single Windows
/// counterpart of unix mode 0600 for every platform private-write path.
#[cfg(windows)]
pub(crate) fn harden_private_file(path: &Path) -> Result<(), PlatformError> {
    apply_current_user_only_dacl(path, false)
}

/// Directory counterpart of [`harden_private_file`], mirroring unix mode 0700.
/// New children inherit the same current-user-only access.
#[cfg(windows)]
pub(crate) fn harden_private_directory(path: &Path) -> Result<(), PlatformError> {
    apply_current_user_only_dacl(path, true)
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_current_user_only_dacl(path: &Path, container: bool) -> Result<(), PlatformError> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns the process pseudo-handle, and `token`
    // is writable storage for the opened handle. Success transfers ownership of
    // a real token handle that is closed exactly once below on every path.
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if opened == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let result = apply_current_user_only_dacl_with_token(token, path, container);
    // SAFETY: `token` is the live handle opened above and is closed exactly once.
    unsafe { CloseHandle(token) };
    result
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn apply_current_user_only_dacl_with_token(
    token: windows_sys::Win32::Foundation::HANDLE,
    path: &Path,
    container: bool,
) -> Result<(), PlatformError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, GENERIC_ALL, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW,
        SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetTokenInformation, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_USER,
        TokenUser,
    };

    let mut required: u32 = 0;
    // SAFETY: a size probe with a null buffer and zero length; the API only
    // writes the required byte count into `required`, which is writable.
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required) };
    if required == 0 {
        return Err(io::Error::last_os_error().into());
    }
    // u64 storage guarantees alignment for the TOKEN_USER header.
    let mut buffer = vec![0u64; (required as usize).div_ceil(std::mem::size_of::<u64>())];
    // SAFETY: `buffer` provides at least `required` writable bytes with
    // pointer alignment; success initializes a TOKEN_USER structure (and its
    // trailing SID) inside that buffer.
    let fetched = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if fetched == 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: the successful call above initialized a TOKEN_USER at the start
    // of `buffer`, which is aligned and outlives every use of `user_sid`.
    let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    let user_sid = token_user.User.Sid;
    if user_sid.is_null() {
        return Err(io::Error::other("process token reported a null user SID").into());
    }

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: GENERIC_ALL,
        grfAccessMode: SET_ACCESS,
        grfInheritance: if container {
            SUB_CONTAINERS_AND_OBJECTS_INHERIT
        } else {
            NO_INHERITANCE
        },
        Trustee: TRUSTEE_W {
            pMultipleTrustee: std::ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: user_sid.cast(),
        },
    };
    let mut acl: *mut ACL = std::ptr::null_mut();
    // SAFETY: exactly one fully initialized entry is passed, the referenced SID
    // lives inside `buffer` for the whole call, and on success `acl` receives a
    // LocalAlloc allocation freed exactly once below.
    let built = unsafe { SetEntriesInAclW(1, &entry, std::ptr::null(), &mut acl) };
    if built != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(built as i32).into());
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is an owned null-terminated UTF-16 path and `acl` is the
    // valid ACL built above; owner, group, and SACL pointers are null and are
    // not consulted for a DACL-only, protected security operation.
    let applied = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            acl,
            std::ptr::null(),
        )
    };
    // SAFETY: `acl` was allocated by SetEntriesInAclW and is freed exactly once.
    unsafe { LocalFree(acl.cast()) };
    if applied != ERROR_SUCCESS {
        return Err(io::Error::from_raw_os_error(applied as i32).into());
    }
    Ok(())
}

/// Reads one small metadata file without lossy text conversion. Callers own
/// the format; the platform boundary owns the filesystem and size cap.
pub fn read_bounded_file(path: &Path, limit: usize) -> Result<Vec<u8>, PlatformError> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > limit as u64 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file exceeds read bound").into());
    }
    let bytes = fs::read(path)?;
    if bytes.len() > limit {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "file exceeds read bound").into());
    }
    Ok(bytes)
}

/// Reads the final `limit` bytes of one append-only file. An unbounded read is
/// not an option for a growing provider-authored log, and a leading truncated
/// record is a format concern the caller owns. `None` is the absent fact.
pub fn read_file_tail_if_present(
    path: &Path,
    limit: usize,
) -> Result<Option<Vec<u8>>, PlatformError> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let length = file.metadata()?.len();
    if length > limit as u64 {
        file.seek(SeekFrom::Start(length - limit as u64))?;
    }
    let mut bytes = Vec::new();
    file.take(limit as u64).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// Reads one small metadata file that may legitimately not exist yet. `None`
/// is the absent fact, not an error; the caller owns what absence means.
pub fn read_bounded_file_if_present(
    path: &Path,
    limit: usize,
) -> Result<Option<Vec<u8>>, PlatformError> {
    if !path.try_exists()? {
        return Ok(None);
    }
    match read_bounded_file(path, limit) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(PlatformError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Removes one file, reporting whether it was there. Absence is success: a
/// caller discarding an already-gone file has the outcome it asked for.
pub fn remove_file_if_present(path: &Path) -> Result<bool, PlatformError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// Removes one directory only when it is already empty, reporting whether it
/// was removed. Absence and remaining content are both quiet non-removal:
/// callers prune scaffolding directories and treat anything left inside as a
/// reason to keep the directory, not an error.
pub fn remove_dir_if_empty(path: &Path) -> Result<bool, PlatformError> {
    match fs::remove_dir(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// What one bounded directory sweep did. `retained_entries` counts what the
/// sweep refused to touch, which is also why the directory itself can stay.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SweptDirectory {
    pub removed_files: usize,
    pub failures: usize,
    pub retained_entries: usize,
    pub directory_removed: bool,
}

/// One sweep's entry bound. A staging directory holds a handful of files, so a
/// count anywhere near this means the path is not the directory the caller
/// thinks it is.
const SWEEP_ENTRY_LIMIT: usize = 4_096;

/// Removes the plain files directly inside one directory, then the directory
/// itself once nothing is left in it. An absent directory is success with
/// nothing done.
///
/// Non-following and non-recursive on purpose: a symlink, a nested directory,
/// or any other entry kind is counted and left alone, and anything left keeps
/// the directory. Which exact directory may be swept is the caller's policy
/// question; this primitive only refuses to walk anywhere else.
pub fn sweep_directory_files(path: &Path) -> Result<SweptDirectory, PlatformError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(SweptDirectory::default());
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "sweep target is not a plain directory",
        )
        .into());
    }
    let mut swept = SweptDirectory::default();
    let mut observed = 0usize;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        observed = observed.checked_add(1).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "sweep traversal overflow")
        })?;
        if observed > SWEEP_ENTRY_LIMIT {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "sweep entry limit exceeded").into(),
            );
        }
        let entry_path = entry.path();
        let entry_metadata = fs::symlink_metadata(&entry_path)?;
        if entry_metadata.file_type().is_symlink() || !entry_metadata.is_file() {
            swept.retained_entries = swept.retained_entries.saturating_add(1);
            continue;
        }
        match fs::remove_file(&entry_path) {
            Ok(()) => swept.removed_files = swept.removed_files.saturating_add(1),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => swept.failures = swept.failures.saturating_add(1),
        }
    }
    if swept.retained_entries == 0 && swept.failures == 0 {
        swept.directory_removed = remove_dir_if_empty(path)?;
    }
    Ok(swept)
}

/// Reads and removes one bounded ephemeral metadata file. The runtime directory
/// has a single daemon owner, so callers can use this as a consume-once handoff
/// without introducing a watcher or polling loop.
pub fn take_bounded_file(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, PlatformError> {
    if !path.try_exists()? {
        return Ok(None);
    }
    let result = read_bounded_file(path, limit);
    let removal = fs::remove_file(path);
    match result {
        Ok(bytes) => {
            removal?;
            Ok(Some(bytes))
        }
        Err(error) => {
            let _ = removal;
            Err(error)
        }
    }
}

#[allow(unsafe_code)]
pub fn atomic_replace_private_file(path: &Path, bytes: &[u8]) -> Result<(), PlatformError> {
    let parent = path
        .parent()
        .ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));

    #[cfg(unix)]
    {
        use std::fs::OpenOptions;
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true).mode(0o600);
        let mut file = options.open(&temp)?;
        io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
    }

    #[cfg(windows)]
    {
        // The replacement target carries the explicit current-user-only DACL
        // before it becomes visible under the destination name; a failed ACL
        // application fails the replace.
        let written = fs::write(&temp, bytes)
            .map_err(PlatformError::from)
            .and_then(|()| harden_private_file(&temp));
        if let Err(error) = written {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        fs::rename(&temp, path)?;
    }

    #[cfg(target_os = "windows")]
    {
        if path.exists() {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                REPLACEFILE_WRITE_THROUGH, ReplaceFileW,
            };

            let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let replacement: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            // SAFETY: Both paths are owned, null-terminated UTF-16 buffers that live
            // for the duration of the call. Optional backup/exclusion pointers are null.
            let replaced = unsafe {
                ReplaceFileW(
                    destination.as_ptr(),
                    replacement.as_ptr(),
                    std::ptr::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if replaced == 0 {
                let error = io::Error::last_os_error();
                let _ = fs::remove_file(&temp);
                return Err(error.into());
            }
        } else {
            fs::rename(&temp, path)?;
        }
        // ReplaceFileW preserves the destination's previous security, so the
        // protected DACL is re-applied to the final name; failure fails the
        // replace rather than leaving a permissive private file.
        harden_private_file(path)?;
    }

    Ok(())
}

/// Creates an exclusive private sibling backup and atomically replaces the
/// source only while its complete bytes still equal the caller's observation.
/// The returned backup is intentionally retained after success.
pub fn backup_and_atomic_replace_private_file(
    path: &Path,
    expected_original: &[u8],
    replacement: &[u8],
) -> Result<PathBuf, PlatformError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "replacement target is not a regular file",
        )
        .into());
    }
    if read_bounded_file(path, expected_original.len())? != expected_original {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "replacement target changed after inspection",
        )
        .into());
    }

    let parent = path
        .parent()
        .ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
    let mut backup_name = path
        .file_name()
        .ok_or(PlatformError::RuntimeDirectoryUnavailable)?
        .to_os_string();
    backup_name.push(format!(".termloop-backup-{}", crate::generate_opaque_id()));
    let backup = parent.join(backup_name);
    create_private_file(&backup, expected_original)?;

    // Close the backup before the final compare. A provider writer that moved
    // after the first observation is refused rather than silently omitted from
    // either the backup or the replacement.
    if read_bounded_file(path, expected_original.len())? != expected_original {
        let _ = fs::remove_file(&backup);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "replacement target changed while creating its backup",
        )
        .into());
    }
    // Keep the complete backup when replacement fails: it is the only
    // artifact the caller can use to recover from an ambiguous host error.
    atomic_replace_private_file(path, replacement)?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::selected_directory;
    use std::path::PathBuf;

    #[test]
    fn backup_and_replace_retains_exact_original_bytes() {
        let root = std::env::temp_dir().join(format!(
            "termloop-backup-replace-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let original = b"original\nbytes\n";
        let replacement = b"repaired\nbytes\n";
        std::fs::write(&path, original).unwrap();

        let backup =
            super::backup_and_atomic_replace_private_file(&path, original, replacement).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), replacement);
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        assert_eq!(backup.parent(), path.parent());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_empty_dir_removal_reports_removed_and_keeps_occupied_or_absent_dirs() {
        let root = std::env::temp_dir().join(format!(
            "termloop-remove-dir-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        let empty = root.join("empty");
        let occupied = root.join("occupied");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::write(occupied.join("keep.json"), b"{}").unwrap();

        assert!(super::remove_dir_if_empty(&empty).unwrap());
        assert!(!empty.exists());
        assert!(!super::remove_dir_if_empty(&empty).unwrap());
        assert!(!super::remove_dir_if_empty(&occupied).unwrap());
        assert!(occupied.join("keep.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_sweep_takes_the_plain_files_and_stops_at_anything_else() {
        let root = std::env::temp_dir().join(format!(
            "termloop-sweep-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        let staged = root.join("staged");
        std::fs::create_dir_all(&staged).unwrap();
        std::fs::write(staged.join("playbook.json"), b"{}").unwrap();
        std::fs::write(staged.join("stray.txt"), b"anything").unwrap();

        // Every plain file goes, including one the staging flow never wrote,
        // and the emptied directory goes with them.
        let swept = super::sweep_directory_files(&staged).unwrap();
        assert_eq!(swept.removed_files, 2);
        assert_eq!(swept.retained_entries, 0);
        assert!(swept.directory_removed);
        assert!(!staged.exists());

        // An absent directory is success with nothing done.
        assert_eq!(
            super::sweep_directory_files(&staged).unwrap(),
            super::SweptDirectory::default()
        );

        // A nested directory is never walked, and what it holds keeps its
        // parent.
        std::fs::create_dir_all(staged.join("nested")).unwrap();
        std::fs::write(staged.join("nested").join("keep.json"), b"{}").unwrap();
        std::fs::write(staged.join("go.json"), b"{}").unwrap();
        let swept = super::sweep_directory_files(&staged).unwrap();
        assert_eq!(swept.removed_files, 1);
        assert_eq!(swept.retained_entries, 1);
        assert!(!swept.directory_removed);
        assert!(staged.join("nested").join("keep.json").exists());

        // A file target is refused rather than treated as a directory.
        let file = root.join("plain.json");
        std::fs::write(&file, b"{}").unwrap();
        assert!(super::sweep_directory_files(&file).is_err());
        assert!(file.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn backup_and_replace_refuses_a_stale_observation() {
        let root = std::env::temp_dir().join(format!(
            "termloop-backup-stale-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        std::fs::write(&path, b"newer").unwrap();

        assert!(
            super::backup_and_atomic_replace_private_file(&path, b"older", b"replacement").is_err()
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"newer");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_tail_read_returns_the_final_bytes_of_a_growing_file() {
        let root = std::env::temp_dir().join(format!(
            "termloop-tail-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("transcript.jsonl");

        assert_eq!(super::read_file_tail_if_present(&path, 16).unwrap(), None);

        std::fs::write(&path, b"first\nsecond\nthird\n").unwrap();
        assert_eq!(
            super::read_file_tail_if_present(&path, 1024).unwrap(),
            Some(b"first\nsecond\nthird\n".to_vec())
        );
        // Above the bound the read starts mid-record; the caller drops that
        // leading partial line rather than the platform guessing a format.
        assert_eq!(
            super::read_file_tail_if_present(&path, 12).unwrap(),
            Some(b"econd\nthird\n".to_vec())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn private_writes_apply_a_protected_current_user_only_dacl() {
        let root = std::env::temp_dir().join(format!(
            "termloop-private-acl-{}-{}",
            std::process::id(),
            crate::current_epoch_ms()
        ));
        let path = root.join("private/record.json");
        super::write_private_file(&path, br#"{"version":1}"#).unwrap();
        assert_protected_single_ace_dacl(&path);
        assert_protected_single_ace_dacl(path.parent().unwrap());

        super::atomic_replace_private_file(&path, br#"{"version":2}"#).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"version":2}"#);
        assert_protected_single_ace_dacl(&path);

        let log_path = root.join("private/diagnostic.log");
        let log = crate::BoundedPrivateLog::open(&log_path, 4096).unwrap();
        log.append_line("fixture").unwrap();
        assert_protected_single_ace_dacl(&log_path);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[allow(unsafe_code)]
    fn assert_protected_single_ace_dacl(path: &std::path::Path) {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{ERROR_SUCCESS, LocalFree};
        use windows_sys::Win32::Security::Authorization::{GetNamedSecurityInfoW, SE_FILE_OBJECT};
        use windows_sys::Win32::Security::{
            ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, PSECURITY_DESCRIPTOR,
            SE_DACL_PROTECTED, SECURITY_DESCRIPTOR_CONTROL,
        };

        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: `wide` is an owned null-terminated UTF-16 path and both out
        // pointers are writable; success hands over one LocalAlloc descriptor
        // that is freed exactly once below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        assert_eq!(status, ERROR_SUCCESS);
        assert!(!dacl.is_null());
        let mut control: SECURITY_DESCRIPTOR_CONTROL = 0;
        let mut revision: u32 = 0;
        // SAFETY: `descriptor` is the valid descriptor returned above and both
        // out parameters are writable.
        let control_read =
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) };
        // SAFETY: `dacl` points into the live descriptor allocation above.
        let ace_count = unsafe { (*dacl).AceCount };
        // SAFETY: `descriptor` was allocated by GetNamedSecurityInfoW and is
        // freed exactly once.
        unsafe { LocalFree(descriptor) };
        assert_ne!(control_read, 0);
        assert_ne!(
            control & SE_DACL_PROTECTED,
            0,
            "DACL must be protected against inherited ACEs"
        );
        // Windows may split a container's effective and inheritable grant
        // into two ACEs. Files remain a single ACE; directories may use either
        // representation while still carrying only our one explicit trustee.
        let expected = if path.is_dir() { 1..=2 } else { 1..=1 };
        assert!(
            expected.contains(&ace_count),
            "unexpected private DACL ACE count {ace_count} for {path:?}"
        );
    }

    #[test]
    fn explicit_directory_wins_over_compiled_profile() {
        assert_eq!(
            selected_directory(
                Some(PathBuf::from("/explicit")),
                Some(PathBuf::from("/base")),
                Some("feature-abcd"),
                "state",
            ),
            Some(PathBuf::from("/explicit"))
        );
    }

    #[test]
    fn linked_profile_and_primary_defaults_are_distinct() {
        assert_eq!(
            selected_directory(
                None,
                Some(PathBuf::from("/base")),
                Some("feature-abcd"),
                "runtime",
            ),
            Some(PathBuf::from(
                "/base/termloop-next/profiles/feature-abcd/runtime"
            ))
        );
        assert_eq!(
            selected_directory(None, Some(PathBuf::from("/base")), None, "runtime"),
            Some(PathBuf::from("/base/termloop-next"))
        );
    }
}
