//! Linux voice floor (#1672): system speech and output ducking, backed by
//! `crates/o8-linux-voice`. macOS keeps its native stack (`tts/`, `stt/`,
//! `audio_ducker.rs` via osascript); nothing here is compiled there.
//!
//! - `system_tts_speak` / `system_tts_stop`: a single-flight, cancellable
//!   speech floor over piper / espeak-ng / spd-say, the Linux counterpart of
//!   `tts::native_say`. The web TTS engine uses it before WebKitGTK's
//!   speechSynthesis, which is silent on most distributions.
//! - `ducker()`: `pactl` volume ducking behind `audio_ducker::{duck, restore}`.
//!
//! Missing tools never fail the app: speak rejects with an install hint and
//! the caller falls back; ducking becomes a no-op.

use o8_linux_voice::ducker::Ducker;
use o8_linux_voice::tts::{SpeakOutcome, Speaker};
use std::sync::OnceLock;

fn speaker() -> &'static Speaker {
    static SPEAKER: OnceLock<Speaker> = OnceLock::new();
    SPEAKER.get_or_init(Speaker::default)
}

pub(crate) fn ducker() -> &'static Ducker {
    static DUCKER: OnceLock<Ducker> = OnceLock::new();
    DUCKER.get_or_init(|| Ducker::new(o8_linux_voice::tools::system_path()))
}

/// Speak `text` with the system engine and resolve when it finishes: `true`
/// when it ran to completion, `false` when `system_tts_stop` or a newer speak
/// cut it off. Rejects when no engine is installed or the engine errored.
#[tauri::command]
pub async fn system_tts_speak(text: String, speed: Option<f32>) -> Result<bool, String> {
    let speed = speed.filter(|s| s.is_finite() && *s > 0.0).unwrap_or(1.0);
    let outcome = tauri::async_runtime::spawn_blocking(move || speaker().speak(&text, speed))
        .await
        .map_err(|e| format!("system speech task failed: {e}"))??;
    match outcome {
        SpeakOutcome::Completed => Ok(true),
        SpeakOutcome::Cancelled => Ok(false),
        SpeakOutcome::Failed(reason) => Err(reason),
    }
}

/// Silence whatever `system_tts_speak` is playing. Safe when idle.
#[tauri::command]
pub fn system_tts_stop() {
    speaker().stop();
}

/// The engine `system_tts_speak` would use right now (`piper`, `espeak-ng`,
/// `spd-say`), or `None` when none is installed. For Voice settings.
#[tauri::command]
pub fn system_tts_backend() -> Option<String> {
    speaker().backend().map(|b| b.name().to_string())
}
