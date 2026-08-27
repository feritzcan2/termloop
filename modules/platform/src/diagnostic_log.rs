use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::PlatformError;

/// A private, disposable, size-bounded operational log. Product state and
/// provider content never belong here; callers supply one already-redacted
/// line per diagnostic transition.
#[derive(Clone)]
pub struct BoundedPrivateLog {
    inner: Arc<Mutex<BoundedPrivateLogInner>>,
}

struct BoundedPrivateLogInner {
    file: File,
    maximum_bytes: u64,
}

impl BoundedPrivateLog {
    pub fn open(path: &Path, maximum_bytes: u64) -> Result<Self, PlatformError> {
        let parent = path
            .parent()
            .ok_or(PlatformError::RuntimeDirectoryUnavailable)?;
        std::fs::create_dir_all(parent)?;
        let mut options = OpenOptions::new();
        // The in-process mutex serializes every writer, so ordinary write
        // access plus an explicit seek is sufficient and, unlike Windows
        // append-only access, also permits bounded rotation via `set_len`.
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            options.mode(0o600);
        }
        #[cfg(windows)]
        crate::fs::harden_private_directory(parent)?;
        let file = options.open(path)?;
        #[cfg(windows)]
        crate::fs::harden_private_file(path)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(BoundedPrivateLogInner {
                file,
                maximum_bytes: maximum_bytes.max(1),
            })),
        })
    }

    pub fn append_line(&self, line: &str) -> Result<(), PlatformError> {
        const MAX_LINE_BYTES: usize = 4 * 1024;
        if line.len() > MAX_LINE_BYTES || line.contains(['\n', '\r']) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "diagnostic log line is invalid",
            )
            .into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| std::io::Error::other("bounded diagnostic log lock was poisoned"))?;
        let incoming = line.len() as u64 + 1;
        if inner.file.metadata()?.len().saturating_add(incoming) > inner.maximum_bytes {
            inner.file.set_len(0)?;
            inner.file.seek(SeekFrom::Start(0))?;
        } else {
            inner.file.seek(SeekFrom::End(0))?;
        }
        inner.file.write_all(line.as_bytes())?;
        inner.file.write_all(b"\n")?;
        inner.file.flush()?;
        Ok(())
    }
}
