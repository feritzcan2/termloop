use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::{PlatformError, canonical_existing_directory_path, canonical_existing_file_within};

const MAX_DISCOVERY_ENTRIES: usize = 20_000;
const FINGERPRINT_WINDOW_BYTES: usize = 64 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct BoundedHistoryFile {
    path: PathBuf,
    root: PathBuf,
    pub modified_at_epoch_ms: u64,
    pub size_bytes: u64,
}

impl BoundedHistoryFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl std::fmt::Debug for BoundedHistoryFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundedHistoryFile")
            .field("path", &"<private>")
            .field("root", &"<private>")
            .field("modified_at_epoch_ms", &self.modified_at_epoch_ms)
            .field("size_bytes", &self.size_bytes)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct BoundedHistoryFileSlices {
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
    pub modified_at_epoch_ms: u64,
    pub size_bytes: u64,
    pub window_sha256: [u8; 32],
}

impl std::fmt::Debug for BoundedHistoryFileSlices {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BoundedHistoryFileSlices")
            .field("head_bytes", &self.head.len())
            .field("tail_bytes", &self.tail.len())
            .field("modified_at_epoch_ms", &self.modified_at_epoch_ms)
            .field("size_bytes", &self.size_bytes)
            .field("window_sha256", &"<private>")
            .finish()
    }
}

/// Discovers newest regular files below one exact provider-owned root. The walk
/// is depth/count bounded, never follows symlinks, and returns private paths
/// only to daemon modules. A missing root is an empty provider history.
pub fn discover_bounded_history_files(
    root: &Path,
    extension: &str,
    max_depth: usize,
    max_files: usize,
) -> Result<Vec<BoundedHistoryFile>, PlatformError> {
    discover_bounded_history_files_with_cancellation(root, extension, max_depth, max_files, None)
}

pub fn discover_bounded_history_files_cancellable(
    root: &Path,
    extension: &str,
    max_depth: usize,
    max_files: usize,
    cancellation: &AtomicBool,
) -> Result<Vec<BoundedHistoryFile>, PlatformError> {
    discover_bounded_history_files_with_cancellation(
        root,
        extension,
        max_depth,
        max_files,
        Some(cancellation),
    )
}

fn discover_bounded_history_files_with_cancellation(
    root: &Path,
    extension: &str,
    max_depth: usize,
    max_files: usize,
    cancellation: Option<&AtomicBool>,
) -> Result<Vec<BoundedHistoryFile>, PlatformError> {
    if max_files == 0 {
        return Ok(Vec::new());
    }
    let root = match canonical_existing_directory_path(root) {
        Ok(root) => root,
        Err(PlatformError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    let mut directories = vec![(root.clone(), 0usize)];
    let mut discovered = Vec::new();
    let mut visited = 0usize;
    'walk: while let Some((directory, depth)) = directories.pop() {
        if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            if cancellation.is_some_and(|value| value.load(Ordering::Acquire)) {
                break 'walk;
            }
            if visited >= MAX_DISCOVERY_ENTRIES {
                break;
            }
            visited += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                if depth < max_depth {
                    directories.push((path, depth + 1));
                }
                continue;
            }
            if !metadata.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some(extension)
            {
                continue;
            }
            discovered.push(BoundedHistoryFile {
                path,
                root: root.clone(),
                modified_at_epoch_ms: modified_epoch_ms(&metadata),
                size_bytes: metadata.len(),
            });
        }
        if visited >= MAX_DISCOVERY_ENTRIES {
            break;
        }
    }
    discovered.sort_by(|left, right| {
        right
            .modified_at_epoch_ms
            .cmp(&left.modified_at_epoch_ms)
            .then_with(|| right.size_bytes.cmp(&left.size_bytes))
    });
    discovered.truncate(max_files);
    Ok(discovered)
}

