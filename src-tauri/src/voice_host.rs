//! Browser voice runtime for the native main window. Never a desktop UI.
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

pub(crate) const PATH: &str = "/voice-host";
pub(crate) const STAMP: &str = "window.__O8_VOICE_HOST__ = true;";
struct VoiceHost;

/// The host runs exactly when o8 next is the packaged app's main window.
pub(crate) fn enabled() -> bool {
    crate::next_main::enabled()
}

pub(crate) fn active<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<VoiceHost>().is_some() || enabled()
}

/// All desktop presentation/layout paths use this accessor. Voice IPC and eval
/// keep the real `main` label and its existing authorization contract.
pub(crate) fn classic_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    if active(app) {
        None
    } else {
        app.get_webview_window("main")
    }
}

pub(crate) fn state_denylist(next: bool) -> Vec<&'static str> {
    let mut labels = crate::window_state_sanitizer::DERIVED_OVERLAY_WINDOW_LABELS.to_vec();
    if next {
        labels.push("main");
    }
    labels
}

fn config(port: u16) -> tauri::utils::config::WindowConfig {
    tauri::utils::config::WindowConfig {
        label: "main".into(),
        title: "o8 voice host".into(),
        url: tauri::WebviewUrl::External(format!("http://127.0.0.1:{port}{PATH}").parse().unwrap()),
        visible: false,
        focus: false,
        focusable: false,
        skip_taskbar: true,
        width: 64.0,
        height: 64.0,
        resizable: false,
        decorations: false,
        background_throttling: Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled),
        ..Default::default()
    }
}

fn permits_navigation(expected: &tauri::Url, url: &tauri::Url) -> bool {
    expected.origin() == url.origin()
        && url.path() == PATH
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn build<R: Runtime>(app: &AppHandle<R>, port: u16) -> tauri::Result<WebviewWindow<R>> {
    let config = config(port);
    let tauri::WebviewUrl::External(expected) = config.url.clone() else {
        unreachable!()
    };
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .initialization_script(STAMP)
        .on_navigation(move |url| permits_navigation(&expected, url))
        .build()?;
    window.on_window_event(|event| {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if matches!(event, tauri::WindowEvent::Destroyed) {
            crate::stt_engine::cancel_headless_all("Voice host closed.");
        }
    });
    Ok(window)
}

pub(crate) fn start(app: AppHandle, port: u16, boot_id: String) {
    if !enabled() {
        return;
    }
    app.manage(VoiceHost);
    // Never load the packaged dashboard loader. Wait for this boot's server,
    // then create directly at the only permitted voice-host URL.
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
        while std::time::Instant::now() < deadline {
            if crate::fetch_setup_identity_with_timeout(port, 500)
                .is_some_and(|identity| identity.boot_id.as_deref() == Some(&boot_id))
            {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if handle.get_webview_window("main").is_none() {
                        if let Err(error) = build(&handle, port) {
                            log::error!("[voice-host] creation failed: {error}");
                        }
                    }
                });
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        log::error!("[voice-host] this boot's server did not become ready");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voice_host_creation_is_hidden_and_desktop_paths_cannot_find_it() {
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .unwrap();
        app.manage(VoiceHost);
        let host = build(app.handle(), 47120).unwrap();
        assert_eq!(host.label(), "main");
        assert!(
            app.get_webview_window("main").is_some(),
            "voice IPC still resolves main"
        );
        assert!(
            classic_window(app.handle()).is_none(),
            "show/focus/file/layout never resolve host"
        );
        crate::show_desktop_window(app.handle());
        assert!(classic_window(app.handle()).is_none());
        // MockRuntime reports every window visible; creation flags above/below
        // are the source-level proof. Actual invisibility is packaged acceptance.
        let config = config(47120);
        assert!(!config.visible && !config.focus && !config.focusable);
        assert!(config.skip_taskbar && !config.decorations && !config.resizable);
        assert!(state_denylist(true).contains(&"main"));
        assert!(!state_denylist(false).contains(&"main"));
    }
    #[test]
    fn only_the_original_voice_route_can_load() {
        let expected: tauri::Url = "http://127.0.0.1:47120/voice-host".parse().unwrap();
        assert!(permits_navigation(&expected, &expected));
        for url in [
            "http://127.0.0.1:47120/dashboard",
            "http://127.0.0.1:47121/voice-host",
            "http://example.test/voice-host",
            "http://127.0.0.1:47120/voice-host?next=/dashboard",
            "http://127.0.0.1:47120/voice-host#dashboard",
        ] {
            assert!(
                !permits_navigation(&expected, &url.parse().unwrap()),
                "{url}"
            );
        }
    }
    #[test]
    fn classic_window_remains_available_without_next_mode() {
        let app = tauri::test::mock_builder()
            .build(crate::app_context())
            .unwrap();
        if app.get_webview_window("main").is_none() {
            tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
                .build()
                .unwrap();
        }
        assert!(classic_window(app.handle()).is_some());
    }
}
