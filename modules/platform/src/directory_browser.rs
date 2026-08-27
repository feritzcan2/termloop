use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::PlatformError;

const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowsedDirectoryKind {
    Directory,
    SymlinkDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowsedDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: BrowsedDirectoryKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowsedDirectory {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<BrowsedDirectoryEntry>,
}

pub fn default_projects_root() -> Result<String, PlatformError> {
    let home = user_home_directory().ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
    canonical_directory_string(&home)
}

pub fn browse_directory(path: &Path) -> Result<BrowsedDirectory, PlatformError> {
    let canonical = crate::canonical_existing_directory_path(path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&canonical)? {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            break;
        }
        let item = item?;
        let item_path = item.path();
        let link_metadata = fs::symlink_metadata(&item_path)?;
        let kind = if link_metadata.file_type().is_symlink() {
            match fs::metadata(&item_path) {
                Ok(metadata) if metadata.is_dir() => BrowsedDirectoryKind::SymlinkDirectory,
                _ => continue,
            }
        } else if link_metadata.is_dir() {
            BrowsedDirectoryKind::Directory
        } else {
            continue;
        };
        let name = item.file_name().to_string_lossy().into_owned();
        if name.is_empty() {
            continue;
        }
        entries.push(BrowsedDirectoryEntry {
            name,
            path: item_path.to_string_lossy().into_owned(),
            kind,
        });
    }
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(BrowsedDirectory {
        path: canonical.to_string_lossy().into_owned(),
        parent_path: canonical
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned()),
        entries,
    })
}

fn canonical_directory_string(path: &Path) -> Result<String, PlatformError> {
    let canonical = crate::canonical_existing_directory_path(path)?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// Resolves the current host user's home from the platform environment adapter.
/// Callers receive a path fact only; provider-specific roots remain outside this
/// module and no environment snapshot crosses the boundary.
pub fn user_home_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(profile) = non_empty_var("USERPROFILE") {
            return Some(PathBuf::from(profile));
        }
        let drive = non_empty_var("HOMEDRIVE")?;
        let path = non_empty_var("HOMEPATH")?;
        Some(PathBuf::from(drive).join(path))
    }
    #[cfg(not(windows))]
    {
        non_empty_var("HOME").map(PathBuf::from)
    }
}

fn non_empty_var(name: &str) -> Option<OsString> {
    std::env::var_os(name).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browse_lists_only_directories_in_stable_order() {
        let root = std::env::temp_dir().join(format!("termloop-browse-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("zebra")).unwrap();
        fs::create_dir_all(root.join("Alpha")).unwrap();
        fs::write(root.join("file.txt"), b"hidden").unwrap();

        let browsed = browse_directory(&root).unwrap();
        assert_eq!(
            browsed
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "zebra"]
        );
        assert!(
            browsed
                .entries
                .iter()
                .all(|entry| entry.kind == BrowsedDirectoryKind::Directory)
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn browse_labels_directory_symlinks_and_canonicalizes_when_entered() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("termloop-browse-link-{}", uuid::Uuid::new_v4()));
        let target = root.join("target");
        fs::create_dir_all(&target).unwrap();
        symlink(&target, root.join("linked")).unwrap();

        let browsed = browse_directory(&root).unwrap();
        let linked = browsed
            .entries
            .iter()
            .find(|entry| entry.name == "linked")
            .unwrap();
        assert_eq!(linked.kind, BrowsedDirectoryKind::SymlinkDirectory);
        assert_eq!(
            browse_directory(Path::new(&linked.path)).unwrap().path,
            crate::canonical_existing_directory_path(&target)
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );

        fs::remove_dir_all(root).unwrap();
    }
}
