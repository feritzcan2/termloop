use std::io::{self, Read, Write};
use std::path::Path;

use cap_std::fs::{Dir, OpenOptions};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    CONTENT_LINE_LIMIT, WORKSPACE_CONTENT_LIMIT, contains_symlink, open_root,
    validate_workspace_relative_path,
};

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceFileWriteState {
    Written,
    Conflict,
}

#[derive(Debug, Serialize)]
pub struct WorkspaceFileWrite {
    pub path: String,
    pub state: WorkspaceFileWriteState,
    /// The new digest after a write, or the current on-disk digest on conflict
    /// (`None` when the file is too large to compare).
    pub version: Option<String>,
}

/// Lowercase hex SHA-256 of the exact file bytes.
pub fn workspace_file_version(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_owned())
}

/// Replace one existing regular text file only while its bytes still match
/// `expected_version`. The replacement is written to an exclusive sibling,
/// synced, given the original permissions and renamed over the target through
/// the root capability, so links and paths outside the root are never followed.
/// A change between the digest check and the rename is not detected.
pub fn write_workspace_file(
    root: &Path,
    path: &str,
    content: &str,
    expected_version: &str,
) -> io::Result<WorkspaceFileWrite> {
    validate_workspace_relative_path(path)?;
    if path.is_empty() {
        return Err(invalid("A file path is required"));
    }
    if content.len() > WORKSPACE_CONTENT_LIMIT
        || content.contains('\0')
        || content.lines().count() > CONTENT_LINE_LIMIT
    {
        return Err(invalid("Content exceeds the editable text bounds"));
    }
    if expected_version.len() != 64
        || !expected_version
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(invalid("Invalid file version"));
    }
    let root = open_root(root)?;
    if contains_symlink(&root, path)? {
        return Err(invalid("Symbolic links cannot be edited"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let current = root.open_with(path, &options)?;
    let metadata = current.metadata()?;
    if !metadata.is_file() {
        return Err(invalid("Only regular files can be edited"));
    }
    let conflict = |version| WorkspaceFileWrite {
        path: path.to_owned(),
        state: WorkspaceFileWriteState::Conflict,
        version,
    };
    if metadata.len() > WORKSPACE_CONTENT_LIMIT as u64 {
        return Ok(conflict(None));
    }
    let mut bytes = Vec::new();
    current
        .take((WORKSPACE_CONTENT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > WORKSPACE_CONTENT_LIMIT {
        return Ok(conflict(None));
    }
    let current_version = workspace_file_version(&bytes);
    if current_version != expected_version {
        return Ok(conflict(Some(current_version)));
    }
    let (parent, name) = path.rsplit_once('/').unwrap_or((".", path));
    let parent = root.open_dir(parent)?;
    let temp = format!(".{name}.termloop-tmp-{}", crate::generate_opaque_id());
    replace(
        &parent,
        name,
        &temp,
        content.as_bytes(),
        metadata.permissions(),
    )
    .inspect_err(|_| {
        let _ = parent.remove_file(&temp);
    })?;
    Ok(WorkspaceFileWrite {
        path: path.to_owned(),
        state: WorkspaceFileWriteState::Written,
        version: Some(workspace_file_version(content.as_bytes())),
    })
}

fn replace(
    parent: &Dir,
    name: &str,
    temp: &str,
    bytes: &[u8],
    permissions: cap_std::fs::Permissions,
) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = parent.open_with(temp, &options)?;
    file.write_all(bytes)?;
    file.set_permissions(permissions)?;
    file.sync_all()?;
    drop(file);
    parent.rename(temp, parent, name)
}
