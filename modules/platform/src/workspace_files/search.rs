use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;

use super::{WorkspaceFileEntry, WorkspaceFileKind, validate_workspace_relative_path};

pub const WORKSPACE_SEARCH_RESULT_LIMIT: usize = 200;
pub const WORKSPACE_SEARCH_QUERY_LIMIT: usize = 512;
// Ranking keeps at most this many candidates; `total` still counts every match.
const MATCH_CANDIDATE_LIMIT: usize = 50_000;
const VISITED_ENTRY_LIMIT: usize = 2_000_000;

#[derive(Debug, Serialize)]
pub struct WorkspaceFileSearch {
    pub query: String,
    pub entries: Vec<WorkspaceFileEntry>,
    pub total: usize,
    pub incomplete: bool,
    pub unreadable: bool,
}

struct Candidate {
    name_match: bool,
    entry: WorkspaceFileEntry,
}

fn normalize(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

/// Match every whitespace-separated term against the case-folded relative path
/// with one parallel, non-following walk. `.gitignore`, `.ignore` and Git
/// excludes prune the walk; hidden files are searched and `.git` is skipped.
pub fn search_workspace_files(
    root: &Path,
    query: &str,
    limit: usize,
    deadline: Instant,
) -> io::Result<WorkspaceFileSearch> {
    if query.len() > WORKSPACE_SEARCH_QUERY_LIMIT
        || query.chars().any(char::is_control)
        || !(1..=WORKSPACE_SEARCH_RESULT_LIMIT).contains(&limit)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid file search",
        ));
    }
    let metadata = std::fs::symlink_metadata(root)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Workspace root is not a directory",
        ));
    }
    let normalized_query = normalize(query);
    let terms: Vec<&str> = normalized_query.split_whitespace().collect();
    if terms.is_empty() {
        return Ok(WorkspaceFileSearch {
            query: query.to_owned(),
            entries: Vec::new(),
            total: 0,
            incomplete: false,
            unreadable: false,
        });
    }
    let candidates = Mutex::new(Vec::<Candidate>::new());
    let total = AtomicUsize::new(0);
    let visited = AtomicUsize::new(0);
    let incomplete = AtomicBool::new(false);
    let unreadable = AtomicBool::new(false);
    WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != ".git")
        .build_parallel()
        .run(|| {
            let (terms, candidates, total, visited, incomplete, unreadable) = (
                &terms,
                &candidates,
                &total,
                &visited,
                &incomplete,
                &unreadable,
            );
            Box::new(move |result| {
                if visited.fetch_add(1, Ordering::Relaxed) >= VISITED_ENTRY_LIMIT
                    || Instant::now() >= deadline
                {
                    incomplete.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                let entry = match result {
                    Ok(entry) => entry,
                    Err(_) => {
                        unreadable.store(true, Ordering::Relaxed);
                        return WalkState::Continue;
                    }
                };
                let Some(file_type) = entry.file_type() else {
                    return WalkState::Continue;
                };
                if entry.depth() == 0 || file_type.is_dir() {
                    return WalkState::Continue;
                }
                let Some(relative) = entry
                    .path()
                    .strip_prefix(root)
                    .ok()
                    .and_then(Path::to_str)
                    .map(|path| path.replace('\\', "/"))
                else {
                    incomplete.store(true, Ordering::Relaxed);
                    return WalkState::Continue;
                };
                let normalized = relative.to_lowercase();
                if !terms.iter().all(|term| normalized.contains(term)) {
                    return WalkState::Continue;
                }
                if validate_workspace_relative_path(&relative).is_err() {
                    incomplete.store(true, Ordering::Relaxed);
                    return WalkState::Continue;
                }
                total.fetch_add(1, Ordering::Relaxed);
                let name = relative.rsplit('/').next().unwrap_or(&relative).to_owned();
                let lowered_name = name.to_lowercase();
                let kind = if file_type.is_symlink() {
                    WorkspaceFileKind::Symlink
                } else if file_type.is_file() {
                    WorkspaceFileKind::File
                } else {
                    WorkspaceFileKind::Other
                };
                let mut candidates = candidates.lock().unwrap_or_else(|e| e.into_inner());
                if candidates.len() < MATCH_CANDIDATE_LIMIT {
                    candidates.push(Candidate {
                        name_match: terms.iter().all(|term| lowered_name.contains(term)),
                        entry: WorkspaceFileEntry {
                            name,
                            path: relative,
                            kind,
                        },
                    });
                }
                WalkState::Continue
            })
        });
    let mut candidates = candidates.into_inner().unwrap_or_else(|e| e.into_inner());
    // File-name hits rank first, then shallower and shorter paths.
    candidates.sort_by(|a, b| {
        b.name_match
            .cmp(&a.name_match)
            .then_with(|| a.entry.path.len().cmp(&b.entry.path.len()))
            .then_with(|| a.entry.path.cmp(&b.entry.path))
    });
    candidates.truncate(limit);
    Ok(WorkspaceFileSearch {
        query: query.to_owned(),
        entries: candidates.into_iter().map(|c| c.entry).collect(),
        total: total.into_inner(),
        incomplete: incomplete.into_inner(),
        unreadable: unreadable.into_inner(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("wfs-{}", &uuid::Uuid::new_v4().to_string()[..8]));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, path: &str) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn search(root: &Path, query: &str) -> WorkspaceFileSearch {
        search_workspace_files(
            root,
            query,
            WORKSPACE_SEARCH_RESULT_LIMIT,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap()
    }

    fn paths(result: &WorkspaceFileSearch) -> Vec<&str> {
        result.entries.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn matches_every_term_case_insensitively_across_nested_and_hidden_files() {
        let f = Fixture::new();
        f.write("src/nested/App.ts");
        f.write("src/other.ts");
        f.write(".env");
        let result = search(&f.0, "NESTED app");
        assert_eq!(paths(&result), ["src/nested/App.ts"]);
        assert_eq!(result.total, 1);
        assert_eq!(result.entries[0].name, "App.ts");
        assert_eq!(result.entries[0].kind, WorkspaceFileKind::File);
        assert_eq!(paths(&search(&f.0, ".ENV")), [".env"]);
        assert_eq!(paths(&search(&f.0, " SRC\\NESTED ")), ["src/nested/App.ts"]);
        assert!(search(&f.0, "missing").entries.is_empty());
        assert!(search(&f.0, "   ").entries.is_empty());
    }

    #[test]
    fn prunes_gitignored_folders_and_the_git_directory_without_a_repository() {
        let f = Fixture::new();
        f.write(".gitignore");
        std::fs::write(f.0.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        f.write("node_modules/pkg/index.js");
        f.write("debug.log");
        f.write(".git/index.js");
        f.write("src/index.js");
        let result = search(&f.0, "index");
        assert_eq!(paths(&result), ["src/index.js"]);
        assert!(search(&f.0, "debug").entries.is_empty());
    }

    #[test]
    fn ranks_file_name_hits_before_directory_hits_and_counts_beyond_the_limit() {
        let f = Fixture::new();
        f.write("subscription/zeta.cs");
        f.write("deep/folder/Subscription.cs");
        for i in 0..5 {
            f.write(&format!("many/Subscription-{i}.cs"));
        }
        let result = search_workspace_files(
            &f.0,
            "subscription",
            3,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(result.total, 7);
        assert_eq!(result.entries.len(), 3);
        assert!(
            result
                .entries
                .iter()
                .all(|e| e.name.to_lowercase().contains("subscription"))
        );
        assert!(!paths(&result).contains(&"subscription/zeta.cs"));
    }

    #[test]
    fn an_expired_deadline_reports_an_incomplete_search() {
        let f = Fixture::new();
        f.write("file.ts");
        let result =
            search_workspace_files(&f.0, "file", 10, Instant::now() - Duration::from_secs(1))
                .unwrap();
        assert!(result.incomplete);
        assert!(result.entries.is_empty());
    }

    #[test]
    fn rejects_invalid_queries_limits_and_roots() {
        let f = Fixture::new();
        let later = Instant::now() + Duration::from_secs(10);
        assert!(search_workspace_files(&f.0, "a\u{0}", 10, later).is_err());
        assert!(search_workspace_files(&f.0, &"a".repeat(513), 10, later).is_err());
        assert!(search_workspace_files(&f.0, "a", 0, later).is_err());
        assert!(search_workspace_files(&f.0, "a", 201, later).is_err());
        assert!(search_workspace_files(&f.0.join("missing"), "a", 10, later).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn reports_symlinks_without_following_them() {
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.write("target/secret.txt");
        std::os::unix::fs::symlink(outside.0.join("target"), f.0.join("linked")).unwrap();
        let result = search(&f.0, "linked");
        assert_eq!(paths(&result), ["linked"]);
        assert_eq!(result.entries[0].kind, WorkspaceFileKind::Symlink);
        assert!(search(&f.0, "secret").entries.is_empty());
        let link_root = Fixture::new();
        std::os::unix::fs::symlink(&f.0, link_root.0.join("root")).unwrap();
        assert!(
            search_workspace_files(
                &link_root.0.join("root"),
                "a",
                10,
                Instant::now() + Duration::from_secs(10)
            )
            .is_err()
        );
    }
}
