use crate::{StoreError, io_error};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::{Duration, Instant};

const CACHE_SCHEMA_VERSION: u32 = 3;
const MAX_MATCHES: usize = 16;
const MAX_ROW_BYTES: usize = 256 * 1024;
const MAX_ROWS: usize = 4_096;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const FLUSH_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCacheFailure {
    ProviderUnavailable,
    Unauthorized,
    Offline,
    RateLimited,
    Timeout,
    OutputLimit,
    MalformedResponse,
    ProviderFailure,
    ParentUnavailable,
    CandidateLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CachedPullRequest {
    pub provider: String,
    pub host: String,
    pub repository_owner: String,
    pub repository_project: Option<String>,
    pub repository_name: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
    pub base_branch: String,
    pub head_branch: String,
    pub head_repository_owner: String,
    pub head_repository_project: Option<String>,
    pub head_repository_name: String,
    pub checks: String,
    pub review: String,
    pub mergeability: String,
    pub updated_at_epoch_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderCacheRow {
    pub key: String,
    pub matches: Vec<CachedPullRequest>,
    pub truncated: bool,
    pub parent_resolved: bool,
    pub failure: Option<ProviderCacheFailure>,
    pub last_success_observed_at: Option<u64>,
    pub last_attempt_observed_at: u64,
    pub retry_after: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderCacheFile {
    schema_version: u32,
    rows: Vec<ProviderCacheRow>,
}

struct CacheInner {
    path: PathBuf,
    rows: BTreeMap<String, ProviderCacheRow>,
    row_sizes: BTreeMap<String, usize>,
    dirty_generation: u64,
    flushed_generation: u64,
    last_flush: Option<Instant>,
    last_error: bool,
}

#[derive(Clone)]
pub struct ProviderCacheHandle {
    inner: Arc<Mutex<CacheInner>>,
    flush: mpsc::SyncSender<()>,
}

impl std::fmt::Debug for ProviderCacheHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock().expect("provider cache mutex poisoned");
        formatter
            .debug_struct("ProviderCacheHandle")
            .field("row_count", &inner.rows.len())
            .field(
                "dirty",
                &(inner.dirty_generation != inner.flushed_generation),
            )
            .field("last_error", &inner.last_error)
            .finish()
    }
}

impl ProviderCacheHandle {
    pub(crate) fn open(path: PathBuf) -> Result<Self, StoreError> {
        let rows = read_rows(&path);
        let row_sizes = rows
            .iter()
            .filter_map(|(key, row)| validate_row(row).ok().map(|size| (key.clone(), size)))
            .collect();
        let inner = Arc::new(Mutex::new(CacheInner {
            path,
            rows,
            row_sizes,
            dirty_generation: 0,
            flushed_generation: 0,
            last_flush: None,
            last_error: false,
        }));
        let (flush, receiver) = mpsc::sync_channel(1);
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name("provider-cache-writer".into())
            .spawn(move || cache_writer(weak, receiver))
            .map_err(io_error)?;
        Ok(Self { inner, flush })
    }

    pub fn get(&self, key: &str) -> Option<ProviderCacheRow> {
        self.inner
            .lock()
            .expect("provider cache mutex poisoned")
            .rows
            .get(key)
            .cloned()
    }

    pub fn update(&self, row: ProviderCacheRow) -> Result<(), StoreError> {
        let row_size = validate_row(&row)?;
        {
            let mut inner = self.inner.lock().expect("provider cache mutex poisoned");
            inner.row_sizes.insert(row.key.clone(), row_size);
            inner.rows.insert(row.key.clone(), row);
            enforce_inner_bounds(&mut inner)?;
            inner.dirty_generation = inner.dirty_generation.wrapping_add(1);
        }
        let _ = self.flush.try_send(());
        Ok(())
    }

    pub fn rows(&self) -> Vec<ProviderCacheRow> {
        self.inner
            .lock()
            .expect("provider cache mutex poisoned")
            .rows
            .values()
            .cloned()
            .collect()
    }

    pub fn last_write_failed(&self) -> bool {
        self.inner
            .lock()
            .expect("provider cache mutex poisoned")
            .last_error
    }
}

fn read_rows(path: &PathBuf) -> BTreeMap<String, ProviderCacheRow> {
    let Ok(bytes) = fs::read(path) else {
        return BTreeMap::new();
    };
    if bytes.len() > MAX_FILE_BYTES {
        return BTreeMap::new();
    }
    let Ok(file) = serde_json::from_slice::<ProviderCacheFile>(&bytes) else {
        return BTreeMap::new();
    };
    if file.schema_version != CACHE_SCHEMA_VERSION {
        return BTreeMap::new();
    }
    let mut rows = BTreeMap::new();
    for row in file.rows {
        if validate_row(&row).is_ok() {
            rows.insert(row.key.clone(), row);
        }
    }
    enforce_row_count(&mut rows);
    let _ = enforce_file_size(&mut rows);
    rows
}

fn cache_writer(weak: Weak<Mutex<CacheInner>>, receiver: mpsc::Receiver<()>) {
    while receiver.recv().is_ok() {
        loop {
            let Some(inner) = weak.upgrade() else { return };
            let wait = {
                let inner = inner.lock().expect("provider cache mutex poisoned");
                inner
                    .last_flush
                    .and_then(|last| FLUSH_INTERVAL.checked_sub(last.elapsed()))
            };
            if let Some(wait) = wait {
                std::thread::sleep(wait);
            }
            let (path, generation, bytes) = {
                let inner = inner.lock().expect("provider cache mutex poisoned");
                if inner.dirty_generation == inner.flushed_generation {
                    break;
                }
                let file = ProviderCacheFile {
                    schema_version: CACHE_SCHEMA_VERSION,
                    rows: inner.rows.values().cloned().collect(),
                };
                let Ok(bytes) = serde_json::to_vec(&file) else {
                    break;
                };
                (inner.path.clone(), inner.dirty_generation, bytes)
            };
            let result = termloop_platform::atomic_replace_private_file(&path, &bytes);
            let mut inner = inner.lock().expect("provider cache mutex poisoned");
            inner.last_flush = Some(Instant::now());
            inner.last_error = result.is_err();
            if result.is_ok() {
                inner.flushed_generation = generation;
            } else {
                drop(inner);
                std::thread::sleep(FLUSH_INTERVAL);
                continue;
            }
            if inner.dirty_generation == inner.flushed_generation {
                break;
            }
        }
    }
}

fn validate_row(row: &ProviderCacheRow) -> Result<usize, StoreError> {
    if row.key.is_empty()
        || row.key.len() > 4096
        || row.matches.len() > MAX_MATCHES
        || row
            .last_success_observed_at
            .is_some_and(|value| value > row.last_attempt_observed_at)
    {
        return Err(StoreError::ConstraintViolation);
    }
    let bytes = serde_json::to_vec(row).map_err(|_| StoreError::CorruptRecord)?;
    if bytes.len() > MAX_ROW_BYTES {
        return Err(StoreError::ConstraintViolation);
    }
    Ok(bytes.len())
}

fn enforce_inner_bounds(inner: &mut CacheInner) -> Result<(), StoreError> {
    while inner.rows.len() > MAX_ROWS || serialized_file_size(&inner.row_sizes) > MAX_FILE_BYTES {
        let Some(key) = oldest_key(&inner.rows) else {
            return Err(StoreError::ConstraintViolation);
        };
        inner.rows.remove(&key);
        inner.row_sizes.remove(&key);
    }
    Ok(())
}

fn serialized_file_size(row_sizes: &BTreeMap<String, usize>) -> usize {
    const EMPTY_FILE_BYTES: usize = 30;
    EMPTY_FILE_BYTES
        .saturating_add(row_sizes.values().copied().sum::<usize>())
        .saturating_add(row_sizes.len().saturating_sub(1))
}

fn enforce_row_count(rows: &mut BTreeMap<String, ProviderCacheRow>) {
    while rows.len() > MAX_ROWS {
        evict_oldest(rows);
    }
}

fn enforce_file_size(rows: &mut BTreeMap<String, ProviderCacheRow>) -> Result<(), StoreError> {
    loop {
        let file = ProviderCacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            rows: rows.values().cloned().collect(),
        };
        let bytes = serde_json::to_vec(&file).map_err(|_| StoreError::CorruptRecord)?;
        if bytes.len() <= MAX_FILE_BYTES {
            return Ok(());
        }
        if rows.is_empty() {
            return Err(StoreError::ConstraintViolation);
        }
        evict_oldest(rows);
    }
}

