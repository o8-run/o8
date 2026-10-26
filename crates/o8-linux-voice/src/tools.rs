//! Runtime detection of external command-line tools.
//!
//! Lookups take an explicit search path so tests can point them at a temp
//! directory of fake tools without mutating the process-wide `PATH`.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The `PATH` of the current process, or an empty value when it is unset.
pub fn system_path() -> OsString {
    std::env::var_os("PATH").unwrap_or_default()
}

/// Find an executable named `name` on `search_path` (a `PATH`-style list).
/// A `name` containing a slash is checked as a path directly.
pub fn find_in(name: &str, search_path: &OsStr) -> Option<PathBuf> {
    if name.contains('/') {
        let candidate = PathBuf::from(name);
        return is_executable(&candidate).then_some(candidate);
    }
    std::env::split_paths(search_path)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

/// Find `name` on the process `PATH`.
pub fn find(name: &str) -> Option<PathBuf> {
    find_in(name, &system_path())
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    /// A unique scratch directory under the system temp dir, removed on drop.
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new(tag: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "o8-linux-voice-{tag}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Write an executable shell script named `name` into `dir`.
    ///
    /// The executable is written by a child `install` process, never through a
    /// file descriptor in this process: tests run in parallel, and a sibling
    /// test forking while we hold the script open for writing would make the
    /// later exec fail with ETXTBSY ("Text file busy").
    pub fn fake_tool(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        let source = dir.join(format!(".{name}.src"));
        std::fs::write(&source, format!("#!/bin/sh\n{body}\n")).unwrap();
        let status = std::process::Command::new("install")
            .args(["-m", "0755"])
            .arg(&source)
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success(), "install {name}");
        std::fs::remove_file(source).unwrap();
        path
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{fake_tool, TempDir};
    use super::*;

    #[test]
    fn finds_only_executables_on_the_given_path() {
        let dir = TempDir::new("tools");
        fake_tool(dir.path(), "espeak-ng", "exit 0");
        std::fs::write(dir.path().join("not-executable"), "x").unwrap();
        let path = dir.path().as_os_str();
        assert_eq!(
            find_in("espeak-ng", path),
            Some(dir.path().join("espeak-ng"))
        );
        assert_eq!(find_in("not-executable", path), None);
        assert_eq!(find_in("missing", path), None);
    }

    #[test]
    fn absolute_names_bypass_the_search_path() {
        let dir = TempDir::new("tools-abs");
        let tool = fake_tool(dir.path(), "piper", "exit 0");
        assert_eq!(find_in(tool.to_str().unwrap(), OsStr::new("")), Some(tool));
    }
}
