use std::fmt;
use zeroize::Zeroize;

const KEY_PART_MAX_BYTES: usize = 256;
const SECRET_MAX_BYTES: usize = 16 * 1024;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SecureCredentialKey {
    service: String,
    account: String,
}

impl SecureCredentialKey {
    pub fn new(service: impl Into<String>, account: impl Into<String>) -> Option<Self> {
        let value = Self {
            service: service.into(),
            account: account.into(),
        };
        (valid_key_part(&value.service) && valid_key_part(&value.account)).then_some(value)
    }
}

impl fmt::Debug for SecureCredentialKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecureCredentialKey")
            .field("service", &self.service)
            .field("account", &"<redacted>")
            .finish()
    }
}

fn valid_key_part(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= KEY_PART_MAX_BYTES
        && !value.bytes().any(|byte| byte.is_ascii_control())
}

pub struct SecureSecret(Vec<u8>);

impl SecureSecret {
    pub fn new(value: Vec<u8>) -> Option<Self> {
        (!value.is_empty() && value.len() <= SECRET_MAX_BYTES).then_some(Self(value))
    }

    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecureSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecureSecret(<redacted>)")
    }
}

impl Drop for SecureSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SecureCredentialError {
    #[error("secure credential was not found")]
    NotFound,
    #[error("native secure credential storage is unavailable")]
    Unavailable,
}

pub trait SecureCredentialStore: Send + Sync {
    fn set(
        &self,
        key: &SecureCredentialKey,
        secret: &SecureSecret,
    ) -> Result<(), SecureCredentialError>;
    fn get(&self, key: &SecureCredentialKey) -> Result<SecureSecret, SecureCredentialError>;
    fn delete(&self, key: &SecureCredentialKey) -> Result<(), SecureCredentialError>;
}

#[derive(Debug, Default)]
pub struct NativeSecureCredentialStore;

impl NativeSecureCredentialStore {
    fn entry(key: &SecureCredentialKey) -> Result<keyring::Entry, SecureCredentialError> {
        keyring::Entry::new(&key.service, &key.account)
            .map_err(|_| SecureCredentialError::Unavailable)
    }
}

impl SecureCredentialStore for NativeSecureCredentialStore {
    fn set(
        &self,
        key: &SecureCredentialKey,
        secret: &SecureSecret,
    ) -> Result<(), SecureCredentialError> {
        Self::entry(key)?
            .set_secret(secret.expose())
            .map_err(|_| SecureCredentialError::Unavailable)
    }

    fn get(&self, key: &SecureCredentialKey) -> Result<SecureSecret, SecureCredentialError> {
        let value = Self::entry(key)?.get_secret().map_err(map_keyring_error)?;
        SecureSecret::new(value).ok_or(SecureCredentialError::Unavailable)
    }

    fn delete(&self, key: &SecureCredentialKey) -> Result<(), SecureCredentialError> {
        Self::entry(key)?
            .delete_credential()
            .map_err(map_keyring_error)
    }
}

fn map_keyring_error(error: keyring::Error) -> SecureCredentialError {
    if matches!(error, keyring::Error::NoEntry) {
        SecureCredentialError::NotFound
    } else {
        SecureCredentialError::Unavailable
    }
}

#[cfg(feature = "test-support")]
pub mod test_support {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct MemorySecureCredentialStore {
        values: Mutex<HashMap<SecureCredentialKey, Vec<u8>>>,
    }

    impl SecureCredentialStore for MemorySecureCredentialStore {
        fn set(
            &self,
            key: &SecureCredentialKey,
            secret: &SecureSecret,
        ) -> Result<(), SecureCredentialError> {
            if let Some(mut previous) = self
                .values
                .lock()
                .map_err(|_| SecureCredentialError::Unavailable)?
                .insert(key.clone(), secret.expose().to_vec())
            {
                previous.zeroize();
            }
            Ok(())
        }

        fn get(&self, key: &SecureCredentialKey) -> Result<SecureSecret, SecureCredentialError> {
            let value = self
                .values
                .lock()
                .map_err(|_| SecureCredentialError::Unavailable)?
                .get(key)
                .cloned()
                .ok_or(SecureCredentialError::NotFound)?;
            SecureSecret::new(value).ok_or(SecureCredentialError::Unavailable)
        }

        fn delete(&self, key: &SecureCredentialKey) -> Result<(), SecureCredentialError> {
            let removed = self
                .values
                .lock()
                .map_err(|_| SecureCredentialError::Unavailable)?
                .remove(key);
            removed
                .map(|mut value| value.zeroize())
                .ok_or(SecureCredentialError::NotFound)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_output_is_redacted() {
        let secret = SecureSecret::new(b"top-secret".to_vec()).unwrap();
        assert_eq!(format!("{secret:?}"), "SecureSecret(<redacted>)");
        assert!(!format!("{secret:?}").contains("top-secret"));
    }

    #[test]
    fn credential_keys_are_bounded() {
        assert!(SecureCredentialKey::new("termloop", "source-1").is_some());
        assert!(SecureCredentialKey::new("termloop", "line\nbreak").is_none());
    }
}
