#![allow(dead_code)]

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

pub struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    pub fn new(label: &str) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "termloop-gitio-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("global.gitconfig"), b"").unwrap();
        fs::create_dir_all(path.join("empty-hooks")).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn compile_fake_git(&self, body: &str) -> PathBuf {
        let source = self.path.join("fake_git.rs");
        let executable = self
            .path
            .join(format!("fake-git{}", std::env::consts::EXE_SUFFIX));
        fs::write(&source, body).unwrap();
        let status = Command::new("rustc")
            .args([source.as_os_str(), OsStr::new("-o"), executable.as_os_str()])
            .status()
            .unwrap();
        assert!(status.success(), "fake Git fixture did not compile");
        executable
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub struct TestRepository {
    directory: TestDirectory,
    root: PathBuf,
}

impl TestRepository {
    pub fn init(label: &str) -> Self {
        let directory = TestDirectory::new(label);
        let root = directory.path.join("repository");
        fs::create_dir_all(&root).unwrap();
        let repository = Self { directory, root };
        repository.git(["init", "--initial-branch=main"]);
        repository
    }

    pub fn init_with_component(label: &str, component: &OsStr) -> Self {
        Self::try_init_with_component(label, component).unwrap()
    }

    pub fn try_init_with_component(label: &str, component: &OsStr) -> std::io::Result<Self> {
        let directory = TestDirectory::new(label);
        let root = directory.path.join(component);
        fs::create_dir_all(&root)?;
        let repository = Self { directory, root };
        repository.git(["init", "--initial-branch=main"]);
        Ok(repository)
    }

    pub fn init_bare(label: &str) -> Self {
        let directory = TestDirectory::new(label);
        let root = directory.path.join("repository.git");
        fs::create_dir_all(&root).unwrap();
        let repository = Self { directory, root };
        repository.git(["init", "--bare", "--initial-branch=main"]);
        repository
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn fixture_root(&self) -> &Path {
        self.directory.path()
    }

    pub fn create_commit(&self, message: &str) {
        self.create_commit_at("tracked.txt", &format!("{message}\n"));
    }

    /// Commit exact content at an exact path. `create_commit` owns `tracked.txt`,
    /// so a test that needs its own baseline content uses this instead.
    pub fn create_commit_at(&self, name: &str, body: &str) {
        fs::write(self.root.join(name), body).unwrap();
        self.git(["add", "--", name]);
        self.git(["commit", "-m", "fixture"]);
    }

    pub fn git<I, S>(&self, args: I) -> Output
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new("git");
        command.current_dir(&self.root);
        hermetic_git(&mut command, self.directory.path());
        command.args(args);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "fixture Git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }

    pub fn index_snapshot(&self, cwd: &Path) -> IndexSnapshot {
        let mut command = Command::new("git");
        command.current_dir(cwd);
        hermetic_git(&mut command, self.directory.path());
        command.args(["rev-parse", "--git-path", "index"]);
        let output = command.output().unwrap();
        assert!(output.status.success());
        let value = output.stdout.strip_suffix(b"\n").unwrap();
        let path = termloop_platform::path_from_process_bytes(value.to_vec()).unwrap();
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        IndexSnapshot {
            bytes: fs::read(&path).ok(),
            lock_exists: path.with_file_name("index.lock").exists(),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct IndexSnapshot {
    bytes: Option<Vec<u8>>,
    lock_exists: bool,
}

pub fn hermetic_git(command: &mut Command, fixture_root: &Path) {
    command
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", fixture_root.join("global.gitconfig"))
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "TermLoop Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@termloop.invalid")
        .env("GIT_AUTHOR_DATE", "2001-01-01T00:00:00Z")
        .env("GIT_COMMITTER_NAME", "TermLoop Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@termloop.invalid")
        .env("GIT_COMMITTER_DATE", "2001-01-01T00:00:00Z")
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args([
            "-c",
            "init.defaultBranch=main",
            "-c",
            &format!(
                "core.hooksPath={}",
                fixture_root.join("empty-hooks").display()
            ),
        ]);
}
