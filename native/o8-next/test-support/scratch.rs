//! Scratch names shared by the native unit and CLI test harnesses.
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

/// A unique scratch name for each call; callers own creation and cleanup.
pub(crate) fn scratch_path(prefix: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
