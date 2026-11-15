//! The saved voice settings a recording finishes with (Settings > Voice), read
//! as the desktop reads them (`src-tauri/src/stt/keys.rs`): `dictation.json`
//! is the base, and a key present in `voice-prefs.json` replaces it. Every key
//! read here is on the voice-prefs allowlist. Read at each finish, so a change
//! applies to the next recording.
use serde_json::{Map, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct VoicePrefs {
    /// Words polish spells exactly as saved.
    pub dictionary: Vec<String>,
    /// The custom polish instructions.
    pub instructions: String,
    /// Trigger and replacement pairs applied to the final text.
    pub replacements: Vec<(String, String)>,
    /// The saved microphone's unique ID; none is the system default.
    pub microphone: Option<String>,
    /// The saved recognition locale, such as `en-US`; none keeps the helper's.
    pub locale: Option<String>,
}

/// The desktop's data directory, resolved as the desktop resolves it. Never
/// resolved under test: this Mac's settings are private.
pub(crate) fn data_dir() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    dir_from(|key| std::env::var_os(key))
}

pub(super) fn dir_from(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |key| var(key).filter(|value| !value.is_empty());
    set("O8_DATA_DIR")
        .or_else(|| set("CORTEX_IDE_DATA_DIR"))
        .map(PathBuf::from)
        .or_else(|| set("HOME").map(|home| PathBuf::from(home).join(".o8")))
}

fn object(path: &Path) -> Map<String, Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

pub(crate) fn read(dir: &Path) -> VoicePrefs {
    let base = object(&dir.join("dictation.json"));
    let overlay = object(&dir.join("voice-prefs.json"));
    let value = |key: &str| {
        if overlay.contains_key(key) {
            overlay.get(key)
        } else {
            base.get(key)
        }
    };
    let dictionary = value("dictionary")
        .and_then(Value::as_array)
        .map(|words| {
            words
                .iter()
                .filter_map(Value::as_str)
                .map(|word| word.trim().to_owned())
                .filter(|word| !word.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let instructions = value("polish_instructions")
        .and_then(Value::as_str)
        .map(|text| text.trim().to_owned())
        .unwrap_or_default();
    let replacements = value("replacements")
        .and_then(Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(|rule| {
                    let trigger = rule.get("trigger")?.as_str()?.trim();
                    let replacement = rule.get("replacement")?.as_str()?;
                    (!trigger.is_empty()).then(|| (trigger.to_owned(), replacement.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    // One stdin line each; a value that could break the line is ignored.
    let line = |key: &str| {
        value(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty() && !text.chars().any(char::is_control))
            .map(str::to_owned)
    };
    VoicePrefs {
        dictionary,
        instructions,
        replacements,
        // The shell treats "default" as the system default too.
        microphone: line("dictation_microphone_uid").filter(|uid| uid != "default"),
        locale: line("dictation_locale"),
    }
}

/// The desktop's deterministic post-pass: longest trigger first, each matched
/// without regard to case.
pub(crate) fn apply_replacements(text: &str, rules: &[(String, String)]) -> String {
    let mut ordered: Vec<_> = rules.iter().collect();
    ordered.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    ordered
        .into_iter()
        .fold(text.to_owned(), |text, (trigger, replacement)| {
            replace_ignoring_case(&text, trigger, replacement)
        })
}

fn replace_ignoring_case(text: &str, pattern: &str, replacement: &str) -> String {
    let lower = text.to_lowercase();
    let pattern_lower = pattern.to_lowercase();
    // Lowercasing can change a non-ASCII string's byte length; then offsets
    // into the lowered text are not offsets into the original, so match the
    // saved case exactly instead.
    if lower.len() != text.len() || pattern_lower.len() != pattern.len() {
        return text.replace(pattern, replacement);
    }
    let mut result = String::with_capacity(text.len());
    let mut last = 0;
    for (start, _) in lower.match_indices(&pattern_lower) {
        result.push_str(&text[last..start]);
        result.push_str(replacement);
        last = start + pattern.len();
    }
    result.push_str(&text[last..]);
    result
}
