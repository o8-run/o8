//! GPUI is the only macOS main UI, including development and missing-binary boots.
//! Windows and Linux retain the classic main window. The server owns GPUI's
//! credentials and process; the shell requests startup and presents failures.

/// Environment variable the shell passes to the server it spawns.
pub(crate) const SERVER_ENV: &str = "O8_NEXT_MAIN_WINDOW";

pub(crate) fn enabled() -> bool {
    cfg!(target_os = "macos")
}

use o8_launch_core::server_env::voice_only;

/// Suppress automatic GPUI startup in voice-only boots, including a saved opt-in.
/// The hidden voice host still runs; no classic dashboard is created.
pub(crate) fn configure_server(command: &mut std::process::Command) {
    configure_server_launch(
        command,
        enabled(),
        voice_only(std::env::var("O8_VOICE_ONLY").ok().as_deref()),
    );
}

fn configure_server_launch(command: &mut std::process::Command, native: bool, voice: bool) {
    if native && voice {
        command.env("O8_NEXT_BIN", "");
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn show(_app: &tauri::AppHandle) {}

#[cfg(target_os = "macos")]
pub(crate) fn show(app: &tauri::AppHandle) {
    if !voice_only(std::env::var("O8_VOICE_ONLY").ok().as_deref()) && !activate_running() {
        start(app.clone(), None);
    }
}

/// Wait for this boot's backend before requesting the first window. Reusing
/// the server's startup protocol makes missing binaries and pre-paint exits
/// visible without exposing its bearer or spawning a second GPUI process.
pub(crate) fn start(app: tauri::AppHandle, identity: Option<(u16, String)>) {
    if !enabled() || voice_only(std::env::var("O8_VOICE_ONLY").ok().as_deref()) {
        return;
    }
    static STARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let result = (|| {
            if let Some((port, boot_id)) = identity {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
                loop {
                    if crate::fetch_setup_identity_with_timeout(port, 500)
                        .is_some_and(|identity| identity.boot_id.as_deref() == Some(&boot_id))
                    {
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(
                            "The local server did not become ready to launch o8 next (GPUI)."
                                .into(),
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
            let port = crate::resolve_api_port();
            crate::next_main_startup::request_window(port, &crate::resolve_ws_token())
        })();
        if let Err(reason) = result {
            use tauri_plugin_dialog::DialogExt;
            let binary = std::env::current_exe()
                .unwrap_or_default()
                .with_file_name("o8-next");
            let log_path =
                std::path::PathBuf::from(crate::o8_data_dir()).join("logs/gpui-startup.log");
            crate::next_main_startup::report_failure(&binary, &log_path, &reason, |message| {
                app.dialog()
                    .message(message)
                    .title("o8 next could not start")
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                    .blocking_show();
            });
        }
        STARTING.store(false, std::sync::atomic::Ordering::SeqCst);
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

#[cfg(target_os = "macos")]
fn is_next_executable(pid: i32) -> bool {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return false;
    }
    std::path::Path::new(std::str::from_utf8(&buffer[..length as usize]).unwrap_or_default())
        .file_name()
        .is_some_and(|name| name == "o8-next")
}

#[cfg(test)]
mod tests {
    #[test]
    fn voice_only_suppresses_gpui_even_with_a_saved_opt_in() {
        for flag in [Some("1"), Some("true"), Some("TRUE")] {
            assert!(super::voice_only(flag));
        }
        assert!(!super::voice_only(None));
        assert!(!super::voice_only(Some("0")));
        let mut command = std::process::Command::new("fixture-server");
        command.env("O8_NEXT_BIN", "fixture-gpui");
        super::configure_server_launch(&mut command, true, true);
        assert_eq!(
            command
                .get_envs()
                .find(|(k, _)| *k == "O8_NEXT_BIN")
                .unwrap()
                .1
                .unwrap(),
            ""
        );
        for (native, voice) in [(false, true), (false, false), (true, false)] {
            let mut command = std::process::Command::new("fixture-server");
            command.env("O8_NEXT_BIN", "fixture-gpui");
            super::configure_server_launch(&mut command, native, voice);
            assert_eq!(
                command
                    .get_envs()
                    .find(|(k, _)| *k == "O8_NEXT_BIN")
                    .unwrap()
                    .1
                    .unwrap(),
                "fixture-gpui"
            );
        }
    }

    #[test]
    fn macos_never_falls_back_to_classic_even_without_a_binary_or_in_dev() {
        assert_eq!(super::enabled(), cfg!(target_os = "macos"));
    }

    #[test]
    fn macos_config_has_no_classic_window_and_no_dashboard_dev_url() {
        let context = crate::app_context::<tauri::test::MockRuntime>();
        if cfg!(target_os = "macos") {
            assert!(context.config().app.windows.is_empty());
            assert_eq!(
                context.config().build.dev_url.as_ref().unwrap().path(),
                "/voice-host"
            );
        } else {
            assert!(context
                .config()
                .app
                .windows
                .iter()
                .any(|window| window.label == "main"));
        }
    }
}