/// Revalidates one discovered non-symlink file inside its original root and
/// reads bounded head/tail windows. The fresh fingerprint lets Core reject a
/// history handle if the provider rewrites the source between scan and launch.
pub fn read_bounded_history_file_slices(
    candidate: &BoundedHistoryFile,
    head_limit: usize,
    tail_limit: usize,
) -> Result<BoundedHistoryFileSlices, PlatformError> {
    let path = canonical_existing_file_within(candidate.root(), candidate.path())?;
    let mut file = fs::File::open(path)?;
    let metadata = file.metadata()?;
    let size_bytes = metadata.len();
    let head_length = usize::try_from(size_bytes.min(head_limit as u64)).unwrap_or(head_limit);
    let mut head = vec![0; head_length];
    file.read_exact(&mut head)?;

    // Keep the two windows disjoint. For a file smaller than both limits this
    // reads the exact remainder after `head`; for a larger file it reads only
    // the newest tail and leaves the bounded middle unobserved.
    let tail_start = size_bytes
        .saturating_sub(tail_limit as u64)
        .max(head_length as u64);
    let tail = if tail_start >= size_bytes {
        Vec::new()
    } else {
        file.seek(SeekFrom::Start(tail_start))?;
        let tail_length = usize::try_from(size_bytes - tail_start).unwrap_or(tail_limit);
        let mut tail = vec![0; tail_length];
        file.read_exact(&mut tail)?;
        tail
    };
    // Fingerprinting is deliberately independent of the caller's parse-window
    // sizes so a cheap launch-time revalidation compares like with like.
    let fingerprint_head_length = usize::try_from(size_bytes.min(FINGERPRINT_WINDOW_BYTES as u64))
        .unwrap_or(FINGERPRINT_WINDOW_BYTES);
    file.seek(SeekFrom::Start(0))?;
    let mut fingerprint_head = vec![0; fingerprint_head_length];
    file.read_exact(&mut fingerprint_head)?;
    let fingerprint_tail_start = size_bytes
        .saturating_sub(FINGERPRINT_WINDOW_BYTES as u64)
        .max(fingerprint_head_length as u64);
    let fingerprint_tail = if fingerprint_tail_start >= size_bytes {
        Vec::new()
    } else {
        file.seek(SeekFrom::Start(fingerprint_tail_start))?;
        let length = usize::try_from(size_bytes - fingerprint_tail_start)
            .unwrap_or(FINGERPRINT_WINDOW_BYTES);
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes)?;
        bytes
    };
    let mut digest = Sha256::new();
    digest.update(size_bytes.to_le_bytes());
    digest.update((fingerprint_head.len() as u64).to_le_bytes());
    digest.update(&fingerprint_head);
    digest.update((fingerprint_tail.len() as u64).to_le_bytes());
    digest.update(&fingerprint_tail);
    Ok(BoundedHistoryFileSlices {
        head,
        tail,
        modified_at_epoch_ms: modified_epoch_ms(&metadata),
        size_bytes,
        window_sha256: digest.finalize().into(),
    })
}

fn modified_epoch_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| u64::try_from(value.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root() -> PathBuf {
        std::env::temp_dir().join(format!("termloop-agent-history-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn discovery_is_newest_first_bounded_and_skips_symlinks() {
        let root = fixture_root();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("older.jsonl"), b"older").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(root.join("nested/newer.jsonl"), b"newer").unwrap();
        fs::write(root.join("ignored.txt"), b"ignored").unwrap();
        let files = discover_bounded_history_files(&root, "jsonl", 2, 1).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].path().file_name().and_then(|value| value.to_str()),
            Some("newer.jsonl")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slices_are_bounded_and_carry_a_fresh_fingerprint() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("one.jsonl"), b"0123456789abcdef").unwrap();
        let candidate = discover_bounded_history_files(&root, "jsonl", 0, 1)
            .unwrap()
            .pop()
            .unwrap();
        let slices = read_bounded_history_file_slices(&candidate, 4, 4).unwrap();
        assert_eq!(slices.head, b"0123");
        assert_eq!(slices.tail, b"cdef");
        assert_eq!(slices.size_bytes, 16);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overlapping_limits_return_disjoint_windows_without_losing_the_file_end() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("one.jsonl"), b"0123456789ab").unwrap();
        let candidate = discover_bounded_history_files(&root, "jsonl", 0, 1)
            .unwrap()
            .pop()
            .unwrap();
        let slices = read_bounded_history_file_slices(&candidate, 8, 8).unwrap();
        assert_eq!(slices.head, b"01234567");
        assert_eq!(slices.tail, b"89ab");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn discovery_honors_preexisting_cancellation_without_reading_entries() {
        let root = fixture_root();
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("one.jsonl"), b"history").unwrap();
        let cancellation = AtomicBool::new(true);
        let files =
            discover_bounded_history_files_cancellable(&root, "jsonl", 0, 10, &cancellation)
                .unwrap();
        assert!(files.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
