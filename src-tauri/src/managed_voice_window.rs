//! Passive presentation for the voice session owned by a chat in the main window.
//! No audio, provider credentials, task dispatch or standalone agent lives here.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU16, AtomicU64, AtomicU8, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager};

pub const LABEL: &str = "managed-chat-voice";
static API_PORT: AtomicU16 = AtomicU16::new(0);
static CAPS_STATE: AtomicU8 = AtomicU8::new(2);
static EPOCH: AtomicU64 = AtomicU64::new(0);
static OWNER: Mutex<Option<String>> = Mutex::new(None);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePresentation {
    owner: String,
    epoch: u64,
    phase: String,
    #[serde(default)]
    dismissed: bool,
    label: String,
    level: f32,
    connected_seconds: Option<f64>,
}

pub fn init(port: u16) {
    API_PORT.store(port, Ordering::Relaxed);
}

pub fn is_active() -> bool {
    OWNER.lock().map(|owner| owner.is_some()).unwrap_or(false)
}

/// Invalidate presentation on navigation, without claiming the provider closed.
pub fn reset_on_main_navigation<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut owner) = OWNER.lock() {
        *owner = None;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn managed_voice_presentation_epoch<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<u64, String> {
    if window.label() != "main" {
        return Err("Only the main chat window owns voice presentation.".into());
    }
    Ok(EPOCH.load(Ordering::SeqCst))
}

/// FlagsChanged is emitted on both Caps Lock toggles. Duplicate edges do not retoggle.
pub fn caps_lock_changed(app: &tauri::AppHandle, keycode: i64, flags: u64) {
    if caps_lock_edge(&CAPS_STATE, keycode, flags) {
        crate::next_main::forward_ui_event("o8:managed-chat-voice-toggle", serde_json::json!({}));
        let _ = app.emit_to("main", "o8:managed-chat-voice-toggle", ());
    }
}

fn caps_lock_edge(state: &AtomicU8, keycode: i64, flags: u64) -> bool {
    if keycode != 57 {
        return false;
    }
    let next = u8::from(flags & (1 << 16) != 0);
    if state.swap(next, Ordering::SeqCst) == next {
        return false;
    }
    flags & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)) == 0
}

#[tauri::command]
pub async fn managed_voice_overlay_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
    mut presentation: VoicePresentation,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main chat window owns voice presentation.".into());
    }
    if presentation.owner.is_empty()
        || presentation.owner.len() > 128
        || ![
            "connecting",
            "live",
            "closing",
            "unknown",
            "closed",
            "error",
        ]
        .contains(&presentation.phase.as_str())
    {
        return Err("Invalid voice presentation.".into());
    }
    presentation.label = presentation.label.chars().take(96).collect();
    presentation.level = if presentation.level.is_finite() {
        presentation.level.clamp(0.0, 1.0)
    } else {
        0.0
    };
    presentation.connected_seconds = presentation
        .connected_seconds
        .filter(|value| value.is_finite() && *value >= 0.0);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(update_on_main(&handle, presentation));
    })
    .map_err(|error| error.to_string())?;
    rx.await.map_err(|error| error.to_string())?
}

fn update_on_main<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    presentation: VoicePresentation,
) -> Result<(), String> {
    if presentation.epoch != EPOCH.load(Ordering::SeqCst) {
        return Ok(());
    }
    let mut owner = OWNER
        .lock()
        .map_err(|_| "Voice presentation owner unavailable.")?;
    // Capture has stopped in unknown state. Preserve that fact in the chat, not
    // as an always-on-top satellite; dismissal never claims provider closure.
    let ending = presentation.dismissed
        || ["unknown", "closed", "error"].contains(&presentation.phase.as_str());
    if owner
        .as_ref()
        .is_some_and(|current| current != &presentation.owner)
    {
        return Ok(());
    }
    // Publish even while suppressed, so restoration cannot paint an obsolete live snapshot.
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(
            LABEL,
            "o8:managed-chat-voice-presentation",
            presentation.clone(),
        );
    }
    if ending {
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.hide();
        }
        *owner = None;
        return Ok(());
    }
    *owner = Some(presentation.owner.clone());
    if crate::presentation::overlay_show_blocked() {
        return Ok(());
    }
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => create(app)?,
    };
    if !window.is_visible().unwrap_or(false) {
        position(app, &window)?;
        window.show().map_err(|error| error.to_string())?;
    }
    // Main sends a periodic snapshot, so a newly loaded webview does not need replay authority.
    app.emit_to(LABEL, "o8:managed-chat-voice-presentation", presentation)
        .map_err(|error| error.to_string())
}

fn create<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<tauri::WebviewWindow<R>, String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let port = API_PORT.load(Ordering::Relaxed);
    if port == 0 {
        return Err("Voice surface is not initialized.".into());
    }
    let base = match crate::dev_frontend::from_env() {
        Ok(Some(dev)) => dev.origin().to_string(),
        _ => format!("http://127.0.0.1:{port}"),
    };
    let url = format!("{base}/managed-chat-voice")
        .parse()
        .map_err(|_| "Invalid voice surface URL.")?;
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(url))
        .title("Chat voice")
        .inner_size(800.0, 220.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .resizable(false)
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
    Ok(window)
}

