//! System-wide audio ducking for voice dictation (Symon parity, #1207).
//!
//! When the user holds Fn (or Right-Option for Ask) to dictate, lower macOS's
//! system output volume so the microphone can hear over whatever's playing —
//! crucially, over o8's OWN TTS when the user wants to talk back while it's
//! still speaking. Restore the original level when the dictation ends.
//!
//! Uses `osascript` to drive the system volume. Core Audio would be cleaner but
//! pulls in an FFI dependency for what is a 2-line shell-out. Ported from
//! aqua/Symon `audio_ducker.rs`.
//!
//! On Linux the same API ducks the default sink through `pactl` (PipeWire or
//! PulseAudio; see `o8_linux_voice::ducker`), and is a no-op without `pactl`.

use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::Duration;

/// The lower bound we clamp the system volume to while dictating, as a fraction
/// of the user's pre-duck volume.
const DUCK_SCALAR: f32 = 0.20;

/// Remembers the volume in place *before* we started ducking. None = not
/// currently ducked. Only the first duck call stores a value; repeated duck
/// calls are no-ops so we never overwrite the baseline with the already-ducked
/// reading.
static SAVED_VOLUME: Mutex<Option<u32>> = Mutex::new(None);

/// Read the current macOS output volume as an integer 0-100.
#[cfg(target_os = "macos")]
fn read_output_volume() -> Option<u32> {
    let out = std::process::Command::new("osascript")
        .args(["-e", "output volume of (get volume settings)"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim().parse::<u32>().ok()
}

/// Set the macOS output volume. Clamped to 0-100.
#[cfg(target_os = "macos")]
fn set_output_volume(v: u32) {
    let clamped = v.min(100);
    let cmd = format!("set volume output volume {clamped}");
    let _ = std::process::Command::new("osascript")
        .args(["-e", &cmd])
        .output();
}

/// Handle returned by [`duck`] that lets a caller wait for the first
/// volume-set to actually land before opening the mic. Dropping it without
/// waiting keeps the old fire-and-forget behavior.
pub struct DuckHandle {
    done: Receiver<()>,
}

impl DuckHandle {
    /// Block until the duck's first volume-set completes, capped at `max` so a
    /// slow `osascript` can never delay dictation start noticeably. Safe only
    /// from a worker thread — never the CGEvent tap callback. Returns whether
    /// the set landed within the cap (`false` = timed out; the duck may still
    /// complete a beat later, which is harmless).
    pub fn wait(self, max: Duration) -> bool {
        self.done.recv_timeout(max).is_ok()
    }
}

/// Lower the system volume so dictation audio is clearer. Safe to call
/// repeatedly; only the first call since the last `restore()` takes effect.
///
/// Runs the two `osascript` shell-outs (each hundreds of ms: process spawn +
/// AppleScript compile + IPC to the volume server) on a detached thread so the
/// Fn press path never blocks. The returned [`DuckHandle`] signals when the
/// first volume-set has landed — `begin_system_dictation` waits on it (bounded)
/// so playing audio can't bleed into the start of the message before the mic
/// opens (#1544). Callers that don't need the ordering just drop the handle.
#[must_use = "drop the DuckHandle to keep fire-and-forget ducking, or call wait() to gate on it"]
pub fn duck() -> DuckHandle {
    let (tx, rx) = channel::<()>();
    #[cfg(target_os = "macos")]
    {
        // Gated by the `ducking_enabled` voice pref (default on). When off,
        // signal immediately so a waiter doesn't sit out the full cap.
        if !crate::stt::keys::config_bool("ducking_enabled", true) {
            let _ = tx.send(());
            return DuckHandle { done: rx };
        }
        std::thread::spawn(move || {
            // Signal on EVERY exit path (early returns included) so a waiter is
            // never stranded for the full cap when there's nothing to duck.
            let _guard = SendOnDrop(Some(tx));
            let mut saved = match SAVED_VOLUME.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if saved.is_some() {
                return; // already ducked
            }
            let Some(current) = read_output_volume() else {
                return;
            };
            // If the system is already silent, nothing to duck — don't save a
            // zero that would prevent future restores from ever raising it back.
            if current == 0 {
                return;
            }
            let target = (current as f32 * DUCK_SCALAR).round() as u32;
            set_output_volume(target);
            *saved = Some(current);
        });
    }
    #[cfg(target_os = "linux")]
    {
        if !o8_linux_voice::ducker::voice_pref_bool("ducking_enabled", true) {
            let _ = tx.send(());
            return DuckHandle { done: rx };
        }
        std::thread::spawn(move || {
            let _guard = SendOnDrop(Some(tx));
            crate::linux_voice::ducker().duck();
        });
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = tx.send(());
    }
    DuckHandle { done: rx }
}

/// Fires its channel on drop so the duck worker signals completion no matter
/// which early return it takes.
#[cfg(any(target_os = "macos", target_os = "linux"))]
struct SendOnDrop(Option<std::sync::mpsc::Sender<()>>);

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl Drop for SendOnDrop {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

/// Restore the system volume to whatever it was before `duck()`. Safe to call
/// when nothing is ducked — a no-op in that case. Idempotent, so it can be
/// sprinkled on every dictation teardown path without double-restoring.
pub fn restore() {
    #[cfg(target_os = "macos")]
    std::thread::spawn(|| {
        let original = {
            let mut guard = match SAVED_VOLUME.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            guard.take()
        };
        let Some(original) = original else {
            return;
        };
        set_output_volume(original);
    });
    #[cfg(target_os = "linux")]
    std::thread::spawn(|| {
        crate::linux_voice::ducker().restore();
    });
}
