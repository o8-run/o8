//! Linux-only process defaults applied before GTK/WebKitGTK start.
//!
//! WebKitGTK on Wayland with the NVIDIA driver can paint a blank window or die
//! with `Error 71 (Protocol error)` because of explicit sync
//! (https://bugs.webkit.org/show_bug.cgi?id=280210,
//! https://v2.tauri.app/develop/debug/linux-graphics/). On an NVIDIA + Wayland
//! session o8 defaults `__NV_DISABLE_EXPLICIT_SYNC=1` (keeps acceleration) and
//! `WEBKIT_DISABLE_DMABUF_RENDERER=1` (the documented fallback). A value the
//! user already set, including an empty one, always wins; `O8_LINUX_GPU_DEFAULTS=0`
//! turns both defaults off.
//!
//! It also pins the GLib program name to `o8`, which GTK uses as the X11
//! WM_CLASS and the Wayland app_id when no GApplication id is set (Tauri
//! leaves `enable_gtk_app_id` off), so window rules (`class:^(o8)$` in
//! Hyprland) and `StartupWMClass=o8` match even when the binary is launched
//! through a symlink or wrapper with another name.

pub const APP_ID: &str = "o8";

/// Pure decision: which variables to set, given a lookup of the current
/// environment and whether an NVIDIA driver is loaded.
pub fn gpu_env_defaults(
    get: impl Fn(&str) -> Option<String>,
    nvidia: bool,
) -> Vec<(&'static str, &'static str)> {
    if get("O8_LINUX_GPU_DEFAULTS").as_deref() == Some("0") {
        return Vec::new();
    }
    let wayland = get("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
        || get("XDG_SESSION_TYPE").as_deref() == Some("wayland");
    if !(wayland && nvidia) {
        return Vec::new();
    }
    ["__NV_DISABLE_EXPLICIT_SYNC", "WEBKIT_DISABLE_DMABUF_RENDERER"]
        .into_iter()
        .filter(|key| get(key).is_none())
        .map(|key| (key, "1"))
        .collect()
}

fn nvidia_driver_loaded() -> bool {
    std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::path::Path::new("/sys/module/nvidia_drm").exists()
}

/// Must run first in `run()`, while the process is still single-threaded.
pub fn apply() {
    let defaults = gpu_env_defaults(|key| std::env::var(key).ok(), nvidia_driver_loaded());
    for (key, value) in defaults {
        std::env::set_var(key, value);
        eprintln!("[linux-session-env] {key}={value} (NVIDIA + Wayland default)");
    }
    glib::set_prgname(Some(APP_ID));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> =
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn nvidia_wayland_gets_both_defaults() {
        let got = gpu_env_defaults(env(&[("WAYLAND_DISPLAY", "wayland-1")]), true);
        assert_eq!(
            got,
            vec![("__NV_DISABLE_EXPLICIT_SYNC", "1"), ("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
    }

    #[test]
    fn session_type_alone_counts_as_wayland() {
        let got = gpu_env_defaults(env(&[("XDG_SESSION_TYPE", "wayland")]), true);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn user_values_win_even_when_empty() {
        let got = gpu_env_defaults(
            env(&[
                ("WAYLAND_DISPLAY", "wayland-1"),
                ("__NV_DISABLE_EXPLICIT_SYNC", "0"),
                ("WEBKIT_DISABLE_DMABUF_RENDERER", ""),
            ]),
            true,
        );
        assert!(got.is_empty());
    }

    #[test]
    fn no_defaults_off_nvidia_or_off_wayland_or_opted_out() {
        assert!(gpu_env_defaults(env(&[("WAYLAND_DISPLAY", "wayland-1")]), false).is_empty());
        assert!(gpu_env_defaults(env(&[("DISPLAY", ":0"), ("XDG_SESSION_TYPE", "x11")]), true).is_empty());
        assert!(gpu_env_defaults(
            env(&[("WAYLAND_DISPLAY", "wayland-1"), ("O8_LINUX_GPU_DEFAULTS", "0")]),
            true
        )
        .is_empty());
    }
}
