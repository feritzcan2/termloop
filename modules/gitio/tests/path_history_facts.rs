use std::fs;

use termloop_gitio::{GitRunner, PATH_HISTORY_MAX_ENTRIES};

mod support;

use support::TestRepository;

fn commit_as(repository: &TestRepository, author: &str, path: &str, message: &str) {
    let file = repository.root().join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, format!("{message}\n")).unwrap();
    repository.git(["add", "--", path]);
    repository.git([
        "commit",
        "-m",
        message,
        &format!("--author={author} <{author}@example.test>"),
    ]);
}

#[test]
fn path_and_message_history_name_the_authors_newest_first_without_touching_the_index() {
    let repository = TestRepository::init("path-history");
    commit_as(&repository, "Ada", "src/pay ment.rs", "PAY-7 first fix");
    commit_as(&repository, "Bo", "src/other.rs", "unrelated");
    commit_as(&repository, "Cy", "src/pay ment.rs", "second fix");
    let before = repository.index_snapshot(repository.root());
    let git = GitRunner::discover().unwrap();

    let history = git
        .path_history(repository.root(), b"src/pay ment.rs")
        .unwrap();
    let authors: Vec<&[u8]> = history
        .commits
        .iter()
        .map(|commit| commit.author())
        .collect();
    assert_eq!(authors, [b"Cy".as_slice(), b"Ada".as_slice()]);
    assert_eq!(history.commits[0].subject(), b"second fix");
    assert!(history.commits[0].authored_at_epoch_ms() > 0);
    assert!(!history.truncated);

    let named = git.message_history(repository.root(), "PAY-7").unwrap();
    assert_eq!(named.commits.len(), 1);
    assert_eq!(named.commits[0].author(), b"Ada");

    assert!(
        git.path_history(repository.root(), b"missing.rs")
            .unwrap()
            .commits
            .is_empty()
    );
    assert_eq!(before, repository.index_snapshot(repository.root()));
}

#[test]
fn history_refuses_escaping_paths_and_option_like_words() {
    let repository = TestRepository::init("path-history-refusals");
    repository.create_commit("first");
    let git = GitRunner::discover().unwrap();
    assert!(git.path_history(repository.root(), b"../outside").is_err());
    assert!(git.path_history(repository.root(), b"/etc/passwd").is_err());
    assert!(git.message_history(repository.root(), "--all").is_err());
    assert!(git.message_history(repository.root(), "a b").is_err());
    assert!(git.message_history(repository.root(), "").is_err());
}

#[test]
fn history_is_bounded_and_reports_truncation() {
    let repository = TestRepository::init("path-history-bounded");
    for index in 0..=PATH_HISTORY_MAX_ENTRIES {
        commit_as(&repository, "Ada", "hot.rs", &format!("change {index}"));
    }
    let git = GitRunner::discover().unwrap();
    let history = git.path_history(repository.root(), b"hot.rs").unwrap();
    assert_eq!(history.commits.len(), PATH_HISTORY_MAX_ENTRIES);
    assert!(history.truncated);
}