fn evict_oldest(rows: &mut BTreeMap<String, ProviderCacheRow>) {
    let oldest = oldest_key(rows);
    if let Some(key) = oldest {
        rows.remove(&key);
    }
}

fn oldest_key(rows: &BTreeMap<String, ProviderCacheRow>) -> Option<String> {
    rows.iter()
        .min_by(|(left_key, left), (right_key, right)| {
            left.last_attempt_observed_at
                .cmp(&right.last_attempt_observed_at)
                .then_with(|| left_key.cmp(right_key))
        })
        .map(|(key, _)| key.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, attempt: u64) -> ProviderCacheRow {
        ProviderCacheRow {
            key: key.into(),
            matches: vec![],
            truncated: false,
            parent_resolved: true,
            failure: None,
            last_success_observed_at: Some(attempt),
            last_attempt_observed_at: attempt,
            retry_after: None,
        }
    }

    #[test]
    fn running_file_size_matches_actual_json_encoding() {
        let rows = [row("a", 1), row("quoted-key", 2)];
        let sizes = rows
            .iter()
            .map(|row| (row.key.clone(), validate_row(row).unwrap()))
            .collect::<BTreeMap<_, _>>();
        let actual = serde_json::to_vec(&ProviderCacheFile {
            schema_version: CACHE_SCHEMA_VERSION,
            rows: rows.to_vec(),
        })
        .unwrap();
        assert_eq!(serialized_file_size(&sizes), actual.len());
    }

    #[test]
    fn concurrent_updates_share_one_map_and_survive_reopen() {
        let directory = std::env::temp_dir().join(format!(
            "termloop-provider-cache-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms()
        ));
        let path = directory.join("provider-cache.v1.json");
        let handle = ProviderCacheHandle::open(path.clone()).unwrap();
        let left = handle.clone();
        let right = handle.clone();
        let a = std::thread::spawn(move || left.update(row("a", 1)).unwrap());
        let b = std::thread::spawn(move || right.update(row("b", 2)).unwrap());
        a.join().unwrap();
        b.join().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let persisted = read_rows(&path);
            if persisted.contains_key("a") && persisted.contains_key("b") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(handle);
        let reopened = ProviderCacheHandle::open(path).unwrap();
        assert!(reopened.get("a").is_some());
        assert!(reopened.get("b").is_some());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn corrupt_or_unknown_cache_opens_empty() {
        let directory = std::env::temp_dir().join(format!(
            "termloop-provider-cache-corrupt-{}-{}",
            std::process::id(),
            termloop_platform::current_epoch_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("provider-cache.v1.json");
        fs::write(&path, b"{not-json").unwrap();
        assert!(
            ProviderCacheHandle::open(path.clone())
                .unwrap()
                .rows()
                .is_empty()
        );
        fs::write(&path, br#"{"schema_version":99,"rows":[]}"#).unwrap();
        assert!(
            ProviderCacheHandle::open(path.clone())
                .unwrap()
                .rows()
                .is_empty()
        );
        fs::write(
            &path,
            serde_json::to_vec(&ProviderCacheFile {
                schema_version: 2,
                rows: vec![row("stale-project-scan", 1)],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(ProviderCacheHandle::open(path).unwrap().rows().is_empty());
        let _ = fs::remove_dir_all(directory);
    }
}
