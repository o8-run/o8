//! Server-independent macOS dictation launch and process-held hotkey ownership.
use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Launch {
    FullApp,
    VoiceOnly { server_port: Option<u16> },
}

pub(crate) fn published_port(data_dir: &Path) -> Option<u16> {
    std::fs::read_to_string(data_dir.join("api-port"))
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
}

// This decision is consumed before the full-app boot prologue. In voice-only
// mode neither a missing server nor a mismatched version can select that boot.
pub(crate) fn inspect_launch(voice_only: bool, data_dir: &Path) -> Launch {
    if !voice_only {
        return Launch::FullApp;
    }
    let server_port = published_port(data_dir).filter(|port| {
        crate::fetch_setup_identity_with_timeout(
            *port,
            crate::DESKTOP_RECONNECT_IDENTITY_TIMEOUT_MS,
        )
        .is_some_and(|identity| identity.product.as_deref() == Some("o8"))
    });
    Launch::VoiceOnly { server_port }
}

// Per-user, rather than per-data-dir: two profiles still share one keyboard.
// Keep the inode after exit. Unlinking a flock file permits two lock owners.
pub(crate) struct HotkeyOwner {
    _file: std::fs::File,
}

impl HotkeyOwner {
    /// `wait` covers a restart: the old shell spawns its replacement before it
    /// exits, so the replacement can reach this claim while the lock is held.
    pub(crate) fn for_process(wait: std::time::Duration) -> Result<Self, String> {
        // Under the home directory, not /tmp: the system's daily temp cleaner
        // unlinks old files there, and an unlinked lock file admits a second owner.
        let home = std::env::var_os("HOME").ok_or("Cannot claim dictation hotkey: HOME is unset")?;
        let dir = Path::new(&home).join("Library/Application Support/ai.o8.desktop");
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Cannot claim dictation hotkey: {error}"))?;
        Self::acquire_within(&dir.join("dictation-hotkey.lock"), wait)
    }

    pub(crate) fn acquire_within(path: &Path, wait: std::time::Duration) -> Result<Self, String> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            match Self::acquire(path) {
                Err(error)
                    if error.contains("already owns") && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                result => return result,
            }
        }
    }

    pub(crate) fn acquire(path: &Path) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|error| format!("Cannot claim dictation hotkey: {error}"))?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            let error = std::io::Error::last_os_error();
            return Err(if error.kind() == std::io::ErrorKind::WouldBlock {
                "Another o8 shell already owns the dictation hotkey. Quit that shell before starting the full app or voice-only mode.".into()
            } else {
                format!("Cannot claim dictation hotkey: {error}")
            });
        }
        Ok(Self { _file: file })
    }
}

pub(crate) fn claim_hotkey_or_exit(wait: std::time::Duration) -> HotkeyOwner {
    HotkeyOwner::for_process(wait).unwrap_or_else(|error| {
        eprintln!("[dictation-owner] {error}");
        std::process::exit(75);
    })
}

