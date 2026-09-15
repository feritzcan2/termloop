use super::*;
use std::os::unix::fs::{PermissionsExt, symlink};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "termloop-credentials-{}",
            crate::generate_opaque_id()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn store(&self) -> EncryptedFileCredentialStore {
        EncryptedFileCredentialStore::new(self.0.join("credentials"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn key() -> SecureCredentialKey {
    SecureCredentialKey::new("dev.termloop.task-source.jira", "source-1").unwrap()
}

fn secret() -> SecureSecret {
    SecureSecret::new(b"jira@example.invalid\0test-api-token".to_vec()).unwrap()
}

#[test]
fn credentials_survive_reopening_update_and_delete_without_plaintext_on_disk() {
    let fixture = Fixture::new();
    let store = fixture.store();
    assert!(matches!(
        store.get(&key()),
        Err(SecureCredentialError::NotFound)
    ));
    store.set(&key(), &secret()).unwrap();
    assert_eq!(
        fixture.store().get(&key()).unwrap().expose(),
        secret().expose()
    );
    let first = fs::read(store.directory.join(record_name(&key()))).unwrap();
    store.set(&key(), &secret()).unwrap();
    assert_ne!(
        first,
        fs::read(store.directory.join(record_name(&key()))).unwrap()
    );
    for entry in fs::read_dir(&store.directory).unwrap() {
        let entry = entry.unwrap();
        let bytes = fs::read(entry.path()).unwrap();
        assert!(
            !bytes
                .windows(b"test-api-token".len())
                .any(|window| window == b"test-api-token")
        );
        assert!(
            !bytes
                .windows(b"jira@example.invalid".len())
                .any(|window| window == b"jira@example.invalid")
        );
        assert_eq!(
            entry.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        fs::metadata(&store.directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let updated = SecureSecret::new(vec![0, 255, 1, 128]).unwrap();
    fixture.store().set(&key(), &updated).unwrap();
    assert_eq!(store.get(&key()).unwrap().expose(), updated.expose());
    fixture.store().delete(&key()).unwrap();
    assert!(matches!(
        store.get(&key()),
        Err(SecureCredentialError::NotFound)
    ));
    assert_eq!(store.delete(&key()), Err(SecureCredentialError::NotFound));
}

#[test]
fn service_and_account_are_isolated_and_cannot_escape_the_directory() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let keys = [
        ("ab", "c"),
        ("a", "bc"),
        ("a", "../../outside"),
        ("b", "bc"),
    ]
    .map(|(service, account)| SecureCredentialKey::new(service, account).unwrap());
    for (index, key) in keys.iter().enumerate() {
        store
            .set(key, &SecureSecret::new(vec![index as u8]).unwrap())
            .unwrap();
    }
    for (index, key) in keys.iter().enumerate() {
        assert_eq!(store.get(key).unwrap().expose(), &[index as u8]);
    }
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn modified_or_reassigned_ciphertext_is_rejected() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.set(&key(), &secret()).unwrap();
    let path = store.directory.join(record_name(&key()));
    let original = fs::read(&path).unwrap();
    let other = SecureCredentialKey::new("other-service", "source-1").unwrap();
    store.set(&other, &secret()).unwrap();
    fs::write(store.directory.join(record_name(&other)), &original).unwrap();
    assert!(matches!(
        store.get(&other),
        Err(SecureCredentialError::Unavailable)
    ));
    for index in [0, HEADER.len(), original.len() - 1] {
        let mut changed = original.clone();
        changed[index] ^= 1;
        fs::write(&path, changed).unwrap();
        assert!(matches!(
            store.get(&key()),
            Err(SecureCredentialError::Unavailable)
        ));
    }
    fs::write(&path, vec![0; RECORD_MAX_BYTES + 1]).unwrap();
    assert!(matches!(
        store.get(&key()),
        Err(SecureCredentialError::Unavailable)
    ));
}

#[test]
fn lost_or_corrupt_master_key_is_never_replaced_over_existing_credentials() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.set(&key(), &secret()).unwrap();
    let record = fs::read(store.directory.join(record_name(&key()))).unwrap();
    fs::remove_file(store.directory.join(MASTER_KEY)).unwrap();
    assert!(matches!(
        store.get(&key()),
        Err(SecureCredentialError::Unavailable)
    ));
    assert_eq!(
        store.set(&key(), &secret()),
        Err(SecureCredentialError::Unavailable)
    );
    assert!(!store.directory.join(MASTER_KEY).exists());
    fs::write(store.directory.join(MASTER_KEY), b"invalid").unwrap();
    fs::set_permissions(
        store.directory.join(MASTER_KEY),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        store.set(&key(), &secret()),
        Err(SecureCredentialError::Unavailable)
    );
    assert_eq!(
        fs::read(store.directory.join(record_name(&key()))).unwrap(),
        record
    );
}

#[test]
fn symlinked_roots_keys_locks_and_records_are_rejected() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, &store.directory).unwrap();
    assert!(store.selected());
    assert_eq!(
        store.set(&key(), &secret()),
        Err(SecureCredentialError::Unavailable)
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_file(&store.directory).unwrap();
    store.set(&key(), &secret()).unwrap();
    for name in [
        MASTER_KEY.to_owned(),
        "store.lock".to_owned(),
        record_name(&key()),
    ] {
        let path = store.directory.join(&name);
        let target = outside.join(&name);
        fs::rename(&path, &target).unwrap();
        let original = fs::read(&target).unwrap();
        symlink(&target, &path).unwrap();
        assert!(matches!(
            store.get(&key()),
            Err(SecureCredentialError::Unavailable)
        ));
        assert_eq!(fs::read(&target).unwrap(), original);
        fs::remove_file(&path).unwrap();
        fs::rename(target, path).unwrap();
    }
}

#[test]
fn permissive_files_hard_links_and_special_files_are_rejected() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store.set(&key(), &secret()).unwrap();
    for path in [
        &store.directory,
        &store.directory.join(MASTER_KEY),
        &store.directory.join(record_name(&key())),
    ] {
        let permissions = fs::metadata(path).unwrap().permissions();
        fs::set_permissions(path, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(matches!(
            store.get(&key()),
            Err(SecureCredentialError::Unavailable)
        ));
        fs::set_permissions(path, permissions).unwrap();
    }
    let path = store.directory.join(record_name(&key()));
    fs::hard_link(&path, fixture.0.join("linked-record")).unwrap();
    assert!(matches!(
        store.get(&key()),
        Err(SecureCredentialError::Unavailable)
    ));
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        store.get(&key()),
        Err(SecureCredentialError::Unavailable)
    ));
}

#[test]
fn independent_store_instances_serialize_key_creation_and_writes() {
    let fixture = Fixture::new();
    std::thread::scope(|scope| {
        for index in 0..12 {
            let fixture = &fixture;
            scope.spawn(move || {
                let key = SecureCredentialKey::new("jira", format!("source-{index}")).unwrap();
                fixture.store().set(&key, &secret()).unwrap();
            });
        }
    });
    for index in 0..12 {
        let key = SecureCredentialKey::new("jira", format!("source-{index}")).unwrap();
        assert_eq!(
            fixture.store().get(&key).unwrap().expose(),
            secret().expose()
        );
    }
}

#[test]
fn maximum_size_binary_secret_round_trips() {
    let fixture = Fixture::new();
    let secret = SecureSecret::new(vec![0xff; SECRET_MAX_BYTES]).unwrap();
    fixture.store().set(&key(), &secret).unwrap();
    assert_eq!(
        fixture.store().get(&key()).unwrap().expose(),
        secret.expose()
    );
}

#[test]
fn existing_file_store_stays_selected_across_daemon_restarts() {
    let fixture = Fixture::new();
    fixture.store().set(&key(), &secret()).unwrap();
    let store = crate::PersistentSecureCredentialStore::new(&fixture.0);
    assert_eq!(store.get(&key()).unwrap().expose(), secret().expose());
    assert_eq!(store.use_files.get(), Some(&true));
}
