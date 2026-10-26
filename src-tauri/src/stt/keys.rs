//! API key + preference resolution for the o8 STT engine.
//!
//! This is the de-Symonized replacement for aqua's `keys.rs` /
//! `product_mode.rs` / license logic. There is NO proxy, NO license token,
//! NO product-mode gate — both resolvers read an environment variable first,
//! then fall back to macOS Keychain. Non-secret preferences live in a small JSON
//! config under `~/.o8`; legacy plaintext keys migrate on first use.
//!
//! `GEMINI_API_KEY` powers transcript polish; `OPENROUTER_API_KEY` powers the
//! optional Whisper re-transcription pass. The Tauri sidecar already forwards
//! both vars from the user's login shell into this process (see
//! `load_ai_keys_from_login_shell` in `lib.rs`), so a key in `~/.zshenv`
//! reaches a Finder-launched build without any extra config file.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

const SECRET_PREF_KEYS: [&str; 5] = [
    "gemini_api_key",
    "openrouter_api_key",
    "elevenlabs_api_key",
    "google_tts_api_key",
    "groq_api_key",
];

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "ai.o8.desktop.voice-provider-keys";

// Security.framework's documented `errSecItemNotFound` OSStatus. Keep this
// local rather than adding the low-level security-framework-sys crate solely
// for one comparison.
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
fn keychain_delete_error_is_ignorable(code: i32) -> bool {
    code == ERR_SEC_ITEM_NOT_FOUND
}

#[cfg(target_os = "macos")]
fn delete_keychain_secret(key: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, key) {
        Ok(()) => Ok(()),
        Err(error) if keychain_delete_error_is_ignorable(error.code()) => Ok(()),
        Err(error) => Err(format!("delete {key} from macOS Keychain: {error}")),
    }
}

/// Canonical o8 data dir (`~/.o8`, overridable via env). Mirrors the resolver
/// in `lib.rs` but does NOT trigger the cortex-ide → o8 migration — STT only
/// reads a single config file, so the lighter resolver keeps it dependency-free.
fn o8_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

/// Path to the optional STT config file: `~/.o8/dictation.json`.
fn config_path() -> PathBuf {
    o8_data_dir().join("dictation.json")
}

/// mtime-keyed cache of `~/.o8/dictation.json`. Unlike the old process-lifetime
/// `OnceLock`, this reloads when the file's mtime changes — so a settings write
/// (the Voice settings panel) takes effect WITHOUT an app relaunch. Reads still
/// avoid a full parse on the hot path: only a `stat()` + an mtime compare when
/// the file is unchanged.
static CONFIG_CACHE: Mutex<Option<(Option<SystemTime>, serde_json::Value)>> = Mutex::new(None);

/// Load `~/.o8/dictation.json` as a JSON value, reloading on mtime change.
fn config() -> serde_json::Value {
    let path = config_path();
    let current_mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut guard = CONFIG_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some((cached_mtime, value)) = guard.as_ref() {
        if *cached_mtime == current_mtime {
            return value.clone();
        }
    }
    let value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or(serde_json::Value::Null);
    *guard = Some((current_mtime, value.clone()));
    value
}

/// Read a string value from `~/.o8/dictation.json`, empty strings filtered out.
pub fn config_string(key: &str) -> Option<String> {
    config()
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

/// Read a numeric pref (a JSON number or a numeric string).
#[cfg(target_os = "linux")]
pub fn config_f64(key: &str) -> Option<f64> {
    config()
        .get(key)
        .and_then(|v| v.as_f64().or_else(|| v.as_str()?.trim().parse().ok()))
}

/// Read a boolean pref — accepts real JSON bools or `"true"/"1"/"yes"` strings.
/// Returns `default` when the key is absent or unparseable.
pub fn config_bool(key: &str, default: bool) -> bool {
    match config().get(key) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => default,
        },
        _ => default,
    }
}

