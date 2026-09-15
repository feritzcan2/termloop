use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("wf-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn lists_all_kinds_of_files_lazily_with_directories_first() {
    let f = Fixture::new();
    std::fs::create_dir(f.0.join("z-dir")).unwrap();
    std::fs::create_dir(f.0.join(".git")).unwrap();
    std::fs::write(f.0.join("z-dir/nested.txt"), "nested").unwrap();
    for name in [
        "tracked.txt",
        "untracked.txt",
        ".hidden",
        ".gitignore",
        "ignored.log",
    ] {
        std::fs::write(f.0.join(name), "ignored.log\n").unwrap();
    }
    let list = list_workspace_directory(&f.0, "").unwrap();
    assert_eq!(list.entries.len(), 6);
    assert_eq!(list.entries[0].kind, WorkspaceFileKind::Directory);
    assert_eq!(list.entries[0].name, "z-dir");
    assert!(!list.truncated);
    let nested = list_workspace_directory(&f.0, "z-dir").unwrap();
    assert_eq!(nested.entries[0].path, "z-dir/nested.txt");
    std::fs::remove_dir(f.0.join(".git")).unwrap();
    std::fs::write(f.0.join(".git"), "gitdir: elsewhere").unwrap();
    assert_eq!(list_workspace_directory(&f.0, "").unwrap().entries.len(), 6);
}

#[test]
fn refuses_traversal_and_nonportable_paths_before_io() {
    for path in [
        "/etc",
        "../a",
        "x/../../a",
        "x//a",
        "x/./a",
        "x/",
        "C:/x",
        "x\\a",
        "x\0a",
        "x\na",
    ] {
        assert!(validate_workspace_relative_path(path).is_err(), "{path:?}");
        assert!(list_workspace_directory(Path::new("missing"), path).is_err());
        assert!(read_workspace_file(Path::new("missing"), path).is_err());
    }
    assert!(validate_workspace_relative_path(&"x".repeat(4097)).is_err());
    assert!(validate_workspace_relative_path("src/café.ts").is_ok());
}

