use std::fs;
use std::io;
use std::path::Path;

use crate::{PlatformError, atomic_replace_private_file};

/// What sharing one entry into another directory did. `Kept` means the target
/// already holds something the caller must not replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedEntryOutcome {
    Linked,
    Copied,
    Unchanged,
    Absent,
    Kept,
}

/// The kind an entry resolves to, following links: a linked entry is shared
/// as what it points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedEntryKind {
    File,
    Directory,
}

/// Names directly inside `directory`, at most `limit` of them. A missing
/// directory has none.
pub fn list_entry_names(directory: &Path, limit: usize) -> Result<Vec<String>, PlatformError> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    let mut names = Vec::new();
    for entry in entries.take(limit) {
        if let Ok(name) = entry?.file_name().into_string() {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

pub fn shared_entry_kind(path: &Path) -> Option<SharedEntryKind> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.is_dir() {
        Some(SharedEntryKind::Directory)
    } else if metadata.is_file() {
        Some(SharedEntryKind::File)
    } else {
        None
    }
}

/// Makes the directory `source` reachable at `target` through a link to the
/// path itself, so a source that is re-pointed later is followed. An empty
/// directory or a dangling link at `target` is replaced; anything else there
/// is kept.
pub fn link_shared_directory(
    source: &Path,
    target: &Path,
) -> Result<SharedEntryOutcome, PlatformError> {
    let Ok(canonical) = fs::canonicalize(source) else {
        return Ok(SharedEntryOutcome::Absent);
    };
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => match fs::canonicalize(target) {
            Ok(current) if current == canonical => return Ok(SharedEntryOutcome::Unchanged),
            Ok(_) => return Ok(SharedEntryOutcome::Kept),
            Err(_) => remove_link(target)?,
        },
        Ok(metadata) if metadata.is_dir() => {
            if fs::read_dir(target)?.next().is_some() {
                return Ok(SharedEntryOutcome::Kept);
            }
            fs::remove_dir(target)?;
        }
        Ok(_) => return Ok(SharedEntryOutcome::Kept),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(source, target)?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(source, target)?;
    Ok(SharedEntryOutcome::Linked)
}

/// Removes `path` when it is a link whose target no longer exists, so an
/// entry shared earlier disappears once its source is deleted. Anything else
/// is left alone; the result says whether a link was removed.
pub fn remove_dangling_link(path: &Path) -> Result<bool, PlatformError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() && fs::metadata(path).is_err() => {
            remove_link(path)?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_link(path: &Path) -> io::Result<()> {
    // A Windows directory link is removed as a directory, a Unix one as a file.
    fs::remove_file(path).or_else(|_| fs::remove_dir(path))
}

/// Replaces `target` with `bytes` when it differs, keeping the executable
/// bits of `mode` where the OS has them. A link at `target` is kept: copying
/// through it would write wherever it points.
pub fn write_shared_file(
    target: &Path,
    bytes: &[u8],
    mode: Option<u32>,
) -> Result<SharedEntryOutcome, PlatformError> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if !metadata.is_file() => return Ok(SharedEntryOutcome::Kept),
        Ok(_) if fs::read(target)? == bytes => return Ok(SharedEntryOutcome::Unchanged),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    atomic_replace_private_file(target, bytes)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(target, fs::Permissions::from_mode(0o600 | (mode & 0o100)))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(SharedEntryOutcome::Copied)
}

/// Copies the regular file `source` (at most `limit` bytes) over `target`
/// when their contents differ.
pub fn copy_shared_file(
    source: &Path,
    target: &Path,
    limit: usize,
) -> Result<SharedEntryOutcome, PlatformError> {
    let metadata = match fs::metadata(source) {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return Ok(SharedEntryOutcome::Absent),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(SharedEntryOutcome::Absent);
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.len() > limit as u64 {
        return Ok(SharedEntryOutcome::Kept);
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(metadata.permissions().mode())
    };
    #[cfg(not(unix))]
    let mode = None;
    write_shared_file(target, &fs::read(source)?, mode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let root = std::env::temp_dir().join(format!("termloop-shared-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        root
    }

    #[test]
    fn links_a_directory_once_and_keeps_one_with_its_own_content() {
        let root = scratch();
        let source = root.join("source/commands");
        fs::create_dir(&source).unwrap();
        let target = root.join("target/commands");
        assert_eq!(
            link_shared_directory(&source, &target).unwrap(),
            SharedEntryOutcome::Linked
        );
        assert_eq!(
            link_shared_directory(&source, &target).unwrap(),
            SharedEntryOutcome::Unchanged
        );
        let own = root.join("target/skills");
        fs::create_dir(&own).unwrap();
        fs::write(own.join("mine.md"), "x").unwrap();
        fs::create_dir(root.join("source/skills")).unwrap();
        assert_eq!(
            link_shared_directory(&root.join("source/skills"), &own).unwrap(),
            SharedEntryOutcome::Kept
        );
        assert_eq!(
            link_shared_directory(&root.join("source/absent"), &root.join("target/absent"))
                .unwrap(),
            SharedEntryOutcome::Absent
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn removes_only_a_link_whose_target_is_gone() {
        let root = scratch();
        let source = root.join("source/skill");
        fs::create_dir(&source).unwrap();
        let link = root.join("target/skill");
        link_shared_directory(&source, &link).unwrap();
        assert!(!remove_dangling_link(&link).unwrap());
        fs::remove_dir(&source).unwrap();
        assert!(remove_dangling_link(&link).unwrap());
        assert!(fs::symlink_metadata(&link).is_err());
        let own = root.join("target/own");
        fs::create_dir(&own).unwrap();
        assert!(!remove_dangling_link(&own).unwrap());
        assert!(!remove_dangling_link(&root.join("target/absent")).unwrap());
        assert!(own.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_a_file_only_when_it_changed_and_never_through_a_link() {
        let root = scratch();
        let source = root.join("source/statusline.sh");
        fs::write(&source, "echo hi").unwrap();
        let target = root.join("target/statusline.sh");
        assert_eq!(
            copy_shared_file(&source, &target, 1024).unwrap(),
            SharedEntryOutcome::Copied
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "echo hi");
        assert_eq!(
            copy_shared_file(&source, &target, 1024).unwrap(),
            SharedEntryOutcome::Unchanged
        );
        fs::write(&source, "echo bye").unwrap();
        assert_eq!(
            copy_shared_file(&source, &target, 1024).unwrap(),
            SharedEntryOutcome::Copied
        );
        assert_eq!(
            copy_shared_file(&source, &target, 2).unwrap(),
            SharedEntryOutcome::Kept
        );
        assert_eq!(
            copy_shared_file(&root.join("source/none"), &target, 1024).unwrap(),
            SharedEntryOutcome::Absent
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_executable_bit_of_a_shared_script() {
        use std::os::unix::fs::PermissionsExt;
        let root = scratch();
        let source = root.join("source/run.sh");
        fs::write(&source, "#!/bin/sh").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o755)).unwrap();
        let target = root.join("target/run.sh");
        copy_shared_file(&source, &target, 1024).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let elsewhere = root.join("elsewhere");
        fs::write(&elsewhere, "keep").unwrap();
        let linked = root.join("target/linked.sh");
        std::os::unix::fs::symlink(&elsewhere, &linked).unwrap();
        assert_eq!(
            write_shared_file(&linked, b"new", None).unwrap(),
            SharedEntryOutcome::Kept
        );
        assert_eq!(fs::read_to_string(&elsewhere).unwrap(), "keep");
        fs::remove_dir_all(root).unwrap();
    }
}
