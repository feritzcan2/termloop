//! Private snapshot replacement for a single writer, including temporary-file
//! cleanup after failed writes and a bounded startup sweep after crashes.

use std::path::{Path, PathBuf};

use crate::PlatformError;

struct TemporaryCleanup(PathBuf);

impl Drop for TemporaryCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// The caller serializes replacements of this file. As with the underlying
/// primitive, a successful replacement is atomic and privately permissioned.
pub fn atomic_replace_private_snapshot(path: &Path, bytes: &[u8]) -> Result<(), PlatformError> {
    let _cleanup = TemporaryCleanup(path.with_extension(format!("tmp-{}", std::process::id())));
    crate::atomic_replace_private_file(path, bytes)
}

/// Call before starting the writer. Only the exact named snapshots' numeric
/// PID temporary files are removed; links, directories and other files remain.
pub fn remove_atomic_replace_temporaries(
    directory: &Path,
    file_names: &[String],
) -> Result<(), PlatformError> {
    let prefixes = file_names
        .iter()
        .filter_map(|name| {
            let path = Path::new(name);
            (path.components().count() == 1)
                .then(|| {
                    path.file_stem()
                        .and_then(|stem| stem.to_str())
                        .map(|stem| format!("{stem}.tmp-"))
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    let entries = std::fs::read_dir(directory)?
        .take(4097)
        .collect::<Result<Vec<_>, _>>()?;
    if entries.len() > 4096 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "snapshot directory exceeds cleanup bound",
        )
        .into());
    }
    for entry in entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if prefixes.iter().any(|prefix| {
            name.strip_prefix(prefix)
                .is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()))
        }) && entry.file_type()?.is_file()
        {
            crate::remove_file_if_present(&entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_replacement_and_crash_sweep_preserve_the_exact_snapshot_and_other_files() {
        let root = std::env::temp_dir().join(format!(
            "termloop-private-snapshot-{}",
            crate::generate_opaque_id()
        ));
        std::fs::create_dir(&root).unwrap();
        let target = root.join("00.bin");
        std::fs::create_dir(&target).unwrap();
        assert!(atomic_replace_private_snapshot(&target, b"cannot replace a directory").is_err());
        assert!(target.is_dir());
        assert!(
            !target
                .with_extension(format!("tmp-{}", std::process::id()))
                .exists()
        );
        std::fs::remove_dir(&target).unwrap();
        atomic_replace_private_snapshot(&target, b"kept").unwrap();
        std::fs::write(root.join("00.tmp-123"), b"interrupted write").unwrap();
        std::fs::write(root.join("00.tmp-other"), b"not our temporary").unwrap();
        std::fs::write(root.join("different.tmp-123"), b"different file").unwrap();
        remove_atomic_replace_temporaries(&root, &["00.bin".into()]).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"kept");
        assert!(!root.join("00.tmp-123").exists());
        assert!(root.join("00.tmp-other").exists());
        assert!(root.join("different.tmp-123").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
