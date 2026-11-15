use std::process::Command;
use crate::{no_window::NoWindow, shell_env};
#[cfg(windows)]
use crate::windows_node_locate;
pub const MIN_NODE_MAJOR: u32 = 22;
// macOS ships multiple native-addon ABIs. Linux keeps the host-built Node 22
// addons, so it must not accept Node 24 merely because macOS supports it.
// Linux also loads the actual packaged addons before admitting a runtime.
pub const PREFERRED_NODE_MAJOR: u32 = 22;
pub const LATEST_SUPPORTED_NODE_MAJOR: u32 = 24;
#[cfg(target_os = "linux")]
const SUPPORTED_NATIVE_NODE_MAJORS: &[u32] = &[PREFERRED_NODE_MAJOR];
#[cfg(not(target_os = "linux"))]
const SUPPORTED_NATIVE_NODE_MAJORS: &[u32] = &[PREFERRED_NODE_MAJOR, LATEST_SUPPORTED_NODE_MAJOR];

/// Look in well-known places for a Node 22.x install regardless of the user's
/// nvm/fnm/volta default. Order matches the rough population of users on each.
pub fn find_preferred_node_22(server_dir: &std::path::Path) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    find_preferred_node_22_in(&home, |candidate| {
        let version = check_node_version(candidate)?;
        supports_packaged_native_addons(candidate, server_dir).then_some(version)
    })
}

pub fn find_preferred_node_22_in<F>(home: &str, mut check_node: F) -> Option<String>
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

pub fn resolve_node_via_login_shell() -> Option<String> {
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

/// Returns Some((major, raw_version)) on success, None on failure.
///
/// Served from `~/.o8/node-abi-cache` when the binary hasn't changed since we
/// last checked it: exec'ing `node --version` costs ~0.49s on the operator's
/// machine, and it re-derives an answer that only moves when node itself does.
/// The cache is stamped with the binary's (mtime, size), so a node upgrade
/// invalidates the entry and we re-exec — the #1032 ABI pin is preserved.
pub fn check_node_version(node_bin: &str) -> Option<(u32, String)> {
    shell_env::check_node_version_cached(node_bin)
}

/// Linux exports host-built addons. Loading both catches the actual ABI (and
/// architecture), including a mismatched Node 22 or a stale addon payload.
#[cfg(target_os = "linux")]
pub fn supports_packaged_native_addons(node_bin: &str, server_dir: &std::path::Path) -> bool {
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
pub fn supports_packaged_native_addons(_node_bin: &str, _server_dir: &std::path::Path) -> bool {
    true
}

pub fn supports_native_node_major(major: u32) -> bool {
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
pub fn resolve_node_windows() -> Option<String> {
    windows_node_locate::resolve_node_via_where()
        .or_else(|| windows_node_locate::find_preferred_node_22(check_node_version))
}

#[cfg(not(target_os = "windows"))]
pub fn resolve_node_windows() -> Option<String> {
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
pub enum NodePreflightError {
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
pub fn run_node_preflight(
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
pub fn node_install_hint() -> String {
    "Install a supported version from https://nodejs.org, or run \
     `winget install OpenJS.NodeJS.LTS`, then launch o8 again.\n\n\
     If Node.js is already installed via nvm-windows, Volta, or fnm, make sure it\n\
     is on PATH — open a new terminal after installing and confirm `node -v` works."
        .to_string()
}

#[cfg(target_os = "linux")]
pub fn node_install_hint() -> String {
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
pub fn node_install_hint() -> String {
    format!(
        "Install a supported version with `brew install node@{major}` / `nvm install {major}`\n\
         or `brew install node@{latest}` / `nvm install {latest}`, then launch o8 again.\n\n\
         If Node.js is already installed via nvm, fnm, or Volta, make sure it is\n\
         available to a login shell (zsh/bash with -l flag).",
        major = PREFERRED_NODE_MAJOR,
        latest = LATEST_SUPPORTED_NODE_MAJOR
    )
}
