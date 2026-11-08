//! Per-file thread summaries for the sidebar list, kept across reads while the
//! file is the same file. Mirrors `src/lib/mobile/orchestrator-thread-summary-cache.ts`:
//! the same 256-entry and 1 MiB bounds, keyed by path, size and mtime, plus the
//! device and inode. Chat history saves write a temporary file and rename it,
//! so every save is a new inode and is read again even within the same mtime
//! and size. A same-inode rewrite that keeps both size and mtime is not seen,
//! the same limit the TS cache has.
//!
//! One deliberate difference from the TS cache: eviction resists the list's
//! in-order scan. With plain LRU, a 300-conversation list evicted each entry
//! just before the next read needed it, so every read missed and the list was
//! slower than with no cache (box: 38 ms against 34 ms; 200 conversations,
//! within the bound, 6 ms against 24 ms). It changes only which summaries are
//! kept, never what a read returns.
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 1024 * 1024;

/// What the list needs from one record, before any per-request filter.
pub(super) struct Summary {
    pub(super) archived: bool,
    pub(super) bot_network: bool,
    pub(super) backend: Value,
    /// The listed thread; null for archived and network records.
    pub(super) thread: Value,
    pub(super) remote: String,
}

#[derive(PartialEq, Eq, Clone, Copy)]
struct Key {
    device: u64,
    inode: u64,
    size: u64,
    modified_ns: i128,
}

struct Entry {
    key: Key,
    summary: Arc<Summary>,
    bytes: usize,
    used: u64,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<PathBuf, Entry>,
    bytes: usize,
    clock: u64,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
#[cfg(test)]
pub(super) static PROJECTIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Marks the start of one list request.
pub(super) fn epoch() -> u64 {
    CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().map(|cache| cache.clock))
        .unwrap_or(0)
}

/// `path` must already be canonical and inside the profile directory, the same
/// boundary `Store::file` applies before it reads. A list longer than the cache
/// would evict, in order, every entry it is about to need: once the least
/// recently used entry was used by this same request (after `epoch`), a new
/// summary is not kept, so the entries already kept stay hits.
pub(super) fn read(
    path: &Path,
    epoch: u64,
    project: impl FnOnce() -> Option<Summary>,
) -> Option<Arc<Summary>> {
    let Some(key) = key(path) else {
        return project().map(Arc::new);
    };
    if let Ok(mut cache) = CACHE.lock() {
        let cache = cache.get_or_insert_with(Cache::default);
        cache.clock += 1;
        let clock = cache.clock;
        if let Some(entry) = cache.entries.get_mut(path) {
            if entry.key == key {
                entry.used = clock;
                return Some(entry.summary.clone());
            }
        }
        cache.remove(path);
    }
    #[cfg(test)]
    PROJECTIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let summary = Arc::new(project()?);
    let bytes = 2
        * (path.as_os_str().len() + summary.thread.to_string().len() + summary.remote.len())
        + 256;
    if bytes <= MAX_BYTES {
        if let Ok(mut cache) = CACHE.lock() {
            let cache = cache.get_or_insert_with(Cache::default);
            cache.remove(path);
            while cache.entries.len() >= MAX_ENTRIES || cache.bytes + bytes > MAX_BYTES {
                let Some((oldest, used)) = cache
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(path, entry)| (path.clone(), entry.used))
                else {
                    break;
                };
                if used > epoch {
                    return Some(summary);
                }
                cache.remove(&oldest);
            }
            cache.clock += 1;
            let used = cache.clock;
            cache.bytes += bytes;
            cache.entries.insert(
                path.to_owned(),
                Entry {
                    key,
                    summary: summary.clone(),
                    bytes,
                    used,
                },
            );
        }
    }
    Some(summary)
}

impl Cache {
    fn remove(&mut self, path: &Path) {
        if let Some(entry) = self.entries.remove(path) {
            self.bytes -= entry.bytes;
        }
    }
}

#[cfg(unix)]
fn key(path: &Path) -> Option<Key> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some(Key {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.size(),
        modified_ns: i128::from(metadata.mtime()) * 1_000_000_000
            + i128::from(metadata.mtime_nsec()),
    })
}

/// Without a file identity, read every time.
#[cfg(not(unix))]
fn key(_: &Path) -> Option<Key> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn a_list_longer_than_the_cache_keeps_its_first_entries_as_hits() {
        let directory =
            std::env::temp_dir().join(format!("o8d-thread-summary-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let files: Vec<PathBuf> = (0..MAX_ENTRIES + 44)
            .map(|index| {
                let path = directory.join(format!("thoughts-{index:04}.json"));
                std::fs::write(&path, format!("v1-{index}")).unwrap();
                path
            })
            .collect();
        // Each summary is the file's current contents, so a returned summary
        // shows whether it matches an uncached read of the file right now.
        let list = || {
            let epoch = epoch();
            let before = PROJECTIONS.load(Ordering::SeqCst);
            for path in &files {
                let summary = read(path, epoch, || {
                    Some(Summary {
                        archived: false,
                        bot_network: false,
                        backend: Value::Null,
                        thread: Value::String(std::fs::read_to_string(path).unwrap()),
                        remote: String::new(),
                    })
                })
                .unwrap();
                assert_eq!(
                    summary.thread,
                    Value::String(std::fs::read_to_string(path).unwrap()),
                    "{path:?}"
                );
            }
            PROJECTIONS.load(Ordering::SeqCst) - before
        };
        assert_eq!(list(), MAX_ENTRIES + 44);
        // Plain LRU would evict each entry just before the scan needs it again.
        assert_eq!(list(), 44, "only the entries past the bound are read again");

        // Saves replace a kept entry and one that was never kept: both read
        // exactly what an uncached read does.
        for index in [3, MAX_ENTRIES + 7] {
            let temporary = directory.join("save.tmp");
            std::fs::write(&temporary, format!("v2-{index}")).unwrap();
            std::fs::rename(&temporary, &files[index]).unwrap();
        }
        assert_eq!(list(), 45);
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
