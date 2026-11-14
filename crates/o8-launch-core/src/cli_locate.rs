//! Shared runtime CLI discovery for native-side consumers.
//!
//! Keep the directory inventory aligned with
//! `src/lib/runtimes/shared/cli-locate.ts`. The app bootstrap uses it to widen
//! child PATHs; Symon uses the same scan to choose an installed planner.

use std::path::{Path, PathBuf};

fn version_manager_bin_dirs(root: PathBuf, suffix: &[&str]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    versions.sort();
    versions.reverse();
    versions
        .into_iter()
        .map(|mut version| {
            for part in suffix {
                version.push(part);
            }
            version
        })
        .filter(|dir| dir.is_dir())
        .collect()
}

pub fn well_known_cli_bin_dirs() -> Vec<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        for relative in [
            ".o8/bin",
            ".local/bin",
            ".claude/local",
            ".npm-global/bin",
            ".bun/bin",
            "Library/pnpm",
            ".local/share/pnpm",
            ".deno/bin",
            ".volta/bin",
            ".asdf/shims",
            ".fnm/aliases/default/bin",
        ] {
            dirs.push(home.join(relative));
        }
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
        dirs.extend(version_manager_bin_dirs(
            home.join(".nvm/versions/node"),
            &["bin"],
        ));
        dirs.extend(version_manager_bin_dirs(
            home.join(".fnm/node-versions"),
            &["installation", "bin"],
        ));
    } else {
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    }

    // Windows has no `$HOME`-anchored login-shell PATH to inherit from, so
    // widen with the version-manager layouts a Finder^H^H Explorer launch
    // would otherwise miss (#1740).
    #[cfg(windows)]
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let user_profile = PathBuf::from(user_profile);
        dirs.extend(version_manager_bin_dirs(
            user_profile.join(".fnm").join("node-versions"),
            &["installation"],
        ));
        dirs.extend(version_manager_bin_dirs(
            user_profile.join(".volta").join("tools").join("image").join("node"),
            &[],
        ));
    }
    #[cfg(windows)]
    if let Ok(nvm_home) = std::env::var("NVM_HOME") {
        dirs.extend(version_manager_bin_dirs(PathBuf::from(nvm_home), &[]));
    }

    let mut out: Vec<String> = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        let value = dir.to_string_lossy().to_string();
        if !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

pub fn scan_for_binary(binary_name: &str) -> Option<String> {
    let path_dirs = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    for dir in path_dirs.into_iter().chain(well_known_cli_bin_dirs()) {
        let candidate = Path::new(&dir).join(binary_name);
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

pub fn resolve_binary(binary_name: &str, env_keys: &[&str]) -> Option<String> {
    for env_key in env_keys {
        if let Ok(value) = std::env::var(env_key) {
            if !value.trim().is_empty() && Path::new(&value).exists() {
                return Some(value);
            }
        }
    }
    scan_for_binary(binary_name)
}
