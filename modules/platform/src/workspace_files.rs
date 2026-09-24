use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;

#[cfg(test)]
mod tests;

pub const WORKSPACE_DIRECTORY_LIMIT: usize = 2_000;
pub const WORKSPACE_CONTENT_LIMIT: usize = 256 * 1024;
const DIRECTORY_BYTES_LIMIT: usize = 256 * 1024;
const CONTENT_LINE_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceFileKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub kind: WorkspaceFileKind,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceDirectory {
    pub path: String,
    pub entries: Vec<WorkspaceFileEntry>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_name: Option<String>,
    pub omitted: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceContentState {
    Text,
    Binary,
    TooLarge,
    Symlink,
    Unsupported,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceFileContent {
    pub path: String,
    pub state: WorkspaceContentState,
    pub content: Option<String>,
}

/// Wire paths have one portable spelling and never grant ambient path access.
pub fn validate_workspace_relative_path(path: &str) -> io::Result<()> {
    if path.len() > 4096
        || path.contains(['\\', ':'])
        || path.chars().any(char::is_control)
        || (!path.is_empty()
            && path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid relative file path",
        ));
    }
    Ok(())
}

fn open_root(root: &Path) -> io::Result<Dir> {
    if std::fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Workspace root is a symbolic link",
        ));
    }
    Dir::open_ambient_dir(root, cap_std::ambient_authority())
}

