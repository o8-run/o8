#[cfg(target_os = "macos")]
mod agent;
#[cfg(target_os = "macos")]
mod ai;
mod agent_partials_window;
mod spatial_ink_window;
#[cfg(target_os = "macos")]
mod visual_capture;
#[cfg(target_os = "macos")]
mod visual_capture_session;
#[cfg(target_os = "macos")]
mod visual_capture_snapshot;
#[cfg(target_os = "macos")]
mod visual_capture_input;
#[cfg(target_os = "macos")]
mod visual_capture_media;
#[cfg(any(target_os = "macos", test))]
mod visual_capture_packet;
mod audio_ducker;
mod background;
mod browser_view;
mod remote_preview;
mod restart_job_drain;
mod cli_locate;
mod dev_frontend;
mod desktop_close;
mod desktop_attach_retry;
mod desktop_attach_owner;
mod dictation_history;
mod dock_window;
#[cfg(target_os = "macos")]
mod first_run_install;
mod fn_hotkey;
mod voice_surfaces;
mod voice_input;
mod managed_voice_window;
mod launch_updater;
mod update_ping;
#[cfg(target_os = "linux")]
mod linux_ptt;
#[cfg(target_os = "linux")]
mod linux_voice;
#[cfg(target_os = "macos")]
mod live_dictation;
// Live caret streaming drives the macOS Accessibility API. Linux keeps the
// same call sites in `stt_engine` behind inert stand-ins.
#[cfg(target_os = "linux")]
#[path = "live_dictation_linux.rs"]
mod live_dictation;
#[cfg(target_os = "macos")]
mod macos_webview_scale;
mod mac_perms;
mod models;
// Child processes must not open console windows on Windows — a console the
// user can click into suspends the process (see the module doc).
mod no_window;
mod native_test_instance;
mod overlay_geometry;
mod next_main;
mod paste;
mod point_overlay;
mod presentation;
#[cfg(target_os = "macos")]
mod screen_localization;
mod shell_env;
mod sidecar_lifecycle;
mod sound;
mod speech_text;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod stt;
#[cfg(target_os = "macos")]
mod tts;
mod window_restore;
mod window_state_sanitizer;
// Windows-native Node.js discovery (#1740). Compiles on Windows targets or
// under `cfg(test)` so its pure logic gets real unit coverage from macOS —
// see the module doc comment.
#[cfg(any(test, target_os = "windows"))]
mod windows_node_locate;
// #1741: PATH string logic is unconditional so `cargo test --lib` exercises
// it on every host OS; only its `windows_impl` submodule is cfg-gated.
mod windows_cli_path;
// Plan-token + managed-inference proxy routing: reads keys via the stt module,
// consumed by the agent / ai paths (macOS) and the stt engine (macOS + Linux).
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod entitlement;
// #2158: scopes the Control-as-Fn dictation substitute to an attached
// non-Apple external keyboard instead of leaving it a global toggle. macOS-only
// like the rest of the voice stack (#1673).
#[cfg(target_os = "macos")]
mod external_keyboard;
mod telemetry;
#[cfg(target_os = "macos")]
mod url_scheme_handler;
mod webview_latch;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::Path;
use std::process::Command;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use crate::no_window::NoWindow;
use desktop_close::DesktopClosePreference;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use desktop_close::DesktopCloseRequest;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent,
};
use tauri_plugin_notification::NotificationExt;
use webview_latch::WebviewLatch;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

// ── macOS Keychain integration ──
//
// The AES-256-GCM master key that protects API keys at rest is stored in the
// macOS Keychain under a well-known service / account pair. We shell out to
// the `security` CLI (always present on macOS) rather than pulling in a
// keychain crate, keeping the dependency tree minimal.
//
// On non-macOS platforms these functions are not compiled. The TypeScript
// layer falls back to an env-var / config-file key on those platforms.

/// Keychain service name — identifies the o8 application.
const KEYCHAIN_SERVICE: &str = "ai.o8.master-key";
/// Keychain account name — a single per-install master key slot.
const KEYCHAIN_ACCOUNT: &str = "default";

pub(crate) fn env_flag_enabled(name: &str) -> bool {
    matches!(std::env::var(name).as_deref(), Ok("1"))
}

/// Minimal URL-safe base64 encoder (no padding, no external crate).
/// Used only for the 32-byte master key.
fn base64_encode_url(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((data.len() * 4 + 2) / 3);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as u32
        } else {
            0
        };
        out.push(TABLE[((b0 >> 2) & 0x3f) as usize] as char);
        out.push(TABLE[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize] as char);
        }
        if i + 2 < data.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        }
        i += 3;
    }
    out
}

#[cfg(target_os = "macos")]
fn keychain_find_password() -> Option<String> {
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let pw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if pw.is_empty() {
        None
    } else {
        Some(pw)
    }
}

#[cfg(target_os = "macos")]
fn keychain_add_password(password: &str) -> bool {
    // -U updates an existing entry if one already exists.
    Command::new("security")
        .args([
            "add-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            password,
            "-U",
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Generate a cryptographically random 256-bit key encoded as URL-safe base64.
#[cfg(target_os = "macos")]
fn generate_master_key() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    // /dev/urandom is always available on macOS.
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    }
    base64_encode_url(&bytes)
}

fn require_main_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("command not authorized".to_string())
    }
}

/// Retrieve the master encryption key from the Keychain.
/// Returns Err("keychain-miss") if the entry does not exist.
#[cfg(target_os = "macos")]
#[tauri::command]
fn master_key_get(window: tauri::Window) -> Result<String, String> {
    require_main_window(&window)?;
    keychain_find_password().ok_or_else(|| "keychain-miss".to_string())
}

/// Retrieve the master key, creating and storing a new one if absent.
/// Idempotent — multiple calls return the same key.
#[cfg(target_os = "macos")]
#[tauri::command]
fn master_key_ensure(window: tauri::Window) -> Result<String, String> {
    require_main_window(&window)?;
    if env_flag_enabled("O8_PRESHIP_GATE") {
        return Err("preship-gate-keychain-disabled".to_string());
    }
    if let Some(existing) = keychain_find_password() {
        return Ok(existing);
    }
    let key = generate_master_key();
    if keychain_add_password(&key) {
        log::info!(
            "[keychain] Master key created and stored (service={} account={})",
            KEYCHAIN_SERVICE,
            KEYCHAIN_ACCOUNT
        );
        Ok(key)
    } else {
        Err("keychain-write-failed".to_string())
    }
}

// ── Data directory resolution ──
//
// Canonical location: ~/.o8 (was ~/.cortex-ide before the April 13 rebrand).
// On first launch of the renamed binary we copy the old dir into the new
// location once, drop a marker file, and never touch it again. The old dir
// is left in place so rolling back to an older installer still works.
//
// Priority:
//   1. O8_DATA_DIR      — explicit override, no migration
//   2. CORTEX_IDE_DATA_DIR — legacy override, also no migration
//   3. ~/.o8           — default, auto-migrate from ~/.cortex-ide on first use

fn o8_data_dir() -> String {
    let primary = std::env::var("O8_DATA_DIR").ok();
    let legacy = std::env::var("CORTEX_IDE_DATA_DIR").ok();
    let home = home_dir_string();
    let cwd = std::env::current_dir().unwrap_or_default();
    let directory = o8_restart_safety::resolve_data_directory(primary.as_deref(), legacy.as_deref(),
        std::path::Path::new(&home), &cwd).expect("Native data directory must be absolute");
    let resolved = directory.to_string_lossy().into_owned();
    if !primary.as_ref().is_some_and(|value| !value.is_empty())
        && !legacy.as_ref().is_some_and(|value| !value.is_empty()) {
        migrate_data_dir_once(&home, &resolved);
    }
    resolved
}

#[cfg(test)]
pub(crate) static DATA_DIR_ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

/// `$HOME`, falling back to `%USERPROFILE%`. Windows sets only the latter, so
/// the plain `var("HOME")` this replaced resolved to "" there — child logs and
/// prefs landed at `/.o8/...` (drive root, access denied) and were lost
/// (#1673 VM smoke).
fn home_dir_string() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .unwrap_or_default()
}

/// Windows `resource_dir()` (and anything else touched by
/// `std::fs::canonicalize`) comes back `\\?\C:\...`. Node.js cannot resolve a
/// script entry through the extended-length prefix — `resolveMainPath` dies
/// with EISDIR lstat'ing `C:` — so every path handed to a Node child must be
/// a plain drive path (#1673 VM smoke). No-op for `\\?\UNC\` shares and on
/// non-Windows.
fn strip_extended_length_prefix(p: std::path::PathBuf) -> std::path::PathBuf {
    if cfg!(windows) {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest.to_string());
        }
    }
    p
}

fn migrate_data_dir_once(home: &str, new_dir: &str) {
    let marker = format!("{}/.migrated-from-cortex-ide", new_dir);
    if std::path::Path::new(&marker).exists() {
        return;
    }
    let old_dir = format!("{}/.cortex-ide", home);
    let old_exists = std::path::Path::new(&old_dir).exists();
    let new_exists = std::path::Path::new(new_dir).exists();

    if !new_exists && !old_exists {
        let _ = std::fs::create_dir_all(new_dir);
        let _ = std::fs::write(
            &marker,
            format!("Fresh install on {:?}\n", std::time::SystemTime::now()),
        );
        return;
    }
    if new_exists {
        let has_content = std::fs::read_dir(new_dir)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
        if has_content {
            let _ = std::fs::write(
                &marker,
                format!("Existing dir on {:?}\n", std::time::SystemTime::now()),
            );
            return;
        }
    }
    if old_exists {
        log::info!("[data-dir] Migrating {} → {}", old_dir, new_dir);
        let _ = std::fs::create_dir_all(new_dir);
        if let Err(e) = copy_dir_recursive(&old_dir, new_dir) {
            log::warn!("[data-dir] Migration failed: {}", e);
        } else {
            let _ = std::fs::write(
                &marker,
                format!(
                    "Migrated from {} on {:?}\n",
                    old_dir,
                    std::time::SystemTime::now()
                ),
            );
            log::info!(
                "[data-dir] Migration complete. Old dir left at {} for rollback.",
                old_dir
            );
        }
    }
}

fn copy_dir_recursive(src: &str, dst: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dst_path = std::path::Path::new(dst).join(&file_name);
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(
                src_path.to_str().unwrap_or(""),
                dst_path.to_str().unwrap_or(""),
            )?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

// ── Codebase Memory MCP runtime download (issue #755 / #739) ──
//
// The Context Engine v2 (epic #738) ships a static `codebase-memory-mcp`
// binary so the production app can index repos and answer recall queries
// without a separate install step. Each architecture's binary is ~161 MB
// — bundling it would balloon the installer (148 MB → 309 MB on disk),
// so we download it on first launch into `~/.o8/bin/` instead. Every
// subsequent launch re-uses the cached binary.
//
// Strategy:
//   1. If `~/.o8/bin/codebase-memory-mcp` exists with the expected SHA →
//      set `O8_CODEBASE_MEMORY_BIN` and return immediately. No network.
//   2. Otherwise download the matching-arch tarball from the upstream
//      DeusData release, verify SHA-256 against the pinned constant,
//      extract the binary, chmod +x, set the env var.
//   3. On any failure: log + emit `codebase-memory:status` = "error" +
//      set `O8_CODEBASE_MEMORY_BIN=""` so #740's MCP registration sees
//      the variable but skips the entry gracefully.
//
// The whole flow runs on a background thread so it never blocks the
// Tauri builder's `setup` callback. By the time #740's MCP registration
// runs (orchestrator-session.ts spawns Claude Code), the env var is
// either populated (binary cached or freshly downloaded) or empty
// (download failed). Either way startup is unblocked.
//
// Pin: bump `CODEBASE_MEMORY_VERSION` and the matching `CODEBASE_MEMORY_CHECKSUMS`
// entries to upgrade. SHA-256 values come from the upstream release
// `checksums.txt` for that tag. See `docs/internals/codebase-memory-build.md`.

// 0.9.0 bump (2026-07-09): upstream DELETED the v0.6.0 release assets — every
// fresh install's download 404'd forever, and the Settings→MCP readiness gate
// misread the permanent failure as "still downloading" (beta report: "MCP still
// saying install after days"). SHAs below are from v0.9.0's checksums.txt.
const CODEBASE_MEMORY_VERSION: &str = "0.9.0";
const CODEBASE_MEMORY_REPO: &str = "DeusData/codebase-memory-mcp";

/// SHA-256 of the upstream archive (tar.gz / zip) — the binary inside
/// inherits its integrity from the verified archive. Bump these together
/// with `CODEBASE_MEMORY_VERSION`.
fn codebase_memory_archive_sha(asset: &str) -> Option<&'static str> {
    match asset {
        "codebase-memory-mcp-darwin-amd64.tar.gz" => {
            Some("6af3d02a27f589901fa763d3971089337bc8c9838bbed5d0cf543ca9f1a9e543")
        }
        "codebase-memory-mcp-darwin-arm64.tar.gz" => {
            Some("faa02f0404230c451a9812230394481948f80183801fa5bf67044b41c2f25ed4")
        }
        "codebase-memory-mcp-linux-amd64.tar.gz" => {
            Some("e2832a8d207c26beaa30efa6222ed4a37cb3f526ca4bee060bfbf336ed6fc679")
        }
        "codebase-memory-mcp-linux-arm64.tar.gz" => {
            Some("68a345d9a6842f02a3cb07e187b28bc38c4f3a22967f47fadbcd0757ba93a680")
        }
        "codebase-memory-mcp-windows-amd64.zip" => {
            Some("92f96896f952e539f0d6cb34d7892a25064b677ccbf808b8f8310ad897e86f2c")
        }
        "codebase-memory-mcp-windows-arm64.zip" => {
            Some("63994fcfd15bf5e3f03cbf368cce86261713c7d7802e31469ae81a3939e4fae6")
        }
        _ => None,
    }
}

/// (asset_name, binary_name, is_zip) for the running host. Returns None
/// when the host doesn't match any upstream prebuilt — in that case we
/// skip silently and let #740 omit the MCP entry.
fn detect_codebase_memory_asset() -> Option<(&'static str, &'static str, bool)> {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "x86_64") {
            return Some((
                "codebase-memory-mcp-darwin-amd64.tar.gz",
                "codebase-memory-mcp",
                false,
            ));
        }
        if cfg!(target_arch = "aarch64") {
            return Some((
                "codebase-memory-mcp-darwin-arm64.tar.gz",
                "codebase-memory-mcp",
                false,
            ));
        }
    } else if cfg!(target_os = "linux") {
        if cfg!(target_arch = "x86_64") {
            return Some((
                "codebase-memory-mcp-linux-amd64.tar.gz",
                "codebase-memory-mcp",
                false,
            ));
        }
        if cfg!(target_arch = "aarch64") {
            return Some((
                "codebase-memory-mcp-linux-arm64.tar.gz",
                "codebase-memory-mcp",
                false,
            ));
        }
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        return Some((
            "codebase-memory-mcp-windows-amd64.zip",
            "codebase-memory-mcp.exe",
            true,
        ));
    }
    None
}

/// Hash a local file with SHA-256, returned as lowercase hex.
fn sha256_file(path: &std::path::Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Spawn a background thread that ensures the codebase-memory-mcp binary
/// is available at `~/.o8/bin/codebase-memory-mcp`. On success sets the
/// `O8_CODEBASE_MEMORY_BIN` env var on the parent process so any later
/// child inherits it (mirrors the `O8_NODE_BIN` pattern). On failure
/// sets the var to an empty string — downstream MCP registration in
/// #740 treats empty/unset as "feature unavailable".
/// Persist the downloader's lifecycle state where the NODE side can see it.
/// `app.emit` only reaches webviews; the Settings→MCP readiness gate runs in
/// the bundled Next server, which was blind to the "error" state and misread
/// a permanently failed download as "still downloading" — blocking the
/// one-click Connect forever (2026-07-09 beta report). Values: "downloading" |
/// "ready" | "error". Best-effort — a write failure only costs status fidelity.
fn write_codebase_memory_status(status: &str) {
    let path = std::path::PathBuf::from(format!("{}/bin", o8_data_dir()))
        .join(".codebase-memory-status");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, status);
}

fn ensure_codebase_memory_binary(app: AppHandle) {
    std::thread::spawn(move || {
        let Some((asset_name, binary_name, is_zip)) = detect_codebase_memory_asset() else {
            log::info!(
                "[codebase-memory] no prebuilt for {}/{} — skipping",
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            return;
        };
        let Some(expected_sha) = codebase_memory_archive_sha(asset_name) else {
            log::warn!("[codebase-memory] no checksum pinned for {}", asset_name);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            return;
        };

        let bin_dir = format!("{}/bin", o8_data_dir());
        if let Err(e) = std::fs::create_dir_all(&bin_dir) {
            log::warn!("[codebase-memory] mkdir {} failed: {}", bin_dir, e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            return;
        }
        let bin_path = std::path::PathBuf::from(&bin_dir).join(binary_name);
        let sentinel_path = std::path::PathBuf::from(&bin_dir).join(".codebase-memory-mcp.version");

        // Cache hit: existing binary + matching version sentinel = ready.
        // Skipping the hash on cache hit keeps re-launches snappy
        // (~150 MB hash takes meaningful time on slow disks). The
        // sentinel encodes both version + asset so a partial re-extract
        // or arch mismatch fails the check.
        let expected_tag = format!("{}-{}", CODEBASE_MEMORY_VERSION, asset_name);
        if bin_path.exists() {
            if let Ok(tag) = std::fs::read_to_string(&sentinel_path) {
                if tag.trim() == expected_tag {
                    log::info!(
                        "[codebase-memory] cached: {} v{}",
                        binary_name,
                        CODEBASE_MEMORY_VERSION
                    );
                    let bin_str = bin_path.to_string_lossy().to_string();
                    std::env::set_var("O8_CODEBASE_MEMORY_BIN", &bin_str);
                    write_codebase_memory_status("ready");
                    let _ = app.emit("codebase-memory:status", "ready");
                    return;
                }
            }
        }

        write_codebase_memory_status("downloading");
        let _ = app.emit("codebase-memory:status", "downloading");

        // Materialise the archive into a tmp file, verify SHA, extract,
        // move the binary into place. Any failure on this path leaves
        // the env var empty so downstream code skips the MCP entry.
        let url = format!(
            "https://github.com/{}/releases/download/v{}/{}",
            CODEBASE_MEMORY_REPO, CODEBASE_MEMORY_VERSION, asset_name
        );
        let tmp_root = std::env::temp_dir().join(format!("o8-cmm-{}", std::process::id()));
        if let Err(e) = std::fs::create_dir_all(&tmp_root) {
            log::warn!("[codebase-memory] mkdir tmp failed: {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
            return;
        }
        let archive_path = tmp_root.join(asset_name);

        log::info!(
            "[codebase-memory] fetching {} v{}",
            asset_name,
            CODEBASE_MEMORY_VERSION
        );
        let download_result: Result<(), String> = (|| {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|e| format!("client build: {}", e))?;
            let mut resp = client
                .get(&url)
                .send()
                .map_err(|e| format!("send: {}", e))?;
            if !resp.status().is_success() {
                return Err(format!("HTTP {}", resp.status()));
            }
            let mut out = std::fs::File::create(&archive_path)
                .map_err(|e| format!("create archive: {}", e))?;
            std::io::copy(&mut resp, &mut out).map_err(|e| format!("write archive: {}", e))?;
            Ok(())
        })();

        if let Err(e) = download_result {
            log::warn!("[codebase-memory] download failed (non-fatal): {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        let actual_sha = match sha256_file(&archive_path) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("[codebase-memory] hash failed: {}", e);
                std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
                write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
                let _ = std::fs::remove_dir_all(&tmp_root);
                return;
            }
        };
        if actual_sha != expected_sha {
            log::warn!(
                "[codebase-memory] SHA mismatch: expected {}, got {}",
                expected_sha,
                actual_sha
            );
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        // Extract via system `tar` / `unzip`. Both ship on every macOS and
        // Linux host. Windows has no `unzip`, but its bundled bsdtar
        // (`tar.exe`, Win10 1803+) extracts zip archives natively — the
        // `unzip` spawn just failed "program not found" there (#1673).
        let extract_result: Result<(), String> = (|| {
            let archive_str = archive_path.to_string_lossy();
            let tmp_str = tmp_root.to_string_lossy();
            if is_zip && cfg!(windows) {
                let status = Command::new("tar")
                    .args(["-xf", &archive_str, "-C", &tmp_str])
                    .no_window()
                    .status()
                    .map_err(|e| format!("tar(zip) spawn: {}", e))?;
                if !status.success() {
                    return Err(format!("tar(zip) exit {}", status));
                }
            } else if is_zip {
                let status = Command::new("unzip")
                    .args(["-o", &archive_str, "-d", &tmp_str])
                    .status()
                    .map_err(|e| format!("unzip spawn: {}", e))?;
                if !status.success() {
                    return Err(format!("unzip exit {}", status));
                }
            } else {
                let status = Command::new("tar")
                    .args(["-xzf", &archive_str, "-C", &tmp_str])
                    .no_window()
                    .status()
                    .map_err(|e| format!("tar spawn: {}", e))?;
                if !status.success() {
                    return Err(format!("tar exit {}", status));
                }
            }
            Ok(())
        })();

        if let Err(e) = extract_result {
            log::warn!("[codebase-memory] extract failed: {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        let extracted = tmp_root.join(binary_name);
        if !extracted.exists() {
            log::warn!(
                "[codebase-memory] binary not found in archive: {:?}",
                extracted
            );
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        // copy + rename into place. fs::rename can fail across tmpfs ↔
        // home-dir filesystem boundaries, so copy + remove keeps it
        // robust.
        if let Err(e) = std::fs::copy(&extracted, &bin_path) {
            log::warn!("[codebase-memory] install failed: {}", e);
            std::env::set_var("O8_CODEBASE_MEMORY_BIN", "");
            write_codebase_memory_status("error");
            let _ = app.emit("codebase-memory:status", "error");
            let _ = std::fs::remove_dir_all(&tmp_root);
            return;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755));
        }

        if let Err(e) = std::fs::write(&sentinel_path, &expected_tag) {
            log::warn!("[codebase-memory] sentinel write failed: {}", e);
            // Not fatal — next launch will re-verify and re-extract.
        }
        let _ = std::fs::remove_dir_all(&tmp_root);

        let bin_str = bin_path.to_string_lossy().to_string();
        log::info!("[codebase-memory] installed at {}", bin_str);
        std::env::set_var("O8_CODEBASE_MEMORY_BIN", &bin_str);
        write_codebase_memory_status("ready");
                    let _ = app.emit("codebase-memory:status", "ready");
    });
}

// ── Dynamic port allocation ──
//
// A packaged Tauri app can't assume the default port is free — another dev tool,
// a running o8 dev server, or an unrelated service may already own it.
// `find_free_port(preferred)` probes from the preferred port upward and
// returns the first one that has no reachable listener and binds successfully.
// The result is persisted to `~/.o8/api-port` so downstream consumers (the MCP server,
// `/api/setup/mcp-config`, the orchestrator session config writer) all
// agree on where the backend actually lives.

const PROD_API_DEFAULT_PORT: u16 = 47100;
const PROD_WS_DEFAULT_PORT: u16 = 47105;
const PROD_API_PORT_RANGE: std::ops::Range<u16> = 47100..47105;
const PROD_WS_PORT_RANGE: std::ops::Range<u16> = 47105..47110;

/// Take at most `max` bytes from the head of `s`, floored to a char boundary.
/// `&s[..n]` panics when byte `n` lands mid-UTF-8-sequence — error bodies from
/// provider APIs routinely contain multibyte characters, and the panic fires
/// on exactly the path that was trying to report a failure.
pub(crate) fn utf8_head(s: &str, max: usize) -> &str {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod utf8_head_tests {
    use super::utf8_head;

    #[test]
    fn returns_whole_string_when_under_max() {
        assert_eq!(utf8_head("hello", 10), "hello");
        assert_eq!(utf8_head("", 10), "");
    }

    #[test]
    fn cuts_ascii_exactly_at_max() {
        assert_eq!(utf8_head("hello world", 5), "hello");
    }

    #[test]
    fn floors_to_char_boundary_instead_of_panicking() {
        // 'é' is 2 bytes (0xC3 0xA9); cutting at byte 1 lands mid-sequence.
        assert_eq!(utf8_head("é", 1), "");
        // "aé" = [a][C3 A9]; cutting at byte 2 lands mid-é → floor to "a".
        assert_eq!(utf8_head("aé", 2), "a");
        // 4-byte emoji: every interior cut floors to the previous boundary.
        let s = "x😀y";
        assert_eq!(utf8_head(s, 2), "x");
        assert_eq!(utf8_head(s, 3), "x");
        assert_eq!(utf8_head(s, 4), "x");
        assert_eq!(utf8_head(s, 5), "x😀");
    }

    #[test]
    fn max_zero_returns_empty() {
        assert_eq!(utf8_head("anything", 0), "");
    }
}

/// A wildcard listener can coexist with a second `127.0.0.1` bind on macOS
/// even though the bundled Node sidecar cannot subsequently claim that port.
/// Reject reachable listeners before using the bind probe so desktop/daemon
/// coexistence always advances to a genuinely unused port.
fn bundled_sidecar_port_available(port: u16) -> bool {
    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
        return false;
    }
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Returns the first port in the range that the bundled sidecar can claim.
/// `skip` lets the caller avoid picking the same port for API and WS.
fn find_free_port(range: std::ops::Range<u16>, skip: Option<u16>) -> Option<u16> {
    for port in range {
        if Some(port) == skip {
            continue;
        }
        if bundled_sidecar_port_available(port) {
            return Some(port);
        }
    }
    None
}

fn bind_ephemeral_port(skip: Option<u16>) -> u16 {
    for _ in 0..16 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) {
            if let Ok(addr) = listener.local_addr() {
                let port = addr.port();
                drop(listener);
                if Some(port) != skip && bundled_sidecar_port_available(port) {
                    return port;
                }
            }
        }
    }
    0
}

/// Bind host for the bundled Next server (and, via the inherited
/// `O8_LAN_ACCESS`, the ws-server — see src/lib/panel/listen-host.ts).
/// Loopback by default: every desktop caller uses 127.0.0.1, and a wildcard
/// bind exposes the API to the whole LAN/VPN. `O8_LAN_ACCESS=1` opts in to
/// 0.0.0.0 so a phone can reach this machine directly for mobile pairing.
fn sidecar_listen_host() -> &'static str {
    listen_host_for(std::env::var("O8_LAN_ACCESS").ok().as_deref())
}

fn listen_host_for(lan_access: Option<&str>) -> &'static str {
    match lan_access
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("1" | "true" | "yes" | "on") => "0.0.0.0",
        _ => "127.0.0.1",
    }
}

#[cfg(test)]
mod listen_host_tests {
    use super::listen_host_for;

    #[test]
    fn bundled_servers_bind_loopback_by_default() {
        assert_eq!(listen_host_for(None), "127.0.0.1");
        for value in ["", "0", "false", "no", "off", "0.0.0.0"] {
            assert_eq!(listen_host_for(Some(value)), "127.0.0.1", "{value:?}");
        }
    }

    #[test]
    fn lan_access_opt_in_binds_all_interfaces() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert_eq!(listen_host_for(Some(value)), "0.0.0.0", "{value:?}");
        }
    }
}

#[cfg(test)]
mod port_allocation_tests {
    use super::{bundled_sidecar_port_available, find_free_port};
    use std::net::TcpListener;

    #[test]
    fn reachable_wildcard_listener_is_not_available_to_bundled_sidecars() {
        let listener =
            TcpListener::bind(("0.0.0.0", 0)).expect("bind wildcard listener");
        let port = listener
            .local_addr()
            .expect("wildcard listener address")
            .port();
        let end = port.checked_add(1).expect("ephemeral port has a successor");

        assert!(!bundled_sidecar_port_available(port));
        assert_eq!(find_free_port(port..end, None), None);
    }
}

fn random_uuid_v4() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes[..8].copy_from_slice(&(now as u64).to_be_bytes());
        bytes[8..12].copy_from_slice(&std::process::id().to_be_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

#[derive(Clone, Debug)]
struct BootIdentity {
    boot_id: String,
    instance_id: String,
}

fn read_or_create_boot_identity() -> BootIdentity {
    let dir = o8_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let instance_path = format!("{}/instance-id", dir);
    let instance_id = std::fs::read_to_string(&instance_path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            let id = random_uuid_v4();
            let _ = std::fs::write(&instance_path, &id);
            id
        });
    let boot_id = random_uuid_v4();
    let _ = std::fs::write(format!("{}/boot-id", dir), &boot_id);
    BootIdentity {
        boot_id,
        instance_id,
    }
}

fn export_boot_identity(identity: &BootIdentity) {
    std::env::set_var("O8_BOOT_ID", &identity.boot_id);
    std::env::set_var("O8_INSTANCE_ID", &identity.instance_id);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupIdentityResponse {
    product: Option<String>,
    instance_id: Option<String>,
    boot_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopAttachDecision {
    Attach,
    Coexist,
    NormalBoot,
}

/// Decide whether the desktop shell can attach without reading files, probing
/// processes, or touching listeners. `None` for `pidfile_alive` means there is
/// no usable daemon PID file. The other optional inputs are unavailable until
/// a live PID has a valid serve-state record and an identity response.
fn decide_desktop_attach(
    pidfile_alive: Option<bool>,
    identity_is_o8: Option<bool>,
    versions_match: Option<bool>,
) -> DesktopAttachDecision {
    match pidfile_alive {
        None | Some(false) => DesktopAttachDecision::NormalBoot,
        Some(true)
            if identity_is_o8 == Some(true) && versions_match == Some(true) =>
        {
            DesktopAttachDecision::Attach
        }
        Some(true) => DesktopAttachDecision::Coexist,
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ServeStateV1 {
    schema: String,
    version: String,
    pid: u32,
    api_port: u16,
    ws_port: u16,
    generation: Option<String>,
}

#[derive(Clone, Debug)]
struct DesktopAttachTarget {
    api_port: u16,
    ws_port: u16,
    identity: BootIdentity,
}

#[derive(Debug)]
struct DesktopAttachAttempt {
    decision: DesktopAttachDecision,
    target: Option<DesktopAttachTarget>,
    reason: String,
}

// The probe runs before the first window. A loopback identity response is
// normally single-digit milliseconds; 75ms leaves scheduler margin while
// keeping an unhealthy daemon below the common 100ms perception threshold.
const DESKTOP_ATTACH_IDENTITY_TIMEOUT_MS: u64 = 75;
// Reopening a live profile can race a cold route or a busy scheduler. Other
// listener probes retain their short budget; attachment has a recovery prompt.
const DESKTOP_RECONNECT_IDENTITY_TIMEOUT_MS: u64 = 2_000;

fn fetch_setup_identity(port: u16) -> Option<SetupIdentityResponse> {
    fetch_setup_identity_with_timeout(port, DESKTOP_ATTACH_IDENTITY_TIMEOUT_MS)
}

fn fetch_setup_identity_with_timeout(port: u16, timeout_ms: u64) -> Option<SetupIdentityResponse> {
    let url = format!("http://127.0.0.1:{}/api/setup/identity", port);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(
            timeout_ms,
        ))
        .build()
        .ok()?;
    let response = client.get(url).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<SetupIdentityResponse>().ok()
}

#[cfg(unix)]
fn daemon_pid_is_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    let result = unsafe { libc::kill(pid, 0) };
    result == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn daemon_pid_is_alive(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .no_window()
        .output();
    let Ok(output) = output else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        line.split(',')
            .nth(1)
            .and_then(|value| value.trim().trim_matches('"').parse::<u32>().ok())
            == Some(pid)
    })
}

#[cfg(not(any(unix, windows)))]
fn daemon_pid_is_alive(_pid: u32) -> bool {
    false
}

fn unowned_desktop_boot(data_dir: &str, reason: String) -> DesktopAttachAttempt {
    if let Some(reason) = desktop_attach_owner::retained_owner_reason(data_dir, daemon_pid_is_alive) {
        return DesktopAttachAttempt { decision: DesktopAttachDecision::Coexist, target: None, reason };
    }
    DesktopAttachAttempt { decision: DesktopAttachDecision::NormalBoot, target: None, reason }
}

fn inspect_desktop_attach() -> DesktopAttachAttempt {
    let data_dir = o8_data_dir();
    let pid_path = format!("{data_dir}/serve.pid");
    let state_path = format!("{data_dir}/serve-state.json");
    let pid_raw = match std::fs::read_to_string(&pid_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
            && matches!(std::fs::symlink_metadata(&pid_path), Err(ref error) if error.kind() == std::io::ErrorKind::NotFound) => {
            return unowned_desktop_boot(&data_dir, "serve.pid is absent".to_string());
        }
        Err(error) => {
            return DesktopAttachAttempt {
                decision: DesktopAttachDecision::Coexist,
                target: None,
                reason: format!("serve.pid could not be read: {error}"),
            };
        }
    };
    let pid = match pid_raw.trim().parse::<u32>() {
        Ok(pid) if pid > 0 => pid,
        _ => {
            return DesktopAttachAttempt {
                decision: DesktopAttachDecision::Coexist,
                target: None,
                reason: "serve.pid is malformed".to_string(),
            };
        }
    };
    if !daemon_pid_is_alive(pid) {
        return unowned_desktop_boot(&data_dir, format!("serve.pid references dead pid {pid}"));
    }

    let state_raw = match std::fs::read_to_string(&state_path) {
        Ok(raw) => raw,
        Err(error) => {
            return DesktopAttachAttempt {
                decision: decide_desktop_attach(Some(true), None, None),
                target: None,
                reason: format!("live daemon pid {pid} has no readable serve-state.json: {error}"),
            };
        }
    };
    let state = match serde_json::from_str::<ServeStateV1>(&state_raw) {
        Ok(state) => state,
        Err(error) => {
            return DesktopAttachAttempt {
                decision: decide_desktop_attach(Some(true), None, None),
                target: None,
                reason: format!("live daemon pid {pid} has malformed serve-state.json: {error}"),
            };
        }
    };
    if state.schema != "o8/serve-state/v1"
        || state.pid != pid
        || state.api_port == 0
        || state.ws_port == 0
        || state.version.trim().is_empty()
    {
        return DesktopAttachAttempt {
            decision: decide_desktop_attach(Some(true), None, None),
            target: None,
            reason: format!("live daemon pid {pid} has invalid serve-state.json fields"),
        };
    }

    let identity = fetch_setup_identity_with_timeout(state.api_port, DESKTOP_RECONNECT_IDENTITY_TIMEOUT_MS).and_then(|response| {
        let SetupIdentityResponse {
            product: Some(product),
            instance_id: Some(instance_id),
            boot_id: Some(boot_id),
        } = response
        else {
            return None;
        };
        if product != "o8" || instance_id.is_empty() || boot_id.is_empty() {
            return None;
        }
        Some(BootIdentity {
            boot_id,
            instance_id,
        })
    });
    let identity_is_o8 = identity.is_some();
    let app_version = env!("CARGO_PKG_VERSION");
    let versions_match = state.version == app_version;
    let decision = decide_desktop_attach(
        Some(true),
        Some(identity_is_o8),
        Some(versions_match),
    );
    if decision != DesktopAttachDecision::Attach {
        let reason = if !identity_is_o8 {
            format!(
                "live daemon pid {pid} did not return a complete o8 identity on api port {}",
                state.api_port
            )
        } else {
            format!(
                "daemon version {} does not match desktop version {app_version}",
                state.version
            )
        };
        return DesktopAttachAttempt {
            decision,
            target: None,
            reason,
        };
    }

    let Some(identity) = identity else {
        return DesktopAttachAttempt {
            decision: DesktopAttachDecision::Coexist,
            target: None,
            reason: format!(
                "live daemon pid {pid} returned an incomplete o8 identity on api port {}",
                state.api_port
            ),
        };
    };
    // The probe awaited an external process. Re-read ownership before using its
    // result so a reply from a superseded generation cannot select our backend.
    let owner_unchanged = std::fs::read_to_string(&pid_path)
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok()) == Some(pid)
        && daemon_pid_is_alive(pid)
        && std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<ServeStateV1>(&raw).ok())
            .as_ref() == Some(&state);
    if !owner_unchanged {
        return DesktopAttachAttempt {
            decision: DesktopAttachDecision::Coexist,
            target: None,
            reason: "daemon ownership changed during the identity probe".to_string(),
        };
    }
    DesktopAttachAttempt {
        decision,
        target: Some(DesktopAttachTarget {
            api_port: state.api_port,
            ws_port: state.ws_port,
            identity,
        }),
        reason: format!(
            "healthy daemon pid {pid} matches desktop version {app_version}"
        ),
    }
}

/// A live or unreadable owner is never permission to start another backend in
/// its profile. Dismissal exits before boot identity, listeners or sidecars.
fn resolve_desktop_attach(mut retry: impl FnMut(&str) -> bool) -> Option<DesktopAttachAttempt> {
    loop {
        let attempt = inspect_desktop_attach();
        if attempt.decision != DesktopAttachDecision::Coexist {
            return Some(attempt);
        }
        eprintln!("[desktop-attach] waiting for existing profile: {}", attempt.reason);
        if !retry(&attempt.reason) {
            return None;
        }
    }
}

#[cfg(test)]
mod desktop_attach_tests {
    use super::{
        decide_desktop_attach, inspect_desktop_attach, resolve_desktop_attach, DesktopAttachDecision,
        DATA_DIR_ENV_TEST_LOCK,
    };
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(0);

    struct DataDirFixture {
        path: PathBuf,
        previous_o8: Option<OsString>,
        previous_cortex: Option<OsString>,
    }

    impl DataDirFixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "o8-desktop-attach-{}-{}",
                std::process::id(),
                NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create desktop attach test data dir");
            let previous_o8 = std::env::var_os("O8_DATA_DIR");
            let previous_cortex = std::env::var_os("CORTEX_IDE_DATA_DIR");
            std::env::set_var("O8_DATA_DIR", &path);
            std::env::remove_var("CORTEX_IDE_DATA_DIR");
            Self {
                path,
                previous_o8,
                previous_cortex,
            }
        }
    }

    impl Drop for DataDirFixture {
        fn drop(&mut self) {
            match self.previous_o8.take() {
                Some(value) => std::env::set_var("O8_DATA_DIR", value),
                None => std::env::remove_var("O8_DATA_DIR"),
            }
            match self.previous_cortex.take() {
                Some(value) => std::env::set_var("CORTEX_IDE_DATA_DIR", value),
                None => std::env::remove_var("CORTEX_IDE_DATA_DIR"),
            }
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn write_state(data_dir: &Path, pid: u32, api_port: u16, version: &str) {
        let state = serde_json::json!({
            "schema": "o8/serve-state/v1",
            "version": version,
            "pid": pid,
            "pgid": pid,
            "apiPort": api_port,
            "wsPort": 47105,
            "mode": "packaged",
            "root": data_dir,
            "startedAt": "2026-08-31T00:00:00.000Z",
            "status": "ready",
            "children": [],
        });
        std::fs::write(data_dir.join("serve-state.json"), state.to_string())
            .expect("write serve state");
    }

    fn spawn_identity_stub() -> (u16, JoinHandle<()>) {
        spawn_delayed_identity_stub(Duration::ZERO, || {})
    }

    fn spawn_delayed_identity_stub(
        delay: Duration,
        before_response: impl FnOnce() + Send + 'static,
    ) -> (u16, JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind identity stub");
        listener
            .set_nonblocking(true)
            .expect("set identity stub nonblocking");
        let port = listener.local_addr().expect("identity stub address").port();
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_nonblocking(false)
                            .expect("set identity stream blocking");
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .expect("set identity stream read timeout");
                        let mut request = [0_u8; 2048];
                        let bytes_read = stream.read(&mut request).expect("read identity request");
                        assert!(
                            String::from_utf8_lossy(&request[..bytes_read])
                                .starts_with("GET /api/setup/identity "),
                            "identity probe must use the setup identity route"
                        );
                        std::thread::sleep(delay);
                        before_response();
                        let body = r#"{"product":"o8","instanceId":"daemon-instance","bootId":"daemon-boot"}"#;
                        write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .expect("write identity response");
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "identity probe never connected");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept identity probe: {error}"),
                }
            }
        });
        (port, handle)
    }

    #[test]
    fn healthy_matching_daemon_attaches() {
        assert_eq!(
            decide_desktop_attach(Some(true), Some(true), Some(true)),
            DesktopAttachDecision::Attach
        );
    }

    #[test]
    fn version_mismatch_coexists() {
        assert_eq!(
            decide_desktop_attach(Some(true), Some(true), Some(false)),
            DesktopAttachDecision::Coexist
        );
    }

    #[test]
    fn dead_pid_uses_normal_boot() {
        assert_eq!(
            decide_desktop_attach(Some(false), None, None),
            DesktopAttachDecision::NormalBoot
        );
    }

    #[test]
    fn absent_daemon_files_use_normal_boot() {
        assert_eq!(
            decide_desktop_attach(None, None, None),
            DesktopAttachDecision::NormalBoot
        );
    }

    #[test]
    fn real_state_and_identity_probe_attach_to_a_matching_live_daemon() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id();
        let (api_port, identity_stub) = spawn_identity_stub();
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string())
            .expect("write daemon pid");
        write_state(&fixture.path, pid, api_port, env!("CARGO_PKG_VERSION"));

        let attempt = inspect_desktop_attach();
        identity_stub.join().expect("join identity stub");

        assert_eq!(attempt.decision, DesktopAttachDecision::Attach);
        let target = attempt.target.expect("matching live daemon target");
        assert_eq!(target.api_port, api_port);
        assert_eq!(target.ws_port, 47105);
        assert_eq!(target.identity.instance_id, "daemon-instance");
        assert_eq!(target.identity.boot_id, "daemon-boot");
    }

    #[test]
    fn delayed_valid_daemon_attaches_without_replacing_profile_metadata() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id();
        let (api_port, identity_stub) = spawn_delayed_identity_stub(Duration::from_millis(200), || {});
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string()).unwrap();
        write_state(&fixture.path, pid, api_port, env!("CARGO_PKG_VERSION"));
        let before = std::fs::read(fixture.path.join("serve-state.json")).unwrap();

        let attempt = inspect_desktop_attach();
        identity_stub.join().expect("join delayed identity stub");

        assert_eq!(attempt.decision, DesktopAttachDecision::Attach);
        assert_eq!(std::fs::read(fixture.path.join("serve-state.json")).unwrap(), before);
        assert!(!fixture.path.join("boot-id").exists());
    }

    #[test]
    fn dismissing_reconnect_preserves_the_live_owner_and_saved_profile() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id().to_string();
        std::fs::write(fixture.path.join("serve.pid"), &pid).unwrap();
        std::fs::write(fixture.path.join("serve-state.json"), "{unfinished").unwrap();
        std::fs::write(fixture.path.join("boot-id"), "existing-boot").unwrap();
        std::fs::write(fixture.path.join("terminal-state.json"), "saved terminal").unwrap();

        for _ in 0..2 {
            let mut prompted = 0;
            assert!(resolve_desktop_attach(|reason| {
                assert!(reason.contains("malformed"));
                prompted += 1;
                false
            }).is_none());
            assert_eq!(prompted, 1);
            assert_eq!(std::fs::read_to_string(fixture.path.join("serve.pid")).unwrap(), pid);
            assert_eq!(std::fs::read_to_string(fixture.path.join("serve-state.json")).unwrap(), "{unfinished");
            assert_eq!(std::fs::read_to_string(fixture.path.join("boot-id")).unwrap(), "existing-boot");
            assert_eq!(std::fs::read_to_string(fixture.path.join("terminal-state.json")).unwrap(), "saved terminal");
        }
    }

    #[test]
    fn retry_rechecks_the_profile_and_connects_when_it_becomes_ready() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id();
        let (api_port, identity_stub) = spawn_identity_stub();
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string()).unwrap();
        std::fs::write(fixture.path.join("serve-state.json"), "{unfinished").unwrap();
        let mut prompted = 0;

        let attempt = resolve_desktop_attach(|_| {
            prompted += 1;
            write_state(&fixture.path, pid, api_port, env!("CARGO_PKG_VERSION"));
            true
        }).expect("ready owner attaches after retry");
        identity_stub.join().unwrap();

        assert_eq!(prompted, 1);
        assert_eq!(attempt.decision, DesktopAttachDecision::Attach);
        assert!(!fixture.path.join("boot-id").exists());
    }

    #[test]
    fn a_live_supervisor_without_a_live_daemon_pid_keeps_the_profile_owned() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        for dead_pid in [false, true] {
            let fixture = DataDirFixture::new();
            if dead_pid {
                std::fs::write(fixture.path.join("serve.pid"), u32::MAX.to_string()).unwrap();
            }
            let state = serde_json::json!({
                "schema": "o8/serve-state/v1", "supervisorPid": std::process::id(), "generation": "restarting"
            }).to_string();
            std::fs::write(fixture.path.join("serve-state.json"), &state).unwrap();
            assert!(resolve_desktop_attach(|_| false).is_none());
            assert_eq!(std::fs::read_to_string(fixture.path.join("serve-state.json")).unwrap(), state);
            assert!(!fixture.path.join("boot-id").exists());
        }
    }

    #[test]
    fn retry_after_supervisor_startup_uses_its_ready_daemon() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id();
        std::fs::write(fixture.path.join("serve-state.json"), serde_json::json!({
            "schema": "o8/serve-state/v1", "supervisorPid": pid, "generation": "starting"
        }).to_string()).unwrap();
        let (api_port, identity_stub) = spawn_identity_stub();
        let mut prompted = 0;
        let attempt = resolve_desktop_attach(|_| {
            prompted += 1;
            assert!(!fixture.path.join("boot-id").exists());
            std::fs::write(fixture.path.join("serve.pid"), pid.to_string()).unwrap();
            write_state(&fixture.path, pid, api_port, env!("CARGO_PKG_VERSION"));
            true
        }).expect("attach to supervisor's ready daemon");
        identity_stub.join().unwrap();
        assert_eq!(prompted, 1);
        assert_eq!(attempt.decision, DesktopAttachDecision::Attach);
        assert!(!fixture.path.join("boot-id").exists());
    }

    #[test]
    fn retained_children_and_uncertain_lifecycle_metadata_block_a_new_backend() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        for state in [
            serde_json::json!({ "schema": "o8/serve-state/v1", "children": [{ "pid": std::process::id() }] }).to_string(),
            "{unfinished".to_string(),
        ] {
            let fixture = DataDirFixture::new();
            std::fs::write(fixture.path.join("serve-state.json"), &state).unwrap();
            assert!(resolve_desktop_attach(|_| false).is_none());
            assert_eq!(std::fs::read_to_string(fixture.path.join("serve-state.json")).unwrap(), state);
            assert!(!fixture.path.join("boot-id").exists());
        }
        let fixture = DataDirFixture::new();
        std::fs::create_dir(fixture.path.join("serve-operation.lock")).unwrap();
        assert!(resolve_desktop_attach(|_| false).is_none());
        assert!(fixture.path.join("serve-operation.lock").is_dir());
        assert!(!fixture.path.join("boot-id").exists());
    }

    #[test]
    fn a_successful_identity_from_a_superseded_generation_is_rejected() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let fixture = DataDirFixture::new();
        let state_path = fixture.path.join("serve-state.json");
        let state_for_reply = state_path.clone();
        let (api_port, identity_stub) = spawn_delayed_identity_stub(Duration::from_millis(50), move || {
            let mut state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state_for_reply).unwrap()).unwrap();
            state["generation"] = serde_json::json!("replacement");
            std::fs::write(state_for_reply, state.to_string()).unwrap();
        });
        let pid = std::process::id();
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string()).unwrap();
        write_state(&fixture.path, pid, api_port, env!("CARGO_PKG_VERSION"));

        let attempt = inspect_desktop_attach();
        identity_stub.join().unwrap();

        assert_eq!(attempt.decision, DesktopAttachDecision::Coexist);
        assert!(attempt.target.is_none());
        assert!(attempt.reason.contains("ownership changed"));
        assert!(!fixture.path.join("boot-id").exists());
    }

    #[test]
    fn real_state_version_mismatch_declines_with_a_reason() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id();
        let (api_port, identity_stub) = spawn_identity_stub();
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string())
            .expect("write daemon pid");
        write_state(&fixture.path, pid, api_port, "0.0.0-mismatch");

        let attempt = inspect_desktop_attach();
        identity_stub.join().expect("join identity stub");

        assert_eq!(attempt.decision, DesktopAttachDecision::Coexist);
        assert!(attempt.target.is_none());
        assert!(attempt.reason.contains("does not match desktop version"));
    }

    #[test]
    fn out_of_range_pid_declines_to_normal_boot_with_a_reason() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fixture = DataDirFixture::new();
        std::fs::write(fixture.path.join("serve.pid"), u32::MAX.to_string())
            .expect("write dead daemon pid");

        let attempt = inspect_desktop_attach();

        assert_eq!(attempt.decision, DesktopAttachDecision::NormalBoot);
        assert!(attempt.target.is_none());
        assert!(attempt.reason.contains("references dead pid"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn real_reaped_child_pid_declines_to_normal_boot_with_a_reason() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fixture = DataDirFixture::new();
        #[cfg(unix)]
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn short-lived child");
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .expect("spawn short-lived child");
        let pid = child.id();
        assert!(child.wait().expect("reap short-lived child").success());
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string())
            .expect("write reaped daemon pid");

        let attempt = inspect_desktop_attach();

        assert_eq!(attempt.decision, DesktopAttachDecision::NormalBoot);
        assert!(attempt.target.is_none());
        assert!(attempt.reason.contains("references dead pid"));
    }

    #[test]
    fn real_half_written_starting_state_declines_without_panicking() {
        let _env_lock = DATA_DIR_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let fixture = DataDirFixture::new();
        let pid = std::process::id();
        std::fs::write(fixture.path.join("serve.pid"), pid.to_string())
            .expect("write daemon pid");
        std::fs::write(
            fixture.path.join("serve-state.json"),
            format!(
                r#"{{"schema":"o8/serve-state/v1","version":"{}","pid":{pid},"apiPort":47100,"wsPort":47105,"status":"starting""#,
                env!("CARGO_PKG_VERSION")
            ),
        )
        .expect("write truncated daemon state");

        let attempt = std::panic::catch_unwind(inspect_desktop_attach)
            .expect("half-written state must not panic");

        assert_eq!(attempt.decision, DesktopAttachDecision::Coexist);
        assert!(attempt.target.is_none());
        assert!(attempt.reason.contains("malformed serve-state.json"));
    }
}

fn listener_is_stale_current_instance(port: u16, identity: &BootIdentity) -> bool {
    let Some(remote) = fetch_setup_identity(port) else {
        return false;
    };
    remote.product.as_deref() == Some("o8")
        && remote.instance_id.as_deref() == Some(identity.instance_id.as_str())
        && remote.boot_id.as_deref() != Some(identity.boot_id.as_str())
}

fn allocate_identity_gated_api_port(identity: &BootIdentity) -> u16 {
    for port in PROD_API_PORT_RANGE {
        if bundled_sidecar_port_available(port) {
            return port;
        }
        if listener_is_stale_current_instance(port, identity) {
            match classify_port_listener(port) {
                PortListener::Orphan { pid, command }
                | PortListener::Legit { pid, command, .. }
                    if pid != 0 =>
                {
                    log::info!(
                        "[identity-port] :{} stale o8 instance pid={} cmd={:?} — killing",
                        port,
                        pid,
                        command
                    );
                    sidecar_lifecycle::kill_orphan_and_wait(pid, port);
                    if bundled_sidecar_port_available(port) {
                        return port;
                    }
                }
                _ => {
                    log::warn!(
                        "[identity-port] :{} matched stale identity but listener PID was unavailable — skipping",
                        port
                    );
                }
            }
        } else {
            log::info!(
                "[identity-port] :{} occupied by foreign or current listener — trying next",
                port
            );
        }
    }
    let port = bind_ephemeral_port(None);
    log::warn!(
        "[identity-port] production API block occupied — falling back to ephemeral :{}",
        port
    );
    port
}

fn allocate_ws_port(api_port: u16) -> u16 {
    find_free_port(PROD_WS_PORT_RANGE, Some(api_port)).unwrap_or_else(|| {
        let port = bind_ephemeral_port(Some(api_port));
        log::warn!(
            "[identity-port] production WS block occupied — falling back to ephemeral :{}",
            port
        );
        port
    })
}

/// Persist the chosen ports to the data dir so child processes (MCP server,
/// generators) can read the same values without guessing.
fn write_port_file(name: &str, port: u16) -> std::io::Result<()> {
    let dir = o8_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = format!("{}/{}", dir, name);
    std::fs::write(path, port.to_string())
}

// ── Orphan bundled-server detection (issue #509) ──
//
// When the Tauri shell is force-quit (kill -9) or crashes, its child Node
// process (the bundled Next server) can be reparented to launchd (pid 1)
// and keep holding port 3001. The naive `TcpStream::connect(...)` probe
// used to think any listener on :3001 was a legitimate `npm run
// desktop:dev` server and defer to it, leaving the user with a half-dead
// app (orphan Next but no ws-server, stale state, silent hangs).
//
// We now classify the listener before deciding:
//   1. Free      → spawn bundled as normal.
//   2. Active o8 → defer (a dev server or another live sidecar owns it).
//   3. Orphan    → SIGKILL, wait for port release, spawn bundled fresh.
//
// On macOS we shell out to `lsof` / `ps` / `kill` because they're part of
// the base system and avoid pulling in a new crate. On other platforms
// the orphan path is a no-op (tracked for #548 cross-platform work).

/// Lookup result for a port listener classification.
#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum PortListener {
    /// Nothing listening on the port.
    Free,
    /// Legitimate listener. Defer only when it looks o8-owned.
    Legit {
        pid: u32,
        command: String,
        o8_owned: bool,
    },
    /// Orphan reparented to launchd that still owns the bundled server.
    Orphan { pid: u32, command: String },
}

#[cfg(target_os = "macos")]
fn classify_port_listener(port: u16) -> PortListener {
    // First: quick TCP connect probe. Cheap check — if nothing answers we
    // skip lsof entirely.
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_err() {
        return PortListener::Free;
    }

    // Find the owning PID via lsof. `-t` prints only the pid, `-sTCP:LISTEN`
    // filters to listeners, and we scope to the port to keep output tiny.
    let lsof = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{}", port), "-sTCP:LISTEN", "-t"])
        .output();
    let pid = match lsof {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // lsof can return multiple pids on separate lines when IPv4 and
            // IPv6 share the same listener — take the first.
            raw.lines()
                .next()
                .and_then(|s| s.trim().parse::<u32>().ok())
        }
        _ => None,
    };

    let Some(pid) = pid else {
        // Something is listening per TCP connect, but lsof couldn't tell us
        // who. Treat as legit to stay conservative.
        log::warn!(
            "[orphan-check] Port :{} is bound but lsof returned no pid",
            port
        );
        return PortListener::Legit {
            pid: 0,
            command: "<unknown>".to_string(),
            o8_owned: false,
        };
    };

    // Grab the owner's ppid + command line with `ps`. `-o` fields are comma
    // separated in BSD ps; `command` gives the full argv.
    let ps = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid=,command="])
        .output();
    let (ppid, command) = match ps {
        Ok(out) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            // The first whitespace-separated token is ppid; the rest is the
            // full command line (which may itself contain spaces).
            let mut parts = raw.splitn(2, char::is_whitespace);
            let ppid = parts
                .next()
                .and_then(|s| s.trim().parse::<u32>().ok())
                .unwrap_or(0);
            let command = parts.next().unwrap_or("").trim().to_string();
            (ppid, command)
        }
        _ => (0, String::new()),
    };

    let cwd = sidecar_lifecycle::process_cwd(pid);
    log::info!(
        "[orphan-check] :{} bound by pid={} ppid={} cwd={:?} cmd={:?}",
        port,
        pid,
        ppid,
        cwd,
        command
    );

    // Orphan signature: parent is launchd (pid 1) AND the binary path
    // points into the packaged app's server bundle. We accept either
    // `/Applications/o8.app/Contents/Resources/server/server.js` (signed
    // install) or the more general `.app/Contents/Resources/server`
    // substring in case someone installed under a different prefix.
    let looks_bundled = command.contains(".app/Contents/Resources/server")
        || command.contains("/Resources/server/server.js")
        || cwd.contains(".app/Contents/Resources/server")
        || (command.ends_with("server.js") && sidecar_lifecycle::cwd_looks_o8_owned(&cwd));

    if ppid == 1 && looks_bundled {
        PortListener::Orphan { pid, command }
    } else {
        PortListener::Legit {
            pid,
            command,
            o8_owned: sidecar_lifecycle::cwd_looks_o8_owned(&cwd),
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn classify_port_listener(port: u16) -> PortListener {
    // TODO(#548): implement Windows/Linux orphan detection. Until then we
    // fall back to dynamic bundled-port allocation instead of killing or
    // deferring to an unclassified listener.
    if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
        PortListener::Legit {
            pid: 0,
            command: "<unsupported-platform>".to_string(),
            o8_owned: false,
        }
    } else {
        PortListener::Free
    }
}

// ── Child process log capture ──
//
// The bundled Next.js server and WS server each get their own log file
// under `~/.o8/logs/`. On each boot the previous log is rotated to
// `<name>.prev` so we always have the last two runs available for
// post-mortem. Without this, silent production failures (like the hung
// Next.js loop from 2026-04-11) are impossible to diagnose because stderr
// is discarded and there are no devtools in release builds.
//
/// Open a truncating log file at `~/.o8/logs/<name>`, rotating any
/// prior run to `<name>.prev` first. Returns `None` if the filesystem is
/// unwritable (we prefer to keep the app bootable rather than failing loud).
/// Directory for Node's V8 compile cache (Node 22+).
///
/// The Node sidecars spend a large share of their boot simply COMPILING
/// JavaScript. CPU-profiled at boot on the operator's Intel box:
///
///     compile cache OFF   CPU 1401ms   CJS loader 398ms
///     compile cache ON    CPU 1103ms   CJS loader 147ms   (-298ms, 1.27x)
///
/// That is the phase the loader spins in front of, so it is time the operator
/// spends watching a spinner on every launch.
///
/// The cache keys on file CONTENT, so a new build simply misses and repopulates
/// — it cannot serve stale code across an update. It lives in the user data dir,
/// never inside the read-only .app bundle.
/// Boot-time orphan reap, moved off the pre-window path.
///
/// The reaper kills stale `next-server` / `ws-server` processes left by a
/// previous crash. It costs ~73ms (three `pgrep` spawns, plus `ps`/`lsof` per
/// candidate) and it used to run SYNCHRONOUSLY before the window existed, so the
/// operator paid it staring at no window at all.
///
/// It does not need to be there. It needs to be done before we spawn a SIDECAR —
/// those stale processes still hold the SQLite WAL, the microphone and our ports
/// (#1539), and spawning before the reap completes risks two writers on the same
/// WAL. So: reap runs concurrently with window creation, and is JOINED before the
/// first sidecar spawn. The invariant is preserved; only the waiting moved.
///
/// The stale-MCP-socket cleanup is NOT deferred — `tauri-plugin-mcp` binds that
/// socket during builder setup and throws if the file lingers, so it stays on the
/// synchronous pre-builder path. It is a stat + unlink; it costs nothing.
static ORPHAN_REAPER: std::sync::Mutex<Option<std::thread::JoinHandle<()>>> =
    std::sync::Mutex::new(None);

fn start_orphan_reap() {
    let handle = std::thread::spawn(|| {
        sidecar_lifecycle::reap_o8_orphan_processes();
        log::info!("[boot] orphan reap finished at {}ms (off the pre-window path)", boot_ms());
    });
    if let Ok(mut slot) = ORPHAN_REAPER.lock() {
        *slot = Some(handle);
    }
}

/// Block until the boot-time orphan reap has finished.
///
/// MUST be called before ANY sidecar spawn. See `start_orphan_reap`.
fn join_orphan_reap() {
    let handle = ORPHAN_REAPER.lock().ok().and_then(|mut slot| slot.take());
    if let Some(handle) = handle {
        let _ = handle.join();
        log::info!("[boot] orphan reap joined at {}ms — safe to spawn sidecars", boot_ms());
    }
}

/// Bound the V8 compile cache.
///
/// The cache is content-keyed, which is what makes it safe across updates — a new
/// build simply misses and repopulates. But it also means it only ever GROWS:
/// every ship rewrites the Next chunk hashes, so every ship adds a fresh ~5MB
/// generation and nothing ever reclaims the old one. Left alone that is a slow
/// leak in the user's data dir, measured in hundreds of MB after a year of ships.
///
/// So: cap it. If the directory exceeds the cap we delete it wholesale rather than
/// trying to work out which generation is live — it is a CACHE, so the only cost
/// of being wrong is one slower boot while it repopulates. Runs on a worker
/// thread; it never touches the boot path.
const COMPILE_CACHE_CAP_BYTES: u64 = 100 * 1024 * 1024; // ~20 ships' worth

fn prune_compile_cache() {
    std::thread::spawn(|| {
        let dir = compile_cache_dir();
        let path = std::path::Path::new(&dir);
        if !path.is_dir() {
            return;
        }
        let mut total: u64 = 0;
        let mut stack = vec![path.to_path_buf()];
        while let Some(next) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&next) else {
                continue;
            };
            for entry in entries.flatten() {
                match entry.file_type() {
                    Ok(ft) if ft.is_dir() => stack.push(entry.path()),
                    Ok(_) => {
                        if let Ok(meta) = entry.metadata() {
                            total = total.saturating_add(meta.len());
                        }
                    }
                    Err(_) => {}
                }
            }
            // Bail early — we only need to know whether we are OVER the cap, and
            // walking a runaway cache is itself work we should not be doing.
            if total > COMPILE_CACHE_CAP_BYTES {
                break;
            }
        }
        if total > COMPILE_CACHE_CAP_BYTES {
            log::info!(
                "[compile-cache] {}MB exceeds the {}MB cap — clearing (it will repopulate on the next boot)",
                total / (1024 * 1024),
                COMPILE_CACHE_CAP_BYTES / (1024 * 1024)
            );
            let _ = std::fs::remove_dir_all(path);
        }
    });
}

fn compile_cache_dir() -> String {
    format!("{}/compile-cache", o8_data_dir())
}

/// The native approved-write helper for Pi workers (#3289), shipped as an
/// externalBin next to the app binary. The packaged servers refuse approved
/// writes without it.
fn pi_write_helper() -> Option<std::path::PathBuf> {
    let helper = std::env::current_exe().ok()?.parent()?.join("o8-pi-write");
    helper.is_file().then_some(helper)
}

fn open_child_log(name: &str) -> Option<std::fs::File> {
    let dir = format!("{}/logs", o8_data_dir());
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Could not create log dir {}: {}", dir, e);
        return None;
    }
    let path = format!("{}/{}", dir, name);
    let prev = format!("{}.prev", path);
    let _ = std::fs::rename(&path, &prev);
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => {
            log::info!("Child log → {}", path);
            Some(f)
        }
        Err(e) => {
            log::warn!("Could not open child log {}: {}", path, e);
            None
        }
    }
}

/// Build a `Stdio` suitable for piping a child's output to a log file,
/// falling back to discarding the stream if the file couldn't be opened.
fn child_stdio(file: Option<&std::fs::File>) -> std::process::Stdio {
    match file {
        Some(f) => match f.try_clone() {
            Ok(clone) => std::process::Stdio::from(clone),
            Err(_) => std::process::Stdio::null(),
        },
        None => std::process::Stdio::null(),
    }
}

/// Tee one ws-server stream to its dedicated rotated log and tauri-plugin-log.
///
/// The dedicated file keeps full sidecar post-mortems, while the Tauri logger
/// makes `[connect]` audit lines visible in the packaged app's canonical
/// `~/Library/Logs/ai.o8.desktop/o8.log` without requiring a second log hunt.
fn capture_ws_server_stream<R>(
    stream: Option<R>,
    file: Option<std::fs::File>,
    stream_name: &'static str,
    level: log::Level,
) where
    R: std::io::Read + Send + 'static,
{
    let Some(stream) = stream else {
        return;
    };
    std::thread::spawn(move || {
        use std::io::{BufRead, Write};

        let mut file = file;
        for result in std::io::BufReader::new(stream).lines() {
            match result {
                Ok(line) => {
                    if let Some(output) = file.as_mut() {
                        let _ = writeln!(output, "{}", line);
                    }
                    log::log!(level, "[ws-server:{}] {}", stream_name, line);
                }
                Err(error) => {
                    log::warn!(
                        "[ws-server:{}] output capture failed: {}",
                        stream_name,
                        error
                    );
                    break;
                }
            }
        }
    });
}

fn prewarm_bundled_next_server(app: AppHandle, api_port: u16) {
    std::thread::spawn(move || {
        let url = format!("http://127.0.0.1:{}/dashboard", api_port);

        let client = match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };

        // Poll the bundled server until it answers. The dock pill window
        // (system-wide Symon fold P3) is created only AFTER the server is
        // confirmed up — it navigates to /dictation-pill on the same port, so
        // it must not be built against a dead listener (same reason main waits
        // via the loader before /dashboard).
        //
        // Cadence ramps tight -> relaxed rather than a flat 250ms grid. A
        // connect to a port nothing is listening on fails immediately
        // (ECONNREFUSED), so the early attempts cost almost nothing — and when
        // the sidecar does bind we notice it right away instead of waiting out
        // the remainder of a coarse tick. Same ~10s ceiling as the old
        // 40 x 250ms, and no 150ms head start (the window is already painted by
        // the time this runs, so that sleep was pure latency).
        const BACKOFF_MS: [u64; 12] = [20, 20, 40, 40, 60, 80, 120, 160, 200, 250, 250, 250];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut server_up = false;
        let mut attempt = 0usize;
        while std::time::Instant::now() < deadline {
            if client
                .get(&url)
                .header("Connection", "close")
                .send()
                .is_ok()
            {
                server_up = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(
                BACKOFF_MS[attempt.min(BACKOFF_MS.len() - 1)],
            ));
            attempt += 1;
        }

        if !server_up {
            log::warn!("[dock-window] bundled Next server never answered; skipping dock pill");
            return;
        }
        log::info!("[boot] sidecar answering at {}ms — the dashboard can load", boot_ms());

        crate::voice_surfaces::create(&app, api_port);
        // Fleet visibility in the dock — the worker-pulse poller drives the
        // idle sliver's orbiting dot + count while packets are in flight.
        #[cfg(target_os = "macos")]
        {
            agent::worker_pulse::spawn(app.clone());
            agent::calendar_attention::spawn();
        }
    });
}

fn spawn_bundled_ws_server(
    app: &AppHandle,
    node_bin: &str,
    server_dir: &std::path::Path,
    ws_port: u16,
    next_origin: &str,
    ws_log: Option<&std::fs::File>,
    ai_keys: &[(String, String)],
    identity: &BootIdentity,
) {
    let ws_server_js = server_dir.join("ws-server.mjs");
    if ws_server_js.exists() {
        log::info!(
            "Starting WS server: {} {:?} on :{}",
            node_bin,
            ws_server_js,
            ws_port
        );
        let bundled_operator_mcp = server_dir.join("operator-mcp-server.mjs");
        let spawn = BundledWsSpawn {
            data_dir: o8_data_dir(),
            node_bin: node_bin.to_string(),
            server_dir: server_dir.to_path_buf(),
            server_js: ws_server_js,
            ws_port,
            next_origin: next_origin.to_string(),
            boot_identity: identity.clone(),
            bundled_operator_mcp: bundled_operator_mcp
                .exists()
                .then_some(bundled_operator_mcp),
            ai_keys: ai_keys.to_vec(),
        };
        let fatal_app = app.clone();
        match spawn_and_supervise_bundled_ws(
            spawn,
            ws_log.and_then(|file| file.try_clone().ok()),
            move |reason| show_ws_backend_failure_and_exit(&fatal_app, &reason),
        ) {
            Ok((pid, _supervisor)) => log::info!("WS server started (pid: {})", pid),
            Err(e) => {
                log::error!("Failed to start WS server: {}", e);
                show_ws_backend_failure_and_exit(app, &e.to_string());
            }
        }
    } else {
        log::error!(
            "ws-server.mjs missing from bundle at {:?} — this will break the WebSocket bridge and may hang the Next.js server",
            ws_server_js
        );
    }
}

// ── Node.js pre-flight ──
//
// Finder-launched Tauri apps inherit a minimal PATH (`/usr/bin:/bin`) that
// does not include `~/.nvm/...`, `~/.fnm/...`, `~/.volta/bin`, etc. A user
// can have Node perfectly installed in their terminal but the bundled
// server fails to spawn with a cryptic ENOENT.
//
// `resolve_node_via_login_shell()` runs a login shell (zsh → bash → sh) and
// asks it where `node` lives, yielding the real absolute path a terminal
// would see. If nothing works, returns None and the caller shows a dialog.

const MIN_NODE_MAJOR: u32 = 22;
// macOS ships multiple native-addon ABIs. Linux keeps the host-built Node 22
// addons, so it must not accept Node 24 merely because macOS supports it.
// Linux also loads the actual packaged addons before admitting a runtime.
const PREFERRED_NODE_MAJOR: u32 = 22;
const LATEST_SUPPORTED_NODE_MAJOR: u32 = 24;
#[cfg(target_os = "linux")]
const SUPPORTED_NATIVE_NODE_MAJORS: &[u32] = &[PREFERRED_NODE_MAJOR];
#[cfg(not(target_os = "linux"))]
const SUPPORTED_NATIVE_NODE_MAJORS: &[u32] = &[PREFERRED_NODE_MAJOR, LATEST_SUPPORTED_NODE_MAJOR];

/// Look in well-known places for a Node 22.x install regardless of the user's
/// nvm/fnm/volta default. Order matches the rough population of users on each.
fn find_preferred_node_22(server_dir: &std::path::Path) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    find_preferred_node_22_in(&home, |candidate| {
        let version = check_node_version(candidate)?;
        supports_packaged_native_addons(candidate, server_dir).then_some(version)
    })
}

fn find_preferred_node_22_in<F>(home: &str, mut check_node: F) -> Option<String>
where
    F: FnMut(&str) -> Option<(u32, String)>,
{
    let glob_dirs = [
        (format!("{}/.nvm/versions/node", home), "v22"),
        (format!("{}/.fnm/node-versions", home), "v22"),
        // fnm's default root on Linux is $XDG_DATA_HOME/fnm, not ~/.fnm.
        #[cfg(target_os = "linux")]
        (format!("{}/.local/share/fnm/node-versions", home), "v22"),
        (format!("{}/.volta/tools/image/node", home), "22"),
        // Extra Linux manager roots must not change macOS/Windows discovery.
        #[cfg(target_os = "linux")]
        (format!("{}/.asdf/installs/nodejs", home), "22."),
        #[cfg(target_os = "linux")]
        (format!("{}/.local/share/mise/installs/node", home), "22"),
        ("/opt/homebrew/opt/node@22".to_string(), ""),
        ("/usr/local/opt/node@22".to_string(), ""),
        #[cfg(target_os = "linux")]
        ("/home/linuxbrew/.linuxbrew/opt/node@22".to_string(), ""),
    ];
    for (dir, prefix) in glob_dirs {
        // Homebrew's node@22 keg has node directly at <keg>/bin/node — no
        // version-dir traversal needed.
        if prefix.is_empty() {
            let candidate = format!("{}/bin/node", dir);
            if let Some((22, _)) = check_node(&candidate) {
                return Some(candidate);
            }
            continue;
        }
        // nvm / fnm / volta lay out as <root>/<version>/bin/node or
        // <root>/<version>/installation/bin/node (fnm). Scan the version dirs.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.starts_with(prefix) {
                    continue;
                }
                let bases = [
                    entry.path().join("bin").join("node"),
                    entry.path().join("installation").join("bin").join("node"),
                ];
                for base in bases {
                    if let Some(p) = base.to_str() {
                        if let Some((22, _)) = check_node(p) {
                            return Some(p.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn resolve_node_via_login_shell() -> Option<String> {
    let shells: [(&str, &[&str]); 3] = [
        ("zsh", &["-l", "-c", "command -v node"]),
        ("bash", &["-l", "-c", "command -v node"]),
        ("sh", &["-l", "-c", "command -v node"]),
    ];
    for (shell, args) in shells {
        // .no_window() matters here even though these are POSIX shell names: a
        // Windows box with Git Bash DOES resolve `sh`, and this runs inside the
        // node pre-flight that gates the whole boot. An unflagged spawn pops a
        // console, and a console the user CLICKS suspends the process — the
        // same splash-screen deadlock the flag was introduced to kill.
        if let Ok(out) = Command::new(shell).args(args).no_window().output() {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() && std::path::Path::new(&path).exists() {
                    return Some(path);
                }
            }
        }
    }
    // Last resort: raw PATH lookup (in case the user really has it in
    // /usr/local/bin and Finder's PATH is fine).
    if let Ok(out) = Command::new("which").arg("node").no_window().output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return Some(path);
            }
        }
    }
    None
}

/// Directories runtime CLIs (claude / codex / gemini / opencode / gh) are known
/// to land in but that a NON-INTERACTIVE login shell (`zsh -l -c`) often can't
/// see: nvm / fnm / the Claude native installer (~/.local/bin) all add their
/// PATH lines to ~/.zshrc, which only INTERACTIVE shells source. The v0.1.548
/// beta report ("Claude/Gemini not detected" while Codex — brew, ~/.zprofile —
/// showed green) is exactly this gap. Mirrors wellKnownCliDirs() in
/// src/lib/runtimes/shared/cli-locate.ts — keep the two lists in sync.
/// Prepend the login-shell PATH onto this process's PATH so every child we
/// spawn (Next server, ws-server, MCP, dispatched Codex workers) sees the same
/// PATH a terminal would — then append the well-known CLI dirs the login shell
/// itself misses (~/.zshrc-managed entries; see well_known_cli_bin_dirs). Runs
/// even when the login-shell probe fails: the well-known dirs alone rescue CLI
/// detection on machines where no shell probe works. The sidecar still launches
/// on the explicit preflight-approved Node binary (`O8_NODE_BIN`), so this
/// never changes the selected native addon ABI — it only widens what children
/// can find. Dedup'd;
/// minimal PATH kept as fallback.
///
/// `login_path` comes from the single `shell_env::probe_login_shell()` call the
/// boot path already made — we do NOT re-source the user's profile to ask again.
fn augment_process_path(login_path: &str) {
    if login_path.is_empty() {
        log::warn!(
            "Could not resolve login-shell PATH; falling back to the well-known \
             CLI dirs + minimal Finder PATH for sidecar children"
        );
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let well_known = cli_locate::well_known_cli_bin_dirs();
    // PATH entries are ':'-delimited on Unix, ';'-delimited on Windows —
    // `current` is a real inherited PATH on both platforms, so this has to
    // match the OS or every Windows PATH collapses into one bogus entry.
    let path_sep = if cfg!(windows) { ';' } else { ':' };
    let mut merged: Vec<String> = Vec::new();
    for entry in login_path
        .split(path_sep)
        .chain(current.split(path_sep))
        .map(str::to_string)
        .chain(well_known.into_iter())
    {
        if !entry.is_empty() && !merged.contains(&entry) {
            merged.push(entry);
        }
    }
    let entry_count = merged.len();
    let merged = merged.join(&path_sep.to_string());
    log::info!(
        "Augmented PATH from login shell + well-known CLI dirs ({} entries) for sidecar children",
        entry_count
    );
    std::env::set_var("PATH", merged);
}

/// Returns Some((major, raw_version)) on success, None on failure.
///
/// Served from `~/.o8/node-abi-cache` when the binary hasn't changed since we
/// last checked it: exec'ing `node --version` costs ~0.49s on the operator's
/// machine, and it re-derives an answer that only moves when node itself does.
/// The cache is stamped with the binary's (mtime, size), so a node upgrade
/// invalidates the entry and we re-exec — the #1032 ABI pin is preserved.
fn check_node_version(node_bin: &str) -> Option<(u32, String)> {
    shell_env::check_node_version_cached(node_bin)
}

/// Linux exports host-built addons. Loading both catches the actual ABI (and
/// architecture), including a mismatched Node 22 or a stale addon payload.
#[cfg(target_os = "linux")]
fn supports_packaged_native_addons(node_bin: &str, server_dir: &std::path::Path) -> bool {
    let script = r#"
        const path = require('node:path');
        const modules = path.join(process.argv[1], 'node_modules');
        try {
            const Database = require(path.join(modules, 'better-sqlite3'));
            new Database(':memory:').close();
            require(path.join(modules, 'node-pty'));
        } catch { process.exit(1); }
    "#;
    Command::new(node_bin)
        .args(["-e", script])
        .arg(server_dir)
        .no_window()
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

// Preserve the existing macOS/Windows runtime selection without an extra probe.
#[cfg(not(target_os = "linux"))]
fn supports_packaged_native_addons(_node_bin: &str, _server_dir: &std::path::Path) -> bool {
    true
}

fn supports_native_node_major(major: u32) -> bool {
    SUPPORTED_NATIVE_NODE_MAJORS.contains(&major)
}

/// Windows-native fallback: `where node`, then the common install roots
/// (nvm-windows / Volta / fnm / official installer / winget / choco).
/// `resolve_node_via_login_shell()` above only knows zsh/bash/sh, which USUALLY
/// answer nothing on Windows — but not always: a box with Git Bash resolves
/// `sh`, and an MSYS login shell can return a PATH that still has no node on it
/// (installer/nvm-windows touch the Windows PATH, not the MSYS one). So treat
/// that fallback as "usually empty here", never as unreachable, and keep this
/// the actual Windows discovery path (#1740). A no-op on macOS/Linux — one more
/// `None` in an already-exhausted `.or_else` chain there, so behavior stays
/// byte-identical.
#[cfg(target_os = "windows")]
fn resolve_node_windows() -> Option<String> {
    windows_node_locate::resolve_node_via_where()
        .or_else(|| windows_node_locate::find_preferred_node_22(check_node_version))
}

#[cfg(not(target_os = "windows"))]
fn resolve_node_windows() -> Option<String> {
    None
}

#[cfg(test)]
mod node_preflight_tests {
    use super::{find_preferred_node_22_in, supports_native_node_major, PREFERRED_NODE_MAJOR};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempHome {
        path: PathBuf,
    }

    impl TempHome {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "o8-node-preflight-{}-{}-{}",
                name,
                std::process::id(),
                suffix
            ));
            fs::create_dir_all(&path).expect("create temp home");
            Self { path }
        }

        fn str(&self) -> &str {
            self.path.to_str().expect("utf8 temp path")
        }

        fn touch_node(&self, rel: &str) -> PathBuf {
            let path = self.path.join(rel);
            fs::create_dir_all(path.parent().expect("node path parent"))
                .expect("create node parent");
            fs::write(&path, b"fake node").expect("write fake node");
            path
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn checker(path: &str) -> Option<(u32, String)> {
        if !Path::new(path).exists() {
            return None;
        }
        if path.contains("/v22.") || path.contains("/22.") {
            return Some((22, "v22.19.0".to_string()));
        }
        if path.contains("/v24.") || path.contains("/24.") {
            return Some((24, "v24.11.1".to_string()));
        }
        None
    }

    #[test]
    fn preferred_node_discovery_uses_nvm_before_other_managers() {
        let home = TempHome::new("nvm-first");
        let nvm_node = home.touch_node(".nvm/versions/node/v22.19.0/bin/node");
        home.touch_node(".fnm/node-versions/v22.18.0/installation/bin/node");
        home.touch_node(".volta/tools/image/node/22.17.0/bin/node");

        assert_eq!(
            find_preferred_node_22_in(home.str(), checker),
            Some(nvm_node.to_string_lossy().to_string())
        );
    }

    #[test]
    fn preferred_node_discovery_supports_fnm_installation_layout() {
        let home = TempHome::new("fnm-installation");
        let fnm_node = home.touch_node(".fnm/node-versions/v22.18.0/installation/bin/node");

        assert_eq!(
            find_preferred_node_22_in(home.str(), checker),
            Some(fnm_node.to_string_lossy().to_string())
        );
    }

    #[test]
    fn preferred_node_discovery_supports_volta_image_layout() {
        let home = TempHome::new("volta");
        let volta_node = home.touch_node(".volta/tools/image/node/22.17.1/bin/node");

        assert_eq!(
            find_preferred_node_22_in(home.str(), checker),
            Some(volta_node.to_string_lossy().to_string())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preferred_node_discovery_supports_linux_manager_layouts() {
        let fnm = TempHome::new("fnm-xdg");
        let fnm_node =
            fnm.touch_node(".local/share/fnm/node-versions/v22.18.0/installation/bin/node");
        assert_eq!(
            find_preferred_node_22_in(fnm.str(), checker),
            Some(fnm_node.to_string_lossy().to_string())
        );

        let asdf = TempHome::new("asdf");
        let asdf_node = asdf.touch_node(".asdf/installs/nodejs/22.17.0/bin/node");
        assert_eq!(
            find_preferred_node_22_in(asdf.str(), checker),
            Some(asdf_node.to_string_lossy().to_string())
        );

        let mise = TempHome::new("mise");
        let mise_node = mise.touch_node(".local/share/mise/installs/node/22.17.0/bin/node");
        assert_eq!(
            find_preferred_node_22_in(mise.str(), checker),
            Some(mise_node.to_string_lossy().to_string())
        );
    }

    #[test]
    fn preferred_node_discovery_ignores_newer_native_abi_majors() {
        let home = TempHome::new("ignore-newer");
        home.touch_node(".nvm/versions/node/v24.11.1/bin/node");
        home.touch_node(".fnm/node-versions/v24.11.1/installation/bin/node");
        home.touch_node(".volta/tools/image/node/24.11.1/bin/node");

        assert_eq!(find_preferred_node_22_in(home.str(), checker), None);
    }

    #[test]
    fn native_abi_support_matches_shipped_node_majors() {
        assert!(supports_native_node_major(PREFERRED_NODE_MAJOR));
        assert_eq!(supports_native_node_major(24), cfg!(not(target_os = "linux")));
        assert!(!supports_native_node_major(23));
        assert!(!supports_native_node_major(25));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn non_linux_discovery_keeps_main_fallback_order() {
        let home = TempHome::new("platform-order");
        home.touch_node(".local/share/fnm/node-versions/v22.18.0/installation/bin/node");
        home.touch_node(".asdf/installs/nodejs/22.17.0/bin/node");
        home.touch_node(".local/share/mise/installs/node/22.17.0/bin/node");
        let brew = "/opt/homebrew/opt/node@22/bin/node";
        assert_eq!(find_preferred_node_22_in(home.str(), |path| {
            if path == brew { Some((22, "v22.19.0".into())) } else { checker(path) }
        }), Some(brew.into()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_native_abi_support_rejects_node24() {
        assert!(!supports_native_node_major(24));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_install_hint_avoids_distro_version_claims() {
        let hint = super::node_install_hint();
        assert!(!hint.contains("Ubuntu"));
        assert!(!hint.contains("Debian"));
        assert!(hint.contains("Node 22"));
        assert!(hint.contains("nvm install 22"));
    }


    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires a packaged Linux server plus Node 22 and Node 24 binaries"]
    fn linux_preflight_matches_real_packaged_addons() {
        let server = PathBuf::from(std::env::var("O8_TEST_NATIVE_SERVER").expect("packaged server"));
        let node22 = std::env::var("O8_TEST_NODE22").expect("Node 22 binary");
        let node24 = std::env::var("O8_TEST_NODE24").expect("Node 24 binary");
        assert!(super::supports_packaged_native_addons(&node22, &server));
        assert!(!super::supports_packaged_native_addons(&node24, &server));
        assert_eq!(super::run_node_preflight(Some(&node22), &server).unwrap(), node22);
        assert!(!matches!(super::run_node_preflight(Some(&node24), &server), Ok(path) if path == node24));
        let missing = TempHome::new("missing-native-addons");
        assert!(super::run_node_preflight(Some(&node22), &missing.path).is_err());
    }

}

#[derive(Debug)]
enum NodePreflightError {
    Missing,
    TooOld { raw: String },
    UnsupportedNativeAbi { raw: String, major: u32 },
}

/// Full pre-flight: returns the resolved node path on success, or an error
/// describing what to tell the user.
///
/// `shell_node` is whatever `shell_env::probe_login_shell()` already found —
/// the boot path sources the user's profile exactly once, so we reuse that
/// answer instead of spawning another login shell here. Only when the probe
/// came back empty (no shell answered at all) do we fall back to asking
/// directly.
fn run_node_preflight(
    shell_node: Option<&str>,
    server_dir: &std::path::Path,
) -> Result<String, NodePreflightError> {
    let node_bin = shell_node
        .map(str::to_string)
        .or_else(resolve_node_via_login_shell)
        .or_else(|| find_preferred_node_22(server_dir))
        .or_else(resolve_node_windows)
        .ok_or(NodePreflightError::Missing)?;
    let (major, raw) = check_node_version(&node_bin).ok_or(NodePreflightError::Missing)?;
    if major >= MIN_NODE_MAJOR
        && supports_native_node_major(major)
        && supports_packaged_native_addons(&node_bin, server_dir)
    {
        log::info!("Node.js pre-flight OK: {} ({})", raw, node_bin);
        return Ok(node_bin);
    }

    // Preserve #1032's rescue path when the user's default is too old or newer
    // than the ABIs bundled by this release, but do not override a compatible
    // default merely because another Node 22 installation exists.
    if let Some(node22) = find_preferred_node_22(server_dir) {
        if node22 != node_bin {
            if let Some((22, fallback_raw)) = check_node_version(&node22) {
                log::info!(
                    "Node.js pre-flight OK: {} ({}) — default {} is unsupported",
                    fallback_raw,
                    node22,
                    raw
                );
                return Ok(node22);
            }
        }
    }

    if major < MIN_NODE_MAJOR {
        Err(NodePreflightError::TooOld { raw })
    } else {
        Err(NodePreflightError::UnsupportedNativeAbi { raw, major })
    }
}

/// Platform-appropriate "how to install Node" text for the dialog bodies
/// below. macOS/Linux point at brew/nvm; Windows has neither, so it points
/// at the official installer / winget / nvm-windows instead (#1740).
#[cfg(target_os = "windows")]
fn node_install_hint() -> String {
    "Install a supported version from https://nodejs.org, or run \
     `winget install OpenJS.NodeJS.LTS`, then launch o8 again.\n\n\
     If Node.js is already installed via nvm-windows, Volta, or fnm, make sure it\n\
     is on PATH — open a new terminal after installing and confirm `node -v` works."
        .to_string()
}

#[cfg(target_os = "linux")]
fn node_install_hint() -> String {
    format!(
        "Your distribution's Node.js may be too old for this build.\n\
         Install Node {major} with nvm (`nvm install {major}`), fnm (`fnm install {major}`),\n\
         or the NodeSource packages at https://github.com/nodesource/distributions,\n\
         then launch o8 again.\n\n\
         o8 also finds Node {major} under nvm, fnm, Volta, asdf, mise, and Linuxbrew\n\
         even when your default `node` is older.",
        major = PREFERRED_NODE_MAJOR
    )
}

#[cfg(all(not(target_os = "windows"), not(target_os = "linux")))]
fn node_install_hint() -> String {
    format!(
        "Install a supported version with `brew install node@{major}` / `nvm install {major}`\n\
         or `brew install node@{latest}` / `nvm install {latest}`, then launch o8 again.\n\n\
         If Node.js is already installed via nvm, fnm, or Volta, make sure it is\n\
         available to a login shell (zsh/bash with -l flag).",
        major = PREFERRED_NODE_MAJOR,
        latest = LATEST_SUPPORTED_NODE_MAJOR
    )
}

/// Show a native error dialog and exit. Uses platform-native tools so we
/// don't need to pull in tauri-plugin-dialog.
fn show_node_error_and_exit(err: NodePreflightError) -> ! {
    #[cfg(target_os = "linux")]
    let versions = format!("{}.x", PREFERRED_NODE_MAJOR);
    #[cfg(not(target_os = "linux"))]
    let versions = format!("{}.x or {}.x", PREFERRED_NODE_MAJOR, LATEST_SUPPORTED_NODE_MAJOR);
    let (title, body) = match err {
        NodePreflightError::Missing => (
            "Node.js not found",
            format!(
                "o8 needs Node.js {versions} to run its backend.\n\n{hint}",
                hint = node_install_hint()
            ),
        ),
        NodePreflightError::TooOld { raw } => (
            "Node.js is too old",
            format!(
                "o8 needs Node.js {versions} but found {raw}.\n\n{hint}",
                raw = raw,
                hint = node_install_hint()
            ),
        ),
        #[cfg(target_os = "linux")]
        NodePreflightError::UnsupportedNativeAbi { raw, .. } => (
            "Node.js is not compatible with this o8 build",
            format!(
                "o8 found {raw}, but this Linux build requires Node {major}.x with matching native addons.\n\n{hint}",
                major = PREFERRED_NODE_MAJOR,
                hint = node_install_hint()
            ),
        ),
        #[cfg(not(target_os = "linux"))]
        NodePreflightError::UnsupportedNativeAbi { raw, major: found_major } => (
            "Node.js version is not supported by o8 yet",
            format!(
                "o8 found {raw}, but this build ships native addons for Node {major}.x and {latest}.x.\n\n\
                 Install Node {major} with `brew install node@{major}` or `nvm install {major}`,\n\
                 then launch o8 again. If you use nvm, also run `nvm alias default {major}`.\n\n\
                 Node {found_major}.x support needs matching native addon prebuilds before o8 can run on it.",
                major = PREFERRED_NODE_MAJOR,
                latest = LATEST_SUPPORTED_NODE_MAJOR,
                raw = raw,
                found_major = found_major
            ),
        ),
    };

    log::error!("{}: {}", title, body);

    #[cfg(target_os = "macos")]
    {
        // osascript is always available on macOS. Escape quotes for AppleScript.
        let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display dialog "{}" with title "{}" buttons {{"Download Node.js", "Quit"}} default button "Download Node.js" with icon stop"#,
            escape(&body),
            escape(title)
        );
        let out = Command::new("osascript").args(["-e", &script]).output();
        let clicked_download = out
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.contains("Download Node.js"))
            .unwrap_or(false);
        if clicked_download {
            let _ = Command::new("open").arg("https://nodejs.org").spawn();
        }
    }

    #[cfg(target_os = "windows")]
    {
        // mshta shows a VBScript message box without extra deps.
        let escape = |s: &str| s.replace('"', "\"\"").replace('\n', " ");
        let script = format!(
            r#"javascript:var r=confirm("{}\n\nClick OK to open nodejs.org.");if(r)new ActiveXObject("WScript.Shell").Run("cmd /c start https://nodejs.org",1,false);window.close();"#,
            escape(&format!("{}: {}", title, body))
        );
        let _ = Command::new("mshta").arg(script).spawn();
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        // Linux fallback — try zenity / kdialog, otherwise just stderr.
        let full = format!("{}\n\n{}", title, body);
        let _ = Command::new("zenity")
            .args(["--error", "--title", title, "--text", &full])
            .status()
            .or_else(|_| Command::new("kdialog").args(["--error", &full]).status());
        eprintln!("{}: {}", title, body);
    }

    std::process::exit(1);
}

/// Desktop info exposed to the React frontend via invoke
#[derive(Serialize)]
pub struct DesktopInfo {
    pub is_desktop: bool,
    pub platform: String,
    pub version: String,
    pub arch: String,
}

/// Result from spawning the WS server sidecar
#[derive(Serialize)]
pub struct SidecarResult {
    pub ok: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

/// Get desktop environment info
#[tauri::command]
fn get_desktop_info() -> DesktopInfo {
    DesktopInfo {
        is_desktop: true,
        platform: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// Return the once-per-launch macOS signature assessment for the running app.
/// The launch updater starts the check during boot; this command replays the
/// cached result so the webview cannot miss the warning event during startup.
#[tauri::command]
fn get_running_bundle_integrity() -> launch_updater::BundleIntegrityStatus {
    launch_updater::running_bundle_integrity()
}

/// Check if a process is listening on a given port
#[tauri::command]
fn check_port(port: u16) -> bool {
    std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok()
}

/// Restart the app, killing the bundled Node children FIRST.
///
/// The Tauri plugin-process `relaunch()` (and `AppHandle::restart()` underneath
/// it) spawns the new instance and then `std::process::exit()`s the old one —
/// WITHOUT going through the `RunEvent::ExitRequested`/`Exit` path where
/// `kill_tracked_children()` runs. So on an auto-update relaunch the old
/// next-server / ws-server children survived, kept holding the API/WS ports,
/// and the freshly-installed instance came up unable to bind — the "stuck in
/// restart / reconnecting" zombie observed live 2026-07-03. The UpdateCard
/// calls THIS command instead of the raw plugin relaunch so the children are
/// reaped and the ports freed before the new instance boots.
#[tauri::command]
fn restart_app(app: tauri::AppHandle, reservation_id: Option<String>) -> Result<(), String> {
    app.state::<o8_restart_safety::RestartSafety>().before_restart(reservation_id.as_deref())?;
    app.restart();
}

#[tauri::command]
fn prepare_app_restart(app: tauri::AppHandle, force: Option<bool>) -> Result<String, String> {
    app.state::<o8_restart_safety::RestartSafety>().prepare_with_work(force.unwrap_or(false))
}

#[tauri::command]
fn cancel_app_restart(app: tauri::AppHandle, reservation_id: String) -> Result<(), String> {
    app.state::<o8_restart_safety::RestartSafety>().cancel(&reservation_id)
}

/// Start the WebSocket server as a background process
#[tauri::command]
fn start_ws_server(project_dir: String) -> SidecarResult {
    match Command::new("npx")
        .args(["tsx", "src/ws-server.ts"])
        .current_dir(&project_dir)
        .no_window()
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(child) => SidecarResult {
            ok: true,
            pid: Some(child.id()),
            error: None,
        },
        Err(e) => SidecarResult {
            ok: false,
            pid: None,
            error: Some(e.to_string()),
        },
    }
}

/// Check if Cortex binary is available
#[tauri::command]
fn cortex_available() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let cortex_path = format!("{}/bin/cortex", home);
    std::path::Path::new(&cortex_path).exists()
}

/// Get the app data directory for persistent storage
#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Option<String> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

// ── IPC-accelerated data commands ──
// These bypass HTTP, serving data directly via Tauri IPC (~0.5ms vs ~5-10ms).

/// Read the repo registry from disk. Returns { repos: [...] }.
/// Equivalent to GET /api/panel/repos but without readiness enrichment.
#[tauri::command]
fn read_repos() -> Result<serde_json::Value, String> {
    let repos_path = format!("{}/repos.json", o8_data_dir());
    let content = std::fs::read_to_string(&repos_path)
        .map_err(|e| format!("Failed to read repos.json: {}", e))?;
    let store: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse repos.json: {}", e))?;
    // repos.json has { repos: [...], ... } — return the whole store
    Ok(store)
}

/// Read recent git commits for a local repo path.
/// Equivalent to GET /api/panel/commits?workspace=<path>&limit=<n>
#[tauri::command]
fn read_local_commits(repo: String, limit: Option<u32>) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(10).min(50);
    let output = Command::new("git")
        .no_window()
        .args([
            "log",
            &format!("--max-count={}", limit),
            "--date=iso-strict",
            "--format=%H\x1f%an\x1f%aI\x1f%s",
        ])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git log failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git log error: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits: Vec<serde_json::Value> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(4, '\x1f').collect();
            serde_json::json!({
                "hash": parts.first().unwrap_or(&""),
                "author": parts.get(1).unwrap_or(&""),
                "date": parts.get(2).unwrap_or(&""),
                "message": parts.get(3).unwrap_or(&""),
            })
        })
        .collect();

    Ok(serde_json::json!({ "commits": commits, "workspace": repo }))
}

/// Read git worktrees for a local repo path.
/// Equivalent to GET /api/worktrees?repo=<path>
#[tauri::command]
fn read_worktrees(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .no_window()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git worktree list failed: {}", e))?;

    if !output.status.success() {
        return Ok(serde_json::json!({ "worktrees": [] }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees: Vec<serde_json::Value> = Vec::new();
    let mut path = String::new();
    let mut head = String::new();
    let mut branch = String::new();
    let mut is_bare = false;

    for line in stdout.lines() {
        if line.starts_with("worktree ") {
            // Flush previous entry
            if !path.is_empty() {
                worktrees.push(serde_json::json!({
                    "path": path,
                    "head": head,
                    "branch": branch,
                    "bare": is_bare,
                }));
            }
            path = line[9..].to_string();
            head.clear();
            branch.clear();
            is_bare = false;
        } else if line.starts_with("HEAD ") {
            head = line[5..].to_string();
        } else if line.starts_with("branch ") {
            branch = line[7..].trim_start_matches("refs/heads/").to_string();
        } else if line == "bare" {
            is_bare = true;
        }
    }
    // Flush last entry
    if !path.is_empty() {
        worktrees.push(serde_json::json!({
            "path": path,
            "head": head,
            "branch": branch,
            "bare": is_bare,
        }));
    }

    Ok(serde_json::json!({ "worktrees": worktrees }))
}

/// Read the current git branch for a repo.
#[tauri::command]
fn read_current_branch(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .no_window()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git rev-parse failed: {}", e))?;

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(serde_json::json!({ "branch": branch }))
}

/// Read git status (changed files count) for a repo.
#[tauri::command]
fn read_git_status(repo: String) -> Result<serde_json::Value, String> {
    let output = Command::new("git")
        .no_window()
        .args(["status", "--porcelain"])
        .current_dir(&repo)
        .output()
        .map_err(|e| format!("git status failed: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let changed_files: usize = stdout.lines().filter(|l| !l.is_empty()).count();
    Ok(serde_json::json!({ "changedFiles": changed_files, "clean": changed_files == 0 }))
}

// ── MCP loop observability (issues #793, #794) ──
//
// Two MCP tools that close gaps in the autonomous dogfood loop's
// observability when the webview's JS thread is busy. Both keep their
// state on the Rust side so the data is captured / queried even when
// page-side eval calls are slow:
//
//   - `o8_view_console_errors`: an in-process ring buffer (cap 100, FIFO
//     eviction) populated by an injected JS hook that wraps `console.error`
//     + listens for `error` / `unhandledrejection` events and posts each
//     one back through `__TAURI_INTERNALS__.invoke('record_console_error', …)`.
//     The MCP read returns `{ errors, count, sinceLastFetch }` and resets
//     the per-fetch counter on every call.
//
//   - `o8_view_active_route`: returns the main webview's current URL parts
//     by calling `webview.url()` directly (no JS-thread crossing on the
//     read side; the MCP transport still goes through the plugin's
//     execute_js bridge — see operator-mcp-server.ts). The Next.js
//     router segment is intentionally returned as `null` for now;
//     extracting it requires JS-side state that is harder to reach
//     without an eval round-trip.

const CONSOLE_ERROR_BUFFER_CAP: usize = 100;

#[derive(Clone, Serialize)]
struct ConsoleError {
    message: String,
    source: String,
    lineno: u32,
    timestamp: u64,
}

struct ConsoleErrorBuffer {
    errors: VecDeque<ConsoleError>,
    /// Errors recorded since the last `o8_view_console_errors` call. Counter
    /// resets on every read, so consecutive calls show only the delta.
    since_last_fetch: u32,
}

fn console_errors() -> &'static Mutex<ConsoleErrorBuffer> {
    static BUFFER: OnceLock<Mutex<ConsoleErrorBuffer>> = OnceLock::new();
    BUFFER.get_or_init(|| {
        Mutex::new(ConsoleErrorBuffer {
            errors: VecDeque::with_capacity(CONSOLE_ERROR_BUFFER_CAP),
            since_last_fetch: 0,
        })
    })
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Tauri command invoked by the injected JS hook. Pushes one error onto the
/// ring buffer, evicting the oldest entry when capacity is reached, and
/// bumps the per-fetch counter that `o8_view_console_errors` resets on read.
#[tauri::command]
fn record_console_error(message: String, source: String, lineno: u32) {
    // #932: also log to sidecar so the ring buffer is visible without going
    // through o8_view_console_errors (which goes through the broken eval path).
    log::info!(
        "[webview-console] {} (source={} line={})",
        message.chars().take(400).collect::<String>(),
        source,
        lineno
    );
    // The MCP eval bridge fires three '[mcp-*]' lifecycle beacons per call
    // (#932 parallel-channel diagnostic). They stay visible in the sidecar
    // log line above, but must not enter the ring: at cap 100 a busy MCP
    // session evicts every real error and o8_view_console_errors reads as
    // pure beacon spam (2026-06-11 surface walk).
    if source == "tauri-plugin-mcp" {
        return;
    }
    let Ok(mut buffer) = console_errors().lock() else {
        return;
    };
    if buffer.errors.len() >= CONSOLE_ERROR_BUFFER_CAP {
        buffer.errors.pop_front();
    }
    buffer.errors.push_back(ConsoleError {
        message,
        source,
        lineno,
        timestamp: now_unix_ms(),
    });
    buffer.since_last_fetch = buffer.since_last_fetch.saturating_add(1);
}

// ── #1136 read_dropped_file ──
//
// Backing command for the Tauri drag-drop bridge. The frontend receives
// paths via the `o8:tauri-file-drop` window event (emitted from
// on_window_event below), then calls this command to read the bytes.
// Done in Rust (not behind an HTTP route) so there is no auth surface
// to abuse — invokes are scoped to the webview origin.

const DROPPED_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
struct DroppedFileResult {
    name: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    #[serde(rename = "contentBase64")]
    content_base64: String,
    size: u64,
}

fn base64_encode_standard(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as u32
        } else {
            0
        };
        out.push(TABLE[((b0 >> 2) & 0x3f) as usize] as char);
        out.push(TABLE[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize] as char);
        if i + 1 < data.len() {
            out.push(TABLE[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < data.len() {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn mime_for_extension(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" | "heif" => "image/heic",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "md" | "markdown" | "mdx" => "text/markdown",
        "txt" | "log" | "csv" | "tsv" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "application/javascript",
        "ts" | "tsx" | "jsx" => "text/typescript",
        "py" => "text/x-python",
        "rs" => "text/x-rust",
        "go" => "text/x-go",
        "java" => "text/x-java",
        "rb" => "text/x-ruby",
        "sh" | "bash" | "zsh" => "application/x-sh",
        "yaml" | "yml" => "application/yaml",
        "toml" => "application/toml",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
fn read_dropped_file(path: String) -> Result<DroppedFileResult, String> {
    // Whitelist: must be a regular file within $HOME. Blocks /etc/*,
    // /var/log/*, /private/var/db/*, and anything an operator could be
    // tricked into "dropping" via a malicious link or page.
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let path_buf = std::path::PathBuf::from(&path);
    let canonical = path_buf
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {}", e))?;
    let home_canonical = std::path::PathBuf::from(&home)
        .canonicalize()
        .map_err(|e| format!("canonicalize $HOME failed: {}", e))?;
    if !canonical.starts_with(&home_canonical) {
        return Err(format!("path outside $HOME: {}", canonical.display()));
    }

    let metadata = std::fs::metadata(&canonical).map_err(|e| format!("stat failed: {}", e))?;
    if !metadata.is_file() {
        return Err("path is not a regular file".to_string());
    }
    if metadata.len() > DROPPED_FILE_MAX_BYTES {
        return Err(format!(
            "file too large: {} bytes (max {})",
            metadata.len(),
            DROPPED_FILE_MAX_BYTES
        ));
    }

    let bytes = std::fs::read(&canonical).map_err(|e| format!("read failed: {}", e))?;
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dropped".to_string());
    let mime_type = mime_for_extension(&name).to_string();
    let content_base64 = base64_encode_standard(&bytes);

    Ok(DroppedFileResult {
        name,
        mime_type,
        content_base64,
        size: metadata.len(),
    })
}

/// #932 — host-app `mcp_result` command. Lives in the main app (NOT the
/// plugin) because plugin invokes were silently denied by the ACL across
/// every capability scoping we tried. The main-app `record_console_error`
/// uses the same un-prefixed pattern and is empirically working.
///
/// JS calls: `__TAURI_INTERNALS__.invoke('mcp_result', { correlationId, ok, data, error })`
///
/// Note: separate params (not a struct) — Tauri command framework wraps
/// struct params in an `args` key, but separate params get individually
/// JSON-mapped from JS. `rename_all = "camelCase"` lets JS send camelCase
/// keys while Rust uses snake_case. This works for host-app commands
/// because there's no permission file to fight with — only plugin commands
/// have the rename-renames-the-command-name problem.
#[tauri::command(rename_all = "camelCase")]
fn mcp_result(
    correlation_id: String,
    ok: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
) {
    log::info!(
        "[mcp_result] cid={} ok={} has_data={} has_error={}",
        correlation_id,
        ok,
        data.is_some(),
        error.is_some()
    );
    let payload = serde_json::json!({
        "ok": ok,
        "data": data,
        "error": error,
    });
    #[cfg(feature = "dev-mcp-plugin")]
    tauri_plugin_mcp::tools::webview::PendingResults::complete(&correlation_id, payload);
    #[cfg(not(feature = "dev-mcp-plugin"))]
    {
        let _ = payload;
        log::warn!("[mcp_result] dev-mcp-plugin disabled; dropping result");
    }
}

/// MCP read path. Returns the full ring buffer plus the count since the
/// previous call (which resets to zero after this returns).
#[tauri::command]
fn o8_view_console_errors() -> serde_json::Value {
    let Ok(mut buffer) = console_errors().lock() else {
        return serde_json::json!({ "errors": [], "count": 0, "sinceLastFetch": 0 });
    };
    let errors: Vec<ConsoleError> = buffer.errors.iter().cloned().collect();
    let count = errors.len();
    let since_last_fetch = buffer.since_last_fetch;
    buffer.since_last_fetch = 0;
    serde_json::json!({
        "errors": errors,
        "count": count,
        "sinceLastFetch": since_last_fetch,
    })
}

/// Read the main webview's current URL via `webview.url()` and split it into
/// pathname / search / hash. `routerState` is intentionally `null` — the
/// Next.js segment isn't reachable without a JS-side eval, which we defer.
#[tauri::command]
fn o8_view_active_route(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Err("main webview not found".to_string());
    };
    let url = window
        .url()
        .map_err(|e| format!("webview.url() failed: {}", e))?;
    let pathname = url.path().to_string();
    let search = match url.query() {
        Some(q) if !q.is_empty() => format!("?{}", q),
        _ => String::new(),
    };
    let hash = match url.fragment() {
        Some(f) if !f.is_empty() => format!("#{}", f),
        _ => String::new(),
    };
    Ok(serde_json::json!({
        "pathname": pathname,
        "search": search,
        "hash": hash,
        "routerState": serde_json::Value::Null,
    }))
}

// ── SQLite helper (read-only, WAL mode) ──

fn open_cortex_db() -> Result<Connection, String> {
    let db_path = format!("{}/cortex-ide.db", o8_data_dir());
    if !std::path::Path::new(&db_path).exists() {
        return Err("db_not_found".to_string());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&db_path, flags)
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    conn.pragma_update(None, "journal_mode", "wal")
        .map_err(|e| format!("Failed to set WAL: {}", e))?;
    Ok(conn)
}

/// Read pending approvals from SQLite. Returns { approvals: [...] }.
/// Equivalent to GET /api/panel/approvals (pending only, no session filter).
#[tauri::command]
fn read_approvals(status: Option<String>) -> Result<serde_json::Value, String> {
    let conn = match open_cortex_db() {
        Ok(c) => c,
        Err(e) if e == "db_not_found" => {
            return Ok(serde_json::json!({ "approvals": [] }));
        }
        Err(e) => return Err(e),
    };

    let filter_status = status.unwrap_or_else(|| "pending".to_string());
    let use_filter = filter_status != "all";

    let approvals: Vec<serde_json::Value> = if use_filter {
        let mut stmt = conn
            .prepare(
                "SELECT id, source, runtime, agent, session_key, title, description, summary,
                        tool_name, args_json, command, editable, diff_json, risk,
                        metadata_json, packet_id, lane_id, policy_rule_id,
                        status, created_at, updated_at, resolved_at,
                        resolution_json, audit_json, fingerprint, continuation_json
                 FROM approvals
                 WHERE status = ?1
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("SQL prepare failed: {}", e))?;
        let result: Vec<serde_json::Value> = stmt
            .query_map(rusqlite::params![filter_status], |row| {
                Ok(map_approval_row(row))
            })
            .map_err(|e| format!("Query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        result
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, source, runtime, agent, session_key, title, description, summary,
                        tool_name, args_json, command, editable, diff_json, risk,
                        metadata_json, packet_id, lane_id, policy_rule_id,
                        status, created_at, updated_at, resolved_at,
                        resolution_json, audit_json, fingerprint, continuation_json
                 FROM approvals
                 ORDER BY created_at DESC",
            )
            .map_err(|e| format!("SQL prepare failed: {}", e))?;
        let result: Vec<serde_json::Value> = stmt
            .query_map([], |row| Ok(map_approval_row(row)))
            .map_err(|e| format!("Query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        result
    };

    Ok(serde_json::json!({ "approvals": approvals }))
}

fn map_approval_row(row: &rusqlite::Row) -> serde_json::Value {
    let id: String = row.get(0).unwrap_or_default();
    let source: String = row.get(1).unwrap_or_default();
    let runtime: String = row.get(2).unwrap_or_default();
    let agent: String = row.get(3).unwrap_or_default();
    let session_key: String = row.get(4).unwrap_or_default();
    let title: String = row.get(5).unwrap_or_default();
    let description: String = row.get(6).unwrap_or_default();
    let summary: String = row.get(7).unwrap_or_default();
    let tool_name: Option<String> = row.get(8).ok();
    let args_json: Option<String> = row.get(9).ok();
    let command: Option<String> = row.get(10).ok();
    let editable: Option<bool> = row.get(11).ok();
    let diff_json: Option<String> = row.get(12).ok();
    let risk: String = row.get(13).unwrap_or_default();
    let metadata_json: Option<String> = row.get(14).ok();
    let _packet_id: Option<String> = row.get::<_, Option<String>>(15).ok().flatten();
    let _lane_id: Option<String> = row.get::<_, Option<String>>(16).ok().flatten();
    let policy_rule_id: Option<String> = row.get(17).ok();
    let status: String = row.get(18).unwrap_or_default();
    let created_at: i64 = row.get(19).unwrap_or(0);
    let updated_at: i64 = row.get(20).unwrap_or(0);
    let resolved_at: Option<i64> = row.get(21).ok();
    let resolution_json: Option<String> = row.get(22).ok();
    let audit_json: String = row.get(23).unwrap_or_else(|_| "[]".to_string());
    let fingerprint: String = row.get(24).unwrap_or_default();
    let continuation_json: Option<String> = row.get(25).ok();

    let args = args_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let diff = diff_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let metadata = metadata_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let resolution = resolution_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
    let audit: serde_json::Value =
        serde_json::from_str(&audit_json).unwrap_or(serde_json::json!([]));
    let continuation = continuation_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());

    serde_json::json!({
        "id": id,
        "source": source,
        "runtime": runtime,
        "agent": agent,
        "sessionKey": session_key,
        "title": title,
        "description": description,
        "summary": summary,
        "toolName": tool_name,
        "args": args,
        "command": command,
        "editable": editable,
        "diff": diff,
        "risk": risk,
        "metadata": metadata,
        "policyRuleId": policy_rule_id,
        "status": status,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "resolvedAt": resolved_at,
        "resolution": resolution,
        "audit": audit,
        "fingerprint": fingerprint,
        "continuation": continuation,
    })
}

/// Read watched agents from SQLite. Returns { workspaces: [...] }.
/// Lightweight IPC snapshot of durable supervisor state.
#[tauri::command]
fn read_workspaces() -> Result<serde_json::Value, String> {
    let conn = match open_cortex_db() {
        Ok(c) => c,
        Err(e) if e == "db_not_found" => {
            return Ok(serde_json::json!({ "workspaces": [] }));
        }
        Err(e) => return Err(e),
    };

    let mut stmt = conn
        .prepare(
            "SELECT surface_id, repo_path, name, prompt, registered_at,
                    last_status, retry_count, steer_count,
                    completion_reported, last_event_at, last_activity_at
             FROM watched_agents
             ORDER BY last_activity_at DESC",
        )
        .map_err(|e| format!("SQL prepare failed: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let surface_id: String = row.get(0).unwrap_or_default();
            let repo_path: String = row.get(1).unwrap_or_default();
            let name: String = row.get(2).unwrap_or_default();
            let prompt: String = row.get(3).unwrap_or_default();
            let registered_at: i64 = row.get(4).unwrap_or(0);
            let last_status: String = row.get(5).unwrap_or_default();
            let retry_count: i64 = row.get(6).unwrap_or(0);
            let steer_count: i64 = row.get(7).unwrap_or(0);
            let completion_reported: bool = row.get(8).unwrap_or(false);
            let last_event_at: i64 = row.get(9).unwrap_or(0);
            let last_activity_at: i64 = row.get(10).unwrap_or(0);

            Ok(serde_json::json!({
                "surfaceId": surface_id,
                "repoPath": repo_path,
                "name": name,
                "prompt": prompt,
                "registeredAt": registered_at,
                "lastStatus": last_status,
                "retryCount": retry_count,
                "steerCount": steer_count,
                "completionReported": completion_reported,
                "lastEventAt": last_event_at,
                "lastActivityAt": last_activity_at,
            }))
        })
        .map_err(|e| format!("Query failed: {}", e))?;

    let workspaces: Vec<serde_json::Value> = rows.filter_map(|r| r.ok()).collect();

    Ok(serde_json::json!({ "workspaces": workspaces }))
}

// ── Tray badge + native weapons (issue #731) ──
//
// Two native macOS features that differentiate o8 from web/Electron rivals:
//
//   1. Native notifications when a packet flips to `awaiting_review`. Fired
//      from the frontend (which already holds the WS lane stream) via the
//      `notify_review_ready` Tauri command. The macOS notification plugin
//      doesn't expose action buttons natively (notify-rust limitation), so
//      clicking the notification raises the app focused on the review card —
//      "Approve / Reject" stay as in-app affordances for v1.
//
//   2. Menu bar tray with live "[N]" badge for pending reviews. The tray
//      already exists; we now keep its title in sync by polling the lanes
//      API every 5s. `set_tray_badge` is also exposed as a Tauri command so
//      the frontend can push exact counts when WS lane events arrive (faster
//      than waiting for the next poll tick).

/// Shared handle to the menu bar tray icon. Stored once on `setup()` so
/// background polls and frontend commands can update its title without
/// re-creating the tray.
fn tray_handle() -> &'static Mutex<Option<TrayIcon>> {
    static HANDLE: OnceLock<Mutex<Option<TrayIcon>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

fn store_tray(tray: TrayIcon) {
    if let Ok(mut guard) = tray_handle().lock() {
        *guard = Some(tray);
    }
}

/// Update the macOS menu bar tray title with a count badge. Hides the badge
/// (sets to None) when count is 0 so the icon sits clean. macOS only — on
/// other platforms `set_title` is a no-op, which is fine: we still update the
/// tooltip elsewhere.
fn apply_tray_badge(count: u32) {
    let Ok(guard) = tray_handle().lock() else {
        return;
    };
    let Some(tray) = guard.as_ref() else { return };
    let title = if count == 0 {
        None
    } else {
        Some(format!("[{}]", count))
    };
    if let Err(err) = tray.set_title(title.as_deref()) {
        log::warn!("[tray-badge] set_title failed: {}", err);
    }
    // Tooltip mirrors the count so accessibility tools report it too.
    let tooltip = if count == 0 {
        "o8".to_string()
    } else {
        format!("o8 — {} awaiting review", count)
    };
    let _ = tray.set_tooltip(Some(tooltip));
}

/// Read a UTF-8 file from the o8 data dir, trimming whitespace. Used to pick
/// up the dynamic API port and ws-token written by the sidecar.
fn read_data_file(name: &str) -> Option<String> {
    let path = format!("{}/{}", o8_data_dir(), name);
    std::fs::read_to_string(&path)
        .ok()
        .map(|s| s.trim().to_string())
}

/// Resolve the API port the Next server is bound to. Mirrors the precedence
/// in `src/lib/panel/api-port.ts` — env var first, on-disk file second,
/// production default last.
pub(crate) fn resolve_api_port() -> u16 {
    if let Ok(p) = std::env::var("O8_API_PORT") {
        if let Ok(parsed) = p.parse() {
            return parsed;
        }
    }
    if let Some(raw) = read_data_file("api-port") {
        if let Ok(parsed) = raw.parse() {
            return parsed;
        }
    }
    PROD_API_DEFAULT_PORT
}

/// Read the cross-origin auth token. Empty string if missing — the loopback
/// origin path (which we use here) doesn't strictly need it but we send it
/// when present so the request also works under future hardenings.
fn resolve_ws_token() -> String {
    read_data_file("ws-token").unwrap_or_default()
}

/// Background HTTP GET against the local Next server. Uses a raw TCP write so
/// we don't pull in a new HTTP crate. The response body is small (lanes JSON,
/// hundreds of bytes per active lane). Bounded read keeps us safe from a
/// runaway server. Returns `None` on any error — callers fall back to the
/// previous count.
fn http_get_local(path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::time::Duration;
    let port = resolve_api_port();
    let token = resolve_ws_token();
    let addr = format!("127.0.0.1:{}", port);
    let mut stream =
        std::net::TcpStream::connect_timeout(&addr.parse().ok()?, Duration::from_millis(750))
            .ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_millis(1500)))
        .ok();
    let auth = if token.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {}\r\n", token)
    };
    let req = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{}Connection: close\r\nAccept: application/json\r\n\r\n",
        path, port, auth
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 1024 * 1024 {
                    break;
                } // 1 MiB cap
            }
            Err(_) => break,
        }
    }
    let raw = String::from_utf8_lossy(&buf).to_string();
    // Split off HTTP headers — body starts after the first \r\n\r\n.
    let body_start = raw.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
    Some(raw[body_start..].to_string())
}

fn desktop_close_preference_path() -> String {
    format!("{}/desktop-close-preference", o8_data_dir())
}

fn read_desktop_close_preference() -> DesktopClosePreference {
    std::fs::read_to_string(desktop_close_preference_path())
        .ok()
        .and_then(|value| DesktopClosePreference::parse(&value))
        .unwrap_or(DesktopClosePreference::Ask)
}

fn persist_desktop_close_preference(preference: DesktopClosePreference) -> Result<(), String> {
    std::fs::create_dir_all(o8_data_dir()).map_err(|error| error.to_string())?;
    std::fs::write(desktop_close_preference_path(), preference.as_str())
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn set_tray_visible(visible: bool) {
    let Ok(guard) = tray_handle().lock() else {
        return;
    };
    let Some(tray) = guard.as_ref() else { return };
    if let Err(error) = tray.set_visible(visible) {
        log::warn!("[desktop-close] tray visibility update failed: {error}");
    }
}

fn show_desktop_window(app: &AppHandle) {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    set_tray_visible(false);
    background::set_background_mode(app, false, true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Bring up the window the operator works in: o8 next in the packaged macOS
/// app, the classic window everywhere else.
fn show_main_ui(app: &AppHandle) {
    if next_main::enabled() {
        next_main::show();
    } else {
        show_desktop_window(app);
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn background_desktop_app(app: &AppHandle) {
    set_tray_visible(true);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app.emit("window-hidden", ());

    let notice_marker = format!("{}/desktop-background-notice-seen", o8_data_dir());
    if !Path::new(&notice_marker).exists() {
        match app
            .notification()
            .builder()
            .title("o8 is still working")
            .body("Open o8 from the system tray when you are ready to return.")
            .show()
        {
            Ok(()) => {
                let _ = std::fs::write(notice_marker, "1");
            }
            Err(error) => log::warn!("[desktop-close] background notice failed: {error}"),
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn handle_desktop_close(app: AppHandle) {
    let working_count = http_get_local("/api/lanes?active=true")
        .as_deref()
        .and_then(desktop_close::working_lane_count);
    let preference = read_desktop_close_preference();

    if working_count == Some(0) || preference == DesktopClosePreference::Quit {
        app.exit(0);
        return;
    }

    if preference == DesktopClosePreference::Background {
        background_desktop_app(&app);
        return;
    }

    let _ = app.emit(
        "desktop-close-requested",
        DesktopCloseRequest { working_count },
    );
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn desktop_close_resolution_pending() -> &'static AtomicBool {
    static PENDING: AtomicBool = AtomicBool::new(false);
    &PENDING
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn request_desktop_close(app: AppHandle) {
    if desktop_close_resolution_pending().swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || {
        handle_desktop_close(app);
        desktop_close_resolution_pending().store(false, Ordering::Release);
    });
}

#[tauri::command]
fn desktop_close_preference_get() -> String {
    read_desktop_close_preference().as_str().to_string()
}

#[tauri::command]
fn desktop_close_preference_set(preference: String) -> Result<String, String> {
    let preference = DesktopClosePreference::parse(&preference)
        .ok_or_else(|| "Close preference must be ask, background, or quit".to_string())?;
    persist_desktop_close_preference(preference)?;
    Ok(preference.as_str().to_string())
}

#[tauri::command]
fn resolve_desktop_close(app: AppHandle, action: String, remember: bool) -> Result<bool, String> {
    let preference = DesktopClosePreference::parse(&action)
        .filter(|preference| *preference != DesktopClosePreference::Ask)
        .ok_or_else(|| "Close action must be background or quit".to_string())?;
    if remember {
        persist_desktop_close_preference(preference)?;
    }

    match preference {
        DesktopClosePreference::Background => {
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            background_desktop_app(&app);
        }
        DesktopClosePreference::Quit => app.exit(0),
        DesktopClosePreference::Ask => unreachable!(),
    }
    Ok(true)
}

/// One lane projected for the tray dropdown. Windows/Linux include live work
/// while backgrounded; macOS keeps its existing awaiting-review menu.
#[derive(Clone)]
struct TrayLane {
    id: String,
    label: String,
    repo: String,
    status: String,
}

fn fetch_tray_lanes() -> Vec<TrayLane> {
    let Some(body) = http_get_local("/api/lanes?active=true") else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Vec::new();
    };
    let Some(lanes) = json.get("lanes").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    lanes
        .iter()
        .filter_map(|lane| {
            let status = lane.get("status").and_then(|s| s.as_str())?;
            #[cfg(target_os = "macos")]
            let visible = status == "reviewing";
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            let visible = matches!(
                status,
                "launching"
                    | "running"
                    | "awaiting_input"
                    | "awaiting_orchestrator"
                    | "awaiting_human"
                    | "recovering"
                    | "reviewing"
                    | "merging"
            );
            if !visible {
                return None;
            }
            let id = lane.get("id").and_then(|s| s.as_str())?.to_string();
            let label = lane
                .get("label")
                .and_then(|s| s.as_str())
                .unwrap_or("Untitled")
                .to_string();
            let repo_path = lane.get("repoPath").and_then(|s| s.as_str()).unwrap_or("");
            let repo = repo_path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            Some(TrayLane {
                id,
                label,
                repo,
                status: status.to_string(),
            })
        })
        .collect()
}

/// Truncate a label for the tray menu. macOS menus render long titles fine
/// but the dropdown gets unwieldy past ~60 chars — pull back to 48 with an
/// ellipsis so each row stays scannable.
fn truncate_label(label: &str) -> String {
    const MAX: usize = 48;
    if label.chars().count() <= MAX {
        return label.to_string();
    }
    let truncated: String = label.chars().take(MAX - 1).collect();
    format!("{}…", truncated.trim_end())
}

/// Build the tray dropdown menu given the current awaiting-review set.
/// Layout: `<packet> · <repo>` rows, separator, `Show o8`, separator, `Quit`.
/// When the set is empty the per-packet rows are skipped and the menu collapses
/// to the static two.
fn build_tray_menu(app: &AppHandle, lanes: &[TrayLane]) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", "Show o8", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit o8", true, None::<&str>)?;

    if lanes.is_empty() {
        return Menu::with_items(app, &[&show, &separator, &quit]);
    }

    let menu = Menu::new(app)?;
    for lane in lanes {
        let title = if lane.repo.is_empty() {
            truncate_label(&lane.label)
        } else {
            format!("{} · {}", truncate_label(&lane.label), lane.repo)
        };
        let item = MenuItem::with_id(app, format!("lane:{}", lane.id), title, true, None::<&str>)?;
        menu.append(&item)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&show)?;
    menu.append(&separator)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// Swap the tray's menu to reflect the current awaiting-review set.
/// Called from the poller when the set changes. Errors are logged + skipped
/// so a transient menu-build hiccup never kills the poller thread.
fn apply_tray_menu(app: &AppHandle, lanes: &[TrayLane]) {
    let Ok(guard) = tray_handle().lock() else {
        return;
    };
    let Some(tray) = guard.as_ref() else { return };
    match build_tray_menu(app, lanes) {
        Ok(menu) => {
            if let Err(err) = tray.set_menu(Some(menu)) {
                log::warn!("[tray-menu] set_menu failed: {}", err);
            }
        }
        Err(err) => log::warn!("[tray-menu] build_tray_menu failed: {}", err),
    }
}

/// Spawn a long-lived background thread that polls the lanes API every 5s,
/// updates the badge count, and rebuilds the tray dropdown to list each
/// awaiting-review packet by title + repo. Light enough to run continuously
/// — one tiny HTTP request per tick.
fn spawn_tray_badge_poller(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_signature: Option<String> = None;
        loop {
            let lanes = fetch_tray_lanes();
            let count = lanes
                .iter()
                .filter(|lane| lane.status == "reviewing")
                .count() as u32;
            // Signature = count + sorted lane id list. Rebuild menu only when
            // the set itself changes — avoids churn when nothing happened.
            let mut ids: Vec<&str> = lanes.iter().map(|l| l.id.as_str()).collect();
            ids.sort();
            let signature = format!("{}:{}", count, ids.join(","));

            if Some(&signature) != last_signature.as_ref() {
                apply_tray_badge(count);
                apply_tray_menu(&app, &lanes);
                let _ = app.emit("tray-badge-changed", count);
                last_signature = Some(signature);
            }
            std::thread::sleep(std::time::Duration::from_secs(5));
        }
    });
}

/// Tauri command: push an exact awaiting-review count to the tray badge.
/// Frontend calls this when a WS lane event flips a packet's status, so the
/// badge updates instantly instead of waiting for the 5s poll.
#[tauri::command]
fn set_tray_badge(count: u32) {
    apply_tray_badge(count);
}

/// Tauri command: fire a native notification when a packet flips to
/// awaiting_review. Frontend invokes this from the WS lane event handler.
/// We also raise the tray badge by 0 (no-op for count) just to refresh the
/// tooltip in case the poller hasn't ticked yet.
#[tauri::command]
fn notify_review_ready(
    app: AppHandle,
    title: String,
    body: String,
    packet_id: Option<String>,
) -> Result<(), String> {
    // #2150 — the banner is opt-out now, and #2147's quiet mode forces it off
    // for its duration. Both live in `presentation::should_deliver_review_notification`
    // so the native path and the server-side push path can never disagree about
    // what "suppressed" means. A suppressed call is a silent success: the caller
    // asked for a courtesy, not for a guarantee.
    if !presentation::should_deliver_review_notification(
        presentation::is_quiet_mode_active(),
        presentation::review_notifications_enabled(),
    ) {
        return Ok(());
    }
    let display_title = if title.is_empty() {
        "Awaiting review".to_string()
    } else {
        title
    };
    let display_body = if body.is_empty() {
        "A packet is ready for review".to_string()
    } else {
        body
    };
    app.notification()
        .builder()
        .title(&display_title)
        .body(&display_body)
        .show()
        .map_err(|e| e.to_string())?;
    // Frontend can listen for this if it wants to scroll to the packet card
    // when the notification is clicked. We can't intercept the click on
    // macOS through the notify-rust path, but emitting here means anything
    // listening on `notification-fired` knows the most recent packet.
    let _ = app.emit(
        "notification-fired",
        serde_json::json!({
            "title": display_title,
            "body": display_body,
            "packetId": packet_id,
        }),
    );
    Ok(())
}

/// Tauri command: turn presentation (quiet) mode on or off (#2147).
///
/// One switch for every surface that can appear over a screen share: the four
/// satellite overlay windows go down, native review notifications stop, and the
/// in-app coach cards / status pills / toasts stop (the webview listens for the
/// `o8:quiet-mode-changed` event this emits). Leaving the mode restores exactly
/// the overlays that were up, in the positions they held.
#[tauri::command]
fn presentation_quiet_mode_set(app: AppHandle, active: bool) -> serde_json::Value {
    let mut overlays = presentation::TauriOverlays { app: &app };
    let resolved = presentation::apply_quiet_mode(&mut overlays, active);
    let payload = presentation_quiet_mode_state();
    // Every window, including the satellites, learns the new mode. The main
    // window's React tree gates its own suppressible surfaces on this.
    let _ = app.emit("o8:quiet-mode-changed", payload.clone());
    log::info!("[quiet-mode] active={resolved}");
    payload
}

/// Tauri command: read the current mode. A caller (a recording script, an
/// agent, the settings row) confirms quiet mode is live BEFORE it starts.
#[tauri::command]
fn presentation_quiet_mode_get() -> serde_json::Value {
    presentation_quiet_mode_state()
}

fn presentation_quiet_mode_state() -> serde_json::Value {
    serde_json::json!({
        "active": presentation::is_quiet_mode_active(),
        "suppressedOverlays": presentation::suppressed_overlay_labels(),
        "reviewNotificationsEnabled": presentation::review_notifications_enabled(),
        "reviewNotificationsDelivering": presentation::should_deliver_review_notification(
            presentation::is_quiet_mode_active(),
            presentation::review_notifications_enabled(),
        ),
    })
}

/// Tauri command: mirror the `notificationsReviewReady` operator default into
/// the native shell (#2150). The webview pushes this whenever operator defaults
/// load or change; the Rust side holds no opinion of its own about the setting,
/// it only enforces the last value it was told plus quiet mode.
#[tauri::command]
fn set_review_notifications_enabled(enabled: bool) {
    presentation::set_review_notifications_enabled(enabled);
}

// Heal saved window state before tauri-plugin-window-state reads it. Symon's
// derived-geometry overlays must never enter the plugin's physical-pixel
// persistence round trip; malformed state keeps the existing discard behavior.
fn sanitize_window_state() {
    use window_state_sanitizer::SanitizedWindowState;

    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let path = std::path::PathBuf::from(home)
        .join("Library/Application Support/ai.o8.desktop/.window-state.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return;
    };
    match window_state_sanitizer::sanitize_window_state_json(&content) {
        SanitizedWindowState::Unchanged => {}
        SanitizedWindowState::Rewrite(cleaned) => {
            if let Err(error) = std::fs::write(&path, cleaned) {
                eprintln!("[o8] failed to sanitize saved window state: {error}");
            } else {
                eprintln!("[o8] removed derived overlays from saved window state");
            }
        }
        SanitizedWindowState::Discard => {
            eprintln!("[o8] discarding malformed saved window state");
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Ensure `o8` is on PATH by symlinking the bundled CLI into the first writable
/// well-known bin directory. Best-effort — logs and returns on any error so a
/// permission failure never blocks app startup.
///
/// Priority: /opt/homebrew/bin on Apple Silicon → /usr/local/bin → ~/.local/bin.
/// We refuse to clobber a non-symlink at the target. If an existing symlink
/// points at any /Applications/o8.app path, we replace it (assume stale o8
/// from a previous install).
#[cfg(target_os = "macos")]
fn ensure_cli_on_path(cli_source: &Path) {
    if !cli_source.exists() {
        eprintln!(
            "[cli-symlink] bundled CLI missing at {}",
            cli_source.display()
        );
        return;
    }

    let home = match std::env::var_os("HOME") {
        Some(h) => std::path::PathBuf::from(h),
        None => {
            eprintln!("[cli-symlink] $HOME unset — skipping");
            return;
        }
    };

    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(target_arch = "aarch64") {
        candidates.push(std::path::PathBuf::from("/opt/homebrew/bin/o8"));
    }
    candidates.push(std::path::PathBuf::from("/usr/local/bin/o8"));
    candidates.push(home.join(".local").join("bin").join("o8"));

    let mut failures: Vec<String> = Vec::new();
    for target in &candidates {
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                if let Err(err) = std::fs::create_dir_all(parent) {
                    failures.push(format!("mkdir {} failed: {}", parent.display(), err));
                    continue;
                }
            }
        }

        match std::fs::symlink_metadata(target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    match std::fs::read_link(target) {
                        Ok(existing) if existing == cli_source => {
                            // Already pointing where we want — nothing to do.
                            std::env::set_var(
                                "O8_CLI_INSTALL_PATH",
                                target.to_string_lossy().to_string(),
                            );
                            std::env::set_var("O8_CLI_INSTALL_STATUS", "already-linked");
                            return;
                        }
                        Ok(existing)
                            if existing.to_string_lossy().contains("/Applications/o8.app/") =>
                        {
                            // Stale symlink from a previous install — replace.
                            let _ = std::fs::remove_file(target);
                        }
                        Ok(existing) if existing.to_string_lossy().contains("/server/bin/o8") => {
                            // Stale dev-target symlink (e.g. a prior `cargo tauri dev`
                            // left /usr/local/bin/o8 pointing at
                            // <repo>/src-tauri/target/{debug,release}/server/bin/o8).
                            // Those bundles go stale once the user runs the production
                            // app — replace with the current bundled CLI (#1104 hardening).
                            let _ = std::fs::remove_file(target);
                        }
                        Ok(_) => {
                            // User-owned symlink to something else — leave alone.
                            failures.push(format!(
                                "{} points to a user-owned symlink",
                                target.display()
                            ));
                            continue;
                        }
                        Err(_) => {
                            let _ = std::fs::remove_file(target);
                        }
                    }
                } else {
                    // Regular file or directory — never clobber.
                    let message = format!("{} exists and is not a symlink", target.display());
                    failures.push(message.clone());
                    eprintln!("[cli-symlink] {} — leaving alone", message);
                    continue;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                // No existing entry — fall through to create.
            }
            Err(err) => {
                eprintln!("[cli-symlink] stat {} failed: {}", target.display(), err);
                failures.push(format!("stat {} failed: {}", target.display(), err));
                continue;
            }
        }

        match std::os::unix::fs::symlink(cli_source, target) {
            Ok(()) => {
                eprintln!(
                    "[cli-symlink] linked {} -> {}",
                    target.display(),
                    cli_source.display()
                );
                std::env::set_var("O8_CLI_INSTALL_PATH", target.to_string_lossy().to_string());
                std::env::set_var("O8_CLI_INSTALL_STATUS", "linked");
                return;
            }
            Err(err) => {
                eprintln!("[cli-symlink] {} failed: {}", target.display(), err);
                failures.push(format!("{} failed: {}", target.display(), err));
            }
        }
    }
    let detail = failures.join("; ");
    std::env::set_var("O8_CLI_INSTALL_STATUS", format!("failed: {}", detail));
}

/// Windows has no symlink-without-elevation story, so instead of linking we
/// copy the bundled o8.cmd/o8.ps1/o8.mjs into `%USERPROFILE%\.o8\bin` and add
/// that directory to `HKCU\Environment\Path` (#1741, part of #1673).
#[cfg(target_os = "windows")]
fn ensure_cli_on_path(cli_source: &Path) {
    windows_cli_path::ensure_cli_on_path(cli_source);
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn ensure_cli_on_path(_cli_source: &Path) {
    // Linux packaging isn't shipping yet — no symlink/PATH story needed
    // until that surface comes online.
}

// ── Voice STT engine wiring (lifted from aqua/Symon, de-Symonized) ──
//
// The Swift `speech_recognizer` sidecar streams Apple-Speech partials over
// stdout; the Rust `LiveRecognizer` (src/stt/mod.rs) owns the daemon and hands
// us a `TranscriptEvent` receiver. We spawn it ONCE in setup(), forward every
// event to the webview as `o8:stt-event`, and on stop run the finalize chain
// (Whisper re-transcribe → Gemini polish) before emitting the polished result.
//
// Anthropic is intentionally NOT a provider here — polish is Gemini-only,
// transcription is Whisper-via-OpenRouter. Both bill outside the Anthropic
// subscription pool, so this engine never touches the Claude REPL path.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod stt_engine {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};

    const FINAL_AUDIO_FILE_GRACE_MS: u64 = 1200;

    /// The single long-lived recognizer daemon. `start`/`stop`/`set_locale`
    /// take `&mut self`, so the global is a Mutex (mirrors `tray_handle`).
    fn recognizer() -> &'static Mutex<crate::stt::LiveRecognizer> {
        static REC: OnceLock<Mutex<crate::stt::LiveRecognizer>> = OnceLock::new();
        REC.get_or_init(|| Mutex::new(crate::stt::LiveRecognizer::new()))
    }

    /// Per-process monotonically increasing session id, handed to the Swift
    /// helper so its rapid-tap fencing can discard stale sessions.
    ///
    /// MUST stay strictly monotonic and never reuse ids: `stop_session`'s
    /// id-fence (and the voice P3 long-form brush/finish/cancel races it closes)
    /// rely on `active_session()` only ever advancing, so a stale stop no-ops.
    /// Wrapping or resetting this would silently break every fence.
    fn next_session_id() -> u64 {
        static SEQ: AtomicU64 = AtomicU64::new(1);
        SEQ.fetch_add(1, Ordering::SeqCst)
    }

    /// The session id of the currently-active dictation (set on start, read on
    /// stop so the command layer doesn't need to thread it through JS).
    fn active_session() -> &'static AtomicU64 {
        static ACTIVE: AtomicU64 = AtomicU64::new(0);
        &ACTIVE
    }

    /// Pending in-app fill acknowledgements (J5PHEN root fix, 2026-07-16).
    /// `system-fill` used to claim PasteOutcome::Pasted the moment the event
    /// BROADCAST succeeded — Ok(()) only means the event left Rust, not that
    /// any JS listener inserted anything, so a dead/unmounted DictationHost
    /// produced a success chime with zero delivery (Chris, three reports
    /// across six weeks). Now each fill carries a nonce; DictationHost acks
    /// through `o8_stt_fill_ack` with whether it actually inserted, and the
    /// emitter blocks on this channel (bounded wait) before claiming success —
    /// no ack or a false ack falls back to the real synthetic paste.
    fn fill_acks() -> &'static Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<(bool, String)>>> {
        static ACKS: OnceLock<Mutex<std::collections::HashMap<u64, std::sync::mpsc::Sender<(bool, String)>>>> =
            OnceLock::new();
        ACKS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
    }

    fn next_fill_nonce() -> u64 {
        static NONCE: AtomicU64 = AtomicU64::new(1);
        NONCE.fetch_add(1, Ordering::SeqCst)
    }

    /// DictationHost's delivery receipt for a `system-fill` event. `delivered`
    /// is true only when text ACTUALLY landed in a field (execCommand success,
    /// native-setter insert, or the composer fill) — never merely "listener
    /// ran". Unknown nonces are ignored (late ack after the emitter already
    /// fell back).
    pub fn ack_fill(nonce: u64, delivered: bool, via: Option<String>) {
        let tx = fill_acks().lock().ok().and_then(|mut m| m.remove(&nonce));
        if let Some(tx) = tx {
            let _ = tx.send((delivered, via.unwrap_or_default()));
        } else {
            log::warn!("[paste] fill ack for unknown nonce {nonce} (emitter already fell back)");
        }
    }

    /// Register a pending fill and hand back the receiver the emitter blocks
    /// on. The caller MUST call `clear_fill(nonce)` after resolving (success,
    /// decline, or timeout) so a never-acked entry can't leak.
    pub fn register_fill(nonce: u64) -> std::sync::mpsc::Receiver<(bool, String)> {
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut m) = fill_acks().lock() {
            m.insert(nonce, tx);
        }
        rx
    }

    pub fn clear_fill(nonce: u64) {
        if let Ok(mut m) = fill_acks().lock() {
            m.remove(&nonce);
        }
    }

    /// The currently-active session id (0 = none). Used by the Right-Option Ask
    /// path to force-stop a competing Fn / long-form session before it takes the
    /// mic — the three voice modes share this one recognizer.
    pub fn active_session_id() -> u64 {
        active_session().load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn seed_test_session_id(session: u64) -> u64 {
        active_session().swap(session, Ordering::SeqCst)
    }

    /// App handle for re-installing the event router after a daemon respawn.
    /// Without it, `start()`'s auto-respawn produced a daemon whose events
    /// flowed into a dropped Receiver — the dock showed "listening" forever
    /// and nothing ever finalized or pasted (live incident 2026-07-10; this
    /// also matches the historical "restart o8 and dictation works once"
    /// reports: any quiet daemon death bricked dictation until app restart).
    fn router_app() -> &'static OnceLock<AppHandle> {
        static APP: OnceLock<AppHandle> = OnceLock::new();
        &APP
    }

    /// Install the stdout→webview router thread for a daemon receiver.
    fn install_event_router(
        app: AppHandle,
        rx: std::sync::mpsc::Receiver<crate::stt::TranscriptEvent>,
    ) {
        std::thread::spawn(move || {
            for event in rx {
                forward_event(&app, event);
            }
            log::info!("[stt] event router thread exiting (daemon stopped)");
        });
    }

    /// Spawn the daemon once and install the stdout→webview router thread.
    /// Safe to call once from setup(); a second call is a no-op (the daemon
    /// reports "already running").
    pub fn spawn(app: AppHandle) {
        let _ = router_app().set(app.clone());
        let rx = {
            let mut guard = match recognizer().lock() {
                Ok(g) => g,
                Err(_) => {
                    log::warn!("[stt] recognizer mutex poisoned; skipping daemon spawn");
                    return;
                }
            };
            match guard.spawn_daemon() {
                Ok(rx) => rx,
                Err(e) => {
                    // Missing helper / spawn failure is non-fatal — the existing
                    // webkitSpeechRecognition + HTTP dictation path still works.
                    log::warn!("[stt] daemon spawn failed (non-fatal): {}", e);
                    return;
                }
            }
        };

        install_event_router(app, rx);

        // Warm the Gemini TLS handshake in the background so the first polish
        // call doesn't pay the cold-start cost.
        std::thread::spawn(crate::stt::polish::warmup);
        // Apple Silicon: pre-download/load the on-device transcription models
        // (speech-local sidecar) so the first dictation never pays the fetch.
        // No-op on Intel and once the readiness marker exists.
        std::thread::spawn(crate::stt::whisper::warmup_local);
    }

    /// Origin discriminator for the active dictation (system-wide Symon fold
    /// P3 review HIGH). `o8:stt-event` is broadcast to ALL windows; this lets
    /// the screen `dock` pill react only to global-Fn (`system`) sessions and
    /// the in-window DictationHost react only to mic-button (`in-window`)
    /// sessions, so neither double-renders. `is_system_origin()` is set at
    /// Fn-down BEFORE `start()`, so it is stable for the whole session here.
    fn origin_str() -> &'static str {
        if crate::fn_hotkey::is_system_origin() {
            "system"
        } else {
            "in-window"
        }
    }

    /// Emit one `o8:stt-event` payload. Always broadcasts (the in-window pill
    /// listens on the broadcast); for SYSTEM-origin events it ALSO emits
    /// directly to the screen `dock` window via `emit_to(DOCK_LABEL, …)` so the
    /// live morph (recording waveform + transcript + paste flash) reliably lands
    /// in the second webview — `app.emit` broadcast can miss the dock. The
    /// agent-partials HUD gets the same direct delivery for the same reason.
    fn emit_stt(app: &AppHandle, origin: &str, mut payload: serde_json::Value) {
        // Direct delivery and broadcast share one gesture identity, including
        // when a recognizer frame interleaves with those duplicate starts.
        if payload["type"] == "system-start" && payload["startId"].is_null() {
            payload["startId"] = serde_json::Value::String(uuid::Uuid::new_v4().to_string());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = origin;
        #[cfg(target_os = "macos")]
        if origin == "system" {
            let _ = app.emit_to(
                crate::dock_window::DOCK_LABEL,
                "o8:stt-event",
                payload.clone(),
            );
            let _ = app.emit_to(
                crate::agent_partials_window::PARTIALS_LABEL,
                "o8:stt-event",
                payload.clone(),
            );
            // The spatial-ink page latches on the same agent-lane start and
            // needs the `final` event to ship its strokes — direct delivery, as
            // the broadcast can miss secondary webviews (same reason as the HUD).
            #[cfg(target_os = "macos")]
            let _ = app.emit_to(
                crate::spatial_ink_window::SPATIAL_INK_LABEL,
                "o8:stt-event",
                payload.clone(),
            );
        }
        let _ = app.emit("o8:stt-event", payload);
    }

    pub(crate) fn emit_system_stt(app: &AppHandle, payload: serde_json::Value) {
        emit_stt(app, "system", payload);
    }

    fn with_agent_lane(mut payload: serde_json::Value) -> serde_json::Value {
        if let Some(record) = payload.as_object_mut() {
            record.insert("lane".to_string(), serde_json::Value::String("agent".to_string()));
        }
        payload
    }

    pub(crate) fn emit_agent_stt(app: &AppHandle, payload: serde_json::Value) {
        emit_stt(app, "system", with_agent_lane(payload));
    }

    fn emit_session_stt(
        app: &AppHandle,
        origin: &str,
        session_id: Option<u64>,
        payload: serde_json::Value,
    ) {
        if origin == "system" && crate::fn_hotkey::is_agent_event_session(session_id) {
            emit_agent_stt(app, payload);
        } else {
            emit_stt(app, origin, payload);
        }
    }

    /// Forward one TranscriptEvent to the webview. Partial/Level events are
    /// passed straight through for live UI; Final triggers the finalize chain.
    fn forward_event(app: &AppHandle, event: crate::stt::TranscriptEvent) {
        use crate::stt::TranscriptEvent as TE;
        let origin = origin_str();
        match event {
            TE::Partial { session_id, text } => {
                if origin == "system" {
                    crate::live_dictation::queue_partial(session_id, text.clone());
                }
                emit_session_stt(
                    app,
                    origin,
                    Some(session_id),
                    serde_json::json!({ "type": "partial", "origin": origin, "sessionId": session_id, "text": text }),
                );
            }
            TE::Level { session_id, level } => {
                emit_session_stt(
                    app,
                    origin,
                    Some(session_id),
                    serde_json::json!({ "type": "level", "origin": origin, "sessionId": session_id, "level": level }),
                );
            }
            TE::Final { session_id, text } => {
                if origin == "system" {
                    crate::live_dictation::queue_partial(session_id, text.clone());
                }
                // Stash Apple's transcript; the polished result is emitted once
                // the AudioFile event lands (so polish can ground on the WAV).
                // If the helper never emits audio_file/complete, fall back to
                // Apple's final transcript so the dock cannot stay stuck forever.
                stash_final(session_id, text.clone());
                schedule_final_fallback(app.clone(), session_id);
                emit_session_stt(
                    app,
                    origin,
                    Some(session_id),
                    serde_json::json!({ "type": "final", "origin": origin, "sessionId": session_id, "text": text }),
                );
            }
            TE::AudioFile { session_id, path } => {
                emit_session_stt(
                    app,
                    origin,
                    Some(session_id),
                    serde_json::json!({ "type": "audio_file", "origin": origin, "sessionId": session_id, "path": path }),
                );
                if let Some(apple_text) = take_final(session_id) {
                    if mark_finalizing(session_id) {
                        run_finalize(app.clone(), session_id, path, apple_text);
                    } else {
                        log::warn!(
                            "[stt] audio_file for session {session_id} arrived after finalize already started; skipping duplicate finalize"
                        );
                    }
                } else if mark_finalizing(session_id) {
                    log::warn!(
                        "[stt] audio_file for session {session_id} had no pending final transcript; finalizing from audio file only"
                    );
                    run_finalize(app.clone(), session_id, path, String::new());
                } else {
                    log::warn!(
                        "[stt] audio_file for session {session_id} had no pending final transcript and was already finalized; skipping duplicate finalize"
                    );
                }
            }
            TE::Status { session_id, text } => {
                emit_session_stt(
                    app,
                    origin,
                    session_id,
                    serde_json::json!({ "type": "status", "origin": origin, "sessionId": session_id, "text": text }),
                );
            }
            TE::Error { session_id, text } => {
                if let Some(session_id) = session_id {
                    // Daemon startup can fail after the start command was accepted.
                    // Stop capture before releasing only that session's input claim.
                    if let Err(error) = stop_session(session_id) {
                        log::warn!("[stt] failed to stop errored session {session_id}: {error}");
                    }
                }
                if origin == "system" {
                    if let Some(session_id) = session_id {
                        crate::live_dictation::cancel_session(session_id);
                    } else {
                        crate::live_dictation::cancel_active();
                    }
                    crate::fn_hotkey::set_system_origin(false);
                    let _ = crate::fn_hotkey::take_smart_compose_mode();
                    #[cfg(any(target_os = "macos", target_os = "linux"))]
                    crate::audio_ducker::restore();
                    // Teardown path — restore ink click-through + clear strokes.
                    #[cfg(target_os = "macos")]
                    crate::spatial_ink_window::disarm(app);
                }
                let is_agent = crate::fn_hotkey::is_agent_event_session(session_id);
                emit_session_stt(
                    app,
                    origin,
                    session_id,
                    serde_json::json!({ "type": "error", "origin": origin, "sessionId": session_id, "text": text }),
                );
                if is_agent {
                    crate::fn_hotkey::clear_agent_event_session(session_id);
                }
            }
            TE::Complete { session_id } => {
                if let Some(apple_text) = take_final(session_id) {
                    if mark_finalizing(session_id) {
                        log::warn!(
                            "[stt] finalize fallback: session {session_id} completed without audio_file; using Apple transcript"
                        );
                        run_finalize(app.clone(), session_id, String::new(), apple_text);
                    }
                }
                let is_agent = crate::fn_hotkey::is_agent_event_session(Some(session_id));
                emit_session_stt(
                    app,
                    origin,
                    Some(session_id),
                    serde_json::json!({ "type": "complete", "origin": origin, "sessionId": session_id }),
                );
                if is_agent {
                    crate::fn_hotkey::clear_agent_event_session(Some(session_id));
                }
            }
            TE::Ready => {
                emit_stt(
                    app,
                    origin,
                    serde_json::json!({ "type": "ready", "origin": origin }),
                );
            }
        }
    }

    /// Sessions whose finalize chain has already started. This is separate from
    /// the pending Apple final transcript: `audio_file` can be the only terminal
    /// artifact, and that still must finalize once.
    fn finalizing_store() -> &'static Mutex<VecDeque<u64>> {
        static STORE: OnceLock<Mutex<VecDeque<u64>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(VecDeque::new()))
    }

    fn mark_finalizing(session_id: u64) -> bool {
        let Ok(mut guard) = finalizing_store().lock() else {
            return true;
        };
        if guard.iter().any(|sid| *sid == session_id) {
            return false;
        }
        guard.push_back(session_id);
        while guard.len() > 64 {
            let _ = guard.pop_front();
        }
        true
    }

    /// The most recent Apple-Speech final transcript keyed by session id, held
    /// until the AudioFile event arrives so the finalize chain can pair them.
    fn final_store() -> &'static Mutex<Option<(u64, String)>> {
        static STORE: OnceLock<Mutex<Option<(u64, String)>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(None))
    }

    fn stash_final(session_id: u64, text: String) {
        if let Ok(mut guard) = final_store().lock() {
            *guard = Some((session_id, text));
        }
    }

    fn take_final(session_id: u64) -> Option<String> {
        let mut guard = final_store().lock().ok()?;
        match guard.take() {
            Some((sid, text)) if sid == session_id => Some(text),
            other => {
                // Mismatched session — put it back so a later matching AudioFile
                // can still pair with it (rapid-tap ordering safety).
                *guard = other;
                None
            }
        }
    }

    fn schedule_final_fallback(app: AppHandle, session_id: u64) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(FINAL_AUDIO_FILE_GRACE_MS));
            if let Some(apple_text) = take_final(session_id) {
                log::warn!(
                    "[stt] finalize fallback: session {session_id} timed out waiting for audio_file; using Apple transcript"
                );
                if mark_finalizing(session_id) {
                    run_finalize(app, session_id, String::new(), apple_text);
                }
            }
        });
    }

    /// Terminal teardown when a dictation resolves to nothing worth pasting —
    /// the silence gate tripped or the whole transcript was a Whisper silence
    /// artifact (#1544-adjacent). Removes the WAV and emits the
    /// origin-appropriate terminal event so no surface hangs waiting: the
    /// always-on dock morphs back to idle on the system paths (Fn / Ask /
    /// Agent all run system-origin), and the in-window composer path gets an
    /// empty `polished` so its pill settles without inserting anything.
    fn finalize_bail_empty(
        app: &AppHandle,
        session_id: u64,
        audio_file: &str,
        apple_text: &str,
        is_agent: bool,
    ) {
        if !audio_file.is_empty() {
            let _ = std::fs::remove_file(audio_file);
        }
        if crate::fn_hotkey::is_system_origin() {
            crate::live_dictation::cancel_session(session_id);
            crate::fn_hotkey::set_system_origin(false);
            #[cfg(target_os = "macos")]
            crate::spatial_ink_window::disarm(app);
            let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
            if is_agent {
                emit_agent_stt(app, idle);
                crate::fn_hotkey::clear_agent_event_session(Some(session_id));
            } else {
                emit_stt(app, "system", idle);
            }
        } else {
            let _ = app.emit(
                "o8:stt-event",
                serde_json::json!({
                    "type": "polished",
                    "origin": "in-window",
                    "sessionId": session_id,
                    "text": "",
                    "rawText": "",
                    "appleText": apple_text,
                    "whisperUsed": false,
                }),
            );
        }
    }

    /// Terminal teardown for a named transcription dependency failure. Unlike
    /// the ordinary provider-failure path, this must not fall back silently or
    /// claim a paste while managed transcription cannot reach its control plane.
    fn finalize_bail_error(
        app: &AppHandle,
        session_id: u64,
        audio_file: &str,
        message: &str,
        is_agent: bool,
    ) {
        if !audio_file.is_empty() {
            let _ = std::fs::remove_file(audio_file);
        }
        let system_origin = crate::fn_hotkey::is_system_origin();
        crate::live_dictation::cancel_session(session_id);
        crate::fn_hotkey::set_system_origin(false);
        #[cfg(target_os = "macos")]
        crate::spatial_ink_window::disarm(app);
        let error = serde_json::json!({
            "type": "error",
            "origin": if system_origin { "system" } else { "in-window" },
            "sessionId": session_id,
            "text": message,
        });
        if is_agent {
            emit_agent_stt(app, error);
            crate::fn_hotkey::clear_agent_event_session(Some(session_id));
        } else if system_origin {
            emit_stt(app, "system", error);
        } else {
            let _ = app.emit("o8:stt-event", error);
        }
    }

    /// Run the finalize chain on a background thread: Whisper re-transcribe
    /// (default-on, OpenRouter) → Gemini polish (audio-grounded). The polished
    /// result is emitted as `o8:stt-event` type `polished`. Ordinary provider
    /// failures fall back to Apple's transcript; a managed tier without its
    /// control plane emits the named terminal error instead.
    fn run_finalize(app: AppHandle, session_id: u64, audio_file: String, apple_text: String) {
        std::thread::spawn(move || {
            // Long-form Escape-cancel: drop THIS session's finalize entirely — no
            // Whisper, no polish, no paste, no composer emit. Matched by session id
            // so a concurrent (non-cancelled) finalize can't eat the discard. The
            // cancel path already cleared the origin + morphed the dock to idle;
            // just clear the stashed final + temp WAV and bail.
            #[cfg(target_os = "macos")]
            if crate::fn_hotkey::take_discard_finalize(session_id) {
                let _ = take_final(session_id);
                let _ = std::fs::remove_file(&audio_file);
                return;
            }

            // Capture + CONSUME the Right-Option Ask flag at the TOP — before any
            // early return below (discard / voice-command Cancel) could strand it
            // true and mis-route the NEXT dictation to Ask. Routed at the bottom
            // (after polish) via this local. Always false off the macOS Ask path.
            let is_ask = crate::fn_hotkey::take_ask_mode();
            // Same for the Right-Option agent flag — routed at the bottom to the
            // Symon voice agent. Always false off the macOS agent path.
            let is_agent = crate::fn_hotkey::take_agent_mode();
            // Control+Fn Smart Compose uses the same recognizer and target
            // transaction, but routes the cleaned instruction through the
            // subscription-billed Sonnet writer before committing at the caret.
            let is_smart_compose = crate::fn_hotkey::take_smart_compose_mode();

            // ── Silence gate (net 1, BEFORE transcription) — #1544-adjacent ──
            // Parse the recorded WAV, compute RMS + duration; if it's below the
            // noise floor or shorter than a deliberate press, skip the entire
            // transcribe/polish/paste chain. Silence must never round-trip to
            // Whisper and paste a "Thank you." hallucination. Fail-open: an
            // unparseable/absent WAV falls through to normal transcription.
            if !audio_file.is_empty() {
                if let Some(stats) = std::fs::read(&audio_file)
                    .ok()
                    .and_then(|bytes| crate::stt::gate::analyze_wav(&bytes))
                {
                    // The gate exists to stop SILENCE from hallucinating a paste —
                    // but RMS alone can't tell silence from a quiet microphone. A
                    // laptop mic at low input gain measures under the floor while
                    // carrying perfectly real speech (live-hit 2026-07-12: free-tier
                    // MacBook transcribed fine in the HUD, then the gate ate the
                    // paste). Apple's live recognizer is the tiebreaker: if it heard
                    // words, it wasn't silence — deliver. Only bail when BOTH the
                    // energy floor trips AND the live pass heard nothing; the
                    // post-transcription denylist still catches Apple's own silence
                    // artifacts ("thank you") independently of this branch.
                    if crate::stt::gate::is_silence(&stats) {
                        if apple_text.trim().is_empty() {
                            log::info!(
                                "[voice] silence gate tripped: rms={:.1}dBFS duration={}ms apple_text=empty — no transcribe, no paste",
                                stats.rms_dbfs,
                                stats.duration_ms
                            );
                            finalize_bail_empty(&app, session_id, &audio_file, &apple_text, is_agent);
                            return;
                        }
                        log::info!(
                            "[voice] silence gate DEFERRED to live transcript: rms={:.1}dBFS duration={}ms apple_text={} chars — quiet mic, not silence",
                            stats.rms_dbfs,
                            stats.duration_ms,
                            apple_text.trim().chars().count()
                        );
                    }
                }
            }

            // Whisper re-transcribes the recorded WAV BEFORE polish; on
            // failure/empty it falls back to Apple's transcript. SHORT
            // utterances skip the pass entirely — Apple's live transcript is
            // reliable at command length, and the re-transcription round-trip
            // was most of the release-to-paste lag on quick dictations
            // (operator-approved 2026-07-07). Polish still runs and still
            // hears the audio, so a rare short mishear gets corrected there.
            let apple_word_count = apple_text.split_whitespace().count();
            // Skip Whisper for SHORT dictations (Apple's live transcript is fine at command
            // length + it saves latency) — but NEVER for the agent path: a command the brain
            // is about to EXECUTE needs Whisper's accuracy more than the paste-latency win.
            let skip_whisper_short = apple_word_count > 0
                && apple_word_count < 12
                && !is_agent
                && !is_smart_compose;
            if skip_whisper_short {
                log::info!(
                    "[stt] whisper skipped: short utterance ({apple_word_count} words) — using Apple transcript"
                );
            }
            let (raw_text, whisper_used) = match (
                crate::stt::whisper::enabled() && !skip_whisper_short,
                audio_file.as_str(),
            ) {
                (true, path) if !path.is_empty() => {
                    match crate::stt::whisper::finalize_transcription(
                        path,
                        &apple_text,
                        |result| {
                            if result.whisper_used {
                                log::info!(
                                    "[stt] whisper used (latency={}ms model={})",
                                    result.latency_ms.unwrap_or(0),
                                    result.model.as_deref().unwrap_or("unknown")
                                );
                            } else {
                                log::warn!(
                                    "[stt] whisper failed/empty; using Apple transcript"
                                );
                            }
                            (result.text, result.whisper_used)
                        },
                    ) {
                        Ok(delivery) => delivery,
                        Err(error @ crate::stt::whisper::TranscriptionFailure::ManagedServerUnavailable) => {
                            finalize_bail_error(
                                &app,
                                session_id,
                                &audio_file,
                                error.user_message().unwrap_or("Dictation failed."),
                                is_agent,
                            );
                            return;
                        }
                        Err(crate::stt::whisper::TranscriptionFailure::Unavailable) => {
                            log::warn!("[stt] whisper failed/empty; using Apple transcript");
                            (apple_text.clone(), false)
                        }
                    }
                }
                _ => (apple_text.clone(), false),
            };

            // ── Hallucination denylist (net 2, AFTER transcription) — #1544 ──
            // Whether the transcript came from Whisper or Apple's live pass
            // (the skip_whisper_short path), drop it when the WHOLE normalized
            // transcript is one of Whisper's canonical silence artifacts. This
            // is the shared chokepoint the RMS gate can't cover — low-level
            // room tone above the floor that Whisper still turns into "thank
            // you". Whole-transcript only: real speech is never substring-cut.
            if crate::stt::gate::is_silence_artifact(&raw_text) {
                log::info!(
                    "[voice] hallucination denylist dropped whole transcript ({} chars, whisper_used={})",
                    raw_text.chars().count(),
                    whisper_used
                );
                finalize_bail_empty(&app, session_id, &audio_file, &apple_text, is_agent);
                return;
            }

            // ── Voice commands (system-Fn path ONLY) ──
            // Deterministic command phrases at the END of the transcript, run on
            // the RAW text BEFORE polish (zero-latency, no LLM). "scratch that" /
            // "cancel" / "never mind" discard the whole dictation; "remove that" /
            // "undo" strips the last word; "new line" / "new paragraph" insert
            // breaks. Gated to origin==system: the in-window composer path has its
            // own TS processor (`voice-commands.ts`), so we must NOT double-process
            // it. `is_system_origin()` is always false off the macOS system path.
            // Also skipped for an Ask question (`!is_ask`) — a spoken question
            // must reach Gemini verbatim, not be mangled by the command parser.
            let raw_text = if crate::fn_hotkey::is_system_origin()
                && !is_ask
                && !is_agent
                && !is_smart_compose
            {
                match crate::stt::commands::process(&raw_text) {
                    crate::stt::commands::CommandResult::Text(t) => t,
                    crate::stt::commands::CommandResult::Cancel => {
                        // Cancelled — clear origin + morph the dock back to idle,
                        // no paste, no composer emit.
                        crate::live_dictation::cancel_session(session_id);
                        crate::fn_hotkey::set_system_origin(false);
                        let _ = std::fs::remove_file(&audio_file);
                        #[cfg(target_os = "macos")]
                        {
                            let idle =
                                serde_json::json!({ "type": "system-idle", "origin": "system" });
                            emit_stt(&app, "system", idle);
                        }
                        return;
                    }
                    crate::stt::commands::CommandResult::Speak(t) => {
                        // "say <text>" — speak it aloud, don't paste. Clear origin
                        // + morph the dock back to idle.
                        crate::live_dictation::cancel_session(session_id);
                        crate::fn_hotkey::set_system_origin(false);
                        let _ = std::fs::remove_file(&audio_file);
                        #[cfg(target_os = "macos")]
                        {
                            if !t.trim().is_empty() {
                                crate::tts::playback::play_thread(t, crate::tts::load_config());
                            }
                            let idle =
                                serde_json::json!({ "type": "system-idle", "origin": "system" });
                            emit_stt(&app, "system", idle);
                        }
                        #[cfg(target_os = "linux")]
                        {
                            crate::linux_voice::speak_in_background(t);
                            let idle =
                                serde_json::json!({ "type": "system-idle", "origin": "system" });
                            emit_stt(&app, "system", idle);
                        }
                        return;
                    }
                }
            } else {
                raw_text
            };

            // Read the recorded WAV so Gemini can hear what was actually said.
            let audio_wav = std::fs::read(&audio_file).ok();

            // Pure-accuracy upgrade: walk the focused app's Accessibility tree so
            // polish can spell on-screen proper nouns, resolve pronouns, and match
            // the surrounding window's tone. Best-effort — empty/None for canvas /
            // Electron apps that don't expose AX text. (System-wide Symon fold P1.)
            let window_ctx = crate::paste::gather_window_context();
            #[cfg(target_os = "macos")]
            let compose_window_ctx = window_ctx.clone();

            let ctx = crate::stt::polish::PolishContext {
                transcript: &raw_text,
                audio_wav: audio_wav.as_deref(),
                frontmost_app: None,
                window_title: window_ctx.window_title,
                selected_text: window_ctx.selected_text,
                ax_excerpt: window_ctx.ax_excerpt,
                // Custom dictionary + polish instructions from the Voice settings
                // (`~/.o8/dictation.json`) — so the operator's proper nouns spell
                // right and their guidance shapes the cleanup (#1209).
                dictionary: crate::stt::keys::config_string_list("dictionary"),
                instructions: crate::stt::keys::config_string("polish_instructions")
                    .unwrap_or_default(),
                // Snippets tab → deterministic phrase expansion on the cleaned text.
                replacements: crate::stt::keys::config_replacements(),
            };

            let polished = if crate::stt::polish::is_available()
                && !crate::stt::polish::should_skip_polish(&ctx)
            {
                // Publish the actual processing phase before the provider call.
                let origin = origin_str();
                emit_session_stt(
                    &app,
                    origin,
                    Some(session_id),
                    serde_json::json!({ "type": "polishing", "origin": origin, "sessionId": session_id }),
                );
                crate::stt::polish::polish(&ctx)
            } else {
                raw_text.clone()
            };

            // Diagnostic: WHERE does emptiness enter the pipeline? Lengths only
            // (never the text — privacy). apple = Apple SFSpeech final, raw =
            // post-Whisper, polished = post-Gemini. Empty `polished` with a
            // non-empty `raw` means polish ate it (Gemini key/failure); empty
            // `apple` AND `raw` means STT produced nothing at all (Microphone /
            // Speech-Recognition permission, not Accessibility).
            log::info!(
                "[stt] finalize lengths: apple={} raw={} whisper_used={} polished={}",
                apple_text.chars().count(),
                raw_text.chars().count(),
                whisper_used,
                polished.chars().count()
            );

            // Best-effort cleanup of the temp WAV.
            let _ = std::fs::remove_file(&audio_file);

            // ── Ask mode (Right-Option) — the polished text is a QUESTION ──
            // Route it to Gemini + speak the answer; do NOT paste or emit to the
            // composer. Checked AFTER polish so the question is cleaned up, and
            // BEFORE the paste/composer origin branch. The flag was already
            // consumed at the top (`is_ask`) so a stray re-finalize can't re-ask.
            #[cfg(target_os = "macos")]
            if is_ask {
                // Ask ran as a system-origin session (for the live dock
                // transcript) — reset the flag so the next dictation isn't
                // mistaken for system-origin.
                crate::fn_hotkey::set_system_origin(false);
                // The dock was morphed to 'recording' on ask-start; return it to
                // idle now — the Ask answer panel takes over when the answer lands.
                let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
                emit_stt(&app, "system", idle);
                crate::dictation_history::record("ask", &polished, None);
                crate::spawn_ask_and_speak(app.clone(), polished);
                return;
            }

            // ── Agent mode (Right-Option) — the polished text is a COMMAND ──
            // Route it to the Symon voice agent (tool-calling loop), which
            // streams progress + a spoken result to the dock and surfaces a
            // confirm card for any risky action. Same teardown as Ask.
            #[cfg(target_os = "macos")]
            if is_agent {
                crate::fn_hotkey::set_system_origin(false);
                let polished_payload = serde_json::json!({
                    "type": "polished",
                    "origin": "system",
                    "lane": "agent",
                    "sessionId": session_id,
                    "text": polished.clone(),
                });
                emit_agent_stt(&app, polished_payload);
                let idle = serde_json::json!({
                    "type": "system-idle",
                    "origin": "system",
                    "lane": "agent"
                });
                emit_agent_stt(&app, idle);
                crate::dictation_history::record("agent", &polished, None);
                // Symon Spatial Context: if the operator drew on the screen
                // during this hold, drain the composite + full-res crop and ride
                // them on the brain turn. None → text-only turn, zero behavior
                // change. Disarm the ink window on this teardown path regardless.
                let spatial = crate::spatial_ink_window::take_spatial_context();
                crate::spatial_ink_window::disarm(&app);
                crate::agent::spawn_agent_with_spatial(app.clone(), polished, spatial);
                return;
            }

            // ── Smart Compose (Control+Fn) — Sonnet writes, native target commits ──
            // The model has NO tools in this lane: a terminal command is generated
            // into the prompt but never executed. On failure we leave the field
            // exactly as captured and surface the reason instead of pasting the
            // spoken instruction as if it were the requested output.
            #[cfg(target_os = "macos")]
            let polished = if is_smart_compose {
                let composing = serde_json::json!({
                    "type": "status",
                    "origin": "system",
                    "sessionId": session_id,
                    "text": "Composing with Sonnet…",
                });
                emit_stt(&app, "system", composing);
                match crate::agent::smart_compose(&app, &polished, &compose_window_ctx) {
                    Ok(result) => result,
                    Err(error) => {
                        crate::live_dictation::cancel_session(session_id);
                        crate::fn_hotkey::set_system_origin(false);
                        let payload = serde_json::json!({
                            "type": "error",
                            "origin": "system",
                            "sessionId": session_id,
                            "text": format!("Smart Compose failed: {error}"),
                        });
                        emit_stt(&app, "system", payload);
                        return;
                    }
                }
            } else {
                polished
            };

            // ── Origin branch (system-wide Symon fold P2) ──
            // A dictation started by the GLOBAL Fn hotkey pastes the polished text
            // at the system caret and does NOT emit the composer-bound `polished`
            // event (which would double-fire into the in-window composer). A
            // dictation started by the in-window mic button emits as before. These
            // are mutually exclusive — never paste AND emit.
            if crate::fn_hotkey::is_system_origin() {
                // Clear the flag first so a daemon hiccup can't re-paste a stale
                // session, then paste into whatever app the user is focused on.
                crate::fn_hotkey::set_system_origin(false);
                if polished.trim().is_empty() {
                    crate::live_dictation::cancel_session(session_id);
                    // Nothing transcribed (silence / STT miss) — morph the
                    // always-on dock back to its idle capsule rather than flash a
                    // false "Pasted". Symon parity: never claim a paste it didn't
                    // make. emit_to(DOCK_LABEL) + broadcast (same reliable path).
                    let idle = serde_json::json!({ "type": "system-idle", "origin": "system" });
                    emit_stt(&app, "system", idle);
                } else {
                    // In-app delivery (#1542 slim-down + composer-focus fix):
                    // when o8 itself is frontmost, a synthetic Cmd+V into our
                    // own webview is fragile — the partials/dock windows can
                    // shuffle first responder mid-session and the paste lands
                    // nowhere (live incident 2026-07-10). Deliver through the
                    // SAME fill path the in-window dictation uses instead:
                    // DictationHost fills the sticky-registered composer, else
                    // inserts at the focused editable, and only falls back to
                    // a real Cmd+V (o8_debug_paste) if it has nowhere to put
                    // the text. Fake keystrokes to ourselves are now a last
                    // resort, not the default.
                    let live_outcome = crate::live_dictation::finish(session_id, &polished);
                    let paste_outcome = if live_outcome
                        == crate::live_dictation::FinishOutcome::Applied
                    {
                        log::info!(
                            "[paste] outcome=caret-stream-final chars={} (AX transaction committed)",
                            polished.len()
                        );
                        crate::paste::PasteOutcome::Pasted
                    } else if let crate::live_dictation::FinishOutcome::Conflict(message) = live_outcome {
                        crate::paste::PasteOutcome::Failed(message)
                    } else if crate::paste::frontmost_is_o8() {
                        // J5PHEN root fix (2026-07-16): a broadcast Ok(()) only
                        // proves the event LEFT Rust — with a dead or unmounted
                        // DictationHost the old code chimed success while the
                        // text went nowhere (Chris, three reports over six
                        // weeks). The fill now carries a nonce and we block
                        // (bounded) on the webview's o8_stt_fill_ack receipt:
                        // only an acked INSERT counts as Pasted; a declined ack
                        // or timeout falls back to the real synthetic paste,
                        // whose own honest ladder ends in ClipboardOnly + toast.
                        let nonce = stt_engine::next_fill_nonce();
                        let ack_rx = stt_engine::register_fill(nonce);
                        let fill = serde_json::json!({
                            "type": "system-fill",
                            "origin": "system",
                            "text": polished.clone(),
                            "nonce": nonce,
                        });
                        let outcome = match app.emit("o8:stt-event", fill) {
                            Ok(()) => {
                                match ack_rx.recv_timeout(std::time::Duration::from_millis(1200)) {
                                    Ok((true, via)) => {
                                        log::info!(
                                            "[paste] outcome=filled-in-app chars={} via={} (webview acked the insert)",
                                            polished.len(),
                                            if via.is_empty() { "unspecified" } else { &via }
                                        );
                                        crate::paste::PasteOutcome::Pasted
                                    }
                                    Ok((false, via)) => {
                                        log::warn!(
                                            "[paste] in-app fill declined (via={}) — falling back to synthetic paste",
                                            if via.is_empty() { "no-target" } else { &via }
                                        );
                                        crate::paste::paste_text_with_status(&polished)
                                    }
                                    Err(_) => {
                                        log::warn!(
                                            "[paste] in-app fill UNACKED after 1200ms (listener dead or webview busy) — falling back to synthetic paste"
                                        );
                                        crate::paste::paste_text_with_status(&polished)
                                    }
                                }
                            }
                            Err(e) => {
                                log::warn!("[paste] in-app fill emit failed ({e}); falling back to synthetic paste");
                                crate::paste::paste_text_with_status(&polished)
                            }
                        };
                        stt_engine::clear_fill(nonce);
                        outcome
                    } else {
                        crate::paste::paste_text_with_status(&polished)
                    };
                    let paste_error = match &paste_outcome {
                        crate::paste::PasteOutcome::Failed(message) => Some(message.clone()),
                        crate::paste::PasteOutcome::ClipboardOnly => Some(
                            "Dictation copied. Press Command-V to paste, then grant Accessibility to o8.".to_string(),
                        ),
                        _ => None,
                    };
                    // Persist to dictation history so the operator can retrieve
                    // what they said if the paste landed in the wrong place.
                    crate::dictation_history::record(
                        if is_smart_compose { "smart-compose" } else { "dictation" },
                        &polished,
                        crate::paste::get_frontmost_bundle_id(),
                    );
                    // Remember the polished text so the ⌘⌥V global shortcut can
                    // re-paste the last dictation (voice P3 paste-last).
                    crate::fn_hotkey::set_last_voice_transcript(&polished);
                    // Dock-only success signal carrying the ACTUAL pasted words so
                    // the notch dock shows the text (Symon parity), not a generic
                    // "Pasted". The in-window DictationHost ignores system-origin,
                    // so this never double-fires into the composer. The dock is
                    // ALWAYS-ON: it MORPHS (success flash → idle capsule) in place;
                    // the /dictation-pill route collapses to idle after
                    // SUCCESS_FLASH_MS. Emit DIRECTLY to the dock (emit_to
                    // DOCK_LABEL) so the flash always lands, plus the broadcast.
                    let char_count = polished.chars().count();
                    if let Some(message) = paste_error {
                        let error = serde_json::json!({
                            "type": "error",
                            "origin": "system",
                            "sessionId": session_id,
                            "text": message,
                        });
                        emit_stt(&app, "system", error);
                    } else {
                        let pasted = serde_json::json!({
                            "type": "system-pasted",
                            "origin": "system",
                            "sessionId": session_id,
                            "text": polished,
                            "chars": char_count,
                            // Accessibility ungranted (e.g. a translocated build): the
                            // text is on the clipboard but Cmd+V couldn't be posted.
                            // Flag it so the surface can say "copied — press ⌘V" rather
                            // than a false "pasted".
                            "clipboardOnly": !paste_outcome.did_paste(),
                        });
                        emit_stt(&app, "system", pasted);
                        // Cue: paste landed (#1208).
                        crate::sound::play_sound("Done");
                    }
                }
            } else {
                let _ = app.emit(
                    "o8:stt-event",
                    serde_json::json!({
                        "type": "polished",
                        "origin": "in-window",
                        "sessionId": session_id,
                        "text": polished,
                        "rawText": raw_text,
                        "appleText": apple_text,
                        "whisperUsed": whisper_used,
                    }),
                );
            }
        });
    }

    /// Begin a dictation. Returns the new session id so the JS side can match
    /// subsequent `o8:stt-event` payloads.
    pub fn start() -> Result<u64, String> {
        start_with_gate(None)
    }

    /// Like [`start`], but hands the capture pump a duck-settle gate so the mic
    /// opens immediately and the start of the message is held (bounded) until
    /// the audio duck lands — instead of serializing the duck wait ahead of the
    /// device open (#1544 overlap). Fn dictation passes `Some`; every other
    /// entry point (in-window mic, agent/ask lanes) passes `None`.
    pub fn start_with_gate(
        duck_gate: Option<crate::stt::capture::DuckGate>,
    ) -> Result<u64, String> {
        start_prepared(prepare_input()?, duck_gate)
    }

    pub(crate) fn prepare_input() -> Result<crate::voice_input::NativeInput, String> {
        crate::voice_input::reserve_native(next_session_id())
    }

    pub(crate) fn start_prepared(
        input: crate::voice_input::NativeInput,
        duck_gate: Option<crate::stt::capture::DuckGate>,
    ) -> Result<u64, String> {
        let sid = input.session();
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        input.activate()?;
        active_session().store(sid, Ordering::SeqCst);
        // Respawn if the daemon died between sessions — and REWIRE the event
        // router to the new receiver. Discarding it (the old `let _ =`) left
        // the fresh daemon's final/audio_file/complete events flowing into a
        // dropped channel: "listening" forever, no finalize, no paste, until
        // an app restart.
        if !guard.is_running() {
            log::warn!("[stt] daemon not running on start; respawning");
            match guard.respawn() {
                Ok(rx) => {
                    if let Some(app) = router_app().get().cloned() {
                        install_event_router(app, rx);
                        log::info!("[stt] daemon respawned + event router reinstalled");
                    } else {
                        log::warn!(
                            "[stt] daemon respawned but no app handle — events will be DROPPED"
                        );
                    }
                }
                Err(e) => log::warn!("[stt] daemon respawn failed: {e}"),
            }
        }
        // Apply the saved microphone choice (Settings → Input). set_input_device
        // early-returns when unchanged, so this is cheap; "default"/empty → system
        // default. Read per-start so the choice survives an app restart.
        let mic = crate::stt::keys::config_string("dictation_microphone_uid");
        let _ = guard.set_input_device(mic.as_deref().filter(|s| !s.is_empty() && *s != "default"));
        if let Err(error) = guard.start(sid, duck_gate) {
            guard.stop(sid);
            crate::voice_input::release_native(sid);
            return Err(error);
        }
        Ok(sid)
    }

    /// End the active dictation. The finalize chain fires off the daemon's
    /// final/audio_file stdout events.
    pub fn stop() -> Result<(), String> {
        let sid = active_session().load(Ordering::SeqCst);
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        guard.stop(sid);
        crate::voice_input::release_native(sid);
        Ok(())
    }

    /// Stop a SPECIFIC dictation session — no-op if a newer session has already
    /// superseded it (`active_session() != expected`). This fences the teardown
    /// so a late stop (a long-form finish, or a brush teardown that raced a
    /// long-form start) can never kill a session the user started afterwards.
    /// `expected == 0` ("unknown") is always a no-op. (Voice P3 long-form.)
    pub fn stop_session(expected: u64) -> Result<(), String> {
        if expected == 0 || active_session().load(Ordering::SeqCst) != expected {
            return Ok(());
        }
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        // Re-check under the lock: a session could have superseded between the
        // unlocked check above and acquiring the recognizer.
        if active_session().load(Ordering::SeqCst) == expected {
            guard.stop(expected);
            crate::voice_input::release_native(expected);
        }
        Ok(())
    }

    /// Set the recognition locale (e.g. "en-US").
    pub fn set_locale(locale: &str) -> Result<(), String> {
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        guard.set_locale(locale)
    }

    /// Route dictation to a specific microphone (uid). `None` = system default.
    pub fn set_input_device(uid: Option<&str>) -> Result<(), String> {
        let mut guard = recognizer()
            .lock()
            .map_err(|_| "STT recognizer unavailable".to_string())?;
        guard.set_input_device(uid)
    }

    /// Enumerate audio input devices by spawning the Swift helper with
    /// `--input-devices-json` (prints one `{type:"input_devices",devices:[…]}`
    /// line and exits). Each device → `{id,name,is_default}` for the mic picker.
    pub fn list_input_devices() -> Result<Vec<crate::InputDeviceDto>, String> {
        let helper = crate::stt::LiveRecognizer::helper_path();
        let output = std::process::Command::new(&helper)
            .arg("--input-devices-json")
            .output()
            .map_err(|e| format!("spawn speech_recognizer: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("input_devices") {
                continue;
            }
            let devices = v
                .get("devices")
                .and_then(|d| d.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|d| {
                            Some(crate::InputDeviceDto {
                                id: d.get("uid")?.as_str()?.to_string(),
                                name: d
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("Microphone")
                                    .to_string(),
                                is_default: d
                                    .get("is_default")
                                    .and_then(|b| b.as_bool())
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            return Ok(devices);
        }
        Ok(Vec::new())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn test_lock() -> &'static Mutex<()> {
            static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
            LOCK.get_or_init(|| Mutex::new(()))
        }

        #[test]
        fn final_store_hands_transcript_to_first_finalize_path_only() {
            let _guard = test_lock().lock().unwrap();
            finalizing_store().lock().unwrap().clear();
            stash_final(4242, "hello from apple".to_string());

            assert_eq!(take_final(4242), Some("hello from apple".to_string()));
            assert_eq!(take_final(4242), None);
        }

        #[test]
        fn final_store_preserves_mismatched_session_for_later_audio_file() {
            let _guard = test_lock().lock().unwrap();
            finalizing_store().lock().unwrap().clear();
            stash_final(7, "saved final".to_string());

            assert_eq!(take_final(8), None);
            assert_eq!(take_final(7), Some("saved final".to_string()));
        }

        #[test]
        fn finalizing_guard_distinguishes_missing_transcript_from_duplicate_finalize() {
            let _guard = test_lock().lock().unwrap();
            finalizing_store().lock().unwrap().clear();

            assert_eq!(take_final(91), None);
            assert!(mark_finalizing(91));
            assert!(!mark_finalizing(91));
        }

        #[test]
        fn finalizing_guard_resets_per_session_for_consecutive_system_dictations() {
            let _guard = test_lock().lock().unwrap();
            finalizing_store().lock().unwrap().clear();

            assert!(mark_finalizing(100));
            assert!(mark_finalizing(101));
            assert!(!mark_finalizing(100));
            assert!(!mark_finalizing(101));
        }

        #[test]
        fn agent_stt_payloads_are_always_lane_tagged() {
            let payload = with_agent_lane(serde_json::json!({
                "type": "partial",
                "origin": "system",
                "text": "spawn two agents"
            }));

            assert_eq!(payload["lane"], "agent");
            assert_eq!(payload["type"], "partial");
        }
    }
}

/// Begin a dictation via the native Apple-Speech sidecar. Returns the session
/// id so the frontend can correlate `o8:stt-event` payloads. macOS only.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn o8_stt_start() -> Result<u64, String> {
    stt_engine::start()
}

/// End the active native dictation; triggers the finalize chain. macOS only.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn o8_stt_stop() -> Result<(), String> {
    stt_engine::stop()
}

/// Finish the active system-wide dictation from a UI surface. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_system_dictation_finish() -> Result<(), String> {
    fn_hotkey::finish_active_system_dictation()
}

/// Set the native recognizer locale (e.g. "en-US"). macOS only.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn o8_stt_locale(locale: String) -> Result<(), String> {
    stt_engine::set_locale(&locale)
}

/// One audio input device for the Settings mic picker.
#[derive(serde::Serialize)]
pub struct InputDeviceDto {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// List connected audio input devices for the Settings mic picker. macOS only.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn stt_list_input_devices() -> Result<Vec<InputDeviceDto>, String> {
    stt_engine::list_input_devices()
}

/// Route dictation to a specific microphone (uid); applied live + saved per-start
/// via the `dictation_microphone_uid` pref. macOS only.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn stt_set_input_device(device_uid: String) -> Result<(), String> {
    let uid = device_uid.trim();
    stt_engine::set_input_device(if uid.is_empty() || uid == "default" {
        None
    } else {
        Some(uid)
    })
}

/// DictationHost's delivery receipt for a nonce-carrying `system-fill` event
/// (J5PHEN root fix): the emitter blocks on this ack before claiming the
/// paste happened. See stt_engine::ack_fill.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn o8_stt_fill_ack(nonce: u64, delivered: bool, via: Option<String>) {
    stt_engine::ack_fill(nonce, delivered, via);
}

/// Speak `text` aloud via the native TTS engine (voice P4): ElevenLabs/Google →
/// macOS `say` fallback. Fire-and-forget on a dedicated OS thread (rodio is
/// `!Send`), so it returns immediately and never blocks the webview. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_speak(text: String, message_id: Option<String>) {
    tts::playback::play_thread_with_message(text, tts::load_config(), message_id);
}

/// Speak one Broadcast line and resolve only after native playback finishes.
/// The ws-server speaker queue uses this receipt to keep utterances serialized.
#[cfg(target_os = "macos")]
#[tauri::command]
async fn broadcast_tts_speak(text: String) -> Result<bool, String> {
    tts::playback::play_thread_with_completion(text, tts::load_config())
        .await
        .map_err(|_| "Broadcast TTS completion channel closed.".to_string())
}

/// Speak a short Symon status callout, gated at speak time by Voice settings.
/// Main webview only: the native browser child must not gain app-level speech.
#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_speak_status(window: tauri::WebviewWindow, text: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("symon_speak_status is only available to the main webview".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    if stt::keys::config_bool("voice_callouts", true) {
        tts::playback::play_status_queued(text.to_string(), tts::load_config());
    }
    Ok(())
}

/// Stop any active TTS playback immediately (the "say"/Ask voice). Single-flight
/// stop — safe no-op when nothing is speaking. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_stop() {
    tts::playback::stop();
}

/// Toggle pause/resume on the active TTS playback. Returns the resulting paused
/// state (`true` = now paused). macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_toggle_pause() -> bool {
    tts::playback::toggle_pause()
}

/// Whether TTS is currently speaking — lets the UI render the right play/stop
/// control on mount. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_is_active() -> bool {
    tts::playback::is_active()
}

/// Set Symon's speaking speed — persists `reading_speed` so every later
/// utterance speaks at this rate (pitch-preserving, server-side). Takes effect
/// on Symon's NEXT utterance, not the one mid-playback (no chipmunk resample).
/// `rate` clamps to 0.7–1.2, the range ElevenLabs preserves pitch across.
/// macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn tts_set_speed(rate: f32) -> Result<(), String> {
    let clamped = rate.clamp(0.7, 1.2);
    crate::stt::keys::set_pref("reading_speed", serde_json::json!(clamped))
}

/// Grow / shrink the screen dock window for the Ask answer panel (voice P4
/// phase C). Called from the `/dictation-pill` webview when it opens/collapses
/// the Ask thread. The resize runs Rust-side so the dock webview needs no
/// window-control permission. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn dock_set_expanded(app: tauri::AppHandle, expanded: bool) {
    dock_window::set_expanded(&app, expanded);
}

/// Report the painted pill's window-local logical rect (from the dock React
/// layer, on every morph). Drives the hit-test poller's click-through toggle —
/// see `dock_window::spawn_hit_test_poller`.
#[tauri::command]
fn dock_set_hit_rect(x: f64, y: f64, w: f64, h: f64) {
    dock_window::set_hit_rect(x, y, w, h);
}

/// Open (or re-target) the native browser-view child window over the panel's
/// Browser content rect and navigate it to `url`. The React panel calls this on
/// mount / URL change; idempotent (navigates + repositions an existing window).
/// CSS logical px in (`getBoundingClientRect()`), converted to physical screen
/// coords against the main window. `initScript` (the panel passes
/// `NATIVE_BROWSER_AGENT_SOURCE`) installs the in-page agent via the builder's
/// initialization_script — no Tauri capability, so the untrusted page never gets
/// the IPC bridge (see `browser_view.rs`).
#[cfg(target_os = "macos")]
#[tauri::command(rename_all = "camelCase")]
fn browser_view_open(
    window: tauri::Window,
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    init_script: Option<String>,
    page_zoom: Option<f64>,
) -> Result<(), String> {
    require_main_window(&window)?;
    browser_view::open(&app, &url, x, y, w, h, init_script.as_deref(), page_zoom.unwrap_or(1.0))
}

/// Reposition/resize the browser-view child window over a new content rect
/// (panel ResizeObserver / window move+resize). CSS logical px in.
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_set_rect(
    window: tauri::Window,
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    page_zoom: Option<f64>,
) -> Result<(), String> {
    require_main_window(&window)?;
    browser_view::set_rect(&app, x, y, w, h, page_zoom.unwrap_or(1.0))
}

/// Navigate the browser-view child window to a new URL (URL bar / tab / reload).
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_navigate(
    window: tauri::Window,
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    require_main_window(&window)?;
    browser_view::navigate(&app, &url)
}

/// Eval `js` into the browser-view page (fire-and-forget, host-owned, no IPC).
/// Returns whether the window existed — the o8_browser_* native path invokes this
/// from the main webview (reached via the plugin socket); the eval'd agent verb
/// POSTs its result back through /api/browser/native-result (cid-only channel).
/// Returns `false` so the caller falls back to the iframe path when native is off.
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_eval(
    window: tauri::Window,
    app: tauri::AppHandle,
    js: String,
) -> Result<bool, String> {
    require_main_window(&window)?;
    Ok(browser_view::eval(&app, &js))
}

/// Eval `js` into the browser-view and RETURN its JSON result (the host pulling a
/// value back from a webview it owns — works at ANY page origin, unlike the in-page
/// agent's own fetch which HTTPS mixed-content blocks). `/api/browser/agent` uses
/// this to read verb results + poll the design-grab sink. `timeoutMs` default 8s.
#[cfg(target_os = "macos")]
#[tauri::command(rename_all = "camelCase")]
async fn browser_view_eval_result(
    window: tauri::Window,
    app: tauri::AppHandle,
    js: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    require_main_window(&window)?;
    browser_view::eval_result(&app, js, timeout_ms.unwrap_or(8000)).await
}

/// Capture the browser-view window's on-screen content as a base64 PNG (occlusion
/// snapshot-swap, Stage 5). The native window composites above o8's web content,
/// so before hiding it for an overlay/drag we paint this last frame into the
/// placeholder — the page reads as frozen, not blank. Same `screencapture -R`
/// region grab as the report-issue capture; None if the window is gone or Screen
/// Recording isn't granted.
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_capture(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    require_main_window(&window)?;
    Ok(agent::screen::capture_window(
        &app,
        browser_view::BROWSER_VIEW_LABEL,
    ))
}

/// Close + destroy the browser-view child window (Browser tab closed / teardown).
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_close(window: tauri::Window, app: tauri::AppHandle) -> Result<(), String> {
    require_main_window(&window)?;
    browser_view::close(&app);
    Ok(())
}

/// Hide the browser-view child window without destroying it (tab not visible,
/// panel collapsed, occlusion snapshot-swap).
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_hide(window: tauri::Window, app: tauri::AppHandle) -> Result<(), String> {
    require_main_window(&window)?;
    browser_view::hide(&app);
    Ok(())
}

/// Show the browser-view child window again and re-apply its last rect.
#[cfg(target_os = "macos")]
#[tauri::command]
fn browser_view_show(window: tauri::Window, app: tauri::AppHandle) -> Result<(), String> {
    require_main_window(&window)?;
    browser_view::show(&app);
    Ok(())
}

/// Open the standalone Voice settings window (Symon parity). Double-tapping the
/// dock pill invokes this — it works even when the main o8 window is closed,
/// since the dock is always-on. Creates the window on first call, then just
/// shows/focuses it. Renders `/voice-settings` (the same VoiceTab as the main
/// settings overlay).
#[cfg(target_os = "macos")]
#[tauri::command]
fn open_voice_settings(app: tauri::AppHandle) {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    if let Some(win) = app.get_webview_window("voice-settings") {
        let _ = win.center();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    // Resolve the frontend origin the same way the dock does (dev-bridge aware).
    let base = match dev_frontend::from_env() {
        Ok(Some(dev)) => dev.origin().to_string(),
        _ => {
            let port = std::env::var("O8_API_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(PROD_API_DEFAULT_PORT);
            format!("http://127.0.0.1:{}", port)
        }
    };
    let url = format!("{}/voice-settings", base);
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            log::warn!("[voice-settings] bad url {url}: {e}");
            return;
        }
    };
    match WebviewWindowBuilder::new(&app, "voice-settings", WebviewUrl::External(parsed))
        .title("o8 Voice Settings")
        // Symon settings window dimensions: 188px sidebar + content needs the room.
        .inner_size(660.0, 720.0)
        .min_inner_size(520.0, 560.0)
        .resizable(true)
        .center()
        .focused(true)
        // Symon glass: no native frame/traffic lights, transparent so the CSS
        // glass card + rounded corners show, shadow in CSS (avoid double shadow).
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .build()
    {
        Ok(win) => {
            // Frosted-glass backdrop, like the main window — without this the
            // transparent window just shows the desktop behind the CSS tint and
            // reads as a flat solid panel. No radius here: the content-view layer
            // rounding below clips the vibrancy view AND the webview to 22px
            // together and tracks window resize, so the bottom corners never go
            // square behind the CSS card (the radius-on-the-effect-view approach
            // went stale on resize).
            if let Err(e) = window_vibrancy::apply_vibrancy(
                &win,
                window_vibrancy::NSVisualEffectMaterial::HudWindow,
                // Active (not the default follows-window-state) so the glass stays
                // vibrant when another window is focused — no jarring grey "blur"
                // swap on blur/focus.
                Some(window_vibrancy::NSVisualEffectState::Active),
                None,
            ) {
                log::warn!("[voice-settings] vibrancy failed: {e}");
            }
            round_window_corners(&win, 22.0);
            log::info!("[voice-settings] window opened → {url}");
        }
        Err(e) => log::warn!("[voice-settings] failed to open window: {e}"),
    }
}

/// Round all four corners of a window by clipping its NSWindow content-view
/// layer (cornerRadius + masksToBounds). The layer tracks the view bounds, so
/// the rounding follows window resize — and because it clips the vibrancy effect
/// view AND the webview together, the corners never go square/pointed behind the
/// CSS (the effect-view's own radius alone went stale; this is the durable fix).
/// Used by the Symon voice panel AND the main window.
#[cfg(target_os = "macos")]
fn round_window_corners(win: &tauri::WebviewWindow, radius: f64) {
    use objc2::{msg_send, runtime::AnyObject};
    let ptr = match win.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    unsafe {
        let content: *mut AnyObject = msg_send![ptr, contentView];
        if content.is_null() {
            return;
        }
        let _: () = msg_send![content, setWantsLayer: true];
        let layer: *mut AnyObject = msg_send![content, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
}

/// Hide the native macOS traffic lights (close / miniaturize / zoom) on a
/// window. The webview renders its own DOM traffic lights instead (Q ruling
/// 2026-07-16): native buttons are drawn by the OS at a fixed PHYSICAL size
/// and position, so they can never track the app's CSS `zoom` — every
/// alignment between them and the scaled chrome was a per-zoom calibration
/// (the 64px × --zoom-inverse spacer, the empirical 22.4px yNudge saga).
/// DOM lights live in the same flex row as the sidebar toggle and scale with
/// everything else. macOS re-shows standard buttons after some style-mask /
/// fullscreen transitions, so this is also re-asserted from the main window's
/// event handler (Focused + Resized), not just at setup.
#[cfg(target_os = "macos")]
fn hide_native_traffic_lights(win: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};
    let ptr = match win.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    unsafe {
        // NSWindowButton: 0 = close, 1 = miniaturize, 2 = zoom
        for kind in 0usize..3 {
            let btn: *mut AnyObject = msg_send![ptr, standardWindowButton: kind];
            if !btn.is_null() {
                let _: () = msg_send![btn, setHidden: true];
            }
        }
    }
}

/// Make the native Zoom (maximize / restore-down) instant instead of animated.
///
/// WKWebView cannot repaint during an animated NSWindow frame change — the web
/// content freezes at the old layout, slides/clips behind the animating frame,
/// then snaps into place when the animation ends (operator video 2026-07-15;
/// Electron apps repaint per animation frame, WKWebView has no public hook).
/// The honest fix is to drop the animation: `-[NSWindow zoom:]` reads its
/// duration from `animationResizeTime:`, so overriding that to 0 on tao's
/// window class makes frame + content change together in a single repaint.
/// The class is shared by every o8 window in this process — intended; zoom
/// behaves identically everywhere. Manual drag-resize is unaffected (no
/// animation involved).
#[cfg(target_os = "macos")]
fn make_window_zoom_instant(win: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    let object = match win.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => {
            log::warn!("[zoom-anim] ns_window unavailable; zoom stays animated");
            return;
        }
    };
    // CGRect by value — 4 contiguous f64s; identical ABI to the nested
    // {CGPoint,CGSize} layout on both x86_64 (memory class) and arm64 (HFA).
    #[repr(C)]
    struct CGRectRaw {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }
    unsafe extern "C-unwind" fn zero_resize_time(
        _this: *mut AnyObject,
        _cmd: Sel,
        _target_frame: CGRectRaw,
    ) -> f64 {
        0.0
    }
    unsafe {
        let cls = (*object).class();
        let replaced = objc2::ffi::class_replaceMethod(
            (cls as *const AnyClass).cast_mut(),
            objc2::sel!(animationResizeTime:),
            std::mem::transmute::<
                unsafe extern "C-unwind" fn(*mut AnyObject, Sel, CGRectRaw) -> f64,
                Imp,
            >(zero_resize_time),
            c"d@:{CGRect={CGPoint=dd}{CGSize=dd}}".as_ptr(),
        );
        log::info!(
            "[zoom-anim] native zoom animation disabled (instant maximize/restore, replaced_existing={})",
            replaced.is_some()
        );
    }
}

/// Read the voice preferences (`~/.o8/dictation.json`) for the settings panel,
/// with API keys stripped. The config is mtime-cached, so writes apply live.
/// macOS only — the pref store lives in the macOS-gated stt module (#1673).
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
async fn voice_prefs_get() -> Result<serde_json::Value, String> {
    // Even metadata-only Keychain I/O must not hold the native event loop.
    tauri::async_runtime::spawn_blocking(crate::stt::keys::config_public)
        .await
        .map_err(|error| format!("read public voice preferences: {error}"))
}

/// Write one voice preference into `~/.o8/dictation.json` (read-modify-write).
/// Takes effect on the next read without a relaunch (mtime cache). Keys:
/// `ducking_enabled`, `sounds_enabled`, `dictionary` (array), `polish_instructions`,
/// `reading_speed`, `tts_provider`, `tts_voice_id`, etc. macOS only (#1673).
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn voice_prefs_set(app: tauri::AppHandle, key: String, value: serde_json::Value) -> Result<(), String> {
    let top_pill = if key == "dictation_top_pill" { value.as_bool() } else { None };
    let external_symon_left_control = if key == "external_symon_left_control" {
        value.as_bool()
    } else {
        None
    };
    crate::stt::keys::set_pref(&key, value)?;
    if let Some(enabled) = top_pill {
        use tauri::Emitter;
        let _ = app.emit("o8:top-pill-preference", serde_json::json!({ "enabled": enabled }));
    }
    if let Some(enabled) = external_symon_left_control {
        // #2158: hand the pref to the device watcher, which re-evaluates at once
        // and arms the tap only while a non-Apple external keyboard is attached.
        #[cfg(target_os = "macos")]
        crate::external_keyboard::set_pref_enabled(enabled);
        #[cfg(not(target_os = "macos"))]
        let _ = enabled;
    }
    Ok(())
}

/// The Symon brain seat (#2156): the operator's stored provider / tier / model
/// pin, which planner adapters are actually installed, and the seat the
/// registry resolves right now. Settings → Voice renders the resolved line
/// under the control so a pick whose CLI is missing reads as a fallback rather
/// than silently doing something else.
#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_brain_state() -> crate::agent::planner_route::SymonBrainState {
    crate::agent::planner_route::brain_state()
}

/// Live state of the external-keyboard Fn substitute (#2158): the stored pref,
/// whether the Control-as-Fn remap is actually armed right now, and the product
/// name of the keyboard arming it. Settings → Voice renders this under the
/// toggle so "on but waiting for a keyboard" is visible rather than silent.
#[cfg(target_os = "macos")]
#[tauri::command]
fn external_keyboard_fn_state() -> crate::external_keyboard::ExternalKeyboardFnState {
    crate::external_keyboard::state()
}

/// Operator-facing personal memory controls. These commands use the same
/// `agent.db` rows and validation as Symon's voice tools, so the Settings panel
/// cannot create a second memory truth.
#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_memory_get() -> Result<crate::agent::memory::MemorySnapshot, String> {
    crate::agent::memory::snapshot()
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_memory_add(fact: String) -> Result<crate::agent::memory::MemoryEntry, String> {
    crate::agent::memory::remember(&fact, "settings")
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_memory_update(
    id: i64,
    fact: String,
) -> Result<crate::agent::memory::MemoryEntry, String> {
    crate::agent::memory::update(id, &fact)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_memory_forget(id: i64) -> Result<(), String> {
    crate::agent::memory::forget(id)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_memory_accept_suggestion(
    id: i64,
) -> Result<crate::agent::memory::MemoryEntry, String> {
    crate::agent::memory::accept_suggestion(id)
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_memory_dismiss_suggestion(id: i64) -> Result<(), String> {
    crate::agent::memory::dismiss_suggestion(id)
}

/// Recent dictation history (newest first) for the settings History panel — the
/// safety net to retrieve what you said when a paste went to the wrong place.
#[tauri::command]
fn dictation_history_get() -> Vec<dictation_history::HistoryEntry> {
    dictation_history::list()
}

#[tauri::command]
fn dictation_history_clear() {
    dictation_history::clear();
}

#[tauri::command]
fn dictation_history_delete(id: String) {
    dictation_history::delete(&id);
}

/// Answer `question` on the Symon FRONT brain on a dedicated OS thread, emit the
/// answer to the webview (`o8:ask-answer` / `o8:ask-error`), and SPEAK it
/// through the TTS engine. Shared by the `ask_question` command (text) and the
/// Right-Option voice path (`run_finalize`). macOS only.
///
/// #2164: the seat is whatever the front-brain setting resolves — the built-in
/// Gemini call it always made, or one tools-withheld turn on a planner seat.
/// The Anthropic billing rule is unchanged: a Claude seat is reached only by
/// spawning the CLI, never by a direct provider call from o8's backend.
#[cfg(target_os = "macos")]
fn spawn_ask_and_speak(app: tauri::AppHandle, question: String) {
    use tauri::Emitter;
    let question = question.trim().to_string();
    if question.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("[ask] failed to build runtime: {e}");
                return;
            }
        };
        log::info!("[ask] question: {} chars", question.len());
        match rt.block_on(async { agent::front_brain::ask(&question, None).await }) {
            Ok(answer) => {
                log::info!("[ask] answer: {} chars", answer.len());
                let answer_payload = serde_json::json!({ "question": question, "answer": answer });
                // Emit ONLY to the screen dock — the Ask answer panel lives in the
                // dock webview. (Emitting to `main` too made the dock receive it
                // twice → duplicated turns.)
                let _ = app.emit_to(dock_window::DOCK_LABEL, "o8:ask-answer", answer_payload);
                // Speak the answer through the TTS engine (spawns its own thread).
                tts::playback::play_thread(answer, tts::load_config());
            }
            Err(e) => {
                log::warn!("[ask] failed: {e}");
                let err_payload = serde_json::json!({ "message": e });
                let _ = app.emit_to(dock_window::DOCK_LABEL, "o8:ask-error", err_payload);
            }
        }
    });
}

/// Ask o8 a question by text (voice P4 phase C). Thin wrapper over
/// `spawn_ask_and_speak` — the Right-Option voice path calls the same helper.
#[cfg(target_os = "macos")]
#[tauri::command]
fn ask_question(app: tauri::AppHandle, text: String) {
    spawn_ask_and_speak(app, text);
}

/// Run the Symon voice agent on `prompt` (a separate lane from Ask). Fire-and-
/// forget: the tool-calling loop runs on its own thread; progress + the final
/// spoken answer reach the user via `o8:agent-task-event` + TTS, and any
/// risky action surfaces a confirm card via `o8:agent-confirm`.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_run(app: tauri::AppHandle, prompt: String) {
    agent::spawn_agent(app, prompt);
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_text_planner_info(
    engine: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> agent::SymonTextPlannerInfo {
    agent::symon_text_planner_info(engine.as_deref(), model.as_deref(), effort.as_deref())
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn symon_text_run_turn(
    app: tauri::AppHandle,
    session_id: String,
    turn_id: String,
    prompt: String,
    engine: String,
    model: String,
    effort: String,
    allow_default_fallback: Option<bool>,
) -> Result<agent::SymonTextTurnResult, String> {
    agent::run_symon_text_turn(app, session_id, turn_id, prompt, engine, model, effort, allow_default_fallback.unwrap_or(false)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn symon_text_interrupt(session_id: String, turn_id: String) -> bool {
    agent::interrupt_symon_text_turn(&session_id, &turn_id)
}

/// Resolve a pending agent confirm card (Allow / Cancel).
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_confirm(task_id: String, allow: bool) {
    agent::resolve_confirm(&task_id, allow);
}

/// Resolve the exact dock card that the operator clicked. A delayed card from
/// an earlier gate for the same task must never decide the current gate.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_confirm_exact(
    confirmation_id: String,
    task_id: String,
    allow: bool,
) -> agent::ConfirmResolution {
    agent::resolve_confirm_exact(&confirmation_id, &task_id, allow)
}

/// Resolve a pending agent confirm by its gate-owned v2 identity. Unlike the
/// legacy taskId command, this reports whether this decision won, repeated an
/// earlier decision, or arrived after expiry/preemption.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_confirm_v2(
    confirmation_id: String,
    session_id: String,
    call_id: String,
    allow: bool,
    terminal: Option<String>,
) -> agent::ConfirmResolution {
    agent::resolve_confirm_v2(
        &confirmation_id,
        &session_id,
        &call_id,
        allow,
        terminal.as_deref(),
    )
}

/// Interrupt Symon: stop every running agent task (the reasoning loops bail
/// between turns and go quiet) AND halt any in-progress speech. Triggered by the
/// dock's tap-to-stop and by Escape. Safe no-op when nothing is running.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_interrupt() {
    let live = agent::cancel_all_tasks();
    // Unblock any task waiting on a confirm card — without this it hangs on the
    // pending card until the 2-min timeout, ignoring the interrupt. Cancel flags
    // are set first, so the freed task bails on the next between-turn check.
    let declined = agent::decline_all_confirms();
    tts::playback::stop();
    log::info!(
        "[symon-agent] interrupt: cancelled {live} task(s), declined {declined} confirm card(s) + stopped TTS"
    );
}

/// Read the current voice escalation policy ("off" | "auto" | "deep") — the
/// two-tier brain's hand-off behavior, persisted in agent_models.json.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_get_escalation() -> String {
    agent::router::load_config().voice_escalation
}

/// Set the voice escalation policy. "off" disables the background Claude brain
/// (front brain handles everything inline); "auto" escalates heavy tasks;
/// "deep" also escalates medium ones.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_set_escalation(policy: String) -> Result<(), String> {
    agent::router::set_voice_escalation(&policy)
}

/// One-tap revert of the last in-place text edit (the dock Revert chip —
/// the governance surface for `apply_text_edit`, see agent/edit_ctx.rs).
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_edit_revert(app: tauri::AppHandle) -> Result<agent::edit_ctx::RevertResult, String> {
    agent_edit_revert_inner(|| agent::edit_ctx::revert(&app))
}

#[cfg(target_os = "macos")]
fn agent_edit_revert_inner(
    revert: impl FnOnce() -> Result<agent::edit_ctx::RevertResult, String>,
) -> Result<agent::edit_ctx::RevertResult, String> {
    let result = revert()?;
    if let Err(error) = agent::ledger::invalidate_edit_inverse(&result.edit_id) {
        log::warn!("[symon-ledger] dock revert could not retire undo token: {error}");
    }
    Ok(result)
}

#[cfg(all(test, target_os = "macos"))]
mod agent_edit_revert_command_tests {
    use super::*;

    #[test]
    fn command_workflow_retires_the_persisted_edit_token() {
        let data_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("dock-revert-ledger-seam-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&data_dir).unwrap();
        agent::store::with_test_data_dir(data_dir.clone(), || {
            let edit_id = "edit-command-seam";
            let inverse = agent::undo::Inverse::RevertEdit {
                edit_id: edit_id.to_string(),
            };
            agent::ledger::record(agent::ledger::ActionRecord {
                action_id: "action-command-seam",
                task_id: "task-command-seam",
                source: "cascaded",
                phase: "terminal",
                utterance: Some("rewrite that"),
                tool: "apply_text_edit",
                args: &serde_json::json!({}),
                confirmation_id: None,
                confirmation_outcome: "not_required",
                outcome: "succeeded",
                session_id: None,
                call_id: None,
                plan: None,
                inverse: Some(&inverse),
            })
            .unwrap();
            assert_eq!(
                agent::ledger::recent(1, None).unwrap()["actions"][0]["undoable"],
                true
            );

            let result = agent_edit_revert_inner(|| {
                Ok(agent::edit_ctx::RevertResult {
                    edit_id: edit_id.to_string(),
                    outcome: agent::edit_ctx::RevertOutcome::Restored,
                })
            })
            .unwrap();
            assert_eq!(result.outcome, agent::edit_ctx::RevertOutcome::Restored);
            assert_eq!(
                agent::ledger::recent(1, None).unwrap()["actions"][0]["undoable"],
                false
            );
        });
        std::fs::remove_dir_all(data_dir).unwrap();
    }
}

/// Answer a pending `o8:edit-capture` request — the main webview reports its
/// live selection / focused-editable state back to the edit lane (the
/// WKWebView path; see agent/edit_ctx.rs).
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_edit_capture_result(request_id: String, state: agent::edit_ctx::WebviewEditState) {
    agent::edit_ctx::resolve_webview_capture(&request_id, state);
}

/// Answer a pending `o8:edit-apply` request (ok / error) from the main webview.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_edit_apply_result(request_id: String, result: agent::edit_ctx::WebviewApplyResult) {
    agent::edit_ctx::resolve_webview_apply(&request_id, result);
}

/// Stage files dropped onto the dock as context for the NEXT agent run
/// (Clicky-parity dossier #3). The dock webview reads content via the HTML5
/// File API (WKWebView exposes no absolute paths) and sends bounded text
/// excerpts; they drain into the next `agent_run` prompt within 5 minutes.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_files_stage(files: Vec<agent::StagedFileIn>) {
    agent::stage_files(files);
    sound::play_sound("Pop");
}

/// The most recent agent task (status/result), for the dock to poll if needed.
#[cfg(target_os = "macos")]
#[tauri::command]
fn agent_task_status() -> Option<serde_json::Value> {
    agent::store::latest_task()
}

/// Run the Symon model-eval harness (live round-trip) over the read-only fixture
/// set. Optionally pass model ids to A/B; empty/omitted = the configured brain.
/// Returns the markdown scoreboard (also written to ~/.o8/agent-eval-latest.md).
#[cfg(target_os = "macos")]
#[tauri::command]
async fn agent_eval(
    window: tauri::Window,
    app: tauri::AppHandle,
    models: Option<Vec<String>>,
) -> Result<String, String> {
    require_main_window(&window)?;
    Ok(agent::eval::run_eval(app, models.unwrap_or_default()).await)
}

/// Compatibility fallback for legacy desktop shells: paste dictation text into
/// the currently focused app when the web layer has no in-app insertion target.
/// Invocation is restricted to the main window. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_debug_paste(window: tauri::Window, text: String) -> Result<(), String> {
    require_main_window(&window)?;
    paste::paste_text(&text);
    Ok(())
}

/// Dock-route morph instrumentation. The `/dictation-pill` route runs in a
/// SECOND webview whose `console.log` does NOT reach `~/Library/Logs/
/// ai.o8.desktop/o8.log` — so when the dock fails to morph there is no server
/// trace to inspect. This thin command lets the dock route write a line to the
/// Rust tracing log (`[dock-route] …`) so we can SEE which `o8:stt-event`
/// payloads actually reach the dock webview (subscribe success + each
/// system-start/system-idle/system-pasted/final/error). High-frequency
/// partial/level events are intentionally NOT logged from the route. macOS only
/// (the dock window is macOS-only).
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DockRouteState {
    Idle,
    Recording,
    Transcribing,
    Polishing,
    Success,
    Error,
}

#[cfg(test)]
fn reduce_dock_route_state(state: DockRouteState, event_type: &str) -> DockRouteState {
    match event_type {
        "system-start" | "status" => DockRouteState::Recording,
        "final" if matches!(state, DockRouteState::Recording) => DockRouteState::Transcribing,
        "audio_file"
            if matches!(
                state,
                DockRouteState::Recording | DockRouteState::Transcribing
            ) =>
        {
            DockRouteState::Polishing
        }
        "system-pasted" => DockRouteState::Success,
        "error" => DockRouteState::Error,
        "complete" | "ready" | "system-idle" => DockRouteState::Idle,
        _ => state,
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_dock_log(msg: String) {
    // `log::` (captured by tauri_plugin_log → o8.log), NOT `tracing::` — the
    // tracing subscriber writes to stdout, which a bundled .app discards, so the
    // earlier `tracing::info!` here never surfaced in o8.log (false-negative that
    // masked the dock-morph capability bug). `log::info!` is what reaches the file.
    log::info!("[dock-route] {msg}");
}

#[cfg(test)]
mod dock_route_tests {
    use super::{reduce_dock_route_state, DockRouteState};

    #[test]
    fn terminal_events_clear_recording_state() {
        for event_type in ["complete", "ready", "system-idle"] {
            assert_eq!(
                reduce_dock_route_state(DockRouteState::Recording, event_type),
                DockRouteState::Idle
            );
        }
    }

    #[test]
    fn terminal_events_win_from_in_flight_states() {
        for state in [
            DockRouteState::Recording,
            DockRouteState::Transcribing,
            DockRouteState::Polishing,
            DockRouteState::Success,
            DockRouteState::Error,
        ] {
            assert_eq!(
                reduce_dock_route_state(state, "ready"),
                DockRouteState::Idle
            );
        }
    }

    #[test]
    fn audio_file_advances_recording_without_final_event() {
        assert_eq!(
            reduce_dock_route_state(DockRouteState::Recording, "audio_file"),
            DockRouteState::Polishing
        );
    }
}

/// Capture the o8 window as a base64 PNG for the in-app feedback / error report
/// (operator note, 2026-06-16; Cmd+Shift+E). Window-only, downscaled, returns
/// None on failure so the feedback flow degrades to a manual paste. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn capture_app_window(
    window: tauri::Window,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    require_main_window(&window)?;
    Ok(agent::screen::capture_window(&app, "main"))
}

/// TEMP/debug: morph the always-on screen dock pill into a sample "listening"
/// state so the dock can be screenshotted without a live Fn dictation (which
/// needs TCC perms + a physical Fn press). The dock window is created visible at
/// boot (idle capsule); this just re-asserts it + emits demo events to morph it
/// to recording. Not wired to any UI. macOS only.
#[cfg(target_os = "macos")]
#[tauri::command]
fn o8_debug_show_dock(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    // NSWindow ops are main-thread-only — schedule show() on the main thread
    // (the real Fn path does the same).
    if let Some(win) = app.get_webview_window("main") {
        let a = app.clone();
        let _ = win.run_on_main_thread(move || {
            dock_window::show(&a);
        });
    } else {
        dock_window::show(&app);
    }
    // Re-emit the demo state a few times: the dock webview may be waking from
    // hidden when the first events fire, so repeat until its route subscribes.
    // Emit DIRECTLY to the dock window (emit_to DOCK_LABEL) — the same reliable
    // path the real Fn flow uses — plus the broadcast for parity.
    let a = app.clone();
    std::thread::spawn(move || {
        for delay_ms in [250u64, 800, 1600] {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            log::info!("[dock-demo] morph dock → recording (system-start → dock)");
            let events = [
                serde_json::json!({ "type": "system-start", "origin": "system" }),
                serde_json::json!({ "type": "partial", "text": "the o8 dock pill \u{2014} system-wide voice, anywhere", "origin": "system" }),
                serde_json::json!({ "type": "level", "level": 0.62, "origin": "system" }),
            ];
            for payload in &events {
                let _ = a.emit_to(dock_window::DOCK_LABEL, "o8:stt-event", payload.clone());
                let _ = a.emit("o8:stt-event", payload.clone());
            }
        }
    });
}

/// Swap the main window's vibrancy material for Canvas mode (#1232).
/// `material` picks the NSVisualEffectMaterial behind the whole window —
/// this IS the canvas background (the desktop reads through it). The ids
/// mirror `CANVAS_GLASS_MATERIALS` in lib/canvas-mode/glass-settings.ts.
/// `"default"` restores the HudWindow chrome material (follows-window
/// state, matching the boot-time application).
/// The chrome vibrancy material for THIS macOS version (#1543).
///
/// Apple degraded `HudWindow` twice in 2026: the 15.7.8 security update
/// (2026-06-27) and the Tahoe 26.x line both stopped rendering it for our
/// window shape — chrome fell back to raw transparency (sharp desktop, no
/// blur). `UnderWindowBackground` renders correct glass on both, verified
/// live on the operator iMac (26.6b3, operator-approved look) with the
/// laptop (15.7.8) verified via bench build. 15.7.7-and-earlier keeps the
/// original HudWindow (proven on 15.7.1 — Sydney's control machine).
#[cfg(target_os = "macos")]
fn chrome_vibrancy_material() -> window_vibrancy::NSVisualEffectMaterial {
    use window_vibrancy::NSVisualEffectMaterial as M;
    static MATERIAL: std::sync::OnceLock<window_vibrancy::NSVisualEffectMaterial> =
        std::sync::OnceLock::new();
    *MATERIAL.get_or_init(|| {
        let version = std::process::Command::new("sysctl")
            .args(["-n", "kern.osproductversion"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        let mut parts = version.trim().split('.');
        let major: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let minor: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let patch: u32 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        let hud_broken = major >= 26 || (major == 15 && minor == 7 && patch >= 8);
        if hud_broken {
            log::info!(
                "[vibrancy] macOS {version} — HudWindow degraded on this OS; using UnderWindowBackground (#1543)"
            );
            M::UnderWindowBackground
        } else {
            M::HudWindow
        }
    })
}

#[tauri::command]
fn set_canvas_material(app: tauri::AppHandle, material: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        use window_vibrancy::NSVisualEffectMaterial as M;
        let Some(window) = app.get_webview_window("main") else {
            return Err("main window not found".into());
        };
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                // apply_vibrancy stacks a new effect view per call — always clear first.
                let _ = window_vibrancy::clear_vibrancy(&target);
                // "none" = NO effect view at all: the window is raw transparent and
                // the desktop reads through perfectly sharp — the liquid-clear look.
                // macOS material blur amounts are fixed recipes, so true clarity
                // tuning is material choice; this is the clear extreme.
                if material == "none" {
                    return;
                }
                let resolved = match material.as_str() {
                    "popover" => M::Popover,
                    "sidebar" => M::Sidebar,
                    "menu" => M::Menu,
                    "sheet" => M::Sheet,
                    "window" => M::WindowBackground,
                    "under-window" => M::UnderWindowBackground,
                    "fullscreen" => M::FullScreenUI,
                    "hud" => M::HudWindow,
                    _ => chrome_vibrancy_material(), // "default"/unknown → per-OS chrome (#1543)
                };
                // ALWAYS Active — including "default". Boot applies the chrome
                // HudWindow material with State::Active (#1267: stay glassy when
                // the window loses key focus). `None` means follows-window, so
                // restoring "default" on canvas exit downgraded the whole window
                // to flatten-to-grey on blur for the rest of the session
                // (operator-reported regression, 2026-07-06).
                let state = Some(window_vibrancy::NSVisualEffectState::Active);
                // Rounding is owned by the content-view clip (round_window_corners,
                // applied at setup) which clips the effect view AND the webview
                // together and tracks resize. Keep the effect view square (None)
                // so it fills to the corner and the content-view mask rounds it
                // cleanly — no sliver between two mismatched radii.
                let radius: Option<f64> = None;
                if let Err(e) = window_vibrancy::apply_vibrancy(&target, resolved, state, radius) {
                    log::warn!("[canvas-material] apply_vibrancy failed: {e}");
                }
            })
            .map_err(|e| format!("schedule material swap failed: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, material);
    }
    Ok(())
}

// Window-server background blur (the iTerm2 trick) — the ONLY continuous
// desktop-blur knob macOS offers; NSVisualEffectMaterial blur amounts are
// fixed recipes. Private CGS API, battle-tested for a decade (iTerm2,
// kitty, Alacritty). Failure is logged and harmless.
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSMainConnectionID() -> u32;
    fn CGSSetWindowBackgroundBlurRadius(cid: u32, wid: u32, radius: i32) -> i32;
}

/// Tunable desktop frost for Canvas mode (#1232): blurs whatever is behind
/// the window's transparent regions. Pairs with the "none"/Liquid material
/// for a continuous liquid-frost dial; radius 0 restores raw clarity.
#[tauri::command]
fn set_canvas_backdrop_blur(app: tauri::AppHandle, radius: u32) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            return Err("main window not found".into());
        };
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(ptr) = target.ns_window() else {
                    log::warn!("[canvas-blur] ns_window unavailable");
                    return;
                };
                if ptr.is_null() {
                    return;
                }
                let object = ptr as *mut objc2::runtime::AnyObject;
                let wid: isize = unsafe { objc2::msg_send![&*object, windowNumber] };
                if wid <= 0 {
                    return;
                }
                let err = unsafe {
                    CGSSetWindowBackgroundBlurRadius(
                        CGSMainConnectionID(),
                        wid as u32,
                        radius.min(64) as i32,
                    )
                };
                if err != 0 {
                    log::warn!("[canvas-blur] CGSSetWindowBackgroundBlurRadius failed: {err}");
                }
            })
            .map_err(|e| format!("schedule backdrop blur failed: {e}"))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, radius);
    }
    Ok(())
}

/// Files handed to o8 by the OS (Finder "Open With", dock drop) before the
/// frontend was ready to receive them. RunEvent::Opened buffers here; the
/// canvas drains via take_pending_file_opens, the dashboard peeks to decide
/// whether to route to the canvas without consuming the paths.
fn pending_file_opens() -> &'static Mutex<Vec<String>> {
    static PENDING: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

#[tauri::command]
fn take_pending_file_opens() -> Vec<String> {
    pending_file_opens()
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

#[tauri::command]
fn peek_pending_file_opens() -> Vec<String> {
    pending_file_opens()
        .lock()
        .map(|pending| pending.clone())
        .unwrap_or_default()
}

/// Auth deep-links handed to o8 by the OS (`o8://auth/callback?ticket=...&state=...`)
/// before the frontend was ready. RunEvent::Opened buffers the full URL here; the
/// dashboard drains it via take_pending_auth_callbacks on mount (cold-start) and
/// also receives a live `o8:auth-callback` event for the hot path.
fn pending_auth_callbacks() -> &'static Mutex<Vec<String>> {
    static PENDING: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

#[tauri::command]
fn take_pending_auth_callbacks() -> Vec<String> {
    pending_auth_callbacks()
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
}

/// The downstream seam for a `o8://` deep-link that arrives while the app is
/// LIVE (#1742). macOS arrives via `RunEvent::Opened`; Windows/Linux arrive via
/// `tauri-plugin-deep-link`'s `on_open_url` (single-instance forwarding). The
/// frontend contract is identical on both, so no TS changes were needed to light
/// up the new platforms.
///
/// Deliver through exactly ONE path. The ticket in the URL is a one-time Clerk
/// token: buffering AND emitting delivered the same ticket twice, and the second
/// exchange burned it with "sign in token has already been used" (live-hit
/// 2026-07-05). Hot path (window exists) -> emit only. Cold start -> buffer only;
/// the dashboard drains it via take_pending_auth_callbacks on mount.
///
/// The window check is what picks the branch, and it is only a correct proxy for
/// "is the frontend listening?" on the macOS cold-launch path, where
/// `RunEvent::Opened` fires BEFORE window creation. Do NOT route a cold-start
/// URL through here on Windows/Linux: their drain runs inside `setup()`, where
/// the main window already exists but its JS has not registered a listener yet,
/// so the emit branch would burn the ticket into a void. That path calls
/// `buffer_o8_auth_deep_links` directly instead.
fn deliver_o8_auth_deep_links(app_handle: &AppHandle, links: Vec<String>) {
    if links.is_empty() {
        return;
    }
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.emit("o8:auth-callback", &links);
        show_desktop_window(app_handle);
    } else {
        buffer_o8_auth_deep_links(links);
    }
}

/// Park deep-links for the dashboard to drain on mount. The delivery of record
/// whenever the frontend is not provably listening yet — see the asymmetry note
/// on `deliver_o8_auth_deep_links`.
fn buffer_o8_auth_deep_links(links: Vec<String>) {
    if links.is_empty() {
        return;
    }
    if let Ok(mut pending) = pending_auth_callbacks().lock() {
        pending.extend(links);
    }
}

#[derive(Clone, Copy)]
struct RestartPolicy {
    max_restarts: usize,
    window: std::time::Duration,
    delay: std::time::Duration,
}

#[derive(Debug, PartialEq, Eq)]
enum RestartDecision {
    Restart {
        attempt: usize,
        delay: std::time::Duration,
    },
    Exhausted {
        attempts: usize,
    },
}

struct RestartTracker {
    policy: RestartPolicy,
    restarts: VecDeque<std::time::Instant>,
}

impl RestartTracker {
    fn new(policy: RestartPolicy) -> Self {
        Self {
            policy,
            restarts: VecDeque::new(),
        }
    }

    fn record_failure(&mut self, now: std::time::Instant) -> RestartDecision {
        while self
            .restarts
            .front()
            .is_some_and(|started| now.saturating_duration_since(*started) >= self.policy.window)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= self.policy.max_restarts {
            return RestartDecision::Exhausted {
                attempts: self.restarts.len(),
            };
        }
        self.restarts.push_back(now);
        RestartDecision::Restart {
            attempt: self.restarts.len(),
            delay: self.policy.delay,
        }
    }
}

const NEXT_RESTART_POLICY: RestartPolicy = RestartPolicy {
    max_restarts: 3,
    window: std::time::Duration::from_secs(5 * 60),
    delay: std::time::Duration::from_millis(750),
};

fn child_exit_reason(status: &std::process::ExitStatus) -> String {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    format!("code={:?} signal={:?}", status.code(), signal)
}

fn wait_for_child_exit(child: &mut std::process::Child) -> std::io::Result<String> {
    child.wait().map(|status| child_exit_reason(&status))
}

fn append_supervisor_log(file: &mut Option<std::fs::File>, message: &str) {
    use std::io::Write;
    if let Some(file) = file.as_mut() {
        let _ = writeln!(file, "[o8-sidecar-supervisor] {message}");
        let _ = file.flush();
        let _ = file.sync_data();
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SupervisorOutcome {
    Shutdown,
    Fatal(String),
    RegistrationRejected,
}

#[allow(clippy::too_many_arguments)]
fn run_next_sidecar_supervisor_loop<F, G, I, R, U, B, S>(
    mut child: std::process::Child,
    mut child_log: Option<std::fs::File>,
    policy: RestartPolicy,
    mut restart: F,
    mut on_fatal: G,
    mut is_shutting_down: I,
    mut register_child: R,
    mut unregister_child: U,
    mut begin_shutdown: B,
    mut sleep: S,
) -> SupervisorOutcome
where
    F: FnMut() -> std::io::Result<std::process::Child>,
    G: FnMut(String),
    I: FnMut() -> bool,
    R: FnMut(u32) -> bool,
    U: FnMut(u32),
    B: FnMut() -> bool,
    S: FnMut(std::time::Duration),
{
    let mut tracker = RestartTracker::new(policy);
    'watch: loop {
        let pid = child.id();
        let exit_reason = match wait_for_child_exit(&mut child) {
            Ok(reason) => reason,
            Err(error) => {
                let reason = format!("wait failed for pid={pid}: {error}");
                append_supervisor_log(&mut child_log, &reason);
                log::error!("[next-supervisor] {reason}");
                if begin_shutdown() {
                    on_fatal(reason.clone());
                    return SupervisorOutcome::Fatal(reason);
                }
                return SupervisorOutcome::Shutdown;
            }
        };
        unregister_child(pid);
        let mut failure = format!("pid={pid} exited {exit_reason}");
        append_supervisor_log(&mut child_log, &failure);
        if is_shutting_down() {
            log::info!("[next-supervisor] {failure} during app shutdown");
            return SupervisorOutcome::Shutdown;
        }
        log::error!("[next-supervisor] {failure}");

        loop {
            let (attempt, delay) = match tracker.record_failure(std::time::Instant::now()) {
                RestartDecision::Restart { attempt, delay } => (attempt, delay),
                RestartDecision::Exhausted { attempts } => {
                    let reason = format!(
                        "{failure}; restart budget exhausted ({attempts} restarts in {}s)",
                        policy.window.as_secs()
                    );
                    append_supervisor_log(&mut child_log, &reason);
                    log::error!("[next-supervisor] {reason}");
                    if begin_shutdown() {
                        on_fatal(reason.clone());
                        return SupervisorOutcome::Fatal(reason);
                    }
                    return SupervisorOutcome::Shutdown;
                }
            };
            append_supervisor_log(
                &mut child_log,
                &format!("restart attempt {attempt} after {}ms", delay.as_millis()),
            );
            sleep(delay);
            if is_shutting_down() {
                log::info!("[next-supervisor] restart cancelled by app shutdown");
                return SupervisorOutcome::Shutdown;
            }
            match restart() {
                Ok(mut next) => {
                    let next_pid = next.id();
                    if !register_child(next_pid) {
                        let _ = next.wait();
                        return SupervisorOutcome::RegistrationRejected;
                    }
                    append_supervisor_log(
                        &mut child_log,
                        &format!("restart attempt {attempt} started pid={next_pid}"),
                    );
                    log::info!(
                        "[next-supervisor] restart attempt {attempt} started pid={next_pid}"
                    );
                    child = next;
                    continue 'watch;
                }
                Err(error) => {
                    failure = format!("restart attempt {attempt} failed to spawn: {error}");
                    append_supervisor_log(&mut child_log, &failure);
                    log::error!("[next-supervisor] {failure}");
                }
            }
        }
    }
}

fn supervise_next_sidecar<F, G>(
    mut child: std::process::Child,
    child_log: Option<std::fs::File>,
    restart: F,
    on_fatal: G,
) -> Option<std::thread::JoinHandle<SupervisorOutcome>>
where
    F: FnMut() -> std::io::Result<std::process::Child> + Send + 'static,
    G: FnMut(String) + Send + 'static,
{
    let pid = child.id();
    if !sidecar_lifecycle::register_child(pid) {
        let _ = child.wait();
        return None;
    }
    Some(
        std::thread::Builder::new()
            .name("next-sidecar-supervisor".to_string())
            .spawn(move || {
                run_next_sidecar_supervisor_loop(
                    child,
                    child_log,
                    NEXT_RESTART_POLICY,
                    restart,
                    on_fatal,
                    sidecar_lifecycle::is_shutting_down,
                    sidecar_lifecycle::register_child,
                    sidecar_lifecycle::unregister_child,
                    sidecar_lifecycle::begin_shutdown,
                    std::thread::sleep,
                )
            })
            .expect("spawn next sidecar supervisor"),
    )
}

#[derive(Clone)]
struct BundledNextSpawn {
    data_dir: String,
    node_bin: String,
    server_dir: std::path::PathBuf,
    server_js: std::path::PathBuf,
    api_port: u16,
    ws_port: u16,
    boot_identity: BootIdentity,
    bundled_operator_mcp: Option<std::path::PathBuf>,
    codebase_memory_bin: Option<String>,
    ai_keys: Vec<(String, String)>,
}

impl BundledNextSpawn {
    fn spawn(&self, log_file: Option<&std::fs::File>) -> std::io::Result<std::process::Child> {
        let mut command = Command::new(&self.node_bin);
        command
            .arg(&self.server_js)
            .current_dir(&self.server_dir)
            .env("O8_DATA_DIR", &self.data_dir)
            .env("CORTEX_IDE_DATA_DIR", &self.data_dir)
            .no_window()
            .env("PORT", self.api_port.to_string())
            .env("HOSTNAME", sidecar_listen_host())
            .env("NODE_ENV", "production")
            .env("O8_PACKAGED_APP", "1")
            .env("O8_NODE_BIN", &self.node_bin)
            .env("O8_API_PORT", self.api_port.to_string())
            .env("O8_WS_PORT", self.ws_port.to_string())
            .env("O8_BOOT_ID", &self.boot_identity.boot_id)
            .env("O8_INSTANCE_ID", &self.boot_identity.instance_id)
            .env("WS_PORT", self.ws_port.to_string())
            .env("O8_SIDECAR_PID", std::process::id().to_string())
            .env("NODE_COMPILE_CACHE", compile_cache_dir());
        if let Some(path) = pi_write_helper() {
            command.env("O8_PI_WRITE_BIN", path);
        }
        if let Some(path) = self.bundled_operator_mcp.as_ref() {
            command.env("O8_BUNDLED_MCP_DIR", &self.server_dir);
            command.env("O8_BUNDLED_MCP_PATH", path);
        }
        // Tauri externalBin lives beside the app executable. Pass only its path;
        // the local server supplies its own operator credential at spawn time.
        if let Ok(executable) = std::env::current_exe() {
            if let Some(directory) = executable.parent() {
                command.env("O8_NEXT_BIN", directory.join("o8-next"));
            }
        }
        // The server keeps o8 next open as the main window instead of
        // following the old Settings switch.
        if next_main::enabled() {
            command.env(next_main::SERVER_ENV, "1");
        }
        if let Some(path) = self.codebase_memory_bin.as_ref() {
            command.env("O8_CODEBASE_MEMORY_BIN", path);
        }
        for (key, value) in &self.ai_keys {
            command.env(key, value);
        }
        command
            .stdout(child_stdio(log_file))
            .stderr(child_stdio(log_file))
            .spawn()
    }
}

fn spawn_and_supervise_bundled_next<G>(
    spawn: BundledNextSpawn,
    child_log: Option<std::fs::File>,
    on_fatal: G,
) -> std::io::Result<(u32, Option<std::thread::JoinHandle<SupervisorOutcome>>)>
where
    G: FnMut(String) + Send + 'static,
{
    let supervisor_log = child_log.as_ref().and_then(|file| file.try_clone().ok());
    let child = spawn.spawn(child_log.as_ref())?;
    let pid = child.id();
    let restart_spawn = spawn;
    let restart = move || restart_spawn.spawn(child_log.as_ref());
    let supervisor = supervise_next_sidecar(child, supervisor_log, restart, on_fatal);
    Ok((pid, supervisor))
}

#[derive(Clone)]
struct BundledWsSpawn {
    data_dir: String,
    node_bin: String,
    server_dir: std::path::PathBuf,
    server_js: std::path::PathBuf,
    ws_port: u16,
    next_origin: String,
    boot_identity: BootIdentity,
    bundled_operator_mcp: Option<std::path::PathBuf>,
    ai_keys: Vec<(String, String)>,
}

impl BundledWsSpawn {
    fn spawn(&self, log_file: Option<&std::fs::File>) -> std::io::Result<std::process::Child> {
        let mut command = Command::new(&self.node_bin);
        command
            .arg(&self.server_js)
            .current_dir(&self.server_dir)
            .env("O8_DATA_DIR", &self.data_dir)
            .env("CORTEX_IDE_DATA_DIR", &self.data_dir)
            .no_window()
            .env("O8_NODE_BIN", &self.node_bin)
            .env("WS_PORT", self.ws_port.to_string())
            .env("NEXT_ORIGIN", &self.next_origin)
            .env("O8_PACKAGED_APP", "1")
            .env("O8_APP_VERSION", env!("CARGO_PKG_VERSION"))
            .env("O8_BOOT_ID", &self.boot_identity.boot_id)
            .env("O8_INSTANCE_ID", &self.boot_identity.instance_id)
            .env("O8_SIDECAR_PID", std::process::id().to_string())
            .env("NODE_COMPILE_CACHE", compile_cache_dir());
        if let Some(path) = pi_write_helper() {
            command.env("O8_PI_WRITE_BIN", path);
        }
        if let Some(path) = self.bundled_operator_mcp.as_ref() {
            command.env("O8_BUNDLED_MCP_DIR", &self.server_dir);
            command.env("O8_BUNDLED_MCP_PATH", path);
        }
        for (key, value) in &self.ai_keys {
            command.env(key, value);
        }
        let mut child = command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        capture_ws_server_stream(
            child.stdout.take(),
            log_file.and_then(|file| file.try_clone().ok()),
            "stdout",
            log::Level::Info,
        );
        capture_ws_server_stream(
            child.stderr.take(),
            log_file.and_then(|file| file.try_clone().ok()),
            "stderr",
            log::Level::Warn,
        );
        Ok(child)
    }
}

fn spawn_and_supervise_bundled_ws<G>(
    spawn: BundledWsSpawn,
    child_log: Option<std::fs::File>,
    on_fatal: G,
) -> std::io::Result<(u32, Option<std::thread::JoinHandle<SupervisorOutcome>>)>
where
    G: FnMut(String) + Send + 'static,
{
    let supervisor_log = child_log.as_ref().and_then(|file| file.try_clone().ok());
    let child = spawn.spawn(child_log.as_ref())?;
    let pid = child.id();
    let restart_spawn = spawn;
    let restart = move || restart_spawn.spawn(child_log.as_ref());
    let supervisor = supervise_next_sidecar(child, supervisor_log, restart, on_fatal);
    Ok((pid, supervisor))
}

fn show_backend_failure_and_exit(app: &AppHandle, reason: &str) {
    let title = "o8 backend stopped";
    let body = format!(
        "The local API server exited repeatedly, so o8 will quit instead of leaving dead panels.\n\nReopen o8 to try again. Exit details were written to ~/.o8/logs/next-server.log.\n\n{reason}"
    );
    log::error!("{title}: {body}");
    sidecar_lifecycle::kill_tracked_children();

    #[cfg(target_os = "macos")]
    {
        let escape = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display dialog "{}" with title "{}" buttons {{"Quit"}} default button "Quit" with icon stop"#,
            escape(&body),
            escape(title)
        );
        let _ = Command::new("osascript").args(["-e", &script]).status();
    }
    #[cfg(target_os = "windows")]
    {
        let message = format!("{title}: {body}")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "")
            .replace('\n', "\\n");
        let script = format!(r#"javascript:alert("{}");window.close();"#, message);
        let _ = Command::new("mshta").arg(script).no_window().spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let full = format!("{title}\n\n{body}");
        let _ = Command::new("zenity")
            .args(["--error", "--title", title, "--text", &full])
            .status()
            .or_else(|_| Command::new("kdialog").args(["--error", &full]).status());
        eprintln!("{full}");
    }
    app.exit(1);
}

fn show_ws_backend_failure_and_exit(app: &AppHandle, reason: &str) {
    let title = "o8 realtime server stopped";
    let body = format!(
        "The local realtime server exited repeatedly, so o8 will quit instead of showing stale agents and controls.\n\nReopen o8 to try again. Exit details were written to ~/.o8/logs/ws-server.log.\n\n{reason}"
    );
    log::error!("{title}: {body}");
    sidecar_lifecycle::kill_tracked_children();

    #[cfg(target_os = "macos")]
    {
        let escape = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"display dialog "{}" with title "{}" buttons {{"Quit"}} default button "Quit" with icon stop"#,
            escape(&body),
            escape(title)
        );
        let _ = Command::new("osascript").args(["-e", &script]).status();
    }
    #[cfg(target_os = "windows")]
    {
        let message = format!("{title}: {body}")
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "")
            .replace('\n', "\\n");
        let script = format!(r#"javascript:alert("{}");window.close();"#, message);
        let _ = Command::new("mshta").arg(script).no_window().spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let full = format!("{title}\n\n{body}");
        let _ = Command::new("zenity")
            .args(["--error", "--title", title, "--text", &full])
            .status()
            .or_else(|_| Command::new("kdialog").args(["--error", &full]).status());
    }

    app.exit(1);
}

#[cfg(test)]
mod next_sidecar_supervisor_tests {
    use super::{
        run_next_sidecar_supervisor_loop, spawn_and_supervise_bundled_next,
        spawn_and_supervise_bundled_ws, wait_for_child_exit, BootIdentity, BundledNextSpawn,
        BundledWsSpawn, RestartDecision, RestartPolicy, RestartTracker, SupervisorOutcome,
    };
    #[cfg(windows)]
    use crate::no_window::NoWindow;
    use std::cell::{Cell, RefCell};
    use std::process::{Child, Command};
    use std::rc::Rc;
    use std::time::{Duration, Instant};

    fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            predicate(),
            "condition did not become true within {timeout:?}"
        );
    }

    fn real_exit_child(code: i32) -> std::io::Result<Child> {
        #[cfg(unix)]
        {
            Command::new("sh")
                .arg("-c")
                .arg(format!("exit {code}"))
                .spawn()
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.arg("/C").arg(format!("exit {code}")).no_window();
            command.spawn()
        }
    }

    fn test_policy(max_restarts: usize) -> RestartPolicy {
        RestartPolicy {
            max_restarts,
            window: Duration::from_secs(10),
            delay: Duration::ZERO,
        }
    }

    #[test]
    fn restart_budget_is_bounded_and_recovers_after_window() {
        let policy = RestartPolicy {
            max_restarts: 2,
            window: Duration::from_secs(10),
            delay: Duration::from_millis(25),
        };
        let mut tracker = RestartTracker::new(policy);
        let start = Instant::now();
        assert_eq!(
            tracker.record_failure(start),
            RestartDecision::Restart {
                attempt: 1,
                delay: policy.delay,
            }
        );
        assert_eq!(
            tracker.record_failure(start + Duration::from_secs(1)),
            RestartDecision::Restart {
                attempt: 2,
                delay: policy.delay,
            }
        );
        assert_eq!(
            tracker.record_failure(start + Duration::from_secs(2)),
            RestartDecision::Exhausted { attempts: 2 }
        );
        assert_eq!(
            tracker.record_failure(start + Duration::from_secs(12)),
            RestartDecision::Restart {
                attempt: 1,
                delay: policy.delay,
            }
        );
    }

    #[test]
    fn real_child_wait_captures_exit_code() {
        let mut child = real_exit_child(23).expect("spawn exit fixture");

        let reason = wait_for_child_exit(&mut child).expect("wait for exit fixture");
        assert!(reason.contains("code=Some(23)"), "{reason}");
    }

    #[cfg(unix)]
    #[test]
    fn real_child_wait_captures_signal() {
        let mut child = Command::new("sh")
            .args(["-c", "kill -TERM $$"])
            .spawn()
            .expect("spawn signal fixture");

        let reason = wait_for_child_exit(&mut child).expect("wait for signal fixture");
        assert!(reason.contains("code=None"), "{reason}");
        assert!(reason.contains("signal=Some(15)"), "{reason}");
    }

    #[test]
    fn real_supervisor_loop_respawns_once_then_observes_shutdown() {
        let initial = real_exit_child(31).expect("spawn initial exit fixture");
        let registered = Rc::new(RefCell::new(vec![initial.id()]));
        let shutdown = Rc::new(Cell::new(false));
        let exits = Rc::new(Cell::new(0usize));
        let respawns = Rc::new(Cell::new(0usize));
        let fatals = Rc::new(RefCell::new(Vec::<String>::new()));

        let restart_count = Rc::clone(&respawns);
        let fatal_reasons = Rc::clone(&fatals);
        let shutdown_check = Rc::clone(&shutdown);
        let register_state = Rc::clone(&registered);
        let unregister_state = Rc::clone(&registered);
        let exit_count = Rc::clone(&exits);
        let shutdown_after_second_exit = Rc::clone(&shutdown);
        let shutdown_claim = Rc::clone(&shutdown);
        let outcome = run_next_sidecar_supervisor_loop(
            initial,
            None,
            test_policy(3),
            move || {
                restart_count.set(restart_count.get() + 1);
                real_exit_child(32)
            },
            move |reason| fatal_reasons.borrow_mut().push(reason),
            move || shutdown_check.get(),
            move |pid| {
                register_state.borrow_mut().push(pid);
                true
            },
            move |pid| {
                unregister_state
                    .borrow_mut()
                    .retain(|candidate| *candidate != pid);
                let count = exit_count.get() + 1;
                exit_count.set(count);
                if count == 2 {
                    shutdown_after_second_exit.set(true);
                }
            },
            move || {
                if shutdown_claim.get() {
                    false
                } else {
                    shutdown_claim.set(true);
                    true
                }
            },
            |_| {},
        );

        assert_eq!(outcome, SupervisorOutcome::Shutdown);
        assert_eq!(respawns.get(), 1);
        assert!(fatals.borrow().is_empty());
        assert!(registered.borrow().is_empty());
    }

    #[test]
    fn real_supervisor_loop_exhausts_budget_and_invokes_fatal() {
        let initial = real_exit_child(41).expect("spawn initial exit fixture");
        let registered = Rc::new(RefCell::new(vec![initial.id()]));
        let shutdown = Rc::new(Cell::new(false));
        let respawns = Rc::new(Cell::new(0usize));
        let fatals = Rc::new(RefCell::new(Vec::<String>::new()));

        let restart_count = Rc::clone(&respawns);
        let fatal_reasons = Rc::clone(&fatals);
        let shutdown_check = Rc::clone(&shutdown);
        let register_state = Rc::clone(&registered);
        let unregister_state = Rc::clone(&registered);
        let shutdown_claim = Rc::clone(&shutdown);
        let outcome = run_next_sidecar_supervisor_loop(
            initial,
            None,
            test_policy(1),
            move || {
                restart_count.set(restart_count.get() + 1);
                real_exit_child(42)
            },
            move |reason| fatal_reasons.borrow_mut().push(reason),
            move || shutdown_check.get(),
            move |pid| {
                register_state.borrow_mut().push(pid);
                true
            },
            move |pid| {
                unregister_state
                    .borrow_mut()
                    .retain(|candidate| *candidate != pid);
            },
            move || {
                if shutdown_claim.get() {
                    false
                } else {
                    shutdown_claim.set(true);
                    true
                }
            },
            |_| {},
        );

        let SupervisorOutcome::Fatal(reason) = outcome else {
            panic!("expected fatal supervisor outcome");
        };
        assert!(reason.contains("restart budget exhausted"), "{reason}");
        assert_eq!(respawns.get(), 1);
        assert_eq!(fatals.borrow().as_slice(), [reason]);
        assert!(shutdown.get());
        assert!(registered.borrow().is_empty());
    }

    #[test]
    fn real_supervisor_loop_shutdown_race_rejects_late_respawn() {
        let initial = real_exit_child(51).expect("spawn initial exit fixture");
        let registered = Rc::new(RefCell::new(vec![initial.id()]));
        let shutdown = Rc::new(Cell::new(false));
        let respawns = Rc::new(Cell::new(0usize));
        let fatals = Rc::new(RefCell::new(Vec::<String>::new()));

        let restart_count = Rc::clone(&respawns);
        let shutdown_during_restart = Rc::clone(&shutdown);
        let fatal_reasons = Rc::clone(&fatals);
        let shutdown_check = Rc::clone(&shutdown);
        let register_state = Rc::clone(&registered);
        let register_shutdown = Rc::clone(&shutdown);
        let unregister_state = Rc::clone(&registered);
        let shutdown_claim = Rc::clone(&shutdown);
        let outcome = run_next_sidecar_supervisor_loop(
            initial,
            None,
            test_policy(3),
            move || {
                restart_count.set(restart_count.get() + 1);
                shutdown_during_restart.set(true);
                real_exit_child(52)
            },
            move |reason| fatal_reasons.borrow_mut().push(reason),
            move || shutdown_check.get(),
            move |pid| {
                if register_shutdown.get() {
                    return false;
                }
                register_state.borrow_mut().push(pid);
                true
            },
            move |pid| {
                unregister_state
                    .borrow_mut()
                    .retain(|candidate| *candidate != pid);
            },
            move || {
                if shutdown_claim.get() {
                    false
                } else {
                    shutdown_claim.set(true);
                    true
                }
            },
            |_| {},
        );

        assert_eq!(outcome, SupervisorOutcome::RegistrationRejected);
        assert_eq!(respawns.get(), 1);
        assert!(shutdown.get());
        assert!(fatals.borrow().is_empty());
        assert!(registered.borrow().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn production_bundled_spawn_wires_supervisor_and_global_registry() {
        let _registry = crate::sidecar_lifecycle::lock_child_registry_for_test();
        let root = std::env::temp_dir().join(format!(
            "o8-next-supervisor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create spawn fixture");
        let script = root.join("server.sh");
        let counter = root.join("spawn-count");
        let capture = root.join("spawn-env");
        std::fs::write(
            &script,
            r#"#!/bin/sh
count=0
if [ -f "$O8_WATCHDOG_COUNTER" ]; then count=$(cat "$O8_WATCHDOG_COUNTER"); fi
count=$((count + 1))
printf '%s' "$count" > "$O8_WATCHDOG_COUNTER"
printf '%s\n' "$PORT|$O8_API_PORT|$O8_WS_PORT|$O8_BOOT_ID|$O8_INSTANCE_ID|$O8_PACKAGED_APP|$PWD|$0|$O8_DATA_DIR|$CORTEX_IDE_DATA_DIR" > "$O8_WATCHDOG_CAPTURE"
if [ "$count" -eq 1 ]; then sleep 0.2; exit 17; fi
sleep 30
"#,
        )
        .expect("write spawn fixture");

        let spawn = BundledNextSpawn {
            data_dir: root.join("state").to_string_lossy().into_owned(),
            node_bin: "sh".to_string(),
            server_dir: root.clone(),
            server_js: script.clone(),
            api_port: 47_120,
            ws_port: 47_125,
            boot_identity: BootIdentity {
                boot_id: "test-boot".to_string(),
                instance_id: "test-instance".to_string(),
            },
            bundled_operator_mcp: None,
            codebase_memory_bin: None,
            ai_keys: vec![
                (
                    "O8_WATCHDOG_COUNTER".to_string(),
                    counter.to_string_lossy().into_owned(),
                ),
                (
                    "O8_WATCHDOG_CAPTURE".to_string(),
                    capture.to_string_lossy().into_owned(),
                ),
            ],
        };
        let (initial_pid, supervisor) =
            spawn_and_supervise_bundled_next(spawn, None, |_| panic!("unexpected fatal"))
                .expect("spawn production Next fixture");
        assert_eq!(
            crate::sidecar_lifecycle::tracked_children_for_test(),
            [initial_pid]
        );

        wait_until(Duration::from_secs(3), || {
            std::fs::read_to_string(&counter).ok().as_deref() == Some("2")
        });
        let respawned = crate::sidecar_lifecycle::tracked_children_for_test();
        assert_eq!(respawned.len(), 1);
        assert_ne!(respawned[0], initial_pid);
        let environment = std::fs::read_to_string(&capture).expect("read spawn environment");
        assert!(environment.contains("47120|47120|47125|test-boot|test-instance|1"));
        assert!(environment.contains(root.to_string_lossy().as_ref()));
        assert!(environment.contains(script.to_string_lossy().as_ref()));
        let state_dir = root.join("state");
        assert!(environment.contains(&format!("|{}|{}", state_dir.display(), state_dir.display())));

        crate::sidecar_lifecycle::kill_tracked_children();
        let outcome = supervisor
            .expect("supervisor thread registered")
            .join()
            .expect("join supervisor thread");
        assert_eq!(outcome, SupervisorOutcome::Shutdown);
        assert!(crate::sidecar_lifecycle::tracked_children_for_test().is_empty());
        assert_eq!(
            std::fs::read_to_string(&counter).expect("read final spawn count"),
            "2"
        );
        std::fs::remove_dir_all(root).expect("remove spawn fixture");
    }

    #[cfg(unix)]
    #[test]
    fn production_bundled_ws_spawn_restarts_and_stays_globally_owned() {
        let _registry = crate::sidecar_lifecycle::lock_child_registry_for_test();
        let root = std::env::temp_dir().join(format!(
            "o8-ws-supervisor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time after epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create WS spawn fixture");
        let script = root.join("ws-server.sh");
        let counter = root.join("spawn-count");
        let capture = root.join("spawn-env");
        std::fs::write(
            &script,
            r#"#!/bin/sh
count=0
if [ -f "$O8_WATCHDOG_COUNTER" ]; then count=$(cat "$O8_WATCHDOG_COUNTER"); fi
count=$((count + 1))
printf '%s' "$count" > "$O8_WATCHDOG_COUNTER"
printf '%s\n' "$WS_PORT|$NEXT_ORIGIN|$O8_BOOT_ID|$O8_INSTANCE_ID|$O8_PACKAGED_APP|$PWD|$0|$O8_DATA_DIR|$CORTEX_IDE_DATA_DIR" > "$O8_WATCHDOG_CAPTURE"
if [ "$count" -eq 1 ]; then sleep 0.2; exit 23; fi
sleep 30
"#,
        )
        .expect("write WS spawn fixture");
        let spawn = BundledWsSpawn {
            data_dir: root.join("state").to_string_lossy().into_owned(),
            node_bin: "sh".to_string(),
            server_dir: root.clone(),
            server_js: script.clone(),
            ws_port: 47_125,
            next_origin: "http://127.0.0.1:47120".to_string(),
            boot_identity: BootIdentity {
                boot_id: "test-ws-boot".to_string(),
                instance_id: "test-ws-instance".to_string(),
            },
            bundled_operator_mcp: None,
            ai_keys: vec![
                (
                    "O8_WATCHDOG_COUNTER".to_string(),
                    counter.to_string_lossy().into_owned(),
                ),
                (
                    "O8_WATCHDOG_CAPTURE".to_string(),
                    capture.to_string_lossy().into_owned(),
                ),
            ],
        };
        let (initial_pid, supervisor) =
            spawn_and_supervise_bundled_ws(spawn, None, |_| panic!("unexpected fatal"))
                .expect("spawn production WS fixture");
        assert_eq!(
            crate::sidecar_lifecycle::tracked_children_for_test(),
            [initial_pid]
        );

        wait_until(Duration::from_secs(3), || {
            std::fs::read_to_string(&counter).ok().as_deref() == Some("2")
        });
        let respawned = crate::sidecar_lifecycle::tracked_children_for_test();
        assert_eq!(respawned.len(), 1);
        assert_ne!(respawned[0], initial_pid);
        let environment = std::fs::read_to_string(&capture).expect("read WS spawn environment");
        assert!(
            environment.contains("47125|http://127.0.0.1:47120|test-ws-boot|test-ws-instance|1")
        );
        assert!(environment.contains(root.to_string_lossy().as_ref()));
        assert!(environment.contains(script.to_string_lossy().as_ref()));
        let state_dir = root.join("state");
        assert!(environment.contains(&format!("|{}|{}", state_dir.display(), state_dir.display())));

        crate::sidecar_lifecycle::kill_tracked_children();
        let outcome = supervisor
            .expect("WS supervisor thread registered")
            .join()
            .expect("join WS supervisor thread");
        assert_eq!(outcome, SupervisorOutcome::Shutdown);
        assert!(crate::sidecar_lifecycle::tracked_children_for_test().is_empty());
        assert_eq!(
            std::fs::read_to_string(&counter).expect("read final WS spawn count"),
            "2"
        );
        std::fs::remove_dir_all(root).expect("remove WS spawn fixture");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The tail of the bundled-server boot: everything that mutates this process's
/// environment (PATH, `O8_NODE_BIN`, the AI keys) and spawns the sidecar
/// children.
///
/// Runs on the MAIN thread, via `run_on_main_thread`, exactly where it ran
/// before the boot reorder. Only the blocking login-shell probe moved to a
/// worker thread — keeping the env mutation and the spawns on the main thread
/// means the reorder introduces no new `set_var`/`getenv` race.
///
/// `Command::spawn` does not wait on the child, so this whole function is a few
/// milliseconds of work; it will not stall a frame.
#[allow(clippy::too_many_arguments)]
fn finish_bundled_bootstrap(
    app: &AppHandle,
    shell: shell_env::LoginShellEnv,
    node_bin: String,
    server_dir: std::path::PathBuf,
    server_js: std::path::PathBuf,
    api_port: u16,
    ws_port: u16,
    boot_identity: BootIdentity,
) {
    // ORDERING CONTRACT: the boot-time orphan reap must be DONE before we spawn a
    // sidecar. Those stale processes still hold the SQLite WAL, the mic and our
    // ports (#1539) — spawn-before-reap risks two writers on the same WAL. The
    // reap ran concurrently with window creation; this is where we collect it.
    join_orphan_reap();

    // Persist for child processes (MCP server, ws-server, etc.)
    std::env::set_var("O8_NODE_BIN", &node_bin);

    // Widen PATH from the login shell so the Next server's setup detect
    // (`which codex`), Codex dispatch spawn, and worktree `pnpm install` can
    // find the user's CLIs — Finder's minimal PATH hides ~/.npm-global/bin,
    // Homebrew, ~/.local/bin, etc.
    augment_process_path(&shell.path);

    // Tell the Next server where the bundled MCP scripts live so
    // `/api/setup/mcp-config` and `orchestrator-session.ts` can emit
    // `node <bundled>.mjs` commands instead of dev `tsx` paths.
    let bundled_operator_mcp = server_dir.join("operator-mcp-server.mjs");
    let has_bundled_mcp = bundled_operator_mcp.exists();
    if has_bundled_mcp {
        log::info!("Bundled MCP scripts at {:?}", server_dir);
    }

    // Issue #755: kick off the codebase-memory-mcp download in the background.
    // On a cache hit (existing install) the env var lands before Next.js spawns.
    // On a cold first launch the download runs concurrently with Next.js boot
    // and the binary lands at the deterministic path
    // `~/.o8/bin/codebase-memory-mcp` — #740's MCP registration resolves the
    // path from the env var or re-checks the filesystem on session spawn.
    ensure_codebase_memory_binary(app.clone());

    // Open per-server log files before spawning so stdout/stderr can be wired
    // directly. Rotated to .prev on each boot.
    let next_log = open_child_log("next-server.log");
    let ws_log = open_child_log("ws-server.log");

    log::info!(
        "Starting server: {} {:?} on :{}",
        node_bin,
        server_js,
        api_port
    );
    // Issue #935: forward AI provider keys from the user's login shell so
    // Finder-launched builds aren't dead for Gemini / Anthropic / etc. features
    // the user has keys for. These came from the single probe — no second shell.
    let ai_keys = shell.keys;
    if !ai_keys.is_empty() {
        log::info!(
            "Forwarded {} AI provider key(s) from login shell to next-server",
            ai_keys.len()
        );
    }

    let next_spawn = BundledNextSpawn {
        data_dir: o8_data_dir(),
        node_bin: node_bin.clone(),
        server_dir: server_dir.clone(),
        server_js,
        api_port,
        ws_port,
        boot_identity: boot_identity.clone(),
        bundled_operator_mcp: has_bundled_mcp.then_some(bundled_operator_mcp),
        codebase_memory_bin: std::env::var("O8_CODEBASE_MEMORY_BIN")
            .ok()
            .filter(|path| !path.is_empty()),
        ai_keys: ai_keys.clone(),
    };
    let fatal_app = app.clone();
    match spawn_and_supervise_bundled_next(next_spawn, next_log, move |reason| {
        show_backend_failure_and_exit(&fatal_app, &reason);
    }) {
        Ok((pid, _supervisor)) => {
            log::info!("Next.js server started (pid: {})", pid);
            // THE comparison line. Before the boot reorder the main window was
            // built here, at the END of the bootstrap — so this stamp is, to a
            // very close approximation, what cold-launch-to-first-window used to
            // cost. Diff it against `[boot] main window created`.
            log::info!(
                "[boot] next-server spawned at {}ms — the OLD code created the window here",
                boot_ms()
            );
            prewarm_bundled_next_server(app.clone(), api_port);
        }
        Err(e) => {
            log::error!("Failed to start server: {}", e);
            show_node_error_and_exit(NodePreflightError::Missing);
        }
    }

    // ── Start WebSocket server (terminals, chat, git watcher) ──
    //
    // If ws-server.mjs is missing the app boots into a degraded state — /ws
    // requests rewrite to a dead upstream and Next.js can spiral into a
    // CPU-pegged error loop. We no longer silently swallow that: it's a fatal
    // startup error so the user sees the failure instead of a hung dashboard.
    let next_origin = format!("http://127.0.0.1:{}", api_port);
    spawn_bundled_ws_server(
        &app,
        &node_bin,
        &server_dir,
        ws_port,
        &next_origin,
        ws_log.as_ref(),
        &ai_keys,
        &boot_identity,
    );
}

// ── Boot timing (perf regression harness) ──
//
// Cold launch was the one number nobody could quote, because nothing recorded
// it. These stamps make the boot path auditable from the log: if a future change
// puts blocking work back in FRONT of the window, it shows up here as a regressed
// number instead of being felt, vaguely, six months later.
//
//   grep '\[boot\]' ~/Library/Logs/ai.o8.desktop/o8.log
//
// The line that matters is `main window created` versus `next-server spawned`.
// Before the boot reorder the window was built AFTER the sidecar spawn, so the
// gap between those two stamps is what the operator used to spend staring at no
// window at all.
static BOOT_T0: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn boot_ms() -> u128 {
    BOOT_T0.get().map(|t0| t0.elapsed().as_millis()).unwrap_or(0)
}

/// Pre-log-plugin boot tracing, opt-in via `O8_BOOT_TRACE=1`.
///
/// The `log::info!` stamps below only work from `setup()` onward — the Tauri log
/// plugin does not exist before `.build()`, so anything logged earlier goes
/// nowhere. That blind spot is precisely why the largest single cost in cold
/// launch went unnoticed: `generate_context!()` runs BEFORE the log plugin, and
/// it costs 1.6s. This writes to stderr, which works from instruction one.
///
///   O8_BOOT_TRACE=1 /Applications/o8.app/Contents/MacOS/o8
fn boot_trace(stage: &str) {
    if std::env::var("O8_BOOT_TRACE").is_ok_and(|v| v == "1") {
        eprintln!("[boot-trace] {} at {}ms", stage, boot_ms());
    }
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

pub fn run() {
    // A disposable native test process runs beside the operator's installed app.
    // Treat its environment as an all-or-nothing safety contract and fail before
    // telemetry, lifecycle cleanup, plugins, ports, or persistent state when it
    // is incomplete. A typo must never silently degrade into a production boot.
    let native_test_instance =
        match native_test_instance::NativeTestInstance::from_env_if_requested() {
            Ok(instance) => instance,
            Err(error) => {
                eprintln!("[native-test-isolation] refusing unsafe launch: {error}");
                std::process::exit(78);
            }
        };

    // First statement in the process: everything else is measured against this.
    let _ = BOOT_T0.set(std::time::Instant::now());
    boot_trace("run() entry");

    // Sentry (native shell). Dormant unless a RELEASE build baked a DSN; dev /
    // `tauri dev` stay silent. Init FIRST so panics during startup are captured;
    // hold the guard for the whole program so events flush on exit. Then export
    // the DSN so the Next server + ws-server children inherit it.
    let _sentry_guard = telemetry::init();
    telemetry::export_dsn_to_env();
    log::info!("[boot] telemetry init at {}ms", boot_ms());
    boot_trace("telemetry init");

    // Native crash capture (signals/faults the sentry panic hook can't see:
    // SIGSEGV/SIGABRT/SIGBUS/stack-overflow). MUST start HERE — right after
    // sentry, and BEFORE boot-identity, port allocation, orphan reaping, and
    // window creation — because it re-execs THIS binary as an out-of-process
    // reporter and everything before this line runs in BOTH processes. The
    // reporter `exit(0)`s inside init and never runs the setup below, so it
    // never binds ports, reaps the main app's Node children, or opens a window
    // (see telemetry::init_minidump_handler). Held for the program lifetime so
    // the reporter process stays alive; None when dormant (debug/no-DSN) or the
    // crash-reports toggle is OFF at launch.
    let _minidump_handle = _sentry_guard
        .as_ref()
        .and_then(telemetry::init_minidump_handler);

    // Hidden crash-test hook (O8_CRASH_TEST=segv|abort|stackoverflow) — lets the
    // operator verify the native crash pipeline end-to-end post-ship with one
    // terminal launch. Runs only in the main process; no-op when the var is
    // unset. Placed AFTER minidump init so the reporter is already listening.
    telemetry::maybe_trigger_crash_test();

    let preship_gate = native_test_instance.is_some();
    let dev_frontend = match dev_frontend::from_env() {
        Ok(dev_frontend) => dev_frontend,
        Err(err) => {
            eprintln!("[dev-frontend] ignoring {}: {}", dev_frontend::ENV_VAR, err);
            None
        }
    };
    let desktop_attach = if preship_gate {
        DesktopAttachAttempt {
            decision: DesktopAttachDecision::NormalBoot,
            target: None,
            reason: "pre-ship gate requires isolated sidecars".to_string(),
        }
    } else if env_flag_enabled("O8_FORCE_BUNDLED_SERVERS") {
        DesktopAttachAttempt {
            decision: DesktopAttachDecision::NormalBoot,
            target: None,
            reason: "O8_FORCE_BUNDLED_SERVERS requires app-owned sidecars".to_string(),
        }
    } else if dev_frontend.is_some() {
        DesktopAttachAttempt {
            decision: DesktopAttachDecision::NormalBoot,
            target: None,
            reason: format!("{} owns backend selection", dev_frontend::ENV_VAR),
        }
    } else {
        let Some(attempt) = resolve_desktop_attach(|_| desktop_attach_retry::prompt_retry()) else {
            return;
        };
        attempt
    };
    let desktop_attached = desktop_attach.decision == DesktopAttachDecision::Attach;
    let boot_identity = desktop_attach
        .target
        .as_ref()
        .map(|target| target.identity.clone())
        .unwrap_or_else(read_or_create_boot_identity);
    export_boot_identity(&boot_identity);

    if !preship_gate {
        sanitize_window_state();
    }

    // ── Shutdown safety net (issue #719) ──
    // Install panic + Unix-signal handlers BEFORE building Tauri so any
    // crash, SIGTERM, or SIGINT during startup still tears down children.
    // The normal Cmd-Q / app.exit() / CloseRequested paths are handled in
    // the RunEvent callback below; this is the belt-and-suspenders layer
    // for ungraceful exits.
    if !desktop_attached {
        sidecar_lifecycle::install_shutdown_handlers();
    }

    // ── Boot-time orphan reaper (issues #728 / #776) ──
    // Reap stale `next-server` / `ws-server` processes from prior crashes
    // (reparented to launchd) and remove a stale `/tmp/tauri-mcp-o8-<user>.sock`
    // BEFORE the Tauri builder is constructed — the `tauri-plugin-mcp` plugin
    // binds the socket during builder setup and throws if the file lingers.
    // Wider net than default-port cleanup from #719: hits orphans on any port,
    // not just 3001/3002.
    // Start the orphan reap (~73ms of pgrep/ps/lsof) NOW, on a worker, so it
    // overlaps generate_context!() instead of being paid in front of it.
    //
    // It is collected below, BEFORE the Tauri builder — not merely before the
    // sidecar spawn. The ordering is load-bearing in a way that is easy to miss:
    // clean_stale_mcp_socket() decides whether the socket is stale by trying to
    // CONNECT to it. If a stale next-server is still alive and holding that
    // socket, the probe succeeds, the socket looks live, and it is left in place —
    // and then tauri-plugin-mcp stalls binding it during builder setup. Measured:
    // an 18.6-SECOND .build() when the socket clean ran before the reap.
    //
    // So the sequence is, and must remain: reap the processes, THEN clean the
    // socket, THEN build. All this change does is overlap the reap with the 1.6s
    // the macro was going to spend anyway.
    if preship_gate {
        boot_trace("orphan reap SKIPPED (isolated native test instance)");
    } else if desktop_attached {
        boot_trace("orphan reap SKIPPED (desktop attached to daemon)");
    } else {
        start_orphan_reap();
        boot_trace("orphan reap STARTED (async, overlaps generate_context!)");
    }

    boot_trace("BEFORE generate_context!");
    let mut context = app_context();
    log::info!("[boot] tauri context at {}ms", boot_ms());
    boot_trace("generate_context! DONE");

    // Collect the reap BEFORE the builder. The 73ms it costs has already been
    // spent inside generate_context!() above, so this join is free — but it must
    // happen here, because the socket clean below depends on those stale
    // processes being dead, and tauri-plugin-mcp binds the socket in .build().
    if !preship_gate {
        join_orphan_reap();
        sidecar_lifecycle::clean_stale_mcp_socket();
    }
    if preship_gate {
        boot_trace("production MCP socket cleanup SKIPPED (isolated native test instance)");
    } else if desktop_attached {
        boot_trace("mcp socket cleaned (daemon listeners untouched)");
    } else {
        boot_trace("orphan reap joined + mcp socket cleaned (pre-builder)");
    }
    if let Some(dev_frontend) = dev_frontend.as_ref() {
        if !dev_frontend::apply_to_main_window_config(context.config_mut(), dev_frontend) {
            eprintln!(
                "[dev-frontend] main window config not found for {}",
                dev_frontend::ENV_VAR
            );
        }
    }
    let main_window_config = context
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned();
    if let Some(window) = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    {
        window.create = false;
    }

    // Clerk publishable key (PUBLIC — safe in source; also baked into the web
    // bundle as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY). The native-mode Clerk plugin
    // needs it in Rust so clerk-js can hold the session via a Tauri store instead
    // of a cross-site cookie WKWebView won't return (127.0.0.1 → clerk.o8.run).
    // Sourced from the build env when present, else the o8.run production key.
    const CLERK_PUBLISHABLE_KEY: &str = match option_env!("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY") {
        Some(k) => k,
        None => "pk_live_Y2xlcmsubzgucnVuJA",
    };

    #[allow(unused_mut)] // `mut` is needed only when `dev-mcp-plugin` feature is enabled
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Native-mode Clerk session persistence (routes FAPI through Rust +
        // stores the client JWT on disk) — the production-compatible desktop
        // auth path. tauri-plugin-http is its request-routing dependency.
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_clerk::ClerkPluginBuilder::new()
                .publishable_key(CLERK_PUBLISHABLE_KEY)
                .with_tauri_store()
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Phase 4 (background presence): launch-at-login. LaunchAgent matches
        // the resident-hotkey-app pattern. Default ON is bootstrapped once from
        // setup() via background::initialize_autostart (marker-guarded).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));

    // ── Windows/Linux `o8://` deep-link delivery (#1742, part of #1673) ──
    // macOS is untouched: the OS hands `o8://` URLs to the running app through
    // RunEvent::Opened, and LaunchServices owns the registration. Windows and
    // Linux instead LAUNCH THE BINARY AGAIN with the URL as argv[1], so both
    // plugins are required:
    //   - single-instance detects the already-running app, forwards argv to it
    //     and exits the duplicate (without it, clicking a link would boot a
    //     second o8 — two sidecars fighting over the SQLite WAL and the ports).
    //     Its `deep-link` feature is what feeds that argv to the plugin below.
    //   - deep-link parses argv against `plugins.deep-link.desktop.schemes` and
    //     emits `deep-link://new-url`; setup() below funnels that into the same
    //     `o8:auth-callback` / pending-buffer seam macOS uses.
    // Order matters: single-instance FIRST (its callback resolves the deep-link
    // plugin state, and it must claim the instance lock before anything else).
    // The doomed second process still runs run()'s prologue before the plugin
    // exits it — that is safe by construction: the orphan reaper skips anything
    // whose parent is still alive (so it cannot touch the live instance's
    // next-server/ws-server), and it is Unix-only, so on Windows it is a no-op.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    if !preship_gate {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                // The `deep-link` feature already handed _argv to the deep-link
                // plugin before this callback ran, so the URL is in flight. All
                // that is left is to surface the window the user just asked for
                // (a plain `o8` re-launch with no URL lands here too).
                show_desktop_window(app);
            }))
            .plugin(tauri_plugin_deep_link::init());
    }

    // Voice P3 hotkeys: OS-global keyboard shortcuts. Installing the plugin is
    // harmless on its own — the actual chord registrations live in the
    // `!preship_gate` macOS setup() block so the disposable pre-ship child app
    // never grabs system-wide shortcuts.
    builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    // Auto-saves window size + position to the OS data dir on close and
    // restores them on next launch. The pre-ship gate launches a disposable
    // child app and must not mutate the operator's saved window geometry.
    if !preship_gate {
        // Restore size + position, but NOT decorations: a window's decorated/
        // borderless state must come from its creation config, never a stale
        // restore. (The voice-settings glass window is created decorations(false)
        // but the plugin was restoring decorations=true saved from an earlier
        // build, re-adding the native title bar over the glass chrome.)
        // Derived Symon overlays are denylisted because their frames come from
        // live monitor geometry; persisting physical pixels corrupts them.
        use tauri_plugin_window_state::StateFlags;
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(window_state_sanitizer::DERIVED_OVERLAY_WINDOW_LABELS)
                .with_state_flags(StateFlags::all() & !StateFlags::DECORATIONS)
                .build(),
        );
    }

    // MCP plugin: exposes app to AI agents (screenshots, DOM, input simulation).
    // Optional dev-only feature. Requires a sibling checkout of tauri-plugin-mcp.
    // Enable with: `cargo tauri dev --features dev-mcp-plugin`.
    #[cfg(feature = "dev-mcp-plugin")]
    {
        // Namespace the socket per-user so two devs on a shared machine don't clash.
        let socket_path = std::env::var("O8_TAURI_MCP_SOCKET").unwrap_or_else(|_| {
            let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
            format!("/tmp/tauri-mcp-o8-{}.sock", user)
        });
        // Require an auth token on the webview-control socket. Without it the
        // plugin processes every command UNAUTHENTICATED, so any same-uid process
        // (incl. a dispatched worker) could `execute_js` arbitrary JS into the
        // operator's authenticated webview (docs/internals/security-audit-2026-07-02.md §HIGH-5).
        // The plugin writes the token to `<socket>.token` (0600); the operator
        // MCP server reads it there (o8-webview-client.ts resolveAuthToken). A
        // per-launch random token means a stale/guessed value never works.
        fn generate_mcp_socket_token() -> String {
            use std::io::Read;
            // 32 random bytes -> hex. The socket is Unix-only (macOS/Linux), so
            // /dev/urandom is available; read it for a CSPRNG token.
            if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
                let mut buf = [0u8; 32];
                if f.read_exact(&mut buf).is_ok() {
                    return buf.iter().map(|b| format!("{:02x}", b)).collect();
                }
            }
            // Fallback (not expected where the Unix socket lives): time + pid.
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            format!("{:032x}{:08x}", nanos, std::process::id())
        }
        let socket_token = generate_mcp_socket_token();
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new("o8".to_string())
                .start_socket_server(true)
                .socket_path(socket_path.into())
                .auth_token(socket_token)
                // #932: pin the default webview label so emit_to('main') resolves
                // deterministically against the webview registry, not the
                // ambiguous window-vs-webview label scope. Without this, JS-side
                // listeners registered via WebviewWindow.listen() never receive
                // requests Rust emits with app.emit_to('main', ...).
                .default_webview_label("main".to_string()),
        ));
    }

    builder
        // Inject the console-error capture hook on every main-window page
        // load (issue #793). Non-main windows skip injection — we only care
        // about errors in the main app shell.
        // PageLoadEvent fires twice per navigation (Started + Finished); we
        // inject on Started so the hook is in place before any user JS runs.
        .on_page_load(move |webview, payload| {
            if webview.label() != "main" {
                return;
            }
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                voice_input::navigation_finished();
                return;
            }
            if payload.event() != tauri::webview::PageLoadEvent::Started {
                return;
            }
            voice_input::navigation_started();
            #[cfg(target_os = "macos")]
            visual_capture::reset_on_main_navigation(webview.app_handle());
            managed_voice_window::reset_on_main_navigation(webview.app_handle());
            remote_preview::close_on_main_reload(webview.app_handle());
            if !preship_gate {
                launch_updater::start_launch_update_check(webview.app_handle().clone());
            }
            if let Err(err) = WebviewLatch::ConsoleErrorHook.fire(webview) {
                log::warn!("[console-error-hook] inject failed: {}", err);
            }
        })
        .invoke_handler(tauri::generate_handler![
            update_ping::begin_update_check,
            update_ping::read_update_check_ticket,
            update_ping::check_app_update,
            update_ping::read_update_channel,
            update_ping::read_update_channel_status,
            update_ping::set_update_channel,
            update_ping::download_app_update,
            update_ping::discard_app_update_download,
            update_ping::install_app_update,
            get_desktop_info,
            get_running_bundle_integrity,
            check_port,
            restart_app,
            prepare_app_restart,
            cancel_app_restart,
            start_ws_server,
            cortex_available,
            get_app_data_dir,
            read_repos,
            read_local_commits,
            read_worktrees,
            read_current_branch,
            read_git_status,
            read_approvals,
            read_workspaces,
            set_tray_badge,
            desktop_close_preference_get,
            desktop_close_preference_set,
            resolve_desktop_close,
            set_canvas_material,
            set_canvas_backdrop_blur,
            take_pending_file_opens,
            peek_pending_file_opens,
            take_pending_auth_callbacks,
            notify_review_ready,
            presentation_quiet_mode_set,
            presentation_quiet_mode_get,
            set_review_notifications_enabled,
            record_console_error,
            read_dropped_file,
            mcp_result,
            o8_view_console_errors,
            o8_view_active_route,
            #[cfg(target_os = "macos")]
            master_key_get,
            #[cfg(target_os = "macos")]
            master_key_ensure,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            o8_stt_start,
            managed_voice_window::managed_voice_overlay_update,
            managed_voice_window::managed_voice_presentation_epoch,
            voice_input::voice_input_claim,
            voice_input::voice_input_release,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_begin,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_ready,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_widget,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_undo,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_transcribe_audio,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_finish,
            #[cfg(target_os = "macos")]
            visual_capture::o8_visual_capture_cancel,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            o8_stt_stop,
            #[cfg(target_os = "macos")]
            o8_system_dictation_finish,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            o8_stt_locale,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            o8_stt_fill_ack,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            stt_list_input_devices,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            stt_set_input_device,
            #[cfg(target_os = "macos")]
            tts_speak,
            #[cfg(target_os = "macos")]
            broadcast_tts_speak,
            #[cfg(target_os = "macos")]
            symon_speak_status,
            #[cfg(target_os = "macos")]
            tts_stop,
            #[cfg(target_os = "macos")]
            tts_toggle_pause,
            #[cfg(target_os = "macos")]
            tts_set_speed,
            #[cfg(target_os = "macos")]
            tts_is_active,
            #[cfg(target_os = "linux")]
            linux_voice::system_tts_speak,
            #[cfg(target_os = "linux")]
            linux_voice::system_tts_stop,
            #[cfg(target_os = "linux")]
            linux_voice::system_tts_backend,
            #[cfg(target_os = "macos")]
            dock_set_expanded,
            dock_set_hit_rect,
            #[cfg(target_os = "macos")]
            browser_view_open,
            #[cfg(target_os = "macos")]
            browser_view_set_rect,
            #[cfg(target_os = "macos")]
            browser_view_navigate,
            #[cfg(target_os = "macos")]
            browser_view_eval,
            #[cfg(target_os = "macos")]
            browser_view_eval_result,
            #[cfg(target_os = "macos")]
            browser_view_capture,
            #[cfg(target_os = "macos")]
            browser_view_close,
            #[cfg(target_os = "macos")]
            browser_view_hide,
            #[cfg(target_os = "macos")]
            browser_view_show,
            remote_preview::remote_preview_supported,
            remote_preview::remote_preview_open,
            remote_preview::remote_preview_set_rect,
            remote_preview::remote_preview_close,
            #[cfg(target_os = "macos")]
            open_voice_settings,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            voice_prefs_get,
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            voice_prefs_set,
            #[cfg(target_os = "macos")]
            external_keyboard_fn_state,
            #[cfg(target_os = "macos")]
            symon_brain_state,
            #[cfg(target_os = "macos")]
            symon_memory_get,
            #[cfg(target_os = "macos")]
            symon_memory_add,
            #[cfg(target_os = "macos")]
            symon_memory_update,
            #[cfg(target_os = "macos")]
            symon_memory_forget,
            #[cfg(target_os = "macos")]
            symon_memory_accept_suggestion,
            #[cfg(target_os = "macos")]
            symon_memory_dismiss_suggestion,
            dictation_history_get,
            dictation_history_clear,
            dictation_history_delete,
            #[cfg(target_os = "macos")]
            ask_question,
            #[cfg(target_os = "macos")]
            agent_run,
            #[cfg(target_os = "macos")]
            symon_text_planner_info,
            #[cfg(target_os = "macos")]
            symon_text_run_turn,
            #[cfg(target_os = "macos")]
            symon_text_interrupt,
            #[cfg(target_os = "macos")]
            agent_confirm,
            #[cfg(target_os = "macos")]
            agent_confirm_exact,
            #[cfg(target_os = "macos")]
            agent_confirm_v2,
            #[cfg(target_os = "macos")]
            agent_interrupt,
            #[cfg(target_os = "macos")]
            agent::realtime_bridge::realtime_tools,
            #[cfg(target_os = "macos")]
            agent::tools::symon_mcp::symon_mcp_refresh,
            #[cfg(target_os = "macos")]
            agent::realtime_bridge::realtime_invoke_tool,
            #[cfg(target_os = "macos")]
            agent::realtime_bridge::symon_transport_invoke_tool,
            #[cfg(target_os = "macos")]
            agent::machine::symon_machine_status,
            #[cfg(target_os = "macos")]
            agent::machine::symon_machine_list,
            #[cfg(target_os = "macos")]
            agent::machine::symon_machine_switch,
            #[cfg(target_os = "macos")]
            agent::machine::symon_machine_session_end,
            #[cfg(target_os = "macos")]
            agent::realtime_bridge::realtime_interrupt_review,
            #[cfg(target_os = "macos")]
            agent::realtime_bridge::record_realtime_event,
            #[cfg(target_os = "macos")]
            agent::realtime_bridge::realtime_status_changed,
            #[cfg(target_os = "macos")]
            agent_get_escalation,
            #[cfg(target_os = "macos")]
            agent_set_escalation,
            #[cfg(target_os = "macos")]
            agent_edit_revert,
            #[cfg(target_os = "macos")]
            agent_edit_capture_result,
            #[cfg(target_os = "macos")]
            agent_edit_apply_result,
            #[cfg(target_os = "macos")]
            agent_files_stage,
            #[cfg(target_os = "macos")]
            agent_task_status,
            #[cfg(target_os = "macos")]
            agent_eval,
            #[cfg(target_os = "macos")]
            o8_debug_paste,
            #[cfg(target_os = "macos")]
            o8_dock_log,
            #[cfg(target_os = "macos")]
            o8_debug_show_dock,
            #[cfg(target_os = "macos")]
            capture_app_window,
            mac_perms::accessibility_permission_granted_cmd,
            mac_perms::input_monitoring_granted_cmd,
            mac_perms::request_input_monitoring_cmd,
            mac_perms::fn_key_usage_type_cmd,
            mac_perms::screen_capture_granted_cmd,
            mac_perms::mic_permission_granted_cmd,
            mac_perms::request_mic_access_cmd,
            background::autostart_is_enabled,
            background::autostart_set,
            background::background_mode_is_enabled,
            background::background_mode_set,
            background::open_system_settings,
        ])
        .setup(move |app| {
            if let Err(err) = update_ping::initialize(app.handle()) {
                log::warn!("[updater] update identity unavailable: {}", err);
            }
            log::info!("[boot] setup() entered at {}ms (Builder + plugins done)", boot_ms());
            boot_trace("setup() entered (plugins INITIALISED)");
            match desktop_attach.decision {
                DesktopAttachDecision::Attach => {
                    log::info!("[desktop-attach] attached: {}", desktop_attach.reason);
                }
                DesktopAttachDecision::Coexist => {
                    log::warn!(
                        "[desktop-attach] declined; keeping coexistence boot: {}",
                        desktop_attach.reason
                    );
                }
                DesktopAttachDecision::NormalBoot => {
                    log::info!(
                        "[desktop-attach] not selected; keeping normal boot: {}",
                        desktop_attach.reason
                    );
                }
            }
            #[cfg(target_os = "macos")]
            if !preship_gate {
                url_scheme_handler::reassert_o8_scheme_handler();
            }
            // ── Windows/Linux `o8://` (#1742) — the non-macOS half of the above ──
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if !preship_gate {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Hot path: a live app receiving a URL (fresh launch that
                // single-instance forwarded, or this process's own argv replayed).
                let deep_link_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let links: Vec<String> = event
                        .urls()
                        .iter()
                        .filter(|url| url.scheme() == "o8")
                        .map(|url| url.as_str().to_string())
                        .collect();
                    deliver_o8_auth_deep_links(&deep_link_handle, links);
                });

                // Cold start: the plugin parsed argv during ITS setup, which
                // Tauri runs before this closure — so the launch URL was emitted
                // before the listener above existed. get_current() is the drain
                // for exactly that window; without it a cold `o8://auth/callback`
                // click would sign in to nothing.
                //
                // BUFFER, never emit. By the time setup() runs the main window
                // exists (its absence here is the 0.1.598 regression the
                // lifecycle block below warns about), so the emit branch of
                // deliver_o8_auth_deep_links would fire into a webview whose JS
                // has not registered the `o8:auth-callback` listener yet — and
                // the Clerk ticket is one-time, so there is no second chance.
                // The dashboard drains take_pending_auth_callbacks on mount,
                // which is timing-independent.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    let links: Vec<String> = urls
                        .iter()
                        .filter(|url| url.scheme() == "o8")
                        .map(|url| url.as_str().to_string())
                        .collect();
                    buffer_o8_auth_deep_links(links);
                }

                // Runtime registration. The bundler already writes the scheme
                // into the NSIS/WiX/deb/rpm installers, but that covers only
                // installed builds — this catches `cargo tauri dev`, portable
                // extractions, and AppImages the user never registered with an
                // AppImage launcher. Idempotent (HKCU key rewrite on Windows;
                // ~/.local/share/applications/*-handler.desktop + xdg-mime on
                // Linux) and off the boot thread because the Linux path shells
                // out to update-desktop-database + xdg-mime.
                //
                // UNINSTALL CLEANUP, honestly: the Windows NSIS/WiX uninstallers
                // remove the keys THEY wrote (HKCU or HKLM per install mode), and
                // deb/rpm removal drops the bundled .desktop file. Neither knows
                // about what register_all() wrote at runtime — the per-user HKCU
                // key from a machine-wide install, and the Linux
                // `<bin>-handler.desktop` + mimeapps.list default under
                // ~/.local/share + ~/.config. Those survive uninstall as dangling
                // handlers pointing at a missing binary. The plugin exposes
                // unregister() but there is no uninstall hook to call it from, so
                // this is a known, accepted gap rather than a solved problem.
                let register_handle = app.handle().clone();
                std::thread::spawn(move || {
                    if let Err(err) = register_handle.deep_link().register_all() {
                        log::warn!("[url-scheme] runtime o8:// registration failed: {err}");
                    }
                });
            }
            let boot_identity = boot_identity.clone();
            // Nudge the user to move o8 to /Applications when it's running
            // translocated / from a DMG — otherwise dictation paste, Accessibility,
            // and auto-update silently break (#fresh-user). Off-thread so the
            // blocking osascript dialog doesn't delay window creation.
            #[cfg(target_os = "macos")]
            if !preship_gate {
                std::thread::spawn(first_run_install::offer_move_to_applications_if_needed);
            }
            // ── System Tray (issue #731) ──
            // Menu items: Show / Quit.
            let show = MenuItem::with_id(app, "show", "Show o8", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit o8", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                // Show menu on left-click (default is right-click only on
                // macOS) so the count-aware list is one click away.
                .show_menu_on_left_click(false)
                .tooltip("o8");
            // macOS wants a monochrome template glyph. Windows/Linux need the
            // full application icon so the tray stays visible against either
            // a light or dark taskbar/panel.
            #[cfg(target_os = "macos")]
            {
                tray_builder = tray_builder
                    .icon(tauri::image::Image::from_bytes(include_bytes!(
                        "../icons/tray-template.png"
                    ))?)
                    .icon_as_template(true);
            }
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let tray = tray_builder
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    match id {
                        "show" => {
                            show_main_ui(app);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        lane if lane.starts_with("lane:") => {
                            // #731 — dynamic lane row click. Surface the
                            // window so the operator sees the review queue,
                            // then emit a Tauri event the frontend can pick
                            // up to scroll the AgentPanel to the lane.
                            show_main_ui(app);
                            let lane_id = &lane["lane:".len()..];
                            let _ = app.emit("tray:focus-lane", lane_id.to_string());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        show_main_ui(app);
                    }
                })
                .build(app)?;
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            tray.set_visible(false)?;
            // Store the handle so background tasks (badge poller) and
            // frontend commands can mutate the tray's title / tooltip.
            store_tray(tray);
            log::info!("[boot] tray built at {}ms", boot_ms());

            // ── Badge poller (issue #731) ──
            // 5s tick keeps the tray title in sync with awaiting_review
            // count without waiting on a frontend WS subscription. Cheap
            // — one HTTP GET per tick, hits the same server as the panel.
            spawn_tray_badge_poller(app.handle().clone());

            // ── Background presence (system-wide Symon fold P4) ──
            // 1. Launch-at-login defaults ON so the pill + Fn hotkey work without
            //    opening o8; marker-guarded so it auto-enables exactly once.
            // 2. Re-apply the persisted background-mode (Accessory/Regular) pref —
            //    default OFF (Dock icon visible), so a fresh boot is never an
            //    invisible app. This is the single boot-time activation-policy
            //    apply; the Settings toggle is the only other caller.
            // The pre-ship gate launches a disposable child app — never mutate the
            // operator's autostart registration or activation policy from it.
            if !preship_gate {
                background::initialize_autostart(app.handle());
                background::apply_persisted_background_mode(app.handle());

                // ── Boot-time update check (P4 review MEDIUM) ──
                // A background/autostart session that never opens the main window
                // would otherwise never self-update (the on_page_load check only
                // fires when main loads). Fire it here too — start_launch_update_check
                // is AtomicBool-guarded, so this never double-fires with on_page_load.
                launch_updater::start_launch_update_check(app.handle().clone());
            }

            // ── Voice STT engine (lifted from aqua/Symon, de-Symonized) ──
            // Install a tracing subscriber so the lifted STT modules' `tracing::`
            // logs surface (idempotent — `try_init` no-ops if one already set),
            // then spawn the Apple-Speech sidecar daemon ONCE. Both are
            // best-effort: a missing Swift helper or a poisoned mutex is logged
            // and skipped, leaving the existing dictation path intact.
            // Linux runs the whisper.cpp helper (`o8-speech-recognizer`, #1672)
            // behind the same daemon protocol; the macOS-only extras (sound
            // cues, screen dock TTS, Fn hotkey) stay in the block below.
            #[cfg(target_os = "linux")]
            if !preship_gate {
                let _ = tracing_subscriber::fmt()
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                    )
                    .try_init();
                stt_engine::spawn(app.handle().clone());
                linux_ptt::register(app);
            }
            #[cfg(target_os = "macos")]
            if !preship_gate {
                let _ = tracing_subscriber::fmt()
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
                    )
                    .try_init();
                stt_engine::spawn(app.handle().clone());
                // Boot the procedural sound-cue worker (#1208) — owns its own
                // audio stream so cues never collide with TTS playback.
                sound::spawn_worker();
                // Let the off-thread TTS playback morph the screen dock while it speaks.
                tts::set_app_handle(app.handle().clone());

                // ── Global Fn hotkey → system-wide paste (system-wide Symon fold P2) ──
                // Reuses the stt_engine daemon spawned just above — never spawns a
                // second recognizer. On Fn-down it saves the focused app + starts
                // dictation; on Fn-up the finalize chain pastes the polished text at
                // the system caret (see the origin branch in run_finalize). Runs its
                // own CGEventTap on a dedicated CFRunLoop thread, so it keeps working
                // even when the main window is hidden.
                log::info!("[boot] pre-hotkeys at {}ms", boot_ms());
                fn_hotkey::start(app.handle().clone());
                visual_capture::register_shortcut(app.handle());
                log::info!("[boot] fn_hotkey CGEventTap at {}ms", boot_ms());

                // Drive the Microphone permission prompt deterministically at
                // setup (once per run, only when notDetermined) rather than
                // hoping the first mic capture triggers it (#1537-adjacent).
                mac_perms::request_mic_access_once();
                mac_perms::request_apple_events_self_access_once();
                log::info!("[boot] mac_perms (TCC) at {}ms", boot_ms());

                // ── Voice P3 global shortcuts ──
                // OS-global chords (fire even when o8 is unfocused). The Fn /
                // double-tap-Fn gestures stay on the CGEventTap above (modifier-
                // only gestures the plugin can't bind); these three map to
                // existing o8 capabilities. Registered INSIDE !preship_gate so the
                // disposable pre-ship child app never grabs system-wide chords.
                // Registration failures are logged, not fatal — a chord already
                // owned by another app must not block boot.
                {
                    use tauri::Emitter;
                    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

                    // ⌘⇧Space → summon the o8 window to the front. o8's window is
                    // the full IDE (not a tiny pill), so summon-to-front only —
                    // never hide the whole IDE on a global chord.
                    if let Ok(sc) = "CommandOrControl+Shift+Space".parse::<Shortcut>() {
                        let h = app.handle().clone();
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            show_main_ui(&h);
                        }) {
                            log::warn!("[hotkey] failed to register CmdShiftSpace (summon): {e}");
                        }
                    }

                    // ⌘⌥V → paste the last voice dictation at the system caret.
                    if let Ok(sc) = "CommandOrControl+Alt+V".parse::<Shortcut>() {
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            if let Some(text) = fn_hotkey::last_voice_transcript() {
                                // paste_text does clipboard + a synthetic ⌘V + a
                                // focus settle — run it off the event-loop thread.
                                std::thread::spawn(move || crate::paste::paste_text(&text));
                            }
                        }) {
                            log::warn!("[hotkey] failed to register CmdAltV (paste-last): {e}");
                        }
                    }

                    // ⌘⇧, → open the in-app settings overlay. o8 settings is an
                    // overlay in the main webview (not a window), so emit to the
                    // dashboard rather than showing a "settings" window.
                    if let Ok(sc) = "CommandOrControl+Shift+,".parse::<Shortcut>() {
                        let h = app.handle().clone();
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            let _ = h.emit_to("main", "o8:open-settings", ());
                        }) {
                            log::warn!("[hotkey] failed to register CmdShiftComma (settings): {e}");
                        }
                    }

                    // Voice Settings stays reachable with the top pill disabled
                    // and without bringing the main workspace to the front.
                    if let Ok(sc) = "CommandOrControl+Alt+,".parse::<Shortcut>() {
                        if let Err(e) = app.global_shortcut().on_shortcut(sc, move |app, _sc, event| {
                            if event.state == ShortcutState::Pressed {
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || open_voice_settings(handle));
                            }
                        }) {
                            log::warn!("[hotkey] failed to register voice settings: {e}");
                        }
                    }

                    // Ctrl+Alt+R (primary) + Ctrl+Shift+R (legacy) → speak the
                    // current text selection aloud (voice P4 "say").
                    // History: Ctrl+Shift+S → Ctrl+Shift+R 2026-07-07 ("S is a
                    // bad command"); Ctrl+Alt+R added 2026-07-13 because
                    // Ctrl+Shift+R is DOUBLE-BOOKED on operator machines —
                    // Claude Desktop registers it as its window toggle, and
                    // Carbon delivers duplicate registrations to BOTH apps: the
                    // other window hides itself mid-grab while our read finds
                    // nothing (live video + o8.log 2026-07-13). The legacy
                    // chord stays registered for muscle memory on machines
                    // where it's free. (The old "avoid Option" concern was the
                    // OPTION-HOLD agent gesture latching — a bare Alt inside a
                    // chord doesn't trip it; wait_for_option_release below
                    // still guards the synthetic-copy path.)
                    // grab_selection does clipboard polling with sleeps, so the
                    // whole thing runs off the event-loop thread; play_thread
                    // then spawns its own audio thread. Falls back to `say`
                    // inside play_thread.
                    let speak_selection = |h_speak: tauri::AppHandle| move |event: ShortcutState| {
                        if event != ShortcutState::Pressed {
                            return;
                        }
                        // The chord says the current selection — ALWAYS. If a read is
                        // already playing (commonly Symon's OWN voice, or a
                        // transient/stale is_active right after it finishes),
                        // stop it first but DON'T return — fall through and say
                        // the new selection. play_thread's single-flight makes a
                        // new speak supersede the old; a bare chord with nothing
                        // selected still just stops (grab_selection → None).
                        if crate::tts::playback::is_active() {
                            std::thread::spawn(crate::tts::playback::stop);
                        }
                        // o8's own webview doesn't expose its text selection via
                        // AXSelectedText (and synthetic Cmd+C can't copy it), so
                        // when o8 is frontmost ask the WEBVIEW for its selection
                        // (window.getSelection) via the frontend. For any other
                        // app, grab the selection natively (AX → Cmd+C).
                        if crate::paste::frontmost_is_o8() {
                            let _ = h_speak.emit_to("main", "o8:speak-selection", ());
                            return;
                        }
                        std::thread::spawn(|| {
                            // Legacy safety guard: if an interrupted Option agent
                            // gesture is still physically down, wait before the
                            // Cmd+C fallback so the held modifier cannot merge
                            // into the synthetic copy event.
                            crate::fn_hotkey::wait_for_option_release(1_200);
                            match crate::paste::grab_selection() {
                                Some(text) => {
                                    crate::tts::playback::play_thread(text, crate::tts::load_config());
                                }
                                None => log::info!("[tts] speak-selection: no selection to speak"),
                            }
                        });
                    };
                    for chord in ["Control+Alt+R", "Control+Shift+R"] {
                        if let Ok(sc) = chord.parse::<Shortcut>() {
                            let handler = speak_selection(app.handle().clone());
                            if let Err(e) = app.global_shortcut().on_shortcut(sc, move |_app, _sc, event| {
                                handler(event.state);
                            }) {
                                log::warn!("[hotkey] failed to register {chord} (speak-selection): {e}");
                            }
                        }
                    }
                }
            }


            // ── Start bundled Next.js server ──
            let resource_dir = strip_extended_length_prefix(
                app.path().resource_dir().expect("failed to resolve resource dir"),
            );
            let server_dir = resource_dir.join("server");
            let server_js = server_dir.join("server.js");

            // First-launch CLI symlink. The o8 CLI ships inside the .app at
            // Contents/Resources/server/bin/o8; symlink it onto PATH so the
            // operator + dispatched workers can just type `o8 <command>`.
            // Skip on failure — no permission, no /usr/local/bin, no problem.
            if !preship_gate {
                ensure_cli_on_path(&server_dir.join("bin").join("o8"));
            }

            // If a dev server is already running on the default production API port (e.g. the
            // user is running `npm run desktop:dev` in a terminal), defer to it
            // and don't spawn the bundled copy — the dev server is the source
            // of truth during iteration.
            //
            // BUT: a crashed prior install may have orphaned its bundled Next
            // server (reparented to launchd, still holding :3001). Issue #509
            // — we now classify the listener before deferring. An orphan gets
            // killed and we fall through to the bundled-spawn path so the new
            // shell owns both Next and ws-server.
            let dev_server_running = if desktop_attach.decision
                != DesktopAttachDecision::NormalBoot
            {
                // A live daemon is either the selected backend or a listener we
                // must coexist with. Do not run stale-listener classification
                // against daemon-owned ports in either case.
                false
            } else if env_flag_enabled("O8_FORCE_BUNDLED_SERVERS") {
                false
            } else if dev_frontend.is_some() {
                // The explicit frontend override owns API selection; probing
                // the production API default here could kill an unrelated listener during hot reload.
                false
            } else {
                match classify_port_listener(PROD_API_DEFAULT_PORT) {
                    PortListener::Free => false,
                    PortListener::Legit {
                        pid,
                        command,
                        o8_owned,
                    } => {
                        if !o8_owned {
                            log::info!(
                                "[orphan-check] :{} is owned by non-o8 listener (pid={}, cmd={:?}) — bundled server will allocate another port",
                                PROD_API_DEFAULT_PORT, pid, command
                            );
                            false
                        } else if listener_is_stale_current_instance(
                            PROD_API_DEFAULT_PORT,
                            &boot_identity,
                        ) {
                            log::info!(
                                "[orphan-check] :{} is stale o8 identity (pid={}, cmd={:?}) — killing",
                                PROD_API_DEFAULT_PORT,
                                pid,
                                command
                            );
                            sidecar_lifecycle::kill_orphan_and_wait(pid, PROD_API_DEFAULT_PORT);
                            false
                        } else {
                            log::info!(
                                "[orphan-check] :{} looks like an active o8 listener (pid={}, cmd={:?}) — deferring",
                                PROD_API_DEFAULT_PORT, pid, command
                            );
                            true
                        }
                    }
                    PortListener::Orphan { pid, command } => {
                        if listener_is_stale_current_instance(PROD_API_DEFAULT_PORT, &boot_identity)
                        {
                            log::info!(
                                "[orphan-check] :{} owned by stale o8 orphan pid={} cmd={:?} — killing",
                                PROD_API_DEFAULT_PORT,
                                pid,
                                command
                            );
                            sidecar_lifecycle::kill_orphan_and_wait(pid, PROD_API_DEFAULT_PORT);
                        }
                        false
                    }
                }
            };

            // Production block defaults. If
            // nothing is on them and the bundled server is about to start,
            // these become the actual bindings. If they're taken, we probe
            // upward within the o8-owned block only, then fall back to :0.
            let mut api_port: u16 = PROD_API_DEFAULT_PORT;
            let mut ws_port: u16 = PROD_WS_DEFAULT_PORT;

            // ── Boot ordering (perf) ──
            //
            // `setup()` runs BEFORE Tauri's event loop starts, so nothing paints
            // until it RETURNS. Any blocking work in here is dead time where the
            // user stares at no window at all — not an empty frame, no window.
            //
            // The window needs exactly two things: `api_port` and `boot_identity`.
            // It does NOT need node, PATH, or the AI keys. Port resolution is
            // cheap (TCP binds, sub-millisecond); the login-shell probe and the
            // sidecar spawn are not.
            //
            // So: resolve ports → build the window → hand the whole sidecar
            // bootstrap to a worker thread → return immediately. The loader
            // (out/frontend/index.html) already polls /api/setup/identity and
            // navigates to /dashboard once the sidecar binds, so it tolerates a
            // not-yet-listening server by construction — that's the same
            // contract it has always had.
            enum BootMode {
                Attached,
                DevFrontend,
                DevServerRunning,
                Bundled,
                NoBundle,
            }

            let boot_mode = if let Some(target) = desktop_attach.target.as_ref() {
                api_port = target.api_port;
                ws_port = target.ws_port;
                log::info!(
                    "[desktop-attach] using daemon ports api={} ws={}; bundled sidecars disabled",
                    api_port,
                    ws_port
                );
                BootMode::Attached
            } else if let Some(df) = dev_frontend.as_ref() {
                api_port = df.port();
                ws_port = allocate_ws_port(api_port);
                log::info!(
                    "[dev-frontend] {}={} — skipping bundled Next; ports api={} ws={}",
                    dev_frontend::ENV_VAR,
                    df.url().as_str(),
                    api_port,
                    ws_port
                );
                BootMode::DevFrontend
            } else if dev_server_running {
                log::info!(
                    "Dev server already running on :{} — skipping bundled servers",
                    PROD_API_DEFAULT_PORT
                );
                BootMode::DevServerRunning
            } else if server_js.exists() {
                if preship_gate {
                    // ── Pre-ship boot gate isolation ──
                    // This is a disposable 2nd instance launched alongside the
                    // operator's live app. It must NEVER reap or bind the
                    // operator's ports. find_free_port() can wrongly return the
                    // operator's :3001 via an IPv4/IPv6 dual-stack bind quirk
                    // (the probe's 127.0.0.1 bind doesn't conflict with an
                    // operator listener on ::1/0.0.0.0), so do NOT probe — bind
                    // exactly the free ports the gate driver provisioned.
                    let isolation = native_test_instance
                        .as_ref()
                        .expect("validated native test isolation missing");
                    api_port = isolation.api_port;
                    ws_port = isolation.ws_port;
                    log::info!(
                        "[preship-gate] forced isolated ports: api={} ws={}",
                        api_port,
                        ws_port
                    );
                } else {
                    // ── Port allocation ──
                    // Probe only inside the production blocks. Occupied foreign
                    // listeners are skipped; current-install stale boots are
                    // killed only after /api/setup/identity proves ownership.
                    api_port = allocate_identity_gated_api_port(&boot_identity);
                    ws_port = allocate_ws_port(api_port);
                    log::info!("Allocated ports: api={} ws={}", api_port, ws_port);
                }
                BootMode::Bundled
            } else {
                log::warn!(
                    "No bundled server found at {:?} — running in dev mode",
                    server_js
                );
                BootMode::NoBundle
            };

            let _ = write_port_file("api-port", api_port);
            let _ = write_port_file("ws-port", ws_port);
            std::env::set_var("O8_API_PORT", api_port.to_string());
            std::env::set_var("O8_WS_PORT", ws_port.to_string());
            app.manage(restart_job_drain::guard(
                std::path::PathBuf::from(o8_data_dir()), api_port, sidecar_lifecycle::kill_tracked_children,
            ));
            // Expose the resolved ports to the frontend loader HTML so it
            // knows where to navigate.
            std::env::set_var("CORTEX_IDE_API_PORT", api_port.to_string());
            std::env::set_var("CORTEX_IDE_WS_PORT", ws_port.to_string());

            log::info!("[boot] ports resolved at {}ms (api={} ws={})", boot_ms(), api_port, ws_port);

            // ── Window FIRST ──
            // Built before any sidecar work so the loader paints the moment the
            // event loop starts, rather than after the whole bootstrap has run.
            // The packaged macOS app opens o8 next instead (the server spawns
            // it), so the classic window is never built there.
            if next_main::enabled() {
                log::info!("[main-window] o8 next is the main window; the classic window is not built");
            } else if app.get_webview_window("main").is_none() {
                if let Some(config) = main_window_config.as_ref() {
                    // __O8_HTML_TRAFFIC_LIGHTS__ tells the frontend this shell
                    // hides the native traffic lights, so it must render the
                    // DOM ones (TrafficLights.tsx). Old shells lack the flag →
                    // the strips keep the native-lights spacer fallback, which
                    // keeps dev-bridge (new frontend on the old installed
                    // binary) rendering correctly. Only the macOS shell hides
                    // them (hide_native_traffic_lights is macOS-only); Windows
                    // and Linux keep standard decorations, so the flag is
                    // false there and the strips draw no controls (#1743).
                    let html_traffic_lights = cfg!(target_os = "macos");
                    // __O8_HOST_PLATFORM__ is the frontend's synchronous
                    // platform read (#1743) — the pre-paint theme stamp needs
                    // it in <head>, long before any IPC exists, to pick opaque
                    // chrome off macOS. See lib/desktop/host-platform.ts.
                    let init_script = format!(
                        "window.__O8_PORT_HINT__ = {}; window.__O8_EXPECTED_BOOT_ID__ = {}; window.__O8_HTML_TRAFFIC_LIGHTS__ = {}; window.__O8_HOST_PLATFORM__ = {:?};",
                        api_port,
                        serde_json::to_string(&boot_identity.boot_id)
                            .unwrap_or_else(|_| "\"\"".into()),
                        html_traffic_lights,
                        std::env::consts::OS,
                    );
                    #[cfg(target_os = "linux")]
                    let init_script = format!(
                        "{init_script} window.__O8_LINUX_GLASS__ = {};",
                        std::env::var("O8_LINUX_GLASS").map(|v| v.trim() == "1").unwrap_or(false),
                    );
                    tauri::WebviewWindowBuilder::from_config(app, config)?
                        .initialization_script(init_script)
                        .build()?;
                } else {
                    log::warn!("[main-window] config missing; could not create main webview");
                }
            }
            if desktop_attached {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.set_title("o8 (attached)") {
                        log::warn!("[desktop-attach] could not set attached window title: {error}");
                    }
                }
            }
            log::info!("[boot] main window created at {}ms — the loader can paint from here", boot_ms());

            // ── Window Close → Hide to Tray ──
            // MUST stay AFTER "── Window FIRST ──": the main window is built
            // manually above (config create=false), so it does not exist
            // earlier in setup. When this block ran before window creation
            // (0.1.597–598) the guard below skipped silently and took boot
            // vibrancy, the #1543 re-assert ladder, corner rounding, launch
            // clamps, close-to-hide, and the #1136 drag-drop bridge with it.
            let app_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                window_restore::schedule_launch_clamps(&app_handle);

                #[cfg(target_os = "macos")]
                if let Err(err) = apply_vibrancy(
                    &window,
                    chrome_vibrancy_material(),
                    // Active (not focus-following): keep the chrome glassy when the
                    // window loses key focus instead of flattening to grey (#1267).
                    // Mirrors what the canvas surface already does (set_canvas_material).
                    Some(window_vibrancy::NSVisualEffectState::Active),
                    None,
                ) {
                    log::warn!("Failed to apply macOS vibrancy: {}", err);
                }

                // Boot-timing belt-and-braces (#1543): the effect view applied
                // during setup can silently fail to render on macOS 26 AND
                // 15.7.8 (observed live on both operator machines — a runtime
                // clear+re-apply always cures it). Primary re-assert is
                // webview-driven (ThemeProvider invokes set_canvas_material
                // 'default' on mount — the frontend being alive proves the
                // window is ready); this Rust retry loop is the fallback for
                // boots where the webview never mounts. v0.1.582's version of
                // this silently never ran because the dispatch error was
                // swallowed — every failure logs now.
                #[cfg(target_os = "macos")]
                {
                    let reassert = window.clone();
                    std::thread::spawn(move || {
                        for (attempt, delay_ms) in [(1u32, 2_000u64), (2, 6_000), (3, 12_000)] {
                            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                            let target = reassert.clone();
                            let dispatched = reassert.run_on_main_thread(move || {
                                let _ = window_vibrancy::clear_vibrancy(&target);
                                if let Err(e) = window_vibrancy::apply_vibrancy(
                                    &target,
                                    chrome_vibrancy_material(),
                                    Some(window_vibrancy::NSVisualEffectState::Active),
                                    None,
                                ) {
                                    log::warn!("[vibrancy] boot re-assert apply failed: {e}");
                                } else {
                                    log::info!("[vibrancy] boot re-assert applied");
                                }
                            });
                            match dispatched {
                                Ok(()) => break,
                                Err(e) => log::warn!(
                                    "[vibrancy] boot re-assert dispatch failed (attempt {attempt}): {e}"
                                ),
                            }
                        }
                    });
                }

                // Transparent windows lose macOS's automatic corner mask, so the
                // webview's square corners poke past the vibrancy and read as a
                // hard/pointed edge with the desktop showing through. Clip the
                // content-view layer to round the vibrancy + webview together —
                // a normal rounded Mac window. Tracks resize.
                #[cfg(target_os = "macos")]
                round_window_corners(&window, 12.0);

                // Zoom (maximize/restore) must be instant — WKWebView can't
                // repaint during the animated frame change, so the animation
                // reads as frozen-content-then-snap (2026-07-15 polish pass).
                #[cfg(target_os = "macos")]
                make_window_zoom_instant(&window);

                // Native traffic lights OFF — the webview draws its own so the
                // whole titlebar cluster scales with the app's CSS zoom
                // (Q ruling 2026-07-16). Re-asserted below on Focused/Resized
                // because macOS un-hides standard buttons across fullscreen
                // and style-mask transitions.
                #[cfg(target_os = "macos")]
                hide_native_traffic_lights(&window);

                // No blur/acrylic backdrop off macOS (#1743): the Windows and
                // Linux windows are decorated and OPAQUE (tauri.windows /
                // tauri.linux conf overlays set transparent=false), and the
                // frontend pins surface=solid there, so there is no
                // translucent chrome for a backdrop to show through.

                window.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();

                            // A windowless app remains visible in the macOS
                            // Dock, so closing the window keeps the established
                            // macOS behavior. Windows/Linux treat X as quit when
                            // no worker is live and ask before backgrounding
                            // active work; the tray appears only after consent.
                            #[cfg(target_os = "macos")]
                            {
                                if let Some(w) = app_handle.get_webview_window("main") {
                                    let _ = w.hide();
                                }
                                let _ = app_handle.emit("window-hidden", ());
                            }
                            #[cfg(any(target_os = "windows", target_os = "linux"))]
                            request_desktop_close(app_handle.clone());
                        }
                        // #1136 — bridge OS-level drag-drop into the webview as
                        // window CustomEvents. With dragDropEnabled: true in
                        // tauri.conf.json, HTML5 drop events no longer fire for
                        // EXTERNAL drags (Finder → app), so this is the only
                        // path that lets composers receive Finder file paths.
                        // Internal webview drags (tile reorder, etc.) still
                        // work through normal HTML5.
                        tauri::WindowEvent::DragDrop(drag) => match drag {
                            tauri::DragDropEvent::Enter { paths, position } => {
                                let payload = serde_json::json!({
                                    "paths": paths.iter()
                                        .map(|p| p.to_string_lossy().into_owned())
                                        .collect::<Vec<_>>(),
                                    "position": { "x": position.x, "y": position.y },
                                });
                                let _ = app_handle.emit("o8:tauri-file-drop-enter", payload);
                            }
                            tauri::DragDropEvent::Over { position } => {
                                let payload = serde_json::json!({
                                    "position": { "x": position.x, "y": position.y },
                                });
                                let _ = app_handle.emit("o8:tauri-file-drop-over", payload);
                            }
                            tauri::DragDropEvent::Drop { paths, position } => {
                                let payload = serde_json::json!({
                                    "paths": paths.iter()
                                        .map(|p| p.to_string_lossy().into_owned())
                                        .collect::<Vec<_>>(),
                                    "position": { "x": position.x, "y": position.y },
                                });
                                let _ = app_handle.emit("o8:tauri-file-drop", payload);
                            }
                            tauri::DragDropEvent::Leave => {
                                let _ = app_handle.emit("o8:tauri-file-drop-leave", ());
                            }
                            _ => {}
                        },
                        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                            window_restore::schedule_event_clamp(&app_handle);
                            // Re-hide the native traffic lights — macOS
                            // re-shows standard buttons across fullscreen
                            // enter/exit and style-mask changes, and both
                            // paths land here as a Resized event.
                            #[cfg(target_os = "macos")]
                            if let Some(w) = app_handle.get_webview_window("main") {
                                hide_native_traffic_lights(&w);
                            }
                            // A monitor crossing does not always deliver the scale event before
                            // AppKit settles the window. Refit after move/resize as a cheap fallback.
                            #[cfg(target_os = "macos")]
                            macos_webview_scale::schedule_main_webview_frame_repair(&app_handle);
                        }
                        #[cfg(target_os = "macos")]
                        tauri::WindowEvent::ScaleFactorChanged {
                            scale_factor,
                            new_inner_size,
                            ..
                        } => {
                            window_restore::schedule_event_clamp(&app_handle);
                            if let Some(w) = app_handle.get_webview_window("main") {
                                log::info!(
                                    "[display-scale] main window changed to {scale_factor:.2}x at {}x{} physical pixels",
                                    new_inner_size.width,
                                    new_inner_size.height
                                );
                                hide_native_traffic_lights(&w);
                                macos_webview_scale::repair_main_webview_frame(&w);
                                macos_webview_scale::schedule_main_webview_frame_repair(&app_handle);
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        tauri::WindowEvent::ScaleFactorChanged { .. } => {
                            window_restore::schedule_event_clamp(&app_handle);
                        }
                        #[cfg(target_os = "macos")]
                        tauri::WindowEvent::Focused(_) => {
                            if let Some(w) = app_handle.get_webview_window("main") {
                                hide_native_traffic_lights(&w);
                            }
                        }
                        _ => {}
                    }
                });
            } else {
                // Loud, not silent — this skipping is exactly the 0.1.598
                // glass/close-to-hide regression.
                log::warn!("[main-window] lifecycle block skipped: main window missing at setup");
            }

            // Bound the V8 compile cache. Worker thread; never on the boot path.
            prune_compile_cache();

            // ── Sidecar bootstrap: off the main thread ──
            //
            // The only genuinely blocking step is the login-shell probe (~690ms
            // on the operator's Intel box — it execs a shell that sources the
            // user's profile). It runs on a worker; everything that mutates this
            // process's environment or spawns a child is handed straight back to
            // the main thread via `run_on_main_thread`, exactly where it ran
            // before, so we introduce no new set_var/getenv race.
            match boot_mode {
                BootMode::Attached => {
                    // The attached daemon is already verified and listening.
                    // Voice windows belong to this shell, not the daemon.
                    voice_surfaces::create(app.handle(), api_port);
                }
                BootMode::Bundled => {
                    let app_handle = app.handle().clone();
                    let server_dir = server_dir.clone();
                    let server_js = server_js.clone();
                    let identity = boot_identity.clone();
                    std::thread::spawn(move || {
                        let shell = shell_env::probe_login_shell();
                        log::info!("[boot] login-shell probe done at {}ms (off the main thread)", boot_ms());
                        let node_bin = match run_node_preflight(shell.node.as_deref(), &server_dir) {
                            Ok(path) => path,
                            Err(err) => show_node_error_and_exit(err),
                        };
                        log::info!("[boot] node pre-flight done at {}ms", boot_ms());
                        let main_handle = app_handle.clone();
                        if let Err(e) = app_handle.run_on_main_thread(move || {
                            finish_bundled_bootstrap(
                                &main_handle,
                                shell,
                                node_bin,
                                server_dir,
                                server_js,
                                api_port,
                                ws_port,
                                identity,
                            );
                        }) {
                            log::error!("[boot] bundled bootstrap never reached the main thread: {e}");
                        }
                    });
                }
                BootMode::DevFrontend => {
                    let app_handle = app.handle().clone();
                    let server_dir = server_dir.clone();
                    let identity = boot_identity.clone();
                    let origin = dev_frontend
                        .as_ref()
                        .map(|df| df.origin().to_string())
                        .unwrap_or_default();
                    std::thread::spawn(move || {
                        let shell = shell_env::probe_login_shell();
                        let node_bin = match run_node_preflight(shell.node.as_deref(), &server_dir) {
                            Ok(path) => path,
                            Err(err) => show_node_error_and_exit(err),
                        };
                        let main_handle = app_handle.clone();
                        let ws_app = app_handle.clone();
                        if let Err(e) = app_handle.run_on_main_thread(move || {
                            // Same ordering contract as the bundled path: never spawn a
                            // sidecar before the orphan reap has finished (#1539).
                            join_orphan_reap();
                            std::env::set_var("O8_NODE_BIN", &node_bin);

                            let ws_log = open_child_log("ws-server.log");
                            let ai_keys = shell.keys;
                            if !ai_keys.is_empty() {
                                // #935 follow-up: also apply the keys to THIS
                                // (Tauri/Rust) process — the Rust-side Symon agent
                                // + Ask path read GEMINI_API_KEY via std::env::var,
                                // and a Finder launch doesn't inherit ~/.zshenv.
                                // Without this, voice features failed with
                                // "Missing GEMINI_API_KEY" while the Node sidecar
                                // (which gets the keys forwarded) worked fine.
                                for (k, v) in &ai_keys {
                                    std::env::set_var(k, v);
                                }
                                log::info!(
                                    "Applied {} AI provider key(s) from login shell to this process + ws-server",
                                    ai_keys.len()
                                );
                            }
                            spawn_bundled_ws_server(
                                &ws_app,
                                &node_bin,
                                &server_dir,
                                ws_port,
                                &origin,
                                ws_log.as_ref(),
                                &ai_keys,
                                &identity,
                            );
                            // Dev-bridge: the bundled Next isn't spawned here, but
                            // the dev server IS up on `api_port` — create the dock
                            // pill against it. prewarm polls `:{api_port}/dashboard`
                            // (the dev server) then `dock_window::create` loads the
                            // dock from the dev origin.
                            prewarm_bundled_next_server(main_handle, api_port);
                        }) {
                            log::error!(
                                "[boot] dev-frontend bootstrap never reached the main thread: {e}"
                            );
                        }
                    });
                }
                BootMode::DevServerRunning => {
                    voice_surfaces::create(app.handle(), api_port);
                }
                BootMode::NoBundle => {}
            }

            #[cfg(target_os = "macos")]
            if !preship_gate {
                agent::tools::symon_mcp::start_refresh_task();
            }

            log::info!("Cortex IDE desktop shell initialized");

            Ok(())
        })
        .build({ boot_trace("builder chain constructed (plugins registered, not yet init)"); context })
        .expect("error while building Cortex IDE")
        .run(move |_app_handle, event| match event {
            // Auxiliary windows can keep has_visible_windows true while main
            // is hidden. Every Dock reopen restores the existing main window.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_main_ui(_app_handle),
            // Finder "Open With → o8" / dock drop (file:// URLs) AND the auth
            // deep-link handoff (o8://auth/callback?...). macOS delivers both
            // through Opened; we partition by scheme. Buffer for cold launch
            // (frontend may not be listening yet) and nudge the live webview.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                // Auth deep-links: o8://auth/callback?ticket=...&state=...
                let auth_links: Vec<String> = urls
                    .iter()
                    .filter(|url| url.scheme() == "o8")
                    .map(|url| url.as_str().to_string())
                    .collect();
                // Single delivery seam, shared with the Windows/Linux deep-link
                // plugin path (see deliver_o8_auth_deep_links).
                deliver_o8_auth_deep_links(_app_handle, auth_links);

                // Finder "Open With → o8" / dock drop (file:// URLs).
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().to_string())
                    .collect();
                if !paths.is_empty() {
                    if let Ok(mut pending) = pending_file_opens().lock() {
                        pending.extend(paths.clone());
                    }
                    if let Some(window) = _app_handle.get_webview_window("main") {
                        let _ = window.emit("file-open-request", &paths);
                        let _ = window.set_focus();
                    }
                }
            }
            // ExitRequested fires on Cmd-Q, app.exit(), tray Quit menu, etc.
            // We tear down children here so they don't outlive the parent.
            // Children also see a TERM via the OS process group on graceful
            // exits, but the explicit kill is what catches detached/launchd
            // reparenting.
            RunEvent::ExitRequested { .. } => {
                if desktop_attached {
                    log::info!("[desktop-attach] app exit leaves daemon children running");
                } else {
                    sidecar_lifecycle::kill_tracked_children();
                }
            }
            // Final event before the loop terminates. Idempotent with the
            // ExitRequested handler — kill_tracked_children() drains the
            // registry on first call.
            RunEvent::Exit => {
                if !desktop_attached {
                    sidecar_lifecycle::kill_tracked_children();
                }
            }
            _ => {}
        });
}
