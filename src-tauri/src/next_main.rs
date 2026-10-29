//! o8 next is the main window of the packaged macOS app.
//!
//! The shell keeps the server, Symon, Fn dictation, the pills and the tray
//! running, but never builds the classic window and has no Dock icon of its
//! own: the o8 next process owns the Dock icon. The server opens o8 next at
//! startup (`src/lib/next/app-window.ts`) because only it holds the credential
//! the window needs. Dev builds run outside an app bundle and keep the classic
//! window.

use std::path::Path;

/// Environment variable the shell passes to the server it spawns.
pub(crate) const SERVER_ENV: &str = "O8_NEXT_MAIN_WINDOW";

pub(crate) fn enabled() -> bool {
    cfg!(target_os = "macos")
        && std::env::var_os("O8_CLASSIC_WINDOW").is_none()
        && std::env::current_exe()
            .ok()
            .and_then(|executable| executable.parent().map(packaged_next_beside))
            .unwrap_or(false)
}

/// True inside `o8.app/Contents/MacOS` when the bundle carries o8 next.
fn packaged_next_beside(directory: &Path) -> bool {
    directory.ends_with("Contents/MacOS") && directory.join("o8-next").is_file()
}

/// Bring o8 next to the front, or ask the server to open it when it is closed.
pub(crate) fn show() {
    if activate_running() {
        return;
    }
    tauri::async_runtime::spawn(async {
        // The server opens the window when this switch is set, and opening an
        // open window is a no-op.
        let body = serde_json::json!({ "experimentalNext": true });
        if let Err(error) =
            crate::agent::o8_http::post_json("/api/panel/operator-defaults", body).await
        {
            log::warn!("[next-main] could not ask the server to open o8 next: {error}");
        }
    });
}

/// Keep the classic events intact; only the packaged native main window needs
/// the server relay. The existing loopback client owns port and token resolution.
pub(crate) fn forward_ui_event(event: &str, data: serde_json::Value) {
    if !enabled() {
        return;
    }
    let Some(body) = ui_command(event, data) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::agent::o8_http::post_json("/api/next/ui-command", body).await {
            log::warn!("[next-main] could not relay UI command: {error}");
        }
    });
}

fn ui_command(event: &str, data: serde_json::Value) -> Option<serde_json::Value> {
    use serde_json::json;
    let (kind, payload) = match event {
        "o8:open-settings" => ("open-settings", data),
        "o8:managed-chat-voice-toggle" => ("voice-toggle", data),
        "o8:ui-command" => ("symon-ui", json!({ "event": event, "data": data })),
        "o8:spatial-ink-first-stroke"
        | "o8:spatial-ink-strokes"
        | "o8:spatial-ink-clear"
        | "o8:spatial-ink-disarm-request" => (
            "ink-mark",
            json!({ "event": event.strip_prefix("o8:spatial-ink-")?, "data": data }),
        ),
        _ => return None,
    };
    Some(json!({ "kind": kind, "payload": payload }))
}

#[cfg(target_os = "macos")]
fn activate_running() -> bool {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    use objc2_foundation::NSString;

    let own = std::process::id() as i32;
    crate::paste::run_on_main_thread(move || {
        // o8 next ships inside o8.app, so it shares this shell's bundle ID.
        // Tell the two apart by process and executable.
        let bundle_id = NSString::from_str(crate::paste::O8_BUNDLE_ID);
        let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&bundle_id);
        for index in 0..apps.count() {
            let app = apps.objectAtIndex(index);
            let pid = app.processIdentifier();
            if pid == own || !is_next_executable(pid) {
                continue;
            }
            let _ = app.unhide();
            if app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows) {
                return true;
            }
        }
        false
    })
}

#[cfg(not(target_os = "macos"))]
fn activate_running() -> bool {
    false
}

#[cfg(target_os = "macos")]
fn is_next_executable(pid: i32) -> bool {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return false;
    }
    Path::new(std::str::from_utf8(&buffer[..length as usize]).unwrap_or_default())
        .file_name()
        .is_some_and(|name| name == "o8-next")
}

#[cfg(test)]
mod tests {
    use super::{packaged_next_beside, ui_command};
    use serde_json::json;

    #[test]
    fn main_window_shortcuts_keep_object_payloads() {
        for (event, kind) in [
            ("o8:open-settings", "open-settings"),
            ("o8:managed-chat-voice-toggle", "voice-toggle"),
        ] {
            assert_eq!(
                ui_command(event, json!({})),
                Some(json!({ "kind": kind, "payload": {} }))
            );
        }
    }

    #[test]
    fn symon_commands_preserve_the_event_and_data() {
        for data in [
            json!({ "surface": "settings" }),
            json!({ "surface": "set", "key": "theme", "value": "light" }),
            json!({ "surface": "orchestrator_draft", "text": "draft only" }),
        ] {
            assert_eq!(
                ui_command("o8:ui-command", data.clone()),
                Some(
                    json!({ "kind": "symon-ui", "payload": { "event": "o8:ui-command", "data": data } })
                )
            );
        }
    }

    #[test]
    fn ink_commands_strip_only_the_spatial_ink_prefix() {
        for event in ["first-stroke", "strokes", "clear", "disarm-request"] {
            let data = json!({ "sessionId": "ink-session", "strokes": [[0.1, 0.2]] });
            assert_eq!(
                ui_command(&format!("o8:spatial-ink-{event}"), data.clone()),
                Some(json!({ "kind": "ink-mark", "payload": { "event": event, "data": data } }))
            );
        }
    }

    #[test]
    fn state_and_request_reply_events_are_not_ui_commands() {
        for event in [
            "o8:agent-task-event",
            "o8:agent-confirm",
            "o8:agent-confirm-dismissed",
            "o8:worker-status",
            "o8:symon-machine",
            "o8:realtime-status",
            "o8:edit-capture",
            "o8:edit-apply",
            "o8:edit-applied",
            "o8:edit-revert-settled",
            "o8:spatial-ink-unknown",
            "unknown",
        ] {
            assert_eq!(ui_command(event, json!({})), None, "{event}");
        }
    }

    #[test]
    fn only_a_bundle_that_carries_o8_next_uses_it_as_the_main_window() {
        let root = std::env::temp_dir().join(format!("o8-next-main-{}", std::process::id()));
        let bundle = root.join("o8.app/Contents/MacOS");
        let dev = root.join("target/debug");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(&dev).unwrap();

        assert!(
            !packaged_next_beside(&bundle),
            "a bundle without o8 next keeps the classic window"
        );
        std::fs::write(bundle.join("o8-next"), b"").unwrap();
        assert!(packaged_next_beside(&bundle));

        // `tauri dev` copies sidecars beside the dev binary; dev keeps the classic window.
        std::fs::write(dev.join("o8-next"), b"").unwrap();
        assert!(!packaged_next_beside(&dev));
        let _ = std::fs::remove_dir_all(&root);
    }
}
