//! X11 push-to-talk for Linux (#1672): hold a global chord to dictate into
//! whatever window has focus, the Linux counterpart of the macOS Fn hold in
//! `fn_hotkey.rs`. It reuses the `stt_engine` daemon (never a second
//! recognizer) and marks the session system-origin, so the shared finalize
//! chain delivers the text: o8's own composer through `system-fill` when o8
//! has focus, otherwise `xdotool type` at the focused window.
//!
//! The chord is grabbed through `tauri-plugin-global-shortcut`, which uses
//! `XGrabKey` with detectable auto-repeat, so a hold yields exactly one press
//! and one release. Wayland compositors do not allow global grabs, so the
//! chord is only registered in an X11 session.
//!
//! Prefs (`~/.o8/dictation.json`): `linux_ptt_enabled` (default true) and
//! `linux_ptt_shortcut` (default `Control+Alt+Space`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub(crate) const DEFAULT_SHORTCUT: &str = "Control+Alt+Space";

static HELD: AtomicBool = AtomicBool::new(false);
static SESSION: AtomicU64 = AtomicU64::new(0);

/// Whether this desktop session allows global key grabs: an X11 display and
/// not a Wayland session (XWayland grabs only see X11 clients). Pure for tests.
pub(crate) fn x11_session(
    session_type: Option<&str>,
    display: Option<&str>,
    wayland_display: Option<&str>,
) -> bool {
    let has = |v: Option<&str>| v.is_some_and(|s| !s.trim().is_empty());
    if session_type.is_some_and(|t| t.eq_ignore_ascii_case("wayland")) || has(wayland_display) {
        return false;
    }
    has(display)
}

fn current_x11_session() -> bool {
    let var = |k: &str| std::env::var(k).ok();
    x11_session(
        var("XDG_SESSION_TYPE").as_deref(),
        var("DISPLAY").as_deref(),
        var("WAYLAND_DISPLAY").as_deref(),
    )
}

/// The chord to grab, or `None` when push-to-talk is turned off. Pure for tests.
pub(crate) fn chord(enabled: bool, configured: Option<String>) -> Option<String> {
    if !enabled {
        return None;
    }
    Some(configured.unwrap_or_else(|| DEFAULT_SHORTCUT.to_string()))
}

/// Edge of the hold the hotkey thread hands us.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edge {
    Begin,
    End,
}

/// Press / release → begin / end, once per hold. A repeated press while held,
/// or a release with no hold, is ignored. Pure apart from the `HELD` latch.
fn edge_for(pressed: bool, held: &AtomicBool) -> Option<Edge> {
    if pressed {
        (!held.swap(true, Ordering::SeqCst)).then_some(Edge::Begin)
    } else {
        held.swap(false, Ordering::SeqCst).then_some(Edge::End)
    }
}

/// Register the push-to-talk chord. Logs and returns on any failure: a chord
/// another app owns, a Wayland session, or push-to-talk turned off.
pub(crate) fn register(app: &tauri::App) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

    let Some(chord) = chord(
        crate::stt::keys::config_bool("linux_ptt_enabled", true),
        crate::stt::keys::config_string("linux_ptt_shortcut"),
    ) else {
        log::info!("[ptt] push-to-talk disabled (linux_ptt_enabled=false)");
        return;
    };
    if !current_x11_session() {
        log::info!("[ptt] not an X11 session; global push-to-talk is unavailable");
        return;
    }
    let shortcut = match chord.parse::<Shortcut>() {
        Ok(shortcut) => shortcut,
        Err(e) => {
            log::warn!("[ptt] invalid linux_ptt_shortcut {chord:?}: {e}");
            return;
        }
    };
    let handle = app.handle().clone();
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _sc, event| {
            let Some(edge) = edge_for(event.state == ShortcutState::Pressed, &HELD) else {
                return;
            };
            // Starting the mic and stopping the session block briefly; keep them
            // off the hotkey thread.
            let app = handle.clone();
            std::thread::spawn(move || match edge {
                Edge::Begin => begin(&app),
                Edge::End => end(),
            });
        });
    match result {
        Ok(()) => log::info!("[ptt] hold {chord} to dictate (X11)"),
        Err(e) => log::warn!("[ptt] failed to register {chord}: {e}"),
    }
}