#[test]
fn reads_empty_and_utf8_text_and_returns_no_content_for_unsupported_inputs() {
    let f = Fixture::new();
    for (name, bytes, state) in [
        ("empty", b"".as_slice(), WorkspaceContentState::Text),
        (
            "text",
            "Merhaba dünya\n".as_bytes(),
            WorkspaceContentState::Text,
        ),
        ("nul", b"a\0b", WorkspaceContentState::Binary),
        ("invalid", b"\xff", WorkspaceContentState::Binary),
    ] {
        std::fs::write(f.0.join(name), bytes).unwrap();
        let result = read_workspace_file(&f.0, name).unwrap();
        assert_eq!(result.state, state);
        if state == WorkspaceContentState::Text {
            assert_eq!(result.content.unwrap().as_bytes(), bytes);
        } else {
            assert!(result.content.is_none());
        }
    }
    assert_eq!(
        read_workspace_file(&f.0, "").unwrap().state,
        WorkspaceContentState::Unsupported
    );
    assert_eq!(
        read_workspace_file(&f.0, "gone").unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn bounds_directory_entries_bytes_and_lines() {
    let f = Fixture::new();
    std::fs::write(f.0.join("large"), vec![b'a'; WORKSPACE_CONTENT_LIMIT + 1]).unwrap();
    std::fs::write(f.0.join("lines"), "x\n".repeat(CONTENT_LINE_LIMIT + 1)).unwrap();
    for name in ["large", "lines"] {
        let result = read_workspace_file(&f.0, name).unwrap();
        assert_eq!(result.state, WorkspaceContentState::TooLarge);
        assert!(result.content.is_none());
    }
    for index in 0..WORKSPACE_DIRECTORY_LIMIT {
        std::fs::write(f.0.join(format!("file-{index}")), "").unwrap();
    }
    let list = list_workspace_directory(&f.0, "").unwrap();
    assert_eq!(list.entries.len(), WORKSPACE_DIRECTORY_LIMIT);
    assert!(list.truncated);
    let next = list_workspace_directory_page(&f.0, "", list.next_name.as_deref()).unwrap();
    assert!(!next.truncated);
    assert_eq!(next.entries.len(), 2);
    let paths: std::collections::HashSet<_> = list
        .entries
        .iter()
        .chain(&next.entries)
        .map(|entry| &entry.path)
        .collect();
    assert_eq!(paths.len(), WORKSPACE_DIRECTORY_LIMIT + 2);
}

#[test]
fn cursor_is_portable_and_never_a_path_or_root_authority() {
    let f = Fixture::new();
    for cursor in ["", "../escape", "a/b", "a\\b", "/", "C:", ".", ".."] {
        assert_eq!(
            list_workspace_directory_page(&f.0, "", Some(cursor))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }
}

#[test]
fn pages_long_paths_by_bytes_without_skipping_the_first_unreturned_entry() {
    let f = Fixture::new();
    let path = "nested";
    std::fs::create_dir_all(f.0.join(path)).unwrap();
    for i in 0..1000 {
        std::fs::write(
            f.0.join(path).join(format!("{}-{i:04}", "a".repeat(150))),
            "",
        )
        .unwrap();
    }
    let mut cursor = None;
    let mut found = std::collections::HashSet::new();
    loop {
        let result = list_workspace_directory_page(&f.0, path, cursor.as_deref()).unwrap();
        assert!(
            result
                .entries
                .iter()
                .map(|e| e.name.len() + e.path.len())
                .sum::<usize>()
                <= DIRECTORY_BYTES_LIMIT
        );
        for entry in result.entries {
            assert!(found.insert(entry.path));
        }
        cursor = result.next_name;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(found.len(), 1000);
}

#[test]
fn exact_preview_limits_remain_readable() {
    let f = Fixture::new();
    std::fs::write(f.0.join("bytes"), vec![b'a'; WORKSPACE_CONTENT_LIMIT]).unwrap();
    std::fs::write(f.0.join("lines"), "x\n".repeat(CONTENT_LINE_LIMIT)).unwrap();
    for path in ["bytes", "lines"] {
        assert_eq!(
            read_workspace_file(&f.0, path).unwrap().state,
            WorkspaceContentState::Text
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn non_utf8_filenames_are_explicitly_reported_as_omitted() {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new();
    std::fs::write(f.0.join(std::ffi::OsString::from_vec(vec![0xff])), "").unwrap();
    let list = list_workspace_directory(&f.0, "").unwrap();
    assert!(list.truncated);
    assert!(list.entries.is_empty());
}

#[cfg(unix)]
#[test]
fn displays_symlinks_without_reading_targets_or_browsing_them() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = Fixture::new();
    std::fs::write(outside.0.join("secret"), "outside").unwrap();
    std::fs::write(f.0.join("inside"), "inside").unwrap();
    symlink(&outside.0, f.0.join("escape")).unwrap();
    symlink("inside", f.0.join("link")).unwrap();
    symlink("gone", f.0.join("dangling")).unwrap();
    for path in ["escape/secret", "link", "dangling"] {
        let read = read_workspace_file(&f.0, path).unwrap();
        assert_eq!(read.state, WorkspaceContentState::Symlink);
        assert!(read.content.is_none());
    }
    assert!(list_workspace_directory(&f.0, "escape").is_err());
    let list = list_workspace_directory(&f.0, "").unwrap();
    assert_eq!(
        list.entries
            .iter()
            .filter(|e| e.kind == WorkspaceFileKind::Symlink)
            .count(),
        3
    );
}

#[cfg(unix)]
#[test]
fn special_files_are_not_opened() {
    let f = Fixture::new();
    let socket = std::os::unix::net::UnixListener::bind(f.0.join("socket")).unwrap();
    assert_eq!(
        read_workspace_file(&f.0, "socket").unwrap().state,
        WorkspaceContentState::Unsupported
    );
    assert_eq!(
        list_workspace_directory(&f.0, "").unwrap().entries[0].kind,
        WorkspaceFileKind::Other
    );
    drop(socket);
}
