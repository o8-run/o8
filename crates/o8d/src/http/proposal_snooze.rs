//! Saved snooze mutation. Admission and operation ownership belong to the caller.
//! This module is intentionally not registered until bounded dispatch is merged.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};

static WRITER: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const SNOOZE_MILLIS: i64 = 30 * 24 * 60 * 60 * 1000;

/// A persisted encoding that serde cannot retain must never be silently erased.
#[derive(Debug)]
pub enum Refusal {
    UnsupportedEncoding,
    InvalidClock,
}

pub fn trim_js(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn read_entries(file: &Path) -> Result<Vec<Value>, Refusal> {
    let Ok(bytes) = fs::read(file) else { return Ok(Vec::new()) };
    // Node readFileSync(..., 'utf8') replaces malformed UTF-8 before JSON.parse.
    let text = String::from_utf8_lossy(&bytes);
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) if error.to_string().contains("surrogate") => return Err(Refusal::UnsupportedEncoding),
        Err(_) => return Ok(Vec::new()),
    };
    if parsed.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Ok(Vec::new());
    }
    Ok(parsed.get("entries").and_then(Value::as_array).into_iter().flatten()
        .filter(|entry| ["id", "filePattern", "fixPattern", "snoozedUntil"]
            .iter().all(|field| entry.get(field).is_some_and(Value::is_string)))
        .cloned().collect())
}

fn replace(file: &Path, ledger: &Value) -> std::io::Result<()> {
    // Preserve an existing symlink's target, as the canonical TS writer does.
    let target = fs::canonicalize(file).unwrap_or_else(|_| file.to_owned());
    let parent = target.parent().ok_or_else(|| std::io::Error::other("missing ledger parent"))?;
    let temporary = parent.join(format!(".o8d-snooze-{}-{}", std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)));
    let result = (|| {
        let mut output = OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        if let Ok(metadata) = fs::metadata(&target) {
            output.set_permissions(metadata.permissions())?;
        }
        output.write_all(&serde_json::to_vec_pretty(ledger)?)?;
        output.sync_all()?;
        fs::rename(&temporary, &target)?;
        fs::File::open(parent)?.sync_all()
    })();
    // Only this operation's unique temporary file is removed.
    if temporary.exists() { let _ = fs::remove_file(&temporary); }
    result
}

/// Call only for a validated nonempty operator dismiss request. Keep one lock
/// over read/replace so concurrent native writes cannot lose each other's rows.
/// The production adapter supplies Utc::now(); fixture clocks stay in tests.
pub fn dismiss(directory: &Path, id: &str, file_pattern: &str, fix_pattern: &str,
    now_millis: i64) -> Result<Value, Refusal> {
    let until = now_millis.checked_add(SNOOZE_MILLIS)
        .and_then(DateTime::<Utc>::from_timestamp_millis).ok_or(Refusal::InvalidClock)?;
    let entry = json!({"id":id,"filePattern":file_pattern,"fixPattern":fix_pattern,
        "snoozedUntil":until.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()});
    let _guard = WRITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let file = directory.join("proposal-snooze.json");
    let mut entries = read_entries(&file)?;
    if let Some(index) = entries.iter().position(|row| row.get("id").and_then(Value::as_str) == Some(id)) {
        entries[index] = entry.clone();
    } else {
        entries.push(entry.clone());
    }
    // The existing TS writer logs write errors but still returns the entry.
    // Never delegate after beginning a write: its outcome may already exist.
    let _ = replace(&file, &json!({"version":1,"entries":entries}));
    Ok(entry)
}