fn begin(app: &tauri::AppHandle) {
    let input = match crate::stt_engine::prepare_input() {
        Ok(input) => input,
        Err(error) => {
            HELD.store(false, Ordering::SeqCst);
            surface_error(app, &error);
            return;
        }
    };
    crate::linux_voice::stop_speaking();
    let _ = crate::audio_ducker::duck();
    crate::fn_hotkey::set_system_origin(true);
    crate::stt_engine::emit_system_stt(
        app,
        serde_json::json!({ "type": "system-start", "origin": "system", "surface": "off" }),
    );
    match crate::stt_engine::start_prepared(input, None) {
        Ok(sid) => {
            SESSION.store(sid, Ordering::SeqCst);
            log::info!("[ptt] dictation started (session={sid})");
            // Released before the mic opened: finish now.
            if !HELD.load(Ordering::SeqCst) {
                end_session(sid);
            }
        }
        Err(error) => {
            HELD.store(false, Ordering::SeqCst);
            crate::fn_hotkey::set_system_origin(false);
            surface_error(app, &error);
        }
    }
}

fn end() {
    let sid = SESSION.load(Ordering::SeqCst);
    if sid != 0 {
        end_session(sid);
    }
}

fn end_session(sid: u64) {
    if SESSION
        .compare_exchange(sid, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    crate::audio_ducker::restore();
    if let Err(e) = crate::stt_engine::stop_session(sid) {
        log::warn!("[ptt] stop failed: {e}");
    }
}

fn surface_error(app: &tauri::AppHandle, raw: &str) {
    crate::audio_ducker::restore();
    log::warn!("[ptt] dictation could not start: {raw}");
    crate::stt_engine::emit_system_stt(
        app,
        serde_json::json!({
            "type": "error",
            "origin": "system",
            "text": format!("Dictation couldn't start: {raw}"),
        }),
    );
}

/// Whether o8 owns the focused X11 window (`xdotool getactivewindow
/// getwindowpid`). False when xdotool is missing or there is no X11 session.
pub(crate) fn o8_window_focused() -> bool {
    if !current_x11_session() {
        return false;
    }
    let Some(xdotool) = o8_linux_voice::tools::find("xdotool") else {
        return false;
    };
    std::process::Command::new(xdotool)
        .args(["getactivewindow", "getwindowpid"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        == Some(std::process::id())
}

/// Type `text` into the focused X11 window with `xdotool type`. Typing rather
/// than a clipboard round-trip leaves the user's clipboard alone;
/// `--clearmodifiers` keeps a still-held push-to-talk chord out of the text.
pub(crate) fn type_text(text: &str) -> crate::paste::PasteOutcome {
    use crate::paste::PasteOutcome;
    if !current_x11_session() {
        return PasteOutcome::Failed(
            "Typing into other apps needs an X11 session on Linux.".to_string(),
        );
    }
    let Some(xdotool) = o8_linux_voice::tools::find("xdotool") else {
        return PasteOutcome::Failed(
            "Install xdotool to type dictation into other apps.".to_string(),
        );
    };
    match std::process::Command::new(xdotool)
        .args(["type", "--clearmodifiers", "--delay", "2", "--"])
        .arg(text)
        .status()
    {
        Ok(status) if status.success() => PasteOutcome::Pasted,
        Ok(status) => PasteOutcome::Failed(format!("xdotool type exited with {status}")),
        Err(e) => PasteOutcome::Failed(format!("xdotool type failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grabs_only_in_x11_sessions() {
        assert!(x11_session(Some("x11"), Some(":0"), None));
        assert!(x11_session(None, Some(":1"), None));
        assert!(!x11_session(Some("wayland"), Some(":0"), None));
        assert!(!x11_session(None, Some(":0"), Some("wayland-0")));
        assert!(!x11_session(Some("x11"), None, None));
        assert!(!x11_session(Some("tty"), Some(""), None));
    }

    #[test]
    fn chord_defaults_and_respects_the_off_switch() {
        assert_eq!(chord(true, None).as_deref(), Some(DEFAULT_SHORTCUT));
        assert_eq!(
            chord(true, Some("Super+Space".into())).as_deref(),
            Some("Super+Space")
        );
        assert_eq!(chord(false, Some("Super+Space".into())), None);
    }

    #[test]
    fn default_chord_parses() {
        assert!(DEFAULT_SHORTCUT
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
            .is_ok());
    }

    #[test]
    fn one_begin_and_one_end_per_hold() {
        let held = AtomicBool::new(false);
        assert_eq!(edge_for(false, &held), None);
        assert_eq!(edge_for(true, &held), Some(Edge::Begin));
        assert_eq!(edge_for(true, &held), None);
        assert_eq!(edge_for(false, &held), Some(Edge::End));
        assert_eq!(edge_for(false, &held), None);
        assert_eq!(edge_for(true, &held), Some(Edge::Begin));
    }
}
