//! A lazy, read-only SQLite connection owned by one synchronous HTTP read.
use super::Store;
use rusqlite::Connection;
use std::{cell::OnceCell, ops::Deref};

pub(super) struct ReadContext<'a> {
    store: &'a Store,
    database: OnceCell<Result<Connection, ()>>,
}

impl<'a> ReadContext<'a> {
    pub(super) fn new(store: &'a Store) -> Self {
        Self {
            store,
            database: OnceCell::new(),
        }
    }

    pub(super) fn database(&self) -> Result<&Connection, ()> {
        // The existing Store opener retains profile checks, READ_ONLY flags and
        // the busy timeout. Reuse only inside this request, including preflight.
        // A new context retries failures and observes WAL commits/replacements.
        self.database
            .get_or_init(|| self.store.database())
            .as_ref()
            .map_err(|_| ())
    }
}

impl Deref for ReadContext<'_> {
    type Target = Store;

    fn deref(&self) -> &Self::Target {
        self.store
    }
}
