//! The PM app's own SQLite file. It is separate from the developer daemon's
//! store: nothing here reads or writes `termloop-store` state.

mod delivery_rows;
mod migration;
mod rows;

use std::path::{Path, PathBuf};

use rusqlite::{Connection, Transaction};

pub(crate) use delivery_rows::*;
pub use migration::SCHEMA_VERSION;
pub(crate) use rows::*;

use crate::PmError;

const PM_DIRECTORY: &str = "pm";
const PM_DATABASE_FILE: &str = "pm.sqlite";

pub struct PmStore {
    connection: Connection,
    clock: fn() -> u64,
    ids: fn() -> String,
}

impl PmStore {
    /// `<state directory>/pm/pm.sqlite`, beside but apart from the developer
    /// daemon's state.
    pub fn default_path() -> Result<PathBuf, PmError> {
        Ok(termloop_platform::state_directory()?
            .join(PM_DIRECTORY)
            .join(PM_DATABASE_FILE))
    }

    /// Opens (creating when absent) the database at `path` inside a private
    /// directory, and migrates it to the current schema.
    pub fn open(path: &Path) -> Result<Self, PmError> {
        let directory = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or(PmError::Invalid("path"))?;
        if let Some(base) = directory.parent() {
            std::fs::create_dir_all(base)?;
        }
        termloop_platform::ensure_private_directory(directory)?;
        Self::from_connection(Connection::open(path)?)
    }

    /// A database that lives only as long as the store; for tests and
    /// previews.
    pub fn open_in_memory() -> Result<Self, PmError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self, PmError> {
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let mut store = Self {
            connection,
            clock: termloop_platform::current_epoch_ms,
            ids: termloop_platform::generate_uuid_v4,
        };
        migration::migrate(&mut store.connection, (store.clock)())?;
        Ok(store)
    }

    /// The newest schema version recorded in the database.
    pub fn schema_version(&self) -> Result<u32, PmError> {
        migration::applied_version(&self.connection)
    }

    pub(crate) fn connection(&self) -> &Connection {
        &self.connection
    }

    pub(crate) fn now(&self) -> u64 {
        (self.clock)()
    }

    pub(crate) fn new_id(&self) -> String {
        (self.ids)()
    }

    /// Runs one named command in a single transaction: either all of its
    /// writes commit or none do.
    pub(crate) fn write<T>(
        &mut self,
        command: impl FnOnce(&Transaction<'_>) -> Result<T, PmError>,
    ) -> Result<T, PmError> {
        let transaction = self.connection.transaction()?;
        let value = command(&transaction)?;
        transaction.commit()?;
        Ok(value)
    }

    #[cfg(test)]
    pub(crate) fn set_clock(&mut self, clock: fn() -> u64) {
        self.clock = clock;
    }

    #[cfg(test)]
    pub(crate) fn migrate_again(&mut self) -> Result<(), PmError> {
        migration::migrate(&mut self.connection, (self.clock)())
    }
}
