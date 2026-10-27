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

use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

#[path = "linux_ptt/x11.rs"]
mod x11;

pub(crate) const DEFAULT_SHORTCUT: &str = "Control+Alt+Space";

#[derive(Default)]
struct HoldState {
    generation: u64,
    held: Option<u64>,
    session: Option<(u64, u64)>,
}

type SharedHold = Arc<Mutex<HoldState>>;

enum Work {
    Begin(u64, mpsc::Receiver<Result<(), String>>),
    End(u64),
}

fn active(state: &SharedHold, token: u64) -> bool {
    state.lock().unwrap().held == Some(token)
}

fn release(state: &SharedHold, worker: &mpsc::Sender<Work>, token: u64) {
    let mut state = state.lock().unwrap();
    if state.held == Some(token) {
        state.held = None;
        let _ = worker.send(Work::End(token));
    }
}

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
    let state = Arc::new(Mutex::new(HoldState::default()));
    let (worker, jobs) = mpsc::channel();
    let handle = app.handle().clone();
    let audio_state = state.clone();
    // One worker orders all engine effects. A slow preparation from an old
    // hold cannot start or stop the following hold's session.
    std::thread::spawn(move || {
        for job in jobs {
            match job {
                Work::Begin(token, ready) => begin(&handle, &audio_state, token, ready),
                Work::End(token) => end(&audio_state, token),
            }
        }
    });
    let cancel_state = state.clone();
    let cancel_worker = worker.clone();
    let monitor_state = state.clone();
    let monitor = x11::Monitor::new(
        shortcut,
        move |token| active(&monitor_state, token),
        move |token| release(&cancel_state, &cancel_worker, token),
    );
    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |_app, _sc, event| {
            if event.state == ShortcutState::Pressed {
                let mut hold = state.lock().unwrap();
                if hold.held.is_some() {
                    return;
                }
                hold.generation += 1;
                let token = hold.generation;
                hold.held = Some(token);
                // Arm focus/key observation before opening the microphone.
                let ready = monitor.watch(token);
                let _ = worker.send(Work::Begin(token, ready));
            } else {
                let token = state.lock().unwrap().held;
                if let Some(token) = token {
                    release(&state, &worker, token);
                }
            }
        });
    match result {
        Ok(()) => log::info!("[ptt] hold {chord} to dictate (X11)"),
        Err(e) => log::warn!("[ptt] failed to register {chord}: {e}"),
    }
}

fn begin(
    app: &tauri::AppHandle,
    state: &SharedHold,
    token: u64,
    ready: mpsc::Receiver<Result<(), String>>,
) {
    let observed = ready.recv_timeout(Duration::from_millis(500));
    if !active(state, token) {
        return;
    }
    if !matches!(observed, Ok(Ok(()))) {
        let mut hold = state.lock().unwrap();
        if hold.held == Some(token) {
            hold.held = None;
            drop(hold);
            surface_error(app, "Could not monitor the focused window and held keys.");
        }
        return;
    }
    let input = match crate::stt_engine::prepare_input() {
        Ok(input) => input,
        Err(error) => {
            let mut hold = state.lock().unwrap();
            if hold.held == Some(token) {
                hold.held = None;
                drop(hold);
                surface_error(app, &error);
            }
            return;
        }
    };
    if !active(state, token) {
        return;
    }
    crate::linux_voice::stop_speaking();
    let _ = crate::audio_ducker::duck();
    crate::fn_hotkey::set_system_origin(true);
    crate::stt_engine::emit_system_stt(
        app,
        serde_json::json!({ "type": "system-start", "origin": "system", "surface": "off" }),
    );
    match crate::stt_engine::start_prepared(input, None) {
        Ok(sid) => {
            let mut hold = state.lock().unwrap();
            if hold.held == Some(token) {
                hold.session = Some((token, sid));
            } else {
                drop(hold);
                stop(sid);
            }
        }
        Err(error) => {
            let mut hold = state.lock().unwrap();
            if hold.held == Some(token) {
                hold.held = None;
            }
            drop(hold);
            crate::fn_hotkey::set_system_origin(false);
            surface_error(app, &error);
        }
    }
}

fn end(state: &SharedHold, token: u64) {
    let mut hold = state.lock().unwrap();
    if let Some((owner, sid)) = hold.session {
        if owner == token {
            hold.session = None;
            drop(hold);
            stop(sid);
        }
    }
}

fn stop(sid: u64) {
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
}
