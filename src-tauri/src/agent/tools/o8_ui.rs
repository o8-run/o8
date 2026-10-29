//! Symon drives o8's own UI — the o8-control frontier v1.
//!
//! "Open my settings", "show the mobile QR code", "open the browser to
//! anthropic.com": the spoken verb maps to a surface of the o8 window itself.
//! Implementation is a thin event bridge — `o8_ui_open` emits `o8:ui-command`
//! to the MAIN webview, where a dashboard-level listener routes to the same
//! handlers the buttons use (settings overlay, right-panel tabs, mobile
//! pairing canvas tab, browser pane). Nothing here mutates state directly;
//! ReadOnly in `safety` for the same reason `open_app` is — showing a surface
//! has no destructive side effect.

use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// Surfaces the dashboard listener understands. `voice_settings` short-circuits
/// to the native standalone window (it must work even with the main window
/// closed — same path as the dock double-tap).
const SURFACES: &[&str] = &[
    "settings",
    "voice_settings",
    "mobile_qr",
    "automations",
    "browser",
    "inbox",
    "prs",
    "activity",
    "review",
    "o8md",
    "workspace",
    "files",
    "terminal",
];

pub fn open(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let surface = args
        .get("surface")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !SURFACES.contains(&surface.as_str()) {
        return Err(format!(
            "I can't open '{surface}' — the o8 surfaces I know are: {}.",
            SURFACES.join(", ")
        ));
    }

    #[cfg(target_os = "macos")]
    if surface == "voice_settings" {
        crate::open_voice_settings(app.clone());
        return Ok(json!({ "opened": "voice_settings" }));
    }

    // A spoken "open …" implies "show me" — surface the main window first so
    // the change is visible even when o8 was hidden to the tray.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }

    let mut payload = json!({ "surface": surface });
    if let Some(url) = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        payload["url"] = json!(normalize_url(url));
    }
    emit_ui_command(app, payload);
    log::info!("[symon-o8ui] open {surface}");
    Ok(json!({ "opened": surface }))
}

/// The o8 UI preferences Symon can FLIP (not just reveal) and their allowed
/// values. Each maps to the SAME setter the Settings control calls — the
/// dashboard `o8:ui-command` listener routes `theme`/`surface` to ThemeProvider
/// and `canvas_mode` to the `experimentalCanvas` operator default.
fn allowed_values(key: &str) -> Option<&'static [&'static str]> {
    match key {
        "theme" => Some(&["dark", "light"]),
        "surface" => Some(&["glass", "solid"]),
        "canvas_mode" => Some(&["on", "off"]),
        _ => None,
    }
}

/// `o8_ui_set` — change an o8 UI preference by voice ("switch to dark mode",
/// "make it solid", "turn on canvas mode"). Emits `o8:ui-command` with
/// `{ surface: "set", key, value }`; the dashboard listener flips the same
/// control the operator would toggle in Settings. ReadOnly in `safety` — a
/// preference flip is reversible and non-destructive (same rationale as `open`).
pub fn set_setting(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let value = args
        .get("value")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let Some(allowed) = allowed_values(&key) else {
        return Err(
            "I can't set that — the o8 preferences I can change are: theme, surface, canvas_mode."
                .to_string(),
        );
    };
    if !allowed.contains(&value.as_str()) {
        return Err(format!(
            "'{value}' isn't a valid {key} — try one of: {}.",
            allowed.join(", ")
        ));
    }

    // A spoken "switch to …" implies "show me" — bring the window forward so the
    // change is visible, same as `open`.
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }

    emit_ui_command(app, json!({ "surface": "set", "key": key, "value": value }));
    log::info!("[symon-o8ui] set {key}={value}");
    Ok(json!({ "set": key, "value": value }))
}

/// `o8_orchestrator_draft` — drop a spoken message into the orchestrator
/// composer as a DRAFT. Never sends: the user reviews and presses Enter, so
/// this stays ReadOnly — the draft IS the governance (same contract as the
/// resolve-blocker pill).
pub fn orchestrator_draft(app: &tauri::AppHandle, args: Value) -> Result<Value, String> {
    let message = args
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if message.is_empty() {
        return Err("o8_orchestrator_draft needs a 'message'".into());
    }
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    emit_ui_command(
        app,
        json!({ "surface": "orchestrator_draft", "text": message }),
    );
    log::info!("[symon-o8ui] orchestrator draft ({} chars)", message.len());
    Ok(json!({ "drafted": true, "note": "The message is in the orchestrator composer — the user sends it." }))
}

fn emit_ui_command(app: &tauri::AppHandle, payload: Value) {
    crate::next_main::forward_ui_event("o8:ui-command", payload.clone());
    let _ = app.emit_to("main", "o8:ui-command", payload);
}

/// Spoken URLs arrive bare ("anthropic.com") — give them a scheme.
fn normalize_url(u: &str) -> String {
    if u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else {
        format!("https://{u}")
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed_values, normalize_url};

    #[test]
    fn bare_hosts_get_https() {
        assert_eq!(normalize_url("anthropic.com"), "https://anthropic.com");
        assert_eq!(normalize_url("http://localhost:3001"), "http://localhost:3001");
        assert_eq!(normalize_url("https://o8.run"), "https://o8.run");
    }

    #[test]
    fn settable_keys_have_value_allowlists() {
        assert_eq!(allowed_values("theme"), Some(&["dark", "light"][..]));
        assert_eq!(allowed_values("surface"), Some(&["glass", "solid"][..]));
        assert_eq!(allowed_values("canvas_mode"), Some(&["on", "off"][..]));
        assert_eq!(allowed_values("nonsense"), None);
    }
}
