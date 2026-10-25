//! Windows-native Node.js discovery — the locator's non-POSIX counterpart.
//!
//! `resolve_node_via_login_shell()` in lib.rs only knows zsh/bash/sh, and
//! `find_preferred_node_22()` there only globs `$HOME/.nvm` / `.fnm` /
//! `.volta` / Homebrew paths — none of which exist on Windows. An
//! Explorer-launched app (no inherited terminal PATH) previously always fell
//! through to "Node.js not found" even with Node 22 installed. This module
//! gives Windows its own strategy: `where node`, then the common install
//! roots (the official installer / winget / choco, nvm-windows, Volta, fnm)
//! (#1740, part of #1673).
//!
//! Root selection and version matching are plain, injectable functions so
//! they're unit-testable without a live Windows box — see `tests` below,
//! which run on every platform via `cargo test --lib`. The module itself
//! only compiles on Windows targets or under `cfg(test)`, so it never ships
//! dead code on the macOS builds this repo is actually developed on.

use std::path::PathBuf;

/// `where node` — the Windows equivalent of `command -v node` / `which node`.
/// `where` isn't a command on macOS/Linux, so this is only ever invoked from
/// the `cfg(target_os = "windows")` call site in `run_node_preflight`.
///
/// MUST spawn with `.no_window()`. This probe gates the whole boot: without
/// the flag it opens a console window, and a console the user clicks enters
/// "Select" mode, which suspends the process — `where` then never returns and
/// the app hangs on its splash screen with an empty server log and no error.
#[cfg(target_os = "windows")]
pub(crate) fn resolve_node_via_where() -> Option<String> {
    use crate::no_window::NoWindow;
    let out = crate::child_environment::command("where").arg("node").no_window().output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .map(str::to_string)
}

/// How a given root path resolves to a `node.exe`.
enum RootLayout {
    /// `node.exe` sits directly at the root (official installer, winget, choco).
    Fixed,
    /// The root is a directory of version subdirs (`v22.11.0/`, `22.11.0/`);
    /// `node.exe` lives at `<root>/<version>/<suffix...>/node.exe`.
    Versioned(&'static [&'static str]),
}

/// Well-known Windows Node roots, in rough population order. `env` is
/// injectable so tests don't depend on real environment variables.
fn candidate_roots(env: impl Fn(&str) -> Option<String>) -> Vec<(PathBuf, RootLayout)> {
    let mut roots = Vec::new();
    if let Some(v) = env("ProgramFiles") {
        roots.push((PathBuf::from(v).join("nodejs").join("node.exe"), RootLayout::Fixed));
    }
    if let Some(v) = env("ProgramFiles(x86)") {
        roots.push((PathBuf::from(v).join("nodejs").join("node.exe"), RootLayout::Fixed));
    }
    if let Some(v) = env("ProgramData") {
        roots.push((
            PathBuf::from(v).join("chocolatey").join("bin").join("node.exe"),
            RootLayout::Fixed,
        ));
    }
    // nvm-windows: NVM_HOME (default %APPDATA%\nvm), one dir per version.
    if let Some(v) = env("NVM_HOME").or_else(|| env("APPDATA").map(|a| format!("{a}\\nvm"))) {
        roots.push((PathBuf::from(v), RootLayout::Versioned(&[])));
    }
    // Volta: VOLTA_HOME (default %USERPROFILE%\.volta), image layout.
    if let Some(v) = env("VOLTA_HOME").or_else(|| env("USERPROFILE").map(|u| format!("{u}\\.volta"))) {
        roots.push((
            PathBuf::from(v).join("tools").join("image").join("node"),
            RootLayout::Versioned(&[]),
        ));
    }
    // fnm: FNM_DIR (default %APPDATA%\fnm), installation subdir per version.
    if let Some(v) = env("FNM_DIR").or_else(|| env("APPDATA").map(|a| format!("{a}\\fnm"))) {
        roots.push((
            PathBuf::from(v).join("node-versions"),
            RootLayout::Versioned(&["installation"]),
        ));
    }
    roots
}

