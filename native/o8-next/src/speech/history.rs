//! Voice History for in-process dictation. The desktop shell appends every
//! finished dictation to `dictation-history.json` in its data directory
//! (`src-tauri/src/dictation_history.rs`), and Settings > Voice > History
//! (`surfaces/settings/voice_history.rs`) lists that file. Each composer
//! dictation that goes out is appended here in the same format.
use serde_json::{Value, json};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const FILE: &str = "dictation-history.json";
/// The shell's cap; the oldest entries go first.
const MAX_ENTRIES: usize = 200;
/// The app the shell records for a dictation into o8's own window.
const APP: &str = "ai.o8.desktop";

/// Appends `text` as a dictation. Entries already in the file are kept as
/// they are, unknown fields included. A file that is not a JSON array is left
/// alone rather than replaced. The write is a temp file renamed into place,
/// under a name neither the shell's nor the settings panel's writer uses.
pub(super) fn record(dir: &Path, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let path = dir.join(FILE);
    let mut entries = match std::fs::read_to_string(&path) {
        Ok(body) => match serde_json::from_str::<Vec<Value>>(&body) {
            Ok(entries) => entries,
            Err(_) => return,
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return,
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    entries.push(json!({
        "id": now.as_nanos().to_string(),
        "ts": now.as_secs() as i64,
        "mode": "dictation",
        "text": text,
        "app": APP,
    }));
    let excess = entries.len().saturating_sub(MAX_ENTRIES);
    entries.drain(..excess);
    let Ok(body) = serde_json::to_string_pretty(&entries) else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let temp = dir.join(format!(
        "{FILE}.speech-{}-{}.tmp",
        std::process::id(),
        now.as_nanos()
    ));
    if std::fs::write(&temp, body).is_err() || std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&temp);
    }
}