pub(crate) fn run(server_port: Option<u16>) {
    use tauri::{Listener, Manager};
    eprintln!(
        "[voice-only] dictation only; server={server_port:?}; no server sidecars or main window"
    );
    let mut context = crate::app_context();
    crate::app_version::apply(&mut context);
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        // The overlay is bundled in Rust, so it works before any server exists.
        // It receives escaped JSON from Rust and needs no webview IPC grants.
        .register_uri_scheme_protocol("o8-voice", |_context, _request| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(include_bytes!("voice_only_overlay.html").to_vec())
                .unwrap()
        })
        .setup(|app| {
            crate::background::set_background_mode(app.handle(), true, false);
            crate::dock_window::create_voice_only(app.handle());
            let handle = app.handle().clone();
            app.listen("o8:stt-event", move |event| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    if payload["origin"] != "system" {
                        return;
                    }
                    if let Some(window) = handle.get_webview_window(crate::dock_window::DOCK_LABEL)
                    {
                        let _ = window.eval(format!("window.o8VoiceEvent?.({payload})"));
                    }
                }
            });
            let quit =
                tauri::menu::MenuItem::with_id(app, "quit", "Quit o8 Voice", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&quit])?;
            let tray = tauri::tray::TrayIconBuilder::new()
                .title("o8 Voice")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;
            crate::store_tray(tray);
            let _ = tracing_subscriber::fmt().with_env_filter("info").try_init();
            crate::stt_engine::spawn(app.handle().clone());
            crate::sound::spawn_worker();
            crate::tts::set_app_handle(app.handle().clone());
            crate::fn_hotkey::start(app.handle().clone());
            crate::mac_perms::request_mic_access_once();
            crate::mac_perms::request_apple_events_self_access_once();
            Ok(())
        })
        .build(context)
        .expect("error building o8 voice-only shell")
        .run(|_, event| {
            // A windowless resident process must survive Dock/window events.
            if let tauri::RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("o8-voice-only-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn voice_only_follows_later_published_ports_without_inherited_override() {
        const CHILD: &str = "O8_TEST_VOICE_PORT_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let dir = std::path::PathBuf::from(std::env::var_os("O8_DATA_DIR").unwrap());
            assert_eq!(crate::resolve_api_port(), 0, "no profile server yet");
            for port in [12341, 12342] {
                std::fs::write(dir.join("api-port"), port.to_string()).unwrap();
                assert_eq!(crate::resolve_api_port(), port);
            }
            return;
        }
        let dir = fixture();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "voice_only::tests::voice_only_follows_later_published_ports_without_inherited_override", "--nocapture"])
            .env(CHILD, "1").env("O8_DATA_DIR", &dir)
            .env("O8_VOICE_ONLY", "1").env("O8_API_PORT", "65534")
            .output().unwrap();
        assert!(
            child.status.success(),
            "{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_only_without_server_cannot_select_full_app_boot() {
        let dir = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        std::fs::write(
            dir.join("api-port"),
            listener.local_addr().unwrap().port().to_string(),
        )
        .unwrap();
        drop(listener);
        assert_eq!(
            inspect_launch(true, &dir),
            Launch::VoiceOnly { server_port: None }
        );
        assert_eq!(inspect_launch(false, &dir), Launch::FullApp);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn voice_only_uses_published_server_of_any_version_without_writing_ownership() {
        let dir = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let files = [
            ("api-port", port.to_string()),
            ("ws-port", "12345".into()),
            ("serve.pid", "not-a-live-pid".into()),
            ("serve-state.json", r#"{"version":"0.0.1"}"#.into()),
        ];
        for (name, contents) in &files {
            std::fs::write(dir.join(name), contents).unwrap();
        }
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let count = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count]).starts_with("GET /api/setup/identity ")
            );
            let body =
                r#"{"product":"o8","version":"0.0.1","bootId":"fixture","instanceId":"fixture"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let launch = inspect_launch(true, &dir);
        // Drop/join only after the implementation has made its probe. A red
        // assertion exits without waiting on the fixture's pending accept.
        assert_eq!(
            launch,
            Launch::VoiceOnly {
                server_port: Some(port)
            }
        );
        server.join().unwrap();
        for (name, contents) in &files {
            assert_eq!(std::fs::read_to_string(dir.join(name)).unwrap(), *contents);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), files.len());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_restarted_shell_waits_for_the_old_one_to_release_the_hotkey() {
        let dir = fixture();
        let path = dir.join("hotkey.lock");
        let old = HotkeyOwner::acquire(&path).unwrap();
        assert!(
            HotkeyOwner::acquire_within(&path, std::time::Duration::ZERO).is_err(),
            "no wait still refuses a held lock"
        );
        let exiting = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            drop(old);
        });
        HotkeyOwner::acquire_within(&path, std::time::Duration::from_secs(5))
            .expect("the replacement claims the hotkey once the old shell exits");
        exiting.join().unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn hotkey_owner_rejects_second_process_and_releases_on_exit() {
        const CHILD: &str = "O8_TEST_HOTKEY_OWNER_PATH";
        if let Some(path) = std::env::var_os(CHILD) {
            let error = HotkeyOwner::acquire(Path::new(&path))
                .err()
                .expect("second process must not own hotkey");
            assert!(
                error.contains("already owns the dictation hotkey"),
                "{error}"
            );
            return;
        }
        let dir = fixture();
        let path = dir.join("hotkey.lock");
        let owner = HotkeyOwner::acquire(&path).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "voice_only::tests::hotkey_owner_rejects_second_process_and_releases_on_exit",
                "--nocapture",
            ])
            .env(CHILD, &path)
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stdout)
        );
        drop(owner);
        let _owner = HotkeyOwner::acquire(&path)
            .expect("released lock, including a stale file, is reusable");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
