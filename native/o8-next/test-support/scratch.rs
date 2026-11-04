//! Scratch names shared by the native unit and CLI test harnesses.
use std::{
    path::PathBuf,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

/// A unique scratch name for each call; callers own creation and cleanup.
/// The process id separates parallel processes, the counter separates the
/// tests of one process, and the start time separates a reused process id
/// from a stale directory an earlier run left behind.
pub(crate) fn scratch_path(prefix: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    static STARTED: OnceLock<u128> = OnceLock::new();
    let started = STARTED.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    });
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{started}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
