//! Background presence + autostart for the system-wide voice path (Phase 4).
//!
//! Three concerns live here so the rest of `lib.rs` stays clean:
//!
//!   1. **Activation policy** — ONE helper, `set_background_mode`, is the single
//!      place that calls `set_activation_policy`. Background mode ON → Accessory
//!      (Dock icon hidden, pure-pill); OFF → Regular (Dock icon shown, default).
//!      The toggle is persisted to `~/.o8/background_mode` and re-applied at boot.
//!      Operator decision: this is an EXPLICIT toggle only — closing the main
//!      window does NOT flip to Accessory (the `CloseRequested` handler keeps the
//!      Dock icon). Default OFF means there is never an invisible-app edge case.
//!
//!   2. **Autostart** — launch-at-login is ON by default. On first run we enable
//!      it once (guarded by the `~/.o8/autostart_initialized` marker) and then
//!      honor whatever the user toggles thereafter. Tauri commands expose
//!      enable / disable / is-enabled to the Settings surface.
//!
//!   3. **Open System Settings** — a tiny `open` shell-out so the Settings UI can
//!      jump the user to the Accessibility / Input-Monitoring / Keyboard panes
//!      when a permission needs granting.

use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

/// `~/.o8` (honoring the same overrides as `o8_data_dir` in lib.rs). Kept local
/// so this module is self-contained; falls back to `$HOME/.o8`.
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("O8_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("CORTEX_IDE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    // HOME then USERPROFILE — Windows sets only the latter; a bare
    // var("HOME") made this a relative ".o8" that hit Access-denied under
    // Program Files (#1673 VM smoke).
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .unwrap_or_default();
    PathBuf::from(home).join(".o8")
}

fn pref_path(name: &str) -> PathBuf {
    data_dir().join(name)
}

/// Read a small boolean pref file. Missing / unreadable → `default`.
fn read_bool_pref(name: &str, default: bool) -> bool {
    match std::fs::read_to_string(pref_path(name)) {
        Ok(value) => match value.trim() {
            "true" | "1" => true,
            "false" | "0" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

/// Best-effort write of a boolean pref file under `~/.o8`. Logged + ignored on
/// failure so a read-only data dir never blocks the toggle.
fn write_bool_pref(name: &str, value: bool) {
    let dir = data_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log::warn!("[background] create_dir_all {:?} failed: {}", dir, err);
        return;
    }
    if let Err(err) = std::fs::write(pref_path(name), if value { "true" } else { "false" }) {
        log::warn!("[background] write pref {} failed: {}", name, err);
    }
}

// ── Activation policy (the ONE place that touches it) ──

const BACKGROUND_MODE_PREF: &str = "background_mode";

/// Centralized activation-policy switch. `on = true` hides the Dock icon
/// (Accessory, pure-pill); `on = false` shows it (Regular, the default).
///
/// This is the ONLY function in the codebase that calls `set_activation_policy`.
/// Do NOT scatter Accessory/Regular across the close handler or tray handlers —
/// route everything through here (see the Phase 4 review MEDIUM note). `persist`
/// controls whether the new value is written to `~/.o8/background_mode`; the
/// boot-time apply passes `false` (it is reading, not changing, the pref).
pub fn set_background_mode<R: Runtime>(app: &AppHandle<R>, on: bool, persist: bool) {
    #[cfg(target_os = "macos")]
    {
        let policy = if on {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        };
        if let Err(err) = app.set_activation_policy(policy) {
            let label = if on { "Accessory" } else { "Regular" };
            log::warn!("[background] set_activation_policy({}) failed: {}", label, err);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = on;
    }

    if persist {
        write_bool_pref(BACKGROUND_MODE_PREF, on);
    }
}

/// Apply the persisted background-mode pref at boot. Default OFF (Regular / Dock
/// icon visible) — so a fresh install, or one that never touched the toggle,
/// always boots with a Dock icon. Called once from `setup()`.
pub fn apply_persisted_background_mode<R: Runtime>(app: &AppHandle<R>) {
    let on = read_bool_pref(BACKGROUND_MODE_PREF, false);
    if on {
        log::info!("[background] booting in Accessory mode (Dock icon hidden) per saved pref");
    }
    set_background_mode(app, on, false);
}

// ── Autostart (launch at login — ON by default) ──

const AUTOSTART_INIT_PREF: &str = "autostart_initialized";

/// First-run autostart bootstrap. Launch-at-login defaults ON (operator decision)
/// so the pill + Fn hotkey work without the user opening o8. We enable it exactly
/// ONCE, guarded by the `~/.o8/autostart_initialized` marker, then honor the
/// user's explicit Settings choice forever after. Called once from `setup()`.
pub fn initialize_autostart<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_autostart::ManagerExt;

    if read_bool_pref(AUTOSTART_INIT_PREF, false) {
        // Already initialized on a prior run — never re-enable over a user's
        // later "off" choice.
        return;
    }

    let mgr = app.autolaunch();
    match mgr.enable() {
        Ok(()) => {
            log::info!("[background] launch-at-login enabled (first-run default ON)");
            write_bool_pref(AUTOSTART_INIT_PREF, true);
        }
        Err(err) => {
            // Don't write the marker — retry the default-enable next launch.
            log::warn!("[background] first-run autostart enable failed: {}", err);
        }
    }
}

// ── Tauri commands (Settings surface) ──

/// Whether "Launch at login" is currently registered.
#[tauri::command]
pub fn autostart_is_enabled<R: Runtime>(app: AppHandle<R>) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Enable / disable "Launch at login". Returns the resulting state.
#[tauri::command]
pub fn autostart_set<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    // Mark initialized so the first-run default never overrides a deliberate
    // user choice made before the marker was ever written.
    write_bool_pref(AUTOSTART_INIT_PREF, true);
    Ok(enabled)
}

/// Whether background mode (Accessory / Dock icon hidden) is currently on.
#[tauri::command]
pub fn background_mode_is_enabled() -> bool {
    read_bool_pref(BACKGROUND_MODE_PREF, false)
}

/// Toggle background mode from the Settings surface. Persists + applies the new
/// activation policy through the centralized helper.
#[tauri::command]
pub fn background_mode_set<R: Runtime>(app: AppHandle<R>, enabled: bool) -> bool {
    set_background_mode(&app, enabled, true);
    enabled
}

/// Open a macOS System Settings pane by its `x-apple.systempreferences:` URL (or
/// a `com.apple.preference.*` bundle target). Used by the Voice settings section
/// to jump the user to Accessibility / Input-Monitoring / Keyboard for granting.
/// No-op (Ok) off macOS so the command signature stays stable.
#[tauri::command]
pub fn open_system_settings(target: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::child_environment::command("open")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Ok(())
    }
}
