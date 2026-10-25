//! Native text-to-speech engine (voice P4), ported from aqua/Symon `tts/` and
//! de-Symonized: DIRECT API keys only (no proxy / license / product-mode), the
//! dead Edge + Native(AVSpeechSynthesizer) providers omitted, errors are
//! `String`. Two real providers — ElevenLabs (premium, key-gated) and Google
//! (direct) — with the macOS `say` binary as the runtime fallback.
//!
//! Playback runs on a dedicated OS thread (see `playback` — the `!Send` rodio
//! constraint), so o8 can speak with no focused webview.

pub mod edge_local;
mod edge_voice_error;
mod elevenlabs;
pub mod google;
pub mod native_say;
pub mod playback;

use std::sync::OnceLock;

/// App handle stored at setup() so the off-thread playback can morph the screen
/// dock while TTS plays (so it shows activity instead of sitting idle).
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Store the app handle once (called from setup, after the dock window exists).
pub fn set_app_handle(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// The stored app handle, if setup has run. Used by `playback` to emit
/// `o8:tts-state` for the play/stop control surfaces.
pub(crate) fn app_handle() -> Option<&'static tauri::AppHandle> {
    APP_HANDLE.get()
}

/// Shipping providers. `EdgeFree` (the free neural male Steffan voice) is the
/// DEFAULT for every keyless user; ElevenLabs / Google are the key-gated
/// upgrades. `say` is the always-works floor, not a provider.
pub enum TtsProvider {
    ElevenLabs,
    Google,
    /// Free neural male voice (edge-tts en-US-SteffanNeural) via the bundled
    /// server's /api/tts — no key, works out of the box. The product's voice.
    EdgeFree,
}

pub struct TtsConfig {
    pub provider: TtsProvider,
    pub voice_id: String,
    pub speed: f32,
    pub pitch: f32,
}

/// Resolve the active TTS config from prefs (`~/.o8/dictation.json`) + env.
///
/// The free neural male Steffan voice is the DEFAULT for everyone (Q ruling
/// 2026-07-15). A premium provider is chosen ONLY when the user explicitly
/// selected it AND its key resolves — the key is the upgrade gate. Everything
/// else (unset, or a premium provider chosen without a key) uses `EdgeFree`, so
/// Symon and every "play" button speak in the product's voice out of the box,
/// with zero config, instead of the OS system voice.
pub fn load_config() -> TtsConfig {
    let provider = match crate::stt::keys::config_string("tts_provider").as_deref() {
        Some("elevenlabs") if crate::stt::keys::get_elevenlabs_key().is_some() => {
            TtsProvider::ElevenLabs
        }
        Some("google") if crate::stt::keys::get_google_tts_key().is_some() => TtsProvider::Google,
        _ => TtsProvider::EdgeFree,
    };

    let voice_id = match provider {
        // ElevenLabs always uses its own voice id (not the Google reading voice).
        TtsProvider::ElevenLabs => elevenlabs::configured_voice_id(),
        TtsProvider::Google => crate::stt::keys::config_string("tts_voice_id")
            .unwrap_or_else(|| "en-US-Neural2-J".to_string()),
        // edge_local hardcodes the Steffan voice; this is for logging/parity.
        TtsProvider::EdgeFree => "en-US-SteffanNeural".to_string(),
    };

    let speed = crate::stt::keys::config_string("reading_speed")
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(1.0);

    TtsConfig {
        provider,
        voice_id,
        speed,
        pitch: 0.0,
    }
}

/// Synthesize `text` → MP3 bytes via the configured provider. Errors are
/// `String`; the `playback` layer falls back to `say` on error.
pub async fn speak(text: &str, config: &TtsConfig) -> Result<Vec<u8>, String> {
    let primary = match config.provider {
        TtsProvider::ElevenLabs => elevenlabs::synthesize(text, config).await,
        TtsProvider::Google => google::synthesize(text, config).await,
        TtsProvider::EdgeFree => edge_local::synthesize(text).await,
    };
    match primary {
        Ok(bytes) => Ok(bytes),
        Err(primary_err) => {
            // EdgeFree already IS the free Steffan voice — don't retry it; let
            // the playback layer's `say` floor take over. A premium provider that
            // failed falls to Steffan first, then `say`. A keyless machine
            // previously defaulted to Google (key-gated), failed, and only THEN
            // reached Steffan — now EdgeFree is primary, so the common path has
            // no failing cloud round-trip.
            if matches!(config.provider, TtsProvider::EdgeFree) {
                // Ring-buffer breadcrumb: this fall to the `say` floor is the
                // "wrong voice" class (report S9KT8H heard Fred with zero
                // forensics — the TTS ladder only logged to the sidecar).
                // record_console_error puts WHY in the next bug report.
                crate::record_console_error(
                    format!("[tts] Steffan (edge) failed, falling to macOS say: {primary_err}"),
                    "rust-tts".to_string(),
                    0,
                );
                return Err(primary_err);
            }
            match edge_local::synthesize(text).await {
                Ok(bytes) => {
                    log::info!(
                        "[tts] cloud synth unavailable ({primary_err}); using local Steffan voice"
                    );
                    Ok(bytes)
                }
                Err(local_err) => {
                    crate::record_console_error(
                        format!("[tts] Steffan (edge) failed, falling to macOS say: {local_err}"),
                        "rust-tts".to_string(),
                        0,
                    );
                    Err(format!("{primary_err}; edge-local: {local_err}"))
                }
            }
        }
    }
}