/// Scan `candidate_roots()` for a Node 22.x binary, verifying each candidate
/// with `check_node`. Pure and injectable — no real filesystem/env
/// dependency required to test it.
fn find_preferred_node_22_via<F>(
    env: impl Fn(&str) -> Option<String>,
    mut check_node: F,
) -> Option<String>
where
    F: FnMut(&str) -> Option<(u32, String)>,
{
    for (root, layout) in candidate_roots(env) {
        match layout {
            RootLayout::Fixed => {
                if let Some(p) = root.to_str() {
                    if let Some((22, _)) = check_node(p) {
                        return Some(p.to_string());
                    }
                }
            }
            RootLayout::Versioned(suffix) => {
                let Ok(entries) = std::fs::read_dir(&root) else {
                    continue;
                };
                let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
                versions.sort();
                versions.reverse();
                for mut version in versions {
                    let name = version
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if !(name.starts_with("v22") || name.starts_with("22")) {
                        continue;
                    }
                    for part in suffix {
                        version.push(part);
                    }
                    version.push("node.exe");
                    if let Some(p) = version.to_str() {
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

/// Real entry point: scans the actual environment for a Node 22.x install.
#[cfg(target_os = "windows")]
pub(crate) fn find_preferred_node_22<F>(check_node: F) -> Option<String>
where
    F: FnMut(&str) -> Option<(u32, String)>,
{
    find_preferred_node_22_via(|k| std::env::var(k).ok(), check_node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "o8-win-node-{}-{}-{}",
                name,
                std::process::id(),
                suffix
            ));
            fs::create_dir_all(&path).expect("create temp root");
            Self { path }
        }

        fn str(&self) -> String {
            self.path.to_string_lossy().to_string()
        }

        fn touch(&self, rel: &str) -> PathBuf {
            let p = self.path.join(rel);
            fs::create_dir_all(p.parent().expect("node path parent")).expect("create parent");
            fs::write(&p, b"fake node").expect("write fake node");
            p
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // Fixed roots (the official installer / winget / choco) have no version
    // segment in their path, so — like the real `node --version` exec this
    // stands in for — this defaults to 22 unless the path says otherwise.
    fn checker(path: &str) -> Option<(u32, String)> {
        if !std::path::Path::new(path).exists() {
            return None;
        }
        if path.contains("v24.") {
            return Some((24, "v24.0.0".to_string()));
        }
        Some((22, "v22.11.0".to_string()))
    }

    #[test]
    fn finds_nvm_windows_version_dir() {
        let root = TempRoot::new("nvm");
        let node = root.touch("v22.11.0/node.exe");
        let mut env = HashMap::new();
        env.insert("NVM_HOME".to_string(), root.str());
        assert_eq!(
            find_preferred_node_22_via(|k| env.get(k).cloned(), checker),
            Some(node.to_string_lossy().to_string())
        );
    }

    #[test]
    fn finds_fnm_installation_layout() {
        let root = TempRoot::new("fnm");
        let node = root.touch("node-versions/v22.4.0/installation/node.exe");
        let mut env = HashMap::new();
        env.insert("FNM_DIR".to_string(), root.str());
        assert_eq!(
            find_preferred_node_22_via(|k| env.get(k).cloned(), checker),
            Some(node.to_string_lossy().to_string())
        );
    }

    #[test]
    fn ignores_non_22_versions() {
        let root = TempRoot::new("skip");
        root.touch("v24.0.0/node.exe");
        let mut env = HashMap::new();
        env.insert("NVM_HOME".to_string(), root.str());
        assert_eq!(
            find_preferred_node_22_via(|k| env.get(k).cloned(), checker),
            None
        );
    }

    #[test]
    fn fixed_root_checks_directly() {
        let root = TempRoot::new("fixed");
        let node = root.touch("nodejs/node.exe");
        let mut env = HashMap::new();
        env.insert("ProgramFiles".to_string(), root.str());
        assert_eq!(
            find_preferred_node_22_via(|k| env.get(k).cloned(), checker),
            Some(node.to_string_lossy().to_string())
        );
    }
}
