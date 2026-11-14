//! Keep automatic Vulkan selection out of the toolkit's external opener fallback.
use gpui::App;
use std::path::Path;

pub(crate) fn url(cx: &mut App, url: &str) {
    #[cfg(target_os = "linux")]
    if crate::child_command::automatic_vulkan() {
        if url::Url::parse(url).is_ok() {
            open(url.into());
        }
        return;
    }
    cx.open_url(url);
}

pub(crate) fn path(cx: &mut App, path: &Path) {
    #[cfg(target_os = "linux")]
    if crate::child_command::automatic_vulkan() {
        let path = if path.is_absolute() {
            path.to_owned()
        } else {
            std::env::current_dir().unwrap_or_default().join(path)
        };
        open(path.into_os_string());
        return;
    }
    cx.open_with_system(path);
}

#[cfg(target_os = "linux")]
fn open(target: std::ffi::OsString) {
    std::thread::spawn(move || {
        let _ = crate::child_command::command("xdg-open")
            .arg(target)
            .status();
    });
}
