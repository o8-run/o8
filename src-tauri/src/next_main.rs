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
    use super::packaged_next_beside;

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
