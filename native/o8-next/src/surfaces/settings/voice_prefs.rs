//! The voice settings o8 next may change: `voice-prefs.json` in the desktop
//! host's data directory on this Mac. The host creates it from its allowlist
//! and keeps credentials elsewhere; this never reads or writes any other
//! voice file. It never creates the file either: until the host has moved
//! the settings over, the current values aren't here to build on.
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const FILE: &str = "voice-prefs.json";

/// Voice-prefs contract v1: the only keys the host keeps from this file, read
/// from the list the host itself exports, so the two can't drift. The host is
/// the boundary; a key missing here only means a setting can't be saved.
pub(crate) fn allowlist() -> &'static [String] {
    static KEYS: OnceLock<Vec<String>> = OnceLock::new();
    KEYS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../src-tauri/src/stt/voice-prefs-allowlist.json"
        ))
        .unwrap_or_default()
    })
}

fn allowlisted(key: &str) -> bool {
    allowlist().iter().any(|allowed| allowed == key)
}

/// The host's file on this Mac. Never resolved under test.
pub(crate) fn prefs_path() -> Option<PathBuf> {
    super::voice_history::data_dir().map(|dir| dir.join(FILE))
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Prefs {
    /// The host hasn't made the file on this Mac yet.
    Missing,
    /// The file is there but isn't a JSON object; it's left as it is.
    Unreadable,
    Ready(Map<String, Value>),
}

pub(crate) fn read(path: &Path) -> Prefs {
    match std::fs::read_to_string(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Prefs::Missing,
        Err(_) => Prefs::Unreadable,
        Ok(body) => {
            let parsed: Result<Map<String, Value>, _> = serde_json::from_str(&body);
            parsed.map_or(Prefs::Unreadable, Prefs::Ready)
        }
    }
}

/// Changes one allowlisted key, computed from the file as it is now, and
/// keeps every other key exactly as the file has it. A missing or unreadable
/// file and an off-list key are left alone. Returns the file as it now stands.
pub(crate) fn update(
    path: &Path,
    key: &str,
    change: impl FnOnce(Option<&Value>) -> Value,
) -> Prefs {
    let current = read(path);
    if !allowlisted(key) {
        return current;
    }
    let Prefs::Ready(mut map) = current else {
        return current;
    };
    let value = change(map.get(key));
    map.insert(key.to_owned(), value);
    let Ok(text) = serde_json::to_string_pretty(&Value::Object(map.clone())) else {
        return read(path);
    };
    if replace(path, text.as_bytes()) {
        Prefs::Ready(map)
    } else {
        read(path)
    }
}

/// Writes a private temp file beside the target, flushes it to disk and
/// renames it into place. The name is this process's own, so it never meets
/// the host's temp file; a failed attempt leaves nothing behind.
fn replace(path: &Path, bytes: &[u8]) -> bool {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let temp = path.with_file_name(format!("{FILE}.next-{}-{nanos}.tmp", std::process::id()));
    let written = write_private(&temp, bytes).and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written.is_ok()
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// The strings in a list value, as the desktop reads `dictionary`.
pub(crate) fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The trigger and replacement pairs, as the desktop reads `replacements`.
pub(crate) fn rules(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some((
                        item.get("trigger")?.as_str()?.to_owned(),
                        item.get("replacement")?.as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn rules_value(rules: &[(String, String)]) -> Value {
    Value::Array(
        rules
            .iter()
            .map(|(trigger, replacement)| {
                serde_json::json!({"trigger": trigger, "replacement": replacement})
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("o8-voice-prefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(FILE)
    }

    #[test]
    fn the_allowlist_is_the_v1_contract() {
        assert_eq!(allowlist().len(), 33, "the host's exported list parses");
        assert!(allowlisted("dictionary") && allowlisted("polish_instructions"));
        for secret in [
            "gemini_api_key",
            "openrouter_api_key",
            "elevenlabs_api_key",
            "google_tts_api_key",
            "groq_api_key",
        ] {
            assert!(!allowlisted(secret), "{secret} must never be written here");
        }
    }

    #[test]
    fn a_missing_file_is_never_created() {
        let path = scratch("missing");
        assert_eq!(
            update(&path, "dictionary", |_| json!(["o8"])),
            Prefs::Missing
        );
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            0
        );
    }

    #[test]
    fn an_unreadable_file_and_an_off_list_key_are_left_alone() {
        let path = scratch("unreadable");
        std::fs::write(&path, "[1,2").unwrap();
        assert_eq!(
            update(&path, "dictionary", |_| json!([])),
            Prefs::Unreadable
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1,2");
        std::fs::write(&path, r#"{"dictionary":["o8"]}"#).unwrap();
        update(&path, "gemini_api_key", |_| json!("x"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"dictionary":["o8"]}"#
        );
    }

    #[test]
    fn a_write_keeps_other_keys_and_leaves_a_private_file() {
        let path = scratch("write");
        std::fs::write(
            &path,
            r#"{"sounds_enabled":false,"not_on_the_list":1,"dictionary":["a"]}"#,
        )
        .unwrap();
        let after = update(&path, "dictionary", |current| {
            let mut words = strings(current);
            words.push("b".into());
            json!(words)
        });
        let on_disk: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            on_disk,
            json!({"sounds_enabled":false,"not_on_the_list":1,"dictionary":["a","b"]})
        );
        assert_eq!(after, read(&path));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name() != FILE)
            .collect();
        assert!(leftovers.is_empty(), "no temp file stays behind");
    }

    #[test]
    fn lists_read_as_the_desktop_reads_them() {
        assert_eq!(strings(Some(&json!(["a", 1, "b"]))), ["a", "b"]);
        assert_eq!(
            rules(Some(
                &json!([{"trigger":"brb","replacement":"be right back"},{"trigger":1}])
            )),
            [("brb".to_owned(), "be right back".to_owned())]
        );
        assert!(strings(None).is_empty());
    }
}