/// Read a string-array pref (e.g. the custom dictionary). Empty when absent.
pub fn config_string_list(key: &str) -> Vec<String> {
    config()
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Snippet/phrase replacements from the Voice settings (`replacements` array of
/// `{trigger, replacement}`). Applied as a deterministic post-pass on the cleaned
/// transcript (Snippets tab). Empty triggers are dropped.
pub fn config_replacements() -> Vec<crate::stt::commands::ReplacementRule> {
    config()
        .get("replacements")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let trigger = item.get("trigger")?.as_str()?.trim().to_string();
                    let replacement = item.get("replacement")?.as_str()?.to_string();
                    if trigger.is_empty() {
                        return None;
                    }
                    Some(crate::stt::commands::ReplacementRule {
                        trigger,
                        replacement,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Test stored-key presence without decrypting values or prompting for access.
#[cfg(target_os = "macos")]
fn keychain_secret_present(key: &str) -> bool {
    #[cfg(test)]
    if std::env::var("O8_TEST_DISABLE_VOICE_PROVIDER_KEYS").as_deref() == Ok("1") {
        return std::env::var("O8_TEST_PRESENT_VOICE_PROVIDER_KEY").as_deref() == Ok(key);
    }

    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

    ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(KEYCHAIN_SERVICE)
        .account(key)
        .load_attributes(true)
        .load_data(false)
        .skip_authenticated_items(true)
        .limit(Limit::Max(1))
        .search()
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

fn redact_config(
    mut value: serde_json::Value,
    stored_presence: impl Fn(&str) -> bool,
) -> serde_json::Value {
    if !value.is_object() {
        value = serde_json::json!({});
    }
    if let Some(obj) = value.as_object_mut() {
        for secret in SECRET_PREF_KEYS {
            let legacy_present = obj
                .get(secret)
                .and_then(|v| v.as_str())
                .is_some_and(|v| !v.trim().is_empty());
            obj.insert(
                format!("{secret}_set"),
                serde_json::Value::Bool(legacy_present || stored_presence(secret)),
            );
            obj.remove(secret);
        }
    }
    value
}

/// Read public preferences without retrieving or migrating secret values.
/// Secret migration remains in the explicit provider-use path.
pub fn config_public() -> serde_json::Value {
    redact_config(config(), |key| {
        #[cfg(target_os = "macos")]
        {
            keychain_secret_present(key)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = key;
            false
        }
    })
}

/// Write a single key into `~/.o8/dictation.json` (read-modify-write, preserving
/// all other keys incl. secrets), then drop the cache so the next read reloads.
pub fn set_pref(key: &str, value: serde_json::Value) -> Result<(), String> {
    let path = config_path();
    let mut obj = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();

    if SECRET_PREF_KEYS.contains(&key) {
        let secret = value
            .as_str()
            .ok_or_else(|| format!("{key} must be a string"))?
            .trim();

        #[cfg(target_os = "macos")]
        {
            if secret.is_empty() {
                // Deleting a missing item is harmless from the caller's point
                // of view. Every other Keychain failure must stop the settings
                // write so the UI cannot claim a secret was cleared when it
                // remains in secure storage.
                delete_keychain_secret(key)?;
            } else {
                security_framework::passwords::set_generic_password(
                    KEYCHAIN_SERVICE,
                    key,
                    secret.as_bytes(),
                )
                .map_err(|e| format!("store {key} in macOS Keychain: {e}"))?;
            }
            obj.remove(key);
        }

        #[cfg(not(target_os = "macos"))]
        {
            // Cross-platform secure storage is not wired yet. Preserve current
            // behavior off macOS, but the file writer below constrains access.
            obj.insert(key.to_string(), serde_json::Value::String(secret.to_string()));
        }
    } else {
        obj.insert(key.to_string(), value);
    }
    let serialized =
        serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::fs::OpenOptionsExt;

        if path.exists() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("secure dictation.json permissions: {e}"))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("open dictation.json: {e}"))?;
        file.write_all(serialized.as_bytes())
            .map_err(|e| format!("write dictation.json: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync dictation.json: {e}"))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("secure dictation.json permissions: {e}"))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, serialized).map_err(|e| format!("write dictation.json: {e}"))?;
    if let Ok(mut guard) = CONFIG_CACHE.lock() {
        *guard = None;
    }
    Ok(())
}

/// Read a provider secret without exposing it to the webview. On macOS the
/// Keychain is authoritative. A value left by an older release is migrated on
/// first use and then removed from the JSON preferences file.
fn stored_secret(key: &str) -> Option<String> {
    #[cfg(test)]
    if std::env::var("O8_TEST_DISABLE_VOICE_PROVIDER_KEYS").as_deref() == Ok("1") {
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(raw) = security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, key) {
            if let Ok(value) = String::from_utf8(raw) {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }

        let legacy = config_string(key)?;
        if security_framework::passwords::set_generic_password(
            KEYCHAIN_SERVICE,
            key,
            legacy.as_bytes(),
        )
        .is_ok()
        {
            // Best-effort cleanup. The secret remains usable from Keychain even
            // if a damaged preferences file cannot be rewritten immediately.
            let _ = set_pref(key, serde_json::Value::String(legacy.clone()));
        }
        return Some(legacy);
    }

    #[cfg(not(target_os = "macos"))]
    {
        config_string(key)
    }
}

/// Resolve the Gemini API key. Env-first (`GEMINI_API_KEY`), then the o8
/// config file. UN-GATED — no dev gate, no product-mode check, works in
/// release.
pub fn get_gemini_key() -> Option<String> {
    std::env::var("GEMINI_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| stored_secret("gemini_api_key"))
}

/// Resolve the Groq API key (fast Whisper transcription — the latency A/B vs
/// OpenRouter). Env-first (`GROQ_API_KEY`), then the o8 config file
/// (`groq_api_key`). UN-GATED — works in release.
pub fn get_groq_key() -> Option<String> {
    std::env::var("GROQ_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| stored_secret("groq_api_key"))
}

/// The OpenRouter connection record the server writes (#3583). Holds no secret.
fn openrouter_connection_path() -> PathBuf {
    o8_data_dir().join("providers").join("openrouter.json")
}

/// False only after the operator turns the OpenRouter connection off in
/// Providers. A missing or unreadable record means on, matching the server.
pub fn openrouter_enabled() -> bool {
    openrouter_enabled_from(std::fs::read_to_string(openrouter_connection_path()).ok().as_deref())
}

fn openrouter_enabled_from(raw: Option<&str>) -> bool {
    raw.and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok())
        .and_then(|v| v.get("enabled").and_then(|e| e.as_bool()))
        .unwrap_or(true)
}

/// Resolve the OpenRouter API key. Env-first (`OPENROUTER_API_KEY`), then the
/// o8 config file. Returns None while the OpenRouter connection is turned off,
/// whatever the key's source; otherwise works in release.
pub fn get_openrouter_key() -> Option<String> {
    if !openrouter_enabled() {
        return None;
    }
    std::env::var("OPENROUTER_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| stored_secret("openrouter_api_key"))
}

/// Resolve the ElevenLabs API key for premium read-aloud / Ask voices (voice P4
/// TTS). Env-first (`ELEVENLABS_API_KEY`), then `~/.o8/dictation.json`. UN-GATED
/// — the key's PRESENCE is the de-facto premium gate (no proxy, no license).
pub fn get_elevenlabs_key() -> Option<String> {
    std::env::var("ELEVENLABS_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| stored_secret("elevenlabs_api_key"))
}

/// Resolve the Google Cloud TTS API key (voice P4 TTS, direct — no proxy).
/// Env-first (`GOOGLE_TTS_API_KEY`), then `~/.o8/dictation.json`.
pub fn get_google_tts_key() -> Option<String> {
    std::env::var("GOOGLE_TTS_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| stored_secret("google_tts_api_key"))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{keychain_delete_error_is_ignorable, redact_config, ERR_SEC_ITEM_NOT_FOUND};

    #[test]
    fn public_prefs_redact_legacy_keys_without_mutating_or_migrating_them() {
        let input = serde_json::json!({
            "gemini_api_key": " legacy-test-secret ",
            "groq_api_key": "  ",
            "tts_provider": "google",
        });
        let public = redact_config(input.clone(), |key| key == "elevenlabs_api_key");
        assert_eq!(public["gemini_api_key_set"], true);
        assert_eq!(public["groq_api_key_set"], false);
        assert_eq!(public["elevenlabs_api_key_set"], true);
        assert_eq!(public["tts_provider"], "google");
        assert!(public.get("gemini_api_key").is_none());
        assert!(public.get("groq_api_key").is_none());
        assert!(!public.to_string().contains("legacy-test-secret"));
        assert_eq!(input["gemini_api_key"], " legacy-test-secret ");
    }

    #[test]
    fn only_missing_keychain_items_are_ignored_on_delete() {
        assert!(keychain_delete_error_is_ignorable(ERR_SEC_ITEM_NOT_FOUND));
        assert!(!keychain_delete_error_is_ignorable(-25293));
        assert!(!keychain_delete_error_is_ignorable(-50));
    }
}

#[cfg(test)]
mod openrouter_connection_tests {
    use super::openrouter_enabled_from;

    #[test]
    fn only_an_explicit_off_record_disables_openrouter() {
        assert!(openrouter_enabled_from(None));
        assert!(openrouter_enabled_from(Some("not json")));
        assert!(openrouter_enabled_from(Some(r#"{"version":1}"#)));
        assert!(openrouter_enabled_from(Some(r#"{"enabled":true}"#)));
        assert!(!openrouter_enabled_from(Some(r#"{"version":1,"enabled":false}"#)));
    }
}

#[cfg(test)]
mod public_read_tests {
    use super::config_public;

    #[test]
    fn public_read_preserves_persisted_legacy_keys_and_non_secret_preferences() {
        const CHILD: &str = "O8_TEST_PUBLIC_VOICE_PREFS_CHILD";
        if std::env::var(CHILD).as_deref() == Ok("1") {
            let path = std::path::PathBuf::from(std::env::var_os("O8_DATA_DIR").unwrap())
                .join("dictation.json");
            let original = std::fs::read(&path).unwrap();
            for _ in 0..2 {
                let public = config_public();
                assert_eq!(public["gemini_api_key_set"], true);
                assert_eq!(public["groq_api_key_set"], false);
                assert_eq!(public["tts_provider"], "google");
                assert_eq!(public["language"], "en");
                assert!(!public.to_string().contains("fixture-secret"));
                assert!(public.get("gemini_api_key").is_none());
                assert!(public.get("groq_api_key").is_none());
                assert_eq!(std::fs::read(&path).unwrap(), original);
            }
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "o8-public-voice-prefs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        struct RemoveFixture(std::path::PathBuf);
        impl Drop for RemoveFixture {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let _fixture = RemoveFixture(dir.clone());
        std::fs::write(dir.join("dictation.json"),
            br#"{"gemini_api_key":" fixture-secret ","groq_api_key":"  ","tts_provider":"google","language":"en"}"#,
        ).unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("{module}::public_read_preserves_persisted_legacy_keys_and_non_secret_preferences"), "--nocapture"])
            .env(CHILD, "1")
            .env("O8_DATA_DIR", &dir)
            .env("O8_TEST_DISABLE_VOICE_PROVIDER_KEYS", "1")
            .output().unwrap();
        assert!(output.status.success(), "isolated public-read regression failed: {}{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod public_recovery_tests {
    use super::{config_public, set_pref, SECRET_PREF_KEYS};

    fn check_public_read(case: &str, contents: Option<&str>) {
        const CHILD: &str = "O8_TEST_PUBLIC_VOICE_RECOVERY_CHILD";
        if std::env::var(CHILD).as_deref() == Ok(case) {
            let path = std::path::PathBuf::from(std::env::var_os("O8_DATA_DIR").unwrap())
                .join("dictation.json");
            let original = std::fs::read(&path).ok();
            for _ in 0..2 {
                let public = config_public();
                assert!(public.is_object(), "public preferences must recover an object");
                for key in SECRET_PREF_KEYS {
                    let expected = key == "elevenlabs_api_key"
                        || (case == "object" && key == "gemini_api_key");
                    assert_eq!(public[format!("{key}_set")], expected, "{key}");
                    assert!(public.get(key).is_none());
                }
                assert!(!public.to_string().contains("fixture-secret"));
                if case == "object" {
                    assert_eq!(public["language"], "en");
                    assert_eq!(public["reading_speed"], 1.5);
                }
                assert_eq!(std::fs::read(&path).ok(), original, "read must not repair or migrate the file");
            }
            // A later non-secret preference write keeps the existing recovery contract.
            set_pref("language", serde_json::json!("fr")).unwrap();
            let public = config_public();
            assert_eq!(public["language"], "fr");
            assert_eq!(public["elevenlabs_api_key_set"], true);
            if case == "object" {
                assert_eq!(public["reading_speed"], 1.5);
                assert!(std::fs::read_to_string(&path).unwrap().contains("fixture-secret"));
                assert!(!public.to_string().contains("fixture-secret"));
            }
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "o8-public-voice-recovery-{case}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        struct RemoveFixture(std::path::PathBuf);
        impl Drop for RemoveFixture {
            fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
        }
        let _fixture = RemoveFixture(dir.clone());
        if let Some(raw) = contents {
            std::fs::write(dir.join("dictation.json"), raw).unwrap();
        }
        let module = module_path!().split_once("::").unwrap().1;
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &format!("{module}::public_read_recovers_{case}_preferences"), "--nocapture"])
            .env(CHILD, case)
            .env("O8_DATA_DIR", &dir)
            .env("O8_TEST_DISABLE_VOICE_PROVIDER_KEYS", "1")
            .env("O8_TEST_PRESENT_VOICE_PROVIDER_KEY", "elevenlabs_api_key")
            .output().unwrap();
        assert!(output.status.success(), "isolated {case} public-read regression failed: {}{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn public_read_recovers_missing_preferences() { check_public_read("missing", None); }
    #[test]
    fn public_read_recovers_malformed_preferences() { check_public_read("malformed", Some("{fixture-secret")); }
    #[test]
    fn public_read_recovers_null_preferences() { check_public_read("null", Some("null")); }
    #[test]
    fn public_read_recovers_array_preferences() { check_public_read("array", Some("[]")); }
    #[test]
    fn public_read_recovers_string_preferences() { check_public_read("string", Some(r#""fixture-secret""#)); }
    #[test]
    fn public_read_recovers_number_preferences() { check_public_read("number", Some("42")); }
    #[test]
    fn public_read_recovers_boolean_preferences() { check_public_read("boolean", Some("false")); }
    #[test]
    fn public_read_recovers_object_preferences() {
        check_public_read("object", Some(r#"{"gemini_api_key":" fixture-secret ","groq_api_key":" ","groq_api_key_set":true,"language":"en","reading_speed":1.5}"#));
    }
}
