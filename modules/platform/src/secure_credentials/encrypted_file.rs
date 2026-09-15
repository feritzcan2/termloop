use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

use cap_std::fs::{Dir, OpenOptions, OpenOptionsExt as _};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::{
    SECRET_MAX_BYTES, SecureCredentialError, SecureCredentialKey, SecureCredentialStore,
    SecureSecret,
};

#[cfg(test)]
mod tests;

const MASTER_KEY: &str = "master.key";
const HEADER: &[u8] = b"TLCR\x01";
const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const RECORD_MAX_BYTES: usize = HEADER.len() + NONCE_BYTES + SECRET_MAX_BYTES + aead::MAX_TAG_LEN;

pub(super) struct EncryptedFileCredentialStore {
    directory: PathBuf,
}

impl EncryptedFileCredentialStore {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub(super) fn selected(&self) -> bool {
        // A malformed/inaccessible existing store must fail closed, not expose
        // older credentials from a different backend.
        !matches!(fs::symlink_metadata(&self.directory), Err(error) if error.kind() == io::ErrorKind::NotFound)
    }

    fn open(&self) -> io::Result<(Dir, File)> {
        match fs::DirBuilder::new().mode(0o700).create(&self.directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let directory = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&self.directory)?;
        let metadata = directory.metadata()?;
        // SAFETY: geteuid takes no arguments and returns this process's OS uid.
        #[allow(unsafe_code)]
        let uid = unsafe { libc::geteuid() };
        if metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            return Err(invalid_store());
        }
        let directory = Dir::from_std_file(directory);
        let lock = directory
            .open_with(
                "store.lock",
                private_options().read(true).write(true).create(true),
            )?
            .into_std();
        validate_file(&lock, uid)?;
        lock.lock()?;
        Ok((directory, lock))
    }

    fn master_key(directory: &Dir, uid: u32, create: bool) -> io::Result<LessSafeKey> {
        let bytes = match read_private(directory, MASTER_KEY, KEY_BYTES, uid) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                // Never silently replace a lost key and strand existing secrets.
                for entry in directory.entries()? {
                    if entry?.file_name() != "store.lock" {
                        return Err(invalid_store());
                    }
                }
                let mut bytes = Zeroizing::new(vec![0; KEY_BYTES]);
                SystemRandom::new()
                    .fill(&mut bytes)
                    .map_err(|_| invalid_store())?;
                replace_private(directory, MASTER_KEY, &bytes)?;
                bytes
            }
            Err(_) => return Err(invalid_store()),
        };
        let key = UnboundKey::new(&aead::CHACHA20_POLY1305, &bytes).map_err(|_| invalid_store())?;
        Ok(LessSafeKey::new(key))
    }
}

impl SecureCredentialStore for EncryptedFileCredentialStore {
    fn set(
        &self,
        key: &SecureCredentialKey,
        secret: &SecureSecret,
    ) -> Result<(), SecureCredentialError> {
        let result = (|| {
            let (directory, lock) = self.open()?;
            let encryption_key = Self::master_key(&directory, lock.metadata()?.uid(), true)?;
            let name = record_name(key);
            let mut nonce = [0; NONCE_BYTES];
            SystemRandom::new()
                .fill(&mut nonce)
                .map_err(|_| invalid_store())?;
            let mut ciphertext = Zeroizing::new(secret.expose().to_vec());
            encryption_key
                .seal_in_place_append_tag(
                    Nonce::assume_unique_for_key(nonce),
                    Aad::from(name.as_bytes()),
                    &mut *ciphertext,
                )
                .map_err(|_| invalid_store())?;
            let mut record = Vec::with_capacity(HEADER.len() + NONCE_BYTES + ciphertext.len());
            record.extend_from_slice(HEADER);
            record.extend_from_slice(&nonce);
            record.extend_from_slice(&ciphertext);
            replace_private(&directory, &name, &record)
        })();
        result.map_err(|_| SecureCredentialError::Unavailable)
    }

    fn get(&self, key: &SecureCredentialKey) -> Result<SecureSecret, SecureCredentialError> {
        let (directory, lock) = self
            .open()
            .map_err(|_| SecureCredentialError::Unavailable)?;
        let uid = lock
            .metadata()
            .map_err(|_| SecureCredentialError::Unavailable)?
            .uid();
        let name = record_name(key);
        let mut record =
            read_private(&directory, &name, RECORD_MAX_BYTES, uid).map_err(map_read_error)?;
        let result = (|| {
            let encryption_key = Self::master_key(&directory, uid, false)?;
            if !record.starts_with(HEADER) || record.len() < HEADER.len() + NONCE_BYTES {
                return Err(invalid_store());
            }
            let nonce: [u8; NONCE_BYTES] = record[HEADER.len()..HEADER.len() + NONCE_BYTES]
                .try_into()
                .map_err(|_| invalid_store())?;
            let plaintext = encryption_key
                .open_in_place(
                    Nonce::assume_unique_for_key(nonce),
                    Aad::from(name.as_bytes()),
                    &mut record[HEADER.len() + NONCE_BYTES..],
                )
                .map_err(|_| invalid_store())?;
            SecureSecret::new(plaintext.to_vec()).ok_or_else(invalid_store)
        })();
        result.map_err(|_| SecureCredentialError::Unavailable)
    }

    fn delete(&self, key: &SecureCredentialKey) -> Result<(), SecureCredentialError> {
        let (directory, lock) = self
            .open()
            .map_err(|_| SecureCredentialError::Unavailable)?;
        let uid = lock
            .metadata()
            .map_err(|_| SecureCredentialError::Unavailable)?
            .uid();
        let name = record_name(key);
        read_private(&directory, &name, RECORD_MAX_BYTES, uid).map_err(map_read_error)?;
        directory
            .remove_file(name)
            .map_err(|_| SecureCredentialError::Unavailable)?;
        sync_directory(&directory).map_err(|_| SecureCredentialError::Unavailable)
    }
}

fn record_name(key: &SecureCredentialKey) -> String {
    let mut digest = Sha256::new();
    digest.update((key.service.len() as u64).to_be_bytes());
    digest.update(key.service.as_bytes());
    digest.update(key.account.as_bytes());
    format!("{:x}.secret", digest.finalize())
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options
}

fn validate_file(file: &File, uid: u32) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(invalid_store());
    }
    Ok(())
}

fn read_private(
    directory: &Dir,
    name: &str,
    max_bytes: usize,
    uid: u32,
) -> io::Result<Zeroizing<Vec<u8>>> {
    let file = directory
        .open_with(name, private_options().read(true))?
        .into_std();
    validate_file(&file, uid)?;
    if file.metadata()?.len() > max_bytes as u64 {
        return Err(invalid_store());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(max_bytes as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(invalid_store());
    }
    Ok(bytes)
}

fn replace_private(directory: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
    let temporary = format!(".write-{}", crate::generate_opaque_id());
    let mut file =
        directory.open_with(&temporary, private_options().write(true).create_new(true))?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        directory.rename(&temporary, directory, name)?;
        sync_directory(directory)
    })();
    let _ = directory.remove_file(temporary);
    result
}

fn sync_directory(directory: &Dir) -> io::Result<()> {
    directory.try_clone()?.into_std_file().sync_all()
}

fn invalid_store() -> io::Error {
    io::Error::other("private credential storage is unavailable")
}

fn map_read_error(error: io::Error) -> SecureCredentialError {
    if error.kind() == io::ErrorKind::NotFound {
        SecureCredentialError::NotFound
    } else {
        SecureCredentialError::Unavailable
    }
}