#[cfg(target_os = "macos")]
fn position<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSColor, NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let mtm = MainThreadMarker::new().ok_or("Voice geometry requires the main thread.")?;
    let main = app
        .get_webview_window("main")
        .ok_or("The owning chat window is unavailable.")?;
    // Both pointers are owned by live Tauri windows and accessed only on the main thread.
    unsafe {
        let main = &*(main.ns_window().map_err(|error| error.to_string())? as *mut NSWindow);
        let screen = main
            .screen()
            .or_else(|| NSScreen::mainScreen(mtm))
            .ok_or("No display for the chat window.")?;
        let frame = screen.frame();
        let native = &*(window.ns_window().map_err(|error| error.to_string())? as *mut NSWindow);
        native.setBackgroundColor(Some(&NSColor::clearColor()));
        native.setOpaque(false);
        native.setLevel(25);
        native.setHidesOnDeactivate(false);
        native.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::IgnoresCycle,
        );
        native.setFrame_display(
            NSRect::new(
                NSPoint::new(frame.origin.x, frame.origin.y),
                NSSize::new(frame.size.width, 220.0_f64.min(frame.size.height)),
            ),
            true,
        );
        native.orderFrontRegardless();
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn position<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .ok_or("No display for the chat window.")?;
    let height = (220.0 * monitor.scale_factor()).min(f64::from(monitor.size().height)) as u32;
    window
        .set_size(tauri::PhysicalSize::new(monitor.size().width, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y + (monitor.size().height - height) as i32,
        ))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn caps_taps_toggle_once_and_modifier_chords_do_not_activate_voice() {
        let state = AtomicU8::new(2);
        assert!(!caps_lock_edge(&state, 56, 1 << 17));
        assert!(caps_lock_edge(&state, 57, 1 << 16));
        assert!(!caps_lock_edge(&state, 57, 1 << 16));
        assert!(caps_lock_edge(&state, 57, 0));
        assert!(!caps_lock_edge(&state, 57, 0));
        assert!(!caps_lock_edge(&state, 57, (1 << 16) | (1 << 20)));
        assert!(!caps_lock_edge(&state, 57, 1 << 16));
        assert!(caps_lock_edge(&state, 57, 0));
    }
    #[test]
    fn native_ipc_rejects_foreign_callers_and_fences_reload_and_quiet_restore() {
        use crate::presentation::{apply_quiet_mode, TauriOverlays};
        use serde_json::{json, Value};
        use tauri::test::{
            get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY,
        };
        use tauri::{Listener, WebviewWindow, WebviewWindowBuilder};
        fn invoke(
            window: &WebviewWindow<MockRuntime>,
            command: &str,
            body: Value,
        ) -> Result<Value, Value> {
            get_ipc_response(
                window,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.to_string(),
                },
            )
            .map(|body| body.deserialize::<Value>().unwrap())
        }
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                managed_voice_overlay_update,
                managed_voice_presentation_epoch,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let overlay = WebviewWindowBuilder::new(&app, LABEL, Default::default())
            .visible(true)
            .build()
            .unwrap();
        let mut control = TauriOverlays { app: app.handle() };
        apply_quiet_mode(&mut control, false);
        reset_on_main_navigation(app.handle());
        let epoch = invoke(&main, "managed_voice_presentation_epoch", json!({})).unwrap();
        assert!(invoke(&overlay, "managed_voice_presentation_epoch", json!({})).is_err());
        let payload = |owner: &str, phase: &str, generation: &Value| {
            json!({ "presentation": {
                "owner": owner, "epoch": generation, "phase": phase, "label": "Fixture chat", "level": 0.4,
                "connectedSeconds": null,
            }})
        };
        assert!(invoke(
            &overlay,
            "managed_voice_overlay_update",
            payload("foreign", "live", &epoch)
        )
        .is_err());
        assert!(!is_active());
        // MockRuntime always reports visible and makes show/hide no-ops.
        // Exercise real IPC, epoch/restore guards and emitted snapshots; AppKit visibility is separate.
        overlay.show().unwrap();
        assert!(invoke(
            &main,
            "managed_voice_overlay_update",
            payload("first", "live", &epoch)
        )
        .is_ok());
        assert!(is_active());
        apply_quiet_mode(&mut control, true);
        assert!(crate::presentation::suppressed_overlay_labels().contains(&LABEL.to_string()));
        let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let received = seen.clone();
        overlay.listen("o8:managed-chat-voice-presentation", move |event| {
            received.lock().unwrap().push(event.payload().into());
        });
        assert!(invoke(
            &main,
            "managed_voice_overlay_update",
            payload("first", "closed", &epoch)
        )
        .is_ok());
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.contains("closed")));
        apply_quiet_mode(&mut control, false);
        assert!(!is_active());
        overlay.show().unwrap();
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("first", "live", &epoch),
        )
        .unwrap();
        reset_on_main_navigation(app.handle());
        assert!(!is_active());
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("first", "live", &epoch),
        )
        .unwrap();
        assert!(!is_active());
        let next = invoke(&main, "managed_voice_presentation_epoch", json!({})).unwrap();
        assert_ne!(epoch, next);
        overlay.show().unwrap();
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("second", "live", &next),
        )
        .unwrap();
        assert!(is_active());
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("second", "unknown", &next),
        )
        .unwrap();
        assert!(!is_active());
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("second", "live", &next),
        )
        .unwrap();
        let mut dismissed = payload("second", "closing", &next);
        dismissed["presentation"]["dismissed"] = json!(true);
        invoke(&main, "managed_voice_overlay_update", dismissed).unwrap();
        assert!(!is_active());
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("second", "live", &next),
        )
        .unwrap();
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("first", "closed", &epoch),
        )
        .unwrap();
        assert!(is_active());
        invoke(
            &main,
            "managed_voice_overlay_update",
            payload("second", "closed", &next),
        )
        .unwrap();
        assert!(!is_active());
    }
}