/// Check each component for the UI's no-symlink policy. The capability directory
/// also confines actual opens, including when a component changes after this check.
fn contains_symlink(root: &Dir, path: &str) -> io::Result<bool> {
    let mut prefix = PathBuf::new();
    for part in path.split('/').filter(|part| !part.is_empty()) {
        prefix.push(part);
        if root.symlink_metadata(&prefix)?.file_type().is_symlink() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn list_workspace_directory(root: &Path, path: &str) -> io::Result<WorkspaceDirectory> {
    list_workspace_directory_page(root, path, None)
}

pub fn list_workspace_directory_page(
    root: &Path,
    path: &str,
    after_name: Option<&str>,
) -> io::Result<WorkspaceDirectory> {
    validate_workspace_relative_path(path)?;
    if let Some(name) = after_name {
        validate_workspace_relative_path(name)?;
        if name.is_empty() || name.contains('/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid directory cursor",
            ));
        }
    }
    let root = open_root(root)?;
    if contains_symlink(&root, path)? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Symbolic links cannot be browsed",
        ));
    }
    let directory = root.open_dir(if path.is_empty() { "." } else { path })?;
    let mut entries = Vec::new();
    let mut bytes = 0;
    let mut omitted = false;
    // Keep only the next bounded window in portable name order. Reading all
    // names avoids depending on unstable OS enumeration order across pages.
    let mut candidates = BTreeMap::new();
    let mut more_candidates = false;
    for entry in directory.entries()? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let Ok(name) = entry.file_name().into_string() else {
            omitted = true;
            continue;
        };
        if name == ".git" || after_name.is_some_and(|after| name.as_str() <= after) {
            continue;
        }
        let child = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        if validate_workspace_relative_path(&child).is_err() {
            omitted = true;
            continue;
        }
        candidates.insert(name, (child, entry));
        if candidates.len() > WORKSPACE_DIRECTORY_LIMIT + 1 {
            candidates.pop_last();
            more_candidates = true;
        }
    }
    let mut next_name = None;
    let mut last_name = None;
    for (name, (child, entry)) in candidates {
        if entries.len() >= WORKSPACE_DIRECTORY_LIMIT
            || bytes + name.len() + child.len() > DIRECTORY_BYTES_LIMIT
        {
            next_name = last_name.clone();
            break;
        }
        last_name = Some(name.clone());
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let kind = if file_type.is_symlink() {
            WorkspaceFileKind::Symlink
        } else if file_type.is_dir() {
            WorkspaceFileKind::Directory
        } else if file_type.is_file() {
            WorkspaceFileKind::File
        } else {
            WorkspaceFileKind::Other
        };
        bytes += name.len() + child.len();
        entries.push(WorkspaceFileEntry {
            name,
            path: child,
            kind,
        });
    }
    if next_name.is_none() && more_candidates {
        next_name = last_name;
    }
    entries.sort_by(|a, b| {
        (a.kind != WorkspaceFileKind::Directory)
            .cmp(&(b.kind != WorkspaceFileKind::Directory))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(WorkspaceDirectory {
        path: path.to_owned(),
        entries,
        truncated: omitted || next_name.is_some(),
        next_name,
        omitted,
    })
}

pub fn read_workspace_file(root: &Path, path: &str) -> io::Result<WorkspaceFileContent> {
    validate_workspace_relative_path(path)?;
    let result = |state, content| WorkspaceFileContent {
        path: path.to_owned(),
        state,
        content,
    };
    let root = open_root(root)?;
    if contains_symlink(&root, path)? {
        return Ok(result(WorkspaceContentState::Symlink, None));
    }
    if path.is_empty() || !root.symlink_metadata(path)?.is_file() {
        return Ok(result(WorkspaceContentState::Unsupported, None));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // A regular file can be replaced by a FIFO between metadata and open.
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = root.open_with(path, &options)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Ok(result(WorkspaceContentState::Unsupported, None));
    }
    if metadata.len() > WORKSPACE_CONTENT_LIMIT as u64 {
        return Ok(result(WorkspaceContentState::TooLarge, None));
    }
    let mut bytes = Vec::new();
    file.take((WORKSPACE_CONTENT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > WORKSPACE_CONTENT_LIMIT {
        return Ok(result(WorkspaceContentState::TooLarge, None));
    }
    if bytes.contains(&0) {
        return Ok(result(WorkspaceContentState::Binary, None));
    }
    let Ok(content) = String::from_utf8(bytes) else {
        return Ok(result(WorkspaceContentState::Binary, None));
    };
    if content.lines().count() > CONTENT_LINE_LIMIT {
        return Ok(result(WorkspaceContentState::TooLarge, None));
    }
    Ok(result(WorkspaceContentState::Text, Some(content)))
}

/// A retained directory capability for reading an explicitly selected set of
/// editable text files. Renaming/replacing the original path never changes the
/// directory granted to this reader. Reads reject links and non-regular files.
pub struct WorkspaceFileReader(Dir);

impl WorkspaceFileReader {
    pub fn open(root: &Path) -> io::Result<Self> {
        Ok(Self(open_root(root)?))
    }

    pub fn read_text(&self, path: &str, max_bytes: usize) -> io::Result<String> {
        if !(1..=4 * 1024 * 1024).contains(&max_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid text bound",
            ));
        }
        let bytes = self.read_bytes(path, max_bytes)?;
        if bytes.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "NUL in text file",
            ));
        }
        String::from_utf8(bytes)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid UTF-8 file"))
    }

    pub fn create_file(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        validate_workspace_relative_path(name)?;
        if name.is_empty() || name.contains(['/', '\\']) || bytes.len() > 20 * 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid workspace output",
            ));
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = self.0.open_with(name, &options)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    pub fn read_bytes(&self, path: &str, max_bytes: usize) -> io::Result<Vec<u8>> {
        validate_workspace_relative_path(path)?;
        let invalid = || {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Expected a bounded regular UTF-8 workspace file",
            )
        };
        if path.is_empty()
            || !(1..=20 * 1024 * 1024).contains(&max_bytes)
            || contains_symlink(&self.0, path)?
            || !self.0.symlink_metadata(path)?.is_file()
        {
            return Err(invalid());
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = self.0.open_with(path, &options)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > max_bytes as u64 {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        file.take((max_bytes + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > max_bytes {
            return Err(invalid());
        }
        Ok(bytes)
    }
}
